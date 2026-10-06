// КУРСЫ ПО ДОЛЖНОСТЯМ.
//
//   GET  /api/course-positions/course/:id            — должности, для которых курс обязателен
//   POST /api/course-positions/course/:id/preview    — сколько уже работающих сотрудников будут записаны
//   PUT  /api/course-positions/course/:id            — сохранить набор должностей курса (+ записать работающих)
//   GET  /api/course-positions/matrix.xlsx?mode=blank|current
//                                                    — Excel-матрица: строки «Объект / Отдел / Должность»,
//                                                      колонки — все курсы, «+» = курс обязателен.
//                                                      blank — пустой бланк, current — с текущими «+»
//   POST /api/course-positions/matrix/import?dry=1&existing=1
//                                                    — загрузка матрицы: dry=1 только проверка,
//                                                      existing=1 — записать и уже работающих сотрудников
//
// Автозапись новых сотрудников — в lib/positionCourses.js (вызывается из routes/users.js и bulkTraining.js).
// Правило загрузки: в файле учитываются только те строки и колонки, которые в нём есть. Ячейка с «+» —
// курс обязателен, пустая ячейка — не обязателен (привязка снимается). Всё остальное не трогаем.
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeMemoryUploader } = require('../upload');
const { logAction } = require('../lib/audit');
const { norm, keyOf, countWouldEnroll, enrollExistingForKeys } = require('../lib/positionCourses');

const upload = makeMemoryUploader({ maxSizeMB: 10 });
const ADMIN = requireRole('admin', 'superadmin');

const PLUS_VALUES = new Set(['+', '＋', '✓', '✔', 'x', 'х', 'да', 'yes', '1', 'true']); // латинская x и русская х

// ---------- справочник «Объект → Отдел → Должность» ----------
// Плоский список строк структуры в заданном в «Настройках» порядке
async function loadStructureRows() {
  const r = await query('SELECT org_structure FROM settings WHERE id = 1');
  const structure = (r.rows[0] && Array.isArray(r.rows[0].org_structure)) ? r.rows[0].org_structure : [];
  const rows = [];
  structure.forEach((o) => {
    (o.departments || []).forEach((d) => {
      (d.positions || []).forEach((p) => {
        const position = typeof p === 'string' ? p : (p && p.ru) || '';
        if (position) rows.push({ object: o.object, department: d.name, position });
      });
    });
  });
  return rows;
}

function structureIndex(rows) {
  const map = new Map();
  rows.forEach((r) => map.set(keyOf(r.object, r.department, r.position), r));
  return map;
}

