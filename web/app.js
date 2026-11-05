/* AI Todo · 桌面 Web 前端（配置 A：浏览器系统级通知 + 未读列表） */

import { t, setLocale, getLocale, applyI18n, LOCALES } from './i18n.js';
import { qrSvg } from './qr.js';

const state = {
  tasks: [],
  status: 'pending',
  severity: '',
  source: '',
  q: '',
  selectedId: null,
  sources: new Map(),
  rules: null,
  me: null,
  es: null,
  drawerMode: null,
  lastToken: null,
  /** 当前视图：任务列表 / 用户管理 / 令牌管理 */
  view: 'tasks',
  /** 全体有效账号（转交任务时的选人下拉） */
  users: [],
  /** 最近一次创建账号拿到的初始凭据，只在当前页面显示一次 */
  freshUserCredentials: null,
  /** 服务端支持的登录方式 */
  wechat: { enabled: false, mode: 'qrconnect', mock: false },
};

const $ = (id) => document.getElementById(id);
const api = {
  async call(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null; // 非 JSON 的错误页，按状态码兜底
      }
    }
    if (!res.ok) {
      const err = new Error(data?.error?.message || `HTTP ${res.status}`);
      // 把服务端的错误码带出来：界面按 code 翻译，不依赖服务端文案。
      // 401 也要带 code——登录接口的错误密码正是 401，
      // 早先在这里直接抛 'unauthorized'，界面只能显示一个英文单词。
      err.code = data?.error?.code || '';
      err.details = data?.error?.details || null;
      if (res.status === 401) {
        err.code = err.code || 'unauthorized';
        showLogin();
      }
      throw err;
    }
    return data;
  },
  get(p) { return api.call('GET', p); },
  post(p, b) { return api.call('POST', p, b); },
  patch(p, b) { return api.call('PATCH', p, b); },
  put(p, b) { return api.call('PUT', p, b); },
  del(p) { return api.call('DELETE', p); },
};

/**
 * 把服务端错误翻成当前语言的文案。
 *
 * 服务端给的是稳定的 error code + 中文 message；界面按 code 查字典，
 * 查不到才退回服务端 message（至少不会显示成一串错误码）。
 */
