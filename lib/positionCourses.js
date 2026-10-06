// Курсы по должностям: общие помощники для routes/coursePositions.js и автозаписи новых сотрудников.
// Ключ должности = «объект|отдел|должность» в нормализованном виде (без регистра и лишних пробелов).
const { query, pool } = require('../db');

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function keyOf(object, department, position) {
  return `${norm(object)}|${norm(department)}|${norm(position)}`;
}

// Номер протокола для новых назначений — как в routes/assignments.js (peekNextProtocolNumber).
// require внутри функции — чтобы не получить циклическую зависимость при старте сервера.
async function currentProtocolNumber() {
  const { findActiveProtocol, nextProtocolNumber } = require('../routes/protocols');
  const today = new Date().toISOString().slice(0, 10);
  const active = await findActiveProtocol(today);
  if (active) return String(active.protocol_number);
  return nextProtocolNumber(new Date().getFullYear());
}

// Работающие сотрудники, у которых должность входит в набор ключей keys
async function employeesForKeys(keys) {
  const rows = (await query(
    `SELECT id, object, department, position FROM users
      WHERE role = 'employee' AND active = 1 AND COALESCE(employment_status, 'active') = 'active'`
  )).rows;
  return rows.filter((u) => keys.has(keyOf(u.object, u.department, u.position)));
}

// Кому из них курс ещё нужно назначить: нет незавершённого назначения и нет действующего «сдал»
async function filterNeedingCourse(courseId, users) {
  if (!users.length) return [];
  const today = new Date().toISOString().slice(0, 10);
  const r = await query(
    `SELECT DISTINCT user_id FROM assignments
      WHERE course_id = $1 AND user_id = ANY($2::bigint[])
        AND (status IN ('pending', 'in_progress')
             OR (status = 'passed' AND (COALESCE(next_test_date, '') = '' OR next_test_date >= $3)))`,
    [courseId, users.map((u) => u.id), today]
  );
  const busy = new Set(r.rows.map((x) => Number(x.user_id)));
  return users.filter((u) => !busy.has(Number(u.id)));
}

async function countWouldEnroll(courseId, keys) {
  if (!keys || !keys.size) return { matched: 0, would_enroll: 0 };
  const matched = await employeesForKeys(keys);
  const need = await filterNeedingCourse(courseId, matched);
  return { matched: matched.length, would_enroll: need.length };
}

async function createPending(courseId, userIds, assignedBy) {
  if (!userIds.length) return 0;
  const protocolNumber = await currentProtocolNumber();
  const protocolDate = new Date().toISOString().slice(0, 10);
  let created = 0;
  for (const uid of userIds) {
    await query(
      `INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [uid, courseId, protocolNumber, protocolDate, assignedBy || null]
    );
    created += 1;
  }
  // Пуш сотрудникам: им автоматически назначили обязательный по должности курс
  try { require('./push').notifyCourseAssigned(userIds, courseId).catch(() => {}); } catch (e) { /* пуши не должны ломать назначение */ }
  return created;
}

// Записать уже работающих сотрудников на курс (только «наши» курсы)
async function enrollExistingForKeys(courseId, keys, assignedBy) {
  const c = (await query('SELECT course_kind FROM courses WHERE id = $1', [courseId])).rows[0];
  if (!c || c.course_kind !== 'internal') return { created: 0 };
  const matched = await employeesForKeys(keys);
  const need = await filterNeedingCourse(courseId, matched);
  const created = await createPending(courseId, need.map((u) => u.id), assignedBy);
  return { created };
}

// Автозапись нового сотрудника на курсы его должности. Никогда не бросает ошибку наружу —
// сбой автозаписи не должен ломать создание сотрудника.
async function enrollNewUser(userId, assignedBy) {
  try {
    const u = (await query('SELECT id, role, object, department, position FROM users WHERE id = $1', [userId])).rows[0];
    if (!u || u.role !== 'employee') return { created: 0 };
    const k = keyOf(u.object, u.department, u.position);
    const courses = (await query(
      `SELECT cp.course_id FROM course_positions cp
         JOIN courses c ON c.id = cp.course_id
        WHERE cp.key = $1 AND c.course_kind = 'internal'`, [k]
    )).rows;
    let created = 0;
    for (const row of courses) {
      const need = await filterNeedingCourse(row.course_id, [u]);
      created += await createPending(row.course_id, need.map((x) => x.id), assignedBy);
    }
    return { created };
  } catch (e) {
    console.error('positionCourses.enrollNewUser:', e.message);
    return { created: 0 };
  }
}

module.exports = { norm, keyOf, countWouldEnroll, enrollExistingForKeys, enrollNewUser };
