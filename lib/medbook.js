// Личные медицинские книжки (санкнижки): расчёт сроков и статусов.
//
// Правила:
//   • Книжка нужна сотруднику, если его «Объект → Отдел → Должность» отмечена в таблице medbook_positions
//     (там же задан период: 6 или 12 месяцев). Период берётся ИЗ ДОЛЖНОСТИ.
//   • Можно отдельно внести книжку любому сотруднику независимо от должности (medbook_records.manual = TRUE),
//     тогда период хранится в самой записи.
//   • Если книжка по должности не требуется и записи нет — сотруднику она нигде не показывается.
//   • Срок действия = дата начала + период (месяцев). Статусы: no_date | valid | soon (≤ 30 дн.) | overdue.
const { query } = require('../db');
const { keyOf } = require('./positionCourses');

const SOON_DAYS = 30;

function todayYmd() {
  const tz = process.env.PUSH_TZ || 'Asia/Atyrau';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}

function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')); }

function ymdToUtc(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }

// Дата + N месяцев (с «прижатием» к последнему дню месяца: 31.08 + 6 мес = 28.02)
function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const total = (m - 1) + n;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const dd = Math.min(d, dim);
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function calcStatus(startDate, periodMonths, today) {
  if (!startDate || !periodMonths) return { status: 'no_date', expires: null, days_left: null };
  const expires = addMonths(startDate, periodMonths);
  const daysLeft = Math.round((ymdToUtc(expires) - ymdToUtc(today)) / 86400000);
  const status = daysLeft < 0 ? 'overdue' : daysLeft <= SOON_DAYS ? 'soon' : 'valid';
  return { status, expires, days_left: daysLeft };
}

async function positionPeriods() {
  const r = await query('SELECT key, period_months FROM medbook_positions');
  const map = new Map();
  r.rows.forEach((x) => map.set(x.key, Number(x.period_months)));
  return map;
}

// Строка сотрудника -> итог по санкнижке или null, если книжка этому сотруднику не нужна
function buildEntry(u, periods, today) {
  const posPeriod = periods.get(keyOf(u.object, u.department, u.position)) || null;
  const hasRecord = !!u.mb_id;
  if (!posPeriod && !hasRecord) return null;
  const period = posPeriod || Number(u.mb_period) || 12;
  const st = calcStatus(u.mb_start || null, period, today);
  return {
    user_id: Number(u.id),
    last_name: u.last_name, first_name: u.first_name,
    object: u.object, department: u.department, position: u.position,
    staff_category: u.staff_category || 'employee',
    required: !!posPeriod,          // нужна по должности
    manual: !posPeriod,             // добавлена вручную, вне должности
    period_months: period,
    start_date: u.mb_start || null,
    ...st
  };
}

const SELECT_USERS = `
  SELECT u.id, u.last_name, u.first_name, u.object, u.department, u.position, u.staff_category,
         r.id AS mb_id, to_char(r.start_date, 'YYYY-MM-DD') AS mb_start, r.period_months AS mb_period
    FROM users u
    LEFT JOIN medbook_records r ON r.user_id = u.id
   WHERE u.role = 'employee' AND u.active = 1 AND COALESCE(u.employment_status, 'active') = 'active'`;

// filters: { objects:[], departments:[], category:'', q:'' }
async function loadEntries(filters = {}) {
  const params = [];
  let sql = SELECT_USERS;
  if (filters.objects && filters.objects.length) { params.push(filters.objects); sql += ` AND u.object = ANY($${params.length}::text[])`; }
  if (filters.departments && filters.departments.length) { params.push(filters.departments); sql += ` AND u.department = ANY($${params.length}::text[])`; }
  if (filters.category) { params.push(filters.category); sql += ` AND COALESCE(u.staff_category, 'employee') = $${params.length}`; }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    sql += ` AND (u.last_name ILIKE $${params.length} OR u.first_name ILIKE $${params.length})`;
  }
  sql += ' ORDER BY u.last_name, u.first_name';
  const [rows, periods] = await Promise.all([query(sql, params), positionPeriods()]);
  const today = todayYmd();
  return rows.rows.map((u) => buildEntry(u, periods, today)).filter(Boolean);
}

async function loadEntryForUser(userId) {
  const [rows, periods] = await Promise.all([query(SELECT_USERS + ' AND u.id = $1', [userId]), positionPeriods()]);
  if (!rows.rows[0]) return null;
  return buildEntry(rows.rows[0], periods, todayYmd());
}

function summarize(entries) {
  const s = { total: entries.length, valid: 0, soon: 0, overdue: 0, no_date: 0 };
  entries.forEach((e) => { s[e.status] += 1; });
  return s;
}

module.exports = { SOON_DAYS, todayYmd, isYmd, addMonths, calcStatus, loadEntries, loadEntryForUser, summarize };
