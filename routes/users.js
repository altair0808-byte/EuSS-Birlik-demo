const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx'); // для ЧТЕНИЯ загружаемых файлов — заметно терпимее ExcelJS
                               // к файлам, созданным не Microsoft Excel (LibreOffice, Google
                               // Таблицы, openpyxl/Python-выгрузки из 1С и т.п.). Бланк для
                               // скачивания по-прежнему генерируется через ExcelJS ниже.
const { enrollNewUser } = require('../lib/positionCourses');
const { query, pool, restoreExpiredLeaves } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeUploader } = require('../upload');
const { buildHistoricalFields } = require('./assignments');
const { computeFioFields, transliterate, compareFio } = require('../lib/fio.js');
const { splitMulti, scopedFilter } = require('../lib/multiFilter');
const { COMMITTEE_ROLES } = require('../lib/committeeRoles');
const { logAction, fullName } = require('../lib/audit');
const driveSync = require('../driveSync');
const { buildRotationCalendarPdf } = require('../rotationCalendarPdf');

// Защита от дублей: ищет среди ВСЕХ сотрудников (в т.ч. уволенных и в отпуске) того, кто уже
// есть в системе под другим написанием: порядок Ф/И, регистр, русский/английский/казахский,
// ё/е, лишнее отчество, опечатка в 1–2 символа. Объект/отдел/должность не учитываются —
// человек мог перейти в другой отдел. Если у обоих указан ИИН, он решает: одинаковый ИИН —
// это один человек, разный ИИН — разные люди (однофамильцы).
// Возвращает null или { ...сотрудник, level: 'strong' | 'possible', reason }.
//   strong   — почти наверняка тот же человек (создание блокируется);
//   possible — очень похож (админ может подтвердить, что это другой человек).
// excludeId — id сотрудника, которого не нужно считать дублем самого себя (при редактировании).
async function findDuplicateEmployee(lastName, firstName, excludeId, iin) {
  if (!computeFioFields(lastName, firstName).normalized) return null;
  const params = [];
  let sql = `SELECT id, last_name, first_name, object, department, position, active, employment_status, iin
             FROM users WHERE role = 'employee'`;
  if (excludeId) { params.push(excludeId); sql += ` AND id != $${params.length}`; }
  const rows = (await query(sql, params)).rows;
  const cand = { last_name: lastName, first_name: firstName };
  const myIin = iin ? String(iin).trim() : '';
  let strong = null, possible = null;
  for (const row of rows) {
    if (myIin && row.iin) {
      if (row.iin === myIin) return { ...row, level: 'strong', reason: 'iin' };
      continue; // разные ИИН — разные люди, даже если ФИО похожи
    }
    const level = compareFio(cand, row);
    // при нескольких совпадениях показываем в сообщении действующего сотрудника, а не архивного
    if (level === 'strong' && (!strong || (strong.employment_status !== 'active' && row.employment_status === 'active'))) strong = { ...row, level, reason: 'name' };
    if (level === 'possible' && !possible) possible = { ...row, level, reason: 'name' };
  }
  return strong || possible;
}

// Человекочитаемое описание найденного дубля для сообщения об ошибке
function describeDuplicate(dup) {
  const place = [dup.object, dup.department].filter(Boolean).join(' / ');
  const st = dup.employment_status === 'fired' ? 'уволен (в архиве)' : dup.employment_status === 'maternity' ? 'в отпуске (в архиве)' : '';
  const extra = [place, st].filter(Boolean).join(', ');
  return `${dup.last_name} ${dup.first_name}${extra ? ' — ' + extra : ''}`;
}

// Единый ответ на дубль. Возвращает true, если ответ отправлен (операцию нужно прервать).
// «Возможный» дубль админ/суперадмин может пропустить, передав confirm_not_duplicate: true;
// ассистент — нет (обратиться к администратору). «Точный» дубль не пропускается никем.
function rejectDuplicate(req, res, dup) {
  if (!dup) return false;
  const existing = { id: dup.id, last_name: dup.last_name, first_name: dup.first_name, object: dup.object, department: dup.department, position: dup.position, employment_status: dup.employment_status };
  if (dup.level === 'strong') {
    const why = dup.reason === 'iin' ? 'Сотрудник с таким ИИН уже есть в системе' : 'Такой сотрудник уже есть в системе (то же ФИО: порядок слов, регистр, язык написания и отдел не важны)';
    res.status(409).json({ error: 'duplicate_employee', level: 'strong', message: `${why}: ${describeDuplicate(dup)}. Используйте существующую карточку${dup.employment_status !== 'active' ? ' (во вкладке «Архив» её можно восстановить)' : ''}.`, existing_user: existing });
    return true;
  }
  const canConfirm = req.user.role === 'admin' || req.user.role === 'superadmin';
  if (canConfirm && req.body && req.body.confirm_not_duplicate === true) return false;
  res.status(409).json({ error: 'possible_duplicate', level: 'possible', can_confirm: canConfirm, message: `Очень похожий сотрудник уже есть: ${describeDuplicate(dup)}.${canConfirm ? '' : ' Если это действительно другой человек — обратитесь к администратору.'}`, existing_user: existing });
  return true;
}


// Категория сотрудника: обычный сотрудник, специалист или руководитель
const STAFF_CATEGORIES = ['employee', 'specialist', 'manager'];
function normalizeStaffCategory(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (!STAFF_CATEGORIES.includes(s)) throw new Error('invalid_staff_category');
  return s;
}
// Дата YYYY-MM-DD (пустое значение -> null, некорректное -> ошибка)
function normalizeDateOnly(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  const s = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T00:00:00Z').getTime())) throw new Error('invalid_date');
  return s;
}

// ===================== Вахта (заезд / отъезд) =====================
// Вахта хранится в users: rotation_arrival (заезд), rotation_days (срок: 14 / 21 / 28 или любой),
// rotation_departure (отъезд = заезд + срок, можно поправить вручную). Статус «на вахте / дома»
// в БД не хранится — считается на лету по сегодняшней дате (Атырау, UTC+5): с дня заезда по день
// отъезда включительно сотрудник «на вахте», до заезда и после отъезда — «дома».
const ROT_TODAY_SQL = `(NOW() AT TIME ZONE 'Asia/Atyrau')::date`;
// Вахта по графику (заезд … отъезд) и овертайм (с … по) — два независимых признака «на работе».
const ROT_BASE_SQL = `(rotation_arrival IS NOT NULL AND rotation_arrival <= ${ROT_TODAY_SQL} AND (rotation_departure IS NULL OR rotation_departure >= ${ROT_TODAY_SQL}))`;
const OT_ON_SQL = `(overtime_from IS NOT NULL AND overtime_to IS NOT NULL AND overtime_from <= ${ROT_TODAY_SQL} AND overtime_to >= ${ROT_TODAY_SQL})`;
// «На вахте» = на вахте по графику ИЛИ в овертайме
const ROT_ON_SQL = `(${ROT_BASE_SQL} OR ${OT_ON_SQL})`;
const ROTATION_SELECT = `to_char(rotation_arrival, 'YYYY-MM-DD') AS rotation_arrival,
                      rotation_days,
                      to_char(rotation_departure, 'YYYY-MM-DD') AS rotation_departure,
                      CASE WHEN ${ROT_ON_SQL} THEN 'on_shift' WHEN rotation_arrival IS NULL THEN NULL ELSE 'home' END AS rotation_status,
                      CASE WHEN ${ROT_BASE_SQL} AND rotation_departure IS NOT NULL THEN rotation_departure - ${ROT_TODAY_SQL} END AS rotation_days_left,
                      to_char(overtime_from, 'YYYY-MM-DD') AS overtime_from,
                      to_char(overtime_to, 'YYYY-MM-DD') AS overtime_to,
                      ${OT_ON_SQL} AS overtime_active,
                      CASE WHEN rotation_arrival > ${ROT_TODAY_SQL} THEN rotation_arrival - ${ROT_TODAY_SQL} END AS rotation_days_to_arrival`;

function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDaysIso(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// Значение ячейки Excel / строки → 'YYYY-MM-DD' (или null, если пусто). Понимает дату-ячейку Excel,
// число-серийник Excel, «2026-10-01» и «01.10.2026». Некорректное значение → ошибка invalid_date.
function parseRotationDate(v) {
  if (v === undefined || v === null || v === '') return null;
  let d = null;
  if (v instanceof Date) {
    // +12 ч гасит сдвиг часового пояса, с которым библиотека чтения Excel создаёт даты
    d = new Date(v.getTime() + 12 * 3600 * 1000);
  } else if (typeof v === 'number') {
    d = new Date(Math.round((v - 25569) * 86400 * 1000));
  } else {
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    else if ((m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/))) d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    else if (/^\d+(\.\d+)?$/.test(s)) d = new Date(Math.round((Number(s) - 25569) * 86400 * 1000));
  }
  if (!d || isNaN(d.getTime())) throw new Error('invalid_date');
  const iso = d.toISOString().slice(0, 10);
  if (iso < '2000-01-01' || iso > '2100-01-01') throw new Error('invalid_date');
  return iso;
}

// Заезд + срок + отъезд → согласованная тройка. Нет заезда → вахта снимается (все поля null).
// Нет отъезда — считаем заезд + срок; нет срока — считаем по отъезду.
function computeRotation(arrival, days, departure) {
  if (!arrival) return { arrival: null, days: null, departure: null };
  let d = null;
  if (days !== undefined && days !== null && String(days).trim() !== '') {
    d = Number(String(days).trim().replace(',', '.'));
    if (!Number.isInteger(d) || d < 1 || d > 365) throw new Error('invalid_rotation_days');
  }
  let dep = departure || null;
  if (dep && dep < arrival) throw new Error('invalid_rotation_range');
  if (!dep && d) dep = addDaysIso(arrival, d);
  if (!dep) throw new Error('rotation_days_required');
  if (!d) d = Math.max(1, diffDaysIso(arrival, dep));
  return { arrival, days: d, departure: dep };
}

// Овертайм: обе даты пустые → снят; обе заполнены → период «с … по» (по ≥ с); одна дата — ошибка.
function computeOvertime(from, to) {
  if (!from && !to) return { from: null, to: null };
  if (!from || !to) throw new Error('overtime_both_required');
  if (to < from) throw new Error('invalid_overtime_range');
  return { from, to };
}

