// Журнал действий: кто из администраторов / ассистентов что сделал (добавил сотрудника,
// назначил курс, изменил карточку и т.д.). Читает журнал только суперадмин (routes/audit.js).
//
// logAction НИКОГДА не бросает исключение: сбой журнала не должен ломать основное действие
// (сотрудник уже создан — пользователь не должен получить ошибку из-за записи в журнал).
const { query } = require('../db');

// Пишем в журнал действия обычных администраторов и ассистентов.
// Действия суперадмина тоже пишем — суперадмин видит всё, но фильтр «Кто» позволяет их отделить.
async function logAction(req, action, opts = {}) {
  try {
    const actor = (req && req.user) || {};
    let actorName = '';
    let actorRole = actor.role || '';
    if (actor.id) {
      try {
        const r = await query('SELECT last_name, first_name, role FROM users WHERE id = $1', [actor.id]);
        if (r.rows[0]) {
          actorName = `${r.rows[0].last_name || ''} ${r.rows[0].first_name || ''}`.trim();
          actorRole = r.rows[0].role || actorRole;
        }
      } catch (e) { /* берём то, что есть в токене */ }
    }
    if (!actorName) actorName = `${actor.last_name || ''} ${actor.first_name || ''}`.trim() || actor.login || '';
    const ip = (req && (req.ip || (req.headers && req.headers['x-forwarded-for']))) || null;
    await query(
      `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_name, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        actor.id || null, actorName, actorRole, action,
        opts.entityType || null,
        opts.entityId !== undefined && opts.entityId !== null ? Number(opts.entityId) : null,
        opts.entityName || '',
        JSON.stringify(opts.details || {}),
        ip ? String(ip).slice(0, 100) : null
      ]
    );
  } catch (e) {
    console.error('audit log failed:', action, e.message);
  }
}

function fullName(u) {
  return u ? `${u.last_name || ''} ${u.first_name || ''}`.trim() : '';
}

module.exports = { logAction, fullName };
