const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { initDb, restoreExpiredLeaves } = require('./db');

const app = express();
// За прокси Render реальный IP клиента приходит в X-Forwarded-For; без этого req.ip — адрес прокси
// и лимитер публичных роутов (lib/rateLimit.js) считал бы всех посетителей одним.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(cors());
// Увеличенный лимит нужен, т.к. логотип/печать/подписи теперь передаются
// как base64 прямо в JSON-теле запроса (см. routes/settings.js).
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Логотип/печать/подписи/материалы/видео курсов теперь загружаются в Supabase
// Storage (см. supabaseStorage.js, routes/settings.js, routes/courses.js) и не
// хранятся на локальном диске сервера — он не persistent на большинстве хостингов.
// Папка 'imports' оставлена для временного чтения Excel-файла импорта сотрудников
// (routes/users.js), он не хранится долгосрочно.
fs.mkdirSync(path.join(__dirname, 'uploads', 'imports'), { recursive: true });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// ВАЖНО: корень проекта больше НЕ раздаётся как статика. Раньше `express.static(__dirname)` отдавал
// по прямой ссылке любой файл из корня (db.js, Server.js, package.json, любые случайные файлы
// вроде «download» с логином/паролем суперадмина и т.п.). Фронтенд ничего из корня не подгружает:
// index.html / verify.html / person.html отдаются ниже явными роутами, остальное берётся с CDN.

// Подключение роутов
const { router: authRouter } = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api/users', require('./routes/users'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/assignments', require('./routes/assignments'));
// Массовое обновление через Excel: выгрузка сотрудников -> новое обучение -> загрузка обратно
app.use('/api/bulk-training', require('./routes/bulkTraining'));
// Группы обучения: записать сразу много сотрудников на курс и разом отметить, что они прошли (в т.ч. курс без протокола)
app.use('/api/training-sessions', require('./routes/trainingSessions'));
app.use('/api/protocols', require('./routes/protocols'));
// Курсы по должностям: привязка курсов к должностям, Excel-матрица, автозапись
app.use('/api/course-positions', require('./routes/coursePositions'));
// Личные медицинские книжки (санкнижки): должности, сроки, статистика
app.use('/api/medbooks', require('./routes/medbooks'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/export', require('./routes/export'));
app.use('/api/certificates', require('./routes/certificate'));
// Удостоверения — отдельный документ, не сертификат (см. idCardService.js)
app.use('/api/id-cards', require('./routes/idCards'));
// Публичные данные сотрудника по общему QR (без авторизации, с лимитом запросов)
app.use('/api/public', require('./routes/public'));
app.use('/api/signatures', require('./routes/signatures'));
// Журнал действий администраторов/ассистентов (только суперадмин)
app.use('/api/audit', require('./routes/audit'));
// Запасное хранилище в Google Drive: статус, «Выгрузить всё» (только суперадмин)
app.use('/api/drive', require('./routes/drive'));
// Веб-пуши: ключ, подписка устройства, тестовое уведомление (lib/push.js)
app.use('/api/push', require('./routes/push'));

// Иконка сайта (favicon). Корень проекта не раздаётся как статика, а catch-all `app.get('*')` ниже отдаёт
// index.html на любой неизвестный путь — поэтому иконки отдаются явно и ДО него. /favicon.ico нужен тем
// браузерам и программам, которые просят его по умолчанию, не читая теги <link>.
const ICONS_DIR = path.join(__dirname, 'assets', 'icons');
// Запасная папка: при загрузке на GitHub иконки уже оказывались в assets/fonts/icons/ — без неё манифест
// ссылался на несуществующие файлы, и телефон добавлял на экран «Домой» обычную закладку (сайт в браузере).
const ICONS_DIR_FALLBACK = path.join(__dirname, 'assets', 'fonts', 'icons');
app.use('/icons', express.static(ICONS_DIR, { maxAge: '7d' }));
app.use('/icons', express.static(ICONS_DIR_FALLBACK, { maxAge: '7d' }));
// Если файла иконки нет на сервере — честный 404, а не index.html из catch-all (иначе браузер получает HTML вместо картинки).
app.use('/icons', (req, res) => res.status(404).end());
app.get('/favicon.ico', (req, res) => {
  let f = path.join(ICONS_DIR, 'favicon.ico');
  if (!fs.existsSync(f)) f = path.join(ICONS_DIR_FALLBACK, 'favicon.ico');
  if (!fs.existsSync(f)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(f);
});

// PWA: манифест (установка на Android/iOS как приложения) и service worker (уведомления + офлайн-заглушка).
// sw.js отдаётся с корня и без кеша — иначе обновления приложения подхватываются с задержкой.
app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Публичная страница проверки подлинности удостоверения (QR-код на удостоверении
// ведёт сюда) — отдельная лёгкая статическая страница, без авторизации и без
// загрузки всего SPA (index.html). Данные подтягивает сама через
// GET /api/certificates/verify/:uid (см. routes/certificate.js).
app.get('/verify/:uid', (req, res) => {
  res.sendFile(path.join(__dirname, 'verify.html'));
});

// Публичная страница сотрудника — сюда ведёт ОБЩИЙ QR на всех его удостоверениях
// (public_uid вида P-XXXXXXXXXX, см. lib/publicUid.js). Как и /verify/:uid — лёгкая статическая
// страница без авторизации и без загрузки всего SPA; данные она берёт сама через
// GET /api/public/person/:uid (routes/public.js: лимит запросов с IP, только публичные поля).
// Пока этот файл лежит в корне проекта, routes/idCards.js кладёт в QR именно /p/<public_uid>.
app.get('/p/:uid', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'person.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск после подключения и проверки таблиц в Supabase
initDb()
  .then(async () => {
    // Демо-режим: если задано DEMO_SEED=yes, один раз наполняет базу вымышленными данными
    if (process.env.DEMO_SEED === 'yes') {
      try { await require('./scripts/seed-demo').runSeed(require('./db').pool); }
      catch (e) { console.error('[demo] не удалось наполнить демо-данными:', e.message); }
    }
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ TB Training Platform запущен на порту ${PORT} (база данных Supabase)`);
      // Автовозврат сотрудников из отпуска после даты окончания (при старте и далее раз в час)
      restoreExpiredLeaves();
      setInterval(restoreExpiredLeaves, 60 * 60 * 1000);
      // Фоновая отправка файлов в Google Drive (если заданы GDRIVE_*); сайт от неё не зависит
      // Прогрев конвертера PDF (создаёт профиль LibreOffice заранее), чтобы первый «Скачать PDF» не ждал
      setTimeout(() => { try { require('./protocolPdf').warmUpPdfConverter(); } catch (e) { /* ignore */ } }, 20000);
      // Напоминания о сроках обучения по пушам (если заданы VAPID_*)
      try { require('./lib/push').startReminderWorker(); } catch (e) { console.error('[push] не удалось запустить напоминания:', e.message); }
      try { require('./driveSync').startWorker(); } catch (e) { console.error('[drive] не удалось запустить воркер:', e.message); }
    });
  })
  .catch(err => {
    console.error('Ошибка подключения к базе данных Supabase:', err);
    process.exit(1);
  });