function translateError(err) {
  if (!err) return '';
  const code = err.code;
  if (code) {
    if (code === 'invalid_argument' && err.details?.kind === 'enum') {
      return t('error.invalid_argument.enum', err.details);
    }
    if (code === 'invalid_argument' && err.details?.kind === 'uuid') {
      return t('error.invalid_argument.uuid', err.details);
    }
    const key = `error.${code}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return err.message || '';
}

/* ---------------------------------------------------------------- 提示 */

function toast(message, isError = false, ms = isError ? 4200 : 2400) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = message;
  $('toast-wrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

/* ---------------------------------------------------------------- 当前用户 */

function renderUser() {
  const me = state.me || {};
  const name = me.username || me.display_name || '';
  const chip = $('btn-user');
  if (!name) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  $('user-name').textContent = name;
  $('user-avatar').textContent = name.slice(0, 1);
  $('dd-name').textContent = name;
  $('dd-role').textContent = me.is_admin ? t('status.roleAdmin') : t('status.roleUser');
  // 用户管理是管理员专属入口：不是管理员就直接藏起来
  $('dd-users').hidden = !me.is_admin;
}

function setUserMenu(open) {
  $('user-dropdown').hidden = !open;
  $('btn-user').setAttribute('aria-expanded', String(open));
}

function closeUserMenu() {
  setUserMenu(false);
}

async function doLogout() {
  closeUserMenu();
  try {
    await api.post('/api/v1/auth/logout');
  } catch {
    /* 忽略：本地照样回到登录页 */
  }
  showLogin();
}

$('btn-user').addEventListener('click', (e) => {
  e.stopPropagation();
  setUserMenu($('user-dropdown').hidden);
});
$('dd-account').addEventListener('click', () => {
  closeUserMenu();
  openDrawer('settings');
});
$('dd-tokens').addEventListener('click', () => {
  closeUserMenu();
  setView('tokens');
});
$('dd-users').addEventListener('click', () => {
  closeUserMenu();
  setView('users');
});
$('dd-logout').addEventListener('click', () => {
  doLogout();
});
// 点菜单外面或按 Esc 收起
document.addEventListener('click', (e) => {
  if (!$('user-menu').contains(e.target)) closeUserMenu();
});

/* ---------------------------------------------------------------- 登录 */

/**
 * 登录页整个从文档里摘掉，而不是只 hidden。
 *
 * 原因：登录表单里有 password 输入框。浏览器工具一旦读到「容器里含密码框」，
 * 就会判定需要人工接管认证，把当前会话的所有工具（含终端）一起锁死，
 * 只能靠新开一轮对话恢复。把它从文档里摘掉，这颗雷就拆了。
 *
 * 元素对象本身留着——所有事件监听器都挂在它身上，摘下来并不会丢；
 * 退出登录时再按原位插回去即可（用注释节点当锚点，保证回到原来的位置）。
 */
const loginScreen = $('login');
const loginAnchor = document.createComment('login-screen');
loginScreen.parentNode.insertBefore(loginAnchor, loginScreen);

function detachLogin() {
  if (loginScreen.isConnected) loginScreen.remove();
}

function attachLogin() {
  if (!loginScreen.isConnected) {
    loginAnchor.parentNode.insertBefore(loginScreen, loginAnchor);
  }
}

/** 从登录态切进主界面：登录页顺手从文档里摘掉。 */
function enterApp() {
  loginScreen.hidden = true;
  detachLogin();
  $('app').hidden = false;
  // 上个会话可能停在管理页面里，重新登录一律回到任务列表
  setView('tasks');
}

function showLogin() {
  attachLogin();
  loginScreen.hidden = false;
  $('app').hidden = true;
  // 摘掉的这段时间里语言可能变过，插回来要重新套一遍静态文案
  applyI18n(loginScreen);
  if (state.es) { state.es.close(); state.es = null; }
  closeUserMenu();
  setLive('down', t('topbar.offline'));
}

async function tryLogin() {
  try {
    await api.get('/api/v1/me');
    enterApp();
    await bootstrap();
  } catch {
    /* 401 已在 showLogin 处理 */
  }
}

// 密码框的显示 / 隐藏切换
$('login-password-toggle').addEventListener('click', () => {
  const input = $('login-password');
  const btn = $('login-password-toggle');
  const shown = input.type === 'text';
  input.type = shown ? 'password' : 'text';
  btn.classList.toggle('is-visible', !shown);
  btn.setAttribute('aria-pressed', String(!shown));
  const label = shown ? t('login.showPassword') : t('login.hidePassword');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  input.focus();
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const err = $('login-error');
  const submit = $('login-submit');
  err.hidden = true;
  // 提交期间锁住按钮：避免重复点击打多次登录请求
  submit.disabled = true;
  submit.classList.add('is-loading');
  try {
    await api.post('/api/v1/auth/login', { username, password });
    $('login-password').value = '';
    $('login-password').type = 'password';
    $('login-password-toggle').classList.remove('is-visible');
    $('login-password-toggle').setAttribute('aria-pressed', 'false');
    $('login-password-toggle').setAttribute('aria-label', t('login.showPassword'));
    $('login-password-toggle').title = t('login.showPassword');
    enterApp();
    await bootstrap();
  } catch (err2) {
    const msg =
      err2.code === 'unauthorized' || err2.code === 'invalid_credentials'
        ? t('login.invalidCredentials')
        : translateError(err2);
    // 登录页还挂在文档里 → 错误显示在表单下方（密码错误就是这种情况）；
    // 已经摘掉了 → 说明是登录成功后的初始化出错，改用全局提示
    if (loginScreen.isConnected) {
      err.textContent = msg;
      err.hidden = false;
    } else {
      toast(msg, true);
    }
  } finally {
    submit.disabled = false;
    submit.classList.remove('is-loading');
  }
});

/* ---------------------------------------------------------------- 微信登录 */

/**
 * 扫码登录的轮询定时器。
 * 用递归 setTimeout 而不是 setInterval：请求慢的时候不会攒下一堆并发请求。
 */
let wechatTimer = null;

function stopWechatPoll() {
  if (wechatTimer) {
    clearTimeout(wechatTimer);
    wechatTimer = null;
  }
}

/**
 * 把二维码画进容器。
 * SVG 由本地 qr.js 生成，不是外部内容；但仍然用 DOMParser 解析后 importNode
 * 插入，不走 innerHTML——这条规矩在这个项目里是硬的。
 */
function renderQr(host, text) {
  host.textContent = '';
  let ok = false;
  try {
    const svg = qrSvg(text, { ecc: 'M' });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    if (root && root.nodeName !== 'parsererror') {
      host.appendChild(document.importNode(root, true));
      ok = true;
    }
  } catch {
    /* 落到下面的兜底 */
  }

  // 二维码画不出来时至少留个能点开的链接，不至于把人堵死
  const link = document.createElement('a');
  link.className = 'qr-link';
  link.href = text;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = ok ? t('login.wechatOpenLink') : t('login.wechatQrFailed');
  host.appendChild(link);
}

/** 服务端支持哪些登录方式：没配 AppID 时登录页不显示微信入口 */
async function loadAuthProviders() {
  try {
    const res = await api.get('/api/v1/auth/providers');
    state.wechat = res.wechat || { enabled: false };
  } catch {
    state.wechat = { enabled: false };
  }
  const on = !!state.wechat.enabled;
  $('login-wechat').hidden = !on;
  $('login-wechat-sep').hidden = !on;
  if (!on) $('login-wechat-panel').hidden = true;
}

function showLoginError(msg) {
  const err = $('login-error');
  err.textContent = msg;
  err.hidden = false;
}

/** 发起扫码：拿到授权地址后画成二维码，再轮询结果 */
async function startWechatLogin() {
  $('login-error').hidden = true;
  try {
    const res = await api.get('/api/v1/auth/wechat/start');
    $('login-wechat-panel').hidden = false;
    $('login-wechat-tip').textContent = t('login.wechatScanTip');
    renderQr($('login-wechat-qr'), res.authorize_url);
    pollWechatStatus(res.state, 'login');
  } catch (err) {
    showLoginError(translateError(err));
  }
}

/**
 * 轮询扫码结果。
 * 桌面端发起、手机端授权，两台设备之间只能靠服务端中转，所以这里只能轮询。
 */
async function pollWechatStatus(state, purpose) {
  const tip = purpose === 'bind' ? $('wechat-dialog-status') : $('login-wechat-tip');
  try {
    const res = await api.get(`/api/v1/auth/wechat/status?state=${encodeURIComponent(state)}`);
    if (res.status === 'confirmed') {
      stopWechatPoll();
      if (purpose === 'bind') onWechatBound(res);
      else onWechatSignedIn(res);
      return;
    }
    if (res.status === 'expired' || res.status === 'failed' || res.status === 'unknown') {
      stopWechatPoll();
      tip.textContent =
        res.status === 'expired' ? t('login.wechatExpired') : t('login.wechatFailed');
      if (res.error_code) tip.textContent = translateError({ code: res.error_code });
      return;
    }
  } catch {
    /* 网络抖动：下一轮继续轮询，不打断用户 */
  }
  wechatTimer = setTimeout(() => pollWechatStatus(state, purpose), 2000);
}

/**
 * 扫码授权成功：直接进主界面。
 *
 * 之前是停在登录卡片里让人手动点「进入」，体验上像「扫码了却没登录」——
 * 扫码授权本来就该直接把人带进系统。
 * 首次微信登录会自动签发一枚 MCP 令牌，明文只此一次，
 * 所以用一个弹窗把它摊开给用户复制；顺带存进 state.lastToken，
 * 设置页的 MCP 配置块就能直接用上真令牌而不是占位符。
 */
function onWechatSignedIn(res) {
  const token = res.token;
  if (token) {
    state.lastToken = token;
    $('token-dialog-value').textContent = token;
  }
  enterApp();
  bootstrap();
  if (token) {
    try {
      $('token-dialog').showModal();
    } catch {
      /* 对话框已经开着就算了 */
    }
  }
}

$('login-wechat').addEventListener('click', () => {
  startWechatLogin();
});

$('login-wechat-cancel').addEventListener('click', () => {
  stopWechatPoll();
  $('login-wechat-panel').hidden = true;
});

$('token-dialog-copy').addEventListener('click', async () => {
  const ok = await copyText($('token-dialog-value').textContent);
  toast(ok ? t('wechat.tokenCopied') : t('wechat.tokenCopyFailed'), !ok);
});

$('token-dialog-close').addEventListener('click', () => {
  try {
    $('token-dialog').close();
  } catch {
    /* 已经关了 */
  }
});

/** 绑定微信：把当前微信身份挂到已登录的这个账号上 */
async function startWechatBind() {
  try {
    const res = await api.post('/api/v1/auth/wechat/bind/start', {});
    $('wechat-dialog-status').textContent = t('wechat.scanTip');
    renderQr($('wechat-dialog-qr'), res.authorize_url);
    $('wechat-dialog').showModal();
    pollWechatStatus(res.state, 'bind');
  } catch (err) {
    toast(translateError(err), true);
  }
}

function onWechatBound() {
  try {
    $('wechat-dialog').close();
  } catch {
    /* 对话框可能已经被关掉了 */
  }
  toast(t('wechat.bindDone'));
  loadMe().then(renderDrawerIfOpen);
}

$('wechat-dialog-close').addEventListener('click', () => {
  stopWechatPoll();
  try {
    $('wechat-dialog').close();
  } catch {
    /* 已经关了 */
  }
});

/* ---------------------------------------------------------------- 启动 */

async function bootstrap() {
  await loadSources();
  await loadTasks();
  await loadMe();
  loadUsers();
  connectStream();
  registerServiceWorker();
  updateNotifyBanner();
  updateEmailBanner();
  applyDeepLink();
}

/** 拉取可转交的用户列表（转交下拉的选项）。失败不致命：下拉为空时转交按钮禁用。 */
async function loadUsers() {
  try {
    const { users } = await api.get('/api/v1/users');
    state.users = users || [];
  } catch { /* 忽略 */ }
  renderTransferOptions();
}

/** 任务卡上「转交」下拉的选项：排除自己 */
function renderTransferOptions() {
  for (const sel of document.querySelectorAll('.task-transfer-select')) {
    const current = sel.value;
    sel.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('task.transferPlaceholder');
    sel.appendChild(placeholder);
    for (const u of state.users) {
      if (u.id === state.me?.user_id) continue;
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = u.display_name ? `${u.username}（${u.display_name}）` : u.username;
      sel.appendChild(o);
    }
    if (current) sel.value = current;
  }
}

/**
 * 未绑定邮箱横幅：账号必须有邮箱才能收到任务与转交的邮件通知。
 * 绑定好了就永久消失。
 */
function updateEmailBanner() {
  const banner = $('email-banner');
  if (!banner) return;
  banner.hidden = !!state.me?.email;
}

async function loadSources() {
  try {
    const { sources } = await api.get('/api/v1/me');
    state.sources = new Map((sources || []).map((s) => [s.id, s]));
  } catch { /* 忽略 */ }
  renderSourceFilter();
}

/**
 * 填充「来源」筛选下拉。
 *
 * 选项按 agent 去重：一个工具可能有多个会话（每次 AI 会话一个 session_key），
 * 但用户想筛的是「哪个工具」，不是「哪次会话」。
 * 没有任务来源的用户（纯手动添加）就只有一个「全部来源」。
 */
function renderSourceFilter() {
  const sel = $('filter-source');
  if (!sel) return;
  const agents = [...new Set([...state.sources.values()].map((s) => s.agent))].sort();
  const current = state.source;

  sel.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = t('toolbar.allSources');
  sel.appendChild(all);

  for (const agent of agents) {
    const o = document.createElement('option');
    o.value = agent;
    o.textContent = agent;
    sel.appendChild(o);
  }

  // 当前选的来源可能已经不在列表里（比如来源被删了），别让下拉显示成空
  if (current && !agents.includes(current)) state.source = '';
  sel.value = state.source;
}

async function loadMe() {
  try {
    state.me = await api.get('/api/v1/me');
    state.rules = state.me.rules;
    updatePending(state.me.pending);
    updateClearArchivedButton();
    renderUser();
    updateEmailBanner();
  } catch { /* 忽略 */ }
}

/**
 * 「清空已归档」按钮的显隐与文案。
 * 没有已归档任务时整个按钮藏起来——一个永远点了没反应的按钮比没有更糟。
 */
function updateClearArchivedButton() {
  const btn = $('btn-clear-archived');
  if (!btn || !state.me) return;
  const n = state.me.archived ?? 0;
  btn.hidden = n <= 0;
  btn.textContent = n > 0 ? t('toolbar.clearArchivedCount', { count: n }) : t('toolbar.clearArchived');
}

async function loadTasks() {
  const params = new URLSearchParams();
  if (state.status !== 'all') params.set('status', state.status);
  if (state.severity) params.set('severity', state.severity);
  if (state.source) params.set('source', state.source);
  if (state.q) params.set('q', state.q);
  params.set('limit', '200');
  try {
    const { tasks } = await api.get(`/api/v1/tasks?${params}`);
    state.tasks = tasks || [];
    renderTasks();
  } catch (err) {
    if (err.code !== 'unauthorized') toast(translateError(err), true);
  }
}

function updatePending(n) {
  const pill = $('pending-pill');
  pill.hidden = !n;
  pill.textContent = String(n);
  document.title = n ? `(${n}) AI Todo` : 'AI Todo';
}

/* ---------------------------------------------------------------- 渲染 */

// 标签跟语言走，所以每次现查字典，不缓存成常量
function sevLabel(v) {
  const key = `severity.${v}`;
  const s = t(key);
  return s === key ? v : s;
}
function stLabel(v) {
  const key = `status.${v}`;
  const s = t(key);
  return s === key ? v : s;
}

/**
 * 建 SVG 图标。
 * 用 createElementNS 而不是 innerHTML：这个项目里凡是可能来自 AI 产出的内容
 * 一律只走 textContent，图标这种常量也不能开 innerHTML 的口子。
 */
function svgIcon(paths) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

// 垃圾桶（Lucide trash-2）—— 软删除（归档）
const TRASH_ICON = ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'];

// 垃圾桶带叉（Lucide trash-x）—— 彻底删除，不可恢复
const TRASH_X_ICON = ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'm10 11 5 5', 'm15 11-5 5'];

// 机器人（Lucide bot）—— 任务来源：哪个 AI 工具推的
const BOT_ICON = [
  'M12 8V4H8',
  'M9 7h6a5 5 0 0 1 5 5v1a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-1a5 5 0 0 1 5-5Z',
  'M9 12h.01',
  'M15 12h.01',
  'M9 17v2',
  'M15 17v2',
];

// 文件夹（Lucide folder）—— 来源项目
const FOLDER_ICON = ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'];

// 下箭头（Lucide chevron-down）—— 卡片可展开的暗示
const CHEVRON_ICON = ['m6 9 6 6 6-6'];

function renderTasks() {
  const list = $('list');
  list.textContent = '';
  $('empty').hidden = state.tasks.length > 0;

  for (const task of state.tasks) {
    list.appendChild(renderTask(task));
  }
}

function renderTask(task) {
  const card = document.createElement('article');
  card.className = 'task';
  card.dataset.id = task.id;
  card.dataset.severity = task.severity;
  if (task.status === 'done') card.classList.add('is-done');
  if (task.status === 'archived') card.classList.add('is-archived');
  if (state.selectedId === task.id) card.classList.add('is-selected');

  // 收起 / 展开状态：收起时只有标题 + 基本信息（级别、状态、来源、时间），
  // 详情和操作按钮都要点开卡片才看得到——长列表里一屏能多看好几条。
  const expanded = state.selectedId === task.id;

  const top = document.createElement('div');
  top.className = 'task-top';

  const title = document.createElement('h3');
  title.className = 'task-title';
  title.textContent = task.title;
  top.appendChild(title);

  // 删除：放在卡片右上角，图标形态，鼠标移到卡片上才显现。
  //
  // 两个状态、两种图标，避免用户分不清：
  // - 未归档 → 垃圾桶（trash-2）：软删除，进了「全部」标签还能找回；
  // - 已归档 → 垃圾桶带叉（trash-x）：彻底删除，不可恢复。
  //
  // 为什么已归档的也要给按钮：归档是软删除的第一步，没有第二步的话
  // 回收站永远清不空，测试垃圾会一直堆在「全部」标签里。
  // 用图标而不是文字按钮：原来它和「接手 / 完成」长得一模一样，
  // 根本没有删除的视觉暗示。
  const isArchived = task.status === 'archived';
  const del = document.createElement('button');
  del.className = 'task-del' + (isArchived ? ' is-hard' : '');
  del.type = 'button';
  del.title = isArchived ? t('task.hardDeleteTitle') : t('task.deleteTitle');
  del.setAttribute('aria-label', isArchived ? t('task.hardDeleteLabel') : t('task.deleteLabel'));
  del.appendChild(svgIcon(isArchived ? TRASH_X_ICON : TRASH_ICON));
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isArchived) {
      hardDeleteTask(task.id);
    } else {
      archiveTask(task.id);
    }
  });
  top.appendChild(del);

  // 展开箭头：告诉用户「这张卡片点开还有内容」，展开时翻转朝上
  const caret = document.createElement('span');
  caret.className = 'task-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.appendChild(svgIcon(CHEVRON_ICON));
  top.appendChild(caret);

  card.appendChild(top);

  // 元信息（收起状态下也一直可见的基本信息）
  const meta = document.createElement('div');
  meta.className = 'task-meta';

  const sevTag = document.createElement('span');
  sevTag.className = `tag sev-${task.severity}`;
  sevTag.textContent = sevLabel(task.severity);
  meta.appendChild(sevTag);

  if (task.status !== 'pending') {
    const stTag = document.createElement('span');
    stTag.className = `tag st-${task.status}`;
    stTag.textContent = stLabel(task.status);
    meta.appendChild(stTag);
  }

  // 来源与项目：两者必须一眼分得开。
  // 以前都塞在元信息行里、用「·」隔开，看起来跟提醒时间没区别——
  // 「这条是哪个工具发的、哪个项目的」根本看不出来。
  const source = state.sources.get(task.source_id);
  if (source) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'src-chip';
    chip.appendChild(svgIcon(BOT_ICON));
    const name = document.createElement('span');
    name.textContent = source.label || source.agent;
    chip.appendChild(name);
    chip.title = t('task.sourceTitle', { agent: source.agent, session: source.session_key });
    // 点一下就按这个来源筛选
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      state.source = source.agent;
      const sel = $('filter-source');
      if (sel) sel.value = source.agent;
      loadTasks();
    });
    meta.appendChild(chip);
  }

  if (task.project) {
    const chip = document.createElement('span');
    chip.className = 'src-chip is-project';
    chip.appendChild(svgIcon(FOLDER_ICON));
    const name = document.createElement('span');
    name.textContent = task.project;
    chip.appendChild(name);
    chip.title = t('task.projectTitle', { project: task.project });
    meta.appendChild(chip);
  }

  if (task.due_at) {
    const sep = document.createElement('span');
    sep.className = 'meta-sep';
    sep.textContent = '·';
    meta.appendChild(sep);

    const due = document.createElement('span');
    due.textContent = t('task.remindAt', { time: formatTime(task.due_at) });
    meta.appendChild(due);
  }

  for (const link of task.links || []) {
    const a = document.createElement('a');
    a.className = 'link-chip';
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = link.label || link.url;
    a.title = link.url;
    meta.appendChild(a);
  }

  card.appendChild(meta);

  // 展开区：详情和操作按钮只在点开卡片后出现
  if (expanded) {
    if (task.detail) {
      const detail = document.createElement('p');
      detail.className = 'task-detail';
      detail.textContent = task.detail;
      card.appendChild(detail);
    }

    const actions = document.createElement('div');
    actions.className = 'task-actions';

    if (task.status === 'pending') {
      actions.appendChild(actionBtn(t('action.ack'), 'btn', () => setStatus(task.id, 'ack')));
    }
    if (task.status !== 'done' && task.status !== 'archived') {
      actions.appendChild(actionBtn(t('action.done'), 'btn', () => setStatus(task.id, 'done')));
    }
    if (task.status === 'pending') {
      actions.appendChild(actionBtn(t('action.snooze'), 'btn', (btn) => toggleSnooze(task, btn)));
    }

    // 转交：选人 + 转交按钮。目标用户会收到站内通知和邮件。
    if (task.status === 'pending' || task.status === 'acked') {
      const wrap = document.createElement('span');
      wrap.className = 'task-transfer';

      const sel = document.createElement('select');
      sel.className = 'select task-transfer-select';
      sel.setAttribute('aria-label', t('task.transferLabel'));
      wrap.appendChild(sel);

      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn';
      go.textContent = t('task.transfer');
      go.disabled = state.users.length <= 1;
      go.addEventListener('click', async () => {
        if (!sel.value) { toast(t('task.transferPick'), true); return; }
        try {
          await api.post(`/api/v1/tasks/${task.id}/transfer`, { to_user_id: sel.value });
          const target = state.users.find((u) => u.id === sel.value);
          toast(t('task.transferredToast', { user: target?.username ?? '' }));
          await loadTasks();
        } catch (err) {
          toast(translateError(err), true);
        }
      });
      wrap.appendChild(go);
      actions.appendChild(wrap);
      renderTransferOptions();
    }

    card.appendChild(actions);
  }

  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    selectTask(task.id);
  });

  return card;
}

function actionBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(b);
  });
  return b;
}

function toggleSnooze(task, btn) {
  const card = btn.closest('.task');
  let row = card.querySelector('.snooze-row');
  if (row) { row.remove(); return; }

  row = document.createElement('div');
  row.className = 'snooze-row task-actions';

  const presets = [
    [t('action.snooze1h'), 1],
    [t('action.snoozeTonight'), 'tonight'],
    [t('action.snoozeMorning'), 'morning'],
  ];

  for (const [label, kind] of presets) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm';
    b.textContent = label;
    b.addEventListener('click', async () => {
      const until = computeSnooze(kind);
      await api.post(`/api/v1/tasks/${task.id}/snooze`, { until: until.toISOString() });
      row.remove();
      toast(t('action.snoozedToast', { time: formatTime(until.toISOString()) }));
      await loadTasks();
    });
    row.appendChild(b);
  }

  card.appendChild(row);
}

function computeSnooze(kind) {
  const d = new Date();
  if (kind === 1) { d.setHours(d.getHours() + 1); return d; }
  if (kind === 'tonight') {
    d.setHours(20, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }
  d.setHours(9, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

function selectTask(id) {
  state.selectedId = state.selectedId === id ? null : id;
  renderTasks();
  history.replaceState(null, '', state.selectedId ? `/t/${state.selectedId}` : '/');
}

function applyDeepLink() {
  const m = /^\/t\/([0-9a-f-]{36})/.exec(location.pathname);
  if (!m) return;
  state.selectedId = m[1];
  state.status = 'all';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.status === 'all'));
  loadTasks().then(() => {
    const el = document.querySelector(`.task[data-id="${m[1]}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------------------------------------------------------- 操作 */

async function setStatus(id, status) {
  try {
    // 调用方传的是状态常量 'ack' / 'done'，接口路径同名。
    // 以前写成 status === 'acked' ? 'ack' : 'done'——'ack' 永远不等于 'acked'，
    // 点「接手」实际请求的是 done，任务直接被标成完成了。
    const endpoint = status === 'done' ? 'done' : 'ack';
    await api.post(`/api/v1/tasks/${id}/${endpoint}`);
    await loadTasks();
    await loadMe();
  } catch (err) {
    toast(translateError(err), true);
  }
}

async function archiveTask(id) {
  try {
    await api.post(`/api/v1/tasks/${id}/archive`);
    await loadTasks();
    await loadMe();
    // 必须给反馈：卡片凭空消失、没有提示的话，
    // 在长列表里很容易被当成「没点上」或者「没反应」。
    // 删除提示比默认久一点：它带着「可以去哪儿找回来」的信息，值得看清
    toast(t('task.deletedToast'), false, 5000);
  } catch (err) {
    toast(translateError(err), true);
  }
}

/**
 * 彻底删除（不可恢复）。只对已归档的任务开放。
 *
 * 必须二次确认：这一步没有回收站。
 */
async function hardDeleteTask(id) {
  const ok = await confirmAction({
    title: t('confirm.hardDeleteTitle'),
    text: t('confirm.hardDeleteText'),
    okLabel: t('confirm.hardDeleteOk'),
  });
  if (!ok) return;
  try {
    await api.del(`/api/v1/tasks/${id}`);
    await loadTasks();
    await loadMe();
    toast(t('confirm.hardDeletedToast'), false, 2400);
  } catch (err) {
    toast(translateError(err), true);
  }
}

/**
 * 通用确认框。
 *
 * 不用原生 confirm()：它在部分 WebView / PWA / 自动化环境里会被直接吞掉
 * （返回 false 或干脆不弹），用户只会看到「点了没反应」——
 * 而这恰恰是不可逆操作最不能接受的失败方式。
 */
function confirmAction({ title, text, okLabel }) {
  return new Promise((resolve) => {
    const dlg = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel || t('confirm.ok');
    dlg.returnValue = '';
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

/* ---------------------------------------------------------------- 实时流 */

function setLive(stateName, text) {
  const dot = $('live-dot');
  dot.dataset.state = stateName;
  $('live-text').textContent = text;
}

function connectStream() {
  if (state.es) state.es.close();

  const es = new EventSource('/api/v1/stream', { withCredentials: true });
  state.es = es;

  es.onopen = () => setLive('live', t('topbar.live'));
  es.onerror = () => setLive('down', t('topbar.reconnecting'));

  es.addEventListener('notification', (e) => {
    try {
      onNotification(JSON.parse(e.data));
    } catch { /* 忽略坏包 */ }
  });
}

async function onNotification(payload) {
  playNotifySound();
  await showDesktopNotification(payload);
  await loadTasks();
  await loadMe();
  renderDrawerIfOpen();
}

/**
 * 通知提示音。
 *
 * 用 Web Audio 现场合成两声短音（A5 → D6），不引音频文件：
 * 横幅本身可能被系统吞掉或延迟，声音是独立的提醒通道，得自己保证响。
 *
 * 浏览器规定 AudioContext 必须在用户交互之后才能出声——
 * 登录那一下点击就满足了；万一被挂起就尝试 resume，实在不行静默失败，
 * 声音缺席不该影响通知本身。
 */
let notifyAudioCtx = null;

function playNotifySound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    notifyAudioCtx = notifyAudioCtx || new Ctx();
    if (notifyAudioCtx.state === 'suspended') {
      notifyAudioCtx.resume().catch(() => {});
    }
    const now = notifyAudioCtx.currentTime;
    // 两声上行的「叮咚」：一声太短容易被当成杂音，两声才像提醒
    const notes = [
      [880, 0],        // A5
      [1174.66, 0.14], // D6
    ];
    for (const [freq, offset] of notes) {
      const osc = notifyAudioCtx.createOscillator();
      const gain = notifyAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(0.16, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.42);
      osc.connect(gain);
      gain.connect(notifyAudioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.5);
    }
  } catch {
    /* 声音失败不影响通知流程 */
  }
}

async function showDesktopNotification(payload) {
  const title = payload.title || 'AI Todo';
  const body = payload.body || '';

  if (!('Notification' in window)) {
    toast(`${title}${body ? '：' + body.split('\n')[0] : ''}`);
    return;
  }
  if (Notification.permission !== 'granted') {
    toast(`${title}${body ? '：' + body.split('\n')[0] : ''}`);
    return;
  }

  const options = {
    body,
    tag: `ai-todo-${payload.id}`,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: payload.url || '/' },
    requireInteraction: payload.severity === 'blocker',
  };

  try {
    const reg = await getActiveRegistration();
    if (reg) {
      await reg.showNotification(title, options);
      return;
    }
  } catch { /* 回退到页面级通知 */ }

  try {
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); location.href = options.data.url; n.close(); };
  } catch { /* 忽略 */ }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch { /* 忽略 */ }
}

/**
 * 取到一个「已激活」的 Service Worker 注册。
 * registration.showNotification() 要求 SW 处于 active 状态，
 * 首次安装时 register() 返回的注册还没激活，直接调用会抛 InvalidStateError。
 */
async function getActiveRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    if (reg.active) return reg;
    // 等它激活，但别无限等：8 秒拿不到就放弃，走页面级通知兜底
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    return ready || null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 通知权限 */

function updateNotifyBanner() {
  const banner = $('notify-banner');
  const supported = 'Notification' in window;
  const permission = supported ? Notification.permission : 'unsupported';

  if (!supported) {
    banner.hidden = false;
    $('notify-banner-text').textContent = t('banner.unsupported');
    $('btn-enable-notify').hidden = true;
    return;
  }
  if (permission === 'granted') { banner.hidden = true; return; }
  if (permission === 'denied') {
    banner.hidden = false;
    $('notify-banner-text').textContent = t('banner.denied');
    $('btn-enable-notify').hidden = true;
    return;
  }
  banner.hidden = false;
  $('notify-banner-text').textContent = t('banner.enable');
  $('btn-enable-notify').hidden = false;
}

$('btn-enable-notify').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    updateNotifyBanner();
    toast(t('notify.enabledToast'));
    await registerServiceWorker();
    // 发一条测试横幅，确认端到端可用
    try {
      const reg = await getActiveRegistration();
      if (reg) {
        await reg.showNotification(t('notify.testTitle'), {
          body: t('notify.testBody'),
          tag: 'ai-todo-test',
          icon: '/icon.svg',
        });
      }
    } catch { /* 忽略 */ }
  } else if (perm === 'denied') {
    updateNotifyBanner();
  }
});

