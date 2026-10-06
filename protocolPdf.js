// PDF-версия протокола комиссии — должна выглядеть РОВНО как присланный образец
// (templates/protocol_template.docx / «Протокол по БиОТ № 027»): один лист, без
// дополнительных служебных страниц. Подход: buildProtocolDocx() уже умеет вписывать
// реальные подписи членов комиссии прямо в строки бланка (protocolDocx.js,
// embedSignaturesIntoXml) — здесь этот .docx просто конвертируется в PDF через
// LibreOffice headless (сохраняет вёрстку практически 1:1) и возвращается как есть,
// без каких-либо оверлеев поверх.
//
// Если LibreOffice недоступен в окружении (переменная SOFFICE_PATH не задана и
// soffice/libreoffice не нашлись в PATH) — используем запасной вариант: старую
// самостоятельно свёрстанную через pdfkit версию (buildProtocolPdfDrawn ниже), чтобы
// скачивание PDF не ломалось совсем, только предупреждаем в логах. Этот запасной
// вариант — единственное место, где статус подписания рисуется отдельным блоком,
// т.к. вёрстка там и так не копирует Word-бланк 1:1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const PDFDocument = require('pdfkit');
const { buildEmployeeRows, buildProtocolDocx } = require('./protocolDocx');
const { COMMITTEE_ROLES, COMMITTEE_ROLE_LABELS } = require('./lib/committeeRoles');

const FONT_REG = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr || '');
  return `${m[3]}.${m[2]}.${m[1]}`;
}

// Подпись приходит с фронтенда как data:image/png;base64,... (см. index.html, saveMySignature)
function sigImageBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return null;
  const idx = dataUrl.indexOf('base64,');
  if (idx === -1) return null;
  try { return Buffer.from(dataUrl.slice(idx + 7), 'base64'); } catch (e) { return null; }
}

