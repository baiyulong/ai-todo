/* AI Todo · 云端备份面板（CloudBase Web SDK V2：匿名登录 + PostgreSQL rdb） */

import cloudbase from './vendor/cloudbase.esm.js';

/* 环境：国内站 · 上海。envId 非机密信息，可暴露在前端；真正的门是安全域名白名单。 */
const CLOUDBASE_ENV = 'sure-vole-d0gfdy5aj5daeaa3b';
const CLOUDBASE_REGION = 'ap-shanghai';
const CLOUDBASE_API_BASE = `https://${CLOUDBASE_ENV}.tcb-api.tencentcloudapi.com/web`;
/** 托管域名：安全域名白名单内的正式入口 */
export const HOSTED_URL = `https://${CLOUDBASE_ENV}-1314460870.tcloudbaseapp.com/cloud.html`;
const TABLE = 'cloud_todos';
const PAGE_SIZE = 50;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(kind, text) {
  statusEl.className = kind;
  statusEl.innerHTML = text;
}

/** 判断当前是否处于容易被拦截的环境（本地文件 / 预览沙箱 / 非托管域名） */
function originWarning() {
  const h = location.hostname;
  if (h === CLOUDBASE_ENV + '-1314460870.tcloudbaseapp.com') return '';
  return (
    `<br>⚠️ 当前页面不是从托管域名打开的（<code>${esc(location.host || h || '本地文件')}</code>）。` +
    `聊天窗口的预览面板和本地打开都可能拦截外发请求——请复制下面的地址到浏览器地址栏直接打开：` +
    `<br><a href="${HOSTED_URL}" target="_blank" rel="noopener" style="color:var(--brand)">${HOSTED_URL}</a>`
  );
}

let app = null;
let db = null;
let cloudRows = [];

$('origin').textContent = location.origin;

/* 不在托管域名上时，开门见山提醒（预览沙箱/本地打开极易被拦） */
if (location.hostname !== CLOUDBASE_ENV + '-1314460870.tcloudbaseapp.com') {
  setStatus('info', 'ℹ️ 当前不是托管域名环境。云端连接请用线上地址：' +
    `<a href="${HOSTED_URL}" target="_blank" rel="noopener" style="color:var(--brand)">${HOSTED_URL}</a>`);
}

/* ---------------------------------------------------------------- 连接 */

async function connect() {
  $('btn-connect').disabled = true;
  setStatus('info', '正在初始化 CloudBase SDK 并匿名登录…');
  try {
    app = cloudbase.init({ env: CLOUDBASE_ENV, region: CLOUDBASE_REGION });
    db = app.rdb();

    const { error } = await app.auth.signInAnonymously();
    if (error) throw new Error(error.message || JSON.stringify(error));

    // 匿名身份展示（拿不到就显示已登录）
    let uid = '已登录';
    try {
      const state = await app.auth.getLoginState();
      uid = state?.user?.uid ?? state?.uid ?? uid;
    } catch { /* 展示性信息，失败不影响使用 */ }
    $('uid').textContent = String(uid).slice(0, 18);

    setStatus('ok', '✔ 匿名登录成功，域名已通过安全校验。');
    for (const id of ['btn-refresh', 'btn-download', 'btn-import']) $(id).disabled = false;
    await refresh();
  } catch (err) {
    // 自动诊断：区分「网络被拦」与「SDK 层错误」
    let probe = '未知';
    try {
      const res = await fetch(CLOUDBASE_API_BASE + '/', { method: 'GET' });
      probe = `可连通（HTTP ${res.status}，说明网络没问题，问题在 SDK/参数层）`;
    } catch (e) {
      const code = e?.cause?.code || e?.cause?.message || e?.message || '';
      probe = `不可达（${code || 'Failed to fetch'}）——浏览器/代理把 ${new URL(CLOUDBASE_API_BASE).hostname} 拦了`;
    }
    const msg = esc(err?.message || String(err));
    setStatus(
      'err',
      '✖ 连接失败：' + msg +
      `<br>直连探测：${esc(probe)}` +
      `<br>常见原因：<br>` +
      `1. 在预览面板/本地环境打开（外发请求被沙箱拦截）——请从托管域名访问；<br>` +
      `2. 浏览器代理或公司网络拦截了 <code>*.tcb-api.tencentcloudapi.com</code>；<br>` +
      `3. 匿名登录未开启（本环境已开启，可排除）。` +
      originWarning(),
    );
    $('btn-connect').disabled = false;
  }
}

