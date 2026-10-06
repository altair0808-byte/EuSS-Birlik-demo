// Word-версия УДОСТОВЕРЕНИЯ по виду обучения (не сертификата!). Бланк A4 альбомный — тот же макет
// заказчика, что и в PDF (idCardPdf.js): рамка и боковая полоса с ромбами, шапка (логотип и слоган),
// заголовки, поля сотрудника, номер и статус, цветная плашка курса, таблица «дата / результат /
// протокол / срок / статус», подпись председателя, печать, пояснение про QR и сам общий QR.
//
// Как устроено. Макет в PDF ведётся в «макетных пикселях» 1280×905 — здесь те же координаты
// переводятся в EMU (1 px = 8353 EMU, страница = 297×210 мм). Каждый элемент — отдельный
// плавающий объект, привязанный к странице (фигуры и надписи DrawingML), поэтому в Word всё
// правится руками: надпись — двойным щелчком, картинку — заменой. Внутри документа один пустой
// абзац, поэтому бланк всегда занимает ровно один лист.
//
// Что откуда берётся (как в PDF):
//   • цвет рамки, полосы, заголовков и плашки — courses.card_color (lib/cardLayout.cardPalette);
//   • логотип (или название компании, если логотипа нет), слоган KZ/RU/EN — «Настройки»;
//   • печать — «Настройки»; председатель — из протокола (нет протокола — из «Настроек»);
//   • QR — общий на сотрудника (verifyUrl = /p/<public_uid>).
// Шрифт — Arial. Кегль длинных строк уменьшается до 60% так, чтобы строка влезла в свою зону;
// ширину считает lib/textWidthSans.js (метрики Liberation Sans = Arial).
//
// ВАЖНО: вёрстка PDF и Word должна меняться ВМЕСТЕ (idCardPdf.js <-> этот файл).
const JSZip = require('jszip');
const QRCode = require('qrcode');
const { formatTenureShort } = require('./lib/tenure');
const { resolveImageBuffer, resolveCleanImage } = require('./lib/imageAssets');
const { CARD_STAMP, cardPalette, fmtDate, todayKz, STATUS, resolveChairman, mix } = require('./lib/cardLayout');
const { measureSansPt } = require('./lib/textWidthSans');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* без sharp вставляем только PNG/JPEG как есть */ }

const PX_W = 1280;
const PX_H = 905;
const PAGE_W_PT = 841.89; // 297 мм
const K = PAGE_W_PT / PX_W;          // pt на «макетный пиксель» (то же K, что в PDF)
const EMU_PER_PX = 10692000 / PX_W;  // 297 мм = 10 692 000 EMU
const E = (v) => Math.round(v * EMU_PER_PX);

const INK = '12233A';
const MUTED = '5B6B80';
const FAINT = '7C8A9C';
const FONT = 'Arial';

const hex = (c) => String(c).replace('#', '').toUpperCase();
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Подготовка изображений ----------
function pngSize(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), ext: 'png' };
  return null;
}
function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), ext: 'jpeg' };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
// -> { buf, w, h, ext } | null. С sharp любой формат (в т.ч. webp/svg/gif) приводится к PNG.
async function prepareImage(buf, maxSide = 1400) {
  if (!buf || !buf.length) return null;
  try {
    if (sharp) {
      const out = await sharp(buf, { limitInputPixels: 50e6 }).rotate()
        .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
        .png().toBuffer({ resolveWithObject: true });
      return { buf: out.data, w: out.info.width, h: out.info.height, ext: 'png' };
    }
    const info = pngSize(buf) || jpegSize(buf);
    return info ? { buf, w: info.w, h: info.h, ext: info.ext } : null;
  } catch (e) {
    console.error('Word-удостоверение: не удалось подготовить изображение:', e.message);
    return null;
  }
}

