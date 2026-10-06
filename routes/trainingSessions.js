// ГРУППЫ ОБУЧЕНИЯ — заявка на очный (внутренний) курс, по которому проходят 30 и более человек.
//
//   GET    /api/training-sessions                       — список заявок (?status=planned|completed&q=)
//   GET    /api/training-sessions/stats                 — сводка для дашборда (?year=YYYY)
//   GET    /api/training-sessions/:id                   — заявка + состав
//   POST   /api/training-sessions                       — создать заявку {course_id, planned_date, ..., user_ids[]}
//   PUT    /api/training-sessions/:id                   — изменить данные заявки
//   POST   /api/training-sessions/:id/members           — добавить людей {user_ids[]}
//   PATCH  /api/training-sessions/:id/members           — отметить «присутствовал / не пришёл» {user_ids[] | all:true, attended}
//   DELETE /api/training-sessions/:id/members/:userId   — убрать человека из заявки
//   POST   /api/training-sessions/:id/complete          — ЗАКРЫТЬ ЗАЯВКУ: всем присутствующим разом вносится прохождение
//   POST   /api/training-sessions/:id/reopen            — (суперадмин) откатить закрытие: созданные записи удаляются
//   DELETE /api/training-sessions/:id                   — удалить заявку (только не закрытую)
//
// Пока заявка «planned», никаких записей обучения у сотрудников нет — это просто список. При закрытии для каждого
// присутствующего создаётся то же, что и при ручном внесении «уже пройденного» обучения (routes/assignments.js →
// buildHistoricalFields): назначение со статусом passed, номер сертификата, сертификат и удостоверение.
// Работает для всех трёх видов курса (courses.course_kind):
//   internal    — наш курс: нужен № протокола; создаются сертификат и удостоверение;
//   external    — внешний курс: № протокола необязателен (текст); удостоверения нет;
//   no_protocol — курс БЕЗ протокола: ничего, кроме даты, не нужно; удостоверения нет, но на странице по QR
//                 курс виден как «пройден» и входит в статистику.
// Дашборд: GET /api/training-sessions/stats — сводка по заявкам и курсам.
const express = require('express');
const router = express.Router();
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { logAction } = require('../lib/audit');
const assignmentsRouter = require('./assignments');
const { ensureCertificateForAssignment } = require('../certificateService');
const { ensureIdCardForAssignment } = require('../idCardService');
const driveSync = require('../driveSync');

const buildHistoricalFields = assignmentsRouter.buildHistoricalFields;
const adminOnly = [authRequired, requireRole('admin', 'superadmin')];

const SESSION_COLS = `s.id, s.course_id, c.title_ru AS course_title, c.course_kind, s.title, s.protocol_number, s.note, s.status,
  s.score_percent, s.completed_at,
  to_char(s.planned_date, 'YYYY-MM-DD') AS planned_date,
  to_char(s.protocol_date, 'YYYY-MM-DD') AS protocol_date,
  to_char(s.test_date, 'YYYY-MM-DD') AS test_date,
  to_char(s.next_test_date, 'YYYY-MM-DD') AS next_test_date`;

function isoDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;   // undefined = «некорректно»
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return undefined;
  const y = Number(s.slice(0, 4));
  if (y < 1990 || y > 2100) return undefined;
  return s;
}
function ids(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map(Number))].filter((n) => Number.isFinite(n) && n > 0);
}
function bad(res, message, status = 400) {
  return res.status(status).json({ error: 'bad_request', message });
}

