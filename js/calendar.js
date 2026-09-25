/**
 * カレンダー連携ユーティリティ
 * - RFC 5545 準拠の .ics (iCalendar) ファイル生成 & ダウンロード
 * - Google Calendar 追加用 URL 生成
 * - Outlook / Yahoo カレンダー連携 URL 生成
 */

export const CalendarHelper = {
  /**
   * ISO日時文字列やDateオブジェクトをiCalendar用日時フォーマット (YYYYMMDDTHHmmssZ または YYYYMMDDTHHmmss) に変換
   */
  formatToICSDate(dateStr) {
    const date = new Date(dateStr);
    const pad = (n) => String(n).padStart(2, '0');
    
    return (
      date.getUTCFullYear() +
      pad(date.getUTCMonth() + 1) +
      pad(date.getUTCDate()) +
      'T' +
      pad(date.getUTCHours()) +
      pad(date.getUTCMinutes()) +
      pad(date.getUTCSeconds()) +
      'Z'
    );
  },

  /**
   * Google Calendar用の日時文字列 (YYYYMMDDTHHmmssZ) に変換
   */
  formatToGoogleDate(dateStr) {
    return this.formatToICSDate(dateStr);
  },

  /**
   * イベント情報から .ics ファイルの文字列を生成
   */
  generateICSContent(event) {
    const uid = `gathersync-${event.id}-${Date.now()}@gathersync.app`;
    const dtStamp = this.formatToICSDate(new Date().toISOString());
    const dtStart = this.formatToICSDate(event.startDateTime);
    
    // 終了日時がない場合は開始から2時間後に設定
    let endDateTime = event.endDateTime;
    if (!endDateTime) {
      const end = new Date(event.startDateTime);
      end.setHours(end.getHours() + 2);
      endDateTime = end.toISOString();
    }
    const dtEnd = this.formatToICSDate(endDateTime);

    // テキストのエスケープ処理
    const escapeText = (str) => {
      if (!str) return '';
      return str
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
    };

    const summary = escapeText(event.title);
    const description = escapeText(
      `${event.description || ''}\n\n【主催/グループ】${event.groupName || '全体'}\n【参加人数】${event.attendees ? event.attendees.filter(a => a.status === 'going').length : 0}名\n【GatherSync予定リンク】https://gathersync.app/events/${event.id}`
    );
    const location = escapeText(event.location || '');

    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//GatherSync//Event Calendar Synchronizer//JA',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      location ? `LOCATION:${location}` : '',
      'STATUS:CONFIRMED',
      'BEGIN:VALARM',
      'TRIGGER:-PT1H', // 1時間前にリマインド通知
      'ACTION:DISPLAY',
      `DESCRIPTION:リマインダー: ${summary}`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ]
      .filter(Boolean)
      .join('\r\n');
  },

  /**
   * スマホ標準カレンダー（iPhone / Android / Mac / Windows）用に .ics をダウンロードさせて開く
   */
  downloadICS(event) {
    const icsData = this.generateICSContent(event);
    const blob = new Blob([icsData], { type: 'text/calendar;charset=utf-8' });
    const filename = `${event.title.replace(/[\/\\?%*:|"<>]/g, '_')}_GatherSync.ics`;

    // iOS Safari / Chrome / PC で安全にトリガー
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(link.href);
  },

  /**
   * Google カレンダー登録用 URL を生成
   */
  getGoogleCalendarURL(event) {
    const startStr = this.formatToGoogleDate(event.startDateTime);
    let endDateTime = event.endDateTime;
    if (!endDateTime) {
      const end = new Date(event.startDateTime);
      end.setHours(end.getHours() + 2);
      endDateTime = end.toISOString();
    }
    const endStr = this.formatToGoogleDate(endDateTime);

    const details = `${event.description || ''}\n\n【主催/グループ】: ${event.groupName || 'GatherSync'}\n【参加予定】: ${event.attendees ? event.attendees.filter(a => a.status === 'going').map(a => a.name).join(', ') : ''}`;
    
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: event.title,
      dates: `${startStr}/${endStr}`,
      details: details,
      location: event.location || ''
    });

    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  },

  /**
   * Outlook カレンダー登録用 URL を生成
   */
  getOutlookCalendarURL(event) {
    let endDateTime = event.endDateTime;
    if (!endDateTime) {
      const end = new Date(event.startDateTime);
      end.setHours(end.getHours() + 2);
      endDateTime = end.toISOString();
    }

    const params = new URLSearchParams({
      path: '/calendar/action/compose',
      rru: 'addevent',
      subject: event.title,
      startdt: new Date(event.startDateTime).toISOString(),
      enddt: new Date(endDateTime).toISOString(),
      body: event.description || '',
      location: event.location || ''
    });

    return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
  }
};
