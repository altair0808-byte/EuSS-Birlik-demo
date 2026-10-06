const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { buildProtocolDocx, protocolFileName } = require('../protocolDocx');
const { buildProtocolPdf } = require('../protocolPdf');
const { splitMulti, scopedFilter } = require('../lib/multiFilter');
const { COMMITTEE_ROLES, COMMITTEE_ROLE_LABELS } = require('../lib/committeeRoles');
const { revokeCertificatesForProtocol } = require('../certificateService');
const { revokeIdCardsForProtocol } = require('../idCardService');
const driveSync = require('../driveSync');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// Печать организации хранится в settings.stamp_data (data:image/...;base64,...) или
// settings.stamp_path (URL/локальный путь) — тот же приём, что и в routes/certificate.js,
// приводим к готовому Buffer для protocolDocx.js.
async function fetchRemoteBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) { resp.resume(); return reject(new Error('HTTP ' + resp.statusCode)); }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks)));
      resp.on('error', reject);
    }).on('error', reject);
  });
}
async function resolveImageBuffer(imgVal) {
  if (!imgVal) return null;
  try {
    if (imgVal.startsWith('data:image')) {
      const idx = imgVal.indexOf('base64,');
      if (idx !== -1) return Buffer.from(imgVal.slice(idx + 7), 'base64');
    }
    if (/^https?:\/\//i.test(imgVal)) return await fetchRemoteBuffer(imgVal);
    const localPath = path.join(__dirname, '..', imgVal.replace(/^\//, ''));
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
  } catch (e) { console.error('Error resolving stamp image buffer:', e); }
  return null;
}

// Печать организации из настроек → Buffer (или null). Общая для Word, PDF-предпросмотра и
// PDF при запечатывании: раньше печать доходила только до Word-скачивания, а в PDF (и в
// сохранённый при полном подписании PDF) не передавалась совсем.
async function loadCompanyStamp() {
  const r = await query('SELECT stamp_data, stamp_path FROM settings WHERE id = 1');
  const s = r.rows[0] || {};
  const val = s.stamp_data || s.stamp_path;
  if (!val) return null;
  const buf = await resolveImageBuffer(val);
  if (!buf) console.warn('[protocols] Печать указана в настройках, но файл не удалось прочитать:', String(val).slice(0, 120));
  return buf;
}

// Протоколы комиссии по проверке знаний.
// Администратор «открывает» протокол — указывает его номер и диапазон дат
// (дата открытия / дата закрытия). Пока протокол открыт (status='open') и
// сегодняшняя дата попадает в его диапазон, каждому сотруднику, который
// СДАЁТ тест в эти дни, этот номер протокола присваивается автоматически
// (см. findActiveProtocol() ниже и его использование в routes/assignments.js
// в обработчике POST /:id/submit).
//
// Нумерация — своя для каждого года (год = год даты открытия протокола): новый протокол
// получает следующий номер после максимального в этом году (см. nextProtocolNumber),
// но номер можно ввести и вручную. Настроек нумерации протоколов в «Настройках» больше нет.
//
// Даты отдаём строкой YYYY-MM-DD (to_char), а не объектом Date — иначе при часовом поясе
// сервера, отличном от UTC, дата «съезжает» на день.
const PROTOCOL_COLS = `
  p.id, p.protocol_number, p.status, p.created_by, p.created_at,
  to_char(p.open_date, 'YYYY-MM-DD') AS open_date,
  to_char(p.close_date, 'YYYY-MM-DD') AS close_date,
  p.locked, p.pdf_hash, p.pdf_version,
  to_char(p.fully_signed_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS fully_signed_at,
  p.revoke_reason,
  to_char(p.revoked_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS revoked_at
`;

// Кто входит в протокол: назначения, привязанные к нему при сдаче теста (protocol_id), а также
// внесённые вручную/импортом с тем же номером и датой протокола. Только сданные / несданные —
// «ожидающие» назначения в протокол не попадают.
// Записи по ВНЕШНИМ курсам (courses.is_external) сюда не попадают никогда: их «номер протокола» чужой,
// и совпади он с нашим номером и датой — запись всё равно не должна смешиваться с нашими протоколами.
const MEMBER_JOIN = `
  a.status IN ('passed', 'failed')
  AND NOT EXISTS (SELECT 1 FROM courses xc WHERE xc.id = a.course_id AND xc.is_external)
  AND (
    a.protocol_id = p.id
    OR (a.protocol_id IS NULL AND a.protocol_number = p.protocol_number
        AND LEFT(a.protocol_date, 10) = to_char(p.open_date, 'YYYY-MM-DD'))
  )
`;

// Следующий номер протокола в указанном году: максимальное число в номерах этого года + 1,
// с сохранением формата последнего номера («027» → «028», «9» → «10», «П-05» → «П-06»).
// В году без протоколов — «001».
async function nextProtocolNumber(year) {
  const y = parseInt(year, 10) || new Date().getFullYear();
  const result = await query(
    `SELECT protocol_number FROM protocols WHERE EXTRACT(YEAR FROM open_date)::int = $1`, [y]
  );
  let best = null;
  for (const row of result.rows) {
    const m = String(row.protocol_number).trim().match(/^(.*?)(\d+)$/);
    if (!m) continue;
    const n = parseInt(m[2], 10);
    if (!best || n > best.n) best = { prefix: m[1], digits: m[2].length, n };
  }
  if (!best) return '001';
  return best.prefix + String(best.n + 1).padStart(best.digits, '0');
}

// Есть ли уже протокол с таким номером в том же году (excludeId — при редактировании)
async function numberTaken(number, openDate, excludeId) {
  const result = await query(
    `SELECT id FROM protocols
     WHERE protocol_number = $1 AND EXTRACT(YEAR FROM open_date) = EXTRACT(YEAR FROM $2::date)
       AND ($3::bigint IS NULL OR id <> $3::bigint)
     LIMIT 1`,
    [number, openDate, excludeId || null]
  );
  return result.rows.length > 0;
}

// Есть ли у ассистента (по его зоне) хотя бы один сотрудник среди участников протокола —
// используется, чтобы разрешить/запретить одиночные операции по протоколу (§4, §9 ТЗ:
// "assistant допущен к чтению протоколов, но только по своим объектам/отделам").
async function assistantCanAccessProtocol(user, protocolId) {
  if (!user || user.role !== 'assistant') return true;
  const zoneObjects = Array.isArray(user.assistant_objects) ? user.assistant_objects : [];
  const zoneDepartments = Array.isArray(user.assistant_departments) ? user.assistant_departments : [];
  if (!zoneObjects.length && !zoneDepartments.length) return false;
  const params = [protocolId];
  let sql = `
    SELECT 1 FROM protocols p
    JOIN assignments a ON ${MEMBER_JOIN}
    JOIN users u ON u.id = a.user_id AND u.role = 'employee'
    WHERE p.id = $1
  `;
  if (zoneObjects.length) { params.push(zoneObjects); sql += ` AND u.object = ANY($${params.length}::text[])`; }
  if (zoneDepartments.length) { params.push(zoneDepartments); sql += ` AND u.department = ANY($${params.length}::text[])`; }
  sql += ' LIMIT 1';
  const r = await query(sql, params);
  return r.rows.length > 0;
}

// List all protocols (newest first)
// ТЗ §9: assistant допущен к списку, но только протоколы, где есть сотрудники его зоны.
router.get('/', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    // Единый фильтр по объекту/отделу (мульти-выбор — несколько значений через запятую):
    // считаем только сотрудников выбранных объектов/отделов и показываем только те
    // протоколы, по которым такие сотрудники есть. Для assistant пересекаем с его зоной —
    // если зона не выдана, доступа нет (безопасный дефолт).
    const scope = scopedFilter(req.user, splitMulti(req.query.object), splitMulti(req.query.department));
    if (scope.noAccess) return res.json([]);
    const objects = scope.objects;
    const departments = scope.departments;
    const result = await query(`
      SELECT ${PROTOCOL_COLS}, (
        SELECT COUNT(DISTINCT a.user_id)::int FROM assignments a JOIN users u ON u.id = a.user_id
        WHERE u.role = 'employee' AND ${MEMBER_JOIN}
          AND (cardinality($1::text[]) = 0 OR u.object = ANY($1::text[]))
          AND (cardinality($2::text[]) = 0 OR u.department = ANY($2::text[]))
      ) AS assignments_count
      FROM protocols p
      ORDER BY p.open_date DESC, p.id DESC
    `, [objects, departments]);
    res.json((objects.length || departments.length) ? result.rows.filter(r => r.assignments_count > 0) : result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Протокол(ы), действующие сегодня — используется фронтендом, чтобы подсказать
// администратору при назначении теста, что номер протокола будет присвоен
// автоматически, когда сотрудник его сдаст.
router.get('/active', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(`
      SELECT ${PROTOCOL_COLS} FROM protocols p
      WHERE p.status = 'open' AND CURRENT_DATE BETWEEN p.open_date AND p.close_date
      ORDER BY p.open_date DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Предлагаемый номер нового протокола для года: ?year=2026
router.get('/next-number', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    res.json({ year, next_number: await nextProtocolNumber(year) });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Список сотрудников, попавших в протокол — что показывает «№ протокола» при клике во
// вкладке «Протоколы» (п.4 запроса): ФИО, курс, статус (сдал/не сдал), результат %,
// номер сертификата. Тот же состав участников, что уходит в Word-протокол (MEMBER_JOIN).
router.get('/:id/members', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const pRes = await query(`SELECT ${PROTOCOL_COLS} FROM protocols p WHERE p.id = $1`, [req.params.id]);
    const p = pRes.rows[0];
    if (!p) return res.status(404).json({ error: 'not_found', message: 'Протокол не найден' });
    if (!(await assistantCanAccessProtocol(req.user, p.id))) {
      return res.status(403).json({ error: 'forbidden', message: 'Протокол вне вашей зоны доступа' });
    }

    const mRes = await query(`
      SELECT a.id AS assignment_id, a.user_id, a.status, a.test_date, a.score_percent, a.certificate_number,
             u.last_name, u.first_name, u.object, u.department, u.position,
             c.id AS course_id, c.title_ru, c.title_kz
      FROM protocols p
      JOIN assignments a ON ${MEMBER_JOIN}
      JOIN users u ON u.id = a.user_id AND u.role = 'employee'
      JOIN courses c ON c.id = a.course_id
      WHERE p.id = $1
      ORDER BY a.test_date NULLS LAST, u.last_name, u.first_name
    `, [p.id]);

    res.json({ protocol: p, members: mRes.rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Протокол + его сотрудники — общие данные и для Word (.docx), и для PDF с блоком
// электронного подписания (см. GET /:id/download и GET /:id/pdf ниже).
async function loadProtocolWithMembers(id) {
  const pRes = await query(`SELECT ${PROTOCOL_COLS} FROM protocols p WHERE p.id = $1`, [id]);
  const p = pRes.rows[0];
  if (!p) return null;
  // Порядок — по времени сдачи теста (как сотрудники проходили проверку), затем по ФИО
  const mRes = await query(`
    SELECT a.user_id, a.status, a.test_date,
           u.last_name, u.first_name, u.position, u.object, u.department,
           u.permanent_certificate_number, u.tco_badge
    FROM protocols p
    JOIN assignments a ON ${MEMBER_JOIN}
    JOIN users u ON u.id = a.user_id AND u.role = 'employee'
    WHERE p.id = $1
    ORDER BY a.test_date NULLS LAST, u.last_name, u.first_name, a.id
  `, [p.id]);
  return { protocol: p, members: mRes.rows };
}

// Подписи протокола, присоединённые к подписавшим пользователям (ФИО/должность/картинка
// подписи) — используется и для статуса на экране, и для сборки итогового PDF.
async function loadProtocolSignatures(protocolId) {
  const r = await query(`
    SELECT ps.committee_role, ps.user_id, ps.signed_at, ps.ip_address, ps.user_agent,
           u.last_name, u.first_name, u.position, u.signature_data
    FROM protocol_signatures ps
    JOIN users u ON u.id = ps.user_id
    WHERE ps.protocol_id = $1
  `, [protocolId]);
  return r.rows;
}

async function checkNotLocked(protocolId, res) {
  const r = await query('SELECT locked, status FROM protocols WHERE id = $1', [protocolId]);
  if (!r.rows[0]) { res.status(404).json({ error: 'not_found' }); return false; }
  if (r.rows[0].status === 'revoked') {
    res.status(409).json({ error: 'revoked', message: 'Протокол аннулирован — изменения запрещены' });
    return false;
  }
  if (r.rows[0].locked) {
    res.status(409).json({ error: 'locked', message: 'Протокол полностью подписан всеми членами комиссии — изменения запрещены' });
    return false;
  }
  return true;
}

// Для удаления протокола другое правило: полностью подписанный (locked), но ещё НЕ
// аннулированный протокол удалять нельзя (как и раньше) — сначала его нужно явно
// аннулировать (см. POST /:id/revoke). Уже аннулированный протокол удалить можно
// в любом состоянии locked — это лишь чистка истории, статус REVOKED у выданных по
// нему удостоверений уже зафиксирован и переживёт удаление строки протокола.
async function checkDeletable(protocolId, res) {
  const r = await query('SELECT locked, status FROM protocols WHERE id = $1', [protocolId]);
  if (!r.rows[0]) { res.status(404).json({ error: 'not_found' }); return false; }
  if (r.rows[0].locked && r.rows[0].status !== 'revoked') {
    res.status(409).json({ error: 'locked', message: 'Протокол полностью подписан всеми членами комиссии — сначала аннулируйте его, затем можно удалить' });
    return false;
  }
  return true;
}

// Скачать протокол в Word (.docx): дата открытия и номер подставляются в шапку,
// сотрудники протокола — в таблицу (ФИО кириллицей).
router.get('/:id/download', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    if (!(await assistantCanAccessProtocol(req.user, req.params.id))) {
      return res.status(403).json({ error: 'forbidden', message: 'Протокол вне вашей зоны доступа' });
    }
    const data = await loadProtocolWithMembers(req.params.id);
    if (!data) return res.status(404).json({ error: 'not_found', message: 'Протокол не найден' });
    const { protocol: p, members } = data;

    // Полностью подписанный (запечатанный) протокол — отдаём ровно тот Word, что был сохранён
    // при запечатывании (как и PDF): правки ФИО/должностей/подписей сотрудников после этого
    // на готовый документ не влияют. У протоколов, запечатанных до этого обновления, сохранённого
    // Word нет — они, как раньше, собираются из БД.
    let buffer, fileName;
    const sealedRes = await query('SELECT locked, signed_docx_data FROM protocols WHERE id = $1', [p.id]);
    const sealed = sealedRes.rows[0];
    if (sealed && sealed.locked && sealed.signed_docx_data) {
      buffer = Buffer.from(sealed.signed_docx_data, 'base64');
      fileName = protocolFileName(p.open_date, p.protocol_number);
    } else {
      const [signatures, companyStamp] = await Promise.all([
        loadProtocolSignatures(p.id),
        loadCompanyStamp()
      ]);
      ({ buffer, fileName } = await buildProtocolDocx({
        protocolNumber: p.protocol_number,
        openDate: p.open_date,
        members,
        signatures,
        companyStamp
      }));
    }

    const asciiName = `protocol_${p.open_date}_${String(p.protocol_number).replace(/[^A-Za-z0-9_-]/g, '')}.docx`;
    const encoded = encodeURIComponent(fileName).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (e) {
    console.error('Error building protocol docx:', e);
    res.status(500).json({ error: 'docx_error', message: 'Не удалось сформировать Word-файл: ' + e.message });
  }
});

// ===================== Электронное подписание протокола =====================
// Статус подписания по всем трём ролям комиссии (п.2, п.7 запроса) + может ли
// ТЕКУЩИЙ пользователь подписать прямо сейчас (своя роль, ещё не подписано,
// протокол не заблокирован).
router.get('/:id/signatures', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const pRes = await query(`SELECT ${PROTOCOL_COLS} FROM protocols p WHERE p.id = $1`, [req.params.id]);
    const p = pRes.rows[0];
    if (!p) return res.status(404).json({ error: 'not_found' });
    if (!(await assistantCanAccessProtocol(req.user, p.id))) {
      return res.status(403).json({ error: 'forbidden', message: 'Протокол вне вашей зоны доступа' });
    }

    const sigs = await loadProtocolSignatures(p.id);
    const byRole = Object.fromEntries(sigs.map(s => [s.committee_role, s]));

    const meRes = await query('SELECT committee_role, signature_data FROM users WHERE id = $1', [req.user.id]);
    const me = meRes.rows[0] || {};

    const roles = COMMITTEE_ROLES.map(role => {
      const s = byRole[role];
      return {
        role,
        label: COMMITTEE_ROLE_LABELS[role],
        signed: !!s,
        signed_by: s ? { name: `${s.last_name || ''} ${s.first_name || ''}`.trim(), position: s.position } : null,
        signed_at: s ? s.signed_at : null,
        can_sign: !p.locked && !s && me.committee_role === role
      };
    });

    res.json({
      locked: !!p.locked,
      fully_signed_at: p.fully_signed_at,
      status_label: COMMITTEE_ROLES.every(r => byRole[r]) ? 'Полностью подписан' : (sigs.length ? 'Частично подписан' : 'Не подписан'),
      roles,
      my_committee_role: me.committee_role || null,
      my_committee_role_label: me.committee_role ? COMMITTEE_ROLE_LABELS[me.committee_role] : null,
      my_signature_saved: !!me.signature_data
    });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Подписать протокол своей ролью (п.2-п.3 запроса): требует пароль аккаунта и
// заранее сохранённый образец подписи (см. routes/signatures.js). Когда подписаны
// все три роли — протокол «запечатывается» (п.6, п.8): формируется и сохраняется
// итоговый PDF, фиксируется его контрольная сумма, редактирование блокируется.
router.post('/:id/sign', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: 'password_required', message: 'Для подтверждения подписи введите пароль аккаунта' });
  }
  try {
    const uRes = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const me = uRes.rows[0];
    if (!me) return res.status(404).json({ error: 'not_found' });
    if (!me.committee_role) {
      return res.status(403).json({ error: 'no_committee_role', message: 'У вашего аккаунта не назначена роль в комиссии' });
    }
    if (!me.signature_data) {
      return res.status(400).json({ error: 'no_signature', message: 'Сначала сохраните образец подписи: «Мой профиль → Электронная подпись»' });
    }
    if (!bcrypt.compareSync(String(password), me.password_hash || '')) {
      return res.status(401).json({ error: 'invalid_password', message: 'Неверный пароль' });
    }

    const pRes = await query('SELECT id, locked FROM protocols WHERE id = $1', [req.params.id]);
    const p = pRes.rows[0];
    if (!p) return res.status(404).json({ error: 'not_found', message: 'Протокол не найден' });
    if (p.locked) {
      return res.status(409).json({ error: 'already_locked', message: 'Протокол уже полностью подписан и закрыт для изменений' });
    }

    const already = await query(
      'SELECT id FROM protocol_signatures WHERE protocol_id = $1 AND committee_role = $2',
      [p.id, me.committee_role]
    );
    if (already.rows.length) {
      return res.status(409).json({ error: 'already_signed', message: 'Эта роль уже подписала протокол' });
    }

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';
    await query(
      `INSERT INTO protocol_signatures (protocol_id, committee_role, user_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [p.id, me.committee_role, me.id, ip, ua]
    );

    const countRes = await query('SELECT COUNT(*)::int AS c FROM protocol_signatures WHERE protocol_id = $1', [p.id]);
    let fullySigned = false;
    if (countRes.rows[0].c >= COMMITTEE_ROLES.length) {
      fullySigned = true;
      const data = await loadProtocolWithMembers(p.id);
      const sigs = await loadProtocolSignatures(p.id);
      const settingsRes = await query('SELECT company_name FROM settings WHERE id = 1');
      // PDF всегда делается из Word-бланка (protocolPdf.js). Если конвертер недоступен —
      // протокол всё равно запечатывается, просто без сохранённого PDF: его можно будет
      // скачать позже, а Word-версия доступна всегда.
      // Word и PDF собираются ОДИН раз, с печатью организации, и сохраняются вместе:
      // PDF конвертируется из того же .docx, который потом отдаётся на скачивание.
      const companyStamp = await loadCompanyStamp();
      let docxBuffer = null;
      try {
        docxBuffer = (await buildProtocolDocx({
          protocolNumber: data.protocol.protocol_number,
          openDate: data.protocol.open_date,
          members: data.members,
          signatures: sigs,
          companyStamp
        })).buffer;
      } catch (docxErr) {
        console.error('[protocols] Не удалось сформировать Word при запечатывании:', docxErr.message);
      }
      let pdfBuffer = null;
      try {
        pdfBuffer = await buildProtocolPdf({
          protocol: data.protocol,
          members: data.members,
          signatures: sigs,
          companyName: (settingsRes.rows[0] || {}).company_name,
          companyStamp,
          docxBuffer
        });
      } catch (pdfErr) {
        console.error('[protocols] Не удалось сформировать PDF при запечатывании:', pdfErr.message);
      }
      const hash = pdfBuffer ? crypto.createHash('sha256').update(pdfBuffer).digest('hex') : null;
      // Запечатанный протокол заодно становится закрытым: иначе, пока он «open» и сегодняшняя дата
      // в его диапазоне, новые сдавшие тест продолжали бы добавляться в уже подписанный протокол.
      await query(
        `UPDATE protocols
            SET locked = TRUE,
                status = CASE WHEN status = 'open' THEN 'closed' ELSE status END,
                fully_signed_at = NOW(),
                pdf_hash = $1, signed_pdf_data = $2, signed_docx_data = $3
          WHERE id = $4`,
        [hash, pdfBuffer ? pdfBuffer.toString('base64') : null, docxBuffer ? docxBuffer.toString('base64') : null, p.id]
      );
    }

    // Запасное хранилище (Google Drive): только ставим в очередь, сайт облака не ждёт и от него не зависит.
    // Подпись председателя «будит» удостоверения, ждавшие её; полное подписание отправляет PDF + Word протокола.
    driveSync.wakeWaitersForProtocol(p.id);
    if (fullySigned) driveSync.enqueueProtocol(p.id);

    res.json({ ok: true, fully_signed: fullySigned });
  } catch (e) {
    console.error('Protocol sign error:', e);
    res.status(500).json({ error: 'sign_error', message: 'Не удалось подписать протокол: ' + e.message });
  }
});

// ЭТАП 2. Аннулировать протокол (§ «Автоматическое аннулирование» ТЗ): «Протокол
// аннулирован → удостоверение автоматически получает статус REVOKED». Разрешено
// суперадминистратору в любом состоянии протокола (открыт/закрыт/подписан) — это
// финальное, юридически значимое действие, поэтому пароль не запрашивается отдельно
// (сессия суперадмина уже аутентифицирована), но причина аннулирования обязательна
// для журнала. Повторное аннулирование уже аннулированного протокола — не ошибка,
// просто ничего не меняет.
router.post('/:id/revoke', authRequired, requireRole('superadmin'), async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) {
    return res.status(400).json({ error: 'reason_required', message: 'Укажите причину аннулирования протокола' });
  }
  try {
    const pRes = await query('SELECT id, status FROM protocols WHERE id = $1', [req.params.id]);
    const p = pRes.rows[0];
    if (!p) return res.status(404).json({ error: 'not_found', message: 'Протокол не найден' });
    if (p.status === 'revoked') {
      return res.json({ ok: true, already_revoked: true });
    }
    await query(
      `UPDATE protocols SET status = 'revoked', revoked_at = NOW(), revoked_by = $1, revoke_reason = $2 WHERE id = $3`,
      [req.user.id, reason, p.id]
    );
    const revokedCount = await revokeCertificatesForProtocol(p.id);
    await revokeIdCardsForProtocol(p.id);
    res.json({ ok: true, revoked_certificates: revokedCount });
  } catch (e) {
    console.error('Protocol revoke error:', e);
    res.status(500).json({ error: 'revoke_error', message: 'Не удалось аннулировать протокол: ' + e.message });
  }
});

// Журнал подписания (п.5 запроса): ФИО, роль, дата и время, IP, браузер/устройство, № протокола
router.get('/:id/journal', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    if (!(await assistantCanAccessProtocol(req.user, req.params.id))) {
      return res.status(403).json({ error: 'forbidden', message: 'Протокол вне вашей зоны доступа' });
    }
    const r = await query(`
      SELECT ps.committee_role, ps.signed_at, ps.ip_address, ps.user_agent,
             u.last_name, u.first_name, p.protocol_number
      FROM protocol_signatures ps
      JOIN users u ON u.id = ps.user_id
      JOIN protocols p ON p.id = ps.protocol_id
      WHERE ps.protocol_id = $1
      ORDER BY ps.signed_at DESC
    `, [req.params.id]);
    res.json(r.rows.map(row => ({ ...row, committee_role_label: COMMITTEE_ROLE_LABELS[row.committee_role] || row.committee_role })));
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// PDF-версия протокола со статусом подписания и подписями (п.4 запроса: пример «Подписан
// / Ожидает»). Пока протокол не подписан всеми — формируется «на лету» (предпросмотр,
// уже проставленные подписи видны). После полного подписания отдаётся ровно тот файл,
// что был сохранён при запечатывании (см. POST /:id/sign) — чтобы pdf_hash не «расходился».
router.get('/:id/pdf', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    if (!(await assistantCanAccessProtocol(req.user, req.params.id))) {
      return res.status(403).json({ error: 'forbidden', message: 'Протокол вне вашей зоны доступа' });
    }
    const pRes = await query('SELECT locked, signed_pdf_data, protocol_number, open_date FROM protocols WHERE id = $1', [req.params.id]);
    const p = pRes.rows[0];
    if (!p) return res.status(404).json({ error: 'not_found' });

    let buffer;
    if (p.locked && p.signed_pdf_data) {
      buffer = Buffer.from(p.signed_pdf_data, 'base64');
    } else {
      const data = await loadProtocolWithMembers(req.params.id);
      if (!data) return res.status(404).json({ error: 'not_found' });
      const sigs = await loadProtocolSignatures(req.params.id);
      const settingsRes = await query('SELECT company_name FROM settings WHERE id = 1');
      buffer = await buildProtocolPdf({
        protocol: data.protocol,
        members: data.members,
        signatures: sigs,
        companyName: (settingsRes.rows[0] || {}).company_name,
        companyStamp: await loadCompanyStamp()
      });
    }

    const asciiName = `protocol_${p.open_date}_${String(p.protocol_number).replace(/[^A-Za-z0-9_-]/g, '')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${asciiName}"`);
    res.send(buffer);
  } catch (e) {
    console.error('Protocol PDF error:', e);
    res.status(500).json({ error: 'pdf_error', message: 'Не удалось сформировать PDF: ' + e.message });
  }
});

