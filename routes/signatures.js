const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { authRequired } = require('./auth');
const { COMMITTEE_ROLE_LABELS } = require('../lib/committeeRoles');

// Электронная подпись сотрудника — модуль электронного подписания протоколов
// комиссии (п.1 запроса). Доступна только тем, у кого администратор назначил роль
// в комиссии (users.committee_role — см. routes/users.js): председатель, инженер по
// БиОТ или член комиссии. Подпись хранится прямо в карточке пользователя как base64
// PNG (как логотип/печать/подпись председателя в settings) — рисуется на фронтенде
// пальцем на телефоне, стилусом на планшете или мышью на компьютере.

// GET /api/signatures/me — данные для экрана «Мой профиль → Электронная подпись»
router.get('/me', authRequired, async (req, res) => {
  try {
    const r = await query(
      `SELECT committee_role, signature_data, signature_updated_at FROM users WHERE id = $1`,
      [req.user.id]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    res.json({
      committee_role: u.committee_role,
      committee_role_label: u.committee_role ? COMMITTEE_ROLE_LABELS[u.committee_role] : null,
      signature_data: u.signature_data || null,
      signature_updated_at: u.signature_updated_at
    });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// POST /api/signatures/me — сохранить/обновить подпись (кнопки «Сохранить подпись» /
// «Обновить подпись»). Если подпись уже была сохранена раньше — по п.9 запроса
// («запрет изменения сохраненной подписи без ввода текущего пароля») требуем пароль.
router.post('/me', authRequired, async (req, res) => {
  const { signature_data, current_password } = req.body;
  if (!signature_data || typeof signature_data !== 'string' || !signature_data.startsWith('data:image')) {
    return res.status(400).json({ error: 'invalid_signature', message: 'Подпись не получена — распишитесь ещё раз' });
  }
  try {
    const r = await query('SELECT committee_role, signature_data, password_hash FROM users WHERE id = $1', [req.user.id]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (!u.committee_role) {
      return res.status(403).json({
        error: 'no_committee_role',
        message: 'Электронная подпись доступна только ролям комиссии (председатель, инженер по БиОТ, член комиссии) — обратитесь к администратору'
      });
    }
    if (u.signature_data) {
      if (!current_password || !u.password_hash || !bcrypt.compareSync(String(current_password), u.password_hash)) {
        return res.status(401).json({ error: 'invalid_password', message: 'Для изменения сохранённой подписи введите текущий пароль' });
      }
    }
    await query('UPDATE users SET signature_data = $1, signature_updated_at = NOW() WHERE id = $2', [signature_data, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// DELETE /api/signatures/me — кнопка «Очистить подпись» (тоже требует пароль, если подпись уже была)
router.delete('/me', authRequired, async (req, res) => {
  const { current_password } = req.body || {};
  try {
    const r = await query('SELECT password_hash, signature_data FROM users WHERE id = $1', [req.user.id]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.signature_data) {
      if (!current_password || !u.password_hash || !bcrypt.compareSync(String(current_password), u.password_hash)) {
        return res.status(401).json({ error: 'invalid_password', message: 'Для удаления подписи введите текущий пароль' });
      }
    }
    await query('UPDATE users SET signature_data = NULL, signature_updated_at = NULL WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
