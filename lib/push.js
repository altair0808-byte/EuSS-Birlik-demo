// Веб-пуши (Web Push, протокол VAPID): уведомления на телефон/ПК, в том числе когда приложение закрыто.
// Работает на Android (Chrome и др.) и на iPhone/iPad (iOS 16.4+, только если сайт добавлен «На экран Домой»).
//
// Включается переменными окружения VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
// (ключи: `node scripts/gen-vapid.js`). Без них сайт работает как раньше, а пуши тихо отключены.
// Любая ошибка отправки только пишется в лог — основное действие (назначение курса и т.п.) она не ломает.
const { query } = require('../db');

let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.warn('[push] пакет web-push не установлен — уведомления отключены'); }

const PUB = (process.env.VAPID_PUBLIC_KEY || '').trim();
const PRIV = (process.env.VAPID_PRIVATE_KEY || '').trim();
const SUBJECT = (process.env.VAPID_SUBJECT || process.env.PUBLIC_BASE_URL || 'mailto:admin@example.com').trim();

let enabled = false;
if (webpush && PUB && PRIV) {
  try {
    webpush.setVapidDetails(SUBJECT, PUB, PRIV);
    enabled = true;
  } catch (e) {
    console.error('[push] неверные VAPID-ключи/субъект, уведомления отключены:', e.message);
  }
} else if (webpush) {
  console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY не заданы — уведомления отключены');
}

function isEnabled() { return enabled; }
function publicKey() { return enabled ? PUB : ''; }

// build(lang) -> { title, body, url?, tag? } — текст на языке, который выбран на устройстве получателя.
async function notifyUsers(userIds, build) {
  const result = { sent: 0, failed: 0, removed: 0 };
  if (!enabled) return result;
  const ids = [...new Set((userIds || []).map(Number))].filter(Number.isFinite);
  if (!ids.length) return result;
  let subs;
  try {
    subs = (await query(
      'SELECT id, endpoint, p256dh, auth, lang FROM push_subscriptions WHERE user_id = ANY($1::bigint[])', [ids]
    )).rows;
  } catch (e) {
    console.error('[push] не удалось прочитать подписки:', e.message);
    return result;
  }
  await Promise.all(subs.map(async (s) => {
    const p = build(s.lang === 'kz' ? 'kz' : 'ru');
    const body = JSON.stringify({ url: '/', ...p, lang: s.lang === 'kz' ? 'kk' : 'ru' });
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 60 * 60 * 24, urgency: 'normal' }
      );
      result.sent++;
    } catch (e) {
      // 404/410 — подписка больше не существует (приложение удалено, разрешение отозвано): чистим
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        result.removed++;
        try { await query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); } catch (_) { /* ignore */ }
      } else {
        result.failed++;
        console.error('[push] ошибка отправки:', e && (e.statusCode || e.message));
      }
    }
  }));
  return result;
}

async function courseTitles(courseId) {
  try {
    const r = await query('SELECT title_ru, title_kz FROM courses WHERE id = $1', [courseId]);
    const c = r.rows[0] || {};
    return { ru: c.title_ru || '', kz: c.title_kz || c.title_ru || '' };
  } catch (e) { return { ru: '', kz: '' }; }
}

// Сотрудникам назначили курс (обычное назначение, не «историческая» запись)
async function notifyCourseAssigned(userIds, courseId) {
  try {
    const c = await courseTitles(courseId);
    return await notifyUsers(userIds, (lang) => lang === 'kz'
      ? { title: 'Жаңа курс тағайындалды', body: c.kz || 'Сізге оқу курсы тағайындалды', tag: 'assigned-' + courseId }
      : { title: 'Назначен новый курс', body: c.ru || 'Вам назначен курс обучения', tag: 'assigned-' + courseId });
  } catch (e) { console.error('[push] notifyCourseAssigned:', e.message); }
}

// Разрешена пересдача
async function notifyRetakeAllowed(assignmentId) {
  try {
    const a = await query('SELECT user_id, course_id FROM assignments WHERE id = $1', [assignmentId]);
    if (!a.rows[0]) return;
    const c = await courseTitles(a.rows[0].course_id);
    return await notifyUsers([a.rows[0].user_id], (lang) => lang === 'kz'
      ? { title: 'Қайта тапсыруға рұқсат', body: c.kz, tag: 'retake-' + assignmentId }
      : { title: 'Разрешена пересдача', body: c.ru, tag: 'retake-' + assignmentId });
  } catch (e) { console.error('[push] notifyRetakeAllowed:', e.message); }
}

