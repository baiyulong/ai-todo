import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { TaskService } from '../domain/tasks.js';
import type { GroupBy, TaskSeverity, TaskStatus } from '../domain/types.js';
import { UserService, isValidUsername } from '../domain/users.js';
import { generatePassword } from '../domain/passwords.js';
import { NotificationBus } from '../notify/bus.js';
import type { NotificationOrchestrator } from '../notify/orchestrator.js';
import {
  createAuthenticator,
  createSession,
  currentAuth,
  generateToken,
  hashToken,
  resolvePatToken,
  type AuthContext,
} from './auth.js';
import { createMcpHttpHandler } from '../mcp/http.js';

const linkSchema = z.object({
  label: z.string().max(120).optional(),
  url: z.string().min(1).max(2000),
});

const TASK_STATUSES = ['pending', 'acked', 'done', 'archived'] as const;
const TASK_SEVERITIES = ['info', 'need_human', 'blocker'] as const;

/**
 * 解析逗号分隔的枚举查询参数。
 * 返回 values（合法时）或 error（400 响应体），供路由直接透传。
 */
function parseEnumFilter(
  raw: string | undefined,
  allowed: readonly string[],
  field: string,
): { values: string[]; error?: { error: { code: string; message: string; details?: unknown } } } {
  if (!raw) return { values: [] };
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const bad = values.filter((v) => !allowed.includes(v));
  if (bad.length > 0) {
    return {
      values: [],
      error: {
        error: {
          code: 'invalid_argument',
          message: `参数 ${field} 取值非法：${bad.join(', ')}；可选值 ${allowed.join(', ')}`,
          // 结构化详情：界面按它翻译成当前语言，不依赖这里的中文 message
          details: { kind: 'enum', param: field, value: bad.join(', '), allowed: allowed.join(', ') },
        },
      },
    };
  }
  return { values };
}

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().max(8000).optional(),
  severity: z.enum(['info', 'need_human', 'blocker']).optional(),
  project: z.string().max(120).optional(),
  links: z.array(linkSchema).max(20).optional(),
  idempotency_key: z.string().max(300).optional(),
  notify: z.boolean().optional(),
  due_at: z.string().max(60).optional(),
  source: z
    .object({
      agent: z.string().max(120).optional(),
      session_key: z.string().max(200).optional(),
      label: z.string().max(200).optional(),
    })
    .optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  detail: z.string().max(8000).nullable().optional(),
  severity: z.enum(['info', 'need_human', 'blocker']).optional(),
  project: z.string().max(120).nullable().optional(),
  links: z.array(linkSchema).max(20).optional(),
  notify: z.boolean().optional(),
  due_at: z.string().max(60).nullable().optional(),
});

const rulesSchema = z.object({
  min_severity: z.enum(['info', 'need_human', 'blocker']).optional(),
  quiet_hours: z
    .object({
      start: z.string().regex(/^\d{1,2}:\d{2}$/),
      end: z.string().regex(/^\d{1,2}:\d{2}$/),
      tz: z.string().max(64).optional(),
    })
    .nullable()
    .optional(),
  cooldown_sec: z.number().int().min(0).max(86_400).optional(),
  group_by: z.enum(['source_session', 'project', 'none']).optional(),
  digest_hour: z.number().int().min(0).max(23).nullable().optional(),
});

