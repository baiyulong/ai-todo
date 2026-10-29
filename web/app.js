/* AI Todo · 桌面 Web 前端（配置 A：浏览器系统级通知 + 未读列表） */

const state = {
  tasks: [],
  status: 'pending',
  severity: '',
  q: '',
  selectedId: null,
  sources: new Map(),
  rules: null,
  me: null,
  es: null,
  drawerMode: null,
  lastToken: null,
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
    if (res.status === 401) {
      showLogin();
      throw new Error('unauthorized');
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  },
  get(p) { return api.call('GET', p); },
  post(p, b) { return api.call('POST', p, b); },
  patch(p, b) { return api.call('PATCH', p, b); },
  put(p, b) { return api.call('PUT', p, b); },
  del(p) { return api.call('DELETE', p); },
};

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
  $('dd-role').textContent = me.is_admin ? '管理员' : '普通用户';
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
$('dd-logout').addEventListener('click', () => {
  doLogout();
});
// 点菜单外面或按 Esc 收起
document.addEventListener('click', (e) => {
  if (!$('user-menu').contains(e.target)) closeUserMenu();
});

/* ---------------------------------------------------------------- 登录 */

function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
  if (state.es) { state.es.close(); state.es = null; }
  closeUserMenu();
  setLive('down', '未登录');
}

async function tryLogin() {
  try {
    await api.get('/api/v1/me');
    $('login').hidden = true;
    $('app').hidden = false;
    await bootstrap();
  } catch {
    /* 401 已在 showLogin 处理 */
  }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const err = $('login-error');
  err.hidden = true;
  try {
    await api.post('/api/v1/auth/login', { username, password });
    $('login-password').value = '';
    $('login').hidden = true;
    $('app').hidden = false;
    await bootstrap();
  } catch (err2) {
    err.textContent =
      err2.message === 'unauthorized' || err2.message === '用户名或密码不正确'
        ? '用户名或密码不正确'
        : err2.message;
    err.hidden = false;
  }
});

/* ---------------------------------------------------------------- 启动 */

async function bootstrap() {
  await loadSources();
  await loadTasks();
  await loadMe();
  connectStream();
  registerServiceWorker();
  updateNotifyBanner();
  applyDeepLink();
}

async function loadSources() {
  try {
    const { sources } = await api.get('/api/v1/me');
    state.sources = new Map((sources || []).map((s) => [s.id, s]));
  } catch { /* 忽略 */ }
}

async function loadMe() {
  try {
    state.me = await api.get('/api/v1/me');
    state.rules = state.me.rules;
    updatePending(state.me.pending);
    updateClearArchivedButton();
    renderUser();
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
  btn.textContent = n > 0 ? `清空已归档（${n}）` : '清空已归档';
}

async function loadTasks() {
  const params = new URLSearchParams();
  if (state.status !== 'all') params.set('status', state.status);
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  params.set('limit', '200');
  try {
    const { tasks } = await api.get(`/api/v1/tasks?${params}`);
    state.tasks = tasks || [];
    renderTasks();
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, true);
  }
}

function updatePending(n) {
  const pill = $('pending-pill');
  pill.hidden = !n;
  pill.textContent = String(n);
  document.title = n ? `(${n}) AI Todo` : 'AI Todo';
}

/* ---------------------------------------------------------------- 渲染 */

