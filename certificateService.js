// ЭТАП 1. Фундамент удостоверений БиОТ — сервисный слой.
//
// Связи:
//   Сотрудник -> Курс БиОТ -> Протокол -> Удостоверение
//
// Удостоверение создаётся автоматически, как только назначение (assignment)
// получает статус 'passed' — при сдаче теста (routes/assignments.js:/submit)
// или при внесении исторической записи админом (routes/assignments.js: POST /
// и POST /bulk с historical=true). Протокол в момент сдачи может быть ещё не
// привязан (assignments.protocol_id заполняется только если в этот день открыт
// протокол — см. findActiveProtocol()); в этом случае удостоверение всё равно
// создаётся (protocol_id = NULL), а номер/дата протокола видны в нём как текст
// (protocol_number/protocol_date из assignments) — так же, как это устроено в
// Word-протоколе (routes/protocols.js:MEMBER_JOIN). Отдельной таблицы подписей
// удостоверений нет: подписи наследуются из протокола (protocol_id).
const crypto = require('crypto');
const { query } = require('./db');
const { COMMITTEE_ROLES, COMMITTEE_ROLE_LABELS } = require('./lib/committeeRoles');

// Без похожих друг на друга символов (0/O, 1/I) — легче прочитать и продиктовать.
const UID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomUidSuffix(length = 6) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += UID_ALPHABET[bytes[i] % UID_ALPHABET.length];
  }
  return out;
}

