import { createHash } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createMcpServer } from './server.js';

export interface McpHttpOptions {
  /**
   * MCP 工具回调 REST API 时使用的地址。
   * 指向服务自己（回环地址）即可——不经过端口映射，容器内外都成立。
   */
  internalBaseUrl: string;
  /** 默认来源标识。客户端可用 X-Ai-Todo-Agent 头覆盖。 */
  defaultAgent: string;
  /** 默认来源项目。客户端可用 X-Ai-Todo-Project 头覆盖。 */
  defaultProject?: string;
  sourceLabel?: string;
}

/** 客户端自报的来源标识：只允许一小段安全字符，避免任意文本进库 */
const AGENT_PATTERN = /^[A-Za-z0-9._-]{1,60}$/;

/** 来源项目：允许中文、空格、斜杠、@ 等常见项目名，但仍有长度上限 */
const PROJECT_PATTERN = /^[\w.\-/@ ]{1,120}$/;

/**
 * 同一枚令牌 → 同一个 session key。
 *
 * 默认幂等键是 `agent:session:标题哈希`。session key 如果每次请求都变，
 * 同一个客户端连推两次同名任务就会被当成两条不同任务各记一条——
 * 幂等就形同虚设了。这里用令牌哈希做种子，稳定又不泄露令牌本身。
 */
function sessionKeyForToken(token: string): string {
  return `http-${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

function normalizeAgent(raw: string | string[] | undefined, fallback: string): string {
  const value = headerValue(raw);
  if (value && AGENT_PATTERN.test(value)) return value;
  return fallback;
}

function normalizeProject(raw: string | string[] | undefined, fallback?: string): string | undefined {
  const value = headerValue(raw);
  if (value && PROJECT_PATTERN.test(value)) return value;
  return fallback;
}

/**
 * 把 Fastify 请求转成 Web 标准 Request。
 *
 * body 已经被 Fastify 解析成对象了，这里重新序列化。
 * 原始的 content-length / content-encoding 必须去掉——
 * 重新序列化后的长度可能和原来不一样，留着会和实际长度打架。
 */
function toWebRequest(req: FastifyRequest): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
  }

  // 规范要求客户端同时声明接受 application/json 与 text/event-stream。
  // 少写了就替他补上——这个端点只说 JSON-RPC，不存在内容协商歧义。
  const accept = headers.get('accept') ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    headers.set('accept', 'application/json, text/event-stream');
  }
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('host');

  const method = req.method.toUpperCase();
  const carriesBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
  const body = carriesBody && req.body !== undefined ? JSON.stringify(req.body) : undefined;

  return new Request('http://mcp.local/mcp', { method, headers, body });
}

/**
 * MCP over Streamable HTTP。
 *
 * 存在的理由：stdio 形态要求「AI 客户端和 MCP Server 在同一台机器上」，
 * 于是客户端机器必须装 Node、装依赖、还得有一份编译产物。
 * 有了这个端点，客户端只要填一个 URL 和一枚 Bearer 令牌，本机什么都不用装——
 * Trae / Cursor / Claude Code 都原生支持远程 HTTP MCP。
 *
 * 形态选择：
 * - **无状态**（不生成 session id）：每个 HTTP 请求独立处理，服务端不留会话状态。
 *   多实例、重启都不影响，也不用维护会话表。
 * - **单次 JSON 响应**（enableJsonResponse）：不挂 SSE 长连接，
 *   请求结束连接就结束，代理和防火墙都友好。
 */
export function createMcpHttpHandler(opts: McpHttpOptions) {
  return async function handleMcpHttp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = (req as FastifyRequest & { mcpToken?: string }).mcpToken;
    if (!token) {
      // 正常情况下鉴权中间件已经拦下了，这里只是兜底。
      reply.code(401).send({ error: { code: 'unauthorized', message: '需要 Bearer 访问令牌' } });
      return;
    }

    // 无状态模式不支持 SSE 订阅流，也不支持会话终止：
    // GET 按规范应当回 405（客户端据此认定「服务端不发起服务端侧消息」）。
    // 交给传输层处理会挂起一条常驻 SSE 连接一直不返回——所以自己拦掉。
    if (req.method === 'GET' || req.method === 'DELETE') {
      reply
        .code(405)
        .header('allow', 'POST')
        .send({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message:
              'Method Not Allowed：本端点为无状态实现，只接受 POST（单次 JSON-RPC 请求）。',
          },
          id: null,
        });
      return;
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态模式
      enableJsonResponse: true, // 单次 JSON 响应，不留 SSE 长连接
    });

    const server = createMcpServer({
      baseUrl: opts.internalBaseUrl,
      token,
      sessionKey: sessionKeyForToken(token),
      agent: normalizeAgent(req.headers['x-ai-todo-agent'], opts.defaultAgent),
      sourceProject: normalizeProject(req.headers['x-ai-todo-project'], opts.defaultProject),
      sourceLabel: opts.sourceLabel,
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(toWebRequest(req));
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      return reply.send(Buffer.from(await response.arrayBuffer()));
    } finally {
      // 每个请求一套 server + transport，用完即弃，不能攒着。
      await server.close().catch(() => {
        /* ignore */
      });
    }
  };
}