async function loadSession(id, client) {
  const q = client ? client.query.bind(client) : query;
  const r = await q(
    `SELECT ${SESSION_COLS} FROM training_sessions s JOIN courses c ON c.id = s.course_id WHERE s.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function requireSessionCourse(courseId) {
  const r = await query('SELECT id, title_ru, course_kind, validity_months, no_expiry FROM courses WHERE id = $1', [courseId]);
  const c = r.rows[0];
  if (!c) return { error: 'Курс не найден' };
  return { course: c };
}
const isOwnCourse = (kind) => (kind || 'internal') === 'internal';

// Дата + N месяцев КАЛЕНДАРНО, с учётом конца месяца (31.01 + 1 мес = 28/29.02). Тот же алгоритм, что addMonthsISO в index.html,
// чтобы дата, показанная в форме закрытия группы, и сохранённая в БД совпадали.
function addMonthsISO(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  const n = Number(months);
  if (!m || !Number.isFinite(n)) return null;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + Math.trunc(n);
  const ny = Math.floor(total / 12), nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(Number(m[3]), last);
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

// Создаёт запись «пройдено» для одного сотрудника (внутри транзакции). Если у него уже есть пройденное
// обучение по этому курсу с той же датой — новую запись не заводим, а привязываем существующую.
async function issueAssignment(client, s, userId, actorId) {
  const dup = await client.query(
    `SELECT id FROM assignments
      WHERE user_id = $1 AND course_id = $2 AND status = 'passed' AND test_date IS NOT NULL AND LEFT(test_date, 10) = $3
      ORDER BY id LIMIT 1`,
    [userId, s.course_id, s.test_date]
  );
  if (dup.rows[0]) return { id: Number(dup.rows[0].id), existed: true };
  // external=true для внешних и «без протокола»: счётчик номеров сертификатов не трогаем, результат в % может быть пустым
  const h = await buildHistoricalFields(
    s.course_id,
    { test_date: s.test_date, next_test_date: s.next_test_date, score_percent: s.score_percent },
    userId,
    !isOwnCourse(s.course_kind)
  );
  const r = await client.query(
    `INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by,
        status, score_percent, test_date, next_test_date, certificate_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [userId, s.course_id, s.protocol_number || '', s.protocol_date || s.test_date, actorId,
     h.status, h.score_percent, h.test_date, h.next_test_date, h.certificate_number]
  );
  return { id: Number(r.rows[0].id), existed: false };
}

// Сертификат, удостоверение и отправка в Drive — после коммита; сбой одного не ломает остальных.
async function finishDocuments(assignmentIds, req, kind) {
  if (!isOwnCourse(kind)) return 0;   // внешний / без протокола: удостоверения и сертификата нет
  const failed = [];
  for (const aid of assignmentIds) {
    try { await ensureCertificateForAssignment(aid); }
    catch (e) { failed.push(aid); console.error('Не удалось создать сертификат (группа обучения)', aid, e.message); }
    try { await ensureIdCardForAssignment(aid); }
    catch (e) { failed.push(aid); console.error('Не удалось создать удостоверение (группа обучения)', aid, e.message); }
    try { driveSync.enqueueIdCard(aid, req); } catch (e) { /* очередь Drive не критична */ }
  }
  return [...new Set(failed)].length;
}

