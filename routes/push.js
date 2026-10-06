const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired } = require('./auth');
const push = require('../lib/push');

// Публичный ключ нужен браузеру до входа в систему, секрета в нём нет.
router.get('/public-key', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ enabled: push.isEnabled(), key: push.publicKey() });
});

// Сохранить/обновить подписку этого устройства за текущим пользователем.
// Один и тот же endpoint = одно устройство: если на нём вошёл другой человек, подписка переходит к нему.
router.post('/subscribe', authRequired, async (req, res) => {
  const sub = req.body && req.body.subscription;
  const endpoint = sub && sub.endpoint;
  const p256dh = sub && sub.keys && sub.keys.p256dh;
  const auth = sub && sub.keys && sub.keys.auth;
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 2000 || !p256dh || !auth) {
    return res.status(400).json({ error: 'bad_subscription', message: 'Некорректная подписка' });
  }
  const lang = req.body.lang === 'kz' ? 'kz' : 'ru';
  try {
    await query(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, lang, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (endpoint) DO UPDATE
        SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
            lang = EXCLUDED.lang, user_agent = EXCLUDED.user_agent, last_seen_at = NOW()
    `, [req.user.id, endpoint, p256dh, auth, lang, String(req.headers['user-agent'] || '').slice(0, 300)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.post('/unsubscribe', authRequired, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'bad_request' });
  try {
    await query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Тестовое уведомление себе — чтобы проверить, что всё настроено.
router.post('/test', authRequired, async (req, res) => {
  if (!push.isEnabled()) return res.status(503).json({ error: 'push_disabled', message: 'Уведомления не настроены на сервере' });
  const r = await push.notifyUsers([req.user.id], (lang) => lang === 'kz'
    ? { title: 'Хабарландырулар қосылды ✅', body: 'Жаңа курстар мен мерзімдер туралы хабарлама аласыз.', tag: 'test' }
    : { title: 'Уведомления включены ✅', body: 'Вы будете получать сообщения о новых курсах и сроках обучения.', tag: 'test' });
  res.json(r);
});

module.exports = router;
