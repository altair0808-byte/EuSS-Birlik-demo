// УДОСТОВЕРЕНИЕ (id_cards) — отдельный документ, НЕ сертификат.
//
// Разделение понятий (по запросу заказчика):
//   • СЕРТИФИКАТ (certificates / certificateService.js) — остаётся ровно таким, каким был:
//     свой бланк, свой UID (BIOT-...), свои PDF/DOCX, своя страница проверки.
//   • УДОСТОВЕРЕНИЕ (id_cards / этот файл) — второй, самостоятельный документ,
//     который выдаётся на то же успешно сданное назначение (assignment).
//     Номер удостоверения = ЛОГИН сотрудника (users.login) — постоянный номер человека,
//     он не меняется от курса к курсу и не зависит от нумерации сертификатов.
//     UID для QR-проверки — свой: UD-<год>-XXXXXX.
//
// Бланк удостоверения (idCardPdf.js / idCardDocx.js) — временный: заказчик пришлёт
// образец, после чего меняется ТОЛЬКО вёрстка в этих двух файлах, структура данных
// и роуты остаются прежними.
//
// Подписи удостоверение отдельно не хранит — как и сертификат, берёт их живьём из
// протокола (certificateService.getCommitteeSignaturesForProtocol).
const crypto = require('crypto');
const { query } = require('./db');

const UID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomUidSuffix(length = 6) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += UID_ALPHABET[bytes[i] % UID_ALPHABET.length];
  return out;
}

// Формат UID удостоверения: UD-2026-AB12CD (отличается от сертификата BIOT-2026-...)
async function generateIdCardUid(year) {
  const y = year || new Date().getFullYear();
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `UD-${y}-${randomUidSuffix(6)}`;
    const existing = await query('SELECT 1 FROM id_cards WHERE card_uid = $1', [candidate]);
    if (existing.rows.length === 0) return candidate;
  }
  return `UD-${y}-${randomUidSuffix(8)}`;
}

function generateVerificationToken() {
  return crypto.randomBytes(24).toString('hex');
}

