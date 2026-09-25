/**
 * GatherSync データモデル & ストレージ & 公開サーバー同期管理
 */

export const STORAGE_KEYS = {
  CURRENT_USER: 'gathersync_current_user',
  FRIENDS: 'gathersync_friends',
  GROUPS: 'gathersync_groups',
  EVENTS: 'gathersync_events',
  DELETED_EVENTS: 'gathersync_deleted_events',
  NOTIFICATIONS: 'gathersync_notifications',
  SETTINGS: 'gathersync_settings',
  SECURITY: 'gathersync_security'
};

// XSSサニタイズ用ヘルパー
export const sanitize = (str) => {
  if (typeof str !== 'string') return str || '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

// 悪意のあるURLの無害化
export const safeUrl = (url) => {
  if (!url) return '';
  const trimmed = url.trim().toLowerCase();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return encodeURI(url.trim());
  }
  return '';
};

// ユニークID生成
export const generateUniqueUserId = (prefix = 'usr') => {
  return prefix + '_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
};

// Safari プライベートブラウズ等でのLocalStorage保護ラッパー
const MemoryStore = {};
export const SafeStorage = {
  getItem(key) {
    try {
      return localStorage.getItem(key) || MemoryStore[key] || null;
    } catch (e) {
      return MemoryStore[key] || null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      MemoryStore[key] = value;
    }
  }
};

export const CookieManager = {
  get(name) {
    try {
      const matches = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'));
      return matches ? decodeURIComponent(matches[1]) : null;
    } catch (e) { return null; }
  },
  set(name, value, days = 365) {
    try {
      let expires = '';
      if (days) {
        const d = new Date();
        d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = '; expires=' + d.toUTCString();
      }
      document.cookie = name + '=' + encodeURIComponent(value) + expires + '; path=/; SameSite=Lax';
    } catch (e) { }
  }
};

const INITIAL_DATA = {
  currentUser: {
    id: '',
    name: '自分 (あなた)',
    avatar: '🦊',
    color: '#6366f1'
  },
  friends: [],
  groups: [],
  events: [],
  notifications: []
};

