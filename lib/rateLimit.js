// Простой лимитер запросов «по IP» в памяти процесса (без внешних зависимостей).
// Нужен для публичных роутов без авторизации (routes/public.js), чтобы нельзя было
// перебирать/скрейпить public_uid.
//
// Ограничение: счётчики живут в памяти одного процесса. Если сервер запущен в нескольких
// экземплярах, лимит считается на каждый отдельно — для защиты от перебора этого достаточно.
// Реальный IP за прокси (Render) доступен только при app.set('trust proxy', 1) в Server.js.
function createRateLimiter({ windowMs = 60 * 1000, max = 60 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Чистим устаревшие записи, чтобы Map не рос бесконечно.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, Math.max(windowMs, 10 * 1000));
  if (timer.unref) timer.unref();

  function limiter(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(ip, h);
    }
    h.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - h.count)));
    if (h.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((h.resetAt - now) / 1000))));
      return res.status(429).json({ found: false, error: 'too_many_requests' });
    }
    return next();
  }

  limiter.reset = () => hits.clear(); // для тестов
  return limiter;
}

module.exports = { createRateLimiter };