// Открыть новый протокол
router.post('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { open_date, close_date } = req.body;
  let protocol_number = String(req.body.protocol_number ?? '').trim();
  if (!open_date || !close_date) {
    return res.status(400).json({ error: 'missing_fields', message: 'Укажите дату открытия и дату закрытия' });
  }
  if (new Date(close_date) < new Date(open_date)) {
    return res.status(400).json({ error: 'invalid_range', message: 'Дата закрытия не может быть раньше даты открытия' });
  }
  try {
    // Номер не введён вручную — берём следующий по нумерации года открытия
    if (!protocol_number) protocol_number = await nextProtocolNumber(String(open_date).slice(0, 4));
    if (await numberTaken(protocol_number, open_date)) {
      return res.status(409).json({ error: 'duplicate_number', message: `Протокол № ${protocol_number} за ${String(open_date).slice(0, 4)} год уже существует` });
    }
    const result = await query(`
      INSERT INTO protocols (protocol_number, open_date, close_date, status, created_by)
      VALUES ($1, $2, $3, 'open', $4)
      RETURNING id, protocol_number, status, created_by, created_at,
        to_char(open_date, 'YYYY-MM-DD') AS open_date, to_char(close_date, 'YYYY-MM-DD') AS close_date
    `, [protocol_number, open_date, close_date, req.user.id]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Изменить номер/даты протокола — ТЗ §9: сужено до суперадмина (admin теперь не может
// менять номер/даты уже открытого протокола, только открывать/закрывать/переоткрывать).
router.patch('/:id', authRequired, requireRole('superadmin'), async (req, res) => {
  const { protocol_number, open_date, close_date, status } = req.body;
  const fields = [];
  const params = [];
  if (protocol_number !== undefined) { params.push(String(protocol_number).trim()); fields.push(`protocol_number = $${params.length}`); }
  if (open_date !== undefined) { params.push(open_date); fields.push(`open_date = $${params.length}`); }
  if (close_date !== undefined) { params.push(close_date); fields.push(`close_date = $${params.length}`); }
  if (status !== undefined) {
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
    params.push(status); fields.push(`status = $${params.length}`);
  }
  if (!fields.length) return res.json({ ok: true });
  try {
    if (!(await checkNotLocked(req.params.id, res))) return;
    if (protocol_number !== undefined || open_date !== undefined) {
      const curRes = await query(`SELECT protocol_number, to_char(open_date, 'YYYY-MM-DD') AS open_date FROM protocols WHERE id = $1`, [req.params.id]);
      const cur = curRes.rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });
      const newNumber = protocol_number !== undefined ? String(protocol_number).trim() : cur.protocol_number;
      const newOpen = open_date !== undefined ? open_date : cur.open_date;
      if (await numberTaken(newNumber, newOpen, req.params.id)) {
        return res.status(409).json({ error: 'duplicate_number', message: `Протокол № ${newNumber} за ${String(newOpen).slice(0, 4)} год уже существует` });
      }
    }
    params.push(req.params.id);
    const result = await query(`
      UPDATE protocols SET ${fields.join(', ')} WHERE id = $${params.length}
      RETURNING id, protocol_number, status, created_by, created_at,
        to_char(open_date, 'YYYY-MM-DD') AS open_date, to_char(close_date, 'YYYY-MM-DD') AS close_date
    `, params);
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Закрыть протокол вручную (до истечения даты закрытия)
router.post('/:id/close', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    if (!(await checkNotLocked(req.params.id, res))) return;
    const result = await query(`UPDATE protocols SET status = 'closed' WHERE id = $1 RETURNING id, status`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Снова открыть протокол
router.post('/:id/reopen', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    if (!(await checkNotLocked(req.params.id, res))) return;
    const result = await query(`UPDATE protocols SET status = 'open' WHERE id = $1 RETURNING id, status`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Удалить протокол — ТЗ §3, §9: только суперадмин.
// ЭТАП 2: «Удалён протокол → удостоверение автоматически аннулировано» — прежде чем
// удалить строку протокола (certificates.protocol_id имеет ON DELETE SET NULL и связь
// потеряется), явно помечаем REVOKED все удостоверения, которые на него ссылались.
// Заодно отвязываем assignments.protocol_id (у него нет FK-констрейнта, поэтому сам
// по себе не очищается) — чтобы не оставалось ссылок на несуществующий протокол.
router.delete('/:id', authRequired, requireRole('superadmin'), async (req, res) => {
  try {
    if (!(await checkDeletable(req.params.id, res))) return;
    await revokeCertificatesForProtocol(req.params.id);
    await revokeIdCardsForProtocol(req.params.id);
    await query('UPDATE assignments SET protocol_id = NULL WHERE protocol_id = $1', [req.params.id]);
    await query('DELETE FROM protocols WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Найти открытый протокол, диапазон дат которого покрывает указанную дату
// (YYYY-MM-DD). Используется при сдаче теста, чтобы автоматически присвоить
// номер протокола сотруднику, который сдал именно в эти дни.
async function findActiveProtocol(dateStr) {
  const result = await query(`
    SELECT ${PROTOCOL_COLS} FROM protocols p
    WHERE p.status = 'open' AND NOT p.locked AND $1::date BETWEEN p.open_date AND p.close_date
    ORDER BY p.open_date DESC
    LIMIT 1
  `, [dateStr]);
  return result.rows[0] || null;
}

module.exports = router;
module.exports.findActiveProtocol = findActiveProtocol;
module.exports.nextProtocolNumber = nextProtocolNumber;
