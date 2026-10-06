// PDF УДОСТОВЕРЕНИЯ по виду обучения (не сертификата!). Бланк A4 альбомный по макету заказчика.
//
// Одно удостоверение = один вид обучения. Что откуда берётся:
//   • цвет рамки, боковой полосы, заголовков и плашки курса — courses.card_color;
//   • логотип, название компании (если нет логотипа), слоган — «Настройки» (settings);
//   • печать — «Настройки» (settings.stamp_data / stamp_path);
//   • председатель (ФИО и подпись) — из ПРОТОКОЛА, по которому сотрудник сдавал курс
//     (committeeSignatures = getCommitteeSignaturesForProtocol). Нет протокола — из «Настроек»;
//   • QR — общий на сотрудника: /p/<public_uid> (список всех его обучений). verifyUrl — эта ссылка.
//
// Вёрстка ведётся в «макетных пикселях» 1280×905 (как на образце) и пересчитывается в pt
// вручную (K), а не через doc.scale: при scale pdfkit сравнивает y с высотой страницы в
// НЕмасштабированных единицах и на нижних строках открывает лишнюю страницу.
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { formatTenureShort } = require('./lib/tenure');
const { resolveImageBuffer, resolveCleanImage } = require('./lib/imageAssets');
const { CARD_STAMP, cardPalette, fmtDate, todayKz, STATUS, resolveChairman, mix } = require('./lib/cardLayout');

const FONT_REG = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

const PX_W = 1280;
const PX_H = 905;
const INK = '#12233A';      // основной тёмный текст
const MUTED = '#5B6B80';    // подписи полей
const FAINT = '#7C8A9C';    // мелкий текст

