// ЛИЧНЫЕ МЕДИЦИНСКИЕ КНИЖКИ (санкнижки).
//
//   GET    /api/medbooks/positions        — все должности из структуры + период (6/12 мес.) или «не нужна»
//   PUT    /api/medbooks/positions        — сохранить набор должностей, которым нужна книжка (admin/superadmin)
//   GET    /api/medbooks/overview         — сотрудники, которым нужна книжка (по должности или вручную) + статистика
//   GET    /api/medbooks/user/:id         — книжка одного сотрудника (applicable=false — не нужна, в карточке не показываем)
//   GET    /api/medbooks/me               — то же для вошедшего сотрудника
//   PUT    /api/medbooks/user/:id         — внести/обновить дату начала книжки (+ период для «вне должности»)
//   DELETE /api/medbooks/user/:id         — убрать книжку (сбросить дату / убрать ручное добавление)
const express = require('express');
const router = express.Router();
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { logAction } = require('../lib/audit');
const { splitMulti, scopedFilter } = require('../lib/multiFilter');
const { keyOf } = require('../lib/positionCourses');
const mb = require('../lib/medbook');

const STAFF = requireRole('admin', 'assistant', 'superadmin');
const ADMIN = requireRole('admin', 'superadmin');

async function structureRows() {
  const r = await query('SELECT org_structure FROM settings WHERE id = 1');
  const structure = (r.rows[0] && Array.isArray(r.rows[0].org_structure)) ? r.rows[0].org_structure : [];
  const rows = [];
  structure.forEach((o) => (o.departments || []).forEach((d) => (d.positions || []).forEach((p) => {
    const position = typeof p === 'string' ? p : (p && p.ru) || '';
    if (position) rows.push({ object: o.object, department: d.name, position });
  })));
  return rows;
}

function validPeriod(v) { const n = Number(v); return n === 6 || n === 12 ? n : null; }

// Ассистент работает только в своей зоне (объекты / отделы)
function inScope(user, target) {
  if (!user || user.role !== 'assistant') return true;
  const sc = scopedFilter(user, [], []);
  if (sc.noAccess) return false;
  if (sc.objects.length && !sc.objects.includes(target.object)) return false;
  if (sc.departments.length && !sc.departments.includes(target.department)) return false;
  return true;
}

