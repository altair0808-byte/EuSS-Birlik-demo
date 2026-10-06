// ЗАПАСНОЕ ХРАНИЛИЩЕ В GOOGLE DRIVE.
//
// Что и куда попадает:
//   • ПРОТОКОЛЫ — только полностью подписанные (locked) и не аннулированные. PDF и Word — те самые
//     файлы, что сохранились в базе при запечатывании (protocols.signed_pdf_data / signed_docx_data):
//         Протоколы / <год> / Протокол № <номер> от <дд.мм.гггг>.pdf | .docx
//   • УДОСТОВЕРЕНИЯ — по каждому сданному курсу (в т.ч. внесённому как пройденный), PDF:
//         <Объект> / <Отдел> / <Фамилия Имя> / Удостоверение — <курс> (<дата>).pdf
//     В папках сотрудников ничего, кроме удостоверений, не лежит.
//
// Надёжность: сайт НИКОГДА не ждёт Google. Событие (подпись протокола, сдача теста) только кладёт
// строку в таблицу drive_outbox — быстро и внутри базы; отправкой занимается фоновый воркер.
// Если облако недоступно — строка остаётся в очереди и уходит повторно с нарастающей паузой.
// Любая ошибка постановки в очередь гасится (в консоль) и не ломает подпись / сдачу теста.
//
// Удостоверение по курсу со сдачей в нашей компании формируется только когда председатель подписал
// протокол (правило бланка, lib/cardLayout.js). Пока не подписано — задача ждёт (раз в час
// перепроверяется, плюс сразу «просыпается» в момент подписи председателя).
const fs = require('fs');
const path = require('path');
const { query, pool } = require('./db');
const drive = require('./lib/googleDrive');
const { ensureIdCardForAssignment, getIdCardFullByUid } = require('./idCardService');
const { getCommitteeSignaturesForProtocol } = require('./certificateService');
const { buildIdCardPdfBuffer } = require('./idCardPdf');

const LOCK_KEY = 726501; // ключ pg_advisory_lock: одновременно обрабатывает очередь только один экземпляр сервера
const TICK_MS = 30 * 1000;
const MAX_ATTEMPTS = 30;                         // ≈ 5 суток при паузе до 6 часов
const MAX_WAIT_FOR_SIGNATURE_DAYS = 90;          // ждать подписи протокола дольше — считаем задачу заброшенной
const BACKOFF_MINUTES = [1, 2, 5, 15, 30, 60, 120, 240, 360];

let timer = null;
let running = false;

// ---------- Вспомогательное ----------