// card — из getIdCardFullByUid() (idCardService.js); settings — settings(id=1);
// verifyUrl — общая ссылка сотрудника /p/<public_uid>; committeeSignatures — из протокола.
async function buildIdCardPdfBuffer(card, settings, verifyUrl, committeeSignatures) {
  const s = settings || {};
  const pal = cardPalette(card.card_color);
  // Внешний курс (courses.is_external): без протокола, подписи и печати — только данные обучения.
  const external = !!card.is_external;
  const chairman = external ? { name: '', signature_data: null } : resolveChairman(s, committeeSignatures); // бросает protocol_not_signed
  const st = STATUS[card.status] || STATUS.VALID;

  const [logoBuf, stampBuf, sigBuf, qrBuf] = await Promise.all([
    resolveImageBuffer(s.logo_data || s.logo_path),
    external ? null : resolveCleanImage(s.stamp_data || s.stamp_path),
    external ? null : resolveCleanImage(chairman.signature_data),
    verifyUrl ? QRCode.toBuffer(verifyUrl, { type: 'png', margin: 0, width: 360, errorCorrectionLevel: 'M', color: { dark: pal.dark, light: '#FFFFFF' } }).catch(() => null) : null
  ]);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Удостоверение № ${card.card_number || ''}` } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hasReg = fs.existsSync(FONT_REG);
      const hasBold = fs.existsSync(FONT_BOLD);
      if (hasReg) doc.registerFont('DejaVu', FONT_REG);
      if (hasBold) doc.registerFont('DejaVu-Bold', FONT_BOLD);

      const K = doc.page.width / PX_W;
      const X = (v) => v * K;

      const setFont = (bold, size) => {
        if (bold && hasBold) doc.font('DejaVu-Bold'); else if (hasReg) doc.font('DejaVu');
        doc.fontSize(size * K);
      };
      const wPx = (str, bold, size) => { setFont(bold, size); return doc.widthOfString(String(str)) / K; };

      // Однострочный текст. align: left | center | right относительно x (для center/right — x это
      // соответственно центр и правая граница). Если не влезает в maxW — кегль уменьшается до 60%.
      function text(str, x, y, { size = 14, bold = false, color = INK, align = 'left', maxW = null } = {}) {
        let sz = size;
        const value = String(str == null ? '' : str);
        if (maxW) { while (sz > size * 0.6 && wPx(value, bold, sz) > maxW) sz -= 0.5; }
        const w = wPx(value, bold, sz);
        const px = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
        setFont(bold, sz);
        doc.fillColor(color).text(value, X(px), X(y), { lineBreak: false });
      }
      const rrect = (x, y, w, h, r) => doc.roundedRect(X(x), X(y), X(w), X(h), X(r));
      const line = (x1, y1, x2, y2, color, wd = 1) => {
        doc.lineWidth(X(wd)).strokeColor(color).moveTo(X(x1), X(y1)).lineTo(X(x2), X(y2)).stroke();
      };

      // ---------- Фон, рамка, боковая полоса ----------
      doc.rect(0, 0, doc.page.width, doc.page.height).fill('#F8FBFE');
      rrect(12, 12, PX_W - 24, PX_H - 24, 20); doc.lineWidth(X(2.4)).strokeColor(pal.base).stroke();

      doc.rect(X(26), X(26), X(46), X(PX_H - 52)).fill(pal.soft);
      line(26, 26, 26, PX_H - 26, pal.mid, 1.5);
      line(72, 26, 72, PX_H - 26, pal.mid, 1.5);
      for (let i = 0; i < 17; i += 1) {
        const cy = 64 + i * 49.6;
        doc.polygon([X(49), X(cy - 16)], [X(60), X(cy)], [X(49), X(cy + 16)], [X(38), X(cy)]).fill(pal.mid);
        doc.circle(X(49), X(cy + 24.8), X(2.4)).fill(pal.base);
      }

      // ---------- Шапка: логотип (или название компании) и слоган ----------
      let logoDrawn = false;
      if (logoBuf) {
        try { doc.image(logoBuf, X(98), X(30), { fit: [X(300), X(112)], align: 'left', valign: 'center' }); logoDrawn = true; } catch (e) { console.error('Ошибка вставки логотипа:', e.message); }
      }
      if (!logoDrawn) text(s.company_name || '', 98, 62, { size: 26, bold: true, color: pal.dark, maxW: 520 });

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
      rrect(950, 330, 300, 80, 12); doc.fillColor(st.bg).fill();
      rrect(950, 330, 300, 80, 12); doc.lineWidth(X(1.6)).strokeColor(st.border).stroke();
      doc.circle(X(984), X(370), X(17)).fill(st.fg);
      doc.lineWidth(X(3)).strokeColor('#FFFFFF').lineCap('round').lineJoin('round');
      if (card.status === 'REVOKED') {
        doc.moveTo(X(977), X(363)).lineTo(X(991), X(377)).stroke();
        doc.moveTo(X(991), X(363)).lineTo(X(977), X(377)).stroke();
      } else if (card.status === 'EXPIRED') {
        doc.moveTo(X(984), X(361)).lineTo(X(984), X(373)).stroke();
        doc.circle(X(984), X(379), X(1.8)).fill('#FFFFFF');
      } else {
        doc.moveTo(X(975), X(371)).lineTo(X(982), X(378)).lineTo(X(994), X(363)).stroke();
      }
      text(st.kz, 1026, 339, { size: 19, bold: true, color: st.fg, maxW: 215 });
      text(st.ru, 1026, 362, { size: 15, bold: true, color: st.fg, maxW: 215 });
      text(st.en, 1026, 383, { size: 15, bold: true, color: st.fg, maxW: 215 });

      // ---------- Плашка курса (цвет вида обучения) ----------
      rrect(95, 436, 1155, 84, 12); doc.fillColor(pal.base).fill();
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
      rrect(95, 536, 1155, 44, 8); doc.fillColor(pal.soft).fill();
      heads.forEach(([ru, kz], i) => {
        const cx = (colX[i] + colX[i + 1]) / 2;
        text(ru, cx, 541, { size: 13.5, bold: true, color: pal.dark, align: 'center', maxW: 210 });
        text(kz, cx, 561, { size: 10, color: MUTED, align: 'center', maxW: 210 });
      });
      rrect(95, 536, 1155, 92, 8); doc.lineWidth(X(1.2)).strokeColor(pal.mid).stroke();
      const result = card.score_percent == null ? 'ПРОЙДЕН' : `ПРОЙДЕН · ${card.score_percent}%`;
      const cells = [
        fmtDate(card.test_date || card.issue_date),
        result,
        card.protocol_number ? String(card.protocol_number) : '—',
        card.expiry_date ? fmtDate(card.expiry_date) : 'бессрочно'
      ];
      cells.forEach((v, i) => text(v, (colX[i] + colX[i + 1]) / 2, 596, { size: 17, color: INK, align: 'center', maxW: 210 }));
      // статус-пилюля
      const pcx = (colX[4] + colX[5]) / 2;
      rrect(pcx - 92, 590, 184, 30, 15); doc.fillColor(st.bg).fill();
      rrect(pcx - 92, 590, 184, 30, 15); doc.lineWidth(X(1)).strokeColor(st.border).stroke();
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
      if (sigBuf) {
        try { doc.image(sigBuf, X(105), X(690), { fit: [X(210), X(72)], align: 'center', valign: 'bottom' }); } catch (e) { console.error('Ошибка вставки подписи:', e.message); }
      }
      line(95, 766, 415, 766, '#8A97A8', 1);
      text('Комиссия төрағасы / Председатель комиссии / Committee Chairman', 95, 772, { size: 11, color: MUTED, maxW: 350 });
      text(chairman.name || '—', 95, 791, { size: 15, bold: true, color: INK, maxW: 320 });
      text('Председатель комиссии', 95, 812, { size: 12, color: MUTED, maxW: 320 });
      if (stampBuf) {
        try {
          doc.save(); doc.opacity(0.92);
          doc.image(stampBuf, X(CARD_STAMP.x), X(CARD_STAMP.y), { fit: [X(CARD_STAMP.size), X(CARD_STAMP.size)], align: 'center', valign: 'center' });
          doc.restore();
        } catch (e) { console.error('Ошибка вставки печати:', e.message); }
      }
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
      rrect(1105, 692, 143, 143, 14); doc.fillColor('#FFFFFF').fill();
      rrect(1105, 692, 143, 143, 14); doc.lineWidth(X(1.2)).strokeColor(pal.mid).stroke();
      if (qrBuf) {
        try { doc.image(qrBuf, X(1117), X(704), { fit: [X(119), X(119)] }); } catch (e) { console.error('Ошибка вставки QR:', e.message); }
      }

      // ---------- Подвал ----------
      const foot = [
        'Настоящее удостоверение действительно только при наличии записи в электронном реестре. Актуальный статус и список всех обучений сотрудника — по QR-коду.',
        'Осы куәлік тек электрондық реестрде жазба болған жағдайда ғана жарамды. Өзекті мәртебе және қызметкердің барлық оқытулар тізімі — QR-код бойынша.',
        'This card is valid only if a record exists in the electronic register. Current status and the list of all trainings — scan the QR code.'
      ];
      foot.forEach((t, i) => text(t, 95, 848 + i * 13.5, { size: 10, color: FAINT, maxW: 1130 }));

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildIdCardPdfBuffer };
