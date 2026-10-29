# AI Todo

AI 完成任务后，把「已完成、需你关注」的事项推到一个待办列表，并可靠地提醒你。

技术路线是 **配置 A：纯 Web** —— 不装任何客户端，只用浏览器的系统级通知 + 未读列表作为可靠性地基（详见 `docs/technical-design.md`）。

```
AI 客户端 ──MCP(stdio)──▶ AI Todo 服务端 ──SSE──▶ 浏览器 ──▶ 系统级横幅
  env 里带 PAT          规则编排/聚合           实时推送      真·持久通知
   → 推给谁由令牌决定                            每个用户只看得到自己的任务
                              │
                              └──────── 未读列表（永久保留，不会丢）
```

---

## 快速开始

### 1. 环境要求

- Node.js ≥ 20.10（本项目在 Node 24.22 上开发）
- 无需 Docker、Postgres、Python（想用容器部署见下方「Docker 部署」，宿主机只装 Docker 即可）

### 2. 安装与构建

```powershell
npm install
npm run build
```

### 3. 启动服务

```powershell
npm start
```

首次启动会自动建表、创建管理员账号，并把凭据写进 `data/admin-credentials.txt`：

```
  AI Todo 已启动
  ─────────────────────────────────────────
  Web 界面   http://127.0.0.1:8787
  数据库     PGlite (…\ai-todo\data\pgdata)
  管理员     admin
  凭据文件   …\ai-todo\data\admin-credentials.txt

  首次启动，已创建管理员账号：
    用户名   admin
    初始密码 <随机生成，只显示这一次>
    （只显示这一次，请立即保存）
```

> **Windows 注意**：`node` 不一定在默认 PATH 上。若提示找不到命令，用完整路径：
> `& "C:\Program Files\nodejs\node.exe" ".\dist\src\cli.js" serve`
>
> 或者直接**双击 `scripts\start.cmd`**——它会自动定位 Node、必要时先编译，然后在独立窗口里跑服务。
> **关闭那个窗口就是停止服务。**（如果服务是由 AI 助手或脚本代为拉起的，它可能被宿主环境回收；想长期常驻就用这个脚本自己启动。）

### 4. 打开 Web 界面

浏览器访问 <http://127.0.0.1:8787>，用**用户名 + 密码**登录（凭据见 `data/admin-credentials.txt`）。

登录后点右上角横幅里的「**开启通知**」授权系统通知权限——**这一步是必须的**，否则 AI 干完活你只会看到页面上多了一条记录，不会弹横幅。

> **务必用独立的 PWA 窗口，不要只留一个后台标签页。**
> Chrome 会冻结后台标签页（5 分钟后进入 frozen 状态），冻结页面里发出的通知会被静默丢弃。
> 从浏览器菜单「安装应用 / 添加到桌面」把 AI Todo 装成独立应用并保持窗口开着，是最稳的用法。

**顶栏右上角是你当前登录的账号**（头像 + 用户名）。点开是下拉菜单：

| 菜单项 | 作用 |
|---|---|
| 账号信息 | 显示当前用户名与角色（管理员 / 普通用户） |
| 账号与令牌 | 打开设置抽屉（令牌签发 / 吊销、用户管理、通知规则） |
| **退出登录** | 注销当前会话，回到登录页 |

> 退出登录会**真的吊销服务端会话**（`sessions` 表里的记录直接删除），不是只清浏览器 Cookie——
> 旧 Cookie 换个浏览器也用不了。

### 5. 删除是分两级的

任务卡片右上角有一个垃圾桶图标，**默认藏着，鼠标移到卡片上才出现**。它的含义取决于任务的状态：

| 任务状态 | 图标 | 点击后 |
|---|---|---|
| 待处理 / 已接手 / 已完成 | 垃圾桶 | **归档**（软删除）—— 从列表消失，但能在「全部」标签里找回 |
| 已归档 | 红色垃圾桶带叉 | **彻底删除**—— 弹二次确认框，确认后永久消失，无法恢复 |

> 为什么要分两级：只有软删除的话，「全部」标签就是个永远清不空的回收站；
> 只有硬删除的话，手滑一下就会把正在处理的任务永久删掉。
> 分开既保住了可恢复性，也留得出清空回收站的出口。
>
> 注意硬删除**只对已归档的任务开放**——没归档就想硬删，服务端会回 409。
>
> 工具栏还有个「**清空已归档（N）**」按钮，一键永久删除全部已归档任务（同样有二次确认）。
> 没有已归档任务时它会整个藏起来。