// ---------- список ----------
router.get('/', ...adminOnly, async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.status === 'planned' || req.query.status === 'completed') {
      params.push(req.query.status);
      where.push(`s.status = $${params.length}`);
    }
    if (req.query.q) {
      params.push('%' + String(req.query.q).trim() + '%');
      where.push(`(s.title ILIKE $${params.length} OR c.title_ru ILIKE $${params.length} OR s.protocol_number ILIKE $${params.length})`);
    }
    const r = await query(
      `SELECT ${SESSION_COLS},
              (SELECT COUNT(*) FROM training_session_members m WHERE m.session_id = s.id) AS members_count,
              (SELECT COUNT(*) FROM training_session_members m WHERE m.session_id = s.id AND m.attended) AS attended_count
         FROM training_sessions s JOIN courses c ON c.id = s.course_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY (s.status = 'planned') DESC, COALESCE(s.planned_date, s.created_at::date) DESC, s.id DESC
        LIMIT 500`,
      params
    );
    res.json(r.rows.map((x) => ({ ...x, members_count: Number(x.members_count), attended_count: Number(x.attended_count) })));
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ---------- сводка для дашборда ----------
// ?year=YYYY — только заявки этого года (по дате проведения, а если её нет — по дате создания).
router.get('/stats', ...adminOnly, async (req, res) => {
  try {
    const params = [];
    let yearSql = '';
    if (req.query.year && /^\d{4}$/.test(String(req.query.year))) {
      params.push(Number(req.query.year));
      yearSql = `AND EXTRACT(YEAR FROM COALESCE(s.test_date, s.planned_date, s.created_at::date)) = $${params.length}`;
    }
    const totals = await query(
      `SELECT
         COUNT(*) FILTER (WHERE s.status = 'planned')   AS planned_sessions,
         COUNT(*) FILTER (WHERE s.status = 'completed') AS completed_sessions,
         COUNT(DISTINCT m.user_id) FILTER (WHERE s.status = 'planned')   AS people_enrolled,
         COUNT(DISTINCT m.user_id) FILTER (WHERE s.status = 'completed' AND m.assignment_id IS NOT NULL) AS people_passed,
         COUNT(m.user_id) FILTER (WHERE s.status = 'completed' AND m.assignment_id IS NULL) AS people_absent
       FROM training_sessions s LEFT JOIN training_session_members m ON m.session_id = s.id
       WHERE TRUE ${yearSql}`, params
    );
    const byCourse = await query(
      `SELECT c.id AS course_id, c.title_ru AS course_title, c.course_kind,
              COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'planned')   AS sessions_planned,
              COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'completed') AS sessions_completed,
              COUNT(m.user_id) FILTER (WHERE s.status = 'planned')       AS enrolled,
              COUNT(m.user_id) FILTER (WHERE s.status = 'completed' AND m.assignment_id IS NOT NULL) AS passed,
              COUNT(m.user_id) FILTER (WHERE s.status = 'completed' AND m.assignment_id IS NULL)     AS absent
         FROM training_sessions s
         JOIN courses c ON c.id = s.course_id
         LEFT JOIN training_session_members m ON m.session_id = s.id
        WHERE TRUE ${yearSql}
        GROUP BY c.id, c.title_ru, c.course_kind
        ORDER BY c.title_ru`, params
    );
    const byObject = await query(
      `SELECT COALESCE(NULLIF(u.object, ''), '—') AS object,
              COUNT(*) FILTER (WHERE s.status = 'planned') AS enrolled,
              COUNT(*) FILTER (WHERE s.status = 'completed' AND m.assignment_id IS NOT NULL) AS passed
         FROM training_sessions s
         JOIN training_session_members m ON m.session_id = s.id
         JOIN users u ON u.id = m.user_id
        WHERE TRUE ${yearSql}
        GROUP BY 1 ORDER BY 1`, params
    );
    const upcoming = await query(
      `SELECT ${SESSION_COLS},
              (SELECT COUNT(*) FROM training_session_members m WHERE m.session_id = s.id) AS members_count
         FROM training_sessions s JOIN courses c ON c.id = s.course_id
        WHERE s.status = 'planned' ${yearSql}
        ORDER BY s.planned_date NULLS LAST, s.id DESC LIMIT 10`, params
    );
    const recent = await query(
      `SELECT ${SESSION_COLS},
              (SELECT COUNT(*) FROM training_session_members m WHERE m.session_id = s.id AND m.assignment_id IS NOT NULL) AS passed_count
         FROM training_sessions s JOIN courses c ON c.id = s.course_id
        WHERE s.status = 'completed' ${yearSql}
        ORDER BY s.completed_at DESC NULLS LAST, s.id DESC LIMIT 10`, params
    );
    // int8 (COUNT и id) глобально разбирается в числа — см. types.setTypeParser(20, ...) в db.js
    const num = (o) => o;
    res.json({
      totals: num(totals.rows[0] || {}),
      by_course: byCourse.rows.map(num),
      by_object: byObject.rows.map(num),
      upcoming: upcoming.rows.map(num),
      recent: recent.rows.map(num)
    });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ---------- одна заявка со списком людей ----------
router.get('/:id', ...adminOnly, async (req, res) => {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const m = await query(
      `SELECT u.id AS user_id, u.last_name, u.first_name, u.object, u.department, u.position, u.iin, u.login,
              u.employment_status, m.attended, m.assignment_id,
              (SELECT to_char(MAX(LEFT(a.test_date, 10)::date), 'YYYY-MM-DD') FROM assignments a
                WHERE a.user_id = u.id AND a.course_id = $2 AND a.status = 'passed' AND a.test_date IS NOT NULL
                  AND a.id IS DISTINCT FROM m.assignment_id) AS prev_test_date
         FROM training_session_members m JOIN users u ON u.id = m.user_id
        WHERE m.session_id = $1
        ORDER BY u.last_name, u.first_name`,
      [req.params.id, s.course_id]
    );
    res.json({ ...s, members: m.rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ---------- создать ----------
router.post('/', ...adminOnly, async (req, res) => {
  const b = req.body || {};
  const planned = isoDate(b.planned_date);
  if (planned === undefined) return bad(res, 'Некорректная дата проведения');
  const chk = await requireSessionCourse(b.course_id).catch(() => ({ error: 'Курс не найден' }));
  if (chk.error) return bad(res, chk.error);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO training_sessions (course_id, title, planned_date, protocol_number, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [b.course_id, String(b.title || '').trim(), planned, String(b.protocol_number || '').trim(), String(b.note || '').trim(), req.user.id]
    );
    const sid = r.rows[0].id;
    const userIds = ids(b.user_ids);
    if (userIds.length) {
      await client.query(
        `INSERT INTO training_session_members (session_id, user_id, attended)
         SELECT $1, id, TRUE FROM users WHERE id = ANY($2::bigint[]) AND role = 'employee'
         ON CONFLICT DO NOTHING`,
        [sid, userIds]
      );
    }
    await client.query('COMMIT');
    await logAction(req, 'training_session_created', {
      entityType: 'course', entityId: Number(b.course_id), entityName: chk.course.title_ru,
      details: { course: chk.course.title_ru, session_id: Number(sid), planned_date: planned, employees_total: userIds.length }
    });
    res.json({ id: Number(sid) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'db_error', details: e.message });
  } finally {
    client.release();
  }
});

// ---------- изменить данные заявки ----------
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const cur = await loadSession(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    const sets = [];
    const params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (b.title !== undefined) set('title', String(b.title || '').trim());
    if (b.note !== undefined) set('note', String(b.note || '').trim());

    if (cur.status === 'planned') {
      if (b.course_id !== undefined && Number(b.course_id) !== Number(cur.course_id)) {
        const chk = await requireSessionCourse(b.course_id);
        if (chk.error) return bad(res, chk.error);
        set('course_id', b.course_id);
      }
      for (const [key, col] of [['planned_date', 'planned_date'], ['protocol_date', 'protocol_date'], ['test_date', 'test_date'], ['next_test_date', 'next_test_date']]) {
        if (b[key] !== undefined) {
          const v = isoDate(b[key]);
          if (v === undefined) return bad(res, 'Некорректная дата: ' + key);
          set(col, v);
        }
      }
      if (b.protocol_number !== undefined) set('protocol_number', String(b.protocol_number || '').trim());
      if (b.score_percent !== undefined) {
        const sp = b.score_percent === '' || b.score_percent === null ? null : Number(b.score_percent);
        if (sp !== null && (!Number.isFinite(sp) || sp < 0 || sp > 100)) return bad(res, 'Результат должен быть от 0 до 100');
        set('score_percent', sp);
      }
    } else if (['course_id', 'planned_date', 'protocol_number', 'protocol_date', 'test_date'].some((k) => b[k] !== undefined && String(b[k] || '') !== String(cur[k] || ''))) {
      return bad(res, 'Заявка уже закрыта: менять курс, даты и номер протокола нельзя. Название и примечание — можно. Чтобы исправить остальное, суперадмин может откатить закрытие.', 409);
    }
    if (!sets.length) return res.json({ ok: true });
    params.push(req.params.id);
    await query(`UPDATE training_sessions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ---------- добавить людей ----------
router.post('/:id/members', ...adminOnly, async (req, res) => {
  const client = await pool.connect();
  let createdAssignmentIds = [];
  let sessionKind = 'internal';
  try {
    const userIds = ids((req.body || {}).user_ids);
    if (!userIds.length) return bad(res, 'Не выбрано ни одного сотрудника');
    await client.query('BEGIN');
    const sr = await client.query('SELECT id, status FROM training_sessions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!sr.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    const ins = await client.query(
      `INSERT INTO training_session_members (session_id, user_id, attended)
       SELECT $1, id, TRUE FROM users WHERE id = ANY($2::bigint[]) AND role = 'employee'
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [req.params.id, userIds]
    );
    const added = ins.rows.map((r) => Number(r.user_id));
    // Заявка уже закрыта — «опоздавшему» сразу вносим прохождение теми же данными, что у всей группы.
    if (sr.rows[0].status === 'completed' && added.length) {
      const s = await loadSession(req.params.id, client);
      sessionKind = s.course_kind;
      for (const uid of added) {
        const a = await issueAssignment(client, s, uid, req.user.id);
        await client.query('UPDATE training_session_members SET assignment_id = $1, attended = TRUE WHERE session_id = $2 AND user_id = $3', [a.id, req.params.id, uid]);
        if (!a.existed) createdAssignmentIds.push(a.id);
      }
    }
    await client.query('COMMIT');
    if (createdAssignmentIds.length) await finishDocuments(createdAssignmentIds, req, sessionKind);
    res.json({ added: added.length, already: userIds.length - added.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'db_error', details: e.message });
  } finally {
    client.release();
  }
});

// Записанные в заявку по умолчанию считаются присутствующими (attended = TRUE): не пришедшего убирают из заявки
// («Убрать выбранных») или снимают с него отметку, а при закрытии прохождение вносится всем, кто остался.
// ---------- отметить присутствие ----------
router.patch('/:id/members', ...adminOnly, async (req, res) => {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    if (s.status !== 'planned') return bad(res, 'Заявка закрыта — присутствие менять нельзя', 409);
    const body = req.body || {};
    // all:true — отметить всех участников заявки разом (массовая отметка)
    const r = body.all === true
      ? await query('UPDATE training_session_members SET attended = $1 WHERE session_id = $2', [!!body.attended, req.params.id])
      : await (async () => {
          const userIds = ids(body.user_ids);
          if (!userIds.length) return null;
          return query(
            'UPDATE training_session_members SET attended = $1 WHERE session_id = $2 AND user_id = ANY($3::bigint[])',
            [!!body.attended, req.params.id, userIds]
          );
        })();
    if (!r) return bad(res, 'Не выбрано ни одного сотрудника');
    res.json({ updated: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ---------- убрать человека ----------
router.delete('/:id/members/:userId', ...adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sr = await client.query('SELECT status FROM training_sessions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!sr.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    const m = await client.query('SELECT assignment_id FROM training_session_members WHERE session_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    if (sr.rows[0].status === 'completed' && m.rows[0] && m.rows[0].assignment_id) {
      if (req.user.role !== 'superadmin') {
        await client.query('ROLLBACK');
        return bad(res, 'Заявка закрыта, прохождение уже внесено. Убрать человека из закрытой заявки может только суперадмин.', 403);
      }
      await client.query('DELETE FROM assignments WHERE id = $1', [m.rows[0].assignment_id]);
    }
    await client.query('DELETE FROM training_session_members WHERE session_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'db_error', details: e.message });
  } finally {
    client.release();
  }
});

// ---------- ЗАКРЫТЬ ЗАЯВКУ: всем присутствующим разом ----------
router.post('/:id/complete', ...adminOnly, async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  let createdIds = [];
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT id, status FROM training_sessions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!lock.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    if (lock.rows[0].status !== 'planned') { await client.query('ROLLBACK'); return bad(res, 'Заявка уже закрыта', 409); }

    const cur = await loadSession(req.params.id, client);
    const testDate = isoDate(b.test_date !== undefined ? b.test_date : (cur.test_date || cur.planned_date));
    const protocolDate = isoDate(b.protocol_date !== undefined ? b.protocol_date : cur.protocol_date);
    const nextDate = isoDate(b.next_test_date !== undefined ? b.next_test_date : cur.next_test_date);
    if (testDate === undefined || protocolDate === undefined || nextDate === undefined) { await client.query('ROLLBACK'); return bad(res, 'Некорректная дата'); }
    if (!testDate) { await client.query('ROLLBACK'); return bad(res, 'Укажите дату прохождения'); }
    const own = isOwnCourse(cur.course_kind);
    // Наш курс — номер протокола обязателен; внешний — по желанию (номер документа другой организации); без протокола — не нужен
    let protocolNumber = String(b.protocol_number !== undefined ? b.protocol_number : cur.protocol_number || '').trim();
    if (cur.course_kind === 'no_protocol') protocolNumber = '';
    if (own && !protocolNumber) { await client.query('ROLLBACK'); return bad(res, 'Укажите номер протокола'); }
    let score = b.score_percent !== undefined ? b.score_percent : cur.score_percent;
    score = score === '' || score === null || score === undefined ? null : Number(score);
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) { await client.query('ROLLBACK'); return bad(res, 'Результат должен быть от 0 до 100'); }

    const chk = await requireSessionCourse(cur.course_id);
    if (chk.error) { await client.query('ROLLBACK'); return bad(res, chk.error); }

    // «Следующее прохождение»: бессрочный курс — даты нет; пусто, а срок задан — тест_дата + срок курса
    let nextFinal = nextDate;
    if (chk.course.no_expiry) nextFinal = null;
    else if (!nextFinal && Number(chk.course.validity_months) > 0) nextFinal = addMonthsISO(testDate, Number(chk.course.validity_months));

    const members = await client.query(
      `SELECT m.user_id FROM training_session_members m JOIN users u ON u.id = m.user_id
        WHERE m.session_id = $1 AND m.attended AND u.role = 'employee' ORDER BY u.last_name, u.first_name`,
      [req.params.id]
    );
    if (!members.rows.length) { await client.query('ROLLBACK'); return bad(res, 'В заявке нет присутствовавших сотрудников'); }

    const s = { course_id: cur.course_id, course_kind: cur.course_kind, protocol_number: protocolNumber, protocol_date: own ? (protocolDate || testDate) : testDate, test_date: testDate, next_test_date: nextFinal, score_percent: score };
    let already = 0;
    for (const row of members.rows) {
      const a = await issueAssignment(client, s, Number(row.user_id), req.user.id);
      await client.query('UPDATE training_session_members SET assignment_id = $1 WHERE session_id = $2 AND user_id = $3', [a.id, req.params.id, row.user_id]);
      if (a.existed) already += 1; else createdIds.push(a.id);
    }
    await client.query(
      `UPDATE training_sessions SET status = 'completed', completed_at = NOW(), completed_by = $2,
              protocol_number = $3, protocol_date = $4, test_date = $5, next_test_date = $6, score_percent = $7
        WHERE id = $1`,
      [req.params.id, req.user.id, protocolNumber, s.protocol_date, testDate, nextFinal, score]
    );
    await client.query('COMMIT');

    const docsFailed = await finishDocuments(createdIds, req, cur.course_kind);
    try {
      const names = (await query(
        `SELECT u.last_name, u.first_name FROM training_session_members m JOIN users u ON u.id = m.user_id
          WHERE m.session_id = $1 AND m.attended ORDER BY u.last_name, u.first_name`, [req.params.id]
      )).rows.map((r) => `${r.last_name} ${r.first_name}`.trim());
      await logAction(req, 'training_session_completed', {
        entityType: 'course', entityId: Number(cur.course_id), entityName: chk.course.title_ru,
        details: {
          course: chk.course.title_ru, session_id: Number(req.params.id), protocol_number: protocolNumber,
          created: createdIds.length, skipped: already, employees: names.slice(0, 30), employees_total: names.length
        }
      });
    } catch (logErr) { console.error('audit (session complete):', logErr.message); }
    res.json({ created: createdIds.length, already_had: already, documents_failed: docsFailed });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'db_error', details: e.message });
  } finally {
    client.release();
  }
});

// ---------- откат закрытия (суперадмин) ----------
router.post('/:id/reopen', authRequired, requireRole('superadmin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT status FROM training_sessions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!lock.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    if (lock.rows[0].status !== 'completed') { await client.query('ROLLBACK'); return bad(res, 'Заявка не закрыта', 409); }
    const del = await client.query(
      `DELETE FROM assignments WHERE id IN (SELECT assignment_id FROM training_session_members WHERE session_id = $1 AND assignment_id IS NOT NULL)`,
      [req.params.id]
    );
    await client.query('UPDATE training_session_members SET assignment_id = NULL WHERE session_id = $1', [req.params.id]);
    await client.query(`UPDATE training_sessions SET status = 'planned', completed_at = NULL, completed_by = NULL WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');
    const s = await loadSession(req.params.id);
    await logAction(req, 'training_session_reopened', {
      entityType: 'course', entityId: Number(s.course_id), entityName: s.course_title,
      details: { course: s.course_title, session_id: Number(req.params.id), deleted: del.rowCount }
    });
    res.json({ deleted: del.rowCount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'db_error', details: e.message });
  } finally {
    client.release();
  }
});

// ---------- удалить заявку ----------
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    if (s.status === 'completed') return bad(res, 'Закрытую заявку удалить нельзя. Суперадмин может сначала откатить закрытие.', 409);
    await query('DELETE FROM training_sessions WHERE id = $1', [req.params.id]);
    await logAction(req, 'training_session_deleted', {
      entityType: 'course', entityId: Number(s.course_id), entityName: s.course_title,
      details: { course: s.course_title, session_id: Number(req.params.id) }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
