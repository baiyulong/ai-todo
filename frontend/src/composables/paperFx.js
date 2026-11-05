/* 工程纸主题专属动态效果：秋风卷落叶（点击左下角触发）。
 *
 * 不再放拦截点击的热区元素——那会挡住滚动到左下角的表单控件
 * （转交下拉、回复框都点不动）。改用 document 捕获阶段监听：
 * 点击落在左下角三角区域、且目标不是任何可交互元素时才起一阵风，
 * 其余点击原样穿透，原生控件行为不受影响。
 * 大卷风线贴着屏幕底部扫过，几片秋叶翻滚着飘过；
 * 纯装饰；尊重系统的 prefers-reduced-motion。 */

let layer = null;
let timers = [];
let onDocClick = null;
let onDocMove = null;

/** 左下角触发区边长（px），斜边为直线 x + y = viewport 高度 */
const CORNER = 150;

/** 命中这些元素及其子元素时不触发起风，让点击走原生行为 */
const INTERACTIVE_SELECTOR =
  'select, input, textarea, button, a, label, [contenteditable], dialog, .user-menu, .drawer, .modal';

export function paperFxEnabled() {
  return typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const LEAF_COLORS = ['#c98a3d', '#b5651d', '#a0522d', '#d4a017', '#8f5a2b'];

function later(fn, ms) {
  timers.push(setTimeout(fn, ms));
}

/* 风线：一道大弧贴着屏幕底部扫过，末端带一个打转的「卷」 */
function spawnWindLine() {
  if (!layer) return;
  const w = document.createElement('span');
  w.className = 'paper-wind';
  w.style.bottom = `${6 + Math.random() * 20}vh`;
  w.style.width = `${280 + Math.random() * 260}px`;
  w.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
  const curl = document.createElement('i');
  const size = 26 + Math.random() * 16;
  curl.style.width = `${size}px`;
  curl.style.height = `${size}px`;
  w.appendChild(curl);
  w.addEventListener('animationend', () => w.remove());
  layer.appendChild(w);
}

/* 落叶：外层管横向行程与整体起伏，内层管翻滚摇摆 */
function spawnLeaf() {
  if (!layer) return;
  const leaf = document.createElement('span');
  leaf.className = 'paper-leaf';
  leaf.style.bottom = `${4 + Math.random() * 28}vh`;
  leaf.style.animationDuration = `${4 + Math.random() * 3.5}s`;
  leaf.style.animationDelay = `${Math.random() * 0.8}s`;
  const inner = document.createElement('i');
  inner.style.background = LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)];
  const size = 10 + Math.random() * 8;
  inner.style.width = `${size}px`;
  inner.style.height = `${size}px`;
  inner.style.animationDuration = `${1.2 + Math.random() * 1.2}s`;
  leaf.appendChild(inner);
  leaf.addEventListener('animationend', () => leaf.remove());
  layer.appendChild(leaf);
}

/* 一阵风：风线与落叶错峰掠过 */
function gust() {
  if (!layer) return;
  const lines = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < lines; i++) later(spawnWindLine, 200 + i * (250 + Math.random() * 350));
  const leaves = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < leaves; i++) later(spawnLeaf, 300 + i * (180 + Math.random() * 300));
}

function inCornerTriangle(x, y) {
  const vh = window.innerHeight;
  return x >= 0 && y >= vh - CORNER && x + y <= vh;
}

function isInteractiveTarget(target) {
  return !!(target instanceof Element && target.closest(INTERACTIVE_SELECTOR));
}

export function startPaperFx() {
  stopPaperFx();
  if (!paperFxEnabled()) return;
  layer = document.createElement('div');
  layer.className = 'paper-fx-layer';
  document.body.appendChild(layer);

  onDocClick = (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (isInteractiveTarget(e.target)) return;
    // 正在拖选文字的点击不抢戏
    const sel = window.getSelection?.();
    if (sel && String(sel).length > 0) return;
    if (inCornerTriangle(e.clientX, e.clientY)) gust();
  };
  document.addEventListener('click', onDocClick, true);

  // 悬停在可触发区域时给 pointer 光标提示（纯光标变化，不拦截任何事件）
  onDocMove = (e) => {
    const hot = inCornerTriangle(e.clientX, e.clientY) && !isInteractiveTarget(e.target);
    document.body.style.cursor = hot ? 'pointer' : '';
  };
  document.addEventListener('mousemove', onDocMove);
}

export function stopPaperFx() {
  for (const id of timers) clearTimeout(id);
  timers = [];
  if (onDocClick) document.removeEventListener('click', onDocClick, true);
  if (onDocMove) {
    document.removeEventListener('mousemove', onDocMove);
    document.body.style.cursor = '';
  }
  onDocClick = null;
  onDocMove = null;
  if (layer) {
    layer.remove();
    layer = null;
  }
}