const SEV_LABEL = { info: '记录', need_human: '需处理', blocker: '阻塞' };
const ST_LABEL = { pending: '待处理', acked: '已接手', done: '已完成', archived: '已归档' };

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
  del.title = isArchived ? '彻底删除（不可恢复）' : '删除（可在「全部」标签里找回）';
  del.setAttribute('aria-label', isArchived ? '彻底删除任务' : '删除任务');
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

  card.appendChild(top);

  if (task.detail) {
    const detail = document.createElement('p');
    detail.className = 'task-detail';
    detail.textContent = task.detail;
    card.appendChild(detail);
  }

  // 元信息
  const meta = document.createElement('div');
  meta.className = 'task-meta';

  const sevTag = document.createElement('span');
  sevTag.className = `tag sev-${task.severity}`;
  sevTag.textContent = SEV_LABEL[task.severity] || task.severity;
  meta.appendChild(sevTag);

  if (task.status !== 'pending') {
    const stTag = document.createElement('span');
    stTag.className = `tag st-${task.status}`;
    stTag.textContent = ST_LABEL[task.status] || task.status;
    meta.appendChild(stTag);
  }

  const source = state.sources.get(task.source_id);
  if (source) {
    const sep = document.createElement('span');
    sep.className = 'meta-sep';
    sep.textContent = '·';
    meta.appendChild(sep);

    const src = document.createElement('span');
    src.textContent = source.label || source.agent;
    src.title = `${source.agent} · ${source.session_key}`;
    meta.appendChild(src);
  }

  if (task.project) {
    const sep = document.createElement('span');
    sep.className = 'meta-sep';
    sep.textContent = '·';
    meta.appendChild(sep);

    const prj = document.createElement('span');
    prj.textContent = task.project;
    meta.appendChild(prj);
  }

  if (task.due_at) {
    const sep = document.createElement('span');
    sep.className = 'meta-sep';
    sep.textContent = '·';
    meta.appendChild(sep);

    const due = document.createElement('span');
    due.textContent = `提醒 ${formatTime(task.due_at)}`;
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

  // 操作
  const actions = document.createElement('div');
  actions.className = 'task-actions';

  if (task.status === 'pending') {
    actions.appendChild(actionBtn('接手', 'btn', () => setStatus(task.id, 'ack')));
  }
  if (task.status !== 'done' && task.status !== 'archived') {
    actions.appendChild(actionBtn('完成', 'btn', () => setStatus(task.id, 'done')));
  }
  if (task.status === 'pending') {
    actions.appendChild(actionBtn('稍后提醒', 'btn', (btn) => toggleSnooze(task, btn)));
  }

  card.appendChild(actions);
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
    ['1 小时后', 1],
    ['今晚 20:00', 'tonight'],
    ['明早 9:00', 'morning'],
  ];

  for (const [label, kind] of presets) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm';
    b.textContent = label;
    b.addEventListener('click', async () => {
      const until = computeSnooze(kind);
      await api.post(`/api/v1/tasks/${task.id}/snooze`, { until: until.toISOString() });
      row.remove();
      toast(`已推迟到 ${formatTime(until.toISOString())}`);
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
    await api.post(`/api/v1/tasks/${id}/${status === 'acked' ? 'ack' : 'done'}`);
    await loadTasks();
    await loadMe();
  } catch (err) {
    toast(err.message, true);
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
    toast('已删除，可在「全部」标签里找回', false, 5000);
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 彻底删除（不可恢复）。只对已归档的任务开放。
 *
 * 必须二次确认：这一步没有回收站。
 */
async function hardDeleteTask(id) {
  const ok = await confirmAction({
    title: '彻底删除这条任务？',
    text: '删除后无法恢复。这条任务和它的通知记录会一起消失。',
    okLabel: '彻底删除',
  });
  if (!ok) return;
  try {
    await api.del(`/api/v1/tasks/${id}`);
    await loadTasks();
    await loadMe();
    toast('已彻底删除', false, 2400);
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 通用确认框。
 *
 * 不用原生 confirm()：它在部分 WebView / PWA / 自动化环境里会被直接吞掉
 * （返回 false 或干脆不弹），用户只会看到「点了没反应」——
 * 而这恰恰是不可逆操作最不能接受的失败方式。
 */
function confirmAction({ title, text, okLabel = '确定' }) {
  return new Promise((resolve) => {
    const dlg = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel;
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

  es.onopen = () => setLive('live', '实时');
  es.onerror = () => setLive('down', '重连中');

  es.addEventListener('notification', (e) => {
    try {
      onNotification(JSON.parse(e.data));
    } catch { /* 忽略坏包 */ }
  });
}

async function onNotification(payload) {
  await showDesktopNotification(payload);
  await loadTasks();
  await loadMe();
  renderDrawerIfOpen();
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
    $('notify-banner-text').textContent = '当前浏览器不支持系统通知，将以页内提示代替。';
    $('btn-enable-notify').hidden = true;
    return;
  }
  if (permission === 'granted') { banner.hidden = true; return; }
  if (permission === 'denied') {
    banner.hidden = false;
    $('notify-banner-text').textContent = '通知权限已被拒绝。请在地址栏左侧的网站设置里允许通知，然后刷新页面。';
    $('btn-enable-notify').hidden = true;
    return;
  }
  banner.hidden = false;
  $('notify-banner-text').textContent = '开启桌面通知，AI 完成任务时立刻弹横幅提醒。';
  $('btn-enable-notify').hidden = false;
}

$('btn-enable-notify').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    updateNotifyBanner();
    toast('已开启桌面通知');
    await registerServiceWorker();
    // 发一条测试横幅，确认端到端可用
    try {
      const reg = await getActiveRegistration();
      if (reg) {
        await reg.showNotification('AI Todo 通知已开启', {
          body: 'AI 完成任务后会这样弹横幅提醒你。',
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
    title: `清空 ${n} 条已归档任务？`,
    text: '这些任务会被永久删除，无法恢复。正在处理、已接手和已完成的任务都不受影响。',
    okLabel: '全部删除',
  });
  if (!ok) return;
  try {
    const r = await api.del('/api/v1/tasks/archived');
    await loadTasks();
    await loadMe();
    toast(`已清空 ${r.deleted ?? 0} 条已归档任务`, false, 3000);
  } catch (err) {
    toast(err.message, true);
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
    toast('已添加');
  } catch (err) {
    toast(err.message, true);
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

function renderDrawerIfOpen() {
  if (state.drawerMode && !$('drawer').hidden) renderDrawer();
}

async function renderDrawer() {
  const body = $('drawer-body');
  body.textContent = '';
  const rules = state.rules || state.me?.rules;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';

  if (state.drawerMode === 'rules') {
    $('drawer-title').textContent = '通知规则';
    body.appendChild(rulesForm(rules));
    return;
  }

  $('drawer-title').textContent = '设置';

  // 状态
  const s1 = section('状态');
  s1.appendChild(statusRow('桌面通知权限', permLabel(perm), permClass(perm)));
  s1.appendChild(statusRow('实时连接', $('live-text').textContent, $('live-dot').dataset.state === 'live' ? 'ok' : 'bad'));
  s1.appendChild(statusRow('待处理任务', String(state.me?.pending ?? 0), 'ok'));
  if (perm === 'default') {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = '开启通知';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', () => $('btn-enable-notify').click());
    s1.appendChild(btn);
  }
  body.appendChild(s1);

  // 账号
  const s2 = section('账号');
  s2.appendChild(statusRow('用户名', state.me?.username ?? '—', 'ok'));
  s2.appendChild(statusRow('角色', state.me?.is_admin ? '管理员' : '普通用户', state.me?.is_admin ? 'ok' : ''));
  const logout = document.createElement('button');
  logout.className = 'btn btn-block';
  logout.textContent = '退出登录';
  logout.style.marginTop = '10px';
  logout.addEventListener('click', () => {
    doLogout();
  });
  s2.appendChild(logout);
  body.appendChild(s2);

  // 访问令牌（AI 客户端用）
  const s3 = section('访问令牌');
  s3.appendChild(hint('AI 客户端通过 MCP 推送任务时，需要一枚属于你的访问令牌。凭证必须写在客户端的环境变量 AI_TODO_TOKEN 里，令牌明文只在签发时显示一次。'));
  body.appendChild(s3);
  body.appendChild(await tokensBlock());

  // MCP 接入
  const s4 = section('MCP 接入');
  s4.appendChild(hint('把下面这段加到你的 AI 客户端（MCode / Claude Code / Cursor）的 MCP 配置里，AI 就能把完成的任务推进来。'));
  const pre = document.createElement('pre');
  pre.className = 'code-block';
  const cfg = {
    mcpServers: {
      'ai-todo': {
        command: 'node',
        args: ['<你的项目路径>/dist/src/cli.js', 'mcp'],
        env: {
          AI_TODO_BASE_URL: location.origin,
          AI_TODO_TOKEN: state.lastToken || '<在上一栏签发一枚令牌后填这里>',
        },
      },
    },
  };
  pre.textContent = JSON.stringify(cfg, null, 2);
  s4.appendChild(pre);
  s4.appendChild(hint('每个用户只会看到自己的任务：令牌决定了任务推给谁。'));
  body.appendChild(s4);

  // 用户管理（仅管理员）
  if (state.me?.is_admin) {
    const s5 = section('用户管理');
    s5.appendChild(hint('管理员可以新建账号、禁用账号。初始密码与访问令牌只显示一次。'));
    body.appendChild(s5);
    body.appendChild(await usersBlock());
  }

  // 快捷键
  const s6 = section('快捷键');
  s6.appendChild(statusRow('j / k', '上下选择'));
  s6.appendChild(statusRow('a', '接手'));
  s6.appendChild(statusRow('d', '完成'));
  s6.appendChild(statusRow('/', '聚焦搜索'));
  body.appendChild(s6);
}

/* ---------------------------------------------------------------- 访问令牌 */

async function tokensBlock() {
  const frag = document.createDocumentFragment();

  let tokens = [];
  try {
    const res = await api.get('/api/v1/tokens');
    tokens = res.tokens || [];
  } catch (err) {
    frag.appendChild(hint('令牌列表加载失败：' + err.message));
    return frag;
  }

  if (tokens.length === 0) {
    frag.appendChild(hint('还没有签发任何令牌。'));
  } else {
    for (const t of tokens) {
      const row = document.createElement('div');
      row.className = 'token-row';

      const info = document.createElement('div');
      info.className = 'token-info';
      const name = document.createElement('div');
      name.className = 'token-name';
      name.textContent = t.name;
      const meta = document.createElement('div');
      meta.className = 'token-meta';
      const used = t.last_used_at ? `最近使用 ${formatTime(t.last_used_at)}` : '从未使用';
      meta.textContent = `${t.revoked_at ? '已吊销' : '有效'} · ${used}`;
      info.appendChild(name);
      info.appendChild(meta);
      row.appendChild(info);

      if (!t.revoked_at) {
        const revoke = document.createElement('button');
        revoke.className = 'btn btn-sm btn-quiet btn-danger';
        revoke.textContent = '吊销';
        revoke.addEventListener('click', async () => {
          try {
            await api.del(`/api/v1/tokens/${t.id}`);
            toast('令牌已吊销');
            renderDrawer();
          } catch (err) {
            toast(err.message, true);
          }
        });
        row.appendChild(revoke);
      }

      frag.appendChild(row);
    }
  }

  const nameInput = document.createElement('input');
  nameInput.className = 'input';
  nameInput.placeholder = '令牌名称，如 claude-code';
  nameInput.maxLength = 120;

  const issue = document.createElement('button');
  issue.className = 'btn btn-primary btn-block';
  issue.textContent = '签发新令牌';
  issue.style.marginTop = '10px';
  issue.addEventListener('click', async () => {
    try {
      const res = await api.post('/api/v1/tokens', { name: nameInput.value.trim() || 'mcp-client' });
      state.lastToken = res.token;
      nameInput.value = '';
      toast('令牌已签发，请立即复制保存');
      renderDrawer();
    } catch (err) {
      toast(err.message, true);
    }
  });

  frag.appendChild(nameInput);
  frag.appendChild(issue);

  if (state.lastToken) {
    const box = document.createElement('div');
    box.className = 'token-secret';
    const label = document.createElement('div');
    label.className = 'token-secret-label';
    label.textContent = '刚签发的令牌（只显示这一次）';
    const code = document.createElement('code');
    code.textContent = state.lastToken;
    const copy = document.createElement('button');
    copy.className = 'btn btn-sm';
    copy.textContent = '复制';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.lastToken);
        toast('已复制');
      } catch {
        toast('复制失败，请手动选中复制', true);
      }
    });
    box.appendChild(label);
    box.appendChild(code);
    box.appendChild(copy);
    frag.appendChild(box);
  }

  return frag;
}

/* ---------------------------------------------------------------- 用户管理 */

async function usersBlock() {
  const frag = document.createDocumentFragment();

  let users = [];
  try {
    const res = await api.get('/api/v1/admin/users');
    users = res.users || [];
  } catch (err) {
    frag.appendChild(hint('用户列表加载失败：' + err.message));
    return frag;
  }

  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'token-row';

    const info = document.createElement('div');
    info.className = 'token-info';
    const name = document.createElement('div');
    name.className = 'token-name';
    name.textContent = (u.username || '(无用户名)') + (u.display_name ? ` · ${u.display_name}` : '');
    const meta = document.createElement('div');
    meta.className = 'token-meta';
    const flags = [];
    if (u.is_admin) flags.push('管理员');
    if (!u.is_active) flags.push('已禁用');
    meta.textContent = flags.length ? flags.join(' · ') : '正常';
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(info);

    const toggle = document.createElement('button');
    // 「禁用」是破坏性动作，悬停时给警示色；「启用」是恢复动作，保持中性
    toggle.className = u.is_active ? 'btn btn-sm btn-quiet btn-danger' : 'btn btn-sm btn-quiet';
    toggle.textContent = u.is_active ? '禁用' : '启用';
    toggle.addEventListener('click', async () => {
      try {
        await api.patch(`/api/v1/admin/users/${u.id}`, { is_active: !u.is_active });
        toast(u.is_active ? '账号已禁用' : '账号已启用');
        renderDrawer();
      } catch (err) {
        toast(err.message, true);
      }
    });
    row.appendChild(toggle);

    frag.appendChild(row);
  }

  const uname = document.createElement('input');
  uname.className = 'input';
  uname.placeholder = '新用户名（3–32 位，小写字母/数字/._-）';
  uname.maxLength = 32;
  uname.autocapitalize = 'off';
  uname.spellcheck = false;

  const create = document.createElement('button');
  create.className = 'btn btn-primary btn-block';
  create.textContent = '新建账号';
  create.style.marginTop = '10px';
  create.addEventListener('click', async () => {
    const username = uname.value.trim().toLowerCase();
    if (!username) { toast('请输入用户名', true); return; }
    try {
      const res = await api.post('/api/v1/admin/users', { username });
      state.lastToken = res.token;
      uname.value = '';
      toast(`账号已创建：${res.user.username}，初始密码只显示这一次`);
      renderDrawer();
    } catch (err) {
      toast(err.message, true);
    }
  });

  frag.appendChild(uname);
  frag.appendChild(create);

  return frag;
}

function rulesForm(rules) {
  const frag = document.createDocumentFragment();
  if (!rules) {
    frag.appendChild(hint('正在加载规则…'));
    return frag;
  }

  const sevField = field('最低提醒级别', '低于该级别的任务只入库不打扰。');
  const sev = document.createElement('select');
  sev.className = 'select';
  for (const [v, label] of [['info', '全部记录'], ['need_human', '需处理及以上'], ['blocker', '仅阻塞']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (rules.min_severity === v) o.selected = true;
    sev.appendChild(o);
  }
  sevField.appendChild(sev);

  const cdField = field('冷却时长（秒）', '同一来源在此窗口内的多条任务会合并成一条通知。0 表示不合并。');
  const cd = document.createElement('input');
  cd.className = 'input';
  cd.type = 'number';
  cd.min = '0';
  cd.max = '86400';
  cd.value = String(rules.cooldown_sec ?? 300);
  cdField.appendChild(cd);

  const grField = field('合并维度', '决定哪些任务会被合并。');
  const gr = document.createElement('select');
  gr.className = 'select';
  for (const [v, label] of [['source_session', '按 AI 会话'], ['project', '按项目'], ['none', '不合并']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (rules.group_by === v) o.selected = true;
    gr.appendChild(o);
  }
  grField.appendChild(gr);

  const qhField = field('静默时段', '留空表示不静默。跨零点写法如 23:00 → 08:00。');
  const qh = document.createElement('input');
  qh.className = 'input';
  qh.placeholder = '23:00 - 08:00';
  qh.value = rules.quiet_hours ? `${rules.quiet_hours.start} - ${rules.quiet_hours.end}` : '';
  qhField.appendChild(qh);

  const dgField = field('每日摘要时刻', '留空表示不发送摘要。用于兜底，防止漏掉重要事项。');
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
  save.textContent = '保存规则';
  save.addEventListener('click', async () => {
    let quiet = null;
    const qhText = qh.value.trim();
    if (qhText) {
      const m = /^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/.exec(qhText);
      if (!m) { toast('静默时段格式应为 HH:MM - HH:MM', true); return; }
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
      toast('规则已保存');
    } catch (err) {
      toast(err.message, true);
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
  return { granted: '已允许', denied: '已拒绝', default: '未设置', unsupported: '不支持' }[p] || p;
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
    if (!$('drawer').hidden) closeDrawer();
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

tryLogin();
