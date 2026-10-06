// Постоянный публичный идентификатор сотрудника (users.public_uid) — то, что зашито в QR
// единого удостоверения: https://<домен>/p/P-K7M2Q9XW4B
//
// Формат: "P-" + 10 символов A–Z / 0–9. Генератор берёт алфавит без похожих знаков
// (нет 0/O, 1/I/L) — это ~50 бит случайности, перебором не подобрать. Проверка формата
// (isValidPublicUid) намеренно шире алфавита генератора: значения, которые база создаёт
// сама через DEFAULT (см. db.js), тоже проходят.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PREFIX = 'P-';
const BODY_LEN = 10;
const RE = /^P-[A-Z0-9]{10}$/;

function generatePublicUid() {
  let body = '';
  for (let i = 0; i < BODY_LEN; i += 1) {
    body += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return PREFIX + body;
}

function isValidPublicUid(uid) {
  return typeof uid === 'string' && RE.test(uid);
}

module.exports = { generatePublicUid, isValidPublicUid, PUBLIC_UID_RE: RE };