export const ServerApi = {
  getBaseUrl() {
    return '';
  },

  async syncGet(userId) {
    if (!userId) return null;
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/sync?userId=${encodeURIComponent(userId)}&_t=${Date.now()}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async syncPost(payload) {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async saveEvent(event) {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/events/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async deleteEvent(eventId) {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/events/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId })
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async submitRSVP(eventId, userId, userName, userAvatar, status, comment) {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/rsvp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, userId, userName, userAvatar, status, comment })
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async addFriend(hostId, guestId, guestName, guestAvatar, hostName, hostAvatar) {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/friends`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId, guestId, guestName, guestAvatar, hostName, hostAvatar })
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async deleteFriend(userId, friendId) {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/friends/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, friendId })
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async updateGroup(group) {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/groups/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(group)
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  },

  async deleteGroup(groupId) {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/groups/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId })
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }
};

export class StorageManager {
  static init() {
    let user = null;
    const userStr = SafeStorage.getItem(STORAGE_KEYS.CURRENT_USER);
    if (userStr) {
      try {
        const parsed = JSON.parse(userStr);
        if (parsed && parsed.id && parsed.id !== 'user_me') user = parsed;
      } catch (e) { }
    }

    if (!user) {
      const cookieUid = CookieManager.get('gathersync_user_id');
      if (cookieUid && cookieUid.startsWith('usr_')) {
        user = {
          id: cookieUid,
          name: CookieManager.get('gathersync_user_name') || 'あなた',
          avatar: CookieManager.get('gathersync_user_avatar') || '🦊'
        };
      }
    }

    if (!user) {
      user = {
        id: generateUniqueUserId('usr'),
        name: 'あなた',
        avatar: '🦊',
        color: '#6366f1'
      };
    }

    SafeStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
    CookieManager.set('gathersync_user_id', user.id);
    CookieManager.set('gathersync_user_name', user.name);
    CookieManager.set('gathersync_user_avatar', user.avatar);

    if (!SafeStorage.getItem(STORAGE_KEYS.FRIENDS)) {
      SafeStorage.setItem(STORAGE_KEYS.FRIENDS, JSON.stringify(INITIAL_DATA.friends));
    }
    if (!SafeStorage.getItem(STORAGE_KEYS.GROUPS)) {
      SafeStorage.setItem(STORAGE_KEYS.GROUPS, JSON.stringify(INITIAL_DATA.groups));
    }
    if (!SafeStorage.getItem(STORAGE_KEYS.EVENTS)) {
      SafeStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(INITIAL_DATA.events));
    }
    if (!SafeStorage.getItem(STORAGE_KEYS.NOTIFICATIONS)) {
      SafeStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(INITIAL_DATA.notifications));
    }

    this.pushAllToServer();
  }

  static pushAllToServer() {
    const user = this.getCurrentUser();
    const friends = this.getFriends();
    const groups = this.getGroups();
    const events = this.getEvents();
    ServerApi.syncPost({ user, friends, groups, events }).catch(() => { });
  }

  static resetToDefault() {
    SafeStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(INITIAL_DATA.currentUser));
    SafeStorage.setItem(STORAGE_KEYS.FRIENDS, JSON.stringify(INITIAL_DATA.friends));
    SafeStorage.setItem(STORAGE_KEYS.GROUPS, JSON.stringify(INITIAL_DATA.groups));
    SafeStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(INITIAL_DATA.events));
    SafeStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(INITIAL_DATA.notifications));
  }

  // --- Current User ---
  static getCurrentUser() {
    try {
      const u = JSON.parse(SafeStorage.getItem(STORAGE_KEYS.CURRENT_USER));
      if (u && u.id && u.id !== 'user_me') return u;
    } catch (e) { }
    const newU = { id: generateUniqueUserId('usr'), name: 'あなた', avatar: '🦊', color: '#6366f1' };
    SafeStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(newU));
    return newU;
  }

  static saveCurrentUser(user) {
    SafeStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
    CookieManager.set('gathersync_user_name', user.name);
    CookieManager.set('gathersync_user_avatar', user.avatar);
    this.pushAllToServer();
  }

  // --- Friends ---
  static getFriends() {
    const list = JSON.parse(SafeStorage.getItem(STORAGE_KEYS.FRIENDS) || '[]');
    const me = this.getCurrentUser();
    return list.filter(f => f && f.id && f.id !== me.id);
  }

  static saveFriends(friends) {
    const me = this.getCurrentUser();
    const cleanList = (friends || []).filter(x => x && x.id && x.id !== me.id);
    SafeStorage.setItem(STORAGE_KEYS.FRIENDS, JSON.stringify(cleanList));
  }

  static addFriend(friend) {
    const me = this.getCurrentUser();
    const friends = this.getFriends();
    const newFriend = {
      id: friend.id || generateUniqueUserId('usr'),
      name: friend.name || '友達',
      avatar: friend.avatar || '😊',
      note: friend.note || ''
    };
    const idx = friends.findIndex(f => f.id === newFriend.id);
    if (idx >= 0) {
      friends[idx] = { ...friends[idx], ...newFriend };
    } else {
      friends.push(newFriend);
    }
    this.saveFriends(friends);
    ServerApi.addFriend(newFriend.id, me.id, me.name, me.avatar, newFriend.name, newFriend.avatar).catch(() => { });
    return newFriend;
  }

  static deleteFriend(friendId) {
    const me = this.getCurrentUser();
    let friends = this.getFriends().filter(f => f.id !== friendId);
    this.saveFriends(friends);
    let groups = this.getGroups();
    groups.forEach(g => {
      g.memberIds = (g.memberIds || []).filter(id => id !== friendId);
    });
    this.saveGroups(groups);
    ServerApi.deleteFriend(me.id, friendId).catch(() => { });
  }

  // --- Groups ---
  static getGroups() {
    return JSON.parse(SafeStorage.getItem(STORAGE_KEYS.GROUPS) || '[]');
  }

  static saveGroups(groups) {
    SafeStorage.setItem(STORAGE_KEYS.GROUPS, JSON.stringify(groups));
  }

  static addGroup(group) {
    const groups = this.getGroups();
    const me = this.getCurrentUser();
    const memberIds = Array.isArray(group.memberIds) ? [...group.memberIds] : [];
    if (!memberIds.includes(me.id)) memberIds.push(me.id);

    const newGroup = {
      id: group.id || generateUniqueUserId('grp'),
      name: group.name,
      icon: group.icon || '👥',
      color: group.color || '#6366f1',
      description: group.description || '',
      memberIds: memberIds,
      createdById: me.id
    };
    groups.unshift(newGroup);
    this.saveGroups(groups);
    ServerApi.updateGroup(newGroup).catch(() => { });
    return newGroup;
  }

  static updateGroup(group) {
    const groups = this.getGroups().map(g => g.id === group.id ? { ...g, ...group } : g);
    this.saveGroups(groups);
    ServerApi.updateGroup(group).catch(() => { });
  }

  static deleteGroup(groupId) {
    const groups = this.getGroups().filter(g => g.id !== groupId);
    this.saveGroups(groups);
    ServerApi.deleteGroup(groupId).catch(() => { });
  }

  // --- Events ---
  static getEvents() {
    return JSON.parse(SafeStorage.getItem(STORAGE_KEYS.EVENTS) || '[]');
  }

  static saveEvents(events) {
    SafeStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(events));
  }

  static getEventById(id) {
    return this.getEvents().find(e => e.id === id);
  }

  static addEvent(eventData) {
    const events = this.getEvents();
    const currentUser = this.getCurrentUser();

    const attendees = [
      {
        friendId: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar,
        status: 'going',
        updatedAt: new Date().toISOString(),
        comment: '主催者'
      }
    ];

    const newEvent = {
      id: generateUniqueUserId('ev'),
      title: eventData.title,
      description: eventData.description || '',
      category: eventData.category || 'other',
      location: eventData.location || '',
      passcode: eventData.passcode || '',
      startDateTime: eventData.startDateTime,
      endDateTime: eventData.endDateTime || '',
      deadlineDateTime: eventData.deadlineDateTime,
      groupId: eventData.groupId || eventData.targetGroupId || null,
      groupName: eventData.groupName || '個別招待 / 全体',
      createdById: currentUser.id,
      attendees: attendees,
      isDeadlinePassed: false,
      createdAt: new Date().toISOString()
    };

    events.unshift(newEvent);
    this.saveEvents(events);
    ServerApi.saveEvent(newEvent).catch(() => { });
    return newEvent;
  }

  static updateRSVP(eventId, userId, status, comment = '') {
    const events = this.getEvents();
    const event = events.find(e => e.id === eventId);
    if (!event) return null;
    const currentUser = this.getCurrentUser();

    let attendee = event.attendees.find(a => a.friendId === userId);
    if (attendee) {
      attendee.status = status;
      attendee.updatedAt = new Date().toISOString();
      if (comment !== undefined && comment !== '') attendee.comment = comment;
    } else {
      event.attendees.push({
        friendId: userId,
        name: currentUser.name,
        avatar: currentUser.avatar,
        status: status,
        comment: comment || '',
        updatedAt: new Date().toISOString()
      });
    }

    this.saveEvents(events);
    ServerApi.submitRSVP(eventId, userId, currentUser.name, currentUser.avatar, status, comment).catch(() => { });
    return event;
  }

  static getDeletedEventIds() {
    try {
      return JSON.parse(SafeStorage.getItem(STORAGE_KEYS.DELETED_EVENTS) || '[]');
    } catch (e) { return []; }
  }

  static addDeletedEventId(eventId) {
    if (!eventId) return;
    const list = this.getDeletedEventIds();
    if (!list.includes(eventId)) {
      list.push(eventId);
      if (list.length > 300) list.shift();
      SafeStorage.setItem(STORAGE_KEYS.DELETED_EVENTS, JSON.stringify(list));
    }
  }

  static deleteEvent(eventId) {
    this.addDeletedEventId(eventId);
    const events = this.getEvents().filter(e => e.id !== eventId);
    this.saveEvents(events);
    return ServerApi.deleteEvent(eventId).catch(() => { });
  }

  // --- スマートマージ（サーバーとローカルを安全に統合し、ローカルデータを勝手に消さない） ---
  static mergeFriends(serverFriends) {
    if (!Array.isArray(serverFriends)) return;
    const local = this.getFriends();
    const me = this.getCurrentUser();
    serverFriends.forEach(sf => {
      if (!sf || !sf.id || sf.id === me.id) return;
      const idx = local.findIndex(lf => lf.id === sf.id);
      if (idx >= 0) {
        local[idx] = { ...local[idx], ...sf };
      } else {
        local.push(sf);
      }
    });
    this.saveFriends(local);
  }

  static mergeGroups(serverGroups) {
    if (!Array.isArray(serverGroups)) return;
    const local = this.getGroups();
    serverGroups.forEach(sg => {
      if (!sg || !sg.id) return;
      const idx = local.findIndex(lg => lg.id === sg.id);
      if (idx >= 0) {
        local[idx] = { ...local[idx], ...sg };
      } else {
        local.unshift(sg);
      }
    });
    this.saveGroups(local);
  }

  static mergeEvents(serverEvents) {
    if (!Array.isArray(serverEvents)) return;
    const deletedIds = this.getDeletedEventIds();
    const validServerEvents = serverEvents.filter(se => se && se.id && !deletedIds.includes(se.id));
    const serverEventMap = new Map(validServerEvents.map(se => [se.id, se]));

    const local = this.getEvents().filter(le => le && le.id && !deletedIds.includes(le.id));
    const merged = [];

    validServerEvents.forEach(se => {
      const localItem = local.find(le => le.id === se.id);
      if (localItem) {
        merged.push({ ...localItem, ...se });
      } else {
        merged.push(se);
      }
    });

    const now = Date.now();
    local.forEach(le => {
      if (!serverEventMap.has(le.id)) {
        const createdAt = le.createdAt ? new Date(le.createdAt).getTime() : 0;
        if (now - createdAt < 10000) {
          merged.unshift(le);
        }
      }
    });

    this.saveEvents(merged);
  }

  // --- Notifications ---
  static getNotifications() {
    return JSON.parse(SafeStorage.getItem(STORAGE_KEYS.NOTIFICATIONS) || '[]');
  }
  static addNotification(notif) {
    const notifs = this.getNotifications();
    notifs.unshift({
      id: 'n_' + Date.now(),
      title: notif.title,
      message: notif.message,
      eventId: notif.eventId || null,
      time: 'たった今',
      isRead: false
    });
    SafeStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(notifs));
  }
}
