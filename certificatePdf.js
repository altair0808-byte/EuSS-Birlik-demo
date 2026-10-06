// Генерация PDF удостоверения о проверке знаний по БиОТ.
// Логика печати/подписи/логотипа перенесена почти без изменений из прежнего
// routes/certificate.js (та же тщательно подобранная геометрия печати и подписи —
// см. константы STAMP_D/SIG_MAX_W/SIG_MAX_H), но:
//   1) вынесена в отдельный модуль, чтобы её могли использовать разные роуты
//      (по id назначения — старая ссылка, и по certificate_uid — новая);
//   2) возвращает Buffer, а не пишет сразу в res — удобно и для скачивания, и для
//      будущей рассылки по email;
//   3) добавлен QR-код (ссылка на /verify/:uid) и печать UID удостоверения.
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const QRCode = require('qrcode');

const FONT_REG = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('ru-RU');
}

function fetchRemoteBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) {
        resp.resume();
        return reject(new Error('HTTP ' + resp.statusCode + ' for ' + url));
      }
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
    const localPath = path.join(__dirname, imgVal.replace(/^\//, ''));
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
  } catch (e) {
    console.error('Error resolving image buffer:', e);
  }
  return null;
}

// ===================== Реальные размеры печати и подписи =====================
const MM = 72 / 25.4;
const STAMP_D = 42 * MM;
const SIG_MAX_W = 55 * MM;
const SIG_MAX_H = 22 * MM;
const STAMP_SHIFT_LEFT = 30 * MM;

let sharp = null;
try { sharp = require('sharp'); } catch (e) {
  console.warn('[certificatePdf] пакет sharp не найден — печать и подпись вставляются как есть (без автообрезки полей)');
}

const cleanedImageCache = new Map();

async function trimStampLikeImage(buf, cacheKey) {
  if (!sharp || !buf) return buf;
  if (cacheKey && cleanedImageCache.has(cacheKey)) return cleanedImageCache.get(cacheKey);
  try {
    const { data, info } = await sharp(buf, { limitInputPixels: 50e6 })
      .rotate()
      .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;

    const isPaper = (i) => data[i + 3] > 200 && Math.min(data[i], data[i + 1], data[i + 2]) >= 225;
    const at = (x, y) => (y * width + x) * 4;
    const paperCorners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
      .filter(isPaper).length;
    if (paperCorners >= 3) {
      for (let i = 0; i < data.length; i += 4) {
        const m = Math.min(data[i], data[i + 1], data[i + 2]);
        if (m >= 235) data[i + 3] = 0;
        else if (m > 190) data[i + 3] = Math.round(data[i + 3] * (235 - m) / 45);
      }
    }

    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return buf;

    const pad = 2;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const cw = Math.min(width, maxX + pad + 1) - left;
    const ch = Math.min(height, maxY + pad + 1) - top;

    const out = await sharp(data, { raw: { width, height, channels: 4 } })
      .extract({ left, top, width: cw, height: ch })
      .png()
      .toBuffer();
    if (cacheKey) {
      if (cleanedImageCache.size > 12) cleanedImageCache.clear();
      cleanedImageCache.set(cacheKey, out);
    }
    return out;
  } catch (e) {
    console.error('Не удалось подготовить изображение печати/подписи, используется исходное:', e.message);
    return buf;
  }
}

async function resolveCleanImage(imgVal) {
  const buf = await resolveImageBuffer(imgVal);
  if (!buf) return null;
  const key = /^https?:\/\//i.test(imgVal || '') ? imgVal : null;
  return trimStampLikeImage(buf, key);
}

const STATUS_LABEL = {
  VALID: { ru: 'ДЕЙСТВИТЕЛЬНО', kz: 'ЖАРАМДЫ', en: 'VALID', color: '#0f7a3c' },
  EXPIRED: { ru: 'СРОК ИСТЁК', kz: 'МЕРЗІМІ АЯҚТАЛДЫ', en: 'EXPIRED', color: '#b45309' },
  REVOKED: { ru: 'АННУЛИРОВАНО', kz: 'ЖОЙЫЛДЫ', en: 'REVOKED', color: '#b91c1c' }
};

