/**
 * GatherSync UIコンポーネント & レンダリングロジック
 */

import { StorageManager, sanitize } from './models.js';
import { CalendarHelper } from './calendar.js';

export const UI = {
  /**
   * 日時文字列を日本語フォーマットに変換
   */
  formatDateTime(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    const m = d.getMonth() + 1;
    const date = d.getDate();
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const day = days[d.getDay()];
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${m}月${date}日(${day}) ${h}:${min}`;
  },

  /**
   * 締切までの残り時間を計算・表示
   */
  getDeadlineRemaining(deadlineStr) {
    if (!deadlineStr) return { text: '締切なし', isPassed: false };
    const now = new Date().getTime();
    const deadline = new Date(deadlineStr).getTime();
    const diff = deadline - now;

    if (diff <= 0) {
      return { text: '締め切られました', isPassed: true };
    }

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) {
      return { text: `残り ${days}日 ${hours}時間`, isPassed: false };
    }
    if (hours > 0) {
      return { text: `残り ${hours}時間 ${minutes}分`, isPassed: false };
    }
    return { text: `残り ${minutes}分`, isPassed: false };
  },

  /**
   * カテゴリに応じたアイコンとラベル
   */
  getCategoryInfo(cat) {
    const map = {
      camp: { icon: '⛺', label: 'アウトドア・旅行' },
      drink: { icon: '🍻', label: '飲み会・食事' },
      sports: { icon: '⚽', label: 'スポーツ・運動' },
      study: { icon: '💻', label: '勉強・ワーク' },
      other: { icon: '🎉', label: 'イベント' }
    };
    return map[cat] || map.other;
  },

  /**
   * イベント一覧カードのレンダリング
   */
  renderEventCard(event, currentUser) {
    const myRsvp = event.attendees.find(a => a.friendId === currentUser.id);
    const myStatus = myRsvp ? myRsvp.status : 'unanswered';
    const isGoing = myStatus === 'going';

    // 締切チェック
    const deadlineInfo = this.getDeadlineRemaining(event.deadlineDateTime);
    const isDeadlinePassed = event.isDeadlinePassed || deadlineInfo.isPassed;

    const goingList = event.attendees.filter(a => a.status === 'going');
    const catInfo = this.getCategoryInfo(event.category);
    const hasPasscode = !!event.passcode;

    return `
      <div class="event-card ${isDeadlinePassed ? 'deadline-passed' : ''} ${isGoing ? 'confirmed-going' : ''}" data-event-id="${event.id}">
        <div class="event-card-header">
          <div>
            <div class="event-badge-row">
              <span class="category-tag">${catInfo.icon} ${catInfo.label}</span>
              <span class="group-tag">👥 ${sanitize(event.groupName || '個別招待')}</span>
              ${hasPasscode ? '<span class="status-badge" style="background:rgba(236,72,153,0.15); color:#ec4899; border:1px solid rgba(236,72,153,0.3);">🔒 合言葉保護</span>' : ''}
            </div>
            <h3 class="event-title" onclick="window.App.openEventDetail('${event.id}')">${sanitize(event.title)}</h3>
          </div>
          <div>
            <span class="status-badge ${isDeadlinePassed ? 'closed' : 'open'}">
              ${isDeadlinePassed ? '🔒 締切済み' : '🟢 回答受付中'}
            </span>
          </div>
        </div>

        <div class="event-meta-grid">
          <div class="meta-item">
            <span class="meta-icon">📅</span>
            <span><strong>開催:</strong> ${this.formatDateTime(event.startDateTime)}</span>
          </div>
          ${event.location ? `
            <div class="meta-item">
              <span class="meta-icon">📍</span>
              <span><strong>場所:</strong> <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary); text-decoration:underline;">${sanitize(event.location)}</a></span>
            </div>
          ` : ''}
        </div>

        <!-- 締切情報 & カウントダウン -->
        <div class="countdown-box">
          <span style="color: var(--text-secondary);">⏰ <strong>回答締切:</strong> ${this.formatDateTime(event.deadlineDateTime)}</span>
          <span class="countdown-timer">
            ${isDeadlinePassed ? '⌛ 締切終了' : `⏳ ${deadlineInfo.text}`}
          </span>
        </div>

        <!-- 参加者アバタースタック -->
        <div class="attendees-preview">
          <div class="avatar-stack">
            ${goingList.slice(0, 5).map(a => `<div class="avatar-pill" title="${a.name}">${this.renderAvatarHtml(a.avatar, 24)}</div>`).join('')}
            ${goingList.length > 5 ? `<div class="avatar-pill" style="font-size: 10px; font-weight:700;">+${goingList.length - 5}</div>` : ''}
          </div>
          <div>
            <strong>参加確定:</strong> <span style="color: var(--success); font-weight: 700;">${goingList.length}名</span> / 招待 ${event.attendees.length}名
          </div>
        </div>

        <!-- 自分の出欠選択ボタン (未締切または変更可能時) -->
        <div class="rsvp-section">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; font-weight:700; color:var(--text-secondary);">あなたの回答状況:</span>
          </div>

          <div class="rsvp-buttons">
            <button class="btn-rsvp ${myStatus === 'going' ? 'active-going' : ''}" onclick="window.App.submitRSVP('${event.id}', 'going')">
              ✅ 参加する
            </button>
            <button class="btn-rsvp ${myStatus === 'maybe' ? 'active-maybe' : ''}" onclick="window.App.submitRSVP('${event.id}', 'maybe')">
              🤔 未定
            </button>
            <button class="btn-rsvp ${myStatus === 'declined' ? 'active-declined' : ''}" onclick="window.App.submitRSVP('${event.id}', 'declined')">
              ❌ 不参加
            </button>
          </div>
        </div>

        <!-- 参加者向け: スマホカレンダー自動連携ボックス -->
        ${isGoing ? `
          <div class="calendar-action-box" style="margin-top: 14px;">
            <div class="calendar-action-header">
              <span>📅 ${isDeadlinePassed ? '【締切確定】スマホのカレンダーに予定を登録' : 'カレンダーに予定を同期'}</span>
              <span style="font-size:11px; font-weight:normal; color:var(--text-secondary);">ワンタップ追加</span>
            </div>
            <div class="calendar-action-btns">
              <button class="btn btn-success btn-sm" onclick="window.App.syncWithGoogle('${event.id}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z"/></svg>
                Google カレンダーに追加
              </button>
              <button class="btn btn-primary btn-sm" onclick="window.App.downloadCalendarICS('${event.id}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>
                iPhone / Android カレンダー (.ics)
              </button>
              <button class="btn btn-secondary btn-sm" onclick="window.App.openShareModal('${event.id}')">
                🔗 友達に共有・招待
              </button>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  },

  /**
   * 友達一覧アイテムのレンダリング
   */
  renderFriendItem(friend, groups) {
    const memberGroups = groups.filter(g => g.memberIds.includes(friend.id));
    return `
      <div class="friend-item" data-friend-id="${friend.id}">
        <div class="friend-info">
          <div class="friend-avatar-circle">${friend.avatar || '😊'}</div>
          <div>
            <div style="font-weight: 700; font-size: 15px;">${friend.name}</div>
            <div style="font-size: 12px; color: var(--text-secondary);">
              ${friend.note || 'メモなし'}
              ${memberGroups.length > 0 ? ` • ${memberGroups.map(g => `<span class="group-tag" style="display:inline-flex; padding:1px 6px;">${g.icon} ${g.name}</span>`).join(' ')}` : ''}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-secondary btn-sm" onclick="window.App.deleteFriend('${friend.id}')" title="削除">
            🗑️
          </button>
        </div>
      </div>
    `;
  },

  /**
   * グループカードのレンダリング
   */
  renderGroupCard(group, friends) {
    const members = friends.filter(f => group.memberIds.includes(f.id));
    return `
      <div class="card-group" style="border-top: 4px solid ${group.color || 'var(--primary)'};">
        <div>
          <div class="group-top">
            <div class="group-icon-box" style="background: ${group.color}22; color: ${group.color};">
              ${group.icon || '👥'}
            </div>
            <div>
              <h4 style="font-size: 16px; font-weight: 700;">${group.name}</h4>
              <p style="font-size: 12px; color: var(--text-secondary);">${group.description || '説明なし'}</p>
            </div>
          </div>
          
          <div style="margin-top: 14px;">
            <div style="font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px;">
              メンバー (${members.length}名):
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 6px;">
              ${members.map(m => `
                <span class="group-tag">
                  ${this.renderAvatarHtml(m.avatar, 18)} ${m.name}
                </span>
              `).join('')}
              ${members.length === 0 ? '<span style="font-size: 12px; color: var(--text-muted);">メンバーがいません</span>' : ''}
            </div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-color); padding-top: 10px; margin-top: 10px;">
          <button class="btn btn-primary btn-sm" onclick="window.App.openNewEventWithGroup('${group.id}')">
            📅 このグループで予定作成
          </button>
          <button class="btn btn-secondary btn-sm" onclick="window.App.deleteGroup('${group.id}')" title="グループ削除">
            🗑️
          </button>
        </div>
      </div>
    `;
  },

  /**
   * 紙吹雪（Confetti）エフェクト
   */
  triggerConfetti() {
    const canvas = document.getElementById('confetti-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const pieces = [];
    const colors = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];

    for (let i = 0; i < 70; i++) {
      pieces.push({
        x: canvas.width / 2,
        y: canvas.height / 2,
        w: Math.random() * 8 + 4,
        h: Math.random() * 8 + 4,
        vx: (Math.random() - 0.5) * 16,
        vy: (Math.random() - 0.7) * 16,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 10,
        opacity: 1
      });
    }

    let frame = 0;
    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.3; // 重力
        p.rotation += p.rotSpeed;
        p.opacity -= 0.012;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });

      frame++;
      if (frame < 90) {
        requestAnimationFrame(animate);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    animate();
  }
};
