const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Vercel等のサーバーレス環境では /tmp のみ書き込み可能なためフォールバック
const DB_FILE = process.env.VERCEL ? path.join('/tmp', 'database.json') : path.join(__dirname, 'database.json');

// --- インメモリ高速キャッシュ ＆ データベース管理 ---
let memoryDB = {
  epoch: Date.now(),
  users: {},
  userFriends: {},
  groups: [],
  events: [],
  deletedEventIds: [],
  notifications: []
};

// 起動時にDBファイルをロード
function initDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      memoryDB = {
        epoch: data.epoch || Date.now(),
        users: data.users || {},
        userFriends: data.userFriends || {},
        groups: data.groups || [],
        events: data.events || [],
        deletedEventIds: data.deletedEventIds || [],
        notifications: data.notifications || []
      };
    } catch (e) {
      console.error('Error loading DB, initializing new:', e);
    }
  } else {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(memoryDB, null, 2), 'utf-8');
    } catch (e) {
      console.warn('Could not initialize DB file on disk:', e.message);
    }
  }
  cleanExpiredEvents();
}

// 日本時間 (JST: UTC+9) に対応した正確なタイムスタンプ変換
function parseDateJST(dateStr) {
  if (!dateStr) return 0;
  try {
    if (typeof dateStr === 'string' && !dateStr.includes('Z') && !dateStr.includes('+')) {
      const d = new Date(dateStr + '+09:00');
      if (!isNaN(d.getTime())) return d.getTime();
    }
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  } catch (e) {
    return 0;
  }
}

// --- ⌛ 終了日時を1時間過ぎた予定の自動削除マネージャー ---
function cleanExpiredEvents() {
  if (!Array.isArray(memoryDB.events)) return;
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;

  const activeEvents = [];
  const newlyDeletedIds = [];

  memoryDB.events.forEach(e => {
    let endTimestamp = 0;
    if (e.endDateTime) {
      endTimestamp = parseDateJST(e.endDateTime);
    } else if (e.startDateTime) {
      // 終了日時の指定がない場合は開始から2時間後を終了日時と判定
      endTimestamp = parseDateJST(e.startDateTime) + (2 * 60 * 60 * 1000);
    }

    if (endTimestamp > 0 && (now - endTimestamp >= ONE_HOUR)) {
      newlyDeletedIds.push(e.id);
    } else {
      activeEvents.push(e);
    }
  });

  if (newlyDeletedIds.length > 0) {
    if (!Array.isArray(memoryDB.deletedEventIds)) memoryDB.deletedEventIds = [];
    newlyDeletedIds.forEach(id => {
      if (!memoryDB.deletedEventIds.includes(id)) {
        memoryDB.deletedEventIds.push(id);
      }
    });
    if (memoryDB.deletedEventIds.length > 500) {
      memoryDB.deletedEventIds = memoryDB.deletedEventIds.slice(-500);
    }
    memoryDB.events = activeEvents;
    scheduleSave();
    broadcastUpdate('event_expired_cleanup');
  }
}
initDB();

// 1分ごとに自動期限切れチェック
setInterval(cleanExpiredEvents, 60 * 1000);

// 非同期デバウンス保存（高負荷時もディスクI/Oが詰まらない）
let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(memoryDB, null, 2), 'utf-8', (err) => {
      if (err) console.error('Error saving DB asynchronously:', err);
    });
  }, 100);
}

// --- SSE (Server-Sent Events) リアルタイム配信マネージャー ---
const sseClients = new Set();