function rotationErrorMessage(code) {
  switch (code) {
    case 'overtime_both_required': return 'Для овертайма укажите обе даты: «с» и «по»';
    case 'invalid_overtime_range': return 'Овертайм: дата «по» раньше даты «с»';
    case 'invalid_date': return 'Некорректная дата (нужен формат ГГГГ-ММ-ДД или ДД.ММ.ГГГГ)';
    case 'invalid_rotation_days': return 'Срок вахты — целое число дней от 1 до 365 (обычно 14, 21 или 28)';
    case 'invalid_rotation_range': return 'Дата отъезда раньше даты заезда';
    case 'rotation_days_required': return 'Укажите срок вахты (дней) или дату отъезда';
    default: return code;
  }
}

const upload = makeUploader('imports');

// List users (суперадмин скрыт из списка)
// 'assistant' допущен — но видит только сотрудников своей зоны (assistant_objects/departments),
// см. scopedFilter() ниже; если зона не выдана — пустой список (безопасный дефолт).
router.get('/', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const { object, department, q } = req.query;
    // Администраторы не входят в список сотрудников и статистику: по умолчанию отдаём только
    // сотрудников. Список администраторов (?role=admin) — вкладка «Администраторы», только суперадмин.
    // ?role=staff — админы И ассистенты вместе (вкладка «Администраторы и ассистенты»);
    // ?role=admin / ?role=assistant — только одна из этих ролей.
    const roleParam = req.query.role;
    const roles = roleParam === 'staff' ? ['admin', 'assistant']
      : roleParam === 'admin' ? ['admin']
      : roleParam === 'assistant' ? ['assistant']
      : ['employee'];
    if (roles[0] !== 'employee' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'forbidden_role', message: 'Список администраторов и ассистентов доступен только суперадмину' });
    }
    // Кадровый статус: по умолчанию отдаём только действующих сотрудников (employment_status='active'),
    // как и раньше — уволенные/в декрете не должны неожиданно появляться в общем списке и статистике.
    // ?status=archive — вкладка «Архив» (уволены / в декрете). ?status=all — вообще без фильтра.
    // ?statuses=fired,maternity — точечный мульти-выбор конкретных статусов (п.2 запроса,
    // мульти-выбор фильтров) — если передан, имеет приоритет над ?status.
    const statusesParam = splitMulti(req.query.statuses);
    const statusFilter = req.query.status === 'archive' ? 'archive' : (req.query.status === 'all' ? 'all' : 'active');
    await restoreExpiredLeaves();
    let sql = `SELECT id, last_name, first_name, object, department, position, login, role, active,
                      employment_status, to_char(status_date, 'YYYY-MM-DD') AS status_date,
                      to_char(status_date_end, 'YYYY-MM-DD') AS status_date_end,
                      leave_reason, leave_note,
                      staff_category, to_char(hire_date, 'YYYY-MM-DD') AS hire_date,
                      created_at, permanent_certificate_number, tco_badge,
                      committee_role, iin, assistant_objects, assistant_departments,
                      ${ROTATION_SELECT}
               FROM users WHERE role = ANY($1::text[])`;
    const params = [roles];
    if (statusesParam.length) {
      params.push(statusesParam);
      sql += ` AND employment_status = ANY($${params.length}::text[])`;
    } else if (statusFilter === 'active') sql += ` AND employment_status = 'active'`;
    else if (statusFilter === 'archive') sql += ` AND employment_status IN ('fired', 'maternity')`;
    // Объект / отдел / должность — теперь мульти-выбор (п.2 запроса): можно показать сразу
    // несколько объектов, отделов или должностей вместо одного за раз.
    // Для role='assistant' пересекаем выбор пользователя с его зоной (scopedFilter) —
    // если зона не выдана суперадмином, доступа нет, отдаём пустой список без запроса к БД.
    const scope = scopedFilter(req.user, splitMulti(object), splitMulti(department));
    if (scope.noAccess) return res.json([]);
    const objects = scope.objects;
    const departments = scope.departments;
    const positions = splitMulti(req.query.position);
    if (objects.length) { params.push(objects); sql += ` AND object = ANY($${params.length}::text[])`; }
    if (departments.length) { params.push(departments); sql += ` AND department = ANY($${params.length}::text[])`; }
    if (positions.length) { params.push(positions); sql += ` AND position = ANY($${params.length}::text[])`; }
    // Вахта: ?rotation=on_shift (на вахте) | home (дома) | unset (вахта не указана)
    const rotFilter = String(req.query.rotation || '');
    if (rotFilter === 'on_shift') sql += ` AND ${ROT_ON_SQL}`;
    else if (rotFilter === 'home') sql += ` AND rotation_arrival IS NOT NULL AND NOT ${ROT_ON_SQL}`;
    else if (rotFilter === 'unset') sql += ` AND rotation_arrival IS NULL AND NOT ${OT_ON_SQL}`;
    if (q) {
      // Поиск одновременно по русскому написанию и по английской транслитерации
      // (п.9 запроса): "Утяшев", "Altair", "Utyashev", "Алтаир" должны находить
      // одного и того же сотрудника — сравниваем и с обычными полями, и с
      // full_name_translit (латинская транслитерация ФИО).
      params.push(`%${q}%`);
      sql += ` AND (last_name ILIKE $${params.length} OR first_name ILIKE $${params.length}
                     OR login ILIKE $${params.length} OR full_name_translit ILIKE $${params.length}
                     OR full_name_normalized ILIKE $${params.length})`;
    }
    sql += ' ORDER BY last_name, first_name';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) {
    console.error('Error fetching users:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Bulk import from Excel
// Обязательные колонки (шапка, порядок любой): Фамилия, Имя
// Опционально: Объект, Отдел, Должность, Логин, Пароль
// Если Логин не указан — сотрудник создаётся без доступа в систему,
// логин и пароль можно назначить позже через карточку профиля (кнопка "Изменить").
// Опционально (чтобы сразу зафиксировать уже пройденное ранее обучение —
// например, из старого бумажного/Excel-журнала — вместе с созданием сотрудника):
// Курс, № протокола, Дата протокола, Дата прохождения, № сертификата, Действителен до, Результат %
router.post('/import', authRequired, requireRole('admin', 'superadmin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  const originalName = String(req.file.originalname || '').toLowerCase();
  if (!originalName.endsWith('.xlsx')) {
    return res.status(400).json({
      error: 'invalid_format',
      message: 'Поддерживается только формат .xlsx. Откройте файл в Excel и сохраните его как "Книга Excel (.xlsx)", затем загрузите снова.'
    });
  }

  const headerMap = {
    'фамилия': 'last_name',
    'имя': 'first_name',
    'объект': 'object',
    'отдел': 'department',
    'подразделение': 'department',
    'должность': 'position',
    'логин': 'login',
    'табельный номер': 'login',
    'пароль': 'password',
    'курс': 'course',
    'название курса': 'course',
    'номер протокола': 'protocol_number',
    '№ протокола': 'protocol_number',
    'дата протокола': 'protocol_date',
    'дата прохождения': 'test_date',
    'дата тестирования': 'test_date',
    'номер сертификата': 'certificate_number',
    '№ сертификата': 'certificate_number',
    'действителен до': 'next_test_date',
    'дата след. прохождения': 'next_test_date',
    'результат %': 'score_percent',
    'балл': 'score_percent',
    '№ пропуска тшо': 'tco_badge',
    'пропуск тшо': 'tco_badge',
    'tco badge': 'tco_badge',
    // Вахта (необязательно): заезд / срок / отъезд
    'заезд': 'rotation_arrival',
    'дата заезда': 'rotation_arrival',
    'срок вахты': 'rotation_days',
    'срок вахты (дней)': 'rotation_days',
    'отъезд': 'rotation_departure',
    'дата отъезда': 'rotation_departure'
  };

  // Excel хранит даты как объекты Date — приводим к формату YYYY-MM-DD,
  // как их вводят вручную в форме "Назначить тест" (input type="date"),
  // чтобы даты выглядели одинаково независимо от способа ввода.
  function cellToDateStr(cellValue) {
    if (!cellValue) return '';
    if (cellValue instanceof Date) {
      const y = cellValue.getUTCFullYear();
      const m = String(cellValue.getUTCMonth() + 1).padStart(2, '0');
      const d = String(cellValue.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return String(cellValue).trim();
  }

  let sheetRows; // массив строк-массивов, sheetRows[0] — шапка
  try {
    const wb = XLSX.readFile(req.file.path, { cellDates: true, raw: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: 'empty_file', message: 'В файле нет ни одного листа с данными.' });
    const ws = wb.Sheets[sheetName];
    sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  } catch (readErr) {
    console.error('Error reading import file:', readErr);
    return res.status(400).json({
      error: 'invalid_file',
      message: 'Не удалось прочитать файл. Убедитесь, что это корректный Excel-файл (.xlsx), он не повреждён и не защищён паролем.'
    });
  }

  try {
    if (!sheetRows.length) return res.status(400).json({ error: 'empty_file', message: 'В файле нет ни одного листа с данными.' });

    const headerRow = sheetRows[0];
    const colByField = {}; // field -> индекс колонки (0-based)
    headerRow.forEach((cellValue, colIndex) => {
      const key = String(cellValue || '').trim().toLowerCase();
      if (headerMap[key] && !(headerMap[key] in colByField)) colByField[headerMap[key]] = colIndex;
    });
    if (!(colByField.last_name >= 0) || !(colByField.first_name >= 0)) {
      return res.status(400).json({ error: 'missing_columns', message: 'В файле должны быть колонки: Фамилия, Имя (и опционально Объект, Отдел, Должность, Логин, Пароль)' });
    }

    const DATE_FIELDS = new Set(['protocol_date', 'test_date', 'next_test_date']);
    let created = 0, skipped = 0, historyCreated = 0;
    const errors = [];

    for (let r = 1; r < sheetRows.length; r++) {
      const row = sheetRows[r];
      const rowNum = r + 1; // номер строки как в Excel (шапка = строка 1)
      const get = (field) => {
        if (!(field in colByField)) return '';
        const raw = row[colByField[field]];
        return DATE_FIELDS.has(field) ? cellToDateStr(raw) : String(raw ?? '').trim();
      };
      const last_name = get('last_name');
      const first_name = get('first_name');
      const login = get('login') || null; // логин необязателен — можно назначить позже в карточке профиля
      if (!last_name && !first_name && !login) continue; // blank row

      if (!last_name || !first_name) {
        errors.push(`Строка ${rowNum}: не заполнены обязательные поля (Фамилия, Имя)`);
        skipped++;
        continue;
      }

      try {
        if (login) {
          const exists = await query('SELECT id FROM users WHERE login = $1', [login]);
          if (exists.rows.length > 0) {
            errors.push(`Строка ${rowNum}: логин "${login}" уже занят`);
            skipped++;
            continue;
          }
        }

        // Защита от дублей (п.9 запроса): если сотрудник с таким ФИО (без учёта
        // регистра/пробелов, "УТЯШЕВ АЛТАИР" = "Утяшев Алтаир") уже есть в системе,
        // новая запись не создаётся — используется существующий сотрудник, и к нему
        // же, если указано, привязывается историческая запись об обучении из строки.
        const dup = await findDuplicateEmployee(last_name, first_name);
        let userId;
        if (dup && dup.level === 'possible') {
          // Очень похожее ФИО (опечатка / другое написание): автоматически не создаём и не привязываем —
          // в импорте некому подтвердить, что это другой человек. Добавьте вручную в карточке, если это не дубль.
          errors.push(`Строка ${rowNum}: «${last_name} ${first_name}» очень похож на уже существующего: ${describeDuplicate(dup)} — строка пропущена. Если это другой человек, добавьте его вручную.`);
          skipped++;
          continue;
        }
        if (dup) {
          userId = dup.id;
          errors.push(`Строка ${rowNum}: сотрудник "${last_name} ${first_name}" уже есть в системе — новая карточка не создана, используется существующая`);
          skipped++;
        } else {
          // Пароль/хэш нужны только если указан логин — без логина сотрудник
          // просто числится в списке и не может войти в систему до тех пор,
          // пока ему не назначат логин и пароль через карточку профиля.
          const password = login ? (get('password') || Math.random().toString(36).slice(-8)) : null;
          const hash = password ? bcrypt.hashSync(password, 10) : null;
          const { normalized, translit } = computeFioFields(last_name, first_name);
          const userResult = await query(
            `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role, tco_badge, full_name_normalized, full_name_translit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'employee', $8, $9, $10) RETURNING id`,
            [last_name, first_name, get('object'), get('department'), get('position'), login, hash, get('tco_badge') || null, normalized, translit]
          );
          userId = userResult.rows[0].id;
          created++;
          await enrollNewUser(userId, req.user.id);
          // Вахта (если указан заезд): заезд + срок (или отъезд) → карточка сотрудника
          const rawRot = (f) => (f in colByField ? row[colByField[f]] : '');
          if (rawRot('rotation_arrival') !== '' && rawRot('rotation_arrival') != null) {
            try {
              const rot = computeRotation(parseRotationDate(rawRot('rotation_arrival')), rawRot('rotation_days'), parseRotationDate(rawRot('rotation_departure')));
              await query('UPDATE users SET rotation_arrival = $1, rotation_days = $2, rotation_departure = $3 WHERE id = $4',
                [rot.arrival, rot.days, rot.departure, userId]);
            } catch (rotErr) {
              errors.push(`Строка ${rowNum}: сотрудник создан, но вахта не внесена — ${rotationErrorMessage(rotErr.message)}`);
            }
          }
        }

        // Если в строке указан курс — параллельно заносим уже пройденное ранее
        // обучение (протокол + сертификат) как историческую запись, чтобы не
        // вбивать её вручную по каждому сотруднику после импорта.
        const courseTitle = get('course');
        if (courseTitle) {
          const protocol_number = get('protocol_number');
          const protocol_date = get('protocol_date');
          const test_date = get('test_date');

          if (!protocol_number || !protocol_date || !test_date) {
            errors.push(`Строка ${rowNum}: сотрудник создан, но обучение не внесено — для курса "${courseTitle}" нужны № протокола, дата протокола и дата прохождения`);
            continue;
          }

          const cRes = await query(
            `SELECT id FROM courses WHERE lower(title_ru) = lower($1) OR lower(title_kz) = lower($1) LIMIT 1`,
            [courseTitle]
          );
          const course = cRes.rows[0];
          if (!course) {
            errors.push(`Строка ${rowNum}: курс "${courseTitle}" не найден — обучение не внесено`);
            continue;
          }

          try {
            const h = await buildHistoricalFields(course.id, {
              test_date,
              next_test_date: get('next_test_date'),
              certificate_number: get('certificate_number'),
              score_percent: get('score_percent')
            }, userId);
            const histIns = await query(`
              INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, assigned_by,
                status, score_percent, test_date, next_test_date, certificate_number)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
            `, [userId, course.id, protocol_number, protocol_date, req.user.id,
                h.status, h.score_percent, h.test_date, h.next_test_date, h.certificate_number]);
            historyCreated++;
            // Запасное хранилище (Google Drive): удостоверение по внесённому обучению уйдёт в облако в фоне
            driveSync.enqueueIdCard(histIns.rows[0].id, req);
          } catch (histErr) {
            errors.push(`Строка ${rowNum}: сотрудник создан, но не удалось внести обучение — ${histErr.message}`);
          }
        }
      } catch (rowErr) {
        console.error(`Error importing row ${rowNum}:`, rowErr);
        errors.push(`Строка ${rowNum}: не удалось создать сотрудника — ${rowErr.message}`);
        skipped++;
      }
    }

    await logAction(req, 'users_imported', {
      entityType: 'user', entityName: String(req.file.originalname || ''),
      details: { created, skipped, historyCreated, errors: errors.length }
    });
    res.json({ created, skipped, historyCreated, errors });
  } catch (e) {
    console.error('Error importing users:', e);
    res.status(500).json({ error: 'import_failed', message: 'Не удалось выполнить импорт: ' + e.message, details: e.message });
  }
});

// Excel-шаблон (бланк) для массовой загрузки сотрудников
// Должен быть объявлен раньше '/:id', иначе Express примет "import-template.xlsx" за id
router.get('/import-template.xlsx', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const courseRes = await query('SELECT title_ru FROM courses ORDER BY id LIMIT 1');
    const exampleCourse = courseRes.rows[0]?.title_ru || 'Точное название курса из вкладки "Курсы"';

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Сотрудники');
    ws.columns = [
      { header: 'Фамилия', key: 'last_name', width: 20 },
      { header: 'Имя', key: 'first_name', width: 20 },
      { header: 'Объект', key: 'object', width: 20 },
      { header: 'Отдел', key: 'department', width: 20 },
      { header: 'Должность', key: 'position', width: 22 },
      { header: 'Логин', key: 'login', width: 16 },
      { header: 'Пароль', key: 'password', width: 16 },
      { header: 'Курс', key: 'course', width: 32 },
      { header: '№ протокола', key: 'protocol_number', width: 16 },
      { header: 'Дата протокола', key: 'protocol_date', width: 16 },
      { header: 'Дата прохождения', key: 'test_date', width: 18 },
      { header: '№ сертификата', key: 'certificate_number', width: 18 },
      { header: 'Действителен до', key: 'next_test_date', width: 18 },
      { header: 'Результат %', key: 'score_percent', width: 14 },
      { header: 'Заезд', key: 'rotation_arrival', width: 14 },
      { header: 'Срок вахты (дней)', key: 'rotation_days', width: 18 },
      { header: 'Отъезд', key: 'rotation_departure', width: 14 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn('rotation_arrival').numFmt = 'yyyy-mm-dd';
    ws.getColumn('rotation_departure').numFmt = 'yyyy-mm-dd';
    ws.getColumn('protocol_date').numFmt = 'yyyy-mm-dd';
    ws.getColumn('test_date').numFmt = 'yyyy-mm-dd';
    ws.getColumn('next_test_date').numFmt = 'yyyy-mm-dd';
    ws.addRow({
      last_name: 'Иванов', first_name: 'Иван', object: 'Объект 1', department: 'Отдел ОТ',
      position: 'Инженер', login: '', password: '',
      course: '', protocol_number: '', protocol_date: '', test_date: '', certificate_number: '', next_test_date: '', score_percent: '',
      rotation_arrival: '2026-10-01', rotation_days: 14, rotation_departure: ''
    });
    ws.addRow({
      last_name: 'Петрова', first_name: 'Анна', object: 'Объект 2', department: 'Производство',
      position: 'Мастер', login: '10002', password: 'MyPass123',
      course: exampleCourse, protocol_number: '1', protocol_date: '2026-01-15', test_date: '2026-01-15',
      certificate_number: '', next_test_date: '', score_percent: '100'
    });

    const notes = wb.addWorksheet('Инструкция');
    notes.columns = [{ key: 'a', width: 100 }];
    [
      'Инструкция по заполнению файла для массовой загрузки сотрудников:',
      '1. Заполните лист "Сотрудники", по одной строке на каждого сотрудника.',
      '2. Обязательные колонки: Фамилия, Имя.',
      '3. Колонки Объект, Отдел, Должность, Логин, Пароль — необязательные.',
      '3а. Логин (или табельный номер), если указан, должен быть уникальным. Если оставить его пустым,',
      '    сотрудник будет создан только по ФИО, без доступа в систему — логин и пароль можно будет',
      '    назначить позже на вкладке "Сотрудники" кнопкой "Изменить" у нужного сотрудника.',
      '4. Если логин указан, а колонка "Пароль" оставлена пустой, система сгенерирует случайный пароль автоматически.',
      '5. Все загруженные сотрудники получают роль "Сотрудник" (employee).',
      '',
      'Колонки Курс / № протокола / Дата протокола / Дата прохождения / № сертификата / Действителен до / Результат %',
      'нужны только если у сотрудника уже ЕСТЬ пройденное ранее обучение (например, из бумажного или',
      'старого Excel-журнала), и вы хотите сразу занести его вместе с созданием сотрудника — иначе',
      'оставьте эти колонки пустыми, обучение можно будет назначить или внести позже вручную.',
      '6. Колонка "Курс" — точное название курса, как оно указано во вкладке "Курсы" (регистр не важен).',
      '7. Если заполнена колонка "Курс", обязательно заполните и № протокола, Дату протокола, Дату прохождения.',
      '8. № сертификата можно оставить пустым — он будет присвоен автоматически по текущей нумерации из',
      '   вкладки "Настройки". Действителен до — тоже необязательно, рассчитывается автоматически по сроку',
      '   действия курса и дате прохождения. Результат % по умолчанию — 100.',
      '9. Даты указывайте в формате ГГГГ-ММ-ДД (например, 2026-01-15) либо как дату в ячейке Excel.',
      '10. Такому сотруднику обучение будет сразу отмечено как пройденное — статус "СДАЛ", без прохождения теста в системе.',
      '11. Удалите строки-примеры перед загрузкой своего списка.',
      '12. Загрузите готовый файл на вкладке "Сотрудники" кнопкой "Импорт из Excel (.xlsx)".',
      '',
      'Колонки Заезд / Срок вахты (дней) / Отъезд — необязательные (вахтовый метод). Заезд — дата заезда на вахту,',
      'срок обычно 14, 21 или 28 дней; Отъезд, если пусто, считается как Заезд + Срок. Для уже существующих',
      'сотрудников вахту удобнее загружать отдельным файлом — кнопка "Бланк вахты" / "Загрузить вахту".'
    ].forEach(line => notes.addRow([line]));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="users_import_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: 'template_failed', details: e.message });
  }
});

// ===================== ВАХТА: выгрузка, бланк, массовая загрузка, ручной ввод =====================
// Все маршруты /rotations/* объявлены раньше '/:id', иначе Express примет «rotations» за id.

// Строки для выгрузки: действующие сотрудники с учётом фильтров (объект / отдел / должность / вахта / поиск)
// и зоны ассистента.
async function fetchRotationRows(req) {
  const scope = scopedFilter(req.user, splitMulti(req.query.object), splitMulti(req.query.department));
  if (scope.noAccess) return [];
  const positions = splitMulti(req.query.position);
  const params = [];
  let sql = `SELECT last_name, first_name, iin, object, department, position, ${ROTATION_SELECT}
             FROM users WHERE role = 'employee' AND employment_status = 'active'`;
  if (scope.objects.length) { params.push(scope.objects); sql += ` AND object = ANY($${params.length}::text[])`; }
  if (scope.departments.length) { params.push(scope.departments); sql += ` AND department = ANY($${params.length}::text[])`; }
  if (positions.length) { params.push(positions); sql += ` AND position = ANY($${params.length}::text[])`; }
  const rotFilter = String(req.query.rotation || '');
  if (rotFilter === 'on_shift') sql += ` AND ${ROT_ON_SQL}`;
  else if (rotFilter === 'home') sql += ` AND rotation_arrival IS NOT NULL AND NOT ${ROT_ON_SQL}`;
  else if (rotFilter === 'unset') sql += ` AND rotation_arrival IS NULL AND NOT ${OT_ON_SQL}`;
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    sql += ` AND (last_name ILIKE $${params.length} OR first_name ILIKE $${params.length}
                  OR full_name_translit ILIKE $${params.length} OR full_name_normalized ILIKE $${params.length})`;
  }
  sql += ' ORDER BY object, department, last_name, first_name';
  return (await query(sql, params)).rows;
}

const ROT_STATUS_TEXT = { on_shift: '👷 На вахте', home: '🏠 Дома' };
function isoToExcelDate(iso) { return iso ? new Date(iso + 'T00:00:00Z') : null; }

// Выгрузка в Excel: кто когда заезжает / уезжает и кто сейчас на работе. Файл можно отредактировать
// (колонки «Заезд», «Срок вахты», «Отъезд») и загрузить обратно кнопкой «Загрузить вахту».
router.get('/rotations/export.xlsx', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const rows = await fetchRotationRows(req);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Вахта');
    ws.columns = [
      { header: '№', key: 'n', width: 5 },
      { header: 'Фамилия', key: 'last_name', width: 20 },
      { header: 'Имя', key: 'first_name', width: 18 },
      { header: 'ИИН', key: 'iin', width: 15 },
      { header: 'Объект', key: 'object', width: 18 },
      { header: 'Отдел', key: 'department', width: 22 },
      { header: 'Должность', key: 'position', width: 24 },
      { header: 'Статус', key: 'status', width: 15 },
      { header: 'Заезд', key: 'arrival', width: 13 },
      { header: 'Срок вахты (дней)', key: 'days', width: 13 },
      { header: 'Отъезд', key: 'departure', width: 13 },
      { header: 'Овертайм с', key: 'ot_from', width: 13 },
      { header: 'Овертайм по', key: 'ot_to', width: 13 },
      { header: 'Осталось на вахте (дн.)', key: 'left', width: 16 },
      { header: 'До заезда (дн.)', key: 'to_arrival', width: 14 }
    ];
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.alignment = { vertical: 'middle', wrapText: true };
    head.height = 32;
    head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; });
    ws.getColumn('arrival').numFmt = 'dd.mm.yyyy';
    ws.getColumn('departure').numFmt = 'dd.mm.yyyy';
    ws.getColumn('ot_from').numFmt = 'dd.mm.yyyy';
    ws.getColumn('ot_to').numFmt = 'dd.mm.yyyy';
    ws.getColumn('iin').numFmt = '@';
    rows.forEach((u, i) => {
      const row = ws.addRow({
        n: i + 1, last_name: u.last_name, first_name: u.first_name, iin: u.iin || '',
        object: u.object || '', department: u.department || '', position: u.position || '',
        status: ROT_STATUS_TEXT[u.rotation_status] || 'Не указано',
        arrival: isoToExcelDate(u.rotation_arrival), days: u.rotation_days || null,
        departure: isoToExcelDate(u.rotation_departure),
        ot_from: isoToExcelDate(u.overtime_from), ot_to: isoToExcelDate(u.overtime_to),
        left: u.rotation_days_left, to_arrival: u.rotation_days_to_arrival
      });
      const cell = row.getCell('status');
      if (u.rotation_status === 'on_shift') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      else if (u.rotation_status === 'home') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 15 } };

    // Сводка по отделам: сколько человек сейчас на вахте / дома / не указано
    const sum = wb.addWorksheet('Сводка');
    sum.columns = [
      { header: 'Объект', key: 'o', width: 20 }, { header: 'Отдел', key: 'd', width: 26 },
      { header: '👷 На вахте', key: 'on', width: 14 }, { header: '🏠 Дома', key: 'home', width: 12 },
      { header: 'Не указано', key: 'unset', width: 13 }, { header: 'Всего', key: 'all', width: 10 }
    ];
    sum.getRow(1).font = { bold: true };
    const groups = new Map();
    rows.forEach(u => {
      const k = (u.object || '—') + '\u0000' + (u.department || '—');
      if (!groups.has(k)) groups.set(k, { o: u.object || '—', d: u.department || '—', on: 0, home: 0, unset: 0, all: 0 });
      const g = groups.get(k);
      if (u.rotation_status === 'on_shift') g.on++; else if (u.rotation_status === 'home') g.home++; else g.unset++;
      g.all++;
    });
    const tot = { o: 'ИТОГО', d: '', on: 0, home: 0, unset: 0, all: 0 };
    [...groups.values()].forEach(g => { sum.addRow(g); tot.on += g.on; tot.home += g.home; tot.unset += g.unset; tot.all += g.all; });
    sum.addRow(tot).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="rotation.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Error exporting rotations:', e);
    res.status(500).json({ error: 'export_failed', message: 'Не удалось сформировать файл: ' + e.message, details: e.message });
  }
});

