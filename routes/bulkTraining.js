// МАССОВОЕ ОБНОВЛЕНИЕ ЧЕРЕЗ EXCEL: «выгрузил сотрудников -> внёс новое обучение -> загрузил обратно».
//
//   GET  /api/bulk-training/export          — Excel со всеми (или отфильтрованными) сотрудниками:
//                                             ФИО, объект, отдел, должность, ИИН, № пропуска ТШО + пустые
//                                             колонки нового обучения (Курс, Дата прохождения, № протокола, ...).
//   POST /api/bulk-training/import?dry=1    — «Проверить»: ничего не пишет, возвращает, что будет сделано.
//   POST /api/bulk-training/import          — «Применить»: обновляет карточки, вносит обучение,
//                                             создаёт сертификаты/удостоверения (только для НАШИХ курсов).
//
// Правила по виду курса (courses.course_kind):
//   internal    — наш курс: нужен № протокола; создаются сертификат и удостоверение (как при ручном внесении).
//   external    — обучение провела другая организация: № её протокола необязателен; удостоверения НЕТ,
//                 на странице по QR — «пройден», входит в статистику.
//   no_protocol — курс без протокола: номер не нужен вообще; удостоверения НЕТ, как у external.
//
// Сотрудник ищется по ID из выгрузки (надёжно), а если ID стёрт — по ФИО. Пустая ячейка в колонках карточки
// значит «не менять». Повторная загрузка того же файла безопасна: такое же обучение (сотрудник + курс + дата)
// повторно не вносится.
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeMemoryUploader } = require('../upload');
const { computeFioFields, compareFio } = require('../lib/fio.js');
const { splitMulti } = require('../lib/multiFilter');
const { logAction } = require('../lib/audit');
const { buildHistoricalFields } = require('./assignments');
const { ensureCertificateForAssignment } = require('../certificateService');
const { ensureIdCardForAssignment } = require('../idCardService');
const driveSync = require('../driveSync');

const upload = makeMemoryUploader({ maxSizeMB: 20 });

const KIND_LABEL = { internal: 'Наш курс (с протоколом)', external: 'Внешний курс', no_protocol: 'Курс без протокола' };
const KIND_HINT = {
  internal: 'Нужны Дата прохождения и № протокола. Будут созданы сертификат и удостоверение.',
  external: 'Нужна Дата прохождения. № протокола — номер документа другой организации (можно пусто). Удостоверение не создаётся.',
  no_protocol: 'Нужна только Дата прохождения. Удостоверение не создаётся.'
};

// ---------- разбор ячеек ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function isoFromDate(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function validYear(y) { return y >= 1990 && y <= 2100; }