// ---------- должности ----------
router.get('/positions', authRequired, STAFF, async (req, res) => {
  try {
    const [rows, saved] = await Promise.all([structureRows(), query('SELECT key, period_months FROM medbook_positions')]);
    const map = new Map(saved.rows.map((x) => [x.key, Number(x.period_months)]));
    res.json({ items: rows.map((r) => ({ ...r, period_months: map.get(keyOf(r.object, r.department, r.position)) || null })) });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.put('/positions', authRequired, ADMIN, async (req, res) => {
  const client = await pool.connect();
  try {
    const rows = await structureRows();
    const index = new Map(rows.map((r) => [keyOf(r.object, r.department, r.position), r]));
    const out = new Map();
    (Array.isArray(req.body && req.body.items) ? req.body.items : []).forEach((it) => {
      const k = keyOf(it && it.object, it && it.department, it && it.position);
      const canon = index.get(k);
      const period = validPeriod(it && it.period_months);
      if (canon && period) out.set(k, { ...canon, period });
    });
    await client.query('BEGIN');
    await client.query('DELETE FROM medbook_positions');
    for (const [k, v] of out) {
      await client.query(
        'INSERT INTO medbook_positions (object, department, position, key, period_months) VALUES ($1,$2,$3,$4,$5)',
        [v.object, v.department, v.position, k, v.period]
      );
    }
    await client.query('COMMIT');
    await logAction(req, 'medbook_positions_saved', { entityType: 'medbook', entityName: 'Должности с мед. книжкой', details: { count: out.size } });
    res.json({ ok: true, count: out.size });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    res.status(500).json({ error: 'db_error', details: e.message });
  } finally { client.release(); }
});

// ---------- обзор ----------
router.get('/overview', authRequired, STAFF, async (req, res) => {
  try {
    const scope = scopedFilter(req.user, splitMulti(req.query.object), splitMulti(req.query.department));
    if (scope.noAccess) return res.json({ rows: [], stats: mb.summarize([]) });
    const cat = ['manager', 'specialist', 'employee'].includes(req.query.category) ? req.query.category : '';
    const rows = await mb.loadEntries({ objects: scope.objects, departments: scope.departments, category: cat, q: String(req.query.q || '').trim() });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ rows, stats: mb.summarize(rows) });
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

// ---------- один сотрудник ----------
async function sendUser(res, userId) {
  const e = await mb.loadEntryForUser(userId);
  res.setHeader('Cache-Control', 'no-store');
  res.json(e ? { applicable: true, ...e } : { applicable: false });
}

router.get('/me', authRequired, async (req, res) => {
  try { await sendUser(res, req.user.id); } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.get('/user/:id', authRequired, STAFF, async (req, res) => {
  try {
    const u = (await query('SELECT id, object, department FROM users WHERE id = $1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (!inScope(req.user, u)) return res.status(403).json({ error: 'forbidden_scope' });
    await sendUser(res, u.id);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.put('/user/:id', authRequired, STAFF, async (req, res) => {
  try {
    const u = (await query(
      `SELECT id, last_name, first_name, object, department, position, role FROM users WHERE id = $1`, [req.params.id]
    )).rows[0];
    if (!u || u.role !== 'employee') return res.status(404).json({ error: 'not_found', message: 'Сотрудник не найден' });
    if (!inScope(req.user, u)) return res.status(403).json({ error: 'forbidden_scope', message: 'Сотрудник вне вашей зоны' });
    const start = String((req.body && req.body.start_date) || '');
    if (!mb.isYmd(start)) return res.status(400).json({ error: 'bad_date', message: 'Укажите дату начала книжки' });
    const today = mb.todayYmd();
    if (start > today) {
      return res.status(400).json({ error: 'future_date', message: 'Дата начала не может быть в будущем' });
    }
    const posPeriod = (await query('SELECT period_months FROM medbook_positions WHERE key = $1', [keyOf(u.object, u.department, u.position)])).rows[0];
    const required = !!posPeriod;
    const period = required ? Number(posPeriod.period_months) : validPeriod(req.body && req.body.period_months);
    if (!period) return res.status(400).json({ error: 'bad_period', message: 'Выберите период: 6 или 12 месяцев' });
    await query(
      `INSERT INTO medbook_records (user_id, start_date, period_months, manual, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE SET start_date = EXCLUDED.start_date, period_months = EXCLUDED.period_months,
         manual = EXCLUDED.manual, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [u.id, start, period, !required, req.user.id]
    );
    await logAction(req, 'medbook_saved', {
      entityType: 'user', entityId: u.id, entityName: `${u.last_name} ${u.first_name}`.trim(),
      details: { start_date: start, period_months: period, outside_position: !required }
    });
    await sendUser(res, u.id);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

router.delete('/user/:id', authRequired, STAFF, async (req, res) => {
  try {
    const u = (await query('SELECT id, last_name, first_name, object, department, role FROM users WHERE id = $1', [req.params.id])).rows[0];
    if (!u || u.role !== 'employee') return res.status(404).json({ error: 'not_found' });
    if (!inScope(req.user, u)) return res.status(403).json({ error: 'forbidden_scope' });
    await query('DELETE FROM medbook_records WHERE user_id = $1', [u.id]);
    await logAction(req, 'medbook_removed', { entityType: 'user', entityId: u.id, entityName: `${u.last_name} ${u.first_name}`.trim() });
    await sendUser(res, u.id);
  } catch (e) { res.status(500).json({ error: 'db_error', details: e.message }); }
});

module.exports = router;