/* ---------------------------------------------------------------- 查询 */

async function fetchCount() {
  const { count, error } = await db.from(TABLE).select('*', { count: 'exact', head: true });
  if (error) throw new Error(JSON.stringify(error));
  return count ?? 0;
}

async function fetchRows() {
  const { data, error } = await db.from(TABLE).select().limit(200);
  if (error) throw new Error(JSON.stringify(error));
  return data ?? [];
}

async function refresh() {
  $('btn-refresh').disabled = true;
  setStatus('info', '正在读取云端数据…');
  try {
    const [count, rows] = await Promise.all([fetchCount(), fetchRows()]);
    cloudRows = rows;
    $('cloud-count').textContent = String(count);
    renderRows(rows);
    setStatus('ok', `✔ 已加载 ${rows.length} / ${count} 条（最多展示 200 条）`);
  } catch (err) {
    setStatus('err', '✖ 读取失败：' + (err?.message || err));
  }
  $('btn-refresh').disabled = false;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderRows(rows) {
  const tbody = $('rows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="kv">云端暂无数据（先用 npm run cloud push 备份）</td></tr>';
    return;
  }
  const sorted = [...rows].sort((a, b) =>
    String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  tbody.innerHTML = sorted
    .slice(0, PAGE_SIZE)
    .map((t) => {
      const when = String(t.updated_at ?? '').replace('T', ' ').slice(0, 19);
      return `<tr>
        <td><span class="pill ${esc(t.status)}">${esc(t.status)}</span></td>
        <td class="title" title="${esc(t.title)}">${esc(t.title)}</td>
        <td>${esc(t.project ?? '—')}</td>
        <td>${esc(when)}</td>
      </tr>`;
    })
    .join('');
}

/* ---------------------------------------------------------------- 导出 / 导入 */

function download() {
  const blob = new Blob([JSON.stringify(cloudRows, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cloud_todos-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJson(file) {
  $('btn-import').disabled = true;
  setStatus('info', `正在解析 ${file.name} …`);
  try {
    const parsed = JSON.parse(await file.text());
    const list = Array.isArray(parsed) ? parsed : parsed.tasks;
    if (!Array.isArray(list)) throw new Error('JSON 里没有任务数组（期望数组或 { tasks: [...] }）');

    const existing = new Set(cloudRows.map((r) => String(r.id)));
    const missing = list.filter((t) => t?.id && !existing.has(String(t.id)));
    if (!missing.length) {
      setStatus('ok', `✔ 没有需要导入的行：${list.length} 条全部已存在于云端（幂等跳过）。`);
      return;
    }

    const fields = (t) => ({
      id: String(t.id),
      user_id: String(t.user_id ?? ''),
      title: String(t.title ?? '(无标题)'),
      detail: t.detail ?? null,
      status: t.status ?? 'pending',
      severity: t.severity ?? 'info',
      project: t.project ?? null,
      links: t.links ?? [],
      due_at: t.due_at ?? null,
      created_at: t.created_at ?? null,
      updated_at: t.updated_at ?? null,
    });

    // 分批插入，rdb 单次请求体不宜过大
    let inserted = 0;
    for (let i = 0; i < missing.length; i += 40) {
      const batch = missing.slice(i, i + 40).map(fields);
      const { error } = await db.from(TABLE).insert(batch);
      if (error) throw new Error(JSON.stringify(error).slice(0, 300));
      inserted += batch.length;
    }
    setStatus('ok', `✔ 导入完成：新插 ${inserted} 条，跳过已存在 ${list.length - missing.length} 条。`);
    await refresh();
  } catch (err) {
    setStatus('err', '✖ 导入失败：' + (err?.message || err));
  }
  $('btn-import').disabled = false;
}

/* ---------------------------------------------------------------- 事件 */

$('btn-connect').addEventListener('click', connect);
$('btn-refresh').addEventListener('click', refresh);
$('btn-download').addEventListener('click', download);
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importJson(file).finally(() => (e.target.value = ''));
});