// Бланк для массовой загрузки вахты
router.get('/rotations/template.xlsx', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Вахта');
    ws.columns = [
      { header: 'Фамилия', key: 'last_name', width: 20 },
      { header: 'Имя', key: 'first_name', width: 18 },
      { header: 'ИИН', key: 'iin', width: 15 },
      { header: 'Заезд', key: 'arrival', width: 14 },
      { header: 'Срок вахты (дней)', key: 'days', width: 18 },
      { header: 'Отъезд', key: 'departure', width: 14 },
      { header: 'Овертайм с', key: 'ot_from', width: 14 },
      { header: 'Овертайм по', key: 'ot_to', width: 14 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn('iin').numFmt = '@';
    ws.getColumn('arrival').numFmt = 'dd.mm.yyyy';
    ws.getColumn('departure').numFmt = 'dd.mm.yyyy';
    ws.getColumn('ot_from').numFmt = 'dd.mm.yyyy';
    ws.getColumn('ot_to').numFmt = 'dd.mm.yyyy';
    ws.addRow({ last_name: 'Иванов', first_name: 'Иван', iin: '', arrival: new Date(Date.UTC(2026, 9, 1)), days: 14, departure: null });
    ws.addRow({ last_name: 'Петров', first_name: 'Пётр', iin: '', arrival: new Date(Date.UTC(2026, 9, 5)), days: 28, departure: null });
    ws.dataValidations.add('E2:E2000', { type: 'list', allowBlank: true, formulae: ['"14,21,28"'], showErrorMessage: false });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const notes = wb.addWorksheet('Инструкция');
    notes.columns = [{ key: 'a', width: 110 }];
    [
      'Инструкция по заполнению файла «Вахта»:',
      '1. Одна строка — один сотрудник. Сотрудник должен уже быть в системе (во вкладке «Сотрудники»).',
      '2. Сотрудник ищется по ИИН (если указан), иначе по Фамилии и Имени.',
      '3. Заезд — дата заезда на вахту (например, 01.10.2026 или 2026-10-01).',
      '4. Срок вахты (дней) — обычно 14, 21 или 28. Можно указать любое число от 1 до 365.',
      '5. Отъезд — необязательно: если пусто, считается Заезд + Срок вахты. Если указать и срок, и отъезд — берутся оба как есть.',
      '   Если указан только Отъезд (без срока) — срок посчитается сам.',
      '6. С даты заезда по дату отъезда включительно сотрудник отображается «на вахте» (👷), в остальное время — «дома» (🏠).',
      '7. Строки с пустой датой заезда и пустым овертаймом пропускаются — в системе у этих сотрудников ничего не меняется.',
      '8. Загрузите готовый файл во вкладке «Сотрудники» кнопкой «Загрузить вахту».',
      '9. Удобнее всего: нажмите «Выгрузить вахту», впишите даты в нужные строки и загрузите этот же файл обратно.',
      '10. Овертайм — если сотрудника оставили на несколько дней сверх вахты: впишите «Овертайм с» и «Овертайм по» (обе даты, включительно). Часы не нужны.',
      '    Пока сегодняшняя дата внутри периода овертайма, сотрудник отображается «на вахте» (👷), даже если вахта по графику уже закончилась.',
      '    Овертайм можно заполнять и без даты заезда. Пустые ячейки овертайма ничего не меняют (снять овертайм можно в списке сотрудников).',
      '11. Удалите строки-примеры (Иванов, Петров) перед загрузкой.'
    ].forEach(line => notes.addRow([line]));
    notes.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="rotation_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: 'template_failed', details: e.message });
  }
});

