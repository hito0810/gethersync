/**
 * GatherSync メインアプリケーションコントローラー
 */

import { StorageManager, ServerApi } from './models.js';
import { CalendarHelper } from './calendar.js';
import { UI } from './components.js';

class AppController {
  constructor() {
    this.currentTab = 'events';
    this.currentFilter = 'all';
    this.timerInterval = null;
    this.syncInterval = null;
    this.eventSource = null;
    this.isLocked = false;
    this.lastDataHash = '';
  }

  init() {
    StorageManager.init();
    this.checkPinLock();
    this.bindEvents();
    this.renderAll();
    this.startDeadlineMonitor();
    this.setupRealtimeSync();

    // グローバル露出（インラインイベントハンドラから呼び出し用）
    window.App = this;
  }

  setupRealtimeSync() {
    const me = StorageManager.getCurrentUser();
    if (!me || !me.id) return;

    if (typeof EventSource !== 'undefined') {
      try {
        if (this.eventSource) this.eventSource.close();
        this.eventSource = new EventSource(`/api/events/stream?userId=${encodeURIComponent(me.id)}`);
        this.eventSource.onmessage = (e) => {
          if (e.data && e.data.trim().startsWith('{')) {
            this.pullFromServer(true);
          }
        };
      } catch(e) {}
    }

    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncInterval = setInterval(() => {
      this.pullFromServer(true);
    }, 4000);

    this.pullFromServer(false);
  }

  async pullFromServer(silent = false) {
    const me = StorageManager.getCurrentUser();
    if (!me || !me.id) return;
    const data = await ServerApi.syncGet(me.id);
    if (!data) return;

    let updated = false;
    if (Array.isArray(data.friends)) {
      StorageManager.mergeFriends(data.friends);
      updated = true;
    }
    if (Array.isArray(data.groups)) {
      StorageManager.mergeGroups(data.groups);
      updated = true;
    }
    if (Array.isArray(data.events)) {
      StorageManager.mergeEvents(data.events);
      updated = true;
    }

    if (updated) {
      this.renderAll();
    }
  }

  // --- PINロック管理 ---
  checkPinLock() {
    const sec = StorageManager.getSecuritySettings();
    if (sec && sec.isPinEnabled && sec.pinHash) {
      this.isLocked = true;
      const modal = document.getElementById('modal-pin-lock');
      if (modal) modal.classList.add('active');
    }
  }

  unlockWithPin() {
    const input = document.getElementById('unlock-pin-input');
    const enteredPin = input ? input.value : '';
    const sec = StorageManager.getSecuritySettings();

    if (btoa(enteredPin) === sec.pinHash) {
      this.isLocked = false;
      this.closeModal('modal-pin-lock');
      input.value = '';
      this.showToast('🔓 PINロックを解除しました');
    } else {
      alert('暗証番号が正しくありません');
      if (input) input.value = '';
    }
  }

  togglePinLock() {
    const input = document.getElementById('input-new-pin');
    const pin = input ? input.value.trim() : '';
    const sec = StorageManager.getSecuritySettings();

    if (sec.isPinEnabled) {
      // 解除
      sec.isPinEnabled = false;
      sec.pinHash = '';
      StorageManager.saveSecuritySettings(sec);
      this.showToast('🔓 PINロックを無効化しました');
      if (input) input.value = '';
    } else {
      // 設定
      if (!pin || pin.length < 4) {
        alert('4桁の数字を入力してください');
        return;
      }
      sec.isPinEnabled = true;
      sec.pinHash = btoa(pin);
      StorageManager.saveSecuritySettings(sec);
      this.showToast('🔒 4桁PINロックを有効にしました！');
      if (input) input.value = '';
    }
    this.updatePinStatusText();
  }

  updatePinStatusText() {
    const textEl = document.getElementById('pin-status-text');
    if (!textEl) return;
    const sec = StorageManager.getSecuritySettings();
    if (sec.isPinEnabled) {
      textEl.textContent = '✅ 現在【4桁PINロック】が有効です（起動時に認証が必要）';
      textEl.style.color = 'var(--success)';
    } else {
      textEl.textContent = '⚪ 現在PINロックは無効です';
      textEl.style.color = 'var(--text-muted)';
    }
  }