---

## Docker 部署

宿主机**只需要 Docker**，不需要 Node、Postgres、Python：

```powershell
copy .env.example .env
notepad .env            # 改 AI_TODO_PUBLIC_URL 与 POSTGRES_PASSWORD
docker compose up -d --build
```

打开 <http://localhost:8787> 即可。管理员凭据在容器里：

```powershell
docker compose exec app cat /app/data/admin-credentials.txt
```

MCP 客户端连本机的 `http://127.0.0.1:8787` 即可——**宿主机没有 Node 也能用**。

仓库里另有一份 `docker-compose.pglite.yml`，是**零外部依赖的单容器版**（内置 PGlite 数据库，少一个 Postgres 容器）：

```powershell
docker compose -f docker-compose.pglite.yml up -d --build
```

完整的部署、备份、MCP 接入与排错说明见 **[docs/deployment.md](docs/deployment.md)**。

---

## 账号体系

### 用户与凭据是三件独立的东西

| 东西 | 用途 | 存在哪 |
|---|---|---|
| **账号**（用户名 + 密码） | 人登录 Web 界面 | `users` 表，密码用 scrypt 加盐哈希，明文不落库 |
| **访问令牌（PAT）** | AI 客户端通过 MCP 推送任务 | `api_tokens` 表，只存 sha256 哈希，明文签发时显示一次 |
| **会话 Cookie** | 浏览器登录态 | `sessions` 表，HttpOnly + SameSite=Lax，默认 30 天 |

**令牌决定任务推给谁。** 每个用户签发的令牌只往自己名下推任务，别人用同一枚令牌也会进到同一个账号里。所以给不同 AI 客户端配不同账号，就是最清晰的隔离。

### 建号

```powershell
npm run user -- add alice                  # 建号，打印初始密码与访问令牌
npm run user -- add alice --display-name "爱丽丝"
npm run user -- add bob --admin            # 建管理员
npm run user -- list                       # 列出所有账号
npm run user -- passwd alice               # 重置密码（随机生成，只显示一次）
npm run user -- disable alice              # 禁用（同时吊销其令牌与会话）
npm run user -- enable alice
npm run user -- delete alice               # 删除（任务/会话/令牌一并清除）
npm run user -- token alice --name=claude  # 为 alice 签发一枚 MCP 用的令牌
```

> `npm run user -- ...` 需要服务正在运行（这些命令走 REST API 操作账号）。
> 初始密码与访问令牌**只显示这一次**，请立即保存。

管理员也可以在 Web 端「设置 → 用户管理」里建号、禁用账号。

### 用户之间互相看不到

所有任务、通知记录、规则都以 `user_id` 为界：查询一律带 `user_id` 过滤，鉴权把 PAT / 会话解析成 `user_id` 后再查。

| 场景 | 结果 |
|---|---|
| A 用自己的令牌推任务 | 任务只出现在 A 的列表里 |
| B 登录 Web 界面 | 看不到 A 的任何任务、通知记录、规则 |
| B 直接猜 A 的任务 ID 调接口 | 404（不是 403，不泄露任务是否存在） |
| A 被管理员禁用 | A 的令牌与会话立即失效，推送与登录都被拒 |

### 服务端磁盘上有哪些凭据

| 文件 | 内容 | 说明 |
|---|---|---|
| `data/admin-credentials.txt` | 管理员用户名、初始密码、一枚 PAT | 唯一需要保管的凭据文件；**明文只写一次**，库里只有哈希 |
| `data/admin-token.txt` | 一枚 PAT | v1 遗留文件，仅用于老库迁移时复用令牌，新代码不再读取 |
| `data/user-token.txt` | — | **v1 遗留文件，已删除**。它的令牌也已在库里吊销，留着就是个绕过环境变量的后门 |

> 客户端（MCP / 脚本）侧的凭证一律走 `AI_TODO_TOKEN` 环境变量，服务端不提供任何文件兜底。详见下一节。

---

## 接入 AI 客户端（MCP）

### 凭证必须走环境变量

MCP Server 被 AI 客户端拉起时，**只认环境变量里的 `AI_TODO_TOKEN`**。没有它就拒绝启动：

```
[ai-todo-mcp] 缺少 AI_TODO_TOKEN 环境变量。
```

这不是偷懒，而是三点考虑：

1. **谁配的客户端就推给谁**——令牌在客户端配置里，一眼能看出任务会进谁的列表。
2. **不写进仓库**——配置文件经常会被提交或分享，环境变量不会。
3. **不落到服务端文件系统**——MCP 进程没有秘密可读。

