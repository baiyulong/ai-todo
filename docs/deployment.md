# AI Todo · 部署指南

两种部署形态，都是一条命令起：

| | 生产版 `docker-compose.yml` | 轻量版 `docker-compose.pglite.yml` |
|---|---|---|
| 数据库 | 独立 PostgreSQL 16 容器 | 内置 PGlite（Postgres 编译成 WASM） |
| 容器数 | 2 | 1 |
| 并发 | 连接池 10，可扛多人 | 单连接，**所有查询串行执行** |
| 备份 | `pg_dump` 标准 SQL | 打包数据目录 |
| 适合 | 多人使用、并发写入多 | 自己用、任务量不大、懒得装数据库 |

两版的 Web 界面、REST API、MCP 接入方式完全一样，只是换了个 `docker-compose` 文件名。

---

## 1. 前置条件

- Docker Engine 24+ 或 Docker Desktop（Windows / macOS / Linux 都行）
- Compose v2（`docker compose version` 能输出即可；老的 `docker-compose` 命令行不支持 `depends_on.condition`）
- 宿主机 **8787 端口**空闲（被占用就改 `.env` 里的 `AI_TODO_BIND`）

本项目**不需要**在宿主机上装 Node.js、PostgreSQL 或 Python —— 全部在镜像里。

---

## 2. 生产版（PostgreSQL）

### 2.1 准备环境变量

```powershell
copy .env.example .env
notepad .env
```

最少改两处：

```dotenv
# 宿主侧端口
AI_TODO_BIND=8787

# 浏览器打开的地址。局域网其它机器访问要写实际地址，例如 http://192.168.1.20:8787
AI_TODO_PUBLIC_URL=http://localhost:8787

# Postgres 密码：只用字母数字与下划线（它要拼进连接 URL）
POSTGRES_PASSWORD=换成你自己的
```

> `AI_TODO_PUBLIC_URL` 不是随便填的：它决定了**通知里那个深链接**长什么样。填成容器内的 `0.0.0.0` 或 `127.0.0.1`，你点通知就会打不开。

### 2.2 启动

```powershell
docker compose up -d --build
```

首次构建要装依赖、拉基础镜像，大约 1～3 分钟。之后：

```powershell
docker compose ps        # 两个容器都该是 healthy
docker compose logs -f app
```

看到这行就成功了：

```
  AI Todo 已启动
  Web 界面   http://localhost:8787
```

浏览器打开 `http://localhost:8787`，用管理员账号登录。

### 2.3 拿到管理员账号

首次启动会自动建管理员账号，并把用户名、初始密码、一枚访问令牌写进容器里的凭据文件：

```powershell
docker compose exec app cat /app/data/admin-credentials.txt
```

输出三行：

```
username=admin
password=xxxxxxxx
token=ait_xxxxxxxx
```

> **密码只显示这一次**（文件里存的是哈希，重启不会重新打印）。建议立刻存进密码管理器。

### 2.4 建其它账号

```powershell
docker compose exec -e AI_TODO_BASE_URL=http://127.0.0.1:8787 app node dist/src/cli.js user add alice
```

`user` 子命令要调服务端 API，而 compose 里 `AI_TODO_BASE_URL` 是**对外地址**（可能是局域网 IP）。在容器内部调用时用 `127.0.0.1:8787` 更快也更稳，所以上面那条命令显式覆盖了它。

> ⚠️ 不带 `-e AI_TODO_BASE_URL=...` 覆盖也能跑通（对外地址在你本机可达的话），但会绕一圈公网路径。

其它常用命令：

```powershell
# 列出账号
docker compose exec -e AI_TODO_BASE_URL=http://127.0.0.1:8787 app node dist/src/cli.js user list

# 重置密码（不指定就随机生成，只显示这一次）
docker compose exec -e AI_TODO_BASE_URL=http://127.0.0.1:8787 app node dist/src/cli.js user passwd alice

# 禁用账号（同时吊销它的会话与令牌）
docker compose exec -e AI_TODO_BASE_URL=http://127.0.0.1:8787 app node dist/src/cli.js user disable alice

# 删除账号（它的任务、会话、令牌一并清除）
docker compose exec -e AI_TODO_BASE_URL=http://127.0.0.1:8787 app node dist/src/cli.js user delete alice
```

### 2.5 签发 MCP 访问令牌

令牌也可以在 Web 端自助签发：**登录 → 右上角头像 → 设置 → 访问令牌 → 新建**。新建后只显示一次。

或者用 CLI：

