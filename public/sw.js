/**
 * 麦麦省 · Service Worker
 *
 * 只在 https / localhost 下注册（局域网 http 页面本来就不允许注册 SW）。
 * 策略刻意保守：
 *   · /api/** 一律不缓存（算价结果必须实时）；
 *   · 导航请求 network-first（界面永远优先拿新的，离线才回退缓存）；
 *   · 静态资源 stale-while-revalidate（图标/CSS/JS 秒开，同时后台更新）。
 */
const VERSION = 'mcd-v1';
const STATIC_CACHE = `${VERSION}-static`;

const PRECACHE = ['/', '/index.html', '/app.js', '/render.js', '/style.css', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 实时数据绝不缓存

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          caches.open(STATIC_CACHE).then((c) => c.put('/index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200) caches.open(STATIC_CACHE).then((c) => c.put(request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