$('btn-dismiss-banner').addEventListener('click', () => { $('notify-banner').hidden = true; });

// 邮箱横幅按钮：打开设置抽屉直奔绑定表单
$('btn-bind-email').addEventListener('click', () => openDrawer('settings'));

/* ---------------------------------------------------------------- 筛选 */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    state.status = tab.dataset.status;
    loadTasks();
  });
});

$('filter-severity').addEventListener('change', (e) => {
  state.severity = e.target.value;
  loadTasks();
});

// 来源筛选：下拉选项来自 /api/v1/me 的 sources（哪些 AI 工具推过任务）
$('filter-source').addEventListener('change', (e) => {
  state.source = e.target.value;
  loadTasks();
});

let searchTimer;
$('filter-q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    loadTasks();
  }, 220);
});

/* ---------------------------------------------------------------- 清空已归档 */

$('btn-clear-archived').addEventListener('click', async () => {
  const n = state.me?.archived ?? 0;
  if (n <= 0) return;
  const ok = await confirmAction({
    title: t('confirm.purgeTitle', { count: n }),
    text: t('confirm.purgeText'),
    okLabel: t('confirm.purgeOk'),
  });
  if (!ok) return;
  try {
    const r = await api.del('/api/v1/tasks/archived');
    await loadTasks();
    await loadMe();
    toast(t('confirm.purgedToast', { count: r.deleted ?? 0 }), false, 3000);
  } catch (err) {
    toast(translateError(err), true);
  }
});