  bindEvents() {
    // タブ切り替え
    document.querySelectorAll('.tab-btn, .bottom-nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = btn.dataset.tab;
        if (tab) this.switchTab(tab);
      });
    });

    // フィルタ切り替え
    document.querySelectorAll('.filter-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.currentFilter = pill.dataset.filter;
        this.renderEvents();
      });
    });

    // テーマ切り替え
    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => this.toggleTheme());
    }

    // モーダル背景クリックで閉じる
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.closeAllModals();
        }
      });
    });
  }

  toggleTheme() {
    const isLight = document.body.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.body.removeAttribute('data-theme');
      this.showToast('🌙 ダークモードに切り替えました');
    } else {
      document.body.setAttribute('data-theme', 'light');
      this.showToast('☀️ ライトモードに切り替えました');
    }
  }

  switchTab(tabName) {
    this.currentTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.bottom-nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });

    document.querySelectorAll('.view-section').forEach(section => {
      section.classList.toggle('active', section.id === `view-${tabName}`);
    });

    this.renderAll();
  }

  renderAll() {
    this.renderEvents();
    this.renderGroups();
    this.renderFriends();
    this.renderNotifications();
    this.updateUserBadge();
  }

  updateUserBadge() {
    const user = StorageManager.getCurrentUser();
    const badge = document.getElementById('current-user-badge');
    if (badge) {
      badge.innerHTML = `<span class="user-avatar">${user.avatar}</span> <span>${user.name}</span>`;
    }
  }

  renderEvents() {
    const container = document.getElementById('event-list-container');
    if (!container) return;

    let events = StorageManager.getEvents();
    const currentUser = StorageManager.getCurrentUser();

    // フィルタリング
    if (this.currentFilter === 'going') {
      events = events.filter(e => {
        const myRsvp = e.attendees.find(a => a.friendId === currentUser.id);
        return myRsvp && myRsvp.status === 'going';
      });
    } else if (this.currentFilter === 'open') {
      events = events.filter(e => !UI.getDeadlineRemaining(e.deadlineDateTime).isPassed);
    } else if (this.currentFilter === 'closed') {
      events = events.filter(e => UI.getDeadlineRemaining(e.deadlineDateTime).isPassed);
    }

    if (events.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-color);">
          <div style="font-size: 40px; margin-bottom: 12px;">📅</div>
          <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 6px;">該当する予定がありません</h3>
          <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 16px;">新しい予定を作成して友達やグループを誘ってみましょう！</p>
          <button class="btn btn-primary" onclick="window.App.openNewEventModal()">＋ 新しい予定を作成</button>
        </div>
      `;
      return;
    }

    container.innerHTML = events.map(e => UI.renderEventCard(e, currentUser)).join('');
  }

  renderGroups() {
    const container = document.getElementById('group-list-container');
    if (!container) return;

    const groups = StorageManager.getGroups();
    const friends = StorageManager.getFriends();

    if (groups.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 30px; grid-column: 1/-1; background: var(--bg-card); border-radius: var(--radius-lg);">
          <p style="color: var(--text-secondary);">グループがまだありません。「＋ グループ作成」から作成してください。</p>
        </div>
      `;
      return;
    }

    container.innerHTML = groups.map(g => UI.renderGroupCard(g, friends)).join('');
  }

  renderFriends() {
    const container = document.getElementById('friend-list-container');
    if (!container) return;

    const friends = StorageManager.getFriends();
    const groups = StorageManager.getGroups();

    if (friends.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 30px; background: var(--bg-card); border-radius: var(--radius-lg);">
          <p style="color: var(--text-secondary);">友達がまだ登録されていません。「＋ 友達を追加」から追加してください。</p>
        </div>
      `;
      return;
    }

    container.innerHTML = friends.map(f => UI.renderFriendItem(f, groups)).join('');
  }

  renderNotifications() {
    const container = document.getElementById('notification-list-container');
    const badge = document.getElementById('notif-badge');
    const notifs = StorageManager.getNotifications();

    if (badge) {
      badge.style.display = notifs.some(n => !n.isRead) ? 'block' : 'none';
    }

    if (!container) return;

    if (notifs.length === 0) {
      container.innerHTML = `<div style="text-align: center; padding: 30px; color: var(--text-secondary);">通知はありません</div>`;
      return;
    }

    container.innerHTML = notifs.map(n => `
      <div style="padding: 14px; background: var(--bg-secondary); border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 10px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <strong style="font-size: 14px; color: var(--text-primary);">${n.title}</strong>
          <span style="font-size: 11px; color: var(--text-muted);">${n.time}</span>
        </div>
        <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;">${n.message}</p>
        ${n.eventId ? `
          <button class="btn btn-primary btn-sm" onclick="window.App.openEventDetail('${n.eventId}')">
            予定詳細・カレンダー登録を確認
          </button>
        ` : ''}
      </div>
    `).join('');
  }

  // --- RSVP 出欠回答処理 ---
  submitRSVP(eventId, status) {
    const event = StorageManager.getEventById(eventId);
    if (!event) return;

    // パスコード保護されているイベントの場合、パスコード入力を求める
    if (event.passcode) {
      const entered = prompt(`🔒 この予定には合言葉が設定されています。\n合言葉を入力してください:`);
      if (entered !== event.passcode) {
        alert('❌ 合言葉が正しくありません。回答できませんでした。');
        return;
      }
    }

    const currentUser = StorageManager.getCurrentUser();
    const updated = StorageManager.updateRSVP(eventId, currentUser.id, status);

    if (status === 'going') {
      UI.triggerConfetti();
      this.showToast('🎉 「参加」で回答しました！締切時にカレンダーへ連携できます');
    } else if (status === 'maybe') {
      this.showToast('🤔 「未定」で回答しました');
    } else {
      this.showToast('❌ 「不参加」で回答しました');
    }

    this.renderEvents();
  }

  // --- 締切シミュレーション (開発・デモ用) ---
  simulateDeadline(eventId) {
    const event = StorageManager.getEventById(eventId);
    if (!event) return;

    event.deadlineDateTime = new Date(Date.now() - 1000).toISOString();
    event.isDeadlinePassed = true;
    event.autoSyncTriggered = true;
    StorageManager.updateEvent(event);

    // 通知を追加
    StorageManager.addNotification({
      title: `⏰ 締切通知: ${event.title}`,
      message: `【回答が締め切られました】参加予定が確定しました。スマホのカレンダーに追加してください！`,
      eventId: event.id
    });

    this.showToast(`⏰ 「${event.title}」を締め切りました！カレンダー登録ボタンが表示されます`);
    this.renderAll();
  }

  // --- カレンダー同期アクション ---
  syncWithGoogle(eventId) {
    const event = StorageManager.getEventById(eventId);
    if (!event) return;
    const url = CalendarHelper.getGoogleCalendarURL(event);
    window.open(url, '_blank');
    this.showToast('📅 Googleカレンダーの予定作成ページを開きました');
  }

  downloadCalendarICS(eventId) {
    const event = StorageManager.getEventById(eventId);
    if (!event) return;
    CalendarHelper.downloadICS(event);
    this.showToast('📥 iCalendar (.ics) をダウンロードしました！スマホのカレンダーで開いて追加してください');
  }

  // --- モーダル制御 ---
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
  }

  closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
  }

  // 予定作成モーダルを開く
  openNewEventModal(targetGroupId = null) {
    const groupSelect = document.getElementById('event-group-select');
    if (groupSelect) {
      const groups = StorageManager.getGroups();
      groupSelect.innerHTML = `
        <option value="">（グループなし / 全友達から選択）</option>
        ${groups.map(g => `<option value="${g.id}" ${targetGroupId === g.id ? 'selected' : ''}>${g.icon} ${g.name}</option>`).join('')}
      `;
    }

    // デフォルト日時の設定（開始は明日19:00、終了21:00、締切は明日12:00）
    const tomorrow = new Date(Date.now() + 86400000);
    const startStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}T19:00`;
    const endStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}T21:00`;
    const deadlineStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}T12:00`;

    document.getElementById('event-start').value = startStr;
    document.getElementById('event-end').value = endStr;
    document.getElementById('event-deadline').value = deadlineStr;

    this.openModal('modal-new-event');
  }

  openNewEventWithGroup(groupId) {
    this.openNewEventModal(groupId);
  }

  handleCreateEvent(e) {
    e.preventDefault();
    const title = document.getElementById('event-title').value.trim();
    if (!title) {
      alert('イベント名を入力してください');
      return;
    }

    const category = document.getElementById('event-category').value;
    const location = document.getElementById('event-location').value.trim();
    const passcode = document.getElementById('event-passcode').value.trim();
    const startDateTime = document.getElementById('event-start').value;
    const endDateTime = document.getElementById('event-end').value;
    const deadlineDateTime = document.getElementById('event-deadline').value;
    const targetGroupId = document.getElementById('event-group-select').value;
    const description = document.getElementById('event-desc').value.trim();

    const groups = StorageManager.getGroups();
    const group = groups.find(g => g.id === targetGroupId);

    const newEvent = StorageManager.addEvent({
      title,
      category,
      location,
      passcode,
      startDateTime,
      endDateTime,
      deadlineDateTime,
      targetGroupId: targetGroupId || null,
      groupName: group ? group.name : '個別招待',
      description
    });

    this.closeModal('modal-new-event');
    document.getElementById('form-new-event').reset();
    this.showToast(`✨ 予定「${newEvent.title}」を作成し、友達を招待しました！`);
    UI.triggerConfetti();
    this.renderEvents();
  }

  // 友達追加
  openAddFriendModal() {
    this.openModal('modal-add-friend');
  }

  handleAddFriend(e) {
    e.preventDefault();
    const name = document.getElementById('friend-name').value.trim();
    if (!name) return;
    const avatar = document.getElementById('friend-avatar').value || '😊';
    const note = document.getElementById('friend-note').value.trim();

    StorageManager.addFriend({ name, avatar, note });
    this.closeModal('modal-add-friend');
    document.getElementById('form-add-friend').reset();
    this.showToast(`👤 友達「${name}」を追加しました！`);
    this.renderFriends();
    this.renderGroups();
  }

  deleteFriend(friendId) {
    if (confirm('この友達を削除しますか？')) {
      StorageManager.deleteFriend(friendId);
      this.showToast('友達を削除しました');
      this.renderFriends();
      this.renderGroups();
      this.renderEvents();
    }
  }

  openAddGroupModal() {
    const container = document.getElementById('group-members-checklist');
    const friends = StorageManager.getFriends();
    if (container) {
      container.innerHTML = friends.map(f => `
        <label style="display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:13px; cursor:pointer;">
          <input type="checkbox" name="group-members" value="${f.id}" style="width: 18px; height: 18px;">
          <span style="display:flex; align-items:center; gap:6px;">${UI.renderAvatarHtml(f.avatar, 24)} <strong>${f.name}</strong></span>
        </label>
      `).join('');
    }
    this.openModal('modal-add-group');
  }

  handleAddGroup(e) {
    e.preventDefault();
    const name = document.getElementById('group-name').value.trim();
    if (!name) return;
    const icon = document.getElementById('group-icon').value || '👥';
    const color = document.getElementById('group-color').value || '#6366f1';
    const description = document.getElementById('group-desc').value.trim();

    const checkedMembers = Array.from(document.querySelectorAll('input[name="group-members"]:checked')).map(el => el.value);

    StorageManager.addGroup({
      name,
      icon,
      color,
      description,
      memberIds: checkedMembers
    });

    this.closeModal('modal-add-group');
    document.getElementById('form-add-group').reset();
    this.showToast(`👥 グループ「${name}」を作成しました！`);
    this.renderGroups();
    this.renderFriends();
  }

  deleteGroup(groupId) {
    if (confirm('このグループを削除しますか？')) {
      StorageManager.deleteGroup(groupId);
      this.showToast('グループを削除しました');
      this.renderGroups();
      this.renderFriends();
    }
  }

  // イベント詳細モーダル
  openEventDetail(eventId) {
    const event = StorageManager.getEventById(eventId);
    if (!event) return;

    const modalBody = document.getElementById('event-detail-content');
    if (!modalBody) return;

    const going = event.attendees.filter(a => a.status === 'going');
    const maybe = event.attendees.filter(a => a.status === 'maybe');
    const declined = event.attendees.filter(a => a.status === 'declined');
    const unanswered = event.attendees.filter(a => a.status === 'unanswered');

    const statusBadge = (s) => {
      if (s === 'going') return '<span class="attendee-status-badge going">参加</span>';
      if (s === 'maybe') return '<span class="attendee-status-badge maybe">未定</span>';
      if (s === 'declined') return '<span class="attendee-status-badge declined">不参加</span>';
      return '<span class="attendee-status-badge unanswered">未回答</span>';
    };

    modalBody.innerHTML = `
      <div style="margin-bottom: 16px;">
        <span class="category-tag">${UI.getCategoryInfo(event.category).icon} ${UI.getCategoryInfo(event.category).label}</span>
        <h3 style="font-size: 20px; font-weight: 800; margin: 8px 0;">${event.title}</h3>
        <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;">${event.description || '説明なし'}</p>
        
        <div style="background: var(--bg-primary); padding: 12px; border-radius: var(--radius-md); font-size: 13px; display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px;">
          <div>📅 <strong>日時:</strong> ${UI.formatDateTime(event.startDateTime)} 〜 ${UI.formatDateTime(event.endDateTime)}</div>
          <div>📍 <strong>場所:</strong> ${event.location || '未設定'}</div>
          <div>⏰ <strong>回答締切:</strong> ${UI.formatDateTime(event.deadlineDateTime)}</div>
          <div>👥 <strong>対象グループ:</strong> ${event.groupName || '個別招待'}</div>
        </div>

        <!-- 出欠集計サマリー -->
        <h4 style="font-size: 15px; font-weight: 700; margin-bottom: 8px;">出欠状況 (${going.length}名 参加確定)</h4>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 14px; text-align: center;">
          <div style="background: rgba(16,185,129,0.15); color:#10b981; padding: 6px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 700;">参加: ${going.length}</div>
          <div style="background: rgba(245,158,11,0.15); color:#f59e0b; padding: 6px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 700;">未定: ${maybe.length}</div>
          <div style="background: rgba(239,68,68,0.15); color:#ef4444; padding: 6px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 700;">不参加: ${declined.length}</div>
          <div style="background: var(--bg-primary); color:var(--text-muted); padding: 6px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 700;">未回答: ${unanswered.length}</div>
        </div>

        <div style="max-height: 200px; overflow-y: auto; background: var(--bg-primary); border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          ${event.attendees.map(a => `
            <div class="attendee-row">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span>${a.avatar || '👤'}</span>
                <span style="font-weight: 600;">${a.name}</span>
                ${a.comment ? `<span style="font-size: 11px; color: var(--text-muted); font-style: italic;">「${a.comment}」</span>` : ''}
              </div>
              <div>${statusBadge(a.status)}</div>
            </div>
          `).join('')}
        </div>

        <!-- カレンダー追加 & 共有アクション -->
        <div style="margin-top: 20px; display: flex; flex-direction: column; gap: 8px;">
          <button class="btn btn-success btn-full" onclick="window.App.syncWithGoogle('${event.id}')">
            📅 Google カレンダーに追加
          </button>
          <button class="btn btn-primary btn-full" onclick="window.App.downloadCalendarICS('${event.id}')">
            📥 iPhone / Android カレンダー (.ics) をダウンロード
          </button>
          <button class="btn btn-secondary btn-full" onclick="window.App.openShareModal('${event.id}')">
            🔗 招待リンク / QRコードを表示
          </button>
        </div>
      </div>
    `;

    this.openModal('modal-event-detail');
  }

  // 招待共有モーダル
  openShareModal(eventId) {
    const event = StorageManager.getEventById(eventId);
    if (!event) return;

    const url = `${window.location.origin}${window.location.pathname}?openExternalBrowser=1&event=${event.id}`;
    document.getElementById('share-url-input').value = url;
    document.getElementById('share-event-title').textContent = event.title;

    // QRコードの生成 (Canvas API)
    this.generateQRCode('share-qr-canvas', url);

    this.openModal('modal-share');
  }

  copyShareUrl() {
    const input = document.getElementById('share-url-input');
    input.select();
    navigator.clipboard.writeText(input.value);
    this.showToast('📋 招待URLをクリップボードにコピーしました！LINEやSNSに貼り付けて招待できます');
  }

  shareViaLine() {
    const input = document.getElementById('share-url-input');
    const title = document.getElementById('share-event-title').textContent;
    const text = encodeURIComponent(`【GatherSync】「${title}」の出欠確認にご参加ください！\n${input.value}`);
    window.open(`https://line.me/R/msg/text/?${text}`, '_blank');
  }

  // シンプルなQRコード描画 (Canvas)
  generateQRCode(canvasId, text) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 180;
    canvas.width = size;
    canvas.height = size;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    // 擬似QRパターン（視覚的表現）
    ctx.fillStyle = '#0f172a';
    const numCells = 21;
    const cellSize = size / numCells;

    // ポジションマーカー
    const drawFinder = (x, y) => {
      ctx.fillRect(x * cellSize, y * cellSize, 7 * cellSize, 7 * cellSize);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect((x + 1) * cellSize, (y + 1) * cellSize, 5 * cellSize, 5 * cellSize);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect((x + 2) * cellSize, (y + 2) * cellSize, 3 * cellSize, 3 * cellSize);
    };

    drawFinder(1, 1);
    drawFinder(numCells - 8, 1);
    drawFinder(1, numCells - 8);

    // データパターン
    for (let r = 0; r < numCells; r++) {
      for (let c = 0; c < numCells; c++) {
        if ((r < 8 && c < 8) || (r < 8 && c > numCells - 9) || (r > numCells - 9 && c < 8)) continue;
        const hash = (r * 17 + c * 31 + text.length * 7) % 3;
        if (hash === 0) {
          ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
        }
      }
    }
  }

  // --- 締切タイマー監視 ---
  startDeadlineMonitor() {
    this.timerInterval = setInterval(() => {
      let events = StorageManager.getEvents();
      let hasChange = false;
      const now = new Date().getTime();

      events.forEach(e => {
        if (!e.isDeadlinePassed && e.deadlineDateTime) {
          const deadline = new Date(e.deadlineDateTime).getTime();
          if (now >= deadline) {
            e.isDeadlinePassed = true;
            hasChange = true;
            StorageManager.addNotification({
              title: `⏰ 締切通知: ${e.title}`,
              message: `参加回答が締め切られました！参加確定されたためカレンダーに追加できます。`,
              eventId: e.id
            });
            this.showToast(`⏰ 「${e.title}」の回答受付が終了しました！`);
          }
        }
      });

      if (hasChange) {
        StorageManager.saveEvents(events);
        this.renderAll();
      }
    }, 5000); // 5秒ごとにチェック
  }

  // --- トースト通知 ---
  showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>✨</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // サンプルデータリセット
  resetData() {
    if (confirm('初期サンプルデータにリセットしますか？')) {
      StorageManager.resetToDefault();
      this.showToast('データを初期化しました');
      this.renderAll();
    }
  }
}

// DOM読み込み完了時に起動（Safari / モバイル完全対応）
function bootstrap() {
  const app = new AppController();
  app.init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