function ddmmyyyy(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

// Адрес сайта для QR внутри бланка: PUBLIC_BASE_URL важнее (QR на бумаге постоянный),
// иначе — адрес, с которого пришёл запрос, запомненный при постановке задачи.
function baseUrlFromReq(req) {
  const fixed = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (fixed) return fixed.replace(/\/+$/, '');
  if (!req) return null;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function qrUrlForCard(card, baseUrl) {
  const base = String(process.env.PUBLIC_BASE_URL || baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Не задан PUBLIC_BASE_URL — не из чего собрать ссылку для QR на удостоверении');
  const hasPersonPage = fs.existsSync(path.join(__dirname, 'person.html'));
  return (hasPersonPage && card.public_uid)
    ? `${base}/p/${encodeURIComponent(card.public_uid)}`
    : `${base}/verify/${encodeURIComponent(card.card_uid)}`;
}

function backoffMs(attempts) {
  const m = BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
  return m * 60 * 1000;
}

// ---------- Постановка в очередь ----------

// Все постановки: не бросают исключений, ничего не делают, если Drive не настроен.
async function enqueue(jobs) {
  if (!drive.isConfigured() || !jobs.length) return 0;
  let n = 0;
  for (const j of jobs) {
    try {
      // Уже отправленное («done») не трогаем. Упавшее/пропущенное — ставим заново (напр., после ручной
      // кнопки «Выгрузить всё»: причина пропуска могла исчезнуть).
      const r = await query(
        `INSERT INTO drive_outbox (dedupe_key, kind, protocol_id, assignment_id, base_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (dedupe_key) DO UPDATE SET
           status = CASE WHEN drive_outbox.status IN ('failed','skipped') THEN 'pending' ELSE drive_outbox.status END,
           attempts = CASE WHEN drive_outbox.status IN ('failed','skipped') THEN 0 ELSE drive_outbox.attempts END,
           next_attempt_at = CASE WHEN drive_outbox.status IN ('failed','skipped') THEN NOW() ELSE drive_outbox.next_attempt_at END,
           base_url = COALESCE(EXCLUDED.base_url, drive_outbox.base_url),
           updated_at = NOW()
         RETURNING status`,
        [j.key, j.kind, j.protocolId || null, j.assignmentId || null, j.baseUrl || null]
      );
      if (r.rows[0] && r.rows[0].status === 'pending') n++;
    } catch (e) {
      console.error('[drive] не удалось поставить в очередь', j.key, e.message);
    }
  }
  return n;
}

function kick() {
  if (!drive.isConfigured()) return;
  setImmediate(() => { processQueue().catch((e) => console.error('[drive] воркер:', e.message)); });
}

// Протокол полностью подписан → в облако уходят PDF и Word.
async function enqueueProtocol(protocolId) {
  try {
    const n = await enqueue([
      { key: `protocol:${protocolId}:pdf`, kind: 'protocol_pdf', protocolId },
      { key: `protocol:${protocolId}:docx`, kind: 'protocol_docx', protocolId }
    ]);
    if (n) kick();
  } catch (e) { console.error('[drive] enqueueProtocol:', e.message); }
}

// Удостоверение по сданному назначению.
async function enqueueIdCard(assignmentId, req) {
  try {
    if (!drive.isConfigured()) return;
    const a = await query(
      `SELECT a.protocol_id, c.is_external FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = $1`,
      [assignmentId]
    );
    if (a.rows[0] && a.rows[0].is_external) return; // внешний курс / без протокола: удостоверения нет
    const n = await enqueue([{
      key: `idcard:${assignmentId}`, kind: 'id_card', assignmentId,
      protocolId: a.rows[0] ? a.rows[0].protocol_id : null,
      baseUrl: baseUrlFromReq(req)
    }]);
    if (n) kick();
  } catch (e) { console.error('[drive] enqueueIdCard:', e.message); }
}

// Председатель (или любой член) подписал протокол → задачи удостоверений, ждавшие подписи, будят сразу.
async function wakeWaitersForProtocol(protocolId) {
  try {
    if (!drive.isConfigured()) return;
    const r = await query(
      `UPDATE drive_outbox SET next_attempt_at = NOW()
       WHERE kind = 'id_card' AND status = 'pending' AND protocol_id = $1 AND next_attempt_at > NOW()`,
      [protocolId]
    );
    if (r.rowCount) kick();
  } catch (e) { console.error('[drive] wakeWaitersForProtocol:', e.message); }
}

// ---------- Исполнители задач ----------

class SkipJob extends Error {}

async function runProtocolJob(job) {
  const isPdf = job.kind === 'protocol_pdf';
  const r = await query(
    `SELECT id, protocol_number, status, locked, to_char(open_date, 'YYYY-MM-DD') AS open_date,
            signed_pdf_data, signed_docx_data
     FROM protocols WHERE id = $1`,
    [job.protocol_id]
  );
  const p = r.rows[0];
  if (!p) throw new SkipJob('Протокол удалён');
  if (p.status === 'revoked') throw new SkipJob('Протокол аннулирован');
  if (!p.locked) throw new SkipJob('Протокол не подписан всеми членами комиссии');

  const data = isPdf ? p.signed_pdf_data : p.signed_docx_data;
  if (!data) {
    // PDF мог не сформироваться при запечатывании (нет LibreOffice) — это временное состояние,
    // считаем обычной ошибкой с повторами; «Выгрузить всё» перепоставит, когда конвертер появится.
    throw new Error(isPdf ? 'PDF протокола ещё не сформирован (нет конвертера?)' : 'Word протокола ещё не сформирован');
  }
  const year = (p.open_date || '').slice(0, 4) || String(new Date().getFullYear());
  const ext = isPdf ? 'pdf' : 'docx';
  const fileName = `Протокол № ${p.protocol_number} от ${ddmmyyyy(p.open_date)}.${ext}`;
  const segments = ['Протоколы', year];
  const res = await drive.uploadFile({
    key: job.dedupe_key, segments, fileName,
    buffer: Buffer.from(data, 'base64'),
    mimeType: isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  return { fileId: res.fileId, drivePath: `${segments.join('/')}/${drive.sanitizeName(fileName)}` };
}

async function runIdCardJob(job) {
  const card0 = await ensureIdCardForAssignment(job.assignment_id);
  if (!card0) throw new SkipJob('Назначение удалено или курс не сдан');
  const card = await getIdCardFullByUid(card0.card_uid);
  if (!card) throw new SkipJob('Удостоверение не найдено');
  if (card.status === 'REVOKED') throw new SkipJob('Удостоверение аннулировано');

  const sRes = await query('SELECT * FROM settings WHERE id = 1');
  const settings = sRes.rows[0] || {};
  const sigs = card.is_external ? null : await getCommitteeSignaturesForProtocol(card.protocol_id);
  // protocol_not_signed бросит сам сборщик бланка (lib/cardLayout.js) — обработчик ниже превратит в ожидание.
  const pdf = await buildIdCardPdfBuffer(card, settings, qrUrlForCard(card, job.base_url), sigs);

  const fullName = `${card.last_name || ''} ${card.first_name || ''}`.trim();
  const segments = [
    String(card.object || '').trim() || 'Без объекта',
    String(card.department || '').trim() || 'Без отдела',
    fullName || `Сотрудник ${card.employee_id}`
  ];
  const course = card.title_ru || card.title_kz || 'курс';
  // Дата выдачи берётся из БД строкой (DATE → YYYY-MM-DD), без сдвига по часовому поясу сервера.
  const dRes = await query(`SELECT to_char(issue_date, 'YYYY-MM-DD') AS d FROM id_cards WHERE id = $1`, [card.id]);
  const dateStr = ddmmyyyy(dRes.rows[0] && dRes.rows[0].d);
  const fileName = `Удостоверение — ${course}${dateStr ? ` (${dateStr})` : ''}.pdf`;

  const res = await drive.uploadFile({
    key: job.dedupe_key, segments, fileName, buffer: pdf, mimeType: 'application/pdf'
  });
  return { fileId: res.fileId, drivePath: `${segments.map((s) => drive.sanitizeName(s)).join('/')}/${drive.sanitizeName(fileName)}` };
}

// ---------- Воркер ----------

async function processJob(job) {
  try {
    const out = job.kind === 'id_card' ? await runIdCardJob(job) : await runProtocolJob(job);
    await query(
      `UPDATE drive_outbox SET status = 'done', drive_file_id = $1, drive_path = $2, uploaded_at = NOW(),
              last_error = NULL, updated_at = NOW() WHERE id = $3`,
      [out.fileId, out.drivePath, job.id]
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof SkipJob) {
      await query(`UPDATE drive_outbox SET status = 'skipped', last_error = $1, updated_at = NOW() WHERE id = $2`, [e.message, job.id]);
      return { ok: true };
    }
    if (e && e.code === 'protocol_not_signed') {
      // Не ошибка облака: бланк удостоверения выдаётся только после подписи председателя.
      const ageDays = (Date.now() - new Date(job.created_at).getTime()) / 86400000;
      if (ageDays > MAX_WAIT_FOR_SIGNATURE_DAYS) {
        await query(`UPDATE drive_outbox SET status = 'failed', last_error = $1, updated_at = NOW() WHERE id = $2`,
          [`Протокол не подписан председателем более ${MAX_WAIT_FOR_SIGNATURE_DAYS} дней`, job.id]);
      } else {
        await query(
          `UPDATE drive_outbox SET next_attempt_at = NOW() + INTERVAL '1 hour',
                  last_error = 'Ожидает подписи председателя на протоколе', updated_at = NOW() WHERE id = $1`,
          [job.id]
        );
      }
      return { ok: true };
    }
    const attempts = job.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    const msg = String((e && e.message) || e).slice(0, 500);
    await query(
      `UPDATE drive_outbox SET attempts = $1, status = $2, last_error = $3,
              next_attempt_at = NOW() + ($4::text || ' milliseconds')::interval, updated_at = NOW() WHERE id = $5`,
      [attempts, dead ? 'failed' : 'pending', msg, String(backoffMs(attempts)), job.id]
    );
    console.error(`[drive] задача ${job.id} (${job.dedupe_key}) не отправлена, попытка ${attempts}:`, msg);
    // Проблема на стороне Google / сети / доступа — нет смысла долбить остальные задачи в этом проходе.
    const systemic = e instanceof drive.DriveError;
    return { ok: false, systemic };
  }
}

async function processQueue() {
  if (!drive.isConfigured() || running) return;
  running = true;
  let client = null;
  try {
    client = await pool.connect();
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!lock.rows[0].ok) return; // очередь уже разбирает другой экземпляр сервера
    try {
      const startedAt = Date.now();
      // Пока есть что отправлять (но не дольше 10 минут за проход — остальное в следующий тик)
      while (Date.now() - startedAt < 10 * 60 * 1000) {
        const due = await query(
          `SELECT * FROM drive_outbox WHERE status = 'pending' AND next_attempt_at <= NOW()
           ORDER BY id LIMIT 20`
        );
        if (!due.rows.length) break;
        let stop = false;
        for (const job of due.rows) {
          const r = await processJob(job);
          if (!r.ok && r.systemic) { stop = true; break; }
        }
        if (stop) break;
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    if (client) client.release();
    running = false;
  }
}

function startWorker() {
  if (timer) return;
  if (!drive.isConfigured()) {
    console.log('[drive] Google Drive не настроен (GDRIVE_*) — запасное хранилище выключено');
    return;
  }
  console.log(`[drive] запасное хранилище включено (${drive.authMode()})`);
  timer = setInterval(() => { processQueue().catch((e) => console.error('[drive] воркер:', e.message)); }, TICK_MS);
  if (timer.unref) timer.unref();
  kick();
}

// ---------- «Выгрузить всё, что уже есть» ----------

// Идемпотентно: уже отправленное не дублируется, аннулированное и неподписанное не берётся.
async function enqueueEverything(req) {
  if (!drive.isConfigured()) throw new Error('Google Drive не настроен (см. env.example: GDRIVE_*)');
  const baseUrl = baseUrlFromReq(req);

  const protocols = await query(
    `SELECT id FROM protocols WHERE locked = TRUE AND status <> 'revoked' ORDER BY id`
  );
  const jobs = [];
  for (const p of protocols.rows) {
    jobs.push({ key: `protocol:${p.id}:pdf`, kind: 'protocol_pdf', protocolId: p.id });
    jobs.push({ key: `protocol:${p.id}:docx`, kind: 'protocol_docx', protocolId: p.id });
  }

  // Сданные курсы сотрудников: удостоверения могли быть ещё не созданы (создаются при первом открытии) —
  // ensureIdCardForAssignment внутри задачи создаст недостающее, поэтому берём именно назначения.
  const passed = await query(
    `SELECT a.id, a.protocol_id
       FROM assignments a
       JOIN users u ON u.id = a.user_id AND u.role = 'employee'
      WHERE a.status = 'passed'
        AND NOT EXISTS (SELECT 1 FROM courses xc WHERE xc.id = a.course_id AND xc.is_external)
        AND NOT EXISTS (SELECT 1 FROM id_cards c WHERE c.assignment_id = a.id AND c.status = 'REVOKED')
      ORDER BY a.id`
  );
  for (const a of passed.rows) {
    jobs.push({ key: `idcard:${a.id}`, kind: 'id_card', assignmentId: a.id, protocolId: a.protocol_id, baseUrl });
  }

  const queued = await enqueue(jobs);
  kick();
  return { protocols: protocols.rows.length, id_cards: passed.rows.length, queued };
}

async function retryFailed() {
  const r = await query(
    `UPDATE drive_outbox SET status = 'pending', attempts = 0, next_attempt_at = NOW(), updated_at = NOW()
     WHERE status = 'failed' RETURNING id`
  );
  if (r.rowCount) kick();
  return r.rowCount;
}

async function getStatus() {
  const counts = await query(`SELECT status, COUNT(*)::int AS n FROM drive_outbox GROUP BY status`);
  const byStatus = { pending: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of counts.rows) byStatus[row.status] = row.n;
  const waiting = await query(
    `SELECT COUNT(*)::int AS n FROM drive_outbox WHERE status = 'pending' AND last_error LIKE 'Ожидает подписи%'`
  );
  const problems = await query(
    `SELECT id, kind, status, attempts, last_error, drive_path, next_attempt_at, updated_at
       FROM drive_outbox
      WHERE (status = 'failed') OR (status = 'pending' AND attempts > 0)
      ORDER BY updated_at DESC LIMIT 20`
  );
  return {
    configured: drive.isConfigured(),
    auth_mode: drive.authMode(),
    counts: byStatus,
    waiting_for_signature: waiting.rows[0].n,
    problems: problems.rows
  };
}

module.exports = {
  enqueueProtocol, enqueueIdCard, wakeWaitersForProtocol, enqueueEverything, retryFailed,
  getStatus, startWorker, processQueue, kick
};
