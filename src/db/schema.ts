/**
 * AI Todo · PostgreSQL Schema（配置 A）
 *
 * 说明：
 * - 使用真实 PostgreSQL 语法，SQLite 不兼容（jsonb、部分索引、枚举类型、ON CONFLICT 推断）。
 * - 默认使用 PGlite（编译为 WASM 的 PostgreSQL）零安装运行；设置 DATABASE_URL 后切换到标准 pg 驱动。
 * - gen_random_uuid() 自 PostgreSQL 13 起为内核函数；老版本库（<13）没有且可能装不了
 *   pgcrypto 扩展，因此统一用内核表达式自造 v4 UUID（app_uuid()），任何版本都可用。
 * - 配置 A 不建 channels 表：没有外部推送通道，不需要通道订阅与凭据管理。
 *   未来若升级到配置 B（增加邮件 / 群机器人 / Server酱 兜底），加回 channels 表即可，
 *   任务模型与本表其余部分不受影响。
 */

export const SCHEMA_SQL = `
-- ============ 兼容函数 ============
-- gen_random_uuid() 只在 PostgreSQL 13+ 内置；老版本且无 pgcrypto 时不可用。
-- 这里用内核表达式构造标准 v4 UUID：md5 摘要的 hex 第 13 位放版本位 '4'、
-- 第 17 位放变体位 '8'，::uuid 转型自动插入连字符。输出格式与 gen_random_uuid() 一致。
create or replace function app_uuid() returns uuid as $$
  select overlay(overlay(md5(random()::text || clock_timestamp()::text) placing '4' from 13) placing '8' from 17)::uuid
$$ language sql volatile;

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
  id           uuid primary key default app_uuid(),
  email        text unique,
  display_name text,
  created_at   timestamptz not null default now()
);

-- 账号体系升级（v2）：用户名 + 密码登录 + 管理员标记
alter table users add column if not exists username text;
alter table users add column if not exists password_hash text;
alter table users add column if not exists is_admin boolean not null default false;
-- 禁用功能已移除（有删除功能就够了）：老库里的 is_active 列一并清掉
alter table users drop column if exists is_active;

-- 用户名唯一（小写归一化后存库），空用户名的老数据不受影响
create unique index if not exists users_username_uq
  on users (username) where username is not null;

-- ============ 微信登录：账号映射 ============
-- 一个微信身份（openid）对应一个站内账号。
-- openid 在同一个开放平台账号下唯一；unionid 在同一开放平台账号下的多个应用之间唯一，
-- 拿得到 unionid 时用它兜底换绑（用户可能先在公众号上登过，再来网站应用登）。
alter table users add column if not exists wechat_openid text;
alter table users add column if not exists wechat_unionid text;
alter table users add column if not exists wechat_nickname text;
alter table users add column if not exists avatar_url text;
-- 账号的登录方式：password | wechat | both
alter table users add column if not exists auth_provider text not null default 'password';

create unique index if not exists users_wechat_openid_uq
  on users (wechat_openid) where wechat_openid is not null;
create index if not exists users_wechat_unionid_idx
  on users (wechat_unionid) where wechat_unionid is not null;

-- ============ AI 来源：溯源与聚合维度 ============
create table if not exists ai_sources (
  id          uuid primary key default app_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  agent       text not null,
  session_key text not null,
  label       text,
  created_at  timestamptz not null default now(),
  unique (user_id, session_key)
);

-- ============ 任务 ============
create table if not exists tasks (
  id               uuid primary key default app_uuid(),
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
  id         uuid primary key default app_uuid(),
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
  id           uuid primary key default app_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,
  scopes       text[] not null default '{tasks:read,tasks:write}',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- 任务回复：用户在网页上回复任务后任务标记完成，
-- AI 侧通过 MCP todo_wait_reply / todo_get_reply 取回回复内容继续工作
alter table tasks add column if not exists reply_text text;
alter table tasks add column if not exists replied_at timestamptz;

-- 管理界面要支持随时复制令牌明文，所以明文直接落库（自托管场景可接受）。
-- 老令牌只有哈希、无法回填明文，这些行的 token 为空，界面上仅显示掩码。
alter table api_tokens add column if not exists token text;

-- ============ 项目 ============
-- 项目是任务的一等维度：先有项目，令牌绑定项目，任务落在令牌的项目里。
-- tasks.project 冗余存项目名（展示/筛选/分组直接用），project_id 才是权威关联。
create table if not exists projects (
  id         uuid primary key default app_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  name       text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists projects_user_name_uq
  on projects (user_id, name);
-- 每个用户至多一枚默认项目
create unique index if not exists projects_default_uq
  on projects (user_id) where is_default;

alter table tasks add column if not exists project_id uuid references projects(id);
alter table api_tokens add column if not exists project_id uuid references projects(id);

-- 默认项目：每个用户一枚，幂等补种
insert into projects (user_id, name, is_default)
select u.id, '默认项目', true from users u
on conflict do nothing;

-- 老数据迁移：任务按名字归到同名项目，没名字的归默认项目
insert into projects (user_id, name)
select distinct user_id, project from tasks
where project is not null and project <> ''
on conflict do nothing;
update tasks t set project_id = p.id
from projects p
where p.user_id = t.user_id
  and p.name = coalesce(nullif(t.project, ''), '默认项目');

-- 老令牌统一挂到所属用户的默认项目
update api_tokens a set project_id = p.id
from projects p
where a.project_id is null and p.user_id = a.user_id and p.is_default;

-- ============ Web 会话（浏览器登录后签发） ============
create table if not exists sessions (
  id           uuid primary key default app_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz
);
create index if not exists sessions_token_idx on sessions (token_hash);

-- ============ 微信扫码登录的中间态 ============
-- 桌面端发起扫码 → 手机端微信授权 → 微信回调带 code 回来 → 桌面端轮询取回登录结果。
-- 桌面和手机是两个设备，session cookie 没法跨过去，所以必须有一个服务端中转站：
--   state     ：随机串，既是防伪 token 也是桌面端轮询的钥匙
--   purpose   ：login = 用这个微信身份登录；bind = 把这个微信身份绑到当前账号
--   status    ：pending → confirmed / failed / expired
--   session_token / issued_token：签发结果。明文只在这张表里短暂停留（默认 5 分钟），
--   过期即删；会话本身在 sessions 表里仍然只存哈希。
create table if not exists auth_pending_logins (
  state         text primary key,
  purpose       text not null default 'login',
  status        text not null default 'pending',
  user_id       uuid references users(id) on delete cascade,
  error_code    text,
  session_token text,
  issued_token  text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index if not exists pending_login_exp_idx on auth_pending_logins (expires_at);

-- ============ 邮箱绑定验证码 ============
-- 绑定邮箱走「收验证码 → 回填确认」流程，防止把别人的邮箱绑到自己账号上。
-- 一个邮箱同时只保留一条待验证记录（主键即邮箱）：重发验证码直接覆盖。
-- code_hash 存哈希不存明文；expires_at 过期即作废（查询时顺带清理）。
create table if not exists email_verifications (
  email      text primary key,
  code_hash  text not null,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists email_verif_exp_idx on email_verifications (expires_at);
`;