/* ---------------------------------------------------------------- 手动添加 */

$('btn-add').addEventListener('click', () => {
  $('new-title').value = '';
  $('new-detail').value = '';
  $('new-project').value = '';
  $('new-severity').value = 'need_human';
  $('new-notify').checked = true;
  $('task-dialog').showModal();
});

$('task-form').addEventListener('submit', async (e) => {
  // 判定「用户点的是哪颗按钮」必须看 event.submitter。
  //
  // 这里踩过两个叠加的坑：
  // 1) returnValue 是 HTMLDialogElement 的属性，<form> 上压根没有这个属性——
  //    写成 $('task-form').returnValue 恒为 undefined，判断永远不成立，
  //    提交处理器每次都在第一行 return，对话框照常关闭但请求从未发出。
  // 2) 就算改去读 dialog.returnValue 也不行：method="dialog" 的表单是
  //    **先派发 submit 事件、之后才**把按钮的 value 写进 dialog.returnValue，
  //    读到的永远是上一次的值（第一次提交时是空串）。
  //
  // event.submitter 直接给出被点的那颗按钮，是唯一可靠的依据。
  const submitter = e.submitter;
  if (!submitter || submitter.value !== 'ok') return;

  const title = $('new-title').value.trim();
  if (!title) return;
  try {
    // 所有 DOM 读取都要落在第一个 await 之前：表单一旦提交，
    // 对话框会立刻关闭，之后再读字段就可能拿到已被重置的空值。
    const payload = {
      title,
      detail: $('new-detail').value.trim() || undefined,
      severity: $('new-severity').value,
      project: $('new-project').value.trim() || undefined,
      notify: $('new-notify').checked,
    };
    await api.post('/api/v1/tasks', payload);
    await loadTasks();
    await loadMe();
    toast(t('taskDialog.addedToast'));
  } catch (err) {
    toast(translateError(err), true);
  }
});