// protocol: { protocol_number, open_date, close_date, created_at, fully_signed_at, pdf_version }
// members: строки БД, как для buildProtocolDocx (buildEmployeeRows схлопывает их по сотруднику)
// signatures: [{ committee_role, signed_at, last_name, first_name, position, signature_data }]
// companyName: settings.company_name
function buildProtocolPdfDrawn({ protocol, members, signatures, companyName }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 36, left: 40, right: 40 } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hasFonts = fs.existsSync(FONT_REG);
      const hasBoldFont = fs.existsSync(FONT_BOLD);
      if (hasFonts) doc.registerFont('DejaVu', FONT_REG);
      if (hasBoldFont) doc.registerFont('DejaVu-Bold', FONT_BOLD);
      const fReg = (s = 10) => { if (hasFonts) doc.font('DejaVu'); doc.fontSize(s); };
      const fBold = (s = 10) => { if (hasBoldFont) doc.font('DejaVu-Bold'); else if (hasFonts) doc.font('DejaVu'); doc.fontSize(s); };

      const PAGE_LEFT = 40;
      const PAGE_W = 595.28 - 40 - 40; // A4 портрет минус поля

      fBold(13); doc.fillColor('#0f3b6c');
      doc.text(companyName || 'ТОО «Компания»', { align: 'center' });
      doc.moveDown(0.15);
      fBold(15); doc.fillColor('#1b365d');
      doc.text(`ПРОТОКОЛ № ${protocol.protocol_number}`, { align: 'center' });
      fReg(9.5); doc.fillColor('#555555');
      doc.text(`Заседания комиссии по проверке знаний за период ${fmtDate(protocol.open_date)} — ${fmtDate(protocol.close_date)}`, { align: 'center' });
      doc.moveDown(0.7);

      // ===== Статус подписания (п.7 запроса) =====
      const sigByRole = Object.fromEntries((signatures || []).map(s => [s.committee_role, s]));
      const allSigned = COMMITTEE_ROLES.every(r => sigByRole[r]);

      fBold(10); doc.fillColor('#000000');
      doc.text('Статус подписания:');
      doc.moveDown(0.15);
      COMMITTEE_ROLES.forEach((role) => {
        const s = sigByRole[role];
        fReg(9.3);
        doc.fillColor(s ? '#0a7a3d' : '#a15c00');
        const mark = s ? 'Подписан' : 'Ожидает подписи';
        const who = s ? `— ${(s.last_name || '')} ${(s.first_name || '')}`.trim() + (s.signed_at ? `, ${fmtDateTime(s.signed_at)}` : '') : '';
        doc.text(`   ${COMMITTEE_ROLE_LABELS[role]}: ${mark}  ${who}`);
      });
      doc.moveDown(0.1);
      fBold(9.5);
      doc.fillColor(allSigned ? '#0a7a3d' : '#a15c00');
      doc.text(`Общий статус: ${allSigned ? 'Полностью подписан' : 'Частично подписан'}`);
      doc.moveDown(0.7);
      doc.fillColor('#000000');

      // ===== Таблица сотрудников протокола =====
      const employees = buildEmployeeRows(members);
      const cols = [
        { key: 'n', label: '№', w: 24 },
        { key: 'fio', label: 'ФИО', w: 140 },
        { key: 'pos', label: 'Должность', w: 116 },
        { key: 'dept', label: 'Отдел / объект', w: 95 },
        { key: 'mark', label: 'Результат', w: PAGE_W - (24 + 140 + 116 + 95) }
      ];
      const rowH = 16;
      let y = doc.y;

      const drawHeaderRow = () => {
        fBold(8.3); doc.fillColor('#ffffff');
        doc.rect(PAGE_LEFT, y, PAGE_W, rowH).fill('#334155');
        doc.fillColor('#ffffff');
        let cx = PAGE_LEFT;
        cols.forEach(c => { doc.text(c.label, cx + 3, y + 4, { width: c.w - 6 }); cx += c.w; });
        y += rowH;
      };
      drawHeaderRow();

      fReg(8.1); doc.fillColor('#000000');
      employees.forEach((e, i) => {
        if (y > 760) {
          doc.addPage();
          y = 40;
          drawHeaderRow();
          fReg(8.1); doc.fillColor('#000000');
        }
        if (i % 2 === 1) doc.rect(PAGE_LEFT, y, PAGE_W, rowH).fill('#f1f5f9');
        doc.fillColor('#000000');
        let cx = PAGE_LEFT;
        cols.forEach(c => {
          doc.text(String(e[c.key] ?? ''), cx + 3, y + 4, { width: c.w - 6, height: rowH - 2, ellipsis: true });
          cx += c.w;
        });
        y += rowH;
      });
      doc.y = y + 14;

      // ===== Блок подписей комиссии =====
      if (doc.y > 660) doc.addPage();
      fBold(10.5); doc.fillColor('#000000');
      doc.text('Подписи комиссии');
      doc.moveDown(0.35);

      const colW = PAGE_W / 3;
      const startY = doc.y;
      let maxBottom = startY;
      COMMITTEE_ROLES.forEach((role, i) => {
        const colX = PAGE_LEFT + i * colW;
        const s = sigByRole[role];
        fReg(8.4); doc.fillColor('#444444');
        doc.text(COMMITTEE_ROLE_LABELS[role], colX, startY, { width: colW - 10, align: 'center' });

        const sigTop = startY + 16;
        if (s && s.signature_data) {
          const buf = sigImageBuffer(s.signature_data);
          if (buf) {
            try { doc.image(buf, colX + colW / 2 - 55, sigTop, { fit: [110, 40] }); } catch (e) { /* пропускаем битую картинку подписи */ }
          }
        }
        const lineY = sigTop + 46;
        doc.moveTo(colX + 10, lineY).lineTo(colX + colW - 20, lineY).strokeColor('#999999').lineWidth(0.7).stroke();

        fReg(8.2); doc.fillColor('#000000');
        const name = s ? `${s.last_name || ''} ${s.first_name || ''}`.trim() : '—';
        doc.text(name || '—', colX, lineY + 4, { width: colW - 10, align: 'center' });
        if (s && s.position) {
          fReg(7.3); doc.fillColor('#666666');
          doc.text(s.position, colX, lineY + 15, { width: colW - 10, align: 'center' });
        }
        if (s && s.signed_at) {
          fReg(7.3); doc.fillColor('#666666');
          doc.text(fmtDateTime(s.signed_at), colX, lineY + 26, { width: colW - 10, align: 'center' });
        }
        maxBottom = Math.max(maxBottom, lineY + 38);
      });
      doc.y = maxBottom + 12;
      doc.fillColor('#000000');

      // ===== Служебная информация (п.6 запроса) =====
      fReg(7.4); doc.fillColor('#888888');
      const createdStr = fmtDate(protocol.created_at ? String(protocol.created_at).slice(0, 10) : protocol.open_date);
      let footer = `Версия протокола: ${protocol.pdf_version || 1}    Дата создания: ${createdStr}`;
      if (protocol.fully_signed_at) footer += `    Дата последнего подписания: ${fmtDateTime(protocol.fully_signed_at)}`;
      doc.text(footer, PAGE_LEFT, doc.y, { width: PAGE_W, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Конвертирует буфер .docx в буфер .pdf.
// Два пути:
//   1) unoconv — подключается к уже ЗАПУЩЕННОМУ фоновому LibreOffice-слушателю
//      (см. start.sh: soffice поднят один раз при старте контейнера и слушает
//      сокет 127.0.0.1:2002). Конвертация занимает секунды, т.к. не тратится
//      время на повторный запуск самого LibreOffice на каждый клик «Скачать PDF».
//   2) soffice --convert-to — старый способ, поднимает LibreOffice с нуля на
//      каждый вызов (медленно, 5-40+ сек в зависимости от мощности сервера), но
//      не требует фонового слушателя — работает и без start.sh (например, при
//      установке LibreOffice напрямую на VPS без Docker).
// Путь к бинарнику soffice можно переопределить переменной окружения SOFFICE_PATH.
function writeTmpDocx(docxBuffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-pdf-'));
  const docxPath = path.join(tmpDir, 'protocol.docx');
  fs.writeFileSync(docxPath, docxBuffer);
  return {
    tmpDir,
    docxPath,
    pdfPath: path.join(tmpDir, 'protocol.pdf'),
    cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  };
}

// Общий (постоянный) профиль LibreOffice + очередь. Раньше профиль создавался заново на каждый
// вызов — это самая долгая часть холодного старта (на слабом сервере десятки секунд). Теперь профиль
// создаётся один раз и переиспользуется, а чтобы два запроса не упирались в его lock-файл
// ("another instance is already running"), конвертации идут строго по очереди.
const SHARED_PROFILE_DIR = path.join(os.tmpdir(), 'lo-profile-shared');
let convertQueue = Promise.resolve();

function runSoffice(docxPath, tmpDir, sofficeBin) {
  return new Promise((resolve, reject) => {
    const soffice = sofficeBin || process.env.SOFFICE_PATH || 'soffice';
    execFile(
      soffice,
      [
        '--headless', '--invisible', '--nocrashreport', '--nodefault', '--nologo',
        '--nofirststartwizard', '--norestore',
        `-env:UserInstallation=file://${SHARED_PROFILE_DIR}`,
        '--convert-to', 'pdf', '--outdir', tmpDir, docxPath
      ],
      { timeout: 90000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error('Конвертация LibreOffice не удалась: ' + (stderr || err.message)));
        resolve();
      }
    );
  });
}

function convertViaSofficeDirect(docxPath, tmpDir, sofficeBin) {
  const job = convertQueue.then(() => runSoffice(docxPath, tmpDir, sofficeBin));
  convertQueue = job.catch(() => {});
  return job;
}

// Прогрев: один раз после старта сервера конвертируем пустой шаблон, чтобы профиль LibreOffice уже
// существовал к первому «Скачать PDF». Ошибки игнорируются (прогрев — просто ускорение).
async function warmUpPdfConverter() {
  try {
    const tpl = path.join(__dirname, 'templates', 'protocol_template.docx');
    if (!fs.existsSync(tpl)) return;
    for (const bin of SOFFICE_CANDIDATES) {
      try { await convertDocxToPdf(fs.readFileSync(tpl), bin); return; } catch (e) { /* пробуем следующий */ }
    }
  } catch (e) { /* ignore */ }
}

async function convertDocxToPdf(docxBuffer, sofficeBin) {
  const { tmpDir, docxPath, pdfPath, cleanup } = writeTmpDocx(docxBuffer);
  try {
    await convertViaSofficeDirect(docxPath, tmpDir, sofficeBin);
    const buf = fs.readFileSync(pdfPath);
    cleanup();
    return buf;
  } catch (e) {
    cleanup();
    throw e;
  }
}

// Точка входа, которую вызывает routes/protocols.js (GET /:id/pdf, POST /:id/sign).
//
// ВАЖНО (исправление): PDF-протокол ВСЕГДА получается конвертацией того же самого
// .docx-бланка, что скачивается кнопкой «Word». Раньше при недоступном LibreOffice
// молча включался запасной pdfkit-вариант с другой вёрсткой — из-за этого PDF и Word
// выглядели по-разному. Теперь запасной вариант по умолчанию ВЫКЛЮЧЕН: если конвертация
// невозможна, роут вернёт понятную ошибку («скачайте Word-версию / установите
// LibreOffice»), но никогда не отдаст документ с чужой вёрсткой.
// Включить старое поведение можно переменной окружения PROTOCOL_PDF_FALLBACK=1.
const SOFFICE_CANDIDATES = [
  process.env.SOFFICE_PATH,
  'soffice',
  'libreoffice',
  '/usr/bin/soffice',
  '/usr/bin/libreoffice',
  '/usr/lib/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe'
].filter(Boolean);

// companyStamp — печать организации (Buffer/data:image), без неё печать в PDF не появляется.
// docxBuffer — необязательно: уже собранный Word-бланк (при запечатывании PDF конвертируется
// из ТОГО ЖЕ .docx, что сохраняется для скачивания, — чтобы Word и PDF не расходились).
async function buildProtocolPdf({ protocol, members, signatures, companyName, companyStamp, docxBuffer: readyDocx }) {

  const docxBuffer = readyDocx || (await buildProtocolDocx({
    protocolNumber: protocol.protocol_number,
    openDate: protocol.open_date,
    members,
    signatures,
    companyStamp
  })).buffer;

  let lastError = null;

  // Спавним soffice с нуля на каждый вызов, с изолированным профилем
  // (см. convertViaSofficeDirect) — без общего фонового демона (вариант А по
  // OOM, start.sh больше его не поднимает) это единственный надёжный путь.
  // Перебор нескольких кандидатов бинарника нужен только на случай разных
  // окружений (Docker/VPS/локально) — на самом Render обычно срабатывает
  // первый же (soffice из libreoffice-writer).
  for (const bin of SOFFICE_CANDIDATES) {
    try {
      return await convertDocxToPdf(docxBuffer, bin);
    } catch (e) {
      lastError = e;
    }
  }

  if (process.env.PROTOCOL_PDF_FALLBACK === '1') {
    console.error('[protocolPdf] LibreOffice недоступен, включён запасной вариант (вёрстка отличается от Word):', lastError && lastError.message);
    return buildProtocolPdfDrawn({ protocol, members, signatures, companyName });
  }

  throw new Error(
    'PDF формируется из того же Word-бланка через LibreOffice, но конвертер недоступен на сервере. '
    + 'Скачайте Word-версию протокола или установите LibreOffice (переменная SOFFICE_PATH). '
    + 'Подробности: ' + (lastError ? lastError.message : 'неизвестная ошибка')
  );
}

module.exports = { buildProtocolPdf, buildProtocolPdfDrawn, warmUpPdfConverter };
