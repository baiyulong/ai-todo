/* 工程纸主题专属动态效果：秋风卷落叶。
 * 每隔一阵，风从左侧吹过——弧形风线掠过屏幕中段、几片秋叶翻滚着飘过，
 * 左下角的「纸角」被风掀起卷动一下再落回。
 * 纯装饰、不挡交互、低频率；尊重系统的 prefers-reduced-motion。 */

let layer = null;
let timers = [];

export function paperFxEnabled() {
  return typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const LEAF_COLORS = ['#c98a3d', '#b5651d', '#a0522d', '#d4a017', '#8f5a2b'];

function later(fn, ms) {
  timers.push(setTimeout(fn, ms));
}

/* 风线：一道弧形细线从左扫到右，淡入淡出 */
function spawnWindLine() {
  if (!layer) return;
  const w = document.createElement('span');
  w.className = 'paper-wind';
  w.style.top = `${15 + Math.random() * 55}vh`;
  w.style.width = `${120 + Math.random() * 140}px`;
  w.style.animationDuration = `${2.4 + Math.random() * 1.8}s`;
  w.addEventListener('animationend', () => w.remove());
  layer.appendChild(w);
}

/* 落叶：外层管横向行程与整体起伏，内层管翻滚摇摆 */
function spawnLeaf() {
  if (!layer) return;
  const leaf = document.createElement('span');
  leaf.className = 'paper-leaf';
  leaf.style.top = `${5 + Math.random() * 60}vh`;
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

/* 纸角：左下角被风掀起、抖两下、再落回 */
function liftCorner() {
  if (!layer) return;
  const corner = document.createElement('span');
  corner.className = 'paper-corner';
  corner.addEventListener('animationend', () => corner.remove());
  layer.appendChild(corner);
}

/* 一阵风：纸角先起，风线与落叶随后错峰掠过 */
function gust() {
  if (!layer) return;
  liftCorner();
  const lines = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < lines; i++) later(spawnWindLine, 200 + i * (250 + Math.random() * 350));
  const leaves = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < leaves; i++) later(spawnLeaf, 300 + i * (180 + Math.random() * 300));
}

export function startPaperFx() {
  stopPaperFx();
  if (!paperFxEnabled()) return;
  layer = document.createElement('div');
  layer.className = 'paper-fx-layer';
  document.body.appendChild(layer);
  // 进主题稍等片刻迎来第一阵风，之后每 9~15 秒一阵
  later(gust, 2500);
  const schedule = (delay) => {
    timers.push(
      setTimeout(() => {
        gust();
        schedule(9000 + Math.random() * 6000);
      }, delay),
    );
  };
  schedule(11500);
}

export function stopPaperFx() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  if (layer) {
    layer.remove();
    layer = null;
  }
}
