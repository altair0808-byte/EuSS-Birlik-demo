const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { splitMulti, scopedFilter } = require('../lib/multiFilter');

// Экспорт журнала обучения в Excel.
//
// GET /api/export/excel?…  Параметры (все необязательные):
//   object, department, course_id, status, user_id   — фильтры
//   date_from, date_to                               — период даты прохождения (ГГГГ-ММ-ДД)
//   validity   = overdue | soon | valid              — срок действия (просрочено / ≤30 дней / действует)
//   sort       = org | fio | object | department | course | test_date | next_test_date
//   split      = none | object | department | course — разделить на отдельные листы
//   latest     = 1                                   — только последняя запись по сотруднику и курсу
//
// Книга: лист «Сводка» (показатели и разбивка по объектам/отделам/курсам) + лист(ы) с журналом.
// На листах журнала включён автофильтр Excel (можно самому фильтровать и сортировать по любому столбцу),
// закреплена шапка, даты — настоящие даты Excel, «Осталось дней» — формула от сегодняшней даты.

const TZ = process.env.EXPORT_TZ || 'Asia/Almaty';
const DAY_MS = 86400000;
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

// Календарный день (в часовом поясе организации) → Date на 00:00 UTC, чтобы Excel показал именно эту дату.
function toDay(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const dt = v instanceof Date ? v : new Date(s);
  if (isNaN(dt.getTime())) return null;
  const [y, m, d] = dayFmt.format(dt).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDay(d) {
  if (!d) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

const STATUS_LABEL = { passed: 'Сдал', failed: 'Не сдал', pending: 'Назначен', in_progress: 'В процессе' };
const STATUS_STYLE = {
  passed: { bg: 'FFC6EFCE', fg: 'FF006100' },
  failed: { bg: 'FFFFC7CE', fg: 'FF9C0006' },
  pending: { bg: 'FFFFEB9C', fg: 'FF9C5700' },
  in_progress: { bg: 'FFDDEBF7', fg: 'FF1F4E79' }
};
const VALIDITY_LABEL = { overdue: 'просрочено', soon: 'истекает в ближайшие 30 дней', valid: 'действует' };
const SORT_LABEL = {
  org: 'по объекту → отделу → ФИО',
  fio: 'по ФИО',
  object: 'по объекту',
  department: 'по отделу',
  course: 'по курсу',
  test_date: 'по дате прохождения (новые сверху)',
  next_test_date: 'по дате следующего прохождения (ближайшие сверху)'
};
const SPLIT_LABEL = { none: 'нет (один лист)', object: 'по объектам', department: 'по отделам', course: 'по курсам' };

// ---------- сортировка ----------
const collator = new Intl.Collator('ru');
const strAsc = f => (a, b) => collator.compare(String(f(a) || ''), String(f(b) || ''));
// пустые значения (сотрудник без объекта/отдела) — в конец
const strAscEmptyLast = f => (a, b) => {
  const x = String(f(a) || ''), y = String(f(b) || '');
  if (!x && y) return 1;
  if (x && !y) return -1;
  return collator.compare(x, y);
};
const dateDesc = f => (a, b) => (f(b) ? f(b).getTime() : -Infinity) - (f(a) ? f(a).getTime() : -Infinity);
const dateAscNullsLast = f => (a, b) => {
  const x = f(a), y = f(b);
  if (!x && y) return 1;
  if (x && !y) return -1;
  if (!x && !y) return 0;
  return x.getTime() - y.getTime();
};
const byFio = strAsc(r => r.fio);
const byObject = strAscEmptyLast(r => r.object);
const byDept = strAscEmptyLast(r => r.department);
const byCourse = strAsc(r => r.course);

const SORTERS = {
  org: [byObject, byDept, byFio, byCourse],
  fio: [byFio, byCourse],
  object: [byObject, byFio, byCourse],
  department: [byDept, byFio, byCourse],
  course: [byCourse, byObject, byDept, byFio],
  test_date: [dateDesc(r => r.testDay), byFio],
  next_test_date: [dateAscNullsLast(r => r.nextDay), byFio]
};

function sortRows(rows, sortKey) {
  const chain = SORTERS[sortKey] || SORTERS.org;
  return rows.sort((a, b) => {
    for (const cmp of chain) {
      const v = cmp(a, b);
      if (v) return v;
    }
    return 0;
  });
}

// ---------- подготовка строк ----------
function shapeRow(r, today) {
  const testDay = toDay(r.test_date);
  const nextDay = r.no_expiry ? null : toDay(r.next_test_date);
  let daysLeft = null;
  let validity = '';
  if (r.status === 'passed') {
    if (r.is_current === false) {
      // более ранняя запись: сотрудник уже пересдал этот курс — срок по ней не оценивается
      validity = 'archive';
    } else if (r.no_expiry) {
      validity = 'forever';
    } else if (nextDay) {
      daysLeft = Math.round((nextDay.getTime() - today.getTime()) / DAY_MS);
      validity = daysLeft < 0 ? 'overdue' : daysLeft <= 30 ? 'soon' : 'valid';
    }
  }
  return {
    ...r,
    fio: `${r.last_name || ''} ${r.first_name || ''}`.trim(),
    course: r.title_ru || r.title_kz || '',
    category: r.category_ru || r.category_kz || '',
    testDay,
    nextDay,
    protoDay: toDay(r.protocol_date),
    daysLeft,
    validity
  };
}

function groupRows(rows, split) {
  const keyOf = { object: r => r.object || '', department: r => r.department || '', course: r => r.course || '' }[split];
  if (!keyOf) return [{ name: 'Журнал обучения', title: 'Журнал обучения', rows }];
  const empty = { object: 'Без объекта', department: 'Без отдела', course: 'Без курса' }[split];
  const prefix = { object: 'Объект', department: 'Отдел', course: 'Курс' }[split];
  const map = new Map();
  rows.forEach(r => {
    const k = keyOf(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  });
  return [...map.entries()]
    .sort((a, b) => (!a[0] - !b[0]) || collator.compare(a[0], b[0]))
    .map(([k, list]) => ({ name: k || empty, title: `${prefix}: ${k || empty}`, rows: list }));
}

function statsOf(rows) {
  const users = new Set();
  const s = { records: rows.length, employees: 0, passed: 0, failed: 0, waiting: 0, overdue: 0, soon: 0 };
  rows.forEach(r => {
    users.add(r.user_id);
    if (r.status === 'passed') s.passed++;
    else if (r.status === 'failed') s.failed++;
    else s.waiting++;
    if (r.validity === 'overdue') s.overdue++;
    if (r.validity === 'soon') s.soon++;
  });
  s.employees = users.size;
  return s;
}

// ---------- оформление ----------
const C = {
  navy: 'FF1F3864',
  blue: 'FF1F4E79',
  blueMid: 'FF2E75B6',
  blueLight: 'FFDDEBF7',
  zebra: 'FFF3F7FC',
  grid: 'FFD0D7E2',
  text: 'FF262626',
  muted: 'FF6B7280',
  white: 'FFFFFFFF'
};
const thin = color => ({ style: 'thin', color: { argb: color } });
const gridBorder = { top: thin(C.grid), left: thin(C.grid), bottom: thin(C.grid), right: thin(C.grid) };
const solid = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function colLetter(n) { // 1 → A
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const COLS = [
  { key: 'n', header: '№', width: 6, align: 'center' },
  { key: 'fio', header: 'Сотрудник', width: 28, align: 'left', bold: true },
  { key: 'login', header: 'Логин / таб. №', width: 15, align: 'center' },
  { key: 'object', header: 'Объект', width: 20, align: 'left' },
  { key: 'department', header: 'Отдел', width: 20, align: 'left' },
  { key: 'position', header: 'Должность', width: 22, align: 'left' },
  { key: 'course', header: 'Курс', width: 32, align: 'left' },
  { key: 'category', header: 'Категория', width: 23, align: 'left' },
  { key: 'status', header: 'Статус', width: 13, align: 'center' },
  { key: 'score', header: 'Результат', width: 11, align: 'center', numFmt: '0"%"' },
  { key: 'testDay', header: 'Дата прохождения', width: 14, align: 'center', numFmt: 'dd.mm.yyyy' },
  { key: 'nextDay', header: 'Следующее прохождение (действителен до)', width: 19, align: 'center', numFmt: 'dd.mm.yyyy' },
  { key: 'daysLeft', header: 'Осталось дней', width: 11, align: 'center', numFmt: '0' },
  { key: 'cert', header: '№ сертификата', width: 16, align: 'center' },
  { key: 'protocol', header: '№ протокола', width: 13, align: 'center' },
  { key: 'protoDay', header: 'Дата протокола', width: 13, align: 'center', numFmt: 'dd.mm.yyyy' }
];
const COL_IDX = Object.fromEntries(COLS.map((c, i) => [c.key, i + 1]));
const HEADER_ROW = 4;

function makeSheetNamer() {
  const used = new Set();
  return raw => {
    let base = String(raw || '').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '') || 'Лист';
    base = base.slice(0, 31);
    let name = base;
    let i = 2;
    while (used.has(name.toLowerCase())) {
      const suf = ` (${i++})`;
      name = base.slice(0, 31 - suf.length) + suf;
    }
    used.add(name.toLowerCase());
    return name;
  };
}

function setTitleBlock(ws, lastCol, title, subtitle) {
  ws.mergeCells(`A1:${lastCol}1`);
  const t = ws.getCell('A1');
  t.value = title;
  t.font = { name: 'Calibri', size: 16, bold: true, color: { argb: C.white } };
  t.fill = solid(C.navy);
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 30;
  if (subtitle !== undefined) {
    ws.mergeCells(`A2:${lastCol}2`);
    const s = ws.getCell('A2');
    s.value = subtitle;
    s.font = { name: 'Calibri', size: 10, italic: true, color: { argb: C.muted } };
    s.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(2).height = 18;
  }
}

// ---------- лист журнала ----------
function writeJournalSheet(wb, sheetName, title, rows, ctx) {
  const ws = wb.addWorksheet(sheetName, {
    properties: { tabColor: { argb: C.blueMid } },
    views: [{ state: 'frozen', xSplit: 2, ySplit: HEADER_ROW, showGridLines: false }]
  });
  const lastCol = colLetter(COLS.length);
  COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  const first = HEADER_ROW + 1;
  const last = HEADER_ROW + Math.max(rows.length, 1);

  setTitleBlock(ws, lastCol, title, undefined);
  // строка 2: компания и дата (слева) + счётчик видимых строк (справа, учитывает автофильтр)
  ws.mergeCells(`A2:${colLetter(COL_IDX.category)}2`);
  const sub = ws.getCell('A2');
  sub.value = `${ctx.company ? ctx.company + '  ·  ' : ''}Сформировано: ${fmtDay(ctx.today)}`;
  sub.font = { name: 'Calibri', size: 10, italic: true, color: { argb: C.muted } };
  sub.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.mergeCells(`${colLetter(COL_IDX.status)}2:${colLetter(COL_IDX.testDay)}2`);
  const cntLabel = ws.getCell(`${colLetter(COL_IDX.status)}2`);
  cntLabel.value = 'Показано записей:';
  cntLabel.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.muted } };
  cntLabel.alignment = { vertical: 'middle', horizontal: 'right' };
  const cnt = ws.getCell(`${colLetter(COL_IDX.nextDay)}2`);
  cnt.value = { formula: `SUBTOTAL(103,B${first}:B${last})`, result: rows.length };
  cnt.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.blue } };
  cnt.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 20;
  ws.getRow(3).height = 6;

  // шапка
  const head = ws.getRow(HEADER_ROW);
  head.height = 44;
  COLS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.white } };
    cell.fill = solid(C.blue);
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: thin(C.white), left: thin(C.white), bottom: thin(C.white), right: thin(C.white) };
  });

  if (!rows.length) {
    ws.mergeCells(`A${first}:${lastCol}${first}`);
    const m = ws.getCell(`A${first}`);
    m.value = 'Нет данных по выбранным условиям';
    m.font = { name: 'Calibri', size: 11, italic: true, color: { argb: C.muted } };
    m.alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(first).height = 28;
  }

  const nextLetter = colLetter(COL_IDX.nextDay);
  rows.forEach((r, idx) => {
    const rowNum = first + idx;
    const row = ws.getRow(rowNum);
    row.height = 20;
    const zebra = idx % 2 === 1;

    const values = {
      n: idx + 1,
      fio: r.fio,
      login: r.login || '',
      object: r.object || '',
      department: r.department || '',
      position: r.position || '',
      course: r.course,
      category: r.category,
      status: STATUS_LABEL[r.status] || r.status,
      score: r.score_percent === null || r.score_percent === undefined ? null : Number(r.score_percent),
      testDay: r.testDay,
      nextDay: r.validity === 'forever' ? 'Бессрочно' : r.nextDay,
      daysLeft: null,
      cert: r.certificate_number || '',
      protocol: r.protocol_number || '',
      protoDay: r.protoDay
    };

    COLS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.key === 'daysLeft') {
        // живая формула: пересчитывается при каждом открытии файла
        cell.value = (r.nextDay && r.validity !== 'archive')
          ? { formula: `IF(ISNUMBER(${nextLetter}${rowNum}),${nextLetter}${rowNum}-TODAY(),"")`, result: r.daysLeft === null ? '' : r.daysLeft }
          : null;
      } else {
        cell.value = values[c.key] === '' ? null : values[c.key];
      }
      cell.font = { name: 'Calibri', size: 10, bold: !!c.bold, color: { argb: C.text } };
      cell.alignment = { vertical: 'middle', horizontal: c.align || 'left', wrapText: c.key === 'course' || c.key === 'position' };
      cell.border = gridBorder;
      if (zebra) cell.fill = solid(C.zebra);
      if (c.numFmt) cell.numFmt = c.numFmt;
    });

    const st = STATUS_STYLE[r.status];
    if (st) {
      const sc = row.getCell(COL_IDX.status);
      sc.fill = solid(st.bg);
      sc.font = { name: 'Calibri', size: 10, bold: true, color: { argb: st.fg } };
    }
    if (r.validity === 'forever' || r.validity === 'archive') {
      row.getCell(COL_IDX.nextDay).font = { name: 'Calibri', size: 10, italic: true, color: { argb: C.muted } };
    }
    if (r.validity === 'archive') {
      row.getCell(COL_IDX.daysLeft).value = 'архив';
      row.getCell(COL_IDX.daysLeft).font = { name: 'Calibri', size: 9, italic: true, color: { argb: C.muted } };
    }
  });

  // автофильтр Excel — фильтрация и сортировка по любому столбцу прямо в файле
  ws.autoFilter = rows.length ? `A${HEADER_ROW}:${lastCol}${last}` : `A${HEADER_ROW}:${lastCol}${HEADER_ROW}`;

  // подсветка срока (живая: считается от сегодняшней даты при открытии файла)
  try {
    const ref = `${nextLetter}${first}:${colLetter(COL_IDX.daysLeft)}${last}`;
    const dl = `$${colLetter(COL_IDX.daysLeft)}${first}`;
    const fill = argb => ({ type: 'pattern', pattern: 'solid', bgColor: { argb } });
    ws.addConditionalFormatting({
      ref,
      rules: [
        { type: 'expression', priority: 1, formulae: [`AND(ISNUMBER(${dl}),${dl}<0)`], style: { fill: fill('FFFFC7CE'), font: { bold: true, color: { argb: 'FF9C0006' } } } },
        { type: 'expression', priority: 2, formulae: [`AND(ISNUMBER(${dl}),${dl}>=0,${dl}<=30)`], style: { fill: fill('FFFFEB9C'), font: { bold: true, color: { argb: 'FF9C5700' } } } },
        { type: 'expression', priority: 3, formulae: [`AND(ISNUMBER(${dl}),${dl}>30)`], style: { fill: fill('FFC6EFCE'), font: { color: { argb: 'FF006100' } } } }
      ]
    });
  } catch (e) { /* подсветка — не критична, файл всё равно формируется */ }

  // печать: альбомная, по ширине страницы, шапка повторяется на каждой странице
  try {
    ws.pageSetup = {
      orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`
    };
  } catch (e) { /* не критично */ }
  return ws;
}

// ---------- лист «Сводка» ----------
function writeBreakdown(ws, startRow, title, groups) {
  ws.mergeCells(`A${startRow}:H${startRow}`);
  const h = ws.getCell(`A${startRow}`);
  h.value = title;
  h.font = { name: 'Calibri', size: 12, bold: true, color: { argb: C.blue } };
  h.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(startRow).height = 24;

  const headers = ['Название', 'Сотрудников', 'Записей', 'Сдали', 'Не сдали', 'Ожидают', 'Просрочено', 'Истекает ≤ 30 дн.'];
  const hr = ws.getRow(startRow + 1);
  hr.height = 30;
  headers.forEach((t, i) => {
    const c = hr.getCell(i + 1);
    c.value = t;
    c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.white } };
    c.fill = solid(C.blueMid);
    c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center', wrapText: true, indent: i === 0 ? 1 : 0 };
    c.border = { top: thin(C.white), left: thin(C.white), bottom: thin(C.white), right: thin(C.white) };
  });

  let r = startRow + 2;
  const total = { employees: new Set(), records: 0, passed: 0, failed: 0, waiting: 0, overdue: 0, soon: 0 };
  groups.forEach((g, idx) => {
    const s = statsOf(g.rows);
    g.rows.forEach(x => total.employees.add(x.user_id));
    ['records', 'passed', 'failed', 'waiting', 'overdue', 'soon'].forEach(k => { total[k] += s[k]; });
    const row = ws.getRow(r++);
    row.height = 20;
    const vals = [g.name, s.employees, s.records, s.passed, s.failed, s.waiting, s.overdue, s.soon];
    vals.forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v;
      c.font = { name: 'Calibri', size: 10, bold: i === 0, color: { argb: C.text } };
      c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center', indent: i === 0 ? 1 : 0 };
      c.border = gridBorder;
      if (idx % 2 === 1) c.fill = solid(C.zebra);
    });
    if (s.failed) row.getCell(5).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF9C0006' } };
    if (s.overdue) row.getCell(7).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF9C0006' } };
    if (s.soon) row.getCell(8).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF9C5700' } };
  });

  const tr = ws.getRow(r++);
  tr.height = 22;
  ['Итого', total.employees.size, total.records, total.passed, total.failed, total.waiting, total.overdue, total.soon].forEach((v, i) => {
    const c = tr.getCell(i + 1);
    c.value = v;
    c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.navy } };
    c.fill = solid(C.blueLight);
    c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center', indent: i === 0 ? 1 : 0 };
    c.border = { top: { style: 'medium', color: { argb: C.blue } }, bottom: thin(C.grid), left: thin(C.grid), right: thin(C.grid) };
  });
  return r + 1; // следующая свободная строка (с отступом)
}

function writeSummarySheet(wb, allRows, ctx) {
  const ws = wb.addWorksheet('Сводка', {
    properties: { tabColor: { argb: C.navy } },
    views: [{ showGridLines: false }]
  });
  ws.getColumn(1).width = 40;
  for (let i = 2; i <= 8; i++) ws.getColumn(i).width = 15;

  setTitleBlock(ws, 'H', 'Сводка по обучению и проверке знаний',
    `${ctx.company ? ctx.company + '  ·  ' : ''}Сформировано: ${fmtDay(ctx.today)}`);

  // параметры выгрузки
  let r = 4;
  ws.mergeCells(`A${r}:H${r}`);
  const ph = ws.getCell(`A${r}`);
  ph.value = 'Параметры выгрузки';
  ph.font = { name: 'Calibri', size: 12, bold: true, color: { argb: C.blue } };
  ws.getRow(r).height = 24;
  r++;
  ctx.filterLines.forEach(([label, value]) => {
    const a = ws.getCell(`A${r}`);
    a.value = label;
    a.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.muted } };
    a.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.mergeCells(`B${r}:H${r}`);
    const b = ws.getCell(`B${r}`);
    b.value = value;
    b.font = { name: 'Calibri', size: 10, color: { argb: C.text } };
    b.alignment = { vertical: 'middle', horizontal: 'left' };
    ws.getRow(r).height = 18;
    r++;
  });
  r++;

  // основные показатели
  ws.mergeCells(`A${r}:H${r}`);
  const kh = ws.getCell(`A${r}`);
  kh.value = 'Основные показатели';
  kh.font = { name: 'Calibri', size: 12, bold: true, color: { argb: C.blue } };
  ws.getRow(r).height = 24;
  r++;
  const s = statsOf(allRows);
  const kpis = [
    ['Записей в журнале', s.records, C.blueLight, C.navy],
    ['Сотрудников', s.employees, C.blueLight, C.navy],
    ['Сдали', s.passed, 'FFC6EFCE', 'FF006100'],
    ['Не сдали', s.failed, s.failed ? 'FFFFC7CE' : C.blueLight, s.failed ? 'FF9C0006' : C.navy],
    ['Ожидают прохождения', s.waiting, s.waiting ? 'FFFFEB9C' : C.blueLight, s.waiting ? 'FF9C5700' : C.navy],
    ['Срок истёк (просрочено)', s.overdue, s.overdue ? 'FFFFC7CE' : C.blueLight, s.overdue ? 'FF9C0006' : C.navy],
    ['Истекает в ближайшие 30 дней', s.soon, s.soon ? 'FFFFEB9C' : C.blueLight, s.soon ? 'FF9C5700' : C.navy]
  ];
  kpis.forEach(([label, value, bg, fg]) => {
    const a = ws.getCell(`A${r}`);
    a.value = label;
    a.font = { name: 'Calibri', size: 11, color: { argb: C.text } };
    a.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    a.border = gridBorder;
    const b = ws.getCell(`B${r}`);
    b.value = value;
    b.font = { name: 'Calibri', size: 13, bold: true, color: { argb: fg } };
    b.fill = solid(bg);
    b.alignment = { vertical: 'middle', horizontal: 'center' };
    b.border = gridBorder;
    ws.getRow(r).height = 24;
    r++;
  });
  r++;

  // разбивка
  const by = keyFn => {
    const m = new Map();
    allRows.forEach(x => { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
    return [...m.entries()].sort((a, b) => (!a[0] - !b[0]) || collator.compare(a[0], b[0])).map(([k, list]) => ({ name: k, rows: list }));
  };
  const named = (groups, empty) => groups.map(g => ({ ...g, name: g.name || empty }));
  if (allRows.length) {
    r = writeBreakdown(ws, r, 'По объектам', named(by(x => x.object || ''), 'Без объекта'));
    r = writeBreakdown(ws, r, 'По отделам', named(by(x => x.department || ''), 'Без отдела'));
    r = writeBreakdown(ws, r, 'По курсам', named(by(x => x.course || ''), 'Без курса'));
  } else {
    ws.mergeCells(`A${r}:H${r}`);
    const m = ws.getCell(`A${r}`);
    m.value = 'Нет данных по выбранным условиям';
    m.font = { name: 'Calibri', size: 11, italic: true, color: { argb: C.muted } };
    m.alignment = { horizontal: 'center' };
  }

  try {
    ws.pageSetup = { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  } catch (e) { /* не критично */ }
  return ws;
}

// ---------- маршрут ----------
// ТЗ «роли/ИИН/PDF=копия Word», ответ по §11.2: assistant тоже получает экспорт в ПОЛНОМ
// объёме (те же колонки, что у admin/superadmin), но ограничен своей зоной видимости
// (assistant_objects/assistant_departments) — см. scopedFilter(). Если зона не выдана,
// доступа к экспорту нет вообще (безопасный дефолт, как и в списке сотрудников).
router.get('/excel', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const { object, department, course_id, status, user_id, date_from, date_to } = req.query;
    const validity = ['overdue', 'soon', 'valid'].includes(req.query.validity) ? req.query.validity : '';
    const sortKey = SORTERS[req.query.sort] ? req.query.sort : 'org';
    const split = ['object', 'department', 'course'].includes(req.query.split) ? req.query.split : 'none';
    const latestOnly = req.query.latest === '1' || req.query.latest === 'true';

    const scope = scopedFilter(req.user, splitMulti(object), splitMulti(department));
    if (scope.noAccess) {
      return res.status(403).json({ error: 'no_zone', message: 'Вам не выдана зона видимости (объекты/отделы) — обратитесь к суперадмину' });
    }

    let sql = `
      SELECT a.id, a.user_id, a.course_id, a.status, a.score_percent, a.test_date, a.next_test_date,
             a.certificate_number, a.protocol_number, a.protocol_date, a.created_at,
             u.last_name, u.first_name, u.object, u.department, u.position, u.login,
             c.title_ru, c.title_kz, c.category_ru, c.category_kz, c.no_expiry,
             (a.status = 'passed' AND NOT EXISTS (
               SELECT 1 FROM assignments n
               WHERE n.user_id = a.user_id AND n.course_id = a.course_id AND n.status = 'passed'
                 AND (COALESCE(n.test_date, '') > COALESCE(a.test_date, '')
                      OR (COALESCE(n.test_date, '') = COALESCE(a.test_date, '') AND n.id > a.id))
             )) AS is_current
      FROM assignments a
      JOIN users u ON u.id = a.user_id
      JOIN courses c ON c.id = a.course_id
      WHERE u.role = 'employee'
    `;
    const params = [];
    const objects = scope.objects;
    const departments = scope.departments;
    if (objects.length) { params.push(objects); sql += ` AND u.object = ANY($${params.length}::text[])`; }
    if (departments.length) { params.push(departments); sql += ` AND u.department = ANY($${params.length}::text[])`; }
    if (course_id) { params.push(course_id); sql += ` AND a.course_id = $${params.length}`; }
    if (user_id) { params.push(user_id); sql += ` AND a.user_id = $${params.length}`; }
    if (status && STATUS_LABEL[status]) { params.push(status); sql += ` AND a.status = $${params.length}`; }
    if (date_from) { params.push(date_from); sql += ` AND a.test_date >= $${params.length}`; }
    if (date_to) { params.push(date_to + 'T23:59:59.999Z'); sql += ` AND a.test_date <= $${params.length}`; }
    sql += ' ORDER BY a.created_at DESC, a.id DESC';

    const [result, settingsRes, courseRes] = await Promise.all([
      query(sql, params),
      query('SELECT company_name FROM settings WHERE id = 1'),
      course_id ? query('SELECT title_ru FROM courses WHERE id = $1', [course_id]) : Promise.resolve({ rows: [] })
    ]);

    const today = toDay(new Date());
    let rows = result.rows.map(r => shapeRow(r, today));

    if (latestOnly) {
      // строки уже идут от новых к старым — берём первую запись по каждой паре «сотрудник + курс»
      const seen = new Set();
      rows = rows.filter(r => {
        const k = `${r.user_id}:${r.course_id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (validity === 'overdue') rows = rows.filter(r => r.validity === 'overdue');
    else if (validity === 'soon') rows = rows.filter(r => r.validity === 'soon');
    else if (validity === 'valid') rows = rows.filter(r => r.validity === 'valid' || r.validity === 'forever');

    sortRows(rows, sortKey);

    const company = (settingsRes.rows[0] && settingsRes.rows[0].company_name) || '';
    const period = date_from || date_to
      ? `${date_from ? 'с ' + fmtDay(toDay(date_from)) : ''}${date_from && date_to ? ' ' : ''}${date_to ? 'по ' + fmtDay(toDay(date_to)) : ''}`
      : 'весь период';
    const ctx = {
      company,
      today,
      filterLines: [
        ['Объект', object || 'все'],
        ['Отдел', department || 'все'],
        ['Курс', course_id ? ((courseRes.rows[0] && courseRes.rows[0].title_ru) || course_id) : 'все'],
        ['Статус', status && STATUS_LABEL[status] ? STATUS_LABEL[status] : 'любой'],
        ['Дата прохождения', period],
        ['Срок действия', validity ? VALIDITY_LABEL[validity] : 'любой'],
        ['Только последняя запись по курсу', latestOnly ? 'да' : 'нет (вся история)'],
        ['Сортировка', SORT_LABEL[sortKey]],
        ['Разделение по листам', SPLIT_LABEL[split]],
        ['Примечание', 'Срок действия оценивается по последней успешной записи по каждому курсу; более ранние (заменённые пересдачей) помечены «архив»']
      ]
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TB Training Platform';
    wb.created = new Date();

    const namer = makeSheetNamer();
    namer('Сводка'); // резервируем имя первого листа
    writeSummarySheet(wb, rows, ctx);

    groupRows(rows, split).forEach(g => {
      writeJournalSheet(wb, namer(g.name), g.title, g.rows, ctx);
    });

    const stamp = fmtDay(today).split('.').reverse().join('-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="journal_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent('Журнал_обучения_' + stamp + '.xlsx')}`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Excel export failed:', e);
    if (!res.headersSent) res.status(500).json({ error: 'export_failed', message: 'Не удалось сформировать Excel: ' + e.message, details: e.message });
    else res.end();
  }
});

// ---------- Уведомление о необходимости обучения (п.4 запроса UI) ----------
// Формирует Excel-файл для рассылки руководителю подразделения: обращение с ссылкой
// на портал, таблица «Сотрудник / Логин / Пароль» и напоминание сдать удостоверение.
//
// Правило (с 25.09.2026): пароль сотрудника ВСЕГДА равен его логину — ничего отдельно
// не придумывается и не генерируется. Это не «слабый пароль», а сознательное решение:
// пароли всё равно хранятся только в виде bcrypt-хэша и однажды выданный случайный
// пароль нельзя ни посмотреть повторно, ни распечатать в следующем уведомлении —
// а логин пароль=логин можно пересобрать в любой момент, ничего не «сбрасывая».
// При каждом формировании уведомления хэш пароля сотрудника (пере)записывается как
// bcrypt(логин), так что в файле пароль и логин гарантированно совпадают.
//
// Если у сотрудника вообще нет логина — ему присваивается новый (свободный табельный
// номер), и такой сотрудник дополнительно попадает в список missing (в заголовке
// ответа X-Credentials-Missing), чтобы админ был уведомлён, у кого логин/пароль
// не были указаны и были созданы заново.
function genCredentialLogin() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-значный табельный номер
}

