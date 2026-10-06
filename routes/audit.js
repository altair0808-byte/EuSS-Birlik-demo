const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');

// Журнал действий — ТОЛЬКО суперадмин.
// GET /api/audit?actor_id=&action=&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&q=&limit=&offset=
router.get('/', authRequired, requireRole('superadmin'), async (req, res) => {
  try {
    const params = [];
    const where = [];
    const { actor_id, action, date_from, date_to, q } = req.query;
    if (actor_id) { params.push(Number(actor_id)); where.push(`actor_id = $${params.length}`); }
    if (action) {
      const actions = String(action).split(',').map(s => s.trim()).filter(Boolean);
      if (actions.length) { params.push(actions); where.push(`action = ANY($${params.length}::text[])`); }
    }
    if (date_from && /^\d{4}-\d{2}-\d{2}$/.test(date_from)) { params.push(date_from); where.push(`created_at >= $${params.length}::date`); }
    if (date_to && /^\d{4}-\d{2}-\d{2}$/.test(date_to)) { params.push(date_to); where.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (q) {
      params.push(`%${String(q).trim()}%`);
      where.push(`(entity_name ILIKE $${params.length} OR actor_name ILIKE $${params.length} OR details::text ILIKE $${params.length})`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const totalRes = await query(`SELECT COUNT(*)::int AS n FROM audit_log ${whereSql}`, params);
    const rowsRes = await query(
      `SELECT id, created_at, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_name, details
       FROM audit_log ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    res.json({ total: totalRes.rows[0].n, rows: rowsRes.rows });
  } catch (e) {
    console.error('Error reading audit log:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Список исполнителей для фильтра «Кто»: все, кто есть в журнале + все текущие админы/ассистенты
router.get('/actors', authRequired, requireRole('superadmin'), async (req, res) => {
  try {
    const r = await query(`
      SELECT actor_id AS id, MAX(actor_name) AS name, MAX(actor_role) AS role
      FROM audit_log WHERE actor_id IS NOT NULL GROUP BY actor_id
      UNION
      SELECT id, (last_name || ' ' || first_name) AS name, role FROM users WHERE role IN ('admin','assistant')
      ORDER BY name
    `);
    // UNION мог дать две строки на одного человека (разные написания) — оставляем первую по id
    const seen = new Set();
    res.json(r.rows.filter(x => (seen.has(String(x.id)) ? false : (seen.add(String(x.id)), true))));
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
