// PDF «График вахты на год»: логотип компании, ФИ сотрудника, 12 месяцев в виде календаря.
// Дни на вахте закрашены зелёной лентой, заезд и отъезд выделены кружками, второй лист — таблица смен.
// Расписание строится повтором цикла: вахта (заезд … отъезд включительно) → дома N дней → снова вахта.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { resolveImageBuffer } = require('./lib/imageAssets');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* без sharp логотип вставляется как есть */ }

const FONT_REG = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

const C = {
  navy: '#0f3b6c', navyDark: '#1b365d', ink: '#1e293b', muted: '#64748b', faint: '#94a3b8',
  line: '#e2e8f0', card: '#f8fafc', band: '#059669', arrival: '#0f3b6c', departure: '#ea580c', weekend: '#dc2626'
};

const TXT = {
  ru: {
    title: 'График вахты', period: 'Период', pattern: 'Вахта', home: 'дома', days: 'дн.',
    months: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
    wd: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    onShift: 'На вахте', atHome: 'Дома', arrive: 'Заезд', depart: 'Отъезд',
    made: 'Сформировано', tableTitle: 'Даты заездов и отъездов', n: '№', onDays: 'Дней на вахте', homeDays: 'Дома после вахты'
  },
  kz: {
    title: 'Вахта кестесі', period: 'Кезең', pattern: 'Вахта', home: 'үйде', days: 'күн',
    months: ['Қаңтар', 'Ақпан', 'Наурыз', 'Сәуір', 'Мамыр', 'Маусым', 'Шілде', 'Тамыз', 'Қыркүйек', 'Қазан', 'Қараша', 'Желтоқсан'],
    wd: ['Дс', 'Сс', 'Ср', 'Бс', 'Жм', 'Сб', 'Жс'],
    onShift: 'Вахтада', atHome: 'Үйде', arrive: 'Келу', depart: 'Кету',
    made: 'Жасалған күні', tableTitle: 'Келу және кету күндері', n: '№', onDays: 'Вахтадағы күн', homeDays: 'Вахтадан кейін үйде'
  }
};