```powershell
docker compose exec -e AI_TODO_BASE_URL=http://127.0.0.1:8787 app node dist/src/cli.js user token alice --name=claude
```

---

## 3. MCP 客户端怎么接

**MCP 是 stdio 协议**：AI 客户端（Claude Code / Cursor / Cline / Trae 等）负责把 MCP Server 拉起来，通过 stdin/stdout 通信。所以密钥（`AI_TODO_TOKEN`）必须出现在**拉起它的那台机器**的环境变量里。

> ⚠️ **最容易踩的一个坑：`args` 里的路径必须是「拉起 MCP 的那台机器」上的路径。**
> AI 客户端是在**你自己的电脑**上 spawn 这个进程的，Docker 镜像里的 `/app/dist/src/cli.js`
> 是**容器内**的路径，写进客户端配置会直接报 `Cannot find module '/app/dist/src/cli.js'`。
> 容器里跑的只是**服务端**；MCP Server 是个很薄的 HTTP 客户端，在哪儿跑都行——
> 只要它能通过 `AI_TODO_BASE_URL` 找到服务端。

### 方案 A（推荐）：MCP 客户端跑在本机

服务端在 Docker 里（`8787` 端口已暴露到宿主机），MCP 客户端在本机跑，连回去就行：

```json
{
  "mcpServers": {
    "ai-todo": {
      "command": "node",
      "args": ["C:/Users/你的用户名/Documents/projects/ai-todo/dist/src/cli.js", "mcp"],
      "env": {
        "AI_TODO_BASE_URL": "http://127.0.0.1:8787",
        "AI_TODO_TOKEN": "ait_xxxxxxxx"
      }
    }
  }
}
```

这是最省事的路子：不需要把 MCP 也塞进容器，调试也方便。

> 本机的 MCP Server 需要先构建一次：`npm install && npm run build`（只需要 `dist/`，不需要在本地跑服务）。

**服务端和客户端不在同一台机器时**（比如服务端在另一台 Linux / NAS 上，AI 客户端在你的电脑上），
只有 `AI_TODO_BASE_URL` 要改成服务端那台的地址，**`args` 依然填你自己电脑上的路径**：

```json
{
  "mcpServers": {
    "ai-todo": {
      "command": "node",
      "args": ["C:/Users/你的用户名/Documents/projects/ai-todo/dist/src/cli.js", "mcp"],
      "env": {
        "AI_TODO_BASE_URL": "http://192.168.1.20:8787",
        "AI_TODO_TOKEN": "ait_xxxxxxxx"
      }
    }
  }
}
```

> Windows 上如果客户端提示找不到 `node`，把 `command` 改成 Node 的绝对路径
> （`C:\\Program Files\\nodejs\\node.exe`），并把 `args` 里的路径写成双反斜杠或正斜杠。

### 方案 B：MCP 也跑在容器里

compose 里预留了 `mcp` 这个 profile 服务：

```powershell
# 先在 .env 里填好 AI_TODO_TOKEN
docker compose run --rm mcp
```

用 `run` 而不是 `up` —— `up` 会把它当常驻服务启动，而它是 stdio 模式、没有输入就会立刻退出。

容器内它通过服务名 `app` 直连：`AI_TODO_BASE_URL=http://app:8787`，不走端口映射。

> 方案 B 只在「AI 客户端本身就支持用 docker 命令当 MCP Server」时才好用。多数桌面客户端不支持，所以默认推荐方案 A。

### 方案 C（最省事）：客户端连远程 HTTP 端点

服务端自带 `POST /mcp`（Streamable HTTP）。**客户端机器上什么都不用装**——
不用 Node、不用依赖、不用 clone 项目，只要一个 URL 和一枚令牌：

```json
{
  "mcpServers": {
    "ai-todo": {
      "url": "http://192.168.1.20:8787/mcp",
      "headers": {
        "Authorization": "Bearer ait_xxxxxxxx"
      }
    }
  }
}
```

Trae / Cursor / Claude Code 都原生支持远程 HTTP MCP（Trae 在「设置 → MCP → 添加 → 手动添加」里选 **HTTP** 类型，填 URL 和请求头）。

| 特性 | 说明 |
|---|---|
| 端点 | `POST /mcp`（`GET` / `DELETE` 在无状态模式下返回 405） |
| 鉴权 | 只认 `Authorization: Bearer <访问令牌>`，**不接受会话 Cookie** |
| 会话 | 无状态——服务端不存任何会话状态，多实例、重启都不影响 |
| 来源标识 | 客户端可带 `X-Ai-Todo-Agent` 头标记自己（如 `trae`、`cursor`），任务卡片上会显示 |
| 开关 | `AI_TODO_MCP_HTTP=off` 可关闭该端点 |