// Массовая загрузка вахты из Excel (файл из «Выгрузить вахту» или чистый бланк).
// Админ/суперадмин — любые сотрудники; ассистент — только сотрудники своей зоны.
router.post('/rotations/import', authRequired, requireRole('admin', 'assistant', 'superadmin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
  if (!String(req.file.originalname || '').toLowerCase().endsWith('.xlsx')) {
    return res.status(400).json({ error: 'invalid_format', message: 'Поддерживается только формат .xlsx. Откройте файл в Excel и сохраните как «Книга Excel (.xlsx)».' });
  }
  const headerMap = {
    'фамилия': 'last_name', 'имя': 'first_name', 'иин': 'iin',
    'заезд': 'arrival', 'дата заезда': 'arrival', 'приезд': 'arrival', 'дата приезда': 'arrival',
    'срок вахты': 'days', 'срок вахты (дней)': 'days', 'срок': 'days', 'дней': 'days', 'вахта (дней)': 'days',
    'отъезд': 'departure', 'дата отъезда': 'departure', 'выезд': 'departure',
    'овертайм с': 'ot_from', 'овертайм от': 'ot_from', 'овертайм начало': 'ot_from',
    'овертайм по': 'ot_to', 'овертайм до': 'ot_to', 'овертайм конец': 'ot_to'
  };
  let sheetRows;
  try {
    const wb = XLSX.readFile(req.file.path, { cellDates: true, raw: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: 'empty_file', message: 'В файле нет ни одного листа с данными.' });
    sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
  } catch (readErr) {
    console.error('Error reading rotations file:', readErr);
    return res.status(400).json({ error: 'invalid_file', message: 'Не удалось прочитать файл. Убедитесь, что это корректный .xlsx без пароля.' });
  }
  try {
    if (!sheetRows.length) return res.status(400).json({ error: 'empty_file', message: 'В файле нет данных.' });
    const col = {};
    sheetRows[0].forEach((v, i) => {
      const key = String(v || '').trim().toLowerCase();
      if (headerMap[key] && !(headerMap[key] in col)) col[headerMap[key]] = i;
    });
    const hasName = col.last_name >= 0 && col.first_name >= 0;
    if (!(col.arrival >= 0 || col.ot_from >= 0 || col.ot_to >= 0) || (!hasName && !(col.iin >= 0))) {
      return res.status(400).json({ error: 'missing_columns', message: 'В файле должны быть колонки: Фамилия, Имя (или ИИН) и Заезд (или Овертайм с / по). Также: Срок вахты (дней), Отъезд. Скачайте бланк кнопкой «Бланк вахты».' });
    }
    const raw = (row, f) => (f in col ? row[col[f]] : '');
    const txt = (row, f) => String(raw(row, f) ?? '').trim();

    let updated = 0, emptyRows = 0;
    const errors = [];
    for (let r = 1; r < sheetRows.length; r++) {
      const row = sheetRows[r];
      const rowNum = r + 1;
      const last_name = txt(row, 'last_name'), first_name = txt(row, 'first_name'), iin = txt(row, 'iin').replace(/\s+/g, '');
      if (!last_name && !first_name && !iin) continue;
      const label = `${last_name} ${first_name}`.trim() || `ИИН ${iin}`;
      try {
        const isBlank = f => raw(row, f) === '' || raw(row, f) === null || raw(row, f) === undefined || String(raw(row, f)).trim() === '';
        const hasRot = !isBlank('arrival');
        const hasOt = !isBlank('ot_from') || !isBlank('ot_to');
        if (!hasRot && !hasOt) { emptyRows++; continue; }
        const rot = hasRot ? computeRotation(parseRotationDate(raw(row, 'arrival')), raw(row, 'days'), parseRotationDate(raw(row, 'departure'))) : null;
        const ot = hasOt ? computeOvertime(parseRotationDate(raw(row, 'ot_from')), parseRotationDate(raw(row, 'ot_to'))) : null;

        let found = [];
        if (iin) found = (await query(`SELECT * FROM users WHERE role = 'employee' AND iin = $1`, [iin])).rows;
        if (!found.length && last_name && first_name) {
          const norm = computeFioFields(last_name, first_name).normalized;
          if (norm) found = (await query(`SELECT * FROM users WHERE role = 'employee' AND full_name_normalized = $1`, [norm])).rows;
        }
        if (found.length > 1) {
          const act = found.filter(u => u.employment_status === 'active');
          if (act.length === 1) found = act;
        }
        if (!found.length) { errors.push(`Строка ${rowNum}: сотрудник «${label}» не найден в системе`); continue; }
        if (found.length > 1) { errors.push(`Строка ${rowNum}: найдено несколько сотрудников «${label}» — укажите ИИН`); continue; }
        const target = found[0];
        if (!isInAssistantScope(req.user, target)) { errors.push(`Строка ${rowNum}: «${label}» вне вашей зоны доступа`); continue; }

        if (rot) {
          await query(
            `UPDATE users SET rotation_arrival = $1, rotation_days = $2, rotation_departure = $3 WHERE id = $4`,
            [rot.arrival, rot.days, rot.departure, target.id]
          );
        }
        if (ot) {
          await query(`UPDATE users SET overtime_from = $1, overtime_to = $2 WHERE id = $3`, [ot.from, ot.to, target.id]);
        }
        updated++;
      } catch (rowErr) {
        errors.push(`Строка ${rowNum}: ${rotationErrorMessage(rowErr.message)}`);
      }
    }
    await logAction(req, 'rotations_imported', {
      entityType: 'user', entityName: String(req.file.originalname || ''),
      details: { updated, empty: emptyRows, errors: errors.length }
    });
    res.json({ updated, emptyRows, errors });
  } catch (e) {
    console.error('Error importing rotations:', e);
    res.status(500).json({ error: 'import_failed', message: 'Не удалось выполнить загрузку: ' + e.message, details: e.message });
  }
});