### 客户端配置

```json
{
  "mcpServers": {
    "ai-todo": {
      "command": "node",
      "args": ["C:\\Users\\mctadmin\\Documents\\projects\\ai-todo\\dist\\src\\cli.js", "mcp"],
      "env": {
        "AI_TODO_BASE_URL": "http://127.0.0.1:8787",
        "AI_TODO_TOKEN": "ait_xxxxxxxx"
      }
    }
  }
}
```

> Windows 上如果 `node` 不在 PATH，把 `command` 换成完整路径 `"C:\\Program Files\\nodejs\\node.exe"`。

令牌从哪来，三选一：

- Web 端「设置 → 访问令牌」自助签发（明文只显示一次）
- `npm run user -- token <用户名> --name=xxx`
- `npm run token -- --name=xxx`（给自己签）

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `AI_TODO_TOKEN` | **必填**，访问令牌 | 无（缺失则拒绝启动） |
| `AI_TODO_BASE_URL` | 服务地址 | `http://127.0.0.1:8787` |
| `AI_TODO_SESSION_KEY` | 会话标识（决定聚合分组） | 每次启动随机 UUID |
| `AI_TODO_AGENT` | 来源标识 | `mcp-client` |
| `AI_TODO_SOURCE_LABEL` | 来源显示名 | 无 |

---

## MCP 工具

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `todo_create` | 推进一条需要用户关注的事项 | `title`(必填)、`severity`、`detail`、`project`、`links`、`due_at`、`notify`、`idempotency_key` |
| `todo_list` | 查询待办 | `status`、`severity`、`project`、`q`、`limit` |
| `todo_update` | 改标题/详情/级别/项目 | `id` + 任意可改字段 |
| `todo_ack` | 标记「我已接手」，停止重复提醒 | `id` |
| `todo_done` | 标记已完成 | `id` |
| `todo_archive` | 归档（忽略掉） | `id` |
| `todo_snooze` | 推迟提醒到指定时刻 | `id`、`until` |

资源：`todo://tasks` —— 当前待处理任务的 Markdown 列表，AI 可以直接读取。

### 给 AI 的调用约定

- **只推真正需要人介入的事**：纯进度更新不要调用。`severity=info` 表示只记录不打扰。
- `severity` 三档：`info`（只记录）/ `need_human`（需要用户处理，默认）/ `blocker`（阻塞中，绕过冷却立即提醒）。
- **幂等**：不传 `idempotency_key` 时，服务端按 `agent + session + 标题哈希` 生成，重复调用不会重复推送。

---

## 通知规则

在 Web 界面右上角齿轮图标里可改，也可用 REST 接口 `PUT /api/v1/rules`：

| 规则 | 默认值 | 说明 |
|---|---|---|
| `min_severity` | `need_human` | 低于此级别不推送 |
| `cooldown_sec` | `300` | 同一分组内的聚合冷却窗口 |
| `group_by` | `source_session` | 聚合分组维度：`source_session` / `project` / `none`。分组键始终带账号作用域，不同账号的任务不会并进同一条通知 |
| `quiet_hours` | 空 | 静默时段 `{start:"23:00", end:"08:00"}`，到点后再推 |
| `digest_hour` | 空 | 每日摘要时间点（0–23），设了就开 |

### 节流策略：首条即时 + 尾部合并

不是「攒够一批再一起推」，而是：

1. **首条立刻推** —— AI 干完活你第一时间就知道（这是核心体验，不能为了合并牺牲）。
2. **冷却窗口内的后续任务先攒着** —— 不逐条打扰。
3. **窗口结束时合并成一条**「另外 N 项需要你关注」。
4. **`blocker` 绕过冷却与聚合**，单独即时推送。

---

## 可靠性设计

| 层 | 作用 | 失效时 |
|---|---|---|
| **未读列表** | 待办永久保留，不过期、不自动清除 | 最后的地基，永远在 |
| **SSE 实时通道** | 任务写入后 ~1 秒内推送到浏览器 | 断线自动重连（`retry: 3000`） |
| **浏览器系统级通知** | `registration.showNotification()`，持久横幅 | 需要页面活着；权限被拒则降级为页内提示 |

已知边界（配置 A 的硬约束）：

- **关掉浏览器窗口 = 彻底失联**，没有本机进程就没有真正的后台横幅。
- 页面被 Chrome 冻结后不再推送 → 所以要用独立 PWA 窗口。
- 需要 HTTPS 或 localhost 才能用 Service Worker 与通知权限。

