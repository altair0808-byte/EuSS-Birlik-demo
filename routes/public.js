// ПУБЛИЧНЫЕ роуты (без авторизации).
//
//   GET /api/public/person/:uid — данные сотрудника по постоянному public_uid: на него ведёт
//                                 общий QR на всех его удостоверениях (страница /p/:uid).
//
// В ответе только то, что печатается на бланке и нужно для проверки: ФИО, должность,
// подразделение, работодатель, общий статус и список обучений (см. personService.toPublicPayload).
// Никаких id, логина, телефона, ИИН и т.п. Статусы считаются на момент запроса.
//
// Старые /api/certificates/verify/:uid и /api/id-cards/verify/:uid (BIOT-…, UD-…) не затронуты.
const express = require('express');
const router = express.Router();
const { getPublicProfile } = require('../personService');
const { isValidPublicUid } = require('../lib/publicUid');
const { createRateLimiter } = require('../lib/rateLimit');

// 60 запросов в минуту с одного IP: человеку хватает с запасом, перебор/скрейпинг режется.
const limiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

async function personHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const uid = String(req.params.uid || '');
  // Невалидный формат отсекаем без запроса в БД; ответ такой же, как для несуществующего.
  if (!isValidPublicUid(uid)) return res.status(404).json({ found: false });
  try {
    const payload = await getPublicProfile(uid);
    if (!payload) return res.status(404).json({ found: false });
    res.json(payload);
  } catch (e) {
    console.error('Public person error:', e);
    res.status(500).json({ found: false, error: 'server_error' });
  }
}

router.get('/person/:uid', limiter, personHandler);

module.exports = router;
module.exports.personHandler = personHandler; // для тестов
module.exports.limiter = limiter;
