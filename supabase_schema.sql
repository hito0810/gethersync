-- ========================================================
-- GatherSync (AsoBo) - Supabase データベース作成用 SQL
-- Supabase の「SQL Editor」に貼り付けて「RUN」を押すだけで完了します
-- ========================================================

-- 1. ユーザー情報テーブル
CREATE TABLE IF NOT EXISTS public.users (
    id TEXT PRIMARY KEY,
    name TEXT,
    avatar TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 友達関係テーブル
CREATE TABLE IF NOT EXISTS public.friends (
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    name TEXT,
    avatar TEXT,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_user_id ON public.friends (user_id);
CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON public.friends (friend_id);

-- 3. グループテーブル
CREATE TABLE IF NOT EXISTS public.groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    created_by_id TEXT,
    member_ids JSONB DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_groups_created_by ON public.groups (created_by_id);

-- 4. 予定（イベント）テーブル
CREATE TABLE IF NOT EXISTS public.events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT,
    start_date_time TEXT,
    end_date_time TEXT,
    deadline TEXT,
    location TEXT,
    description TEXT,
    scope TEXT DEFAULT 'all',
    group_id TEXT,
    target_friend_ids JSONB DEFAULT '[]'::jsonb,
    created_by_id TEXT,
    attendees JSONB DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_created_by ON public.events (created_by_id);
CREATE INDEX IF NOT EXISTS idx_events_group_id ON public.events (group_id);

-- 5. 削除済み予定テーブル（復活防止用）
CREATE TABLE IF NOT EXISTS public.deleted_event_ids (
    id TEXT PRIMARY KEY,
    deleted_at TIMESTAMPTZ DEFAULT NOW()
);

-- テーブルの権限を公開APIアクセス可能に設定
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deleted_event_ids ENABLE ROW LEVEL SECURITY;

-- 全アクセス許可ポリシー（サーバーサイドから安全に制御するため）
DO $$
BEGIN
    DROP POLICY IF EXISTS "Allow all for server users" ON public.users;
    CREATE POLICY "Allow all for server users" ON public.users FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow all for server friends" ON public.friends;
    CREATE POLICY "Allow all for server friends" ON public.friends FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow all for server groups" ON public.groups;
    CREATE POLICY "Allow all for server groups" ON public.groups FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow all for server events" ON public.events;
    CREATE POLICY "Allow all for server events" ON public.events FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow all for server deleted_events" ON public.deleted_event_ids;
    CREATE POLICY "Allow all for server deleted_events" ON public.deleted_event_ids FOR ALL USING (true) WITH CHECK (true);
END $$;