---

## 目录结构

```
src/
  config.ts          配置加载（.env 解析、路径定位）
  cli.ts             serve / mcp / user / token / migrate 五个子命令
  db/
    schema.ts        PostgreSQL DDL（幂等迁移）
    index.ts         Db 接口 + PGlite / pg 双驱动
    migrate.ts       迁移执行器
  domain/
    types.ts         Task / Rules / NotificationRecord 等类型
    tasks.ts         TaskService：全部任务相关的数据库读写
    users.ts         UserService：账号增删改查与认证
    passwords.ts     scrypt 密码哈希与校验（零第三方依赖）
    rules.ts         规则纯函数（级别阈值、静默时段、聚合分组）
  notify/
    bus.ts           SSE 广播总线
    orchestrator.ts  通知编排（首条即时 / 尾部合并 / 静默 / 绕过冷却）
    scheduler.ts     30 秒 tick：到点提醒（due_at）+ 每日摘要
  http/
    auth.ts          PAT / 会话鉴权、账号禁用检查
    server.ts        Fastify 路由、SSE 端点、账号与令牌管理、静态文件
  mcp/
    client.ts        REST 客户端
    server.ts        stdio MCP Server（7 个工具 + 1 个资源）
web/
  index.html         应用壳
  styles.css         亮/暗双主题
  app.js             登录、列表、筛选、SSE、通知、令牌与用户管理
  sw.js              Service Worker（应用壳缓存 + 通知点击处理）
  manifest.webmanifest
  icon.svg
scripts/
  e2e.mjs            端到端验证脚本（115 项检查）
  start.cmd          Windows 一键启动（自动定位 Node、必要时先编译）
Dockerfile           多阶段构建：编译 → 只留运行时依赖与产物，非 root 运行
docker-compose.yml   生产部署：app + PostgreSQL 16
docker-compose.pglite.yml  轻量部署：单容器，内置 PGlite
.dockerignore        挡住 data/、.env、node_modules 等，不让本地凭据进镜像
.env.example         容器部署可用环境变量清单
docs/
  technical-design.md       技术方案 v0.12
  deployment.md              Docker 部署指南（部署 / 备份 / MCP 接入 / 排错）
  form-factor-research.html 形态选型调研报告
```

---

## 配置项

通过环境变量或项目根目录的 `.env` 文件配置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AI_TODO_PORT` | `8787` | 监听端口 |
| `AI_TODO_HOST` | `127.0.0.1` | 监听地址（`0.0.0.0` 可对外暴露） |
| `AI_TODO_BASE_URL` | `http://127.0.0.1:8787` | 生成通知链接用；HTTPS 时会话 Cookie 自动加 `secure` |
| `AI_TODO_DATA_DIR` | `data` | 凭据文件与 PGlite 数据目录 |
| `AI_TODO_WEB_DIR` | `web` | 前端静态目录 |
| `AI_TODO_SESSION_TTL_DAYS` | `30` | 会话 Cookie 有效期 |
| `AI_TODO_LOG_LEVEL` | `info` | 日志级别 |
| `DATABASE_URL` | 空 | 设置后改用标准 PostgreSQL 驱动；不设置则用 PGlite（零安装） |

数据库保持真实 PostgreSQL 语法（jsonb、部分索引、枚举、`ON CONFLICT` 推断），设了 `DATABASE_URL` 即可平移到 Postgres，不返工。

---

## REST 接口