// Дата из ячейки Excel: настоящая дата, серийное число, «2026-01-15», «15.01.2026», «15/01/2026». Иначе null.
function parseDateCell(v) {
  if (v === undefined || v === null || v === '') return { empty: true };
  let iso = null;
  if (v instanceof Date) {
    if (!Number.isNaN(v.getTime())) iso = isoFromDate(v);
  } else if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (!Number.isNaN(d.getTime())) iso = isoFromDate(d);
  } else {
    const s = String(v).trim();
    if (!s) return { empty: true };
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) iso = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) iso = `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  }
  if (!iso) return { invalid: true };
  const y = Number(iso.slice(0, 4));
  const chk = new Date(iso + 'T00:00:00Z');
  if (!validYear(y) || Number.isNaN(chk.getTime()) || isoFromDate(chk) !== iso) return { invalid: true };
  return { iso };
}

function cellStr(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : isoFromDate(v);
  return String(v).trim();
}

// Заголовок колонки -> ключ поля. Скобки и лишние пробелы не мешают: «ID (не менять)» = «id».
function normHeader(h) {
  return String(h === undefined || h === null ? '' : h).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}
const HEADER_MAP = {
  'id': 'id',
  'фамилия': 'last_name',
  'имя': 'first_name',
  'объект': 'object',
  'отдел': 'department',
  'подразделение': 'department',
  'должность': 'position',
  'иин': 'iin',
  '№ пропуска тшо': 'tco_badge',
  'пропуск тшо': 'tco_badge',
  'логин': 'login',
  'курс': 'course',
  'название курса': 'course',
  'дата прохождения': 'test_date',
  'дата тестирования': 'test_date',
  '№ протокола': 'protocol_number',
  'номер протокола': 'protocol_number',
  'действителен до': 'next_test_date',
  'дата след. прохождения': 'next_test_date',
  'результат %': 'score_percent',
  'балл': 'score_percent'
};
const CARD_FIELDS = ['last_name', 'first_name', 'object', 'department', 'position', 'iin', 'tco_badge'];
const CARD_LABEL = {
  last_name: 'Фамилия', first_name: 'Имя', object: 'Объект', department: 'Отдел',
  position: 'Должность', iin: 'ИИН', tco_badge: '№ пропуска ТШО'
};

// ---------- ВЫГРУЗКА ----------
router.get('/export', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const objects = splitMulti(req.query.object);
    const departments = splitMulti(req.query.department);
    const params = [];
    let sql = `SELECT id, last_name, first_name, object, department, position, iin, tco_badge, login
               FROM users WHERE role = 'employee' AND employment_status = 'active'`;
    if (objects.length) { params.push(objects); sql += ` AND object = ANY($${params.length}::text[])`; }
    if (departments.length) { params.push(departments); sql += ` AND department = ANY($${params.length}::text[])`; }
    sql += ' ORDER BY last_name, first_name';
    const users = (await query(sql, params)).rows;
    const courses = (await query(
      `SELECT id, title_ru, course_kind, validity_months, no_expiry FROM courses ORDER BY title_ru`
    )).rows;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Сотрудники', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }] });
    ws.columns = [
      { header: 'ID (не менять)', key: 'id', width: 10 },
      { header: 'Фамилия', key: 'last_name', width: 20 },
      { header: 'Имя', key: 'first_name', width: 18 },
      { header: 'Объект', key: 'object', width: 18 },
      { header: 'Отдел', key: 'department', width: 20 },
      { header: 'Должность', key: 'position', width: 24 },
      { header: 'ИИН', key: 'iin', width: 15 },
      { header: '№ пропуска ТШО', key: 'tco_badge', width: 16 },
      { header: 'Логин (только чтение)', key: 'login', width: 16 },
      { header: 'Курс', key: 'course', width: 38 },
      { header: 'Дата прохождения', key: 'test_date', width: 18 },
      { header: '№ протокола', key: 'protocol_number', width: 16 },
      { header: 'Действителен до (необязательно)', key: 'next_test_date', width: 20 },
      { header: 'Результат % (необязательно)', key: 'score_percent', width: 16 }
    ];
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.alignment = { vertical: 'middle', wrapText: true };
    head.height = 32;
    // колонки карточки — серые, колонки нового обучения — жёлтые (сюда вносить)
    head.eachCell((cell, col) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col >= 10 ? 'FFFEF3C7' : 'FFE2E8F0' } };
    });
    // ИИН и № пропуска — текстом, чтобы Excel не превращал 12 цифр в 1,23E+11 и не съедал ведущие нули
    ws.getColumn('iin').numFmt = '@';
    ws.getColumn('tco_badge').numFmt = '@';
    ws.getColumn('test_date').numFmt = 'dd.mm.yyyy';
    ws.getColumn('next_test_date').numFmt = 'dd.mm.yyyy';
    users.forEach((u) => {
      const row = ws.addRow({
        id: Number(u.id), last_name: u.last_name, first_name: u.first_name, object: u.object,
        department: u.department, position: u.position, iin: u.iin || '', tco_badge: u.tco_badge || '',
        login: u.login || ''
      });
      [1, 9].forEach((c) => { row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }; });
    });

    // Выпадающий список курсов в колонке «Курс»
    const cs = wb.addWorksheet('Курсы');
    cs.columns = [
      { header: 'Название курса', key: 'title', width: 46 },
      { header: 'Вид', key: 'kind', width: 26 },
      { header: 'Что заполнять', key: 'hint', width: 90 },
      { header: 'Срок действия', key: 'validity', width: 16 }
    ];
    cs.getRow(1).font = { bold: true };
    courses.forEach((c) => {
      const kind = c.course_kind || 'internal';
      cs.addRow({
        title: c.title_ru, kind: KIND_LABEL[kind] || kind, hint: KIND_HINT[kind] || '',
        validity: c.no_expiry ? 'бессрочно' : `${c.validity_months} мес.`
      });
    });
    if (courses.length) {
      // Выпадающий список — по ячейкам (надёжнее диапазона); с запасом строк под копии строк для 2-го и 3-го курса
      const lastRow = Math.min(users.length + 600, 20000);
      const listRef = `'Курсы'!$A$2:$A$${courses.length + 1}`;
      for (let r = 2; r <= lastRow; r += 1) {
        ws.getCell(`J${r}`).dataValidation = { type: 'list', allowBlank: true, showErrorMessage: false, formulae: [listRef] };
      }
    }

    // Справка: что у людей уже внесено (самая свежая сданная запись по каждому курсу)
    const cur = wb.addWorksheet('Текущее обучение (справка)');
    cur.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Сотрудник', key: 'name', width: 30 },
      { header: 'Курс', key: 'course', width: 40 },
      { header: 'Дата прохождения', key: 'test_date', width: 18 },
      { header: 'Действителен до', key: 'next', width: 18 },
      { header: '№ протокола', key: 'prot', width: 16 },
      { header: 'Состояние', key: 'state', width: 14 }
    ];
    cur.getRow(1).font = { bold: true };
    if (users.length) {
      const ids = users.map((u) => u.id);
      const hist = await query(
        `SELECT DISTINCT ON (a.user_id, a.course_id)
                a.user_id, c.title_ru, a.test_date, a.next_test_date, a.protocol_number
           FROM assignments a JOIN courses c ON c.id = a.course_id
          WHERE a.user_id = ANY($1::bigint[]) AND a.status = 'passed'
          ORDER BY a.user_id, a.course_id, COALESCE(a.test_date, '') DESC, a.id DESC`,
        [ids]
      );
      const byId = new Map(users.map((u) => [String(u.id), u]));
      const today = new Date().toISOString().slice(0, 10);
      hist.rows.forEach((h) => {
        const u = byId.get(String(h.user_id));
        if (!u) return;
        const td = cellStr(h.test_date).slice(0, 10);
        const nx = cellStr(h.next_test_date).slice(0, 10);
        cur.addRow({
          id: Number(u.id), name: `${u.last_name} ${u.first_name}`, course: h.title_ru, test_date: td, next: nx || 'бессрочно',
          prot: h.protocol_number || '', state: nx && nx < today ? 'просрочено' : 'действует'
        });
      });
    }

    const notes = wb.addWorksheet('Инструкция');
    notes.columns = [{ key: 'a', width: 120 }];
    [
      'Как обновить обучение сотрудников через Excel:',
      '1. На листе «Сотрудники» у каждого человека — своя строка. Колонки ID и Логин не меняйте.',
      '2. Серые колонки (ФИО, Объект, Отдел, Должность, ИИН, № пропуска ТШО) — данные карточки. Если исправить значение, оно обновится в карточке.',
      '   Пустая ячейка = «не менять» (стереть значение через Excel нельзя).',
      '3. Жёлтые колонки — НОВОЕ обучение. Выберите Курс из списка, укажите Дату прохождения (и № протокола, если курс его требует).',
      '4. Нужно внести двум курсам одному человеку — скопируйте его строку (ID оставьте тем же) и заполните второй курс.',
      '5. «Действителен до» и «Результат %» — по желанию. Если «Действителен до» пусто, срок посчитается по сроку действия курса.',
      '6. Вид курса (лист «Курсы»): наш курс — создаются сертификат и удостоверение; внешний курс и курс без протокола — удостоверение не создаётся,',
      '   но на странице по QR-коду человек отображается как «пройден», и обучение попадает в статистику.',
      '7. Сохраните файл как .xlsx и загрузите на сайте кнопкой «Загрузить обновлённый Excel». Сначала будет проверка (ничего не сохраняется), потом — «Применить».',
      '8. Повторная загрузка того же файла безопасна: одинаковое обучение (сотрудник + курс + дата) второй раз не вносится.',
      '9. Новых сотрудников здесь не добавляйте — для них есть «Импорт из Excel» во вкладке «Сотрудники».'
    ].forEach((l) => notes.addRow([l]));
    notes.getRow(1).font = { bold: true };

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="employees_training_${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('bulk-training export:', e);
    if (!res.headersSent) res.status(500).json({ error: 'export_failed', message: e.message });
  }
});

// ---------- ПЛАН (общий для «Проверить» и «Применить») ----------
async function buildPlan(buffer) {
  let rows;
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames.find((n) => normHeader(n) === 'сотрудники') || wb.SheetNames[0];
    if (!sheetName) throw new Error('empty');
    rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
  } catch (e) {
    const err = new Error('Не удалось прочитать файл. Нужен Excel .xlsx, не повреждённый и без пароля.');
    err.code = 'invalid_file';
    throw err;
  }
  if (!rows.length) { const e = new Error('В файле нет данных.'); e.code = 'empty_file'; throw e; }

  const col = {};
  rows[0].forEach((h, i) => {
    const key = HEADER_MAP[normHeader(h)];
    if (key && !(key in col)) col[key] = i;
  });
  if (!('id' in col) && !('last_name' in col && 'first_name' in col)) {
    const e = new Error('Не найдены колонки ID или Фамилия+Имя. Используйте файл, выгруженный кнопкой «Выгрузить сотрудников в Excel».');
    e.code = 'missing_columns';
    throw e;
  }

  const courseRows = (await query(
    `SELECT id, title_ru, title_kz, course_kind, is_external, validity_months, no_expiry FROM courses`
  )).rows;
  const courseByTitle = new Map();
  courseRows.forEach((c) => {
    [c.title_ru, c.title_kz].forEach((t) => { if (t) courseByTitle.set(String(t).trim().toLowerCase(), c); });
  });
  const dictRow = (await query('SELECT departments_list, positions_list FROM settings WHERE id = 1')).rows[0] || {};
  const knownDeps = new Set((Array.isArray(dictRow.departments_list) ? dictRow.departments_list : []).map(String));
  const knownPos = new Set((Array.isArray(dictRow.positions_list) ? dictRow.positions_list : []).map((p) => String(p && p.ru !== undefined ? p.ru : p)));

  const plan = {
    total_rows: 0, employees: new Map(), trainings: [], errors: [], warnings: [], duplicates: 0, seen: new Set()
  };
  const userCache = new Map(); // id -> строка users

  const findUser = async (id, lastName, firstName) => {
    if (id) {
      if (userCache.has(`id:${id}`)) return userCache.get(`id:${id}`);
      const r = await query(`SELECT * FROM users WHERE id = $1`, [id]);
      const u = r.rows[0] || null;
      userCache.set(`id:${id}`, u);
      return u;
    }
    const { normalized } = computeFioFields(lastName, firstName);
    if (!normalized) return null;
    if (userCache.has(`n:${normalized}`)) return userCache.get(`n:${normalized}`);
    const r = await query(`SELECT * FROM users WHERE role = 'employee' AND full_name_normalized = $1 LIMIT 1`, [normalized]);
    let u = r.rows[0] || null;
    if (!u) {
      // Точного совпадения нет — ищем того же человека в другом написании («Иван Иванов» / «Ivanov Ivan»).
      // Берём только уверенное совпадение и только если оно единственное, чтобы не привязать обучение не к тому.
      const all = (await query(`SELECT * FROM users WHERE role = 'employee'`)).rows;
      const strong = all.filter((x) => compareFio({ last_name: lastName, first_name: firstName }, x) === 'strong');
      if (strong.length === 1) u = strong[0];
    }
    userCache.set(`n:${normalized}`, u);
    return u;
  };

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const rowNum = r + 1;
    const get = (f) => (f in col ? row[col[f]] : '');
    const idRaw = cellStr(get('id'));
    const lastName = cellStr(get('last_name'));
    const firstName = cellStr(get('first_name'));
    const courseTitle = cellStr(get('course'));
    if (!idRaw && !lastName && !firstName && !courseTitle) continue; // пустая строка
    plan.total_rows += 1;

    const idNum = idRaw ? Number(idRaw) : null;
    if (idRaw && !Number.isInteger(idNum)) {
      plan.errors.push(`Строка ${rowNum}: некорректный ID «${idRaw}» — не меняйте колонку ID.`);
      continue;
    }
    const user = await findUser(idNum, lastName, firstName);
    if (!user || user.role !== 'employee') {
      plan.errors.push(`Строка ${rowNum}: сотрудник не найден${idNum ? ` (ID ${idNum})` : ` («${lastName} ${firstName}»)`} — строка пропущена. Новых сотрудников добавляйте через «Импорт из Excel».`);
      continue;
    }
    const uKey = String(user.id);
    if (!plan.employees.has(uKey)) plan.employees.set(uKey, { user, changes: {}, trainings: 0 });
    const emp = plan.employees.get(uKey);

    // --- изменения карточки (пустая ячейка = не менять) ---
    let rowBad = false;
    for (const f of CARD_FIELDS) {
      if (!(f in col)) continue;
      let val = cellStr(get(f));
      if (val === '') continue;
      if (f === 'iin') {
        val = val.replace(/\s+/g, '');
        if (!/^\d{12}$/.test(val)) {
          plan.errors.push(`Строка ${rowNum}: ИИН «${val}» — должно быть ровно 12 цифр (проверьте, что Excel не превратил число в 1,23E+11). Поле не изменено.`);
          continue;
        }
      }
      const cur = user[f] == null ? '' : String(user[f]);
      if (val !== cur) {
        emp.changes[f] = { from: cur, to: val };
        if (f === 'department' && knownDeps.size && !knownDeps.has(val)) plan.warnings.push(`Строка ${rowNum}: отдела «${val}» нет в справочнике (Настройки → Объекты, отделы и должности).`);
        if (f === 'position' && knownPos.size && !knownPos.has(val)) plan.warnings.push(`Строка ${rowNum}: должности «${val}» нет в справочнике.`);
      } else delete emp.changes[f];
    }
    if (('last_name' in emp.changes) || ('first_name' in emp.changes)) {
      const ln = emp.changes.last_name ? emp.changes.last_name.to : user.last_name;
      const fn = emp.changes.first_name ? emp.changes.first_name.to : user.first_name;
      const others = (await query(`SELECT id, last_name, first_name FROM users WHERE role = 'employee' AND id <> $1`, [user.id])).rows;
      const dupRow = others.find((x) => compareFio({ last_name: ln, first_name: fn }, x));
      if (dupRow) {
        plan.errors.push(`Строка ${rowNum}: сотрудник с ФИО «${ln} ${fn}» уже есть в системе («${dupRow.last_name} ${dupRow.first_name}») — ФИО не изменено.`);
        delete emp.changes.last_name; delete emp.changes.first_name;
      }
    }

    // --- новое обучение ---
    if (!courseTitle) continue;
    const course = courseByTitle.get(courseTitle.toLowerCase());
    if (!course) {
      plan.errors.push(`Строка ${rowNum}: курс «${courseTitle}» не найден — выберите название из списка (лист «Курсы»).`);
      continue;
    }
    const kind = course.course_kind || (course.is_external ? 'external' : 'internal');
    const td = parseDateCell(get('test_date'));
    if (td.empty) { plan.errors.push(`Строка ${rowNum}: для курса «${course.title_ru}» не указана Дата прохождения.`); continue; }
    if (td.invalid) { plan.errors.push(`Строка ${rowNum}: Дата прохождения не распознана (пример: 15.01.2026).`); continue; }
    const today = new Date().toISOString().slice(0, 10);
    if (td.iso > today) { plan.errors.push(`Строка ${rowNum}: Дата прохождения ${td.iso} в будущем.`); continue; }

    const protocol = kind === 'no_protocol' ? '' : cellStr(get('protocol_number'));
    if (kind === 'internal' && !protocol) {
      plan.errors.push(`Строка ${rowNum}: для нашего курса «${course.title_ru}» нужен № протокола.`);
      continue;
    }
    const nx = parseDateCell(get('next_test_date'));
    if (nx.invalid) { plan.errors.push(`Строка ${rowNum}: «Действителен до» не распознана (пример: 15.01.2027).`); continue; }
    if (nx.iso && nx.iso < td.iso) { plan.errors.push(`Строка ${rowNum}: «Действителен до» раньше даты прохождения.`); continue; }
    const scoreRaw = cellStr(get('score_percent'));
    let score = null;
    if (scoreRaw !== '') {
      score = Number(String(scoreRaw).replace('%', '').replace(',', '.'));
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        plan.errors.push(`Строка ${rowNum}: «Результат %» должен быть числом от 0 до 100.`);
        continue;
      }
    }

    const dupKey = `${user.id}|${course.id}|${td.iso}`;
    if (plan.seen.has(dupKey)) { plan.duplicates += 1; continue; }
    plan.seen.add(dupKey);
    const exist = await query(
      `SELECT 1 FROM assignments WHERE user_id = $1 AND course_id = $2 AND status = 'passed' AND substr(COALESCE(test_date, ''), 1, 10) = $3 LIMIT 1`,
      [user.id, course.id, td.iso]
    );
    if (exist.rows.length) { plan.duplicates += 1; continue; }

    emp.trainings += 1;
    plan.trainings.push({
      rowNum, userId: user.id, userName: `${user.last_name} ${user.first_name}`.trim(),
      courseId: course.id, courseTitle: course.title_ru, kind, external: kind !== 'internal',
      test_date: td.iso, next_test_date: nx.iso || null, protocol_number: protocol, score_percent: score
    });
  }
  return plan;
}

function summarize(plan) {
  const changed = [...plan.employees.values()].filter((e) => Object.keys(e.changes).length);
  const internal = plan.trainings.filter((t) => t.kind === 'internal').length;
  return {
    total_rows: plan.total_rows,
    employees_matched: plan.employees.size,
    employees_changed: changed.length,
    card_changes: changed.slice(0, 200).map((e) => ({
      name: `${e.user.last_name} ${e.user.first_name}`.trim(),
      fields: Object.entries(e.changes).map(([f, v]) => ({ field: CARD_LABEL[f] || f, from: v.from, to: v.to }))
    })),
    trainings_new: plan.trainings.length,
    trainings_with_card: internal,
    trainings_without_card: plan.trainings.length - internal,
    duplicates_skipped: plan.duplicates,
    trainings_preview: plan.trainings.slice(0, 200).map((t) => ({
      row: t.rowNum, name: t.userName, course: t.courseTitle, kind: t.kind, test_date: t.test_date,
      protocol_number: t.protocol_number, card: t.kind === 'internal'
    })),
    errors: plan.errors,
    warnings: [...new Set(plan.warnings)].slice(0, 100)
  };
}

// ---------- ЗАГРУЗКА ----------
router.post('/import', authRequired, requireRole('admin', 'superadmin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не передан.' });
  if (!String(req.file.originalname || '').toLowerCase().endsWith('.xlsx')) {
    return res.status(400).json({ error: 'invalid_format', message: 'Поддерживается только .xlsx. Сохраните файл в Excel как «Книга Excel (.xlsx)».' });
  }
  const dry = req.query.dry === '1' || req.query.dry === 'true';
  let plan;
  try {
    plan = await buildPlan(req.file.buffer);
  } catch (e) {
    if (e.code) return res.status(400).json({ error: e.code, message: e.message });
    console.error('bulk-training plan:', e);
    return res.status(500).json({ error: 'import_failed', message: 'Не удалось разобрать файл: ' + e.message });
  }
  if (dry) return res.json({ dry: true, ...summarize(plan) });

  // ---- применяем ----
  const applied = { cards_updated: 0, trainings_created: 0, certificates: 0, id_cards: 0, failed: [] };
  const newAssignments = [];
  try {
    for (const emp of plan.employees.values()) {
      const entries = Object.entries(emp.changes);
      if (!entries.length) continue;
      try {
        const sets = [];
        const params = [];
        entries.forEach(([f, v]) => { params.push(f === 'iin' || f === 'tco_badge' ? (v.to || null) : v.to); sets.push(`${f} = $${params.length}`); });
        if (emp.changes.last_name || emp.changes.first_name) {
          const ln = emp.changes.last_name ? emp.changes.last_name.to : emp.user.last_name;
          const fn = emp.changes.first_name ? emp.changes.first_name.to : emp.user.first_name;
          const { normalized, translit } = computeFioFields(ln, fn);
          params.push(normalized); sets.push(`full_name_normalized = $${params.length}`);
          params.push(translit); sets.push(`full_name_translit = $${params.length}`);
        }
        params.push(emp.user.id);
        await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
        applied.cards_updated += 1;
        const changed = {};
        entries.forEach(([f, v]) => { changed[f] = { from: v.from, to: v.to }; });
        await logAction(req, 'user_updated', {
          entityType: 'user', entityId: emp.user.id, entityName: `${emp.user.last_name} ${emp.user.first_name}`.trim(),
          details: { changed, via: 'excel' }
        });
      } catch (e) {
        applied.failed.push(`${emp.user.last_name} ${emp.user.first_name}: карточка не обновлена — ${e.code === '23505' ? 'ИИН/данные уже используются' : e.message}`);
      }
    }

    for (const t of plan.trainings) {
      try {
        // Для внешнего курса и «без протокола» протокол = дата прохождения (как и при ручном внесении)
        const h = await buildHistoricalFields(t.courseId, {
          test_date: t.test_date, next_test_date: t.next_test_date || undefined,
          score_percent: t.score_percent === null ? undefined : t.score_percent
        }, t.userId, t.external);
        const ins = await query(
          `INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by,
             status, score_percent, test_date, next_test_date, certificate_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [t.userId, t.courseId, t.protocol_number, t.test_date, req.user.id,
           h.status, h.score_percent, h.test_date, h.next_test_date, h.certificate_number]
        );
        applied.trainings_created += 1;
        newAssignments.push({ id: ins.rows[0].id, external: t.external });
        await logAction(req, 'course_assigned', {
          entityType: 'user', entityId: t.userId, entityName: t.userName,
          details: { course: t.courseTitle, course_id: t.courseId, protocol_number: t.protocol_number, historical: true, external: t.external, via: 'excel', assignment_id: ins.rows[0].id }
        });
      } catch (e) {
        applied.failed.push(`Строка ${t.rowNum} (${t.userName}, ${t.courseTitle}): обучение не внесено — ${e.message}`);
      }
    }

    // Сертификаты и удостоверения — только по НАШИМ курсам (для внешних и «без протокола» их нет)
    for (const a of newAssignments) {
      if (a.external) continue;
      try { await ensureCertificateForAssignment(a.id); applied.certificates += 1; }
      catch (e) { applied.failed.push(`Сертификат для записи ${a.id} не создан: ${e.message}`); }
      try { await ensureIdCardForAssignment(a.id); applied.id_cards += 1; }
      catch (e) { applied.failed.push(`Удостоверение для записи ${a.id} не создано: ${e.message}`); }
      driveSync.enqueueIdCard(a.id, req);
    }

    await logAction(req, 'training_excel_update', {
      entityType: 'user', entityName: String(req.file.originalname || ''),
      details: {
        rows: plan.total_rows, cards_updated: applied.cards_updated, trainings_created: applied.trainings_created,
        id_cards: applied.id_cards, errors: plan.errors.length + applied.failed.length
      }
    });
    res.json({ dry: false, ...summarize(plan), applied });
  } catch (e) {
    console.error('bulk-training apply:', e);
    res.status(500).json({ error: 'import_failed', message: 'Не удалось применить файл: ' + e.message, applied });
  }
});

module.exports = router;
