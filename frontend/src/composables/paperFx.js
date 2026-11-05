/* 工程纸主题专属动态效果：秋风卷落叶（点击触发）。
 * 左下角有一块看不见的热区，点一下起一阵风——
 * 大卷风线贴着屏幕底部扫过，几片秋叶翻滚着飘过。
 * 没有纸角、不自动吹风；纯装饰、不挡交互；尊重系统的 prefers-reduced-motion。 */

import { t } from '../i18n.js';

let layer = null;
let timers = [];
let hotspot = null;

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

export function startPaperFx() {
  stopPaperFx();
  if (!paperFxEnabled()) return;
  layer = document.createElement('div');
  layer.className = 'paper-fx-layer';
  hotspot = document.createElement('span');
  hotspot.className = 'paper-wind-hotspot';
  hotspot.title = t('fx.paperCornerHint');
  hotspot.addEventListener('click', gust);
  layer.appendChild(hotspot);
  document.body.appendChild(layer);
}

export function stopPaperFx() {
  for (const id of timers) clearTimeout(id);
  timers = [];
  if (layer) {
    layer.remove();
    layer = null;
  }
  hotspot = null;
}