// cert   — строка из certificates (+ join полей: last_name, first_name, user_position,
//          department, object, title_ru, title_kz, protocol_number), см. certificateService.js
// settings — строка из settings (логотип/печать/подписи/название компании)
// verifyUrl — полный публичный адрес страницы проверки (/verify/:uid) для QR-кода
// committeeSignatures — больше не используется (параметр оставлен для совместимости вызовов):
//          подпись берётся из «Настроек», подписи протокола на сертификат не попадают.
async function buildCertificatePdfBuffer(cert, settings, verifyUrl, committeeSignatures) {
  const s = settings || {};

  // На сертификате ОДНА подпись — председателя из «Настроек» (активный председатель 1 или 2).
  // Подписи комиссии из протокола сюда не попадают: в протоколе остаются три подписи
  // (председатель / инженер по БиОТ / член комиссии), а сертификат от них не зависит.
  const [logoBuf, stampBuf, sig1Buf, sig2Buf, qrBuf] = await Promise.all([
    resolveImageBuffer(s.logo_data || s.logo_path),
    resolveCleanImage(s.stamp_data || s.stamp_path),
    resolveCleanImage(s.chairman1_signature),
    resolveCleanImage(s.chairman2_signature),
    QRCode.toBuffer(verifyUrl, { type: 'png', margin: 1, width: 220, color: { dark: '#0f3b6c', light: '#ffffff' } })
      .catch((e) => { console.error('QR generation error:', e); return null; })
  ]);

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 30, bottom: 30, left: 35, right: 35 }
  });

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  if (fs.existsSync(FONT_REG)) doc.registerFont('DejaVu', FONT_REG);
  if (fs.existsSync(FONT_BOLD)) doc.registerFont('DejaVu-Bold', FONT_BOLD);
  const hasFonts = fs.existsSync(FONT_REG);

  const fRegular = (size = 11) => {
    if (hasFonts) doc.font('DejaVu').fontSize(size);
    else doc.fontSize(size);
  };
  const fBold = (size = 11) => {
    if (hasFonts && fs.existsSync(FONT_BOLD)) doc.font('DejaVu-Bold').fontSize(size);
    else doc.fontSize(size);
  };

  const PAGE_W = 842, PAGE_H = 595;

  doc.rect(20, 20, PAGE_W - 40, PAGE_H - 40).lineWidth(2).strokeColor('#0f3b6c').stroke();
  doc.rect(26, 26, PAGE_W - 52, PAGE_H - 52).lineWidth(0.8).strokeColor('#8aa8c8').stroke();

  if (logoBuf) {
    try { doc.image(logoBuf, 50, 38, { width: 88, height: 52, fit: [88, 52] }); }
    catch (e) { console.error('Ошибка вставки логотипа в PDF:', e); }
  }

  fBold(15);
  doc.fillColor('#0f3b6c');
  doc.text(s.company_name || 'ТОО «Компания»', 150, 46, { align: 'center', width: 542 });

  fBold(23);
  doc.fillColor('#1b365d');
  doc.text('УДОСТОВЕРЕНИЕ О ПРОВЕРКЕ ЗНАНИЙ', 0, 100, { align: 'center' });
  fRegular(9.5);
  doc.fillColor('#555555');
  doc.text('по вопросам безопасности и охраны труда / CERTIFICATE OF PASSING SAFETY TESTS', 0, 126, { align: 'center' });

  fBold(12);
  doc.fillColor('#333333');
  doc.text(`№ ${cert.certificate_number || '—'}`, 0, 146, { align: 'center' });

  fRegular(11);
  doc.fillColor('#444444');
  doc.text('Настоящим подтверждается, что / Осы арқылы расталады:', 0, 172, { align: 'center' });

  fBold(19);
  doc.fillColor('#000000');
  doc.text(`${cert.last_name || ''} ${cert.first_name || ''}`.trim(), 0, 196, { align: 'center' });

  fRegular(10.5);
  doc.fillColor('#555555');
  const empDetails = [cert.user_position, cert.department, cert.object].filter(Boolean).join(' • ');
  if (empDetails) doc.text(empDetails, 0, 223, { align: 'center' });

  fRegular(11);
  doc.fillColor('#444444');
  doc.text('успешно прошел(ла) проверку знаний по курсу / келесі курс бойынша білімін сәтті тексеруден өтті:', 0, 253, { align: 'center' });

  fBold(13.5);
  doc.fillColor('#0f3b6c');
  const courseTitle = cert.title_ru || cert.title_kz || 'Курс';
  doc.text(`«${courseTitle}»`, 60, 277, { align: 'center', width: PAGE_W - 120, height: 32, ellipsis: true });

  fRegular(9.5);
  doc.fillColor('#333333');
  const validUntilStr = cert.expiry_date ? fmtDate(cert.expiry_date) : 'бессрочно / мерзімсіз';
  const protStr = cert.protocol_number ? `Протокол № ${cert.protocol_number}` : '';
  doc.text(`Дата выдачи: ${fmtDate(cert.issue_date)}     Действителен до: ${validUntilStr}     ${protStr}`, 0, 318, { align: 'center' });

  // ===================== Блок подписи (одна подпись + печать) =====================
  // Размеры подобраны под реальную печать на А4: печать Ø42 мм, подпись до 55×22 мм,
  // печать слегка заходит на подпись — как на бумажном документе.
  {
    const isChair2Active = parseInt(s.active_chairman, 10) === 2;
    const activeChair = isChair2Active
      ? { role: s.chairman2_position || 'Председатель комиссии', name: s.chairman2_name || '—', position: '', sig: sig2Buf }
      : { role: s.chairman1_position || 'Председатель комиссии', name: s.chairman1_name || s.chairman_name || '—', position: '', sig: sig1Buf };

    const colW = 320;
    const colX = (PAGE_W - colW) / 2;
    const centerX = colX + colW / 2;

    const roleY = 372;
    const sigBoxTop = 394;
    const sigBoxBottom = sigBoxTop + SIG_MAX_H;
    const lineY = sigBoxBottom + 4;
    const nameY = lineY + 6;

    const m = activeChair;

    fBold(9.5);
    doc.fillColor('#000000');
    const roleHalfW = Math.min(doc.widthOfString(m.role) / 2, colW / 2);
    const roleH = Math.min(doc.heightOfString(m.role, { width: colW }), 24);
    doc.text(m.role, colX, roleY, { width: colW, align: 'center', height: 24, ellipsis: true });

    if (m.sig) {
      try {
        doc.image(m.sig, centerX - SIG_MAX_W / 2, sigBoxTop, { fit: [SIG_MAX_W, SIG_MAX_H], align: 'center', valign: 'bottom' });
      } catch (e) { console.error('Ошибка вставки подписи:', e); }
    }

    doc.moveTo(centerX - 95, lineY).lineTo(centerX + 95, lineY).strokeColor('#888888').lineWidth(0.8).stroke();

    fRegular(9.5);
    doc.fillColor('#000000');
    const nameHalfW = Math.min(doc.widthOfString(m.name) / 2, colW / 2);
    doc.text(m.name, colX, nameY, { width: colW, align: 'center', lineBreak: false });
    if (m.position) {
      fRegular(7.5);
      doc.fillColor('#666666');
      doc.text(m.position, colX, nameY + 13, { width: colW, align: 'center', lineBreak: false, ellipsis: true });
    }

    if (stampBuf) {
      try {
        const r = STAMP_D / 2;
        const stampCenterY = (sigBoxTop + lineY) / 2 + 2;
        const chordHalf = (lineOrY, lineHeight) => {
          const nearest = lineOrY < stampCenterY
            ? Math.min(stampCenterY, lineOrY + lineHeight)
            : Math.max(stampCenterY, lineOrY);
          const dy = Math.abs(nearest - stampCenterY);
          return dy >= r ? 0 : Math.sqrt(r * r - dy * dy);
        };
        const gap = 6;
        const offset = Math.max(
          roleHalfW + gap + chordHalf(roleY, roleH),
          nameHalfW + gap + chordHalf(nameY, 11),
          r * 0.6
        );
        const stampCenterX = centerX + offset - STAMP_SHIFT_LEFT;
        doc.save();
        doc.opacity(0.9);
        doc.image(stampBuf, stampCenterX - r, stampCenterY - r, { fit: [STAMP_D, STAMP_D], align: 'center', valign: 'center' });
        doc.restore();
      } catch (e) { console.error('Ошибка вставки печати:', e); }
    }
  }

  // ===================== QR-код и статус (правый верхний угол) =====================
  const qrSize = 62;
  const qrX = PAGE_W - 35 - qrSize - 8;
  const qrY = 38;
  if (qrBuf) {
    try { doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize }); }
    catch (e) { console.error('Ошибка вставки QR-кода:', e); }
  }
  fRegular(6.5);
  doc.fillColor('#555555');
  doc.text('Проверка подлинности\nVerify certificate', qrX - 15, qrY + qrSize + 3, { width: qrSize + 30, align: 'center' });

  const statusInfo = STATUS_LABEL[cert.status] || STATUS_LABEL.VALID;
  fBold(8);
  doc.fillColor(statusInfo.color);
  doc.text(`${statusInfo.ru} / ${statusInfo.kz} / ${statusInfo.en}`, qrX - 40, qrY - 14, { width: qrSize + 80, align: 'center' });

  fRegular(6.5);
  doc.fillColor('#888888');
  doc.text(cert.certificate_uid || '', qrX - 40, qrY + qrSize + 22, { width: qrSize + 80, align: 'center' });

  doc.end();
  return done;
}

module.exports = { buildCertificatePdfBuffer, STATUS_LABEL };
