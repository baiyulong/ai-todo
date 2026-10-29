/* AI Todo Service Worker
 *
 * 职责：
 *   1. 缓存应用壳（HTML / CSS / JS / 图标），让 PWA 离线时仍能打开、仍能注册通知
 *   2. API 请求一律不缓存（尤其 SSE 流不能被代理，否则实时性就没了）
 *   3. 处理 notificationclick：点横幅时聚焦已打开的 AI Todo 窗口，没有就新开一个
 *
 * 注意：Service Worker 是本方案「持久系统级通知」的关键路径。
 * 前端优先用 registration.showNotification() 发通知——它能产生真正的系统级横幅，
 * 且不受页面被浏览器冻结（freezing）的影响；拿不到 SW 时才回退到 new Notification()。
 */

// 资源版本号：应用壳有变更时 +1。
// activate 事件会删掉所有旧版本的 shell 缓存，避免拿到上一版的 app.js / styles.css。
const SHELL_CACHE = 'ai-todo-shell-v2';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 单个资源 404 不应该让整次安装失败
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* 忽略单个资源失败 */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k.startsWith('ai-todo-shell-')).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API 与实时流：完全不介入，走浏览器默认网络行为
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航：优先网络（拿最新代码），断网时回退到缓存的应用壳
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(req));
    return;
  }

  // 静态资源：cache-first（快），后台顺带更新（stale-while-revalidate）
  event.respondWith(handleAsset(req));
});

/**
 * 页面导航：network-first，失败回退到缓存的应用壳。
 *
 * 注意：这里不能写 event.waitUntil(...)：waitUntil 只能在事件派发的同步阶段调用，
 * 在 await 之后调用会抛 InvalidStateError，进而让 respondWith 的 promise reject，
 * 浏览器拿不到脚本与样式，页面就永远是空白。
 */
async function handleNavigate(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(SHELL_CACHE);
    // 后台回填是 best-effort：失败不影响本次响应
    cache.put('/index.html', fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = (await caches.match('/index.html')) || (await caches.match('/'));
    if (cached) return cached;
    return new Response('<h1>离线</h1><p>请连接网络后重试。</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

/**
 * 静态资源：network-first，失败回退缓存。
 *
 * 为什么不用 cache-first：应用壳改过之后，用户第一次刷新拿到的是旧缓存里的
 * app.js / styles.css，要刷新第二次才看到新版。常驻的 PWA 标签页可能因此
 * 一直停留在旧界面上，还以为改了没生效。
 * 本应用跑在 localhost，网络优先几乎没有延迟代价，而「界面永远是最新的」
 * 正是这类常驻工具该有的行为；断网时回退缓存，功能不受影响。
 */
async function handleAsset(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

/* ------------------------------------------------------- 通知点击处理 */

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  notification.close();

  const target = (notification.data && notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientList.find((c) => {
        const u = new URL(c.url);
        return u.origin === self.location.origin;
      });

      if (existing) {
        await existing.focus();
        try {
          if (existing.url !== target) await existing.navigate(target);
        } catch {
          /* 某些浏览器不允许控制已有窗口的导航，忽略即可 */
        }
        if (existing) return;
      }

      await self.clients.openWindow(target);
    })()
  );
});

/* ------------------------------------------------------- Web Push（可选） */

self.addEventListener('push', (event) => {
  let payload = { title: 'AI Todo', body: '有新的待办事项' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    /* 忽略解析失败 */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: (payload.data && payload.data.url) || '/' },
      tag: payload.tag || 'ai-todo-push',
    })
  );
});
