/* 黑客风专属动态效果：流星雨——细长的荧光尾迹从屏幕上方划落，
 * 淡入淡出、错峰生成，营造「终端夜空」的呼吸感。
 * 纯装饰、不挡交互。尊重系统的 prefers-reduced-motion：要求减少动态时完全不启动。 */

let timer = null;
let layer = null;

export function hackerFxEnabled() {
  return typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function spawnMeteor() {
  if (!layer) return;
  const m = document.createElement('span');
  m.className = 'hacker-meteor';
  // 起点、长度、倾角、速度都随机，避免整齐划一像节拍器
  m.style.left = `${Math.random() * 100}vw`;
  m.style.height = `${70 + Math.random() * 130}px`;
  m.style.rotate = `${8 + Math.random() * 14}deg`;
  m.style.animationDuration = `${1.6 + Math.random() * 1.6}s`;
  m.style.animationDelay = `${Math.random() * 0.4}s`;
  m.addEventListener('animationend', () => m.remove());
  layer.appendChild(m);
}

export function startHackerFx() {
  stopHackerFx();
  if (!hackerFxEnabled()) return;
  layer = document.createElement('div');
  layer.className = 'hacker-rain-layer';
  document.body.appendChild(layer);
  // 开场先撒一小波，之后持续补充，维持满屏三到六颗在飞
  for (let i = 0; i < 4; i++) setTimeout(spawnMeteor, i * 350);
  timer = setInterval(() => {
    spawnMeteor();
    if (Math.random() < 0.55) setTimeout(spawnMeteor, 200 + Math.random() * 700);
  }, 1100);
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
