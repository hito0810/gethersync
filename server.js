const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// --- インメモリ高速キャッシュ ＆ データベース管理 ---
let memoryDB = {
  epoch: Date.now(),
  users: {},
  userFriends: {},
  groups: [],
  events: [],
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
        notifications: data.notifications || []
      };
    } catch (e) {
      console.error('Error loading DB, initializing new:', e);
    }
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(memoryDB, null, 2), 'utf-8');
  }
}
initDB();

// 非同期デバウンス保存（1秒間に何千回書き込みがあってもディスクI/Oが詰まらない）
let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(memoryDB, null, 2), 'utf-8', (err) => {
      if (err) console.error('Error saving DB asynchronously:', err);
    });
  }, 100); // 100msデバウンスバッチ
}

// --- SSE (Server-Sent Events) リアルタイム配信マネージャー ---
// 接続中のクライアント一覧: Set of { res, userId }
const sseClients = new Set();

function broadcastUpdate(reason = 'update', targetUserId = null) {
  const payload = JSON.stringify({ type: 'sync', reason, timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      // 全体通知、または特定ユーザー宛て
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

const server = http.createServer((req, res) => {
  // CORS & セキュリティヘッダー
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

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

    // 🔒 ユーザーIDごとにプライバシーを完全分離（インメモリから0msで高速抽出）
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
    
    // 自分が作成者、またはメンバーに含まれているグループのみ
    const myGroups = (memoryDB.groups || []).filter(g => 
      g.createdById === userId || (Array.isArray(g.memberIds) && g.memberIds.includes(userId))
    );

    // グループ情報の充実化（全メンバーの名前・アバターを解決して同期）
    const enrichedGroups = myGroups.map(g => {
      const membersInfo = (g.memberIds || []).map(mid => {
        if (mid === userId) {
          const meUser = memoryDB.users[userId];
          return { id: mid, name: meUser ? meUser.name : 'あなた', avatar: meUser ? meUser.avatar : '🦊', isMe: true };
        }
        const u = memoryDB.users[mid];
        if (u) return { id: mid, name: u.name, avatar: u.avatar || '😊' };
        // 友達リストからも逆引き
        for (const ownerId in memoryDB.userFriends) {
          const found = (memoryDB.userFriends[ownerId] || []).find(f => f.id === mid);
          if (found) return { id: mid, name: found.name, avatar: found.avatar || '😊' };
        }
        return { id: mid, name: 'メンバー', avatar: '😊' };
      });
      return { ...g, membersInfo };
    });

    // 予定（イベント）のフィルタリング:
    // 1. 自分が作成者
    // 2. 出欠リスト（attendees）に自分が含まれている
    // 3. グループ指定予定の場合: グループメンバーに含まれている
    // 4. 全体/個別招待の予定の場合: 作成者が自分の友達リストにいる、または作成者の友達リストに自分がいる
    const myEvents = (memoryDB.events || []).filter(e => {
      if (e.createdById === userId) return true;
      if (e.attendees && e.attendees.some(a => a.friendId === userId)) return true;
      if (e.groupId) {
        const grp = (memoryDB.groups || []).find(g => g.id === e.groupId);
        if (grp && Array.isArray(grp.memberIds) && grp.memberIds.includes(userId)) return true;
        return false;
      }
      if (myFriendIds.includes(e.createdById)) return true;
      const creatorFriends = memoryDB.userFriends[e.createdById] || [];
      if (creatorFriends.some(f => f.id === userId)) return true;
      return false;
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      epoch: memoryDB.epoch || 1,
      friends: myFriends,
      groups: enrichedGroups,
      events: myEvents
    }));
    return;
  }

  // --- API エンドポイント: 予定の単体保存 (POST /api/events/save) ---
  if (pathname === '/api/events/save' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        if (ev && ev.id) {
          const idx = memoryDB.events.findIndex(e => e.id === ev.id);
          if (idx >= 0) {
            memoryDB.events[idx] = ev;
          } else {
            memoryDB.events.unshift(ev);
          }
          scheduleSave();
          broadcastUpdate('event_saved');
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, event: ev }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API エンドポイント: ユーザー個別データ保存 (POST /api/sync) ---
  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
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

        if (Array.isArray(incoming.groups)) {
          incoming.groups.forEach(g => {
            const idx = memoryDB.groups.findIndex(dg => dg.id === g.id);
            if (idx >= 0) memoryDB.groups[idx] = g;
            else memoryDB.groups.push(g);
          });
        }

        if (Array.isArray(incoming.events)) {
          incoming.events.forEach(e => {
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
              memoryDB.events[idx] = { ...existing, ...e, attendees: mergedAttendees };
            } else {
              memoryDB.events.unshift(e);
            }
          });
        }

        scheduleSave();
        broadcastUpdate('sync');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API エンドポイント: 友達追加・招待登録 (POST /api/friends) ---
  if (pathname === '/api/friends' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { hostId, guestId, guestName, guestAvatar, hostName, hostAvatar } = payload;

        // 自分自身の友達追加（増殖）を完全ブロック（IDのみで判定）
        if (!hostId || !guestId || hostId === guestId) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, ignored: true }));
          return;
        }

        // ゲスト側のユーザープロフィールの保存・最新化
        if (guestId) {
          if (!memoryDB.users[guestId]) {
            memoryDB.users[guestId] = { id: guestId, name: guestName || '友達', avatar: guestAvatar || '😊' };
          } else {
            if (guestName) memoryDB.users[guestId].name = guestName;
            if (guestAvatar) memoryDB.users[guestId].avatar = guestAvatar;
          }
        }

        // ホスト側のユーザープロフィールの保存・最新化
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
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API エンドポイント: 友達削除 (POST /api/friends/delete) ---
  if (pathname === '/api/friends/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { userId: uid, friendId } = JSON.parse(body);
        if (uid && memoryDB.userFriends[uid]) {
          memoryDB.userFriends[uid] = memoryDB.userFriends[uid].filter(f => f.id !== friendId);
          scheduleSave();
          broadcastUpdate('friend_deleted', uid);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API エンドポイント: グループ削除 (POST /api/groups/delete) ---
  if (pathname === '/api/groups/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { groupId } = JSON.parse(body);
        memoryDB.groups = memoryDB.groups.filter(g => g.id !== groupId);
        scheduleSave();
        broadcastUpdate('group_deleted');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, groups: memoryDB.groups }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API エンドポイント: グループ脱退・更新 (POST /api/groups/update) ---
  if (pathname === '/api/groups/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const updatedGroup = JSON.parse(body);
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
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }



  // --- API エンドポイント: 予定削除 (POST /api/events/delete) ---
  if (pathname === '/api/events/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { eventId } = JSON.parse(body);
        memoryDB.events = memoryDB.events.filter(e => e.id !== eventId);
        scheduleSave();
        broadcastUpdate('event_deleted');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, events: memoryDB.events }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API エンドポイント: 出欠回答 (POST /api/rsvp) ---
  if (pathname === '/api/rsvp' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { eventId, userId: uid, userName, userAvatar, status, comment } = JSON.parse(body);
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
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  // --- API エンドポイント: ユーザー情報自動照会 (GET /api/users/lookup?id=...) ---
  if (pathname === '/api/users/lookup' && req.method === 'GET') {
    const targetId = parsedUrl.searchParams.get('id');
    if (targetId && memoryDB.users[targetId]) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, user: memoryDB.users[targetId] }));
      return;
    }
    // 友達リストからも逆引き
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
    console.log(`GatherSync Real-Time In-Memory Server running at http://localhost:${PORT}/`);
  });
}

module.exports = server;
