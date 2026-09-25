# GatherSync（ギャザー・シンク）
### 友達招待・グループ出欠管理 ＆ スマホカレンダー自動同期Webアプリ

---

## 🌟 アプリの概要・特徴

1. **⚡ 公開サーバー リアルタイム同期（複数端末・友達間で即時共有）**
   - 友達招待、グループ作成、予定作成・編集・削除、出欠回答（参加・未定・不参加）が全端末でリアルタイムに自動同期されます。
   - SSE（Server-Sent Events）＋ スマート同期ポーリングの二重構造により、ネットワーク切断やモバイル回線でも確実に同期。
2. **👥 何人でも友達を誘える（友達招待＆QR/URL共有）**
   - 専用の招待URL・QRコード・LINE連携ボタンで一発共有。URLを開くだけで自動的に双方向の友達登録が完了します。
3. **🏷️ グループ分け（サークル・旅行仲間・同期・部活など）**
   - 友達を「大学同期」「フットサル部」「アウトドア隊」などのグループに分類・管理。
   - グループ限定の予定を作成でき、関係者だけに案内できます。
4. **📅 予定を立てる（イベント作成）**
   - タイトル、開催日時、場所（Googleマップ連携）、持ち物や会費のメモを設定。
   - **回答締切日時**（例: 開催2日前など）を設定できます。
5. **🙋‍♂️ 「参加」を押してエントリー（出欠RSVP機能）**
   - 「✅ 参加」「🤔 未定」「❌ 不参加」をワンタップで回答。全員の画面に出欠数とメンバー一覧がリアルタイム反映。
   - 「参加」を押すと祝福の紙吹雪アニメーションが発生！
6. **⏰ 締切到達 ＆ スマホのカレンダーに自動登録**
   - 締切日時になると自動で確定ステータスへ移行。
   - **「Google カレンダーに追加」**: 日時・場所・概要がプリセットされたGoogleカレンダー登録画面を即座に開きます。
   - **「iPhone / Android カレンダー (.ics)」**: RFC 5545規格の標準カレンダーファイルを生成し、スマホ標準のカレンダーアプリで予定を即追加できます。

---

## 🚀 公開サーバーでの起動方法・使い方

### 1. ワンクリックで全世界にHTTPS公開（最も簡単）
フォルダ内の **`run-public-server.bat`** をダブルクリック、または PowerShell で以下を実行するだけです：

```powershell
.\start-public-server.ps1
```

- 付属の `cloudflared.exe` を利用して、世界中どこからでもアクセスできる安全な `https://...trycloudflare.com` の公開URLが自動発行されます。
- 発行されたURLを LINE や SNS で友達に送るだけで、PC・iPhone・Android すべてでリアルタイム同期が利用できます。

### 2. ローカルサーバーとして起動
```powershell
.\run-server.ps1
```
または Node.js がある環境では：
```bash
node server.js
```

### 3. Vercel などのクラウドへデプロイ
`vercel.json` および `package.json` が同梱されているため、GitHub リポジトリを Vercel や Render、Railway に接続するだけで即座に公開サーバーとして稼働します。

---

## 📁 プロジェクト構成

```
Application/
├── index.html              # メイン画面（リアルタイム同期クライアント内蔵・PWA対応）
├── server.js               # Node.js リアルタイム同期バックエンド（SSE / REST API）
├── run-server.ps1          # PowerShell 高速API＆Webサーバー
├── start-public-server.ps1 # Cloudflare Tunnel 自動HTTPS公開スクリプト
├── run-public-server.bat   # ワンクリック公開バッチファイル
├── database.json           # リアルタイム永続化データベース
├── cloudflared.exe         # Cloudflare セキュアトンネル実行ファイル
├── vercel.json             # Vercel クラウドデプロイ設定
├── manifest.json           # Web App Manifest（スマホホーム画面対応）
├── service-worker.js       # オフラインキャッシュ用 Service Worker
├── css/
│   └── style.css           # プレミアムデザインシステム
└── js/
    ├── app.js              # 全体コントローラー（リアルタイム同期管理）
    ├── models.js           # データモデル ＆ ServerApi 通信レイヤー
    ├── calendar.js         # カレンダー連携エンジン（Google / Apple .ics）
    └── components.js       # UIコンポーネント（カード描画、紙吹雪演出）
```
