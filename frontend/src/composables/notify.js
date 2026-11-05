/* 通知通道：提示音（Web Audio 合成）、桌面通知、Service Worker、权限状态 */

import { ref } from 'vue';
import { t } from '../i18n.js';
import { useUiStore } from '../stores/ui.js';

/* ---------------------------------------------------------------- 提示音 */

let notifyAudioCtx = null;

/**
 * 用 Web Audio 现场合成两声短音（A5 → D6），不引音频文件：
 * 横幅本身可能被系统吞掉或延迟，声音是独立的提醒通道，得自己保证响。
 *
 * 浏览器规定 AudioContext 必须在用户交互之后才能出声——
 * 登录那一下点击就满足了；万一被挂起就尝试 resume，实在不行静默失败。
 */
export function playNotifySound() {
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

/* ------------------------------------------------------- Service Worker */

export async function registerServiceWorker() {
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
export async function getActiveRegistration() {
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

/* ------------------------------------------------------- 桌面通知 */

export async function showDesktopNotification(payload) {
  const ui = useUiStore();
  const title = payload.title || 'AI Todo';
  const body = payload.body || '';

  if (!('Notification' in window) || ui.notifyPerm !== 'granted') {
    ui.toast(`${title}${body ? '：' + body.split('\n')[0] : ''}`);
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

/* ------------------------------------------------------- 权限状态 */

/**
 * 通知权限状态的权威来源。
 *
 * 不能直接用 Notification.permission：它是页面加载时的快照，用户在浏览器
 * 地址栏（站点权限）里把通知改成「允许」后，这个值经常停留在旧的 denied。
 * Permissions API 才是实时值，还带 onchange 回调——权限一变，横幅和抽屉
 * 立即跟上，不需要刷新页面。
 */
export async function refreshNotifyPermission() {
  const ui = useUiStore();
  if (!('Notification' in window)) {
    ui.setNotifyPerm('unsupported');
    return;
  }
  try {
    const st = await navigator.permissions.query({ name: 'notifications' });
    ui.setNotifyPerm(st.state);
    st.onchange = () => ui.setNotifyPerm(st.state);
  } catch {
    // 个别浏览器不支持 notifications 这个 PermissionName：退回同步快照
    ui.setNotifyPerm(Notification.permission);
  }
}

/** 「开启通知」按钮：申请权限 + 注册 SW + 发一条测试横幅确认端到端可用 */
export async function requestNotifyPermission() {
  const ui = useUiStore();
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  await refreshNotifyPermission();
  if (perm === 'granted') {
    ui.notifyBannerDismissed.value = false;
    ui.toast(t('notify.enabledToast'));
    await registerServiceWorker();
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
  }
}