// Вахта одного сотрудника: заезд / срок / отъезд (из карточки профиля или из списка).
// Пустой заезд снимает вахту. Ассистент — только сотрудников своей зоны.
router.patch('/:id/rotation', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  let rot;
  try {
    rot = computeRotation(
      parseRotationDate(req.body.rotation_arrival),
      req.body.rotation_days,
      parseRotationDate(req.body.rotation_departure)
    );
  } catch (e) {
    return res.status(400).json({ error: e.message, message: rotationErrorMessage(e.message) });
  }
  try {
    const target = (await query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role !== 'employee') {
      return res.status(400).json({ error: 'not_employee', message: 'Вахта указывается только для сотрудников' });
    }
    if (!isInAssistantScope(req.user, target)) {
      return res.status(403).json({ error: 'forbidden', message: 'Сотрудник вне вашей зоны доступа' });
    }
    await query(
      `UPDATE users SET rotation_arrival = $1, rotation_days = $2, rotation_departure = $3 WHERE id = $4`,
      [rot.arrival, rot.days, rot.departure, id]
    );
    await logAction(req, 'rotation_set', {
      entityType: 'user', entityId: id, entityName: fullName(target),
      details: { arrival: rot.arrival, days: rot.days, departure: rot.departure }
    });
    const out = (await query(`SELECT ${ROTATION_SELECT} FROM users WHERE id = $1`, [id])).rows[0];
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('Error saving rotation:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Овертайм сотрудника: период «с … по» (без часов). Пока сегодня внутри периода — сотрудник «на вахте».
// Пустые обе даты снимают овертайм. Ассистент — только сотрудников своей зоны.
router.patch('/:id/overtime', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  let ot;
  try {
    ot = computeOvertime(parseRotationDate(req.body.overtime_from), parseRotationDate(req.body.overtime_to));
  } catch (e) {
    return res.status(400).json({ error: e.message, message: rotationErrorMessage(e.message) });
  }
  try {
    const target = (await query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role !== 'employee') {
      return res.status(400).json({ error: 'not_employee', message: 'Овертайм указывается только для сотрудников' });
    }
    if (!isInAssistantScope(req.user, target)) {
      return res.status(403).json({ error: 'forbidden', message: 'Сотрудник вне вашей зоны доступа' });
    }
    await query(`UPDATE users SET overtime_from = $1, overtime_to = $2 WHERE id = $3`, [ot.from, ot.to, id]);
    await logAction(req, 'overtime_set', {
      entityType: 'user', entityId: id, entityName: fullName(target),
      details: { from: ot.from, to: ot.to }
    });
    const out = (await query(`SELECT ${ROTATION_SELECT} FROM users WHERE id = $1`, [id])).rows[0];
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('Error saving overtime:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Календарь вахты сотрудника на год (PDF: логотип компании, ФИ, 12 месяцев, таблица смен).
// Расписание = повтор цикла «вахта (заезд … отъезд) → дома N дней». Берётся сохранённая вахта сотрудника;
// из окна «Вахта» можно передать ещё не сохранённые arrival / days / departure.
// Параметры: rest — дней дома между вахтами (по умолчанию = срок вахты), start — месяц начала (ГГГГ-ММ[-ДД],
// по умолчанию текущий), lang — ru | kz.
router.get('/:id/rotation-calendar.pdf', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id', message: 'Некорректный сотрудник' });
  try {
    const target = (await query(
      `SELECT id, role, last_name, first_name, object, department,
              to_char(rotation_arrival, 'YYYY-MM-DD') AS rotation_arrival, rotation_days,
              to_char(rotation_departure, 'YYYY-MM-DD') AS rotation_departure
       FROM users WHERE id = $1`, [id])).rows[0];
    if (!target || target.role !== 'employee') return res.status(404).json({ error: 'not_found', message: 'Сотрудник не найден' });
    if (!isInAssistantScope(req.user, target)) return res.status(403).json({ error: 'forbidden', message: 'Сотрудник вне вашей зоны доступа' });

    let rot;
    try {
      const q = req.query;
      if (q.arrival) {
        rot = computeRotation(parseRotationDate(q.arrival), q.days, parseRotationDate(q.departure));
      } else {
        rot = computeRotation(target.rotation_arrival, target.rotation_days, target.rotation_departure);
      }
    } catch (e) {
      return res.status(400).json({ error: e.message, message: rotationErrorMessage(e.message) });
    }
    if (!rot.arrival) {
      return res.status(400).json({ error: 'rotation_not_set', message: 'У сотрудника не указана вахта — сначала внесите дату заезда и срок' });
    }

    let restDays = rot.days;
    if (req.query.rest !== undefined && String(req.query.rest).trim() !== '') {
      restDays = Number(String(req.query.rest).trim());
      if (!Number.isInteger(restDays) || restDays < 1 || restDays > 365) {
        return res.status(400).json({ error: 'invalid_rest_days', message: 'Дней дома между вахтами — целое число от 1 до 365' });
      }
    }

    const todayIso = (await query(`SELECT to_char(${ROT_TODAY_SQL}, 'YYYY-MM-DD') AS d`)).rows[0].d;
    let startIso = todayIso.slice(0, 7) + '-01';
    if (req.query.start) {
      const m = String(req.query.start).match(/^(\d{4})-(\d{2})/);
      if (!m || +m[2] < 1 || +m[2] > 12 || +m[1] < 2000 || +m[1] > 2100) {
        return res.status(400).json({ error: 'invalid_start', message: 'Некорректный месяц начала периода' });
      }
      startIso = `${m[1]}-${m[2]}-01`;
    }

    const settings = (await query('SELECT company_name, logo_path, logo_data FROM settings WHERE id = 1')).rows[0] || {};
    const pdf = await buildRotationCalendarPdf(
      { last_name: target.last_name, first_name: target.first_name },
      rot, settings,
      { restDays, startIso, todayIso, lang: req.query.lang === 'kz' ? 'kz' : 'ru' }
    );
    const safe = `${target.last_name}_${target.first_name}`.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rotation_calendar.pdf"; filename*=UTF-8''${encodeURIComponent('Вахта_' + safe + '.pdf')}`);
    res.send(pdf);
  } catch (e) {
    console.error('Error building rotation calendar:', e);
    res.status(500).json({ error: 'calendar_failed', message: 'Не удалось сформировать календарь: ' + e.message, details: e.message });
  }
});

// Meta
router.get('/meta/objects', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const objRes = await query(`SELECT DISTINCT object FROM users WHERE object != '' AND role = 'employee' ORDER BY object`);
    const depRes = await query(`SELECT DISTINCT department FROM users WHERE department != '' AND role = 'employee' ORDER BY department`);
    // pairs — реальные сочетания «объект → отдел», чтобы в фильтре список отделов
    // сужался после выбора объекта (единый фильтр по объекту/отделу на всех вкладках).
    const pairRes = await query(`SELECT DISTINCT object, department FROM users WHERE role = 'employee' AND (object != '' OR department != '')`);
    let objects = objRes.rows.map(r => r.object);
    let departments = depRes.rows.map(r => r.department);
    let pairs = pairRes.rows;
    // Ассистент видит в фильтре только объекты/отделы своей зоны.
    if (req.user.role === 'assistant') {
      const zoneObjects = Array.isArray(req.user.assistant_objects) ? req.user.assistant_objects : [];
      const zoneDepartments = Array.isArray(req.user.assistant_departments) ? req.user.assistant_departments : [];
      if (!zoneObjects.length && !zoneDepartments.length) {
        return res.json({ objects: [], departments: [], pairs: [] });
      }
      pairs = pairs.filter(p => isInAssistantScope(req.user, p));
      objects = [...new Set(pairs.map(p => p.object).filter(Boolean))].sort();
      departments = [...new Set(pairs.map(p => p.department).filter(Boolean))].sort();
    }
    res.json({ objects, departments, pairs });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Свои данные о работе в компании (для дашборда сотрудника): дата начала работы и категория.
// Должен быть раньше '/:id', иначе 'me' будет принят за id.
router.get('/me/work', authRequired, async (req, res) => {
  try {
    const r = await query(
      `SELECT to_char(hire_date, 'YYYY-MM-DD') AS hire_date, staff_category FROM users WHERE id = $1`,
      [req.user.id]
    );
    const row = r.rows[0] || {};
    res.setHeader('Cache-Control', 'no-store');
    res.json({ hire_date: row.hire_date || null, staff_category: row.staff_category || 'employee' });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Get single user (профиль сотрудника) — должен быть после /meta/objects, чтобы не перехватывать его
router.get('/:id', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  try {
    const result = await query(
      `SELECT id, last_name, first_name, object, department, position, login, role, active,
              employment_status, to_char(status_date, 'YYYY-MM-DD') AS status_date,
              to_char(status_date_end, 'YYYY-MM-DD') AS status_date_end,
              leave_reason, leave_note,
              staff_category, to_char(hire_date, 'YYYY-MM-DD') AS hire_date,
              created_at, permanent_certificate_number, tco_badge,
              committee_role, iin, public_uid, assistant_objects, assistant_departments,
              ${ROTATION_SELECT}
       FROM users WHERE id = $1 AND role != 'superadmin'`,
      [req.params.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'not_found' });
    if (!isInAssistantScope(req.user, user)) {
      return res.status(403).json({ error: 'forbidden', message: 'Сотрудник вне вашей зоны доступа' });
    }
    res.json(user);
  } catch (e) {
    console.error('Error fetching user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Кадровый статус сотрудника: уволен / в отпуске / вернуть в штат (вкладка «Архив»).
// Отдельный лёгкий эндпоинт — вызывается прямо из списка сотрудников/архива одной кнопкой,
// без открытия полной формы редактирования. Доступен только для role='employee' —
// у администраторов такого статуса нет.
// Администратор и суперадмин — для любого сотрудника; ассистент — только для сотрудников
// своей зоны (объекты/отделы). Значение 'maternity' сохранено для совместимости со старыми
// данными: в интерфейсе это «Отпуск», а причина хранится в leave_reason.
const EMPLOYMENT_STATUSES = ['active', 'fired', 'maternity'];
// Может ли ассистент возвращать сотрудников из архива в штат (false — только админ/суперадмин)
const ASSISTANT_CAN_RESTORE = true;
const LEAVE_REASONS = ['sick', 'maternity', 'childcare', 'annual', 'unpaid', 'study', 'other'];
router.patch('/:id/employment-status', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  const { employment_status } = req.body;
  if (!EMPLOYMENT_STATUSES.includes(employment_status)) {
    return res.status(400).json({ error: 'invalid_status', message: 'Недопустимый статус' });
  }
  if (req.user.role === 'assistant' && employment_status === 'active' && !ASSISTANT_CAN_RESTORE) {
    return res.status(403).json({ error: 'forbidden', message: 'Вернуть сотрудника в штат может только администратор' });
  }
  let startDate, endDate;
  try {
    startDate = normalizeDateOnly(req.body.status_date);
    endDate = normalizeDateOnly(req.body.status_date_end);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_date', message: 'Некорректная дата (нужен формат ГГГГ-ММ-ДД)' });
  }
  // Отпуск: обязательно указываем период «с — по» и причину
  let leaveReason = null, leaveNote = null;
  if (employment_status === 'maternity') {
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'leave_dates_required', message: 'Укажите даты отпуска: с какого и по какое число' });
    }
    if (endDate < startDate) {
      return res.status(400).json({ error: 'invalid_date_range', message: 'Дата окончания отпуска раньше даты начала' });
    }
    leaveReason = String(req.body.leave_reason || '').trim();
    if (!LEAVE_REASONS.includes(leaveReason)) {
      return res.status(400).json({ error: 'leave_reason_required', message: 'Укажите причину отпуска (больничный, декрет и т.д.)' });
    }
    leaveNote = String(req.body.leave_note || '').trim().slice(0, 200) || null;
    if (leaveReason === 'other' && !leaveNote) {
      return res.status(400).json({ error: 'leave_note_required', message: 'Для причины «Другое» напишите пояснение' });
    }
  }
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role !== 'employee') {
      return res.status(400).json({ error: 'not_employee', message: 'Статус «уволен / в отпуске» применим только к сотрудникам и руководителям' });
    }
    if (!isInAssistantScope(req.user, target)) {
      return res.status(403).json({ error: 'forbidden', message: 'Сотрудник вне вашей зоны доступа' });
    }
    // Уволен / в отпуске — сотрудник больше не может войти в систему (как обычная деактивация),
    // сразу пропадает из общего списка/статистики и появляется во вкладке «Архив».
    // Возврат в штат снова включает вход и статистику. Из отпуска сотрудник возвращается
    // автоматически после даты окончания (см. restoreExpiredLeaves в db.js).
    const active = employment_status === 'active' ? 1 : 0;
    const dateVal = employment_status === 'active' ? null : startDate;
    const endVal = employment_status === 'maternity' ? endDate : null;
    await query(
      `UPDATE users SET employment_status = $1, status_date = $2, status_date_end = $3, active = $4,
                        leave_reason = $5, leave_note = $6 WHERE id = $7`,
      [employment_status, dateVal, endVal, active, leaveReason, leaveNote, id]
    );
    await logAction(req, 'employment_status_changed', {
      entityType: 'user', entityId: id, entityName: fullName(target),
      details: { status: employment_status, date: dateVal, date_end: endVal, leave_reason: leaveReason, leave_note: leaveNote }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Error updating employment status:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ТЗ: роли/ИИН/PDF=копия Word §2, §9 — admin и assistant не могут назначать роли вообще
// (поле «Роль» видит только суперадмин, как и раньше); ассистент может создавать только
// обычных сотрудников (employee) в своей зоне; суперадмин может назначить
// admin/assistant/employee (роль superadmin через этот эндпоинт не выдаётся никому).
function validateRole(requesterRole, targetRole) {
  if (requesterRole === 'admin' || requesterRole === 'assistant') return targetRole === 'employee';
  if (requesterRole === 'superadmin') return ['admin', 'assistant', 'employee'].includes(targetRole);
  return false;
}

// Поля карточки сотрудника, которые роль 'assistant' вправе редактировать:
// ФИО / Объект / Отдел / Должность / № пропуска ТШО / ИИН. Объект и отдел — только внутри
// своей зоны (см. valueInAssistantZone). Логин/пароль, № сертификата, роль, комиссия,
// кадровый статус — по-прежнему только admin/superadmin.
const ASSISTANT_EDITABLE_FIELDS = ['last_name', 'first_name', 'object', 'department', 'position', 'tco_badge', 'iin'];

// Проверка, что значение объекта/отдела лежит в зоне ассистента (зона по этому измерению не
// ограничена — значит любое значение допустимо).
function valueInAssistantZone(reqUser, object, department) {
  const zoneObjects = Array.isArray(reqUser.assistant_objects) ? reqUser.assistant_objects : [];
  const zoneDepartments = Array.isArray(reqUser.assistant_departments) ? reqUser.assistant_departments : [];
  if (!zoneObjects.length && !zoneDepartments.length) return false;
  if (object !== undefined && zoneObjects.length && !zoneObjects.includes(object)) return false;
  if (department !== undefined && zoneDepartments.length && !zoneDepartments.includes(department)) return false;
  return true;
}

// ИИН (Казахстан) — ровно 12 цифр, без пробелов/дефисов. Пустое значение снимает поле.
// Контрольную сумму по алгоритму РК на первом этапе не проверяем (ТЗ §6, №6 открытых вопросов).
function normalizeIin(value) {
  if (value === undefined) return undefined;
  const v = String(value || '').trim();
  if (!v) return null;
  if (!/^\d{12}$/.test(v)) {
    throw new Error('invalid_iin');
  }
  return v;
}

// Зона видимости ассистента (ТЗ §4): суперадмин выбирает assistant_objects/assistant_departments
// в userModal; пустые массивы обоих полей — "доступа нет" (безопасный дефолт).
function normalizeZoneArray(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v || '').trim()).filter(Boolean);
}

// Виден ли targetUser текущему пользователю с учётом его зоны (assistant) — для
// admin/superadmin всегда true. Сам сотрудник (employee) сверяется по object/department.
function isInAssistantScope(reqUser, targetUser) {
  if (!reqUser || reqUser.role !== 'assistant') return true;
  const zoneObjects = Array.isArray(reqUser.assistant_objects) ? reqUser.assistant_objects : [];
  const zoneDepartments = Array.isArray(reqUser.assistant_departments) ? reqUser.assistant_departments : [];
  if (!zoneObjects.length && !zoneDepartments.length) return false;
  const objOk = zoneObjects.length ? zoneObjects.includes(targetUser.object) : true;
  const depOk = zoneDepartments.length ? zoneDepartments.includes(targetUser.department) : true;
  return objOk && depOk;
}

// Роль в комиссии по проверке знаний (модуль электронного подписания протоколов,
// п.1 запроса) — пустая строка/undefined снимают роль, иначе значение должно быть
// одним из COMMITTEE_ROLES.
function normalizeCommitteeRole(value) {
  const v = value === undefined ? undefined : (String(value || '').trim() || null);
  if (v !== undefined && v !== null && !COMMITTEE_ROLES.includes(v)) {
    throw new Error('invalid_committee_role');
  }
  return v;
}

// Create single user
// Логин и пароль необязательны при создании — можно добавить сотрудника
// только по ФИО и назначить ему доступ позже через редактирование карточки.
router.post('/', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  // Ассистент создаёт только сотрудников своей зоны: без логина/пароля, роли, № сертификата и
  // комиссии — эти поля игнорируем, даже если их прислал фронтенд.
  if (req.user.role === 'assistant') {
    for (const f of ['login', 'password', 'role', 'permanent_certificate_number', 'committee_role', 'assistant_objects', 'assistant_departments']) {
      delete req.body[f];
    }
    let o = String(req.body.object || '').trim();
    let d = String(req.body.department || '').trim();
    const zObjs = Array.isArray(req.user.assistant_objects) ? req.user.assistant_objects : [];
    const zDeps = Array.isArray(req.user.assistant_departments) ? req.user.assistant_departments : [];
    // Если зона однозначна (один объект / один отдел) — подставляем сами; если зона ограничивает поле, а оно
    // пустое, говорим об этом прямо, а не «вне зоны» (пустое значение в зону не входит).
    if (!o && zObjs.length === 1) o = zObjs[0];
    if (!d && zDeps.length === 1) d = zDeps[0];
    if (zObjs.length && !o) return res.status(400).json({ error: 'zone_required', message: 'Выберите объект из вашей зоны доступа' });
    if (zDeps.length && !d) return res.status(400).json({ error: 'zone_required', message: 'Выберите отдел из вашей зоны доступа' });
    req.body.object = o;
    req.body.department = d;
    if (!valueInAssistantZone(req.user, o, d)) {
      return res.status(403).json({ error: 'out_of_zone', message: 'Объект/отдел вне вашей зоны доступа' });
    }
  }
  const { last_name, first_name, object, department, position, login, password, role, permanent_certificate_number, tco_badge, committee_role, iin, assistant_objects, assistant_departments } = req.body;
  let staffCategoryVal, hireDateVal;
  try {
    staffCategoryVal = normalizeStaffCategory(req.body.staff_category) || 'employee';
    hireDateVal = normalizeDateOnly(req.body.hire_date) ?? null;
  } catch (e) {
    return res.status(400).json({ error: e.message === 'invalid_date' ? 'invalid_date' : 'invalid_staff_category', message: e.message === 'invalid_date' ? 'Некорректная дата начала работы' : 'Недопустимая категория сотрудника' });
  }
  const targetRole = role || 'employee';
  const loginVal = login && String(login).trim() ? String(login).trim() : null;

  if (!validateRole(req.user.role, targetRole)) {
    return res.status(403).json({ error: 'forbidden_role', message: 'Недостаточно прав для назначения роли' });
  }
  if (!last_name || !first_name) {
    return res.status(400).json({ error: 'missing_fields', message: 'Укажите фамилию и имя' });
  }
  if (loginVal && !password) {
    return res.status(400).json({ error: 'password_required', message: 'При указании логина укажите и пароль для него' });
  }
  let committeeRoleVal;
  try {
    committeeRoleVal = normalizeCommitteeRole(committee_role) || null;
  } catch (e) {
    return res.status(400).json({ error: 'invalid_committee_role', message: 'Недопустимая роль в комиссии' });
  }
  let iinVal;
  try {
    iinVal = normalizeIin(iin) ?? null;
  } catch (e) {
    return res.status(400).json({ error: 'invalid_iin', message: 'ИИН должен состоять ровно из 12 цифр' });
  }
  // Зона видимости — только суперадмин может её выдавать, и только для роли assistant
  const zoneObjects = targetRole === 'assistant' ? (normalizeZoneArray(assistant_objects) || []) : [];
  const zoneDepartments = targetRole === 'assistant' ? (normalizeZoneArray(assistant_departments) || []) : [];

  try {
    if (loginVal) {
      const exists = await query('SELECT id FROM users WHERE login = $1', [loginVal]);
      if (exists.rows.length > 0) return res.status(409).json({ error: 'login_taken' });
    }

    // Защита от дублей (п.9 запроса): сотрудник должен существовать только один раз.
    // Регистр и лишние пробелы в ФИО не считаются — если такой сотрудник уже есть,
    // новая запись не создаётся, а вызывающая сторона получает данные существующего.
    if (targetRole === 'employee') {
      const dup = await findDuplicateEmployee(last_name, first_name, null, iinVal);
      if (rejectDuplicate(req, res, dup)) return;
    }

    const hash = loginVal ? bcrypt.hashSync(String(password), 10) : null;
    const { normalized, translit } = computeFioFields(last_name, first_name);
    const result = await query(
      `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role, permanent_certificate_number, tco_badge, full_name_normalized, full_name_translit, committee_role, iin, assistant_objects, assistant_departments, staff_category, hire_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [last_name, first_name, object || '', department || '', position || '', loginVal, hash, targetRole,
       String(permanent_certificate_number || '').trim() || null,
       String(tco_badge || '').trim() || null,
       normalized, translit, committeeRoleVal, iinVal, zoneObjects, zoneDepartments,
       targetRole === 'employee' ? staffCategoryVal : 'employee', hireDateVal]
    );
    await logAction(req, 'user_created', {
      entityType: 'user', entityId: result.rows[0].id, entityName: `${last_name} ${first_name}`.trim(),
      details: { role: targetRole, object: object || '', department: department || '', position: position || '' }
    });
    if (targetRole === 'employee') await enrollNewUser(result.rows[0].id, req.user.id);
    res.json({ id: result.rows[0].id });
  } catch (e) {
    console.error('Error creating user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update user
router.put('/:id', authRequired, requireRole('admin', 'assistant', 'superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });

    if (req.user.role === 'admin' && target.role !== 'employee') {
      return res.status(403).json({ error: 'forbidden', message: 'Администратор может редактировать только обычных сотрудников' });
    }
    if (req.user.role === 'assistant') {
      if (target.role !== 'employee') {
        return res.status(403).json({ error: 'forbidden', message: 'Ассистент может редактировать только карточки сотрудников' });
      }
      if (!isInAssistantScope(req.user, target)) {
        return res.status(403).json({ error: 'forbidden', message: 'Сотрудник вне вашей зоны доступа' });
      }
      // ТЗ §3, §9: ассистент может менять только ФИО/Должность/№ пропуска ТШО/ИИН —
      // игнорируем остальные поля тела запроса, даже если фронтенд их случайно пришлёт.
      const filtered = {};
      for (const f of ASSISTANT_EDITABLE_FIELDS) {
        if (req.body[f] !== undefined) filtered[f] = req.body[f];
      }
      req.body = filtered;
      if (!valueInAssistantZone(req.user, filtered.object, filtered.department)) {
        return res.status(403).json({ error: 'out_of_zone', message: 'Объект/отдел вне вашей зоны доступа' });
      }
    }

    const { last_name, first_name, object, department, position, login, password, active, role, permanent_certificate_number, tco_badge, committee_role, iin, assistant_objects, assistant_departments } = req.body;
    const fields = [];
    const params = [];

    // Категория (сотрудник / руководитель) и дата начала работы — только админ/суперадмин
    // (в ASSISTANT_EDITABLE_FIELDS этих полей нет, так что у ассистента они сюда не попадут).
    if (req.body.staff_category !== undefined || req.body.hire_date !== undefined) {
      try {
        const cat = normalizeStaffCategory(req.body.staff_category);
        if (cat !== undefined) { params.push(cat); fields.push(`staff_category = $${params.length}`); }
        const hd = normalizeDateOnly(req.body.hire_date);
        if (hd !== undefined) { params.push(hd); fields.push(`hire_date = $${params.length}`); }
      } catch (e) {
        return res.status(400).json({ error: e.message === 'invalid_date' ? 'invalid_date' : 'invalid_staff_category', message: e.message === 'invalid_date' ? 'Некорректная дата начала работы' : 'Недопустимая категория сотрудника' });
      }
    }

    // Роль в комиссии по проверке знаний (модуль электронного подписания протоколов).
    // Пустая строка/null снимает роль — при этом сохранённая подпись сотрудника
    // не удаляется автоматически (администратор может назначить роль обратно позже).
    if (committee_role !== undefined) {
      let committeeRoleVal;
      try {
        committeeRoleVal = normalizeCommitteeRole(committee_role) || null;
      } catch (e) {
        return res.status(400).json({ error: 'invalid_committee_role', message: 'Недопустимая роль в комиссии' });
      }
      params.push(committeeRoleVal);
      fields.push(`committee_role = $${params.length}`);
    }

    if (role !== undefined) {
      if (req.user.role === 'admin' && role !== 'employee') {
        return res.status(403).json({ error: 'forbidden_role', message: 'Администратор не может назначать статус администратора' });
      }
      if (req.user.role === 'superadmin') {
        if (!['admin', 'assistant', 'employee'].includes(role)) {
          return res.status(400).json({ error: 'invalid_role' });
        }
        params.push(role);
        fields.push(`role = $${params.length}`);
      }
    }

    // ИИН — доступно и ассистенту (входит в его 4 редактируемых поля), формат 12 цифр
    if (iin !== undefined) {
      let iinVal;
      try {
        iinVal = normalizeIin(iin) ?? null;
      } catch (e) {
        return res.status(400).json({ error: 'invalid_iin', message: 'ИИН должен состоять ровно из 12 цифр' });
      }
      if (target.role === 'employee' && iinVal && iinVal !== target.iin) {
        const same = await query(`SELECT id, last_name, first_name, object, department, position, employment_status FROM users WHERE role = 'employee' AND iin = $1 AND id != $2 LIMIT 1`, [iinVal, id]);
        if (same.rows[0] && rejectDuplicate(req, res, { ...same.rows[0], level: 'strong', reason: 'iin' })) return;
      }
      params.push(iinVal);
      fields.push(`iin = $${params.length}`);
    }

    // Зона видимости ассистента (ТЗ §4) — только суперадмин может её менять, и видна
    // только когда у пользователя (текущего или уже назначенного) роль 'assistant'.
    if (req.user.role === 'superadmin') {
      if (assistant_objects !== undefined) {
        params.push(normalizeZoneArray(assistant_objects) || []);
        fields.push(`assistant_objects = $${params.length}`);
      }
      if (assistant_departments !== undefined) {
        params.push(normalizeZoneArray(assistant_departments) || []);
        fields.push(`assistant_departments = $${params.length}`);
      }
    }

    if (last_name !== undefined || first_name !== undefined) {
      const newLast = last_name !== undefined ? last_name : target.last_name;
      const newFirst = first_name !== undefined ? first_name : target.first_name;

      // Проверяем дубль, только если ФИО реально изменилось: иначе карточку со старым «похожим»
      // двойником нельзя было бы отредактировать вообще (форма всегда присылает ФИО целиком).
      const nameChanged = String(newLast).trim() !== String(target.last_name || '').trim()
        || String(newFirst).trim() !== String(target.first_name || '').trim();
      if (target.role === 'employee' && nameChanged) {
        const iinForCheck = iin !== undefined ? (String(iin || '').trim() || null) : target.iin;
        const dup = await findDuplicateEmployee(newLast, newFirst, id, iinForCheck);
        if (rejectDuplicate(req, res, dup)) return;
      }

      const { normalized, translit } = computeFioFields(newLast, newFirst);
      params.push(normalized); fields.push(`full_name_normalized = $${params.length}`);
      params.push(translit); fields.push(`full_name_translit = $${params.length}`);
    }
    if (last_name !== undefined) { params.push(last_name); fields.push(`last_name = $${params.length}`); }
    if (first_name !== undefined) { params.push(first_name); fields.push(`first_name = $${params.length}`); }
    if (object !== undefined) { params.push(object); fields.push(`object = $${params.length}`); }
    if (department !== undefined) { params.push(department); fields.push(`department = $${params.length}`); }
    if (position !== undefined) { params.push(position); fields.push(`position = $${params.length}`); }

    // Уникальный номер сотрудника (№ сертификата) — редактируется вручную в карточке
    // профиля (п.2 запроса). Это отдельное поле таблицы users и никак не связано с
    // записями таблицы assignments, поэтому вся история тестирования сотрудника
    // (пройденные курсы, баллы, ответы) сохраняется без изменений при его правке.
    if (permanent_certificate_number !== undefined) {
      params.push(String(permanent_certificate_number).trim() || null);
      fields.push(`permanent_certificate_number = $${params.length}`);
    }

    // № пропуска ТШО — попадает в Word-протокол (вкладка «Протоколы»)
    if (tco_badge !== undefined) {
      params.push(String(tco_badge).trim() || null);
      fields.push(`tco_badge = $${params.length}`);
    }

    // Логин можно оставить пустым (сотрудник без доступа) или назначить/сменить в любой момент.
    // Пустая строка трактуется как "убрать логин" (сохраняется как NULL — так уникальность
    // логина не конфликтует между несколькими сотрудниками без доступа).
    let loginVal;
    if (login !== undefined) {
      loginVal = String(login).trim() ? String(login).trim() : null;
      if (loginVal) {
        const existing = await query('SELECT id FROM users WHERE login = $1 AND id != $2', [loginVal, id]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'login_taken' });
      }
      params.push(loginVal);
      fields.push(`login = $${params.length}`);
    }

    // Если в итоге у сотрудника появляется логин, у него должен быть и пароль —
    // либо он уже был задан раньше, либо его нужно указать в этом же запросе.
    const finalLogin = login !== undefined ? loginVal : target.login;
    const willHavePassword = password || target.password_hash;
    if (finalLogin && !willHavePassword) {
      return res.status(400).json({ error: 'password_required', message: 'При указании логина укажите и пароль для него' });
    }

    if (active !== undefined) { params.push(active ? 1 : 0); fields.push(`active = $${params.length}`); }
    if (password) {
      params.push(bcrypt.hashSync(String(password), 10));
      fields.push(`password_hash = $${params.length}`);
    }

    if (fields.length === 0) return res.json({ ok: true });
    params.push(id);
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length}`, params);

    // Сменили объект/отдел/должность — записываем сотрудника на курсы новой должности
    // (то, что у него уже назначено или ещё действует, повторно не назначается).
    const b0 = req.body;
    const posChanged = (b0.object !== undefined && String(b0.object || '') !== String(target.object || ''))
      || (b0.department !== undefined && String(b0.department || '') !== String(target.department || ''))
      || (b0.position !== undefined && String(b0.position || '') !== String(target.position || ''));
    if (posChanged && target.role === 'employee') await enrollNewUser(id, req.user.id);

    // Журнал: только те поля, что реально изменились. Пароль и ИИН значениями не пишем.
    try {
      const b = req.body;
      const changed = {};
      const track = (key, oldV, newV) => {
        if (newV === undefined) return;
        if (String(oldV || '') !== String(newV || '')) changed[key] = { from: oldV || '', to: newV || '' };
      };
      track('last_name', target.last_name, b.last_name);
      track('first_name', target.first_name, b.first_name);
      track('object', target.object, b.object);
      track('department', target.department, b.department);
      track('position', target.position, b.position);
      track('tco_badge', target.tco_badge, b.tco_badge);
      track('permanent_certificate_number', target.permanent_certificate_number, b.permanent_certificate_number);
      track('login', target.login, b.login);
      track('committee_role', target.committee_role, b.committee_role);
      track('staff_category', target.staff_category, b.staff_category);
      if (b.hire_date !== undefined) track('hire_date', target.hire_date ? new Date(target.hire_date).toISOString().slice(0, 10) : '', String(b.hire_date || '').slice(0, 10));
      if (req.user.role === 'superadmin') track('role', target.role, b.role);
      if (b.iin !== undefined && String(target.iin || '') !== String(b.iin || '')) changed.iin = { changed: true };
      if (b.password) changed.password = { changed: true };
      if (b.active !== undefined && Number(target.active) !== (b.active ? 1 : 0)) changed.active = { from: Number(target.active), to: b.active ? 1 : 0 };
      if (req.user.role === 'superadmin' && (b.assistant_objects !== undefined || b.assistant_departments !== undefined)) {
        const oldZ = JSON.stringify([target.assistant_objects || [], target.assistant_departments || []]);
        const newZ = JSON.stringify([
          b.assistant_objects !== undefined ? (normalizeZoneArray(b.assistant_objects) || []) : (target.assistant_objects || []),
          b.assistant_departments !== undefined ? (normalizeZoneArray(b.assistant_departments) || []) : (target.assistant_departments || [])
        ]);
        if (oldZ !== newZ) changed.zone = { changed: true };
      }
      if (Object.keys(changed).length) {
        await logAction(req, 'user_updated', {
          entityType: 'user', entityId: id,
          entityName: fullName({ last_name: b.last_name !== undefined ? b.last_name : target.last_name, first_name: b.first_name !== undefined ? b.first_name : target.first_name }),
          details: { role: target.role, changed }
        });
      }
    } catch (logErr) { console.error('audit (user_updated):', logErr.message); }

    // Синхронизация номера сертификата с логином: если в этом запросе поменяли логин
    // и/или ручной «№ сертификата» — пересчитываем номер сертификата на всех уже
    // выданных сертификатах сотрудника (assignments.certificate_number), а не только
    // на новых. Приоритет: логин, если он задан, — на сертификате всегда должен быть
    // виден именно он и никакой другой номер. Ручной permanent_certificate_number
    // используется только когда логина нет. Если оба пусты — старые номера не трогаем
    // (не обнуляем уже распечатанные сертификаты).
    if (login !== undefined || permanent_certificate_number !== undefined) {
      const finalPermanent = permanent_certificate_number !== undefined
        ? (String(permanent_certificate_number).trim() || null)
        : target.permanent_certificate_number;
      const effectiveCertNumber = finalLogin || finalPermanent || null;
      if (effectiveCertNumber) {
        await query(
          `UPDATE assignments SET certificate_number = $1
           WHERE user_id = $2 AND certificate_number IS NOT NULL AND certificate_number IS DISTINCT FROM $1`,
          [effectiveCertNumber, id]
        );
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Error updating user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete user
// ТЗ §3, §9: удаление сотрудников из базы — только суперадмин (admin эту "опасную"
// операцию больше не может выполнять).
router.delete('/:id', authRequired, requireRole('superadmin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const targetRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role === 'superadmin') {
      return res.status(403).json({ error: 'cannot_delete_superadmin' });
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    await logAction(req, 'user_deleted', {
      entityType: 'user', entityId: id, entityName: fullName(target), details: { role: target.role }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Error deleting user:', e);
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