export interface ServerDeps {
  config: Config;
  db: Db;
  tasks: TaskService;
  users: UserService;
  orchestrator: NotificationOrchestrator;
  bus: NotificationBus;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, db, tasks, users, orchestrator, bus } = deps;

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 1_048_576,
  });

  await app.register(cookie, { secret: undefined });

  // 状态流转类接口（ack / done / archive）不需要请求体。
  // 但 PowerShell 的 Invoke-RestMethod 在 POST 时默认会带上
  // `content-type: application/x-www-form-urlencoded`，Fastify 默认没有这个解析器，
  // 会直接返回 415 Unsupported Media Type。这里放一个兜底解析器：
  // 空 body 一律视为「没有 body」，非空 body 交回原样（JSON 接口仍由 Zod 校验拦截）。
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    return done(null, body);
  });

  // Fastify 默认的 JSON 解析器在 body 为空时报 FST_ERR_CTP_EMPTY_JSON_BODY（400）。
  // 但「无 body 的 POST + content-type: application/json」是极常见的调用姿势：
  //   curl -X POST -H "Content-Type: application/json" .../tasks/{id}/ack
  // PowerShell 7 的 Invoke-RestMethod -Method POST（不带 -Body）也会命中。
  // 这类接口本来就不需要 body，不该因为客户端多带了一个 content-type 头就报 400。
  // 这里把 JSON 解析器换成包装版：空 body 视为「没有 body」，
  // 非空 body 仍然交给 Fastify 自己的默认解析器（保留 __proto__ / constructor 防污染加固）。
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (!text) return done(null, undefined);
    return defaultJsonParser(req, text, done);
  });

  mkdirSync(config.webDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: config.webDir,
    prefix: '/',
    index: ['index.html'],
  });

  const authenticate = createAuthenticator(db, config.cookieName);

  /**
   * 路径参数里的 :id 一律是 UUID（tasks / api_tokens / users / notifications）。
   * 非法 UUID 直接透传给 Postgres 会触发 uuid 类型转换错误并冒泡成 500，
   * 调用方只会看到「服务端炸了」，完全不知道是自己参数写错了。
   * 这里统一拦成 400，并把非法值原样回显，方便定位。
   *
   * 放在 authenticate 之后：未鉴权请求先回 401，不给未认证方做输入校验的余地。
   */
  const ensureUuidParam = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const id = (req.params as Record<string, string | undefined> | undefined)?.id;
    if (id === undefined) return;
    if (!z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_argument',
          message: `路径参数 id 不是合法的 UUID：${id}`,
          details: { kind: 'uuid', param: 'id', value: id },
        },
      });
    }
  };

  // 鉴权 + 参数前置校验。所有用户级接口统一用这一串，保证 401 早于 400。
  const authHooks = [authenticate, ensureUuidParam];

  app.setErrorHandler((error: Error & { validation?: unknown; statusCode?: number }, _req, reply) => {
    if (error.validation) {
      reply.code(400).send({
        error: { code: 'invalid_argument', message: error.message },
      });
      return;
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) app.log.error(error);
    reply.code(status).send({
      error: {
        code: status === 500 ? 'internal_error' : 'request_failed',
        message: error.message || '请求失败',
      },
    });
  });

  // ---------------------------------------------------------------- 鉴权

  // 用户名 + 密码登录（Web 端主路径）
  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = z
      .object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) })
      .safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_argument', message: '请输入用户名和密码' } });
    }

    const user = await users.authenticate(body.data.username, body.data.password);
    if (!user) {
      return reply
        .code(401)
        .send({ error: { code: 'invalid_credentials', message: '用户名或密码不正确' } });
    }

    const { token, expiresAt } = await createSession(db, user.id, config.sessionTtlDays);
    reply.setCookie(config.cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      expires: expiresAt,
    });
    return { ok: true, user_id: user.id, username: user.username, display_name: user.display_name };
  });

  // 访问令牌换会话（脚本 / 自动化用；Web 端不暴露此路径）
  app.post('/api/v1/auth/token', async (req, reply) => {
    const body = z.object({ token: z.string().min(8) }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'invalid_argument', message: '缺少 token' } });
    }

    const res = await db.query<{ id: string; user_id: string; revoked_at: string | null }>(
      `select t.id, t.user_id, t.revoked_at from api_tokens t
       join users u on u.id = t.user_id
       where t.token_hash = $1 and u.is_active`,
      [hashToken(body.data.token)],
    );
    const row = res.rows[0];
    if (!row || row.revoked_at) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: '令牌无效' } });
    }

    const { token, expiresAt } = await createSession(db, row.user_id, config.sessionTtlDays);
    reply.setCookie(config.cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      expires: expiresAt,
    });
    return { ok: true, user_id: row.user_id };
  });

  // 退出登录：必须同时吊销服务端会话，不能只清 Cookie。
  // 只清 Cookie 的话，会话令牌在数据库里仍然有效——换个浏览器（或从别处拿到
  // 旧 Cookie）照样能继续用，「退出登录」就只是个界面动作。
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[config.cookieName];
    if (token) {
      await db.query(`delete from sessions where token_hash = $1`, [hashToken(token)]);
    }
    reply.clearCookie(config.cookieName, { path: '/' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- MCP over HTTP

  /**
   * 远程 MCP 端点（Streamable HTTP）。
   *
   * 为什么要有它：stdio 形态要求「AI 客户端和 MCP Server 在同一台机器上」，
   * 于是客户端机器必须装 Node、装依赖、还得有一份编译产物。
   * 有了这个端点，客户端只要填一个 URL 和一枚 Bearer 令牌，本机什么都不用装——
   * Trae / Cursor / Claude Code 都原生支持远程 HTTP MCP。
   *
   * 鉴权只认 Bearer PAT，不认会话 Cookie：
   * 会话 Cookie 是浏览器凭据，让它能调 MCP 等于把「网页里的脚本」
   * 也变成能推任务的通道；PAT 是机器凭据，只能由客户端显式配置，
   * 与 stdio 形态的语义完全一致。
   */
  const authenticatePat = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send({ error: { code: 'unauthorized', message: '需要 Bearer 访问令牌' } });
      return;
    }
    const token = header.slice(7).trim();
    const ctx = await resolvePatToken(db, token);
    if (!ctx) {
      reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send({ error: { code: 'unauthorized', message: '访问令牌无效或已吊销' } });
      return;
    }
    (req as FastifyRequest & { auth?: AuthContext }).auth = ctx;
    (req as FastifyRequest & { mcpToken?: string }).mcpToken = token;
  };

  if (config.mcpHttpEnabled) {
    const handleMcp = createMcpHttpHandler({
      // 工具回调 REST API 时走回环地址：不经过端口映射，容器内外都成立
      internalBaseUrl: `http://127.0.0.1:${config.port}`,
      defaultAgent: process.env.AI_TODO_AGENT?.trim() || 'mcp-http',
      defaultProject: process.env.AI_TODO_SOURCE_PROJECT?.trim() || undefined,
      sourceLabel: process.env.AI_TODO_SOURCE_LABEL?.trim() || undefined,
    });
    // GET / DELETE 在无状态模式下由传输层自己回 405 并说明原因，
    // 不在这里另写一套，免得两处说法不一致。
    app.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/mcp',
      preHandler: authenticatePat,
      handler: handleMcp,
    });
  }

  // ---------------------------------------------------------------- 访问令牌

  // 列出令牌（只看得到掩码，明文只在签发时给一次）
  app.get('/api/v1/tokens', { preHandler: authHooks }, async (req) => {
    const ctx = currentAuth(req);
    const res = await db.query<{
      id: string;
      name: string;
      prefix: string;
      created_at: string;
      last_used_at: string | null;
      revoked_at: string | null;
    }>(
      `select id, name, left(token_hash, 8) as prefix, created_at, last_used_at, revoked_at
       from api_tokens where user_id = $1 order by created_at desc`,
      [ctx.userId],
    );
    return { tokens: res.rows };
  });

  // 签发令牌：默认签给自己；管理员可传 user_id 替别人签
  app.post('/api/v1/tokens', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const body = z
      .object({
        name: z.string().min(1).max(120).default('mcp-client'),
        user_id: z.string().uuid().optional(),
      })
      .safeParse(req.body ?? {});

    const name = body.success ? body.data.name : 'mcp-client';
    let targetUserId = ctx.userId;

    if (body.success && body.data.user_id && body.data.user_id !== ctx.userId) {
      if (!ctx.scopes.includes('admin')) {
        return reply
          .code(403)
          .send({ error: { code: 'forbidden', message: '只能为自己签发令牌' } });
      }
      const target = await users.findById(body.data.user_id);
      if (!target) {
        return reply
          .code(404)
          .send({ error: { code: 'user_not_found', message: '用户不存在' } });
      }
      targetUserId = target.id;
    }

    const token = generateToken('ait');
    await db.query(
      `insert into api_tokens (user_id, name, token_hash, scopes) values ($1,$2,$3,$4)`,
      [targetUserId, name, hashToken(token), ['tasks:read', 'tasks:write']],
    );
    return { token, name, user_id: targetUserId, created_at: new Date().toISOString() };
  });

  // 吊销令牌（只能吊销自己的）
  app.delete<{ Params: { id: string } }>('/api/v1/tokens/:id', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const res = await db.query(
      `update api_tokens set revoked_at = now()
       where id = $1 and user_id = $2 and revoked_at is null
       returning id`,
      [req.params.id, ctx.userId],
    );
    if (!res.rows[0]) {
      return reply.code(404).send({ error: { code: 'token_not_found', message: '令牌不存在' } });
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- 用户管理（管理员）

  app.get('/api/v1/admin/users', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    if (!ctx.scopes.includes('admin')) {
      return reply.code(403).send({ error: { code: 'forbidden', message: '需要 admin 权限' } });
    }
    const list = await users.listUsers();
    return { users: list };
  });

  app.post('/api/v1/admin/users', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    if (!ctx.scopes.includes('admin')) {
      return reply.code(403).send({ error: { code: 'forbidden', message: '需要 admin 权限' } });
    }

    const body = z
      .object({
        username: z.string().min(3).max(32),
        password: z.string().min(8).max(200).optional(),
        display_name: z.string().max(120).optional(),
        is_admin: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});

    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'invalid_argument', message: body.error.issues[0]?.message ?? '参数不合法' },
      });
    }
    if (!isValidUsername(body.data.username)) {
      return reply.code(400).send({
        error: { code: 'invalid_argument', message: '用户名只允许 3–32 位小写字母、数字、. _ -' },
      });
    }

    // 不指定密码就随机生成，初始密码只显示这一次
    const password = body.data.password ?? generatePassword(20);
    let user;
    try {
      user = await users.createUser({
        username: body.data.username,
        password,
        displayName: body.data.display_name ?? null,
        isAdmin: body.data.is_admin ?? false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: { code: 'invalid_argument', message } });
    }

    // 同时签发一枚 PAT，省得用户再自己走一遍
    const token = generateToken('ait');
    await db.query(
      `insert into api_tokens (user_id, name, token_hash, scopes) values ($1,$2,$3,$4)`,
      [user.id, 'initial', hashToken(token), ['tasks:read', 'tasks:write']],
    );

    return reply.code(201).send({
      user,
      password,
      token,
      notice: '初始密码与访问令牌只显示这一次，请立即保存。',
    });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/v1/admin/users/:id',
    { preHandler: authHooks },
    async (req, reply) => {
      const ctx = currentAuth(req);
      if (!ctx.scopes.includes('admin')) {
        return reply.code(403).send({ error: { code: 'forbidden', message: '需要 admin 权限' } });
      }

      const body = z
        .object({
          is_active: z.boolean().optional(),
          is_admin: z.boolean().optional(),
          password: z.string().min(8).max(200).optional(),
          display_name: z.string().max(120).nullable().optional(),
        })
        .safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: { code: 'invalid_argument', message: '参数不合法' } });
      }

      const target = await users.findById(req.params.id);
      if (!target) {
        return reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在' } });
      }

      const p = body.data;
      if (p.is_active !== undefined) await users.setActive(target.id, p.is_active);
      if (p.is_admin !== undefined) await users.setAdmin(target.id, p.is_admin);
      if (p.display_name !== undefined) await users.setDisplayName(target.id, p.display_name);

      let newPassword: string | null = null;
      if (p.password !== undefined) {
        newPassword = p.password;
        await users.setPassword(target.id, p.password);
      }

      const updated = await users.findById(target.id);
      return { user: updated, password: newPassword };
    },
  );

  // 删除账号（管理员）
  app.delete<{ Params: { id: string } }>(
    '/api/v1/admin/users/:id',
    { preHandler: authHooks },
    async (req, reply) => {
      const ctx = currentAuth(req);
      if (!ctx.scopes.includes('admin')) {
        return reply.code(403).send({ error: { code: 'forbidden', message: '需要 admin 权限' } });
      }
      if (req.params.id === ctx.userId) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_argument', message: '不能删除自己' } });
      }
      const target = await users.findById(req.params.id);
      if (!target) {
        return reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在' } });
      }
      // tasks / sessions / api_tokens 都是 on delete cascade
      await db.query(`delete from users where id = $1`, [req.params.id]);
      return { ok: true };
    },
  );

  // 管理员替某个用户签发令牌
  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/users/:id/tokens',
    { preHandler: authHooks },
    async (req, reply) => {
      const ctx = currentAuth(req);
      if (!ctx.scopes.includes('admin')) {
        return reply.code(403).send({ error: { code: 'forbidden', message: '需要 admin 权限' } });
      }
      const target = await users.findById(req.params.id);
      if (!target) {
        return reply.code(404).send({ error: { code: 'user_not_found', message: '用户不存在' } });
      }
      const body = z
        .object({ name: z.string().min(1).max(120).default('mcp-client') })
        .safeParse(req.body ?? {});
      const name = body.success ? body.data.name : 'mcp-client';

      const token = generateToken('ait');
      await db.query(
        `insert into api_tokens (user_id, name, token_hash, scopes) values ($1,$2,$3,$4)`,
        [target.id, name, hashToken(token), ['tasks:read', 'tasks:write']],
      );
      return { token, name, user_id: target.id, created_at: new Date().toISOString() };
    },
  );

  // ---------------------------------------------------------------- 令牌
  // 令牌签发/吊销见下方「访问令牌」区块（/api/v1/tokens），管理员可替别人签发。

  // ---------------------------------------------------------------- 任务

  app.post('/api/v1/tasks', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_argument', message: parsed.error.issues[0]?.message ?? '参数不合法' },
      });
    }
    const input = parsed.data;

    let sourceId: string | null = null;
    if (input.source?.session_key) {
      const source = await tasks.ensureSource(
        ctx.userId,
        input.source.agent ?? 'unknown',
        input.source.session_key,
        input.source.label ?? null,
      );
      sourceId = source.id;
    }

    const result = await tasks.createTask({
      userId: ctx.userId,
      title: input.title,
      detail: input.detail ?? null,
      severity: input.severity,
      project: input.project ?? null,
      links: input.links ?? [],
      sourceId,
      idempotencyKey: input.idempotency_key ?? null,
      notifyRequested: input.notify ?? true,
      dueAt: input.due_at ?? null,
    });

    if (result.created) {
      await orchestrator.onTaskCreated(result.task);
    }

    return reply.code(result.created ? 201 : 200).send({
      task: result.task,
      created: result.created,
    });
  });

  app.get('/api/v1/tasks', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const q = req.query as Record<string, string | undefined>;

    // 查询参数先做白名单校验：非法枚举值若直接透传给 Postgres 会触发枚举转换错误，
    // 在这里拦住并返回 400，而不是让调用方拿到一个含义不明的 500。
    const status = parseEnumFilter(q.status, TASK_STATUSES, 'status');
    if (status.error) return reply.code(400).send(status.error);
    const severity = parseEnumFilter(q.severity, TASK_SEVERITIES, 'severity');
    if (severity.error) return reply.code(400).send(severity.error);

    const list = await tasks.listTasks(ctx.userId, {
      status: status.values as TaskStatus[] | undefined,
      severity: severity.values as TaskSeverity[] | undefined,
      project: q.project,
      source: q.source?.trim() || undefined,
      q: q.q,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    return { tasks: list };
  });

  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const task = await tasks.getTask(ctx.userId, req.params.id);
    if (!task) {
      return reply.code(404).send({ error: { code: 'task_not_found', message: '任务不存在' } });
    }
    return { task };
  });

  app.patch<{ Params: { id: string } }>('/api/v1/tasks/:id', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const parsed = updateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_argument', message: '参数不合法' } });
    }
    const p = parsed.data;
    const task = await tasks.updateTask(ctx.userId, req.params.id, {
      title: p.title,
      detail: p.detail,
      severity: p.severity,
      project: p.project,
      links: p.links,
      notifyRequested: p.notify,
      dueAt: p.due_at,
    });
    if (!task) {
      return reply.code(404).send({ error: { code: 'task_not_found', message: '任务不存在' } });
    }
    return { task };
  });

  const statusRoute = (status: TaskStatus) => {
    return async (req: FastifyRequest & { params: { id: string } }, reply: any) => {
      const ctx = currentAuth(req);
      const task = await tasks.setStatus(ctx.userId, req.params.id, status);
      if (!task) {
        return reply.code(404).send({ error: { code: 'task_not_found', message: '任务不存在' } });
      }
      return { task };
    };
  };

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/ack', { preHandler: authHooks }, statusRoute('acked'));
  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/done', { preHandler: authHooks }, statusRoute('done'));
  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/archive', { preHandler: authHooks }, statusRoute('archived'));

  /**
   * 清空已归档（批量彻底删除）。
   *
   * 静态段路由优先于 `/tasks/:id`，所以 `/tasks/archived` 不会被当成 id。
   * 只清**当前用户自己**的已归档任务；未归档的任务一个都不动。
   */
  app.delete('/api/v1/tasks/archived', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const deleted = await tasks.purgeArchived(ctx.userId);
    return { deleted };
  });

  /**
   * 彻底删除（不可恢复）。
   *
   * 与 `POST /tasks/:id/archive`（软删除）的分工：
   * - 未归档的任务 → 只能归档，删了还能在「全部」标签里找回；
   * - 已归档的任务 → 允许彻底删除，否则回收站永远清不空。
   *
   * 跨用户访问一律 404（不泄露任务是否存在），与其它任务接口保持一致。
   */
  app.delete<{ Params: { id: string } }>('/api/v1/tasks/:id', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const task = await tasks.getTask(ctx.userId, req.params.id);
    if (!task) {
      return reply.code(404).send({ error: { code: 'task_not_found', message: '任务不存在' } });
    }
    if (task.status !== 'archived') {
      return reply
        .code(409)
        .send({ error: { code: 'task_not_archived', message: '只能彻底删除已归档的任务，请先删除（归档）' } });
    }
    const deleted = await tasks.hardDelete(ctx.userId, req.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: 'task_not_found', message: '任务不存在' } });
    }
    return { deleted: true, id: deleted.id };
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/snooze', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const parsed = z.object({ until: z.string().min(4) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_argument', message: '缺少 until' } });
    }
    const until = new Date(parsed.data.until);
    if (Number.isNaN(until.getTime())) {
      return reply.code(400).send({ error: { code: 'invalid_argument', message: 'until 不是合法时间' } });
    }
    const task = await tasks.snooze(ctx.userId, req.params.id, until.toISOString());
    if (!task) {
      return reply.code(404).send({ error: { code: 'task_not_found', message: '任务不存在' } });
    }
    return { task };
  });

  // ---------------------------------------------------------------- 通知

  app.get('/api/v1/notifications', { preHandler: authHooks }, async (req) => {
    const ctx = currentAuth(req);
    const q = req.query as { limit?: string };
    return { notifications: await tasks.listNotifications(ctx.userId, q.limit ? Number(q.limit) : 50) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/notifications/:id/read', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    await tasks.markNotificationRead(ctx.userId, req.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- 规则

  app.get('/api/v1/rules', { preHandler: authHooks }, async (req) => {
    const ctx = currentAuth(req);
    return { rules: await tasks.getRules(ctx.userId) };
  });

  app.put('/api/v1/rules', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);
    const parsed = rulesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_argument', message: '参数不合法' } });
    }
    const p = parsed.data;
    const rules = await tasks.updateRules(ctx.userId, {
      min_severity: p.min_severity,
      quiet_hours: p.quiet_hours,
      cooldown_sec: p.cooldown_sec,
      group_by: p.group_by as GroupBy | undefined,
      digest_hour: p.digest_hour,
    });
    return { rules };
  });

  // ---------------------------------------------------------------- 元信息

  app.get('/api/v1/me', { preHandler: authHooks }, async (req) => {
    const ctx = currentAuth(req);
    const [rules, pending, archived, sources, user] = await Promise.all([
      tasks.getRules(ctx.userId),
      tasks.countPending(ctx.userId),
      tasks.countArchived(ctx.userId),
      tasks.listSources(ctx.userId),
      users.findById(ctx.userId),
    ]);
    return {
      user_id: ctx.userId,
      username: user?.username ?? null,
      display_name: user?.display_name ?? null,
      is_admin: ctx.scopes.includes('admin'),
      pending,
      archived,
      rules,
      sources,
      live_clients: bus.clientCount(ctx.userId),
      config: {
        quiet_hours_enabled: rules.quiet_hours !== null,
        digest_hour: rules.digest_hour,
      },
    };
  });

  app.get('/api/v1/health', async () => ({ ok: true, driver: db.driver }));

  // ---------------------------------------------------------------- SSE

  app.get('/api/v1/stream', { preHandler: authHooks }, async (req, reply) => {
    const ctx = currentAuth(req);

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');

    const client = {
      send: (event: { type: string; data: unknown }) => {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      },
      close: () => {
        try {
          reply.raw.end();
        } catch {
          /* ignore */
        }
      },
    };

    const off = bus.add(ctx.userId, client);
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25_000);
    heartbeat.unref?.();

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      off();
    });
  });

  // ---------------------------------------------------------------- SPA 回退

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: '接口不存在' } });
    }
    return reply.sendFile('index.html');
  });

  return app;
}