// ---------- Сборка объектов страницы ----------
function createCanvas() {
  const shapes = [];
  const media = []; // { name, buf, ext }
  let idSeq = 1;
  let z = 251658240; // relativeHeight растёт — порядок объектов = порядок вызовов

  const anchorOpen = (x, y, w, h, name, behind) => {
    const id = idSeq++;
    z += 1024;
    return '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="' + z + '" behindDoc="' + (behind ? 1 : 0) + '" locked="0" layoutInCell="1" allowOverlap="1">'
      + '<wp:simplePos x="0" y="0"/>'
      + `<wp:positionH relativeFrom="page"><wp:posOffset>${E(x)}</wp:posOffset></wp:positionH>`
      + `<wp:positionV relativeFrom="page"><wp:posOffset>${E(y)}</wp:posOffset></wp:positionV>`
      + `<wp:extent cx="${Math.max(E(w), 1)}" cy="${Math.max(E(h), 1)}"/>`
      + '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>'
      + `<wp:docPr id="${id}" name="${esc(name)} ${id}"/><wp:cNvGraphicFramePr/>`;
  };

  // Фигуры и надписи (wps) — внутри mc:AlternateContent, как их пишет сам Word.
  const wrapWps = (x, y, w, h, inner, name, behind = false) => '<w:r><w:rPr><w:noProof/></w:rPr>'
    + '<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>'
    + anchorOpen(x, y, w, h, name, behind)
    + `<a:graphic>${inner}</a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r>`;

  const fillXml = (c) => (c ? `<a:solidFill><a:srgbClr val="${hex(c)}"/></a:solidFill>` : '<a:noFill/>');
  const lnXml = (c, wd, round = false) => (c
    ? `<a:ln w="${Math.max(E(wd || 1), 1)}"${round ? ' cap="rnd"' : ''}>${fillXml(c)}${round ? '<a:round/>' : ''}</a:ln>`
    : '<a:ln><a:noFill/></a:ln>');
  const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';

  // Фигура без текста. prst: rect | roundRect | ellipse | diamond | line
  function shape(x, y, w, h, { prst = 'rect', radius = 0, fill = null, stroke = null, strokeW = 1, name = 'Фигура', behind = false } = {}) {
    const av = prst === 'roundRect' && radius
      ? `<a:avLst><a:gd name="adj" fmla="val ${Math.min(50000, Math.round((radius / Math.min(w, h)) * 100000))}"/></a:avLst>`
      : '<a:avLst/>';
    const inner = `<a:graphicData uri="${WPS}"><wps:wsp><wps:cNvSpPr/>`
      + `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.max(E(w), 1)}" cy="${Math.max(E(h), 1)}"/></a:xfrm>`
      + `<a:prstGeom prst="${prst}">${av}</a:prstGeom>${fillXml(fill)}${lnXml(stroke, strokeW)}</wps:spPr>`
      + '<wps:bodyPr/></wps:wsp></a:graphicData>';
    shapes.push(wrapWps(x, y, w, h, inner, name, behind));
  }

  function line(x1, y1, x2, y2, color, wd = 1) {
    shape(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1), { prst: 'line', stroke: color, strokeW: wd, name: 'Линия' });
  }

  // Ломаная (галочка, крестик, «!»): произвольная геометрия с круглыми концами.
  function polyline(points, color, wd) {
    const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
    const bx = Math.min(...xs); const by = Math.min(...ys);
    const bw = Math.max(Math.max(...xs) - bx, 0.01); const bh = Math.max(Math.max(...ys) - by, 0.01);
    const pt = (p) => `<a:pt x="${Math.round((p[0] - bx) * 100)}" y="${Math.round((p[1] - by) * 100)}"/>`;
    const path = `<a:path w="${Math.max(Math.round(bw * 100), 1)}" h="${Math.max(Math.round(bh * 100), 1)}" fill="none">`
      + `<a:moveTo>${pt(points[0])}</a:moveTo>${points.slice(1).map((p) => `<a:lnTo>${pt(p)}</a:lnTo>`).join('')}</a:path>`;
    const inner = `<a:graphicData uri="${WPS}"><wps:wsp><wps:cNvSpPr/>`
      + `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.max(E(bw), 1)}" cy="${Math.max(E(bh), 1)}"/></a:xfrm>`
      + `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>${path}</a:pathLst></a:custGeom>`
      + `<a:noFill/>${lnXml(color, wd, true)}</wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData>`;
    shapes.push(wrapWps(bx, by, bw, bh, inner, 'Значок'));
  }

  // Однострочная надпись. align: left | center | right относительно x (для center — x это центр,
  // для right — правая граница). Не влезает в maxW — кегль уменьшается до 60%.
  function text(str, x, y, { size = 14, bold = false, color = INK, align = 'left', maxW = null } = {}) {
    let value = String(str == null ? '' : str);
    if (!value) return;
    // Word хранит кегль в половинах пункта — меряем по тому размеру, который реально получится.
    const wPxOf = (v, s) => measureSansPt(v, Math.max(2, Math.round(s * K * 2)) / 2, bold) / K;
    let sz = size;
    if (maxW) {
      while (sz > size * 0.6 && wPxOf(value, sz) > maxW) sz -= 0.5;
      // Даже на 60% не влезает (очень длинное название) — обрезаем с «…». В PDF такая строка
      // просто выходит за зону, а в Word она перенеслась бы на вторую строку и наехала на соседние.
      if (wPxOf(value, sz) > maxW) {
        const chars = Array.from(value);
        while (chars.length > 1 && wPxOf(`${chars.join('').trimEnd()}…`, sz) > maxW) chars.pop();
        value = `${chars.join('').trimEnd()}…`;
      }
    }
    const wPx = (s) => wPxOf(value, s);
    const w = wPx(sz);
    const boxW = Math.max(maxW || 0, w) + 10; // небольшой запас, чтобы Word не перенёс строку
    const boxX = align === 'center' ? x - boxW / 2 : align === 'right' ? x - boxW : x;
    const boxH = sz * 1.5;
    const half = Math.max(2, Math.round(sz * K * 2)); // w:sz — в половинах пункта
    const jc = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
    const rpr = `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/>`
      + `${bold ? '<w:b/><w:bCs/>' : ''}<w:noProof/><w:color w:val="${hex(color)}"/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`;
    const inner = `<a:graphicData uri="${WPS}"><wps:wsp><wps:cNvSpPr txBox="1"/>`
      + `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${E(boxW)}" cy="${E(boxH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>`
      + '<wps:txbx><w:txbxContent><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>'
      + `<w:jc w:val="${jc}"/><w:rPr>${rpr}</w:rPr></w:pPr><w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:txbxContent></wps:txbx>`
      + '<wps:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData>';
    shapes.push(wrapWps(boxX, y, boxW, boxH, inner, 'Текст'));
  }

  // Картинка вписывается в рамку (bx,by,bw,bh) с сохранением пропорций.
  function image(img, bx, by, bw, bh, { align = 'center', valign = 'center', alpha = null, name = 'Изображение' } = {}) {
    if (!img) return;
    const k = Math.min(bw / img.w, bh / img.h);
    const w = img.w * k; const h = img.h * k;
    const x = align === 'left' ? bx : align === 'right' ? bx + bw - w : bx + (bw - w) / 2;
    const y = valign === 'top' ? by : valign === 'bottom' ? by + bh - h : by + (bh - h) / 2;
    const idx = media.length + 1;
    media.push({ name: `image${idx}.${img.ext}`, buf: img.buf, ext: img.ext });
    const blip = `<a:blip r:embed="rIdImg${idx}">${alpha != null ? `<a:alphaModFix amt="${Math.round(alpha * 100000)}"/>` : ''}</a:blip>`;
    const inner = '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
      + `<pic:nvPicPr><pic:cNvPr id="${1000 + idx}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${E(w)}" cy="${E(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + '</pic:pic></a:graphicData>';
    shapes.push('<w:r><w:rPr><w:noProof/></w:rPr><w:drawing>'
      + anchorOpen(x, y, w, h, name, false)
      + `<a:graphic>${inner}</a:graphic></wp:anchor></w:drawing></w:r>`);
  }

  return { shape, line, polyline, text, image, shapes, media };
}

// card — из getIdCardFullByUid() (idCardService.js); settings — settings(id=1);
// verifyUrl — общая ссылка сотрудника /p/<public_uid>; committeeSignatures — из протокола.
// Возвращает { buffer, fileName }. Как и PDF, бросает ошибку code = 'protocol_not_signed',
// если по протоколу председатель ещё не подписал.
async function buildIdCardDocx(card, settings, verifyUrl, committeeSignatures) {
  const s = settings || {};
  const pal = cardPalette(card.card_color);
  // Внешний курс (courses.is_external): без протокола, подписи и печати — только данные обучения.
  const external = !!card.is_external;
  const chairman = external ? { name: '', signature_data: null } : resolveChairman(s, committeeSignatures);
  const st = STATUS[card.status] || STATUS.VALID;
  const c = createCanvas();
  const { shape, line, polyline, text } = c;

  const [logoRaw, stampRaw, sigRaw, qrRaw] = await Promise.all([
    resolveImageBuffer(s.logo_data || s.logo_path),
    external ? null : resolveCleanImage(s.stamp_data || s.stamp_path),
    external ? null : resolveCleanImage(chairman.signature_data),
    verifyUrl
      ? QRCode.toBuffer(verifyUrl, { type: 'png', margin: 0, width: 360, errorCorrectionLevel: 'M', color: { dark: pal.dark, light: '#FFFFFF' } }).catch(() => null)
      : null
  ]);
  const [logo, stamp, sig, qr] = await Promise.all([
    prepareImage(logoRaw, 1200), prepareImage(stampRaw, 700), prepareImage(sigRaw, 900), prepareImage(qrRaw, 360)
  ]);

  // ---------- Фон, рамка, боковая полоса ----------
  shape(0, 0, PX_W, PX_H, { fill: 'F8FBFE', behind: true, name: 'Фон' });
  shape(12, 12, PX_W - 24, PX_H - 24, { prst: 'roundRect', radius: 20, stroke: pal.base, strokeW: 2.4, name: 'Рамка' });
  shape(26, 26, 46, PX_H - 52, { fill: pal.soft, name: 'Боковая полоса' });
  line(26, 26, 26, PX_H - 26, pal.mid, 1.5);
  line(72, 26, 72, PX_H - 26, pal.mid, 1.5);
  for (let i = 0; i < 17; i += 1) {
    const cy = 64 + i * 49.6;
    shape(38, cy - 16, 22, 32, { prst: 'diamond', fill: pal.mid, name: 'Ромб' });
    shape(49 - 2.4, cy + 24.8 - 2.4, 4.8, 4.8, { prst: 'ellipse', fill: pal.base, name: 'Точка' });
  }

  // ---------- Шапка: логотип (или название компании) и слоган ----------
  if (logo) c.image(logo, 98, 30, 300, 112, { align: 'left', valign: 'center', name: 'Логотип' });
  else text(s.company_name || '', 98, 62, { size: 26, bold: true, color: pal.dark, maxW: 520 });

  const taglines = [s.tagline_kz, s.tagline_ru, s.tagline_en];
  const defaults = ['ҚАУІПСІЗ ЖҰМЫС — ЖАРҚЫН БОЛАШАҚ', 'БЕЗОПАСНЫЙ ТРУД – УСТОЙЧИВОЕ РАЗВИТИЕ', 'SAFE WORK – SUSTAINABLE FUTURE'];
  taglines.forEach((t, i) => text(t == null ? defaults[i] : t, 1250, 36 + i * 20, { size: 14.5, color: pal.dark, align: 'right', maxW: 420 }));

  // ---------- Заголовки ----------
  const CX = 670;
  text('ҚАУІПСІЗДІК ЖӘНЕ ЕҢБЕКТІ ҚОРҒАУ САЛАСЫ БОЙЫНША', CX, 118, { size: 16, bold: true, color: pal.dark, align: 'center', maxW: 1100 });
  text('БІЛІМДІ ТЕКСЕРУ КУӘЛІГІ', CX, 140, { size: 40, bold: true, color: pal.dark, align: 'center', maxW: 1100 });
  text('УДОСТОВЕРЕНИЕ О ПРОВЕРКЕ ЗНАНИЙ', CX, 184, { size: 27, bold: true, color: pal.dark, align: 'center', maxW: 1100 });
  text('ПО ВОПРОСАМ БЕЗОПАСНОСТИ И ОХРАНЫ ТРУДА', CX, 216, { size: 17, color: pal.dark, align: 'center', maxW: 1100 });
  text('CERTIFICATE OF PASSING SAFETY TESTS', CX, 240, { size: 15, bold: true, color: pal.dark, align: 'center', maxW: 1100 });

  // ---------- Поля сотрудника ----------
  const fullName = `${card.last_name || ''} ${card.first_name || ''}`.trim() || '—';
  const fields = [
    ['Аты-жөні / ФИО / Name:', fullName],
    ['Атқаратын қызметі / Должность / Job Title:', card.user_position || '—'],
    ['Жұмыс орны / Подразделение / Department:', card.department || card.object || '—'],
    ['Жұмыс беруші / Работодатель / Employer:', s.company_name || '—']
  ];
  fields.forEach(([label, value], i) => {
    const y = 284 + i * 34;
    text(label, 95, y + 3, { size: 12.5, color: MUTED, maxW: 350 });
    text(value, 455, y - 2, { size: 20, bold: true, color: INK, maxW: 465 });
    line(95, y + 27, 920, y + 27, pal.line, 1);
  });

  // ---------- Номер и статус ----------
  text('Тұрақты нөмір / Постоянный номер / Permanent No.', 1098, 277, { size: 11, color: MUTED, align: 'center', maxW: 290 });
  text(`№ ${card.card_number || '—'}`, 1100, 296, { size: 27, bold: true, color: pal.dark, align: 'center', maxW: 290 });
  shape(950, 330, 300, 80, { prst: 'roundRect', radius: 12, fill: st.bg, stroke: st.border, strokeW: 1.6, name: 'Плашка статуса' });
  shape(984 - 17, 370 - 17, 34, 34, { prst: 'ellipse', fill: st.fg, name: 'Значок статуса' });
  if (card.status === 'REVOKED') {
    polyline([[977, 363], [991, 377]], '#FFFFFF', 3);
    polyline([[991, 363], [977, 377]], '#FFFFFF', 3);
  } else if (card.status === 'EXPIRED') {
    polyline([[984, 361], [984, 373]], '#FFFFFF', 3);
    shape(984 - 1.8, 379 - 1.8, 3.6, 3.6, { prst: 'ellipse', fill: '#FFFFFF', name: 'Точка' });
  } else {
    polyline([[975, 371], [982, 378], [994, 363]], '#FFFFFF', 3);
  }
  text(st.kz, 1026, 339, { size: 19, bold: true, color: st.fg, maxW: 215 });
  text(st.ru, 1026, 362, { size: 15, bold: true, color: st.fg, maxW: 215 });
  text(st.en, 1026, 383, { size: 15, bold: true, color: st.fg, maxW: 215 });

  // ---------- Плашка курса (цвет вида обучения) ----------
  shape(95, 436, 1155, 84, { prst: 'roundRect', radius: 12, fill: pal.base, name: 'Плашка курса' });
  const titleRu = card.title_ru || card.title_kz || 'Курс';
  text(titleRu, 672, 452, { size: 28, bold: true, color: '#FFFFFF', align: 'center', maxW: 1080 });
  if (card.title_kz && card.title_kz !== titleRu) {
    text(card.title_kz, 672, 490, { size: 15, color: mix(pal.base, '#FFFFFF', 0.85), align: 'center', maxW: 1080 });
  }

  // ---------- Таблица: дата, результат, протокол, срок, статус ----------
  const colX = [95, 326, 557, 788, 1019, 1250];
  const heads = [
    ['Дата проверки', 'Тексеру күні / Test date'],
    ['Результат', 'Нәтиже / Result'],
    ['№ протокола', 'Хаттама № / Protocol'],
    ['Действителен до', 'Жарамды / Valid until'],
    ['Статус', 'Мәртебе / Status']
  ];
  shape(95, 536, 1155, 92, { prst: 'roundRect', radius: 8, fill: '#FFFFFF', stroke: pal.mid, strokeW: 1.2, name: 'Таблица' });
  shape(95, 536, 1155, 44, { prst: 'roundRect', radius: 8, fill: pal.soft, name: 'Шапка таблицы' });
  heads.forEach(([ru, kz], i) => {
    const cx = (colX[i] + colX[i + 1]) / 2;
    text(ru, cx, 541, { size: 13.5, bold: true, color: pal.dark, align: 'center', maxW: 210 });
    text(kz, cx, 561, { size: 10, color: MUTED, align: 'center', maxW: 210 });
  });
  const result = card.score_percent == null ? 'ПРОЙДЕН' : `ПРОЙДЕН · ${card.score_percent}%`;
  const cells = [
    fmtDate(card.test_date || card.issue_date),
    result,
    card.protocol_number ? String(card.protocol_number) : '—',
    card.expiry_date ? fmtDate(card.expiry_date) : 'бессрочно'
  ];
  cells.forEach((v, i) => text(v, (colX[i] + colX[i + 1]) / 2, 596, { size: 17, color: INK, align: 'center', maxW: 210 }));
  const pcx = (colX[4] + colX[5]) / 2;
  shape(pcx - 92, 590, 184, 30, { prst: 'roundRect', radius: 15, fill: st.bg, stroke: st.border, strokeW: 1, name: 'Статус' });
  text(st.pill, pcx, 597, { size: 13, bold: true, color: st.fg, align: 'center', maxW: 170 });

  // ---------- Подпись председателя и печать ----------
  if (external) {
    // ВНЕШНИЙ курс: обучение проходило не у нас — ни подписи председателя, ни печати организации нет.
    text('Обучение пройдено во внешней организации', 95, 704, { size: 14, bold: true, color: pal.dark, maxW: 480 });
    text('Оқыту сыртқы ұйымда өтті', 95, 726, { size: 12, color: MUTED, maxW: 480 });
    text('Training completed at an external organization', 95, 746, { size: 12, color: MUTED, maxW: 480 });
    text('Внесено для учёта. № протокола — внешний, в нашем реестре протоколов не ведётся.', 95, 776, { size: 11, color: FAINT, maxW: 500 });
    text('Подпись и печать организации не проставляются.', 95, 793, { size: 11, color: FAINT, maxW: 500 });
  } else {
  c.image(sig, 105, 690, 210, 72, { align: 'center', valign: 'bottom', name: 'Подпись председателя' });
  line(95, 766, 415, 766, '#8A97A8', 1);
  text('Комиссия төрағасы / Председатель комиссии / Committee Chairman', 95, 772, { size: 11, color: MUTED, maxW: 350 });
  text(chairman.name || '—', 95, 791, { size: 15, bold: true, color: INK, maxW: 320 });
  text('Председатель комиссии', 95, 812, { size: 12, color: MUTED, maxW: 320 });
  c.image(stamp, CARD_STAMP.x, CARD_STAMP.y, CARD_STAMP.size, CARD_STAMP.size, { align: 'center', valign: 'center', alpha: 0.92, name: 'Печать' });
  }

  // ---------- Середина: пояснение про QR ----------
  text('Актуальный статус — по QR-коду', 608, 717, { size: 11.5, bold: true, color: pal.dark, maxW: 215 });
  text('Өзекті мәртебе — QR-код бойынша', 608, 738, { size: 11.5, color: MUTED, maxW: 215 });
  text('Current status — scan the QR code', 608, 757, { size: 11.5, color: MUTED, maxW: 215 });
  text('Сформировано / Generated:', 608, 787, { size: 11.5, color: MUTED, maxW: 215 });
  text(todayKz(), 608, 805, { size: 11.5, bold: true, color: MUTED, maxW: 215 });
  // Стаж работы в компании (если в карточке сотрудника указана дата начала работы)
  if (card.employee_hire_date) {
    text('Стаж / Өтілі: ' + formatTenureShort(card.employee_hire_date), 608, 823, { size: 11, bold: true, color: pal.dark, maxW: 215 });
  }

  // ---------- Справа: QR ----------
  text('Құжаттың түпнұсқалығын тексеру', 1089, 711, { size: 12, color: MUTED, align: 'right', maxW: 262 });
  text('Проверка подлинности удостоверения', 1089, 732, { size: 12, bold: true, color: pal.dark, align: 'right', maxW: 262 });
  text('Verify certificate', 1089, 752, { size: 12, color: MUTED, align: 'right', maxW: 262 });
  if (verifyUrl) text(verifyUrl, 1089, 781, { size: 11, color: pal.dark, align: 'right', maxW: 262 });
  shape(1105, 692, 143, 143, { prst: 'roundRect', radius: 14, fill: '#FFFFFF', stroke: pal.mid, strokeW: 1.2, name: 'Рамка QR' });
  c.image(qr, 1117, 704, 119, 119, { name: 'QR-код' });

  // ---------- Подвал ----------
  const foot = [
    'Настоящее удостоверение действительно только при наличии записи в электронном реестре. Актуальный статус и список всех обучений сотрудника — по QR-коду.',
    'Осы куәлік тек электрондық реестрде жазба болған жағдайда ғана жарамды. Өзекті мәртебе және қызметкердің барлық оқытулар тізімі — QR-код бойынша.',
    'This card is valid only if a record exists in the electronic register. Current status and the list of all trainings — scan the QR code.'
  ];
  foot.forEach((t, i) => text(t, 95, 848 + i * 13.5, { size: 10, color: FAINT, maxW: 1130 }));

  // ---------- Пакет .docx ----------
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
    + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
    + ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
    + ' xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:document ${NS}><w:body>`
    + '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>'
    + c.shapes.join('')
    + '</w:p>'
    + '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
    + '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>';

  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults>'
    + `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="ru-RU" w:eastAsia="ru-RU" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults></w:styles>';

  const exts = [...new Set(c.media.map((m) => m.ext))];
  const zip = new JSZip();
  // без записей-папок (_rels/, word/…): часть версий Word строго относится к таким пакетам
  const put = (name, data) => zip.file(name, data, { createFolders: false });
  put('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + exts.map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>');
  put('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  put('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + c.media.map((m, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')
    + '</Relationships>');
  put('word/styles.xml', stylesXml);
  put('word/document.xml', documentXml);
  c.media.forEach((m) => put(`word/media/${m.name}`, m.buf));

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const fileName = `Удостоверение_${card.card_number || card.card_uid}.docx`;
  return { buffer, fileName };
}

module.exports = { buildIdCardDocx };