除 MCP 外，所有接口都在 `/api/v1` 下。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/health` | 健康检查（免鉴权） |
| `POST` | `/api/v1/auth/login` | 用户名 + 密码换会话 Cookie |
| `POST` | `/api/v1/auth/token` | 访问令牌换会话 Cookie（脚本用） |
| `POST` | `/api/v1/auth/logout` | 退出 |
| `GET`/`POST` | `/api/v1/tokens` | 列出 / 签发自己的访问令牌 |
| `DELETE` | `/api/v1/tokens/:id` | 吊销自己的访问令牌 |
| `GET`/`POST` | `/api/v1/admin/users` | 列出 / 新建账号（需 admin） |
| `PATCH`/`DELETE` | `/api/v1/admin/users/:id` | 改账号（禁用 / 改密码 / 改角色）/ 删除账号 |
| `POST` | `/api/v1/admin/users/:id/tokens` | 为指定用户签发令牌（需 admin） |
| `GET`/`POST` | `/api/v1/tasks` | 列表 / 创建 |
| `GET`/`PATCH` | `/api/v1/tasks/:id` | 详情 / 修改 |
| `DELETE` | `/api/v1/tasks/:id` | 彻底删除（不可恢复，只对已归档的任务开放） |
| `DELETE` | `/api/v1/tasks/archived` | 批量清空自己的已归档任务，返回 `{ deleted: N }` |
| `POST` | `/api/v1/tasks/:id/ack` `/done` `/archive` `/snooze` | 状态流转 |
| `GET` | `/api/v1/notifications` | 通知记录 |
| `GET`/`PUT` | `/api/v1/rules` | 通知规则 |
| `GET` | `/api/v1/me` | 用户信息、待办数、来源列表、实时连接数 |
| `GET` | `/api/v1/stream` | SSE 实时事件流 |

鉴权方式二选一：`Authorization: Bearer <PAT>` 或登录后的会话 Cookie。

**错误约定**：参数写错一律回 **400**，不回 500。

| 情况 | 状态码 | 说明 |
|---|---|---|
| `status` / `severity` 取值不在枚举里 | 400 | message 列出可选值 |
| 路径参数 `:id` 不是合法 UUID | 400 | message 回显原值 |
| 合法 UUID 但不属于当前用户 | 404 | 不泄露该 ID 是否存在 |
| 未带凭证 / 凭证已吊销 | 401 | 未鉴权请求先回 401，不做参数校验 |
| 鉴权通过但 scope 不足 | 403 | 例如非管理员调 `/admin/users` |

`ack` / `done` / `archive` / `snooze` 不需要请求体，带不带 `Content-Type: application/json` 都能正常调用（空 body 不会报错）。

---

## 验证

```powershell
npm run build
npm start            # 另开一个终端保持运行
node scripts/e2e.mjs # 另一个终端跑验证
```

覆盖 115 项检查：健康检查、静态资源、**前端表单提交静态检查（2 项）**、用户名密码登录、错误密码被拒、**退出登录后旧会话立即 401**、SSE 推送、任务创建、幂等命中、不打扰场景、冷却窗口聚合、blocker 绕过、状态流转、归档、规则读写、通知记录、**多用户隔离**、令牌自助签发与吊销、禁用账号后令牌立即失效、**非法枚举查询参数返回 400**、**无 body 的 JSON 头 POST 可用**、**非法 JSON body 返回 400**、**`__proto__` 污染被拦截**、**非法 UUID 路径参数返回 400**、**未鉴权请求先回 401**、MCP stdio 全流程、**MCP 缺少环境变量凭证时拒绝启动**、**通知聚合不跨账号串台**、**账号在聚合窗口期内被删除后服务仍然存活**、**未归档的任务不能彻底删除**、**已归档的任务可以彻底删除**、**别的账号删不掉我的任务**、**批量清空只清自己的已归档任务**。

脚本默认连 `http://127.0.0.1:8787` 并读 `data/admin-credentials.txt`；指向别的实例时用环境变量覆盖：

```powershell
$env:AI_TODO_BASE_URL = 'http://127.0.0.1:8788'
$env:AI_TODO_USER = 'admin'
$env:AI_TODO_PASSWORD = '...'
$env:AI_TODO_TOKEN = 'ait_...'
node scripts/e2e.mjs
```

脚本每次运行使用独立的会话与项目名（冷却状态按分组记忆，复用同一分组会命中上一轮遗留的冷却窗口），开头会把管理员的通知规则归位为默认值（避免上一轮崩溃留下的残值干扰本轮），跑完会自动归档自己产生的测试任务并删除测试账号。

---

## 已实现 / 未实现

**已实现**：账号体系（用户名 + 密码登录、scrypt 哈希、启用/禁用、角色）、用户级数据隔离、访问令牌自助签发与吊销、管理员用户管理、任务模型与状态机、幂等写入、MCP 7 工具 + 1 资源、REST API、SSE 实时推送、首条即时 + 尾部合并的节流、静默时段、每日摘要、到点提醒（`due_at`）、PWA + 系统级通知、通知规则配置面板、快捷键（`j`/`k`/`a`/`d`/`/`）、PGlite 零安装运行。

**未实现（v2+）**：自助注册、密码找回、看板/甘特图视图、离线编辑冲突合并、外部推送通道（微信/邮件/Server酱）、桌面原生壳、远程 Streamable HTTP MCP、移动端。

> 外部通道的接入位已经预留：配置 A 与配置 B 的任务模型、MCP 工具、REST API、聚合规则完全一致，切换不返工。