配置完拿脚本自检一遍（会真的建一条任务再归档掉）：

```powershell
$env:AI_TODO_TOKEN = "ait_xxxxxxxx"
node scripts/mcp-http-check.mjs --url http://192.168.1.20:8787/mcp
```

> **暴露到公网前请三思**：这个端点等同于一个「用令牌就能往你列表里写东西」的接口。
> 令牌泄露 = 任何人都能给你塞任务。放到公网至少套一层 HTTPS 反代，
> 并且只发一枚专用令牌、给它单独的账号。

### 为什么不提供带会话的远程 HTTP MCP？

「远程 MCP 要处理会话、鉴权、CSRF，复杂度远高于收益」——这个判断在**有状态**实现下成立。
本项目选了一条捷径把它绕开：

- **无状态**：不生成 `Mcp-Session-Id`，每个 HTTP 请求独立处理。没有会话表、没有会话清理、没有粘性会话要求。
- **只认 Bearer PAT**：没有 Cookie 参与，就不存在「浏览器自动带上凭据」这回事，CSRF 直接不成立。
- **单次 JSON 响应**：不挂 SSE 长连接，请求结束连接就结束。

代价是放弃服务端主动推送（`notifications/tools/list_changed` 等）。本项目用不上——
工具清单是静态的，任务变更走 Web 端的 SSE 通道，不走 MCP 通道。

---

## 4. 轻量版（PGlite，无 PostgreSQL）

```powershell
docker compose -f docker-compose.pglite.yml up -d --build
```

其它操作完全一致，只是命令前面多一个 `-f docker-compose.pglite.yml`。

数据落在命名卷 `ai-todo_ai-todo-data` 的 `pgdata/` 目录里。

### 备份

PGlite 是单连接嵌入式库，**必须先停容器再打包**，否则文件可能不一致：

```powershell
docker compose -f docker-compose.pglite.yml stop
docker run --rm -v ai-todo_ai-todo-data:/data -v "${PWD}:/out" alpine tar -czf /out/ai-todo-data.tar.gz -C /data .
docker compose -f docker-compose.pglite.yml start
```

### 恢复

```powershell
docker compose -f docker-compose.pglite.yml stop
docker run --rm -v ai-todo_ai-todo-data:/data -v "${PWD}:/in" alpine sh -c "rm -rf /data/* && tar -xzf /in/ai-todo-data.tar.gz -C /data"
docker compose -f docker-compose.pglite.yml start
```

### 从轻量版换到生产版

数据需要导出再导入（两者存储格式不同）：

```powershell
# 1. 在轻量版上导出
docker compose -f docker-compose.pglite.yml exec -T app node dist/src/cli.js migrate   # 确保 schema 最新
docker run --rm -v ai-todo_ai-todo-data:/data -v "${PWD}:/out" alpine tar -czf /out/pgdata.tar.gz -C /data pgdata

# 2. 起生产版
docker compose up -d --build

# 3. 用导出出来的数据替换生产版的库（先停 app）
docker compose stop app
docker compose run --rm --no-deps -v "${PWD}:/in:ro" app sh -c "..."   # 详见下方说明
docker compose start app
```

说实话，**跨形态迁移没有一键命令**，因为 PGlite 的数据目录和 `pg_dump` 的 SQL 格式不是一回事。实际做法是：先在轻量版里把重要任务记下来（或用 Web 端导出——目前没有导出功能），到生产版重建。如果任务量不大，这是最省事的路径。

> 反方向更简单：生产版可以用 `pg_dump` 导出 SQL，再考虑怎么灌进 PGlite（PGlite 底层就是 Postgres，多数标准 SQL 能跑，但需要逐条验证，不保证）。

---

## 5. 日常运维

```powershell
# 看日志
docker compose logs -f app

# 重启（改了 .env 之后要重建容器才生效）
docker compose up -d --force-recreate app

# 停止（保留数据）
docker compose down

# 停止并删容器（保留数据卷）
docker compose down

# 连数据卷一起删干净（不可恢复！）
docker compose down -v
```

### 升级

```powershell
git pull
docker compose up -d --build
```

数据库迁移是**自动**的：`serve` 启动时会先跑迁移再监听端口，不需要单独执行 migrate 命令。

### 备份（生产版）