/**
 * 引导凭据文件管理：
 * - data/admin-credentials.txt：管理员用户名、初始密码（仅创建时写入）、一枚 PAT
 *
 * 明文只写一次，服务端数据库仅存哈希。
 */
export async function ensureBootstrapCredentials(
  db: Db,
  config: Config,
  users: UserService,
): Promise<{
  adminUser: { id: string; username: string | null };
  adminToken: string;
  created: boolean;
  password: string | null;
}> {
  mkdirSync(config.dataDir, { recursive: true });
  const file = join(config.dataDir, 'admin-credentials.txt');

  const { user, created, password } = await users.ensureBootstrapAdmin();

  // 已有凭据文件且令牌仍然有效 → 原样复用，不覆盖已保存的密码
  let existingToken: string | null = null;
  let existingPassword: string | null = null;
  try {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'token') existingToken = value;
      if (key === 'password') existingPassword = value;
    }
  } catch {
    /* 文件不存在则新建 */
  }

  let adminToken = existingToken;
  if (adminToken) {
    const res = await db.query<{ revoked_at: string | null }>(
      `select revoked_at from api_tokens where token_hash = $1`,
      [hashToken(adminToken)],
    );
    if (!res.rows[0] || res.rows[0].revoked_at) adminToken = null;
  }

  // 老库迁移：复用 v1 的 data/admin-token.txt，避免让用户重新配一遍
  if (!adminToken) {
    const legacyFile = join(config.dataDir, 'admin-token.txt');
    try {
      const { readFileSync } = await import('node:fs');
      const legacy = readFileSync(legacyFile, 'utf8').trim();
      if (legacy) {
        const res = await db.query<{ revoked_at: string | null }>(
          `select revoked_at from api_tokens where token_hash = $1`,
          [hashToken(legacy)],
        );
        if (res.rows[0] && !res.rows[0].revoked_at) adminToken = legacy;
      }
    } catch {
      /* 老文件不存在则新建 */
    }
  }

  if (!adminToken) {
    adminToken = generateToken('ait');
    await db.query(
      `insert into api_tokens (user_id, name, token_hash, scopes) values ($1,$2,$3,$4)`,
      [user.id, 'bootstrap (admin)', hashToken(adminToken), ['admin', 'tasks:read', 'tasks:write']],
    );
  }

  const lines = [
    `# AI Todo 管理员凭据（明文只保留在这里，数据库仅存哈希）`,
    `username=${user.username}`,
  ];
  if (password ?? existingPassword) lines.push(`password=${password ?? existingPassword}`);
  lines.push(`token=${adminToken}`);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  return {
    adminUser: { id: user.id, username: user.username },
    adminToken,
    created,
    password: password ?? existingPassword,
  };
}

export function newRequestId(): string {
  return randomUUID();
}