function broadcastUpdate(reason = 'update', targetUserId = null) {
  const payload = JSON.stringify({ type: 'sync', reason, timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      if (!targetUserId || client.userId === targetUserId) {
        client.res.write(`data: ${payload}\n\n`);
      }
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// 15秒ごとのハートビート（回線維持）
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.res.write(': ping\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 15000);

// --- 🛡️ セキュリティ ＆ レートリミッター（DoS/スパム防止） ---
const rateLimits = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1分単位
  const maxRequests = 200; // 1分間に200リクエストまで許容
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 1, resetTime: now + windowMs };
    rateLimits.set(ip, entry);
    return true;
  }
  entry.count++;
  return entry.count <= maxRequests;
}

// 定期的に古いIPレート制限レコードを掃除
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits.entries()) {
    if (now > entry.resetTime) {
      rateLimits.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// リクエストボディ安全読み取りヘルパー（サイズ上限2MBでメモリパンク防止）
function readJsonBody(req, res, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'リクエストデータが大きすぎます（最大2MB）' }));
        req.destroy();
        reject(new Error('Payload Too Large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '無効なJSONフォーマットです' }));
        reject(err);
      }
    });
    req.on('error', err => reject(err));
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ics': 'text/calendar; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  // レートリミット判定（SSEストリームは除外）
  const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
  if (!req.url.startsWith('/api/events/stream') && !checkRateLimit(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'リクエスト頻度が高すぎます。しばらく時間をおいて再試行してください。' }));
    return;
  }

  // CORS & 高度なセキュリティヘッダー
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const pathname = parsedUrl.pathname;
  const userId = parsedUrl.searchParams.get('userId');

  // --- ⚡ リアルタイム通信 (SSE: Server-Sent Events) ---
  if (pathname === '/api/events/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');

    const client = { res, userId: userId || null };
    sseClients.add(client);

    req.on('close', () => {
      sseClients.delete(client);
    });
    return;
  }

  // --- API エンドポイント: ユーザー個別データ同期 (GET /api/sync?userId=...) ---
  if (pathname === '/api/sync' && req.method === 'GET') {
    if (!userId) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ friends: [], groups: [], events: [] }));
      return;
    }

    // 🔒 ユーザーIDごとに友達関係・個人データを完全分離
    const rawFriends = memoryDB.userFriends[userId] || [];
    const myFriends = rawFriends.map(f => {
      const latestUser = memoryDB.users[f.id];
      if (latestUser) {
        return {
          ...f,
          name: latestUser.name || f.name,
          avatar: latestUser.avatar || f.avatar
        };
      }
      return f;
    });
    const myFriendIds = myFriends.map(f => f.id);

    // 自分が作成者、またはメンバーに含まれているグループのみ抽出
    const myGroups = (memoryDB.groups || []).filter(g =>
      g.createdById === userId || (Array.isArray(g.memberIds) && g.memberIds.includes(userId))
    );

    // グループ情報の充実化（全メンバーの名前・アバターを解決）
    const enrichedGroups = myGroups.map(g => {
      const membersInfo = (g.memberIds || []).map(mid => {
        if (mid === userId) {
          const meUser = memoryDB.users[userId];
          return { id: mid, name: meUser ? meUser.name : 'あなた', avatar: meUser ? meUser.avatar : '🦊', isMe: true };
        }
        const u = memoryDB.users[mid];
        if (u) return { id: mid, name: u.name, avatar: u.avatar || '😊' };
        for (const ownerId in memoryDB.userFriends) {
          const found = (memoryDB.userFriends[ownerId] || []).find(f => f.id === mid);
          if (found) return { id: mid, name: found.name, avatar: found.avatar || '😊' };
        }
        return { id: mid, name: 'メンバー', avatar: '😊' };
      });
      return { ...g, membersInfo };
    });

    // 🔒 予定（イベント）の厳格なプライバシーフィルタリング:
    // 1. 自分が作成者（または初期user_me）
    // 2. 出欠リスト（attendees）に自分が含まれている
    // 3. 特定の友達限定（scope: 'friends'）: targetFriendIds に自分が含まれている
    // 4. グループ限定（scope: 'group'）: 自分がそのグループのメンバーである
    // 5. 全体の友達（scope: 'all' または未指定）: 作成者と友達関係にある場合のみ表示！赤の他人には絶対に漏洩しない！
    const myEvents = (memoryDB.events || []).filter(e => {
      // 1. 自分が作成者
      if (e.createdById === userId || e.createdById === 'user_me') return true;

      // 2. 出欠リストに自分が含まれている
      if (e.attendees && e.attendees.some(a => a.friendId === userId)) return true;

      // 3. 友達限定指定
      if (e.scope === 'friends') {
        if (Array.isArray(e.targetFriendIds) && e.targetFriendIds.includes(userId)) return true;
        return false;
      }

      // 4. グループ限定指定
      if (e.scope === 'group' && e.groupId) {
        const grp = (memoryDB.groups || []).find(g => g.id === e.groupId);
        if (grp && Array.isArray(grp.memberIds) && grp.memberIds.includes(userId)) return true;
        return false;
      }

      // 5. 全体の友達 (scope: 'all' または未設定)
      // 作成者が自分の友達リストにある、または相手の友達リストに自分がいる場合のみ公開
      const isFriend = myFriendIds.includes(e.createdById);
      const creatorFriends = memoryDB.userFriends[e.createdById] || [];
      const isInCreatorFriends = creatorFriends.some(f => f.id === userId);
      if (isFriend || isInCreatorFriends) return true;

      // 赤の他人には一切見せない
      return false;
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      epoch: memoryDB.epoch || 1,
      friends: myFriends,
      groups: enrichedGroups,
      events: myEvents,
      deletedEventIds: memoryDB.deletedEventIds || []
    }));
    return;
  }

  // --- API エンドポイント: 予定の単体保存 (POST /api/events/save) ---
  if (pathname === '/api/events/save' && req.method === 'POST') {
    try {
      const ev = await readJsonBody(req, res);
      if (ev && ev.id) {
        const idx = memoryDB.events.findIndex(e => e.id === ev.id);
        if (idx >= 0) {
          const existing = memoryDB.events[idx];
          // 🔒 作成者以外の不正上書き防止
          if (existing.createdById && existing.createdById !== 'user_me' && ev.createdById && existing.createdById !== ev.createdById) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '他のユーザーが作成した予定は直接変更できません' }));
            return;
          }
          memoryDB.events[idx] = ev;
        } else {
          memoryDB.events.unshift(ev);
        }

        // 明示的な個別保存の場合は削除済みリストから除外
        if (Array.isArray(memoryDB.deletedEventIds)) {
          memoryDB.deletedEventIds = memoryDB.deletedEventIds.filter(id => id !== ev.id);
        }
        scheduleSave();
        broadcastUpdate('event_saved');
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, event: ev }));
    } catch (e) {
      // readJsonBody内で既にレスポンス済みの場合はスキップ
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // --- API エンドポイント: ユーザー個別データ保存 (POST /api/sync) ---
  if (pathname === '/api/sync' && req.method === 'POST') {
    try {
      const incoming = await readJsonBody(req, res);
      const currentUid = incoming.user ? incoming.user.id : null;

      if (incoming.user && currentUid) {
        memoryDB.users[currentUid] = incoming.user;
        if (Array.isArray(incoming.friends)) {
          if (!memoryDB.userFriends[currentUid]) memoryDB.userFriends[currentUid] = [];
          incoming.friends.forEach(f => {
            if (!f || !f.id || f.id === currentUid) return;
            const idx = memoryDB.userFriends[currentUid].findIndex(df => df.id === f.id);
            if (idx >= 0) memoryDB.userFriends[currentUid][idx] = f;
            else memoryDB.userFriends[currentUid].push(f);
          });
        }
      }

      // グループの安全なマージ
      if (Array.isArray(incoming.groups)) {
        incoming.groups.forEach(g => {
          if (!g || !g.id) return;
          const idx = memoryDB.groups.findIndex(dg => dg.id === g.id);
          if (idx >= 0) {
            const existing = memoryDB.groups[idx];
            const isMember = (existing.memberIds || []).includes(currentUid) || existing.createdById === currentUid;
            if (isMember) {
              memoryDB.groups[idx] = g;
            }
          } else {
            if (!g.createdById && currentUid) g.createdById = currentUid;
            memoryDB.groups.push(g);
          }
        });
      }

      // 予定の安全なマージ
      if (Array.isArray(incoming.events)) {
        const deletedIds = memoryDB.deletedEventIds || [];
        incoming.events.forEach(e => {
          if (!e || !e.id || deletedIds.includes(e.id)) return;
          const idx = memoryDB.events.findIndex(de => de.id === e.id);
          if (idx >= 0) {
            const existing = memoryDB.events[idx];
            const mergedAttendees = [...(existing.attendees || [])];
            (e.attendees || []).forEach(inAtt => {
              const aIdx = mergedAttendees.findIndex(ma => ma.friendId === inAtt.friendId);
              if (aIdx >= 0) {
                mergedAttendees[aIdx] = inAtt;
              } else {
                mergedAttendees.push(inAtt);
              }
            });

            // 作成者本人でない場合は出欠回答のみマージ許可（タイトルや詳細の改ざん防止）
            if (existing.createdById && existing.createdById !== currentUid && existing.createdById !== 'user_me') {
              memoryDB.events[idx] = { ...existing, attendees: mergedAttendees };
            } else {
              memoryDB.events[idx] = { ...existing, ...e, attendees: mergedAttendees };
            }
          } else {
            if (!e.createdById && currentUid) e.createdById = currentUid;
            memoryDB.events.unshift(e);
          }
        });
      }

      scheduleSave();
      broadcastUpdate('sync');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // --- API エンドポイント: 友達追加・招待登録 (POST /api/friends) ---
  if (pathname === '/api/friends' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req, res);
      const { hostId, guestId, guestName, guestAvatar, hostName, hostAvatar } = payload;

      // 自分自身の友達追加をブロック
      if (!hostId || !guestId || hostId === guestId) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, ignored: true }));
        return;
      }

      // ゲスト側のユーザープロフィール最新化
      if (guestId) {
        if (!memoryDB.users[guestId]) {
          memoryDB.users[guestId] = { id: guestId, name: guestName || '友達', avatar: guestAvatar || '😊' };
        } else {
          if (guestName) memoryDB.users[guestId].name = guestName;
          if (guestAvatar) memoryDB.users[guestId].avatar = guestAvatar;
        }
      }

      // ホスト側のユーザープロフィール最新化
      if (hostId) {
        if (!memoryDB.users[hostId]) {
          memoryDB.users[hostId] = { id: hostId, name: hostName || '友達', avatar: hostAvatar || '🦊' };
        } else {
          if (hostName) memoryDB.users[hostId].name = hostName;
          if (hostAvatar) memoryDB.users[hostId].avatar = hostAvatar;
        }
      }

      // ホスト側の友達リストにゲストを追加
      if (!memoryDB.userFriends[hostId]) memoryDB.userFriends[hostId] = [];
      const hIdx = memoryDB.userFriends[hostId].findIndex(f => f.id === guestId);
      const guestFriendObj = {
        id: guestId,
        name: guestName || (memoryDB.users[guestId] ? memoryDB.users[guestId].name : '友達'),
        avatar: guestAvatar || (memoryDB.users[guestId] ? memoryDB.users[guestId].avatar : '😊'),
        note: '招待リンクで参加'
      };
      if (hIdx >= 0) {
        memoryDB.userFriends[hostId][hIdx] = { ...memoryDB.userFriends[hostId][hIdx], ...guestFriendObj };
      } else {
        memoryDB.userFriends[hostId].push(guestFriendObj);
      }

      // ゲスト側の友達リストにホストを追加
      if (!memoryDB.userFriends[guestId]) memoryDB.userFriends[guestId] = [];
      const gIdx = memoryDB.userFriends[guestId].findIndex(f => f.id === hostId);
      const hostFriendObj = {
        id: hostId,
        name: hostName || (memoryDB.users[hostId] ? memoryDB.users[hostId].name : '友達'),
        avatar: hostAvatar || (memoryDB.users[hostId] ? memoryDB.users[hostId].avatar : '🦊'),
        note: '招待リンクから追加'
      };
      if (gIdx >= 0) {
        memoryDB.userFriends[guestId][gIdx] = { ...memoryDB.userFriends[guestId][gIdx], ...hostFriendObj };
      } else {
        memoryDB.userFriends[guestId].push(hostFriendObj);
      }

      scheduleSave();
      broadcastUpdate('friend_added');

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // --- API エンドポイント: 友達削除 (POST /api/friends/delete) ---
  if (pathname === '/api/friends/delete' && req.method === 'POST') {
    try {
      const { userId: uid, friendId } = await readJsonBody(req, res);
      if (uid && memoryDB.userFriends[uid]) {
        memoryDB.userFriends[uid] = memoryDB.userFriends[uid].filter(f => f.id !== friendId);
        scheduleSave();
        broadcastUpdate('friend_deleted', uid);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // --- API エンドポイント: グループ削除 (POST /api/groups/delete) ---
  if (pathname === '/api/groups/delete' && req.method === 'POST') {
    try {
      const { groupId, userId: uid } = await readJsonBody(req, res);
      const targetGroup = memoryDB.groups.find(g => g.id === groupId);
      if (targetGroup) {
        // 作成者本人のみ削除可能
        if (targetGroup.createdById && uid && targetGroup.createdById !== uid) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'グループを作成した本人のみ削除できます' }));
          return;
        }
        memoryDB.groups = memoryDB.groups.filter(g => g.id !== groupId);
        scheduleSave();
        broadcastUpdate('group_deleted');
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, groups: memoryDB.groups }));
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // --- API エンドポイント: グループ脱退・更新 (POST /api/groups/update) ---
  if (pathname === '/api/groups/update' && req.method === 'POST') {
    try {
      const updatedGroup = await readJsonBody(req, res);
      const idx = memoryDB.groups.findIndex(g => g.id === updatedGroup.id);
      if (idx >= 0) {
        memoryDB.groups[idx] = updatedGroup;
      } else {
        memoryDB.groups.push(updatedGroup);
      }
      scheduleSave();
      broadcastUpdate('group_updated');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, groups: memoryDB.groups }));
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // --- API エンドポイント: 予定削除 (POST /api/events/delete) ---
  if (pathname === '/api/events/delete' && req.method === 'POST') {
    try {
      const { eventId, userId: uid } = await readJsonBody(req, res);
      if (!eventId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'イベントIDが指定されていません' }));
        return;
      }

      const targetEvent = memoryDB.events.find(e => e.id === eventId);
      if (targetEvent) {
        // 作成者本人（または初期互換user_me）のみ削除可能
        if (targetEvent.createdById && targetEvent.createdById !== 'user_me' && uid && targetEvent.createdById !== uid) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '予定を作成した本人のみ削除できます' }));
          return;
        }
      }

      memoryDB.events = memoryDB.events.filter(e => e.id !== eventId);
      if (!Array.isArray(memoryDB.deletedEventIds)) {
        memoryDB.deletedEventIds = [];
      }
      if (!memoryDB.deletedEventIds.includes(eventId)) {
        memoryDB.deletedEventIds.push(eventId);
        if (memoryDB.deletedEventIds.length > 500) {
          memoryDB.deletedEventIds.shift();
        }
      }
      scheduleSave();
      broadcastUpdate('event_deleted');

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, events: memoryDB.events }));
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // --- API エンドポイント: 出欠回答 (POST /api/rsvp) ---
  if (pathname === '/api/rsvp' && req.method === 'POST') {
    try {
      const { eventId, userId: uid, userName, userAvatar, status, comment } = await readJsonBody(req, res);
      const ev = memoryDB.events.find(e => e.id === eventId);
      if (ev) {
        let att = ev.attendees.find(a => a.friendId === uid);
        if (att) {
          att.status = status;
          if (comment !== undefined) att.comment = comment;
          att.updatedAt = new Date().toISOString();
        } else {
          ev.attendees.push({
            friendId: uid || ('u_' + Date.now()),
            name: userName || 'ゲスト',
            avatar: userAvatar || '👤',
            status: status,
            comment: comment || '',
            updatedAt: new Date().toISOString()
          });
        }
        scheduleSave();
        broadcastUpdate('rsvp_updated');
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, event: ev }));
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // --- API エンドポイント: ユーザー情報照会 (GET /api/users/lookup?id=...) ---
  if (pathname === '/api/users/lookup' && req.method === 'GET') {
    const targetId = parsedUrl.searchParams.get('id');
    if (targetId && memoryDB.users[targetId]) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, user: memoryDB.users[targetId] }));
      return;
    }
    for (const ownerId in memoryDB.userFriends) {
      const found = (memoryDB.userFriends[ownerId] || []).find(f => f.id === targetId);
      if (found) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, user: { id: found.id, name: found.name, avatar: found.avatar } }));
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'User not found' }));
    return;
  }

  // --- 静的ファイルの安全な配信 ---
  let filePath = path.join(__dirname, pathname);
  if (filePath === __dirname || filePath === __dirname + '\\' || filePath === __dirname + '/') {
    filePath = path.join(__dirname, 'index.html');
  }

  const safePath = path.resolve(__dirname);
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(safePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(resolvedPath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`GatherSync Server running at http://localhost:${PORT}/`);
  });
}

module.exports = server;