/* ---------------------------------------------------------------- 抽屉 */

function openDrawer(mode) {
  state.drawerMode = mode;
  $('drawer').hidden = false;
  $('drawer-backdrop').hidden = false;
  renderDrawer();
}

function closeDrawer() {
  state.drawerMode = null;
  $('drawer').hidden = true;
  $('drawer-backdrop').hidden = true;
}

$('btn-rules').addEventListener('click', () => openDrawer('rules'));
$('btn-settings').addEventListener('click', () => openDrawer('settings'));
$('btn-close-drawer').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', closeDrawer);

// 顶栏语言按钮：在已支持的语言之间直接对切
$('btn-locale').addEventListener('click', () => {
  setLocale(getLocale() === 'zh-CN' ? 'en-US' : 'zh-CN');
});

// 登录页也有一个：不然英文系统环境的人连登录都进不去
$('login-locale').addEventListener('click', () => {
  setLocale(getLocale() === 'zh-CN' ? 'en-US' : 'zh-CN');
});

/**
 * 语言切换后的重绘。
 * i18n.js 已经套好了 HTML 上的静态文案，这里负责那些运行时才生成的内容：
 * 任务卡片、顶栏状态、设置抽屉、用户/令牌管理页面。
 */
window.addEventListener('ai-todo:localechange', () => {
  renderTasks();
  renderUser();
  updateClearArchivedButton();
  updateNotifyBanner();
  renderDrawerIfOpen();
  // 下拉里的「全部来源」是 JS 生成的，得跟着语言重画
  renderSourceFilter();
  // 当前停在管理页的话整页重绘，别让表头按钮还挂着旧语言
  if (state.view === 'users') renderUsersPage();
  if (state.view === 'tokens') renderTokensPage();
});

function renderDrawerIfOpen() {
  if (state.drawerMode && !$('drawer').hidden) renderDrawer();
}

