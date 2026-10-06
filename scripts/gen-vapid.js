// Генерация VAPID-ключей для веб-пушей (без зависимостей, только встроенный crypto).
// Запуск:  node scripts/gen-vapid.js
// Результат вставьте в переменные окружения (Render → Environment) и в .env:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
const crypto = require('crypto');
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const b64u = (b) => Buffer.from(b).toString('base64url');
const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
console.log('VAPID_PUBLIC_KEY=' + b64u(pub));
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
console.log('VAPID_SUBJECT=mailto:admin@example.com   # замените на свою почту или https-адрес сайта');
