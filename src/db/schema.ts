/**
 * AI Todo · PostgreSQL Schema（配置 A）
 *
 * 说明：
 * - 使用真实 PostgreSQL 语法，SQLite 不兼容（jsonb、部分索引、枚举类型、ON CONFLICT 推断）。
 * - 默认使用 PGlite（编译为 WASM 的 PostgreSQL）零安装运行；设置 DATABASE_URL 后切换到标准 pg 驱动。
 * - gen_random_uuid() 自 PostgreSQL 13 起为内核函数，无需 pgcrypto 扩展。
 * - 配置 A 不建 channels 表：没有外部推送通道，不需要通道订阅与凭据管理。
 *   未来若升级到配置 B（增加邮件 / 群机器人 / Server酱 兜底），加回 channels 表即可，
 *   任务模型与本表其余部分不受影响。
 */

export const SCHEMA_SQL = `
-- ============ 枚举 ============
-- PostgreSQL 的 CREATE TYPE 不支持 IF NOT EXISTS，用 DO 块 + 异常捕获实现幂等。
do $$ begin
  create type task_status as enum ('pending', 'acked', 'done', 'archived');
exception when duplicate_object then null; end $$;
do $$ begin
  create type task_severity as enum ('info', 'need_human', 'blocker');
exception when duplicate_object then null; end $$;
do $$ begin
  create type notif_kind as enum ('task', 'digest');
exception when duplicate_object then null; end $$;

-- ============ 用户 ============
create table if not exists users (
  id           uuid primary key default gen_random_uuid(),
  email        text unique,
  display_name text,
  created_at   timestamptz not null default now()
);

-- 账号体系升级（v2）：用户名 + 密码登录 + 启用状态 + 管理员标记
alter table users add column if not exists username text;
alter table users add column if not exists password_hash text;
alter table users add column if not exists is_admin boolean not null default false;
alter table users add column if not exists is_active boolean not null default true;

-- 用户名唯一（小写归一化后存库），空用户名的老数据不受影响
create unique index if not exists users_username_uq
  on users (username) where username is not null;

-- ============ AI 来源：溯源与聚合维度 ============
create table if not exists ai_sources (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  agent       text not null,
  session_key text not null,
  label       text,
  created_at  timestamptz not null default now(),
  unique (user_id, session_key)
);

-- ============ 任务 ============
create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  title            text not null,
  detail           text,
  status           task_status   not null default 'pending',
  severity         task_severity not null default 'need_human',
  project          text,
  links            jsonb not null default '[]'::jsonb,
  source_id        uuid references ai_sources(id) on delete set null,
  idempotency_key  text,
  notify_requested boolean not null default true,
  due_at           timestamptz,
  due_notified_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  acked_at         timestamptz,
  done_at          timestamptz
);

-- 幂等：AI 重试不产生重复任务
create unique index if not exists tasks_idem_uq
  on tasks (user_id, idempotency_key) where idempotency_key is not null;
create index if not exists tasks_list_idx   on tasks (user_id, status, created_at desc);
create index if not exists tasks_proj_idx   on tasks (user_id, project, status);
create index if not exists tasks_source_idx on tasks (source_id);
create index if not exists tasks_due_idx    on tasks (user_id, due_at) where due_at is not null;

-- ============ 事件流：所有状态变更，落库用于编排与审计 ============
create table if not exists task_events (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  task_id    uuid references tasks(id) on delete cascade,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_type_idx on task_events (type, id);

-- ============ 通知记录：浏览器横幅的投递流水 ============
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  task_id    uuid references tasks(id) on delete cascade,
  kind       notif_kind not null default 'task',
  title      text not null,
  body       text not null default '',
  severity   task_severity not null default 'need_human',
  task_count int not null default 1,
  url        text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists notif_user_idx   on notifications (user_id, created_at desc);
create index if not exists notif_unread_idx on notifications (user_id) where read_at is null;

-- ============ 通知规则（每用户一行） ============
create table if not exists notification_rules (
  user_id          uuid primary key references users(id) on delete cascade,
  min_severity     task_severity not null default 'need_human',
  quiet_hours      jsonb,
  cooldown_sec     int  not null default 300,
  group_by         text not null default 'source_session',
  digest_hour      int,
  last_digest_date date,
  updated_at       timestamptz not null default now()
);

-- ============ API Token（MCP 与脚本用） ============
create table if not exists api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,
  scopes       text[] not null default '{tasks:read,tasks:write}',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- ============ Web 会话（浏览器登录后签发） ============
create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz
);
create index if not exists sessions_token_idx on sessions (token_hash);
`;