function renderDrawer() {
  const body = $('drawer-body');
  body.textContent = '';
  const rules = state.rules || state.me?.rules;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';

  if (state.drawerMode === 'rules') {
    $('drawer-title').textContent = t('drawer.rules');
    body.appendChild(rulesForm(rules));
    return;
  }

  $('drawer-title').textContent = t('drawer.settings');

  // 状态
  const s1 = section(t('section.status'));
  s1.appendChild(statusRow(t('status.notifyPermission'), permLabel(perm), permClass(perm)));
  s1.appendChild(statusRow(t('status.liveConnection'), $('live-text').textContent, $('live-dot').dataset.state === 'live' ? 'ok' : 'bad'));
  s1.appendChild(statusRow(t('status.pendingTasks'), String(state.me?.pending ?? 0), 'ok'));
  if (perm === 'default') {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = t('banner.enableBtn');
    btn.style.marginTop = '10px';
    btn.addEventListener('click', () => $('btn-enable-notify').click());
    s1.appendChild(btn);
  }
  body.appendChild(s1);

  // 账号
  const s2 = section(t('section.account'));
  s2.appendChild(statusRow(t('status.username'), state.me?.username ?? '—', 'ok'));
  s2.appendChild(statusRow(t('status.role'), state.me?.is_admin ? t('status.roleAdmin') : t('status.roleUser'), state.me?.is_admin ? 'ok' : ''));

  // 微信绑定：已登录的账号可以把自己的微信挂上来，之后就能直接扫码登录
  if (state.wechat.enabled) {
    const s2w = section(t('section.wechat'));
    s2w.appendChild(
      statusRow(
        t('status.wechatBound'),
        state.me?.wechat_bound ? t('status.wechatYes') : t('status.wechatNo'),
        state.me?.wechat_bound ? 'ok' : '',
      ),
    );
    const bind = document.createElement('button');
    bind.className = 'btn btn-block';
    bind.textContent = state.me?.wechat_bound ? t('wechat.rebind') : t('wechat.bind');
    bind.style.marginTop = '10px';
    bind.addEventListener('click', () => {
      startWechatBind();
    });
    s2w.appendChild(bind);
    body.appendChild(s2w);
  }

  const logout = document.createElement('button');
  logout.className = 'btn btn-block';
  logout.textContent = t('topbar.logout');
  logout.style.marginTop = '10px';
  logout.addEventListener('click', () => {
    doLogout();
  });
  s2.appendChild(logout);
  body.appendChild(s2);

  // 修改密码：微信-only 账号（没设过密码）第一次是「设置密码」，不用填旧密码
  if (state.me) {
    const s2p = section(state.me.has_password ? t('password.change') : t('password.set'));

    const pwOld = document.createElement('input');
    pwOld.className = 'input';
    pwOld.type = 'password';
    pwOld.autocomplete = 'current-password';
    pwOld.placeholder = t('password.old');
    pwOld.style.marginBottom = '8px';

    const pwNew = document.createElement('input');
    pwNew.className = 'input';
    pwNew.type = 'password';
    pwNew.autocomplete = 'new-password';
    pwNew.placeholder = `${t('password.new')} · ${t('password.newPlaceholder')}`;
    pwNew.style.marginBottom = '8px';

    const pwConfirm = document.createElement('input');
    pwConfirm.className = 'input';
    pwConfirm.type = 'password';
    pwConfirm.autocomplete = 'new-password';
    pwConfirm.placeholder = t('password.confirm');
    pwConfirm.style.marginBottom = '10px';

    const pwSave = document.createElement('button');
    pwSave.type = 'button';
    pwSave.className = 'btn btn-primary btn-block';
    pwSave.textContent = t('password.save');
    pwSave.addEventListener('click', async () => {
      if (pwNew.value !== pwConfirm.value) {
        toast(t('password.mismatch'), true);
        return;
      }
      try {
        await api.post('/api/v1/me/password', {
          old_password: state.me.has_password ? pwOld.value : undefined,
          new_password: pwNew.value,
        });
        pwOld.value = '';
        pwNew.value = '';
        pwConfirm.value = '';
        state.me.has_password = true;
        toast(t('password.changedToast'));
        renderDrawer();
      } catch (err) {
        toast(translateError(err), true);
      }
    });

    if (state.me.has_password) s2p.appendChild(pwOld);
    s2p.appendChild(pwNew);
    s2p.appendChild(pwConfirm);
    s2p.appendChild(pwSave);
    body.appendChild(s2p);
  }

  // 邮箱：任务通知与转交通知都发到这里。账号必须绑定，没绑就给绑定表单。
  if (state.me) {
    const s2e = section(t('email.section'));
    if (state.me.email) {
      s2e.appendChild(statusRow(t('email.current'), state.me.email, 'ok'));
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = t('email.boundHint');
      s2e.appendChild(hint);
    } else {
      s2e.appendChild(hint(t('email.needBind')));

      const emailInput = document.createElement('input');
      emailInput.className = 'input';
      emailInput.type = 'email';
      emailInput.placeholder = t('email.placeholder');
      emailInput.autocomplete = 'email';
      emailInput.style.marginBottom = '8px';

      const codeRow = document.createElement('div');
      codeRow.className = 'email-code-row';
      const codeInput = document.createElement('input');
      codeInput.className = 'input';
      codeInput.inputMode = 'numeric';
      codeInput.maxLength = 6;
      codeInput.placeholder = t('email.codePlaceholder');
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'btn btn-quiet';
      sendBtn.textContent = t('email.sendCode');
      sendBtn.addEventListener('click', async () => {
        if (!emailInput.value.trim()) { toast(t('email.needEmail'), true); return; }
        sendBtn.disabled = true;
        try {
          await api.post('/api/v1/me/email/start', { email: emailInput.value.trim() });
          toast(t('email.codeSent'));
        } catch (err) {
          toast(translateError(err), true);
        } finally {
          setTimeout(() => { sendBtn.disabled = false; }, 3000);
        }
      });
      codeRow.appendChild(codeInput);
      codeRow.appendChild(sendBtn);
      codeRow.style.marginBottom = '8px';

      const bindBtn = document.createElement('button');
      bindBtn.type = 'button';
      bindBtn.className = 'btn btn-primary btn-block';
      bindBtn.textContent = t('email.bind');
      bindBtn.addEventListener('click', async () => {
        if (!codeInput.value.trim()) { toast(t('email.needCode'), true); return; }
        try {
          const res = await api.post('/api/v1/me/email/confirm', {
            email: emailInput.value.trim(),
            code: codeInput.value.trim(),
          });
          state.me.email = res.email;
          toast(t('email.boundToast'));
          renderDrawer();
          updateEmailBanner();
        } catch (err) {
          toast(translateError(err), true);
        }
      });

      s2e.appendChild(emailInput);
      s2e.appendChild(codeRow);
      s2e.appendChild(bindBtn);
    }
    body.appendChild(s2e);
  }

  // 语言
  const s2b = section(t('section.language'));
  for (const [code, meta] of Object.entries(LOCALES)) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm' + (getLocale() === code ? ' btn-primary' : '');
    b.textContent = meta.label;
    b.style.marginRight = '8px';
    b.addEventListener('click', () => {
      setLocale(code);
    });
    s2b.appendChild(b);
  }
  body.appendChild(s2b);

  // MCP 接入（令牌在独立的「令牌管理」界面里签发）
  const s4 = section(t('section.mcp'));
  s4.appendChild(hint(t('mcp.hint')));

  const token = state.lastToken || t('mcp.tokenPlaceholder');
  const httpUrl = `${location.origin}/mcp`;

  s4.appendChild(
    codeBlock(t('mcp.httpTitle'), t('mcp.httpHint'), {
      mcpServers: {
        'ai-todo': {
          url: httpUrl,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }),
  );

  s4.appendChild(hint(t('mcp.isolation')));
  s4.appendChild(hint(t('mcp.sourceHint')));
  body.appendChild(s4);

  // 快捷键
  const s6 = section(t('section.shortcuts'));
  s6.appendChild(statusRow('j / k', t('shortcut.move')));
  s6.appendChild(statusRow('a', t('shortcut.ack')));
  s6.appendChild(statusRow('d', t('shortcut.done')));
  s6.appendChild(statusRow('/', t('shortcut.search')));
  body.appendChild(s6);
}

/* ---------------------------------------------------------------- 视图切换 */

/**
 * 主区域视图切换：任务列表 / 用户管理 / 令牌管理。
 *
 * 用户管理与令牌管理是独立的整页界面，不再是设置抽屉里挤在一起的一段——
 * 账号一多，抽屉里那个窄条既放不下列表也看不清操作。
 */
function setView(view) {
  state.view = view;
  const isTasks = view === 'tasks';
  $('toolbar').hidden = !isTasks;
  $('main-tasks').hidden = !isTasks;
  $('btn-add').hidden = !isTasks;
  $('page-users').hidden = view !== 'users';
  $('page-tokens').hidden = view !== 'tokens';
  if (view === 'users') renderUsersPage();
  if (view === 'tokens') renderTokensPage();
}

$('btn-users-back').addEventListener('click', () => setView('tasks'));
$('btn-tokens-back').addEventListener('click', () => setView('tasks'));

/* ---------------------------------------------------------------- 用户管理（独立界面） */

function renderUsersPage() {
  const body = $('users-body');
  body.textContent = '';

  // 新建账号
  const createCard = document.createElement('div');
  createCard.className = 'mgmt-card';
  const createHead = document.createElement('h3');
  createHead.className = 'mgmt-card-title';
  createHead.textContent = t('user.newTitle');
  createCard.appendChild(createHead);
  createCard.appendChild(hint(t('user.hint')));

  const createRow = document.createElement('div');
  createRow.className = 'mgmt-create-row';
  const uname = document.createElement('input');
  uname.className = 'input';
  uname.placeholder = t('user.newUsernamePlaceholder');
  uname.maxLength = 32;
  uname.autocapitalize = 'off';
  uname.spellcheck = false;
  // 账号必须绑定邮箱：任务邮件与转交通知都发到这个地址
  const uemail = document.createElement('input');
  uemail.className = 'input';
  uemail.type = 'email';
  uemail.placeholder = t('user.newEmailPlaceholder');
  uemail.autocomplete = 'off';
  const create = document.createElement('button');
  create.className = 'btn btn-primary';
  create.textContent = t('user.create');
  create.addEventListener('click', async () => {
    const username = uname.value.trim().toLowerCase();
    const email = uemail.value.trim().toLowerCase();
    if (!username) { toast(t('user.needUsername'), true); return; }
    if (!email) { toast(t('user.needEmail'), true); return; }
    try {
      const res = await api.post('/api/v1/admin/users', { username, email });
      uname.value = '';
      uemail.value = '';
      // 初始密码与令牌只显示一次：摊开在页面里，复制按钮伺候
      state.freshUserCredentials = { kind: 'created', username: res.user.username, password: res.password, token: res.token };
      if (res.token) state.lastToken = res.token;
      toast(t('user.createdToast', { username: res.user.username }));
      renderUsersPage();
    } catch (err) {
      toast(translateError(err), true);
    }
  });
  createRow.appendChild(uname);
  createRow.appendChild(uemail);
  createRow.appendChild(create);
  createCard.appendChild(createRow);
  body.appendChild(createCard);

  // 刚创建的账号凭据（只显示这一次）
  if (state.freshUserCredentials) {
    body.appendChild(credentialsCard(state.freshUserCredentials));
  }

  // 用户列表
  const listCard = document.createElement('div');
  listCard.className = 'mgmt-card';
  const listHead = document.createElement('h3');
  listHead.className = 'mgmt-card-title';
  listHead.textContent = t('user.listTitle');
  listCard.appendChild(listHead);

  let users = [];
  try {
    // 同步函数里发请求拿不到结果——先渲染骨架，数据回来再重画
    api.get('/api/v1/admin/users').then((res) => {
      users = res.users || [];
      fillUserTable(listCard, users);
    }).catch((err) => {
      listCard.appendChild(hint(t('user.loadFailed', { message: translateError(err) })));
    });
  } catch (err) {
    listCard.appendChild(hint(t('user.loadFailed', { message: translateError(err) })));
  }

  const head = userTableRow(true);
  head.className = 'mgmt-row mgmt-row-head';
  listCard.appendChild(head);
  body.appendChild(listCard);
}

function fillUserTable(listCard, users) {
  // 表头和数据行分两次画：列表主体要在不重画整个页面的情况下更新
  listCard.querySelectorAll('.mgmt-row:not(.mgmt-row-head)').forEach((r) => r.remove());
  for (const u of users) {
    listCard.appendChild(userTableRow(false, u));
  }
  if (users.length === 0) {
    listCard.appendChild(hint(t('user.empty')));
  }
}

/**
 * 用户表格的一行（或表头）。
 * 列：用户名 / 角色 / 状态 / 操作。
 */
function userTableRow(isHead, u) {
  const row = document.createElement('div');
  row.className = 'mgmt-row';

  const cellUser = document.createElement('div');
  const cellRole = document.createElement('div');
  const cellStatus = document.createElement('div');
  const cellActions = document.createElement('div');

  if (isHead) {
    cellUser.textContent = t('user.colUsername');
    cellRole.textContent = t('user.colRole');
    cellStatus.textContent = t('user.colStatus');
    cellActions.textContent = t('user.colActions');
    row.append(cellUser, cellRole, cellStatus, cellActions);
    return row;
  }

  const nameSpan = document.createElement('span');
  nameSpan.className = 'mgmt-name';
  nameSpan.textContent = u.username || t('user.noUsername');
  cellUser.appendChild(nameSpan);
  if (u.email) {
    const em = document.createElement('span');
    em.className = 'mgmt-sub';
    em.textContent = u.email;
    cellUser.appendChild(em);
  } else {
    const em = document.createElement('span');
    em.className = 'mgmt-sub badge-warn';
    em.textContent = t('user.noEmail');
    cellUser.appendChild(em);
  }
  if (state.me && u.id === state.me.id) {
    const you = document.createElement('span');
    you.className = 'mgmt-sub';
    you.textContent = t('user.self');
    cellUser.appendChild(you);
  }

  cellRole.textContent = u.is_admin ? t('status.roleAdmin') : t('status.roleUser');
  if (u.is_admin) cellRole.classList.add('mgmt-role-admin');

  const status = document.createElement('span');
  status.className = 'tag ' + (u.is_active ? 'st-acked' : 'sev-blocker');
  status.textContent = u.is_active ? t('user.flagNormal') : t('user.flagDisabled');
  cellStatus.appendChild(status);
  if (u.wechat_openid) {
    const wx = document.createElement('span');
    wx.className = 'mgmt-sub';
    wx.textContent = t('user.flagWechat');
    cellStatus.appendChild(wx);
  }

  // 不能禁用 / 启用自己：把自己禁了就只能去改数据库了
  const isSelf = state.me && u.id === state.me.id;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = u.is_active ? 'btn btn-sm btn-quiet btn-danger' : 'btn btn-sm btn-quiet';
  toggle.textContent = u.is_active ? t('user.disable') : t('user.enable');
  if (isSelf) {
    toggle.disabled = true;
    toggle.title = t('user.selfToggleHint');
  }
  toggle.addEventListener('click', async () => {
    try {
      await api.patch(`/api/v1/admin/users/${u.id}`, { is_active: !u.is_active });
      toast(u.is_active ? t('user.disabledToast') : t('user.enabledToast'));
      renderUsersPage();
    } catch (err) {
      toast(translateError(err), true);
    }
  });
  cellActions.appendChild(toggle);

  // 重置密码：服务端随机生成新密码，邮件发给用户本人；
  // 邮件走不通（没绑邮箱 / SMTP 未配置）时界面摊开显示一次。
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn-sm btn-quiet';
  reset.textContent = t('user.reset');
  reset.title = u.email ? t('user.resetTitle', { email: u.email }) : t('user.resetNoEmailHint');
  reset.addEventListener('click', async () => {
    const name = u.username || t('user.noUsername');
    // 重置会强制对方全部下线，属于打扰性动作，先确认
    if (!window.confirm(t('user.resetConfirm', { username: name }))) return;
    try {
      const res = await api.post(`/api/v1/admin/users/${u.id}/reset-password`);
      if (res.email_sent) {
        toast(t('user.resetSentToast', { email: res.email }));
      } else {
        // 邮件通道不可用：密码只在这里显示一次，管理员线下转达
        state.freshUserCredentials = { kind: 'reset', username: u.username, password: res.password, token: null };
        renderUsersPage();
        toast(t('user.resetFallbackToast'), true);
      }
    } catch (err) {
      toast(translateError(err), true);
    }
  });
  cellActions.appendChild(reset);

  row.append(cellUser, cellRole, cellStatus, cellActions);
  return row;
}

/** 新建账号后的一次性凭据卡：初始密码 + MCP 令牌，各带复制按钮 */
function credentialsCard(creds) {
  const card = document.createElement('div');
  card.className = 'mgmt-card token-secret credentials-card';

  const label = document.createElement('div');
  label.className = 'token-secret-label';
  // 建号与重置密码共用这张一次性凭据卡，标题按来源区分
  label.textContent = creds.kind === 'reset'
    ? t('user.resetFor', { username: creds.username })
    : t('user.createdFor', { username: creds.username });
  card.appendChild(label);

  const passLabel = document.createElement('div');
  passLabel.className = 'cred-label';
  passLabel.textContent = t('user.createdPassword');
  card.appendChild(passLabel);

  card.appendChild(secretRow(creds.password));

  if (creds.token) {
    const tokenLabel = document.createElement('div');
    tokenLabel.className = 'cred-label';
    tokenLabel.textContent = t('user.createdTokenLabel');
    card.appendChild(tokenLabel);
    card.appendChild(secretRow(creds.token));
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-sm btn-quiet';
  close.textContent = t('user.credentialDismiss');
  close.style.marginTop = '4px';
  close.addEventListener('click', () => {
    state.freshUserCredentials = null;
    renderUsersPage();
  });
  card.appendChild(close);

  return card;
}

/** 密文 + 复制按钮的一行 */
function secretRow(value) {
  const row = document.createElement('div');
  row.className = 'qr-token-row';
  const code = document.createElement('code');
  code.textContent = value;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-sm';
  copy.textContent = t('token.copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(value);
    toast(ok ? t('token.copiedToast') : t('token.copyFailedToast'), !ok);
  });
  row.appendChild(code);
  row.appendChild(copy);
  return row;
}

/* ---------------------------------------------------------------- 令牌管理（独立界面） */

function renderTokensPage() {
  const body = $('tokens-body');
  body.textContent = '';

  const card = document.createElement('div');
  card.className = 'mgmt-card';
  card.appendChild(hint(t('token.hint')));

  const listWrap = document.createElement('div');
  listWrap.id = 'tokens-list';
  card.appendChild(listWrap);

  const nameInput = document.createElement('input');
  nameInput.className = 'input';
  nameInput.placeholder = t('token.namePlaceholder');
  nameInput.maxLength = 120;
  nameInput.style.marginTop = '14px';

  const issue = document.createElement('button');
  issue.className = 'btn btn-primary btn-block';
  issue.textContent = t('token.issue');
  issue.style.marginTop = '10px';
  issue.addEventListener('click', async () => {
    try {
      const res = await api.post('/api/v1/tokens', { name: nameInput.value.trim() || 'mcp-client' });
      state.lastToken = res.token;
      nameInput.value = '';
      toast(t('token.issuedToast'));
      renderTokensPage();
    } catch (err) {
      toast(translateError(err), true);
    }
  });

  card.appendChild(nameInput);
  card.appendChild(issue);
  body.appendChild(card);

  // 刚签发的令牌（只显示这一次）
  if (state.lastToken) {
    const box = document.createElement('div');
    box.className = 'mgmt-card token-secret';
    const label = document.createElement('div');
    label.className = 'token-secret-label';
    label.textContent = t('token.freshLabel');
    box.appendChild(label);
    box.appendChild(secretRow(state.lastToken));
    body.appendChild(box);
  }

  // 令牌列表：数据到了再填进 listWrap
  api.get('/api/v1/tokens').then((res) => {
    fillTokenList(listWrap, res.tokens || []);
  }).catch((err) => {
    listWrap.appendChild(hint(t('token.loadFailed', { message: translateError(err) })));
  });
}

function fillTokenList(wrap, tokens) {
  wrap.textContent = '';
  if (tokens.length === 0) {
    wrap.appendChild(hint(t('token.empty')));
    return;
  }
  // 循环变量不能叫 t——那是本模块的翻译函数
  for (const tk of tokens) {
    const row = document.createElement('div');
    row.className = 'token-row';

    const info = document.createElement('div');
    info.className = 'token-info';
    const name = document.createElement('div');
    name.className = 'token-name';
    name.textContent = tk.name;
    const meta = document.createElement('div');
    meta.className = 'token-meta';
    const used = tk.last_used_at
      ? t('token.lastUsed', { time: formatTime(tk.last_used_at) })
      : t('token.neverUsed');
    meta.textContent = `${tk.revoked_at ? t('token.revoked') : t('token.valid')} · ${used}`;
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(info);

    if (!tk.revoked_at) {
      const revoke = document.createElement('button');
      revoke.className = 'btn btn-sm btn-quiet btn-danger';
      revoke.textContent = t('token.revoke');
      revoke.addEventListener('click', async () => {
        try {
          await api.del(`/api/v1/tokens/${tk.id}`);
          toast(t('token.revokedToast'));
          renderTokensPage();
        } catch (err) {
          toast(translateError(err), true);
        }
      });
      row.appendChild(revoke);
    }

    wrap.appendChild(row);
  }
}

function rulesForm(rules) {
  const frag = document.createDocumentFragment();
  if (!rules) {
    frag.appendChild(hint(t('rules.loading')));
    return frag;
  }

  const sevField = field(t('rules.minSeverity'), t('rules.minSeverityHint'));
  const sev = document.createElement('select');
  sev.className = 'select';
  for (const [v, label] of [
    ['info', t('rules.minSeverityInfo')],
    ['need_human', t('rules.minSeverityNeedHuman')],
    ['blocker', t('rules.minSeverityBlocker')],
  ]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (rules.min_severity === v) o.selected = true;
    sev.appendChild(o);
  }
  sevField.appendChild(sev);

  const cdField = field(t('rules.cooldown'), t('rules.cooldownHint'));
  const cd = document.createElement('input');
  cd.className = 'input';
  cd.type = 'number';
  cd.min = '0';
  cd.max = '86400';
  cd.value = String(rules.cooldown_sec ?? 300);
  cdField.appendChild(cd);

  const grField = field(t('rules.groupBy'), t('rules.groupByHint'));
  const gr = document.createElement('select');
  gr.className = 'select';
  for (const [v, label] of [
    ['source_session', t('rules.groupBySession')],
    ['project', t('rules.groupByProject')],
    ['none', t('rules.groupByNone')],
  ]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (rules.group_by === v) o.selected = true;
    gr.appendChild(o);
  }
  grField.appendChild(gr);

  const qhField = field(t('rules.quietHours'), t('rules.quietHoursHint'));
  const qh = document.createElement('input');
  qh.className = 'input';
  qh.placeholder = '23:00 - 08:00';
  qh.value = rules.quiet_hours ? `${rules.quiet_hours.start} - ${rules.quiet_hours.end}` : '';
  qhField.appendChild(qh);

  const dgField = field(t('rules.digestHour'), t('rules.digestHourHint'));
  const dg = document.createElement('input');
  dg.className = 'input';
  dg.type = 'number';
  dg.min = '0';
  dg.max = '23';
  dg.value = rules.digest_hour === null || rules.digest_hour === undefined ? '' : String(rules.digest_hour);
  dgField.appendChild(dg);

  frag.appendChild(sevField);
  frag.appendChild(cdField);
  frag.appendChild(grField);
  frag.appendChild(qhField);
  frag.appendChild(dgField);

  const save = document.createElement('button');
  save.className = 'btn btn-primary btn-block';
  save.textContent = t('rules.save');
  save.addEventListener('click', async () => {
    let quiet = null;
    const qhText = qh.value.trim();
    if (qhText) {
      const m = /^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/.exec(qhText);
      if (!m) { toast(t('rules.quietHoursFormat'), true); return; }
      quiet = { start: m[1], end: m[2] };
    }
    try {
      const res = await api.put('/api/v1/rules', {
        min_severity: sev.value,
        cooldown_sec: Number(cd.value) || 0,
        group_by: gr.value,
        quiet_hours: quiet,
        digest_hour: dg.value === '' ? null : Number(dg.value),
      });
      state.rules = res.rules;
      toast(t('rules.savedToast'));
    } catch (err) {
      toast(translateError(err), true);
    }
  });
  frag.appendChild(save);

  return frag;
}

function section(title) {
  const s = document.createElement('div');
  s.className = 'drawer-section';
  const h = document.createElement('h3');
  h.textContent = title;
  s.appendChild(h);
  return s;
}

function field(label, help) {
  const f = document.createElement('label');
  f.className = 'field';
  const sp = document.createElement('span');
  sp.textContent = label;
  f.appendChild(sp);
  if (help) f.dataset.help = help;
  return f;
}

function hint(text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}

/**
 * 复制文本到剪贴板。
 *
 * navigator.clipboard 只在「安全上下文」里可用——HTTPS 或 localhost。
 * 通过局域网 IP 用 http:// 访问时（http://192.168.1.20:8787）它压根不存在，
 * 所以必须留 execCommand 这条老路兜底，否则复制按钮在真实部署里直接失效。
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 一个带标题、说明与「复制」按钮的 JSON 配置块。
 * 配置是给人抄进 AI 客户端的，抄错一个字符客户端就起不来——
 * 所以复制按钮比让人手抄靠谱得多。
 */
function codeBlock(title, help, cfg) {
  const wrap = document.createElement('div');
  wrap.className = 'code-block-wrap';

  const pre = document.createElement('pre');
  pre.className = 'code-block';
  pre.textContent = JSON.stringify(cfg, null, 2);

  const head = document.createElement('div');
  head.className = 'code-block-head';

  const label = document.createElement('span');
  label.className = 'code-block-title';
  label.textContent = title;
  head.appendChild(label);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-sm btn-quiet code-copy';
  copy.textContent = t('mcp.copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(pre.textContent);
    if (!ok) {
      toast(t('mcp.copyFailed'), true);
      return;
    }
    copy.textContent = t('mcp.copied');
    setTimeout(() => {
      copy.textContent = t('mcp.copy');
    }, 1600);
    // 令牌是占位符时提醒一句：复制出去的配置是跑不起来的
    if (pre.textContent.includes(t('mcp.tokenPlaceholder'))) {
      toast(t('mcp.copyNeedToken'));
    }
  });
  head.appendChild(copy);
  wrap.appendChild(head);

  if (help) wrap.appendChild(hint(help));
  wrap.appendChild(pre);

  return wrap;
}