function toDateOnly(v) {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function computeLiveStatus(storedStatus, expiryDate) {
  if (storedStatus === 'REVOKED') return 'REVOKED';
  if (expiryDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (expiryDate < today) return 'EXPIRED';
  }
  return 'VALID';
}

// Создаёт удостоверение для успешно пройденного назначения, если его ещё нет.
// Идемпотентно — повторный вызов только освежает протокол/срок/статус/номер.
async function ensureIdCardForAssignment(assignmentId) {
  const aRes = await query(
    `SELECT a.*, u.login AS user_login, u.permanent_certificate_number AS user_perm_cert,
            c.validity_months, c.no_expiry, c.is_external
     FROM assignments a
     JOIN users u ON u.id = a.user_id
     JOIN courses c ON c.id = a.course_id
     WHERE a.id = $1`,
    [assignmentId]
  );
  const a = aRes.rows[0];
  if (!a || a.status !== 'passed') return null;
  // Внешний курс / курс без протокола: удостоверение не выпускается (обучение видно по QR и в статистике).
  if (a.is_external) return null;

  // Номер удостоверения = логин сотрудника (решение заказчика).
  const cardNumber = a.user_login || a.user_perm_cert || `A${a.id}`;
  const issueDate = toDateOnly(a.test_date) || new Date().toISOString().slice(0, 10);
  const expiryDate = a.no_expiry ? null : toDateOnly(a.next_test_date);

  const existing = await query('SELECT * FROM id_cards WHERE assignment_id = $1', [assignmentId]);
  if (existing.rows.length) {
    const card = existing.rows[0];
    const liveStatus = computeLiveStatus(card.status, expiryDate);
    const needsUpdate = card.protocol_id !== (a.protocol_id || null)
      || card.expiry_date !== expiryDate
      || card.card_number !== cardNumber
      || card.status !== liveStatus;
    if (needsUpdate) {
      const upd = await query(
        `UPDATE id_cards
         SET protocol_id = $1, expiry_date = $2, card_number = $3, status = $4, updated_at = NOW()
         WHERE id = $5 RETURNING *`,
        [a.protocol_id || null, expiryDate, cardNumber, liveStatus, card.id]
      );
      return upd.rows[0];
    }
    return card;
  }

  const year = parseInt(issueDate.slice(0, 4), 10);
  const uid = await generateIdCardUid(year);
  const token = generateVerificationToken();
  const status = computeLiveStatus('VALID', expiryDate);

  const inserted = await query(
    `INSERT INTO id_cards
       (employee_id, assignment_id, protocol_id, course_id, card_number, card_uid,
        issue_date, expiry_date, status, verification_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (assignment_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [a.user_id, a.id, a.protocol_id || null, a.course_id, cardNumber, uid,
     issueDate, expiryDate, status, token]
  );
  return inserted.rows[0];
}

async function getIdCardFullByUid(uid) {
  const res = await query(
    `SELECT card.*,
            u.last_name, u.first_name, u.position AS user_position, u.department, u.object,
            u.iin, u.login AS user_login, u.public_uid,
            to_char(u.hire_date, 'YYYY-MM-DD') AS employee_hire_date,
            c.title_ru, c.title_kz, c.card_color, c.is_external,
            p.protocol_number, p.open_date AS protocol_open_date,
            a.protocol_number AS assignment_protocol_number, a.protocol_date AS assignment_protocol_date,
            a.score_percent, a.test_date
     FROM id_cards card
     JOIN users u ON u.id = card.employee_id
     LEFT JOIN courses c ON c.id = card.course_id
     LEFT JOIN protocols p ON p.id = card.protocol_id
     JOIN assignments a ON a.id = card.assignment_id
     WHERE card.card_uid = $1`,
    [uid]
  );
  const row = res.rows[0];
  if (!row) return null;
  row.status = computeLiveStatus(row.status, row.expiry_date);
  row.protocol_number = row.protocol_number || row.assignment_protocol_number;
  return row;
}

async function getIdCardFullByAssignmentId(assignmentId) {
  await ensureIdCardForAssignment(assignmentId);
  const res = await query('SELECT card_uid FROM id_cards WHERE assignment_id = $1', [assignmentId]);
  if (!res.rows[0]) return null;
  return getIdCardFullByUid(res.rows[0].card_uid);
}

async function listMyIdCards(userId) {
  const res = await query(
    `SELECT card.id, card.card_uid, card.card_number, card.status,
            card.issue_date, card.expiry_date, card.assignment_id,
            c.title_ru, c.title_kz, c.card_color, c.is_external, a.score_percent, a.test_date,
            COALESCE(p.protocol_number, a.protocol_number) AS protocol_number
     FROM id_cards card
     LEFT JOIN courses c ON c.id = card.course_id
     LEFT JOIN protocols p ON p.id = card.protocol_id
     JOIN assignments a ON a.id = card.assignment_id
     WHERE card.employee_id = $1
     ORDER BY card.issue_date DESC NULLS LAST, card.id DESC`,
    [userId]
  );
  return res.rows.map((r) => ({ ...r, status: computeLiveStatus(r.status, r.expiry_date) }));
}

// Аннулирован протокол → аннулированы и удостоверения по нему (как у сертификатов).
async function revokeIdCardsForProtocol(protocolId) {
  const r = await query(
    `UPDATE id_cards SET status = 'REVOKED', updated_at = NOW()
     WHERE protocol_id = $1 AND status <> 'REVOKED'
     RETURNING id`,
    [protocolId]
  );
  return r.rows.length;
}

module.exports = {
  generateIdCardUid,
  computeLiveStatus,
  ensureIdCardForAssignment,
  getIdCardFullByUid,
  getIdCardFullByAssignmentId,
  listMyIdCards,
  revokeIdCardsForProtocol
};