// ---------- курс: должности ----------
router.get('/course/:id', authRequired, ADMIN, async (req, res) => {
  try {
    const c = (await query('SELECT id, course_kind FROM courses WHERE id = $1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'not_found' });
    const items = (await query(
      'SELECT object, department, position FROM course_positions WHERE course_id = $1 ORDER BY object, department, position',
      [req.params.id]
    )).rows;
    res.json({ items, course_kind: c.course_kind });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Приводит присланные фронтендом позиции к каноническим названиям из структуры; чужие отбрасывает
function resolveItems(rawItems, sIndex) {
  const out = new Map();
  let dropped = 0;
  (Array.isArray(rawItems) ? rawItems : []).forEach((it) => {
    const k = keyOf(it && it.object, it && it.department, it && it.position);
    const canon = sIndex.get(k);
    if (canon) out.set(k, canon); else dropped += 1;
  });
  return { map: out, dropped };
}

router.post('/course/:id/preview', authRequired, ADMIN, async (req, res) => {
  try {
    const courseId = Number(req.params.id);
    const c = (await query('SELECT id, course_kind FROM courses WHERE id = $1', [courseId])).rows[0];
    if (!c) return res.status(404).json({ error: 'not_found' });
    const { map } = resolveItems(req.body.items, structureIndex(await loadStructureRows()));
    if (c.course_kind !== 'internal') return res.json({ auto_enroll: false, matched: 0, would_enroll: 0 });
    const cur = await query('SELECT key FROM course_positions WHERE course_id = $1', [courseId]);
    const have = new Set(cur.rows.map((r) => r.key));
    const added = new Set([...map.keys()].filter((k) => !have.has(k)));
    const cnt = await countWouldEnroll(courseId, added);
    res.json({ auto_enroll: true, ...cnt });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.put('/course/:id', authRequired, ADMIN, async (req, res) => {
  const courseId = Number(req.params.id);
  const client = await pool.connect();
  try {
    const c = (await query('SELECT id, title_ru, course_kind FROM courses WHERE id = $1', [courseId])).rows[0];
    if (!c) { client.release(); return res.status(404).json({ error: 'not_found' }); }
    const { map, dropped } = resolveItems(req.body.items, structureIndex(await loadStructureRows()));
    const cur = await query('SELECT key FROM course_positions WHERE course_id = $1', [courseId]);
    const have = new Set(cur.rows.map((r) => r.key));
    const addedKeys = new Set([...map.keys()].filter((k) => !have.has(k)));
    const removedKeys = [...have].filter((k) => !map.has(k));

    await client.query('BEGIN');
    if (removedKeys.length) {
      await client.query('DELETE FROM course_positions WHERE course_id = $1 AND key = ANY($2::text[])', [courseId, removedKeys]);
    }
    for (const k of addedKeys) {
      const it = map.get(k);
      await client.query(
        `INSERT INTO course_positions (course_id, object, department, position, key) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (course_id, key) DO NOTHING`,
        [courseId, it.object, it.department, it.position, k]
      );
    }
    await client.query('COMMIT');

    let enrolled = 0;
    const wantExisting = req.body.apply_existing === true || req.body.apply_existing === 'true';
    if (wantExisting && c.course_kind === 'internal' && addedKeys.size) {
      const r = await enrollExistingForKeys(courseId, addedKeys, req.user.id);
      enrolled = r.created;
    }
    await logAction(req, 'course_positions_updated', {
      entityType: 'course', entityId: courseId, entityName: c.title_ru,
      details: { added: addedKeys.size, removed: removedKeys.length, total: map.size, enrolled_existing: enrolled }
    });
    res.json({ ok: true, total: map.size, added: addedKeys.size, removed: removedKeys.length, dropped, enrolled_existing: enrolled, auto_enroll: c.course_kind === 'internal' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* уже закрыто */ }
    res.status(500).json({ error: 'db_error', details: e.message });
  } finally {
    client.release();
  }
});

// ---------- Excel: бланк / текущая матрица ----------
const COL_W = 18;

router.get('/matrix.xlsx', authRequired, ADMIN, async (req, res) => {
  try {
    const mode = req.query.mode === 'blank' ? 'blank' : 'current';
    const rows = await loadStructureRows();
    const courses = (await query(
      `SELECT id, title_ru, course_kind, COALESCE(category_ru, '') AS category_ru
         FROM courses ORDER BY COALESCE(category_ru, ''), title_ru`
    )).rows;
    const marks = new Set();
    if (mode === 'current') {
      (await query('SELECT course_id, key FROM course_positions')).rows.forEach((r) => marks.add(`${r.course_id}|${r.key}`));
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Матрица', { views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }] });
    ws.columns = [
      { header: 'Объект', key: 'o', width: 18 },
      { header: 'Отдел', key: 'd', width: 26 },
      { header: 'Должность', key: 'p', width: 34 },
      ...courses.map((c) => ({ header: c.title_ru, key: 'c' + c.id, width: COL_W }))
    ];
    const head = ws.getRow(1);
    head.height = 96;
    head.font = { bold: true };
    head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    head.eachCell((cell, col) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col <= 3 ? 'FFE2E8F0' : 'FFDBEAFE' } };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });
    ws.getRow(1).getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
    ws.getRow(1).getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
    ws.getRow(1).getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };

    let prevObj = null;
    rows.forEach((r, i) => {
      const rowNum = i + 2;
      const row = ws.getRow(rowNum);
      row.getCell(1).value = r.object;
      row.getCell(2).value = r.department;
      row.getCell(3).value = r.position;
      const k = keyOf(r.object, r.department, r.position);
      courses.forEach((c, ci) => {
        const cell = row.getCell(4 + ci);
        cell.value = marks.has(`${c.id}|${k}`) ? '+' : null;
        cell.alignment = { horizontal: 'center' };
        cell.dataValidation = { type: 'list', allowBlank: true, formulae: ['"+"'], showErrorMessage: false };
      });
      // тонкая линия между объектами, чтобы блоки читались
      if (prevObj !== null && prevObj !== r.object) {
        row.eachCell({ includeEmpty: true }, (cell) => { cell.border = { top: { style: 'medium', color: { argb: 'FF94A3B8' } } }; });
      }
      prevObj = r.object;
    });

    if (rows.length && courses.length) {
      const lastCol = ws.getColumn(3 + courses.length).letter;
      ws.addConditionalFormatting({
        ref: `D2:${lastCol}${rows.length + 1}`,
        rules: [{ type: 'cellIs', operator: 'equal', formulae: ['"+"'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFBBF7D0' } }, font: { bold: true } } }]
      });
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 3 + Math.max(courses.length, 0) } };

    // Лист-инструкция
    const help = wb.addWorksheet('Как заполнять');
    help.columns = [{ width: 4 }, { width: 70 }, { width: 28 }];
    const lines = [
      'Как заполнять матрицу «Курсы по должностям»',
      '1. На листе «Матрица» в строке нужной должности поставьте «+» в колонке курса, который она должна проходить.',
      '2. Пустая ячейка — курс для этой должности не обязателен (если он был привязан ранее, привязка снимется).',
      '3. Названия объектов, отделов, должностей и курсов не меняйте — по ним файл сопоставляется с сайтом.',
      '4. Загрузите файл: Курсы → «Курсы по должностям» → «Загрузить». Сначала нажмите «Проверить» — ничего не сохранится.',
      '5. Новые сотрудники с такой должностью будут автоматически записаны на её курсы.',
      '6. Автозапись работает только для «наших» курсов (с тестом). Внешние курсы и курсы без протокола просто фиксируются как требование к должности.'
    ];
    lines.forEach((t, i) => {
      const row = help.getRow(i + 1);
      row.getCell(2).value = t;
      row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      if (i === 0) row.getCell(2).font = { bold: true, size: 13 };
    });
    const KIND = { internal: 'Наш курс (с тестом)', external: 'Внешний курс', no_protocol: 'Курс без протокола' };
    const start = lines.length + 2;
    help.getRow(start).getCell(2).value = 'Курс';
    help.getRow(start).getCell(3).value = 'Вид курса';
    help.getRow(start).font = { bold: true };
    courses.forEach((c, i) => {
      help.getRow(start + 1 + i).getCell(2).value = c.title_ru;
      help.getRow(start + 1 + i).getCell(3).value = KIND[c.course_kind] || c.course_kind;
    });

    const buf = await wb.xlsx.writeBuffer();
    const fname = mode === 'blank' ? 'kursy_po_dolzhnostyam_blank.xlsx' : 'kursy_po_dolzhnostyam.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('course-positions matrix export:', e);
    res.status(500).json({ error: 'export_failed', message: 'Не удалось сформировать файл: ' + e.message });
  }
});

// ---------- Excel: загрузка ----------
function cellText(cell) {
  let v = cell && cell.value;
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) v = v.richText.map((x) => x.text).join('');
    else if (v.result !== undefined) v = v.result;
    else if (v.text !== undefined) v = v.text;
    else if (v instanceof Date) return '';
  }
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

async function buildPlan(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Матрица') || wb.worksheets[0];
  if (!ws) { const e = new Error('В файле нет листов.'); e.code = 'empty_file'; throw e; }

  // заголовки
  const headerRow = ws.getRow(1);
  const cols = { o: 0, d: 0, p: 0 };
  const courseCols = [];
  const maxCol = Math.max(ws.columnCount, headerRow.cellCount);
  for (let c = 1; c <= maxCol; c++) {
    const h = norm(cellText(headerRow.getCell(c)));
    if (!h) continue;
    if (h === 'объект' && !cols.o) cols.o = c;
    else if ((h === 'отдел' || h === 'подразделение') && !cols.d) cols.d = c;
    else if (h === 'должность' && !cols.p) cols.p = c;
    else courseCols.push({ col: c, title: cellText(headerRow.getCell(c)) });
  }
  if (!cols.o || !cols.d || !cols.p) {
    const e = new Error('В первой строке должны быть колонки «Объект», «Отдел», «Должность». Скачайте бланк и заполните его.');
    e.code = 'bad_header'; throw e;
  }

  // курсы по названию (RU или KZ)
  const allCourses = (await query('SELECT id, title_ru, title_kz, course_kind FROM courses')).rows;
  const byTitle = new Map();
  allCourses.forEach((c) => {
    [c.title_ru, c.title_kz].forEach((t) => {
      const k = norm(t);
      if (!k) return;
      const arr = byTitle.get(k) || [];
      if (!arr.find((x) => x.id === c.id)) arr.push(c);
      byTitle.set(k, arr);
    });
  });

  const errors = [];
  const warnings = [];
  const usedCourses = [];
  courseCols.forEach((cc) => {
    const found = byTitle.get(norm(cc.title)) || [];
    if (found.length === 1) usedCourses.push({ ...cc, course: found[0] });
    else if (found.length > 1) errors.push(`Колонка «${cc.title}»: несколько курсов с таким названием — колонка пропущена.`);
    else errors.push(`Колонка «${cc.title}»: курс с таким названием не найден — колонка пропущена.`);
  });
  if (!usedCourses.length) {
    const e = new Error('В файле не найдено ни одной колонки с названием существующего курса. Скачайте бланк заново — в нём названия курсов заполнены сами.');
    e.code = 'no_courses'; throw e;
  }

  const sIndex = structureIndex(await loadStructureRows());
  // desired: courseId -> Map(key -> {row, plus})
  const desired = new Map(usedCourses.map((u) => [u.course.id, new Map()]));
  const seenRows = new Set();
  let dataRows = 0;
  const last = ws.rowCount;
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r);
    const o = cellText(row.getCell(cols.o));
    const d = cellText(row.getCell(cols.d));
    const p = cellText(row.getCell(cols.p));
    if (!o && !d && !p) continue;
    const k = keyOf(o, d, p);
    const canon = sIndex.get(k);
    if (!canon) {
      errors.push(`Строка ${r}: «${o} / ${d} / ${p}» нет в структуре «Объект → Отдел → Должность» (Настройки) — строка пропущена.`);
      continue;
    }
    if (seenRows.has(k)) { warnings.push(`Строка ${r}: «${p}» (${d}) уже была выше — повтор пропущен.`); continue; }
    seenRows.add(k);
    dataRows += 1;
    usedCourses.forEach((u) => {
      const raw = cellText(row.getCell(u.col));
      let plus = false;
      if (raw) {
        if (PLUS_VALUES.has(raw.toLowerCase())) plus = true;
        else { warnings.push(`Строка ${r}, курс «${u.course.title_ru}»: значение «${raw}» не распознано — ячейка не изменена. Ставьте «+» или оставьте пустой.`); return; }
      }
      desired.get(u.course.id).set(k, { row: canon, plus });
    });
  }

  // разница с текущим состоянием
  const existing = new Map(usedCourses.map((u) => [u.course.id, new Set()]));
  (await query('SELECT course_id, key FROM course_positions WHERE course_id = ANY($1::bigint[])', [usedCourses.map((u) => u.course.id)]))
    .rows.forEach((r) => existing.get(Number(r.course_id)).add(r.key));

  const changes = [];
  usedCourses.forEach((u) => {
    const add = [];
    const remove = [];
    desired.get(u.course.id).forEach((v, k) => {
      const has = existing.get(u.course.id).has(k);
      if (v.plus && !has) add.push({ key: k, ...v.row });
      if (!v.plus && has) remove.push({ key: k, ...v.row });
    });
    if (add.length && u.course.course_kind !== 'internal') {
      warnings.push(`Курс «${u.course.title_ru}» не «наш» (внешний / без протокола): требование к должностям сохранится, но автозапись для него не выполняется.`);
    }
    changes.push({ course: u.course, add, remove });
  });
  return { dataRows, courses: usedCourses.length, errors, warnings, changes };
}

router.post('/matrix/import', authRequired, ADMIN, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не передан.' });
  if (!String(req.file.originalname || '').toLowerCase().endsWith('.xlsx')) {
    return res.status(400).json({ error: 'invalid_format', message: 'Поддерживается только .xlsx. Сохраните файл в Excel как «Книга Excel (.xlsx)».' });
  }
  const dry = req.query.dry === '1' || req.query.dry === 'true';
  const withExisting = req.query.existing === '1' || req.query.existing === 'true';
  let plan;
  try {
    plan = await buildPlan(req.file.buffer);
  } catch (e) {
    if (e.code) return res.status(400).json({ error: e.code, message: e.message });
    console.error('course-positions plan:', e);
    return res.status(500).json({ error: 'import_failed', message: 'Не удалось разобрать файл: ' + e.message });
  }

  const totalAdd = plan.changes.reduce((s, c) => s + c.add.length, 0);
  const totalRemove = plan.changes.reduce((s, c) => s + c.remove.length, 0);
  const summary = {
    rows: plan.dataRows, courses: plan.courses, added: totalAdd, removed: totalRemove,
    errors: plan.errors, warnings: [...new Set(plan.warnings)].slice(0, 100),
    per_course: plan.changes.filter((c) => c.add.length || c.remove.length).map((c) => ({
      course: c.course.title_ru, kind: c.course.course_kind, added: c.add.length, removed: c.remove.length
    }))
  };

  // предпросмотр: сколько работающих сотрудников будет записано (только наши курсы)
  const enrollPreview = [];
  for (const c of plan.changes) {
    if (!c.add.length || c.course.course_kind !== 'internal') continue;
    const cnt = await countWouldEnroll(c.course.id, new Set(c.add.map((a) => a.key)));
    if (cnt.would_enroll) enrollPreview.push({ course: c.course.title_ru, employees: cnt.would_enroll });
  }
  summary.existing_employees = enrollPreview.reduce((s, x) => s + x.employees, 0);
  summary.existing_preview = enrollPreview;

  if (dry) return res.json({ dry: true, ...summary });

  // ---- применяем ----
  const client = await pool.connect();
  const applied = { added: 0, removed: 0, enrolled_existing: 0 };
  try {
    await client.query('BEGIN');
    for (const c of plan.changes) {
      if (c.remove.length) {
        await client.query('DELETE FROM course_positions WHERE course_id = $1 AND key = ANY($2::text[])', [c.course.id, c.remove.map((x) => x.key)]);
        applied.removed += c.remove.length;
      }
      for (const a of c.add) {
        await client.query(
          `INSERT INTO course_positions (course_id, object, department, position, key) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (course_id, key) DO NOTHING`,
          [c.course.id, a.object, a.department, a.position, a.key]
        );
        applied.added += 1;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* уже закрыто */ }
    client.release();
    console.error('course-positions apply:', e);
    return res.status(500).json({ error: 'import_failed', message: 'Не удалось применить файл: ' + e.message });
  }
  client.release();

  if (withExisting) {
    for (const c of plan.changes) {
      if (!c.add.length || c.course.course_kind !== 'internal') continue;
      try {
        const r = await enrollExistingForKeys(c.course.id, new Set(c.add.map((a) => a.key)), req.user.id);
        applied.enrolled_existing += r.created;
      } catch (e) {
        console.error('course-positions enroll existing:', c.course.id, e.message);
        summary.errors.push(`Курс «${c.course.title_ru}»: привязка сохранена, но записать работающих сотрудников не удалось — ${e.message}`);
      }
    }
  }
  await logAction(req, 'course_positions_imported', {
    entityType: 'course', entityName: String(req.file.originalname || ''),
    details: { rows: plan.dataRows, courses: plan.courses, added: applied.added, removed: applied.removed, enrolled_existing: applied.enrolled_existing }
  });
  res.json({ dry: false, ...summary, applied });
});

module.exports = router;