```powershell
docker compose exec -T postgres pg_dump -U ai_todo ai_todo > backup.sql
```

恢复（PowerShell 传 stdin 可能带 BOM，用 cmd 更保险）：

```powershell
cmd /c type backup.sql | docker compose exec -T postgres psql -U ai_todo ai_todo
```

---

## 6. 常见问题

**Q：端口被占用 / 起不来**
改 `.env` 里的 `AI_TODO_BIND`（比如 `8080`），然后 `docker compose up -d --force-recreate app`。注意 `AI_TODO_PUBLIC_URL` 也要跟着改成 `http://localhost:8080`。

**Q：登录提示成功，但立刻又跳回登录页**
Cookie 的 `secure` 属性由 `AI_TODO_BASE_URL` 决定：以 `https://` 开头就设 secure，只在 HTTPS 下发。如果你把 `AI_TODO_PUBLIC_URL` 设成了 `https://...` 但实际访问是 `http://`，浏览器就不会带上这个 cookie。把它改回 `http://` 即可。

**Q：忘了管理员密码**

```powershell
docker compose exec -e AI_TODO_BASE_URL=http://127.0.0.1:8787 app node dist/src/cli.js user passwd admin
```

**Q：通知里的链接点不开**
通知里的深链接按 `AI_TODO_PUBLIC_URL` 拼。确认这个值是**你浏览器真正能访问到的地址**，而不是容器内的 `0.0.0.0`。改完重启 app 容器。

**Q：容器里怎么进数据库看数据**

```powershell
# 生产版
docker compose exec postgres psql -U ai_todo -d ai_todo
```

**Q：数据存在哪？删了容器会丢吗**
存在 Docker 命名卷里（`ai-todo_ai-todo-data` 和 `ai-todo_ai-todo-pg`）。`docker compose down` 不删卷；只有 `docker compose down -v` 才删。

```powershell
docker volume ls | findstr ai-todo
```

**Q：想放到 nginx / Caddy 后面**
项目目前没有开 `trustProxy`，反代后日志里记录的会是反代 IP（不影响功能，只影响来源统计）。
反代 HTTPS 时，把 `AI_TODO_PUBLIC_URL` 设成 `https://你的域名`，Cookie 才会带 `secure`。
另外 SSE（实时推送）需要反代**关闭响应缓冲**，否则事件要等缓冲满了才推给浏览器。nginx 对应的设置是 `proxy_buffering off;`。

**Q：容器内存占用高**
PGlite 是 WASM 跑的 Postgres，内存占用比原生 Postgres 大一些。生产版换成 PostgreSQL 容器会明显轻一些。

---

## 7. 镜像是怎么做的

**多阶段构建**：`node:22-slim` 装全量依赖 → `tsc` 编译 → 运行阶段只 `npm ci --omit=dev` + 拷贝 `dist/` 和 `web/`。TypeScript 编译器、开发依赖都不进最终镜像。

**非 root 运行**：运行阶段切到内置 `node` 用户。`/app/data` 在镜像里就 `chown` 给它，命名卷首次挂载时继承这个属主，所以容器能正常写凭据文件与数据库文件。

**`.dockerignore` 挡住了什么**：本地的 `data/`（数据库文件 + 明文密码令牌）、`.env`、`node_modules`、`dist`、文档与开发脚本。**本地凭据不会进镜像**。

**健康检查**：镜像里没有 `curl`，用 Node 自带的 `fetch` 打 `/api/v1/health`（这个接口免鉴权）。Postgres 容器用官方自带的 `pg_isready`。

**信号处理**：compose 里 `init: true` 让 tini 当 PID 1，容器停止时 SIGTERM 能正确送到 Node，服务端注册的关闭钩子（停调度器 → 关数据库连接）才会跑完。

**环境变量**（容器内）：

| 变量 | 值 | 说明 |
|---|---|---|
| `AI_TODO_HOST` | `0.0.0.0` | 必须，否则容器外访问不到 |
| `AI_TODO_PORT` | `8787` | 容器内端口，改它要同步改 compose 的端口映射 |
| `AI_TODO_DATA_DIR` | `/app/data` | 凭据文件与 PGlite 数据目录 |
| `AI_TODO_WEB_DIR` | `/app/web` | 前端静态资源 |
| `AI_TODO_BASE_URL` | 来自 `AI_TODO_PUBLIC_URL` | 通知深链接与 Cookie secure 的依据 |
| `DATABASE_URL` | 生产版指向 `postgres:5432`；轻量版留空 | 留空 = 用 PGlite |
