import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 解析包根目录：从当前模块向上找到 package.json。
 * 编译产物位于 dist/src/**，因此固定向上三级再兜底。
 */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export const packageRoot = findPackageRoot();

export function loadDotEnv(): void {
  const file = join(packageRoot, '.env');
  if (!existsSync(file)) return;
  // 极简解析：KEY=VALUE，支持 # 注释与成对引号
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * 微信登录模式：
 * - qrconnect：微信开放平台「网站应用」扫码登录（桌面体验最好，需企业主体 + ICP 备案）
 * - official：公众号网页授权（需已认证公众号，授权页必须在微信里打开）
 *
 * 两条路线的换 token 接口完全一样（sns/oauth2/access_token），
 * 差别只在授权地址与 scope，所以服务端只实现一次，模式由配置切换。
 */
export type WechatMode = 'qrconnect' | 'official';

export interface WechatConfig {
  /** 是否启用微信登录（配齐 AppID/Secret，或打开模拟模式） */
  enabled: boolean;
  mode: WechatMode;
  appId: string;
  appSecret: string;
  /** 回调地址：必须是微信后台登记过的域名下的地址 */
  redirectUri: string;
  /** 管理员 openid 白名单：逗号分隔 */
  adminOpenids: string[];
  /** 首次微信登录时自动签发一枚 MCP 访问令牌 */
  autoIssueToken: boolean;
  /** 模拟模式：不连微信官方接口，用本地假 code 跑通整条链路 */
  mock: boolean;
}

export interface MailConfig {
  /** SMTP 配齐 host 时启用；未启用时发信降级为日志 */
  enabled: boolean;
  host: string;
  port: number;
  /** 465 为 true（隐式 TLS），587 等为 false（STARTTLS） */
  secure: boolean;
  user: string;
  /** 认证凭据：授权码（QQ/163 等云邮箱）或密码，走 nodemailer 的 auth.pass */
  pass: string;
  /**
   * 发件人。address 保证是合法邮箱——QQ 等服务商在 MAIL FROM 阶段就校验
   * 地址格式与账号归属，带中文引号 / 残缺显示名的原始串会被直接拒收（502）。
   */
  from: { name: string; address: string };
}

export interface Config {
  port: number;
  host: string;
  baseUrl: string;
  databaseUrl?: string;
  pgliteDir: string;
  dataDir: string;
  webDir: string;
  cookieName: string;
  sessionTtlDays: number;
  logLevel: string;
  /** 远程 MCP 端点（/mcp）是否开启 */
  mcpHttpEnabled: boolean;
  /** 保留给未来的外部通道（配置 B）；配置 A 下始终为空 */
  externalChannels: string[];
  wechat: WechatConfig;
  mail: MailConfig;
}

export function loadConfig(): Config {
  loadDotEnv();

  // 端口：AI_TODO_PORT 优先；云平台（Cloudfoundry/xPaas 等）惯例注入 PORT，作兜底。
  // 平台可能注入非数字的 PORT（如 K8s 风格 tcp://ip:port），必须严格校验，
  // 否则 Number() 得到 NaN，Fastify 启动即抛 options.port should be >= 0 and < 65536。
  const parsePort = (raw: string | undefined): number | undefined => {
    const v = raw?.trim();
    if (!v || !/^\d+$/.test(v)) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n < 65536 ? n : undefined;
  };
  const port = parsePort(process.env.AI_TODO_PORT) ?? parsePort(process.env.PORT) ?? 8787;
  if (
    port === 8787 &&
    (process.env.AI_TODO_PORT !== undefined || process.env.PORT !== undefined)
  ) {
    console.warn(
      `[config] AI_TODO_PORT/PORT 不是有效的端口号（AI_TODO_PORT=${JSON.stringify(process.env.AI_TODO_PORT)}，PORT=${JSON.stringify(process.env.PORT)}），已回退到默认端口 8787`,
    );
  }
  const host = process.env.AI_TODO_HOST ?? '127.0.0.1';
  const dataDir = resolve(packageRoot, process.env.AI_TODO_DATA_DIR ?? 'data');
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const baseUrl = process.env.AI_TODO_BASE_URL ?? `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

  // 微信登录：凭据只从环境变量读，代码里不写死任何 AppID / Secret。
  const wechatAppId = process.env.AI_TODO_WECHAT_APPID?.trim() || '';
  const wechatAppSecret = process.env.AI_TODO_WECHAT_SECRET?.trim() || '';
  const wechatMock =
    (process.env.AI_TODO_WECHAT_MOCK ?? 'off').trim().toLowerCase() === 'on';
  const wechatMode: WechatMode =
    (process.env.AI_TODO_WECHAT_MODE ?? 'qrconnect').trim().toLowerCase() === 'official'
      ? 'official'
      : 'qrconnect';
  const wechatRedirectUri =
    process.env.AI_TODO_WECHAT_REDIRECT_URI?.trim() || `${baseUrl}/api/v1/auth/wechat/callback`;
  const wechatAdminOpenids = (process.env.AI_TODO_WECHAT_ADMIN_OPENIDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 邮件：配了 SMTP_HOST 即启用；没配则降级为日志模式（本地开发不用配）
  const mailHost = process.env.AI_TODO_SMTP_HOST?.trim() || '';
  const mailPort = Number(process.env.AI_TODO_SMTP_PORT ?? 465);
  // 显式 on/off 优先；空 / 未设时按端口推断（465 隐式 TLS，其余明文 + STARTTLS）
  const mailSecure = process.env.AI_TODO_SMTP_SECURE?.trim() || '';
  const mail: MailConfig = {
    enabled: mailHost !== '',
    host: mailHost,
    port: mailPort,
    secure: (mailSecure || (mailPort === 465 ? 'on' : 'off')).toLowerCase() === 'on',
    user: process.env.AI_TODO_SMTP_USER?.trim() || '',
    // 凭据二选一：AI_TODO_SMTP_AUTH_CODE（授权码，推荐）优先于 AI_TODO_SMTP_PASS。
    // QQ / 163 / Gmail 等云邮箱要求用「授权码」而非登录密码，值里可能含空格，
    // 统一去掉首尾空白（授权码中间的空格不受影响）。
    pass: (process.env.AI_TODO_SMTP_AUTH_CODE ?? process.env.AI_TODO_SMTP_PASS ?? '').trim(),
    // 发件人规整：FROM 里可能写「显示名 <地址>」、纯地址，也可能手滑带中文引号。
    // 一律拆出地址；地址不合法则回落 SMTP_USER，还不行才用 no-reply@localhost。
    // QQ SMTP 要求 MAIL FROM 必须是认证账号本身，所以回落顺序不能反。
    from: (() => {
      const smtpUser = process.env.AI_TODO_SMTP_USER?.trim() || '';
      const fromRaw = process.env.AI_TODO_SMTP_FROM?.trim() || '';
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test.bind(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      const m = fromRaw.match(/<([^<>]*)>/);
      const addr = (m ? m[1] : fromRaw).trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '');
      const name = m
        ? fromRaw.slice(0, m.index).trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '')
        : '';
      return {
        name,
        address: isEmail(addr) ? addr : isEmail(smtpUser) ? smtpUser : 'no-reply@localhost',
      };
    })(),
  };

  return {
    port,
    host,
    baseUrl,
    databaseUrl,
    pgliteDir: resolve(dataDir, 'pgdata'),
    dataDir,
    // Vue 前端的构建产物（frontend/ 经 Vite 构建得到）。
    // 旧目录 web/ 已由 frontend/ 取代；Docker 里仍是 /app/web（镜像内路径不变）。
    webDir: resolve(packageRoot, process.env.AI_TODO_WEB_DIR ?? 'frontend/dist'),
    cookieName: 'ai_todo_session',
    sessionTtlDays: Number(process.env.AI_TODO_SESSION_TTL_DAYS ?? 30),
    logLevel: process.env.AI_TODO_LOG_LEVEL ?? 'info',
    mcpHttpEnabled: (process.env.AI_TODO_MCP_HTTP ?? 'on').trim().toLowerCase() !== 'off',
    externalChannels: [],
    wechat: {
      // 配齐真实凭据才算启用；模拟模式只在显式打开时生效
      enabled: (wechatAppId !== '' && wechatAppSecret !== '') || wechatMock,
      mode: wechatMode,
      appId: wechatAppId,
      appSecret: wechatAppSecret,
      redirectUri: wechatRedirectUri,
      adminOpenids: wechatAdminOpenids,
      autoIssueToken:
        (process.env.AI_TODO_WECHAT_AUTO_TOKEN ?? 'on').trim().toLowerCase() !== 'off',
      mock: wechatMock,
    },
    mail,
  };
}