function statusRow(k, v, cls) {
  const row = document.createElement('div');
  row.className = 'status-row';
  const kk = document.createElement('span');
  kk.className = 'k';
  kk.textContent = k;
  const vv = document.createElement('span');
  vv.className = 'v' + (cls ? ' badge-' + cls : '');
  vv.textContent = v;
  row.appendChild(kk);
  row.appendChild(vv);
  return row;
}

function permLabel(p) {
  const map = {
    granted: 'perm.granted',
    denied: 'perm.denied',
    default: 'perm.default',
    unsupported: 'perm.unsupported',
  };
  return map[p] ? t(map[p]) : p;
}
function permClass(p) {
  return { granted: 'ok', denied: 'bad', default: 'warn', unsupported: 'bad' }[p] || '';
}

/* ---------------------------------------------------------------- 快捷键 */

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === '/') {
    e.preventDefault();
    $('filter-q').focus();
    return;
  }
  if (e.key === 'Escape') {
    if (!$('user-dropdown').hidden) {
      closeUserMenu();
      return;
    }
    if (!$('drawer').hidden) {
      closeDrawer();
      return;
    }
    // 管理界面里按 Esc 也能回到任务列表，不用非得去点返回按钮
    if (state.view !== 'tasks') setView('tasks');
    return;
  }
  if (!$('app') || $('app').hidden) return;

  const index = state.tasks.findIndex((t) => t.id === state.selectedId);
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    if (state.tasks.length === 0) return;
    const dir = e.key === 'j' ? 1 : -1;
    const next = index < 0 ? 0 : Math.min(state.tasks.length - 1, Math.max(0, index + dir));
    selectTask(state.tasks[next].id);
    return;
  }
  if ((e.key === 'a' || e.key === 'd') && state.selectedId) {
    e.preventDefault();
    const task = state.tasks.find((t) => t.id === state.selectedId);
    if (!task) return;
    if (e.key === 'a' && task.status === 'pending') setStatus(task.id, 'ack');
    if (e.key === 'd' && task.status !== 'done') setStatus(task.id, 'done');
  }
});

/* ---------------------------------------------------------------- 启动流程 */

loadAuthProviders();
tryLogin();