router.post('/credentials-notice', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.user_ids)
      ? [...new Set(req.body.user_ids.map(Number).filter(n => Number.isFinite(n) && n > 0))]
      : [];
    if (!ids.length) return res.status(400).json({ error: 'no_users', message: 'Не выбрано ни одного сотрудника' });
    const portalUrl = String(req.body.portal_url || `${req.protocol}://${req.get('host')}`).trim();

    const usersRes = await query(
      `SELECT id, last_name, first_name, department, position, login
       FROM users WHERE id = ANY($1::bigint[]) AND role = 'employee'
       ORDER BY last_name, first_name`,
      [ids]
    );
    if (!usersRes.rows.length) return res.status(404).json({ error: 'not_found', message: 'Сотрудники не найдены' });

    const rows = [];
    const missing = []; // ФИО тех, у кого логина не было — для уведомления админа
    for (const u of usersRes.rows) {
      let login = u.login;
      if (!login) {
        // подбираем свободный логин (табельный номер)
        do {
          login = genCredentialLogin();
          // eslint-disable-next-line no-await-in-loop
        } while ((await query('SELECT 1 FROM users WHERE login = $1', [login])).rows.length);
        missing.push(`${u.last_name} ${u.first_name}`);
      }
      // Пароль всегда = логину — перезаписываем хэш при каждом формировании уведомления.
      const hash = bcrypt.hashSync(String(login), 10);
      // eslint-disable-next-line no-await-in-loop
      await query('UPDATE users SET login = $1, password_hash = $2 WHERE id = $3', [login, hash, u.id]);
      rows.push({
        fio: `${u.last_name} ${u.first_name}`,
        department: u.department || '',
        position: u.position || '',
        login,
        password: login
      });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TB Training Platform';
    wb.created = new Date();
    const ws = wb.addWorksheet('Уведомление', {
      properties: { tabColor: { argb: C.navy } },
      views: [{ showGridLines: false, state: 'frozen', ySplit: 7 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 30;
    ws.getColumn(3).width = 22;
    ws.getColumn(4).width = 20;
    ws.getColumn(5).width = 18;
    ws.getColumn(6).width = 18;

    let r = 1;
    // Тонкая цветная плашка сверху для аккуратности
    ws.mergeCells(`A${r}:F${r}`);
    ws.getRow(r).height = 6;
    ws.getCell(`A${r}`).fill = solid(C.blueMid);
    r++;

    ws.mergeCells(`A${r}:F${r}`);
    const title = ws.getCell(`A${r}`);
    title.value = '🛡️  Уведомление о прохождении обучения по БиОТ';
    title.font = { name: 'Calibri', size: 16, bold: true, color: { argb: C.white } };
    title.fill = solid(C.navy);
    title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
    ws.getRow(r).height = 34;
    r++;

    ws.mergeCells(`A${r}:F${r}`);
    const dateCell = ws.getCell(`A${r}`);
    dateCell.value = 'Дата формирования: ' + fmtDay(toDay(new Date()));
    dateCell.font = { name: 'Calibri', size: 9, italic: true, color: { argb: C.white } };
    dateCell.fill = solid(C.navy);
    dateCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(r).height = 16;
    r += 2;

    ws.mergeCells(`A${r}:F${r}`);
    const intro = ws.getCell(`A${r}`);
    intro.value = 'Просим Вас довести до сведения сотрудников подразделения необходимость прохождения '
      + 'обучения и тестирования по БиОТ на портале:';
    intro.font = { name: 'Calibri', size: 11, color: { argb: C.text } };
    intro.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 };
    ws.getRow(r).height = 36;
    r++;

    ws.mergeCells(`A${r}:F${r}`);
    const link = ws.getCell(`A${r}`);
    link.value = { text: '🔗  ТБ / БиОТ — Обучение и тестирование', hyperlink: portalUrl };
    link.font = { name: 'Calibri', size: 12, bold: true, underline: true, color: { argb: 'FF1155CC' } };
    link.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(r).height = 24;
    r++;

    ws.mergeCells(`A${r}:F${r}`);
    const note = ws.getCell(`A${r}`);
    note.value = 'ℹ️  Пароль каждого сотрудника совпадает с его логином (см. столбцы ниже) — вводить нужно оба значения одинаково.';
    note.font = { name: 'Calibri', size: 9, italic: true, color: { argb: C.muted } };
    note.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 };
    ws.getRow(r).height = 18;
    r++;

    ['№', 'Сотрудник', 'Отдел', 'Должность', 'Логин', 'Пароль'].forEach((h, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = h;
      c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.white } };
      c.fill = solid(C.blueMid);
      c.alignment = { vertical: 'middle', horizontal: 'center' };
      c.border = { top: thin(C.white), left: thin(C.white), bottom: thin(C.white), right: thin(C.white) };
    });
    ws.getRow(r).height = 24;
    r++;

    rows.forEach((row, idx) => {
      const rr = ws.getRow(r);
      rr.height = 21;
      const isMissing = missing.includes(row.fio);
      [idx + 1, row.fio, row.department, row.position, row.login, row.password].forEach((v, i) => {
        const c = rr.getCell(i + 1);
        c.value = v;
        c.font = { name: 'Calibri', size: 10, color: { argb: C.text }, bold: i === 1 || i === 4 || i === 5 };
        c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'center' : (i === 1 || i === 2 || i === 3) ? 'left' : 'center', indent: (i === 1 || i === 2 || i === 3) ? 1 : 0 };
        c.border = gridBorder;
        if (i === 4 || i === 5) c.fill = solid('FFEFF9F0'); // логин/пароль слегка подсвечены
        else if (idx % 2 === 1) c.fill = solid(C.zebra);
      });
      if (isMissing) {
        // помечаем строку сотрудника, которому логин/пароль присвоены заново
        rr.getCell(2).note = 'Логин/пароль не были указаны — созданы заново при формировании этого уведомления.';
      }
      r++;
    });
    r++;

    if (missing.length) {
      ws.mergeCells(`A${r}:F${r}`);
      const warn = ws.getCell(`A${r}`);
      warn.value = `⚠️  У ${missing.length} сотрудник(ов) логин/пароль не были указаны в системе — созданы заново: ${missing.join(', ')}.`;
      warn.font = { name: 'Calibri', size: 9.5, bold: true, color: { argb: 'FF9C5700' } };
      warn.fill = solid('FFFFF3D6');
      warn.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 };
      ws.getRow(r).height = Math.max(18, Math.ceil(missing.join(', ').length / 90) * 14 + 10);
      r += 2;
    }

    ws.mergeCells(`A${r}:F${r}`);
    const outro = ws.getCell(`A${r}`);
    outro.value = 'После успешной сдачи тестирования сотруднику необходимо направить удостоверение по БиОТ '
      + 'в отдел ТБ административного здания для подписания.';
    outro.font = { name: 'Calibri', size: 10, italic: true, color: { argb: C.muted } };
    outro.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 };
    ws.getRow(r).height = 36;

    const stamp = fmtDay(toDay(new Date())).split('.').reverse().join('-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="credentials_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent('Уведомление_о_обучении_' + stamp + '.xlsx')}`);
    // Список сотрудников, кому логин/пароль присвоены заново — фронтенд читает этот
    // заголовок и показывает всплывающее уведомление админу (base64, т.к. заголовки
    // не поддерживают произвольную кириллицу без кодирования).
    res.setHeader('X-Credentials-Missing', Buffer.from(JSON.stringify(missing), 'utf8').toString('base64'));
    res.setHeader('Access-Control-Expose-Headers', 'X-Credentials-Missing, Content-Disposition');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Credentials notice export failed:', e);
    if (!res.headersSent) res.status(500).json({ error: 'export_failed', message: 'Не удалось сформировать файл: ' + e.message, details: e.message });
    else res.end();
  }
});

module.exports = router;
