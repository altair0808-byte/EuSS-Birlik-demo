/* Service worker: установка как приложение + уведомления.
 * Данные (API, файлы, PDF) НЕ кешируются — всё берётся с сервера, чтобы никогда не показывать устаревшее.
 * Единственное, что лежит в кеше, — страница-заглушка на случай, когда нет интернета. */
const VERSION = 'v1';
const CACHE = 'tb-shell-' + VERSION;

const OFFLINE_HTML = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Нет соединения</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}
button{margin-top:16px;padding:10px 20px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:15px}</style></head>
<body><div><h2>Нет соединения с интернетом</h2><p>Для работы нужен интернет.<br>Байланыс жоқ — интернет қажет.</p>
<button onclick="location.reload()">Повторить / Қайталау</button></div></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.put('/__offline', new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tb-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Только переходы по страницам: сеть, а при её отсутствии — заглушка. Всё остальное браузер грузит сам.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  event.respondWith(
    fetch(req).catch(() => caches.match('/__offline').then((r) => r || new Response('Offline', { status: 503 })))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'ТБ / БиОТ';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    lang: data.lang || 'ru',
    data: { url: data.url || '/' }
  };
  // Одинаковый tag заменяет предыдущее уведомление того же типа, а не плодит копии.
  if (data.tag) { options.tag = data.tag; options.renotify = true; }
  // На iPhone каждое push-сообщение ОБЯЗАНО показать уведомление, иначе iOS отключит подписку.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Если приложение уже открыто — просто выводим его на передний план (не сбрасываем, например, идущий тест).
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