// Напоминания о скором окончании срока действия обучения: за 30 дней, за 7 дней и когда срок истёк.
// Каждое напоминание по конкретной записи уходит один раз (таблица push_log).
async function runExpiryReminders() {
  if (!enabled) return 0;
  let rows;
  try {
    rows = (await query(`
      SELECT a.id, a.user_id, c.title_ru, c.title_kz,
             (a.next_test_date::timestamptz::date - CURRENT_DATE) AS days_left
      FROM assignments a
      JOIN users u ON u.id = a.user_id
      JOIN courses c ON c.id = a.course_id
      WHERE u.role = 'employee' AND u.active = 1
        AND a.status = 'passed'
        AND a.next_test_date IS NOT NULL AND a.next_test_date <> ''
        AND c.no_expiry = FALSE
        AND a.next_test_date::timestamptz <= NOW() + INTERVAL '30 days'
        AND a.next_test_date::timestamptz >= NOW() - INTERVAL '30 days'
        AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = a.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM assignments n
          WHERE n.user_id = a.user_id AND n.course_id = a.course_id AND n.status = 'passed'
            AND (COALESCE(n.test_date, '') > COALESCE(a.test_date, '')
                 OR (COALESCE(n.test_date, '') = COALESCE(a.test_date, '') AND n.id > a.id))
        )
    `)).rows;
  } catch (e) {
    console.error('[push] напоминания о сроках: ошибка запроса:', e.message);
    return 0;
  }
  let n = 0;
  for (const r of rows) {
    const d = Number(r.days_left);
    const kind = d <= 0 ? 'exp0' : d <= 7 ? 'exp7' : 'exp30';
    try {
      const ins = await query(
        'INSERT INTO push_log (assignment_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [r.id, kind]);
      if (!ins.rows[0]) continue; // это напоминание уже отправляли
      await notifyUsers([r.user_id], (lang) => {
        const title = lang === 'kz' ? r.title_kz || r.title_ru : r.title_ru;
        if (kind === 'exp0') return lang === 'kz'
          ? { title: 'Оқу мерзімі өтті', body: title, tag: 'exp-' + r.id }
          : { title: 'Срок обучения истёк', body: title, tag: 'exp-' + r.id };
        return lang === 'kz'
          ? { title: `Оқу мерзімі ${d} күннен кейін аяқталады`, body: title, tag: 'exp-' + r.id }
          : { title: `Срок обучения истекает через ${d} дн.`, body: title, tag: 'exp-' + r.id };
      });
      n++;
    } catch (e) { console.error('[push] напоминание:', e.message); }
  }
  return n;
}

// Напоминания о сроке личной медицинской книжки: за 30 и 7 дней и когда срок истёк (каждое — один раз на срок).
async function runMedbookReminders() {
  if (!enabled) return 0;
  let entries;
  try { entries = await require('./medbook').loadEntries({}); }
  catch (e) { console.error('[push] мед. книжки: ошибка запроса:', e.message); return 0; }
  let n = 0;
  for (const r of entries) {
    if (r.status !== 'soon' && r.status !== 'overdue') continue;
    const d = Number(r.days_left);
    const kind = d < 0 ? 'mb0' : d <= 7 ? 'mb7' : 'mb30';
    try {
      const has = await query('SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1', [r.user_id]);
      if (!has.rows[0]) continue;
      const ins = await query(
        'INSERT INTO medbook_push_log (user_id, expires, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [r.user_id, r.expires, kind]);
      if (!ins.rows[0]) continue;
      await notifyUsers([r.user_id], (lang) => {
        if (kind === 'mb0') return lang === 'kz'
          ? { title: 'Медициналық кітапшаның мерзімі өтті', body: 'Жаңартыңыз', tag: 'mb-' + r.user_id }
          : { title: 'Срок медицинской книжки истёк', body: 'Необходимо обновить санкнижку', tag: 'mb-' + r.user_id };
        return lang === 'kz'
          ? { title: `Медициналық кітапша ${d} күннен кейін аяқталады`, body: 'Алдын ала жаңартыңыз', tag: 'mb-' + r.user_id }
          : { title: `Медицинская книжка истекает через ${d} дн.`, body: 'Заранее обновите санкнижку', tag: 'mb-' + r.user_id };
      });
      n++;
    } catch (e) { console.error('[push] напоминание о мед. книжке:', e.message); }
  }
  return n;
}

// Проверка раз в час, отправка — только в рабочие часы по местному времени (PUSH_TZ, по умолчанию Атырау),
// чтобы напоминания не будили людей ночью.
function startReminderWorker() {
  if (!enabled) return;
  const tz = process.env.PUSH_TZ || 'Asia/Atyrau';
  const tick = () => {
    let hour = 12;
    try { hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())); } catch (e) { /* неизвестная зона — не блокируем */ }
    if (hour >= 9 && hour < 18) {
      runExpiryReminders().catch(e => console.error('[push]', e.message));
      runMedbookReminders().catch(e => console.error('[push]', e.message));
    }
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 60 * 60 * 1000);
}

module.exports = { isEnabled, publicKey, notifyUsers, notifyCourseAssigned, notifyRetakeAllowed, runExpiryReminders, runMedbookReminders, startReminderWorker };