const DAY = 86400000;
const toMs = (iso) => Date.parse(iso + 'T00:00:00Z');
const fmt = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Вахтовые смены в окне [fromIso, toIso]: [{ arrival, departure, days }] (каждая смена — полностью, даже если
// частично выходит за окно). Цикл = (отъезд - заезд + 1) дней вахты + restDays дней дома, повтор в обе стороны.
function buildShifts({ arrival, departure, restDays, fromIso, toIso }) {
  const a0 = toMs(arrival);
  const len = Math.round((toMs(departure) - a0) / DAY) + 1;
  const cycle = len + restDays;
  const from = toMs(fromIso), to = toMs(toIso);
  // первая смена, которая заканчивается не раньше начала окна
  let k = Math.floor((from - a0) / (cycle * DAY));
  const shifts = [];
  for (;; k++) {
    const s = a0 + k * cycle * DAY;
    const e = s + (len - 1) * DAY;
    if (e < from) continue;
    if (s > to) break;
    shifts.push({ arrival: isoOf(s), departure: isoOf(e), days: len });
  }
  return { shifts, len, cycle };
}

async function logoBuffer(settings) {
  const raw = await resolveImageBuffer(settings.logo_data || settings.logo_path);
  if (!raw) return null;
  if (sharp) {
    try { return await sharp(raw, { limitInputPixels: 50e6 }).png().toBuffer(); } catch (e) { /* пробуем как есть */ }
  }
  return raw;
}

// emp: { last_name, first_name }; rot: { arrival, departure, days }; opts: { restDays, startIso (1-е число месяца), todayIso, lang }
async function buildRotationCalendarPdf(emp, rot, settings, opts) {
  const s = settings || {};
  const T = TXT[opts.lang === 'kz' ? 'kz' : 'ru'];
  const restDays = opts.restDays;
  const start = new Date(toMs(opts.startIso));
  const y0 = start.getUTCFullYear(), m0 = start.getUTCMonth();
  const endMs = Date.UTC(y0, m0 + 12, 0); // последний день 12-го месяца
  const fromIso = isoOf(Date.UTC(y0, m0, 1)), toIso = isoOf(endMs);
  const { shifts, len, cycle } = buildShifts({ arrival: rot.arrival, departure: rot.departure, restDays, fromIso, toIso });

  // для быстрой проверки дня: iso → 'a' (заезд) | 'd' (отъезд) | 'ad' (оба) | 'on'
  const mark = new Map();
  shifts.forEach((sh) => {
    for (let t = toMs(sh.arrival); t <= toMs(sh.departure); t += DAY) mark.set(isoOf(t), 'on');
    mark.set(sh.arrival, 'a');
    mark.set(sh.departure, mark.get(sh.departure) === 'a' ? 'ad' : 'd');
  });

  const logoBuf = await logoBuffer(s);

  return new Promise((resolve, reject) => {
    try {
      const fullName = `${emp.last_name || ''} ${emp.first_name || ''}`.trim();
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `${T.title} — ${fullName}` } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hasReg = fs.existsSync(FONT_REG), hasBold = fs.existsSync(FONT_BOLD);
      if (hasReg) doc.registerFont('DejaVu', FONT_REG);
      if (hasBold) doc.registerFont('DejaVu-Bold', FONT_BOLD);
      const reg = (sz) => { if (hasReg) doc.font('DejaVu'); doc.fontSize(sz); };
      const bold = (sz) => { if (hasBold) doc.font('DejaVu-Bold'); else if (hasReg) doc.font('DejaVu'); doc.fontSize(sz); };

      const PW = 841.89, PH = 595.28, MX = 28;

      // ---------- Шапка ----------
      const HEAD_H = 78;
      doc.rect(0, 0, PW, HEAD_H).fill(C.navy);
      doc.rect(0, HEAD_H, PW, 3).fill(C.band);
      let textX = MX;
      if (logoBuf) {
        // белая «плашка» под логотип — читается на любом фоне
        doc.roundedRect(MX, 12, 110, 54, 8).fill('#ffffff');
        try { doc.image(logoBuf, MX + 6, 16, { fit: [98, 46], align: 'center', valign: 'center' }); textX = MX + 126; }
        catch (e) { console.error('Ошибка вставки логотипа в календарь вахты:', e.message); textX = MX; }
      }
      bold(11); doc.fillColor('#bfdbfe').text((s.company_name || '').toUpperCase(), textX, 14, { width: PW - textX - 250, lineBreak: false, ellipsis: true });
      bold(21); doc.fillColor('#ffffff').text(fullName, textX, 30, { width: PW - textX - 250, lineBreak: false, ellipsis: true });
      reg(10.5); doc.fillColor('#dbeafe').text(`${T.title} · ${fmt(fromIso)} — ${fmt(toIso)}`, textX, 58, { width: PW - textX - 250, lineBreak: false });
      // справа — формула цикла
      const rx = PW - MX - 220;
      doc.roundedRect(rx, 14, 220, 50, 10).fillOpacity(0.14).fill('#ffffff').fillOpacity(1);
      bold(10); doc.fillColor('#bfdbfe').text(T.pattern.toUpperCase(), rx + 14, 21, { width: 192, lineBreak: false });
      bold(20); doc.fillColor('#ffffff').text(`${len} / ${restDays}`, rx + 14, 34, { width: 100, lineBreak: false });
      reg(9.5); doc.fillColor('#dbeafe').text(`${len} ${T.days} ${T.pattern.toLowerCase()} · ${restDays} ${T.days} ${T.home}`, rx + 84, 40, { width: 128, lineBreak: false });

      // ---------- Сетка 4×3 месяцев ----------
      const GX = MX, GY = HEAD_H + 16, GAP = 12;
      const COLS = 4, ROWS = 3;
      const CW = (PW - 2 * MX - GAP * (COLS - 1)) / COLS;
      const FOOT_H = 34;
      const CH = (PH - GY - FOOT_H - GAP * (ROWS - 1)) / ROWS;
      const TITLE_H = 20, WD_H = 13;
      const cellW = (CW - 16) / 7;
      const cellH = (CH - TITLE_H - WD_H - 10) / 6;

      for (let i = 0; i < 12; i++) {
        const mIdx = (m0 + i) % 12, yr = y0 + Math.floor((m0 + i) / 12);
        const col = i % COLS, row = Math.floor(i / COLS);
        const x = GX + col * (CW + GAP), y = GY + row * (CH + GAP);
        doc.roundedRect(x, y, CW, CH, 8).fill(C.card);
        doc.roundedRect(x, y, CW, CH, 8).lineWidth(0.6).stroke(C.line);

        bold(11); doc.fillColor(C.navyDark).text(`${T.months[mIdx]} ${yr}`, x + 8, y + 6, { width: CW - 16, lineBreak: false });
        reg(7); doc.fillColor(C.faint);
        T.wd.forEach((w, k) => {
          doc.fillColor(k >= 5 ? '#f87171' : C.faint).text(w, x + 8 + k * cellW, y + TITLE_H + 4, { width: cellW, align: 'center', lineBreak: false });
        });

        const first = new Date(Date.UTC(yr, mIdx, 1));
        const offset = (first.getUTCDay() + 6) % 7; // понедельник = 0
        const dim = new Date(Date.UTC(yr, mIdx + 1, 0)).getUTCDate();
        const gridY = y + TITLE_H + WD_H + 4;
        const cx = (d) => x + 8 + ((offset + d - 1) % 7) * cellW;
        const cy = (d) => gridY + Math.floor((offset + d - 1) / 7) * cellH;
        const iso = (d) => `${yr}-${String(mIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

        // 1) ленты вахты: непрерывные отрезки внутри одной недели
        let d = 1;
        while (d <= dim) {
          if (!mark.has(iso(d))) { d++; continue; }
          let e = d;
          while (e + 1 <= dim && mark.has(iso(e + 1)) && (offset + e) % 7 !== 0) e++;
          const bx = cx(d) + 1, bw = (cx(e) + cellW - 1) - bx, bh = cellH - 3, by = cy(d) + 1.5;
          doc.roundedRect(bx, by, bw, bh, Math.min(bh / 2, 7)).fill(C.band);
          d = e + 1;
        }
        // 2) кружки заезда / отъезда
        for (let k = 1; k <= dim; k++) {
          const m = mark.get(iso(k));
          if (m !== 'a' && m !== 'd' && m !== 'ad') continue;
          const r = Math.min(cellW, cellH) / 2 - 1;
          const ccx = cx(k) + cellW / 2, ccy = cy(k) + cellH / 2;
          doc.circle(ccx, ccy, r).fill(m === 'd' ? C.departure : C.arrival);
          if (m === 'ad') doc.circle(ccx, ccy, r).lineWidth(1.4).stroke(C.departure);
        }
        // 3) числа
        bold(7.5);
        for (let k = 1; k <= dim; k++) {
          const wk = (offset + k - 1) % 7;
          const m = mark.get(iso(k));
          doc.fillColor(m ? '#ffffff' : (wk >= 5 ? C.weekend : C.ink));
          if (!m) reg(7.5); else bold(7.5);
          doc.text(String(k), cx(k), cy(k) + (cellH - 7.5) / 2 + 0.5, { width: cellW, align: 'center', lineBreak: false });
        }
      }

      // ---------- Легенда ----------
      const ly = PH - FOOT_H + 10;
      let lx = MX;
      const legend = (fill, label, shape) => {
        if (shape === 'band') doc.roundedRect(lx, ly, 22, 10, 5).fill(fill);
        else doc.circle(lx + 5, ly + 5, 5).fill(fill);
        reg(8.5); doc.fillColor(C.muted).text(label, lx + (shape === 'band' ? 28 : 15), ly + 1, { lineBreak: false });
        lx += (shape === 'band' ? 28 : 15) + doc.widthOfString(label) + 18;
      };
      legend(C.band, T.onShift, 'band');
      legend(C.arrival, T.arrive, 'dot');
      legend(C.departure, T.depart, 'dot');
      reg(8.5); doc.fillColor(C.muted).text(`${T.atHome} — ${CURRENT_NOTE(T)}`, lx, ly + 1, { lineBreak: false });
      reg(8); doc.fillColor(C.faint).text(`${T.made}: ${fmt(opts.todayIso)}`, PW - MX - 200, ly + 1, { width: 200, align: 'right', lineBreak: false });

      // ---------- Страница 2: таблица смен ----------
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
      doc.rect(0, 0, PW, 54).fill(C.navy);
      doc.rect(0, 54, PW, 3).fill(C.band);
      bold(16); doc.fillColor('#ffffff').text(`${T.tableTitle} — ${fullName}`, MX, 18, { width: PW - 2 * MX, lineBreak: false, ellipsis: true });
      const cols = [
        { t: T.n, w: 40 }, { t: T.arrive, w: 170 }, { t: T.depart, w: 170 }, { t: T.onDays, w: 150 }, { t: T.homeDays, w: 180 }
      ];
      const tw = cols.reduce((a, c) => a + c.w, 0);
      let ty = 78;
      const tx0 = (PW - tw) / 2;
      const drawHead = () => {
        doc.roundedRect(tx0, ty, tw, 24, 6).fill(C.navyDark);
        let cxp = tx0;
        bold(9); doc.fillColor('#ffffff');
        cols.forEach((c) => { doc.text(c.t, cxp, ty + 8, { width: c.w, align: 'center', lineBreak: false }); cxp += c.w; });
        ty += 28;
      };
      drawHead();
      const RH = 24;
      shifts.forEach((sh, idx) => {
        if (ty + RH > PH - 30) { doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 }); ty = 30; drawHead(); }
        if (idx % 2 === 0) doc.roundedRect(tx0, ty, tw, RH, 4).fill(C.card);
        const vals = [String(idx + 1), fmt(sh.arrival), fmt(sh.departure), `${sh.days}`, `${restDays}`];
        let cxp = tx0;
        reg(10);
        vals.forEach((v, k) => {
          doc.fillColor(k === 1 ? C.arrival : k === 2 ? C.departure : C.ink);
          if (k === 1 || k === 2) bold(10); else reg(10);
          doc.text(v, cxp, ty + 7, { width: cols[k].w, align: 'center', lineBreak: false });
          cxp += cols[k].w;
        });
        ty += RH;
      });
      reg(8); doc.fillColor(C.faint).text(`${T.made}: ${fmt(opts.todayIso)}`, tx0, ty + 12, { width: tw, align: 'right', lineBreak: false });

      doc.end();
    } catch (e) { reject(e); }
  });
}

function CURRENT_NOTE(T) { return T === TXT.kz ? 'бос күндер' : 'дни без отметки'; }

module.exports = { buildRotationCalendarPdf, buildShifts };
