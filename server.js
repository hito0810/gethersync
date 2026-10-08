const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.VERCEL ? path.join('/tmp', 'database.json') : path.join(__dirname, 'database.json');

// --- Supabase クラウドデータベース接続設定 ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });
    console.log('🚀 Supabase Cloud Database に正常に接続しました！');
  } catch (err) {
    console.warn('⚠️ @supabase/supabase-js の初期化に失敗（ローカルDBで代替動作します）:', err.message);
  }
} else {
  console.log('ℹ️ SUPABASE_URL / SUPABASE_KEY が未設定のため、ローカル高速インメモリDBで動作します。');
}

// --- DB/アプリ用 モデルマッピング関数 ---
function eventToDb(e) {
  return {
    id: e.id,
    title: e.title,
    category: e.category || 'other',
    start_date_time: e.startDateTime || '',
    end_date_time: e.endDateTime || '',
    deadline: e.deadline || '',
    location: e.location || '',
    description: e.description || '',
    scope: e.scope || 'all',
    group_id: e.groupId || null,
    target_friend_ids: e.targetFriendIds || [],
    created_by_id: e.createdById || null,
    attendees: e.attendees || [],
    updated_at: new Date().toISOString()
  };
}

function dbToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    startDateTime: row.start_date_time,
    endDateTime: row.end_date_time,
    deadline: row.deadline,
    location: row.location,
    description: row.description,
    scope: row.scope,
    groupId: row.group_id,
    targetFriendIds: row.target_friend_ids || [],
    createdById: row.created_by_id,
    attendees: row.attendees || []
  };
}

function groupToDb(g) {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon || '👥',
    created_by_id: g.createdById || null,
    member_ids: g.memberIds || [],
    updated_at: new Date().toISOString()
  };
}

function dbToGroup(row) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    createdById: row.created_by_id,
    memberIds: row.member_ids || []
  };
}

function friendToDb(userId, f) {
  return {
    user_id: userId,
    friend_id: f.id,
    name: f.name || '友達',
    avatar: f.avatar || '😊',
    note: f.note || ''
  };
}

function dbToFriend(row) {
  return {
    id: row.friend_id,
    name: row.name,
    avatar: row.avatar,
    note: row.note
  };
}

// --- インメモリ高速キャッシュ ＆ ローカルフォールバックDB ---
let memoryDB = {
  epoch: Date.now(),
  users: {},
  userFriends: {},
  groups: [],
  events: [],
  deletedEventIds: [],
  notifications: []
};

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

// 終了日時を1時間過ぎた予定の自動削除
async function cleanExpiredEvents() {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;

  if (supabase) {
    try {
      const { data: rows } = await supabase.from('events').select('id, start_date_time, end_date_time');
      if (rows && rows.length > 0) {
        const expiredIds = [];
        rows.forEach(e => {
          let endTimestamp = 0;
          if (e.end_date_time) endTimestamp = parseDateJST(e.end_date_time);
          else if (e.start_date_time) endTimestamp = parseDateJST(e.start_date_time) + (2 * 60 * 60 * 1000);
          if (endTimestamp > 0 && (now - endTimestamp >= ONE_HOUR)) {
            expiredIds.push(e.id);
          }
        });
        if (expiredIds.length > 0) {
          await supabase.from('events').delete().in('id', expiredIds);
          const delEntries = expiredIds.map(id => ({ id }));
          await supabase.from('deleted_event_ids').upsert(delEntries);
          broadcastUpdate('event_expired_cleanup');
        }
      }
    } catch (err) {
      console.error('Supabase cleanExpiredEvents error:', err.message);
    }
    return;
  }

  // ローカルフォールバック
  if (!Array.isArray(memoryDB.events)) return;
  const activeEvents = [];
  const newlyDeletedIds = [];

  memoryDB.events.forEach(e => {
    let endTimestamp = 0;
    if (e.endDateTime) {
      endTimestamp = parseDateJST(e.endDateTime);
    } else if (e.startDateTime) {
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
setInterval(cleanExpiredEvents, 60 * 1000);

let saveTimeout = null;
function scheduleSave() {
  if (supabase) return; // Supabase使用時はローカルファイル書き込み不要
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

// 15秒ごとのハートビート
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.res.write(': ping\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 15000);

// --- 🛡️ セキュリティ ＆ レートリミッター ---
const rateLimits = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 200;
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 1, resetTime: now + windowMs };
    rateLimits.set(ip, entry);
    return true;
  }
  entry.count++;
  return entry.count <= maxRequests;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits.entries()) {
    if (now > entry.resetTime) {
      rateLimits.delete(ip);
    }
  }
}, 5 * 60 * 1000);

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
  const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
  if (!req.url.startsWith('/api/events/stream') && !checkRateLimit(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'リクエスト頻度が高すぎます。しばらく時間をおいて再試行してください。' }));
    return;
  }

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

    try {
      if (supabase) {
        // --- ☁️ Supabase PostgreSQL インデックス高速抽出 ---
        // 1. 友達一覧
        const { data: friendsRows } = await supabase.from('friends').select('*').eq('user_id', userId);
        const myFriends = (friendsRows || []).map(dbToFriend);
        const myFriendIds = myFriends.map(f => f.id);

        // 2. グループ一覧
        const { data: allGroups } = await supabase.from('groups').select('*');
        const myGroups = (allGroups || []).map(dbToGroup).filter(g =>
          g.createdById === userId || (Array.isArray(g.memberIds) && g.memberIds.includes(userId))
        );

        // グループメンバー情報の解決
        const enrichedGroups = myGroups.map(g => {
          const membersInfo = (g.memberIds || []).map(mid => {
            if (mid === userId) return { id: mid, name: 'あなた', avatar: '🦊', isMe: true };
            const foundF = myFriends.find(f => f.id === mid);
            return { id: mid, name: foundF ? foundF.name : 'メンバー', avatar: foundF ? foundF.avatar : '😊' };
          });
          return { ...g, membersInfo };
        });

        // 3. 予定（イベント）一覧（厳格なプライバシー制御）
        const { data: eventsRows } = await supabase.from('events').select('*');
        const myEvents = (eventsRows || []).map(dbToEvent).filter(e => {
          if (e.createdById === userId || e.createdById === 'user_me') return true;
          if (e.attendees && e.attendees.some(a => a.friendId === userId)) return true;
          if (e.scope === 'friends') {
            return Array.isArray(e.targetFriendIds) && e.targetFriendIds.includes(userId);
          }
          if (e.scope === 'group' && e.groupId) {
            return myGroups.some(g => g.id === e.groupId);
          }
          // 全体の友達: 相互・友達関係にある相手のみ
          return myFriendIds.includes(e.createdById);
        });

        // 4. 削除済み予定リスト
        const { data: delRows } = await supabase.from('deleted_event_ids').select('id');
        const deletedEventIds = (delRows || []).map(r => r.id);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          epoch: Date.now(),
          friends: myFriends,
          groups: enrichedGroups,
          events: myEvents,
          deletedEventIds: deletedEventIds
        }));
        return;
      }

      // --- 💾 ローカルインメモリフォールバック ---
      const rawFriends = memoryDB.userFriends[userId] || [];
      const myFriends = rawFriends.map(f => {
        const latestUser = memoryDB.users[f.id];
        if (latestUser) return { ...f, name: latestUser.name || f.name, avatar: latestUser.avatar || f.avatar };
        return f;
      });
      const myFriendIds = myFriends.map(f => f.id);

      const myGroups = (memoryDB.groups || []).filter(g =>
        g.createdById === userId || (Array.isArray(g.memberIds) && g.memberIds.includes(userId))
      );

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

      const myEvents = (memoryDB.events || []).filter(e => {
        if (e.createdById === userId || e.createdById === 'user_me') return true;
        if (e.attendees && e.attendees.some(a => a.friendId === userId)) return true;
        if (e.scope === 'friends') {
          return Array.isArray(e.targetFriendIds) && e.targetFriendIds.includes(userId);
        }
        if (e.scope === 'group' && e.groupId) {
          const grp = (memoryDB.groups || []).find(g => g.id === e.groupId);
          return grp && Array.isArray(grp.memberIds) && grp.memberIds.includes(userId);
        }
        const isFriend = myFriendIds.includes(e.createdById);
        const creatorFriends = memoryDB.userFriends[e.createdById] || [];
        return isFriend || creatorFriends.some(f => f.id === userId);
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        epoch: memoryDB.epoch || 1,
        friends: myFriends,
        groups: enrichedGroups,
        events: myEvents,
        deletedEventIds: memoryDB.deletedEventIds || []
      }));
    } catch (err) {
      console.error('GET /api/sync error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- API エンドポイント: 予定の単体保存 (POST /api/events/save) ---
  if (pathname === '/api/events/save' && req.method === 'POST') {
    try {
      const ev = await readJsonBody(req, res);
      if (ev && ev.id) {
        if (supabase) {
          const { data: existing } = await supabase.from('events').select('created_by_id').eq('id', ev.id).single();
          if (existing && existing.created_by_id && existing.created_by_id !== 'user_me' && ev.createdById && existing.created_by_id !== ev.createdById) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '他のユーザーが作成した予定は直接変更できません' }));
            return;
          }
          await supabase.from('deleted_event_ids').delete().eq('id', ev.id);
          await supabase.from('events').upsert(eventToDb(ev));
        } else {
          const idx = memoryDB.events.findIndex(e => e.id === ev.id);
          if (idx >= 0) {
            const existing = memoryDB.events[idx];
            if (existing.createdById && existing.createdById !== 'user_me' && ev.createdById && existing.createdById !== ev.createdById) {
              res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: '他のユーザーが作成した予定は直接変更できません' }));
              return;
            }
            memoryDB.events[idx] = ev;
          } else {
            memoryDB.events.unshift(ev);
          }
          if (Array.isArray(memoryDB.deletedEventIds)) {
            memoryDB.deletedEventIds = memoryDB.deletedEventIds.filter(id => id !== ev.id);
          }
          scheduleSave();
        }
        broadcastUpdate('event_saved');
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

  // --- API エンドポイント: ユーザー個別データ保存 (POST /api/sync) ---
  if (pathname === '/api/sync' && req.method === 'POST') {
    try {
      const incoming = await readJsonBody(req, res);
      const currentUid = incoming.user ? incoming.user.id : null;

      if (supabase) {
        if (incoming.user && currentUid) {
          await supabase.from('users').upsert({ id: currentUid, name: incoming.user.name, avatar: incoming.user.avatar, updated_at: new Date().toISOString() });
          if (Array.isArray(incoming.friends)) {
            const fRows = incoming.friends.filter(f => f && f.id && f.id !== currentUid).map(f => friendToDb(currentUid, f));
            if (fRows.length > 0) await supabase.from('friends').upsert(fRows);
          }
        }
        if (Array.isArray(incoming.groups)) {
          const gRows = incoming.groups.filter(g => g && g.id).map(groupToDb);
          if (gRows.length > 0) await supabase.from('groups').upsert(gRows);
        }
        if (Array.isArray(incoming.events)) {
          const eRows = incoming.events.filter(e => e && e.id).map(eventToDb);
          if (eRows.length > 0) await supabase.from('events').upsert(eRows);
        }
      } else {
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
        if (Array.isArray(incoming.groups)) {
          incoming.groups.forEach(g => {
            if (!g || !g.id) return;
            const idx = memoryDB.groups.findIndex(dg => dg.id === g.id);
            if (idx >= 0) {
              const existing = memoryDB.groups[idx];
              const isMember = (existing.memberIds || []).includes(currentUid) || existing.createdById === currentUid;
              if (isMember) memoryDB.groups[idx] = g;
            } else {
              if (!g.createdById && currentUid) g.createdById = currentUid;
              memoryDB.groups.push(g);
            }
          });
        }
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
                if (aIdx >= 0) mergedAttendees[aIdx] = inAtt;
                else mergedAttendees.push(inAtt);
              });
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
      }

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

  // --- API エンドポイント: 友達追加 (POST /api/friends) ---
  if (pathname === '/api/friends' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req, res);
      const { hostId, guestId, guestName, guestAvatar, hostName, hostAvatar } = payload;

      if (!hostId || !guestId || hostId === guestId) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, ignored: true }));
        return;
      }

      if (supabase) {
        // ユーザープロフィールの更新
        await supabase.from('users').upsert([
          { id: guestId, name: guestName || '友達', avatar: guestAvatar || '😊' },
          { id: hostId, name: hostName || '友達', avatar: hostAvatar || '🦊' }
        ]);
        // 双方向の友達関係の保存
        await supabase.from('friends').upsert([
          { user_id: hostId, friend_id: guestId, name: guestName || '友達', avatar: guestAvatar || '😊', note: '招待リンクで参加' },
          { user_id: guestId, friend_id: hostId, name: hostName || '友達', avatar: hostAvatar || '🦊', note: '招待リンクから追加' }
        ]);
      } else {
        if (guestId) {
          if (!memoryDB.users[guestId]) memoryDB.users[guestId] = { id: guestId, name: guestName || '友達', avatar: guestAvatar || '😊' };
          else {
            if (guestName) memoryDB.users[guestId].name = guestName;
            if (guestAvatar) memoryDB.users[guestId].avatar = guestAvatar;
          }
        }
        if (hostId) {
          if (!memoryDB.users[hostId]) memoryDB.users[hostId] = { id: hostId, name: hostName || '友達', avatar: hostAvatar || '🦊' };
          else {
            if (hostName) memoryDB.users[hostId].name = hostName;
            if (hostAvatar) memoryDB.users[hostId].avatar = hostAvatar;
          }
        }
        if (!memoryDB.userFriends[hostId]) memoryDB.userFriends[hostId] = [];
        const hIdx = memoryDB.userFriends[hostId].findIndex(f => f.id === guestId);
        const guestObj = { id: guestId, name: guestName || '友達', avatar: guestAvatar || '😊', note: '招待リンクで参加' };
        if (hIdx >= 0) memoryDB.userFriends[hostId][hIdx] = { ...memoryDB.userFriends[hostId][hIdx], ...guestObj };
        else memoryDB.userFriends[hostId].push(guestObj);

        if (!memoryDB.userFriends[guestId]) memoryDB.userFriends[guestId] = [];
        const gIdx = memoryDB.userFriends[guestId].findIndex(f => f.id === hostId);
        const hostObj = { id: hostId, name: hostName || '友達', avatar: hostAvatar || '🦊', note: '招待リンクから追加' };
        if (gIdx >= 0) memoryDB.userFriends[guestId][gIdx] = { ...memoryDB.userFriends[guestId][gIdx], ...hostObj };
        else memoryDB.userFriends[guestId].push(hostObj);

        scheduleSave();
      }

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
      if (uid && friendId) {
        if (supabase) {
          await supabase.from('friends').delete().eq('user_id', uid).eq('friend_id', friendId);
        } else if (memoryDB.userFriends[uid]) {
          memoryDB.userFriends[uid] = memoryDB.userFriends[uid].filter(f => f.id !== friendId);
          scheduleSave();
        }
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
      if (supabase) {
        const { data: targetGroup } = await supabase.from('groups').select('created_by_id').eq('id', groupId).single();
        if (targetGroup && targetGroup.created_by_id && uid && targetGroup.created_by_id !== uid) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'グループを作成した本人のみ削除できます' }));
          return;
        }
        await supabase.from('groups').delete().eq('id', groupId);
      } else {
        const targetGroup = memoryDB.groups.find(g => g.id === groupId);
        if (targetGroup && targetGroup.createdById && uid && targetGroup.createdById !== uid) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'グループを作成した本人のみ削除できます' }));
          return;
        }
        memoryDB.groups = memoryDB.groups.filter(g => g.id !== groupId);
        scheduleSave();
      }
      broadcastUpdate('group_deleted');
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

  // --- API エンドポイント: グループ更新 (POST /api/groups/update) ---
  if (pathname === '/api/groups/update' && req.method === 'POST') {
    try {
      const updatedGroup = await readJsonBody(req, res);
      if (supabase) {
        await supabase.from('groups').upsert(groupToDb(updatedGroup));
      } else {
        const idx = memoryDB.groups.findIndex(g => g.id === updatedGroup.id);
        if (idx >= 0) memoryDB.groups[idx] = updatedGroup;
        else memoryDB.groups.push(updatedGroup);
        scheduleSave();
      }
      broadcastUpdate('group_updated');
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

  // --- API エンドポイント: 予定削除 (POST /api/events/delete) ---
  if (pathname === '/api/events/delete' && req.method === 'POST') {
    try {
      const { eventId, userId: uid } = await readJsonBody(req, res);
      if (!eventId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'イベントIDが指定されていません' }));
        return;
      }

      if (supabase) {
        const { data: targetEvent } = await supabase.from('events').select('created_by_id').eq('id', eventId).single();
        if (targetEvent && targetEvent.created_by_id && targetEvent.created_by_id !== 'user_me' && uid && targetEvent.created_by_id !== uid) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '予定を作成した本人のみ削除できます' }));
          return;
        }
        await supabase.from('events').delete().eq('id', eventId);
        await supabase.from('deleted_event_ids').upsert({ id: eventId });
      } else {
        const targetEvent = memoryDB.events.find(e => e.id === eventId);
        if (targetEvent && targetEvent.createdById && targetEvent.createdById !== 'user_me' && uid && targetEvent.createdById !== uid) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '予定を作成した本人のみ削除できます' }));
          return;
        }
        memoryDB.events = memoryDB.events.filter(e => e.id !== eventId);
        if (!Array.isArray(memoryDB.deletedEventIds)) memoryDB.deletedEventIds = [];
        if (!memoryDB.deletedEventIds.includes(eventId)) {
          memoryDB.deletedEventIds.push(eventId);
          if (memoryDB.deletedEventIds.length > 500) memoryDB.deletedEventIds.shift();
        }
        scheduleSave();
      }

      broadcastUpdate('event_deleted');
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

  // --- API エンドポイント: 出欠回答 (POST /api/rsvp) ---
  if (pathname === '/api/rsvp' && req.method === 'POST') {
    try {
      const { eventId, userId: uid, userName, userAvatar, status, comment } = await readJsonBody(req, res);
      if (supabase) {
        const { data: row } = await supabase.from('events').select('*').eq('id', eventId).single();
        if (row) {
          const ev = dbToEvent(row);
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
          await supabase.from('events').update({ attendees: ev.attendees, updated_at: new Date().toISOString() }).eq('id', eventId);
        }
      } else {
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
        }
      }

      broadcastUpdate('rsvp_updated');
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

  // --- API エンドポイント: ユーザー照会 (GET /api/users/lookup?id=...) ---
  if (pathname === '/api/users/lookup' && req.method === 'GET') {
    const targetId = parsedUrl.searchParams.get('id');
    if (targetId) {
      if (supabase) {
        const { data: u } = await supabase.from('users').select('*').eq('id', targetId).single();
        if (u) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, user: u }));
          return;
        }
      } else {
        if (memoryDB.users[targetId]) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, user: memoryDB.users[targetId] }));
          return;
        }
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'User not found' }));
    return;
  }

  // --- 静的ファイルの配信 ---
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