// Формат: BIOT-2026-AB12CD
async function generateCertificateUid(year) {
  const y = year || new Date().getFullYear();
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `BIOT-${y}-${randomUidSuffix(6)}`;
    const existing = await query('SELECT 1 FROM certificates WHERE certificate_uid = $1', [candidate]);
    if (existing.rows.length === 0) return candidate;
  }
  // Крайне маловероятный случай серии коллизий подряд — расширяем суффикс.
  return `BIOT-${y}-${randomUidSuffix(8)}`;
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
// Идемпотентно: повторный вызов для того же assignment_id ничего не дублирует,
// а лишь освежает protocol_id/срок действия/статус (на случай, если протокол
// был назначен уже ПОСЛЕ сдачи теста, либо если статус нужно пересчитать).
async function ensureCertificateForAssignment(assignmentId) {
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
  if (a.is_external) return null; // внешний курс: сертификата нет, только удостоверение

  const certificateNumber = a.user_login || a.user_perm_cert || a.certificate_number || `A${a.id}`;
  const issueDate = toDateOnly(a.test_date) || new Date().toISOString().slice(0, 10);
  const expiryDate = a.no_expiry ? null : toDateOnly(a.next_test_date);

  const existing = await query('SELECT * FROM certificates WHERE assignment_id = $1', [assignmentId]);
  if (existing.rows.length) {
    const cert = existing.rows[0];
    const liveStatus = computeLiveStatus(cert.status, expiryDate);
    const needsUpdate = cert.protocol_id !== (a.protocol_id || null)
      || cert.expiry_date !== expiryDate
      || cert.certificate_number !== certificateNumber
      || cert.status !== liveStatus;
    if (needsUpdate) {
      const upd = await query(
        `UPDATE certificates
         SET protocol_id = $1, expiry_date = $2, certificate_number = $3, status = $4, updated_at = NOW()
         WHERE id = $5 RETURNING *`,
        [a.protocol_id || null, expiryDate, certificateNumber, liveStatus, cert.id]
      );
      return upd.rows[0];
    }
    return cert;
  }

  const year = parseInt(issueDate.slice(0, 4), 10);
  const uid = await generateCertificateUid(year);
  const token = generateVerificationToken();
  const status = computeLiveStatus('VALID', expiryDate);

  const inserted = await query(
    `INSERT INTO certificates
       (employee_id, assignment_id, protocol_id, course_id, certificate_number, certificate_uid,
        issue_date, expiry_date, status, verification_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (assignment_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [a.user_id, a.id, a.protocol_id || null, a.course_id, certificateNumber, uid,
     issueDate, expiryDate, status, token]
  );
  return inserted.rows[0];
}

// Полные данные удостоверения (для PDF/DOCX/страницы проверки) — по внутреннему UID.
async function getCertificateFullByUid(uid) {
  const res = await query(
    `SELECT cert.*,
            u.last_name, u.first_name, u.position AS user_position, u.department, u.object,
            c.title_ru, c.title_kz,
            p.protocol_number, p.open_date AS protocol_open_date,
            a.protocol_number AS assignment_protocol_number, a.protocol_date AS assignment_protocol_date
     FROM certificates cert
     JOIN users u ON u.id = cert.employee_id
     LEFT JOIN courses c ON c.id = cert.course_id
     LEFT JOIN protocols p ON p.id = cert.protocol_id
     JOIN assignments a ON a.id = cert.assignment_id
     WHERE cert.certificate_uid = $1`,
    [uid]
  );
  const row = res.rows[0];
  if (!row) return null;
  row.status = computeLiveStatus(row.status, row.expiry_date);
  row.protocol_number = row.protocol_number || row.assignment_protocol_number;
  return row;
}

// То же самое, но по id назначения (assignment) — используется старой (существующей
// в интерфейсе) ссылкой скачивания /api/certificates/:id, чтобы ничего не сломать.
async function getCertificateFullByAssignmentId(assignmentId) {
  await ensureCertificateForAssignment(assignmentId);
  const res = await query(
    `SELECT cert.certificate_uid FROM certificates cert WHERE cert.assignment_id = $1`,
    [assignmentId]
  );
  if (!res.rows[0]) return null;
  return getCertificateFullByUid(res.rows[0].certificate_uid);
}

async function listMyCertificates(userId) {
  const res = await query(
    `SELECT cert.id, cert.certificate_uid, cert.certificate_number, cert.status,
            cert.issue_date, cert.expiry_date, cert.assignment_id,
            c.title_ru, c.title_kz,
            COALESCE(p.protocol_number, a.protocol_number) AS protocol_number
     FROM certificates cert
     LEFT JOIN courses c ON c.id = cert.course_id
     LEFT JOIN protocols p ON p.id = cert.protocol_id
     JOIN assignments a ON a.id = cert.assignment_id
     WHERE cert.employee_id = $1
     ORDER BY cert.issue_date DESC NULLS LAST, cert.id DESC`,
    [userId]
  );
  return res.rows.map((r) => ({ ...r, status: computeLiveStatus(r.status, r.expiry_date) }));
}

// ЭТАП 2. Удостоверение отдельно не подписывается — источник подписей всегда протокол.
// Для удостоверения, привязанного к протоколу (certificate.protocol_id), три подписи
// комиссии (председатель / инженер по БиОТ / член комиссии) берутся ЖИВЬЁМ прямо из
// protocol_signatures + users в момент формирования PDF/DOCX (routes/certificate.js),
// а не копируются и не кэшируются в самом удостоверении. Поэтому любое изменение уже
// подписанного протокола — новая подпись, снятая подпись, изменённая должность или ФИО
// подписанта (карточка пользователя) — автоматически видно в удостоверении при следующем
// скачивании, без какой-либо отдельной синхронизации.
async function getCommitteeSignaturesForProtocol(protocolId) {
  if (!protocolId) return null;
  const r = await query(
    `SELECT ps.committee_role, ps.signed_at, u.last_name, u.first_name, u.position, u.signature_data
     FROM protocol_signatures ps
     JOIN users u ON u.id = ps.user_id
     WHERE ps.protocol_id = $1`,
    [protocolId]
  );
  const byRole = Object.fromEntries(r.rows.map((row) => [row.committee_role, row]));
  return COMMITTEE_ROLES.map((role) => {
    const s = byRole[role];
    return {
      role,
      label: COMMITTEE_ROLE_LABELS[role],
      signed: !!s,
      name: s ? `${s.last_name || ''} ${s.first_name || ''}`.trim() : '',
      position: s ? (s.position || '') : '',
      signature_data: s ? s.signature_data : null,
      signed_at: s ? s.signed_at : null
    };
  });
}

// Главное правило ЭТАПА 2: «Аннулирован протокол → автоматически аннулировано
// удостоверение». Помечает REVOKED все удостоверения, выданные на основании данного
// протокола (routes/protocols.js: POST /:id/revoke и DELETE /:id, до удаления строки
// протокола — certificates.protocol_id has ON DELETE SET NULL, поэтому статус нужно
// зафиксировать заранее, иначе после удаления связь потеряется).
async function revokeCertificatesForProtocol(protocolId) {
  const r = await query(
    `UPDATE certificates SET status = 'REVOKED', updated_at = NOW()
     WHERE protocol_id = $1 AND status <> 'REVOKED'
     RETURNING id`,
    [protocolId]
  );
  return r.rows.length;
}

module.exports = {
  generateCertificateUid,
  generateVerificationToken,
  computeLiveStatus,
  ensureCertificateForAssignment,
  getCertificateFullByUid,
  getCertificateFullByAssignmentId,
  listMyCertificates,
  getCommitteeSignaturesForProtocol,
  revokeCertificatesForProtocol
};
