/* 黑客风专属动态效果：每隔几秒一串乱码字符缓缓划过屏幕。
 * 纯装饰、低频率、低透明度——不抢内容，只给一点「终端活着」的呼吸感。
 * 尊重系统的 prefers-reduced-motion：用户要求减少动态时完全不启动。 */

let timer = null;
let layer = null;

const GLYPHS = 'アイウエオカキクケコサシスセソタチツテト0123456789ABCDEF<>[]{}#$%&*+=~';

function spawnColumn() {
  if (!layer) return;
  const col = document.createElement('span');
  col.className = 'hacker-rain-col';
  let text = '';
  const len = 10 + Math.floor(Math.random() * 16);
  for (let i = 0; i < len; i++) text += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  col.textContent = text;
  col.style.left = `${2 + Math.random() * 94}vw`;
  col.style.animationDuration = `${6 + Math.random() * 5}s`;
  col.style.fontSize = `${15 + Math.random() * 6}px`;
  col.addEventListener('animationend', () => col.remove());
  layer.appendChild(col);
}

export function hackerFxEnabled() {
  return typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function startHackerFx() {
  stopHackerFx();
  if (!hackerFxEnabled()) return;
  layer = document.createElement('div');
  layer.className = 'hacker-rain-layer';
  document.body.appendChild(layer);
  spawnColumn();
  // 每 5 秒一串，偶尔叠一发错开节奏，避免太规律像节拍器
  timer = setInterval(() => {
    spawnColumn();
    if (Math.random() < 0.35) setTimeout(spawnColumn, 800 + Math.random() * 1500);
  }, 5000);
}

export function stopHackerFx() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (layer) {
    layer.remove();
    layer = null;
  }
}
