const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { query, pool } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeMemoryUploader } = require('../upload');
const supabaseStorage = require('../supabaseStorage');
const { splitMulti } = require('../lib/multiFilter');
const { normalizeCardColor, pickFreeColor } = require('../lib/cardColors');

// Материалы курса — презентация или PDF-методичка. Загружаются в память и сразу
// отправляются в Supabase Storage (п.2 запроса) — файл не хранится на локальном
// диске сервера и не пропадает при redeploy, и не грузится повторно.
const uploadMaterial = makeMemoryUploader({
  maxSizeMB: 50,
  fileFilter: (req, file, cb) => {
    const okExt = /\.(pdf|ppt|pptx)$/i.test(file.originalname || '');
    const okMime = /pdf|presentation|powerpoint/i.test(file.mimetype || '');
    if (okExt || okMime) return cb(null, true);
    cb(new Error('bad_file_type'));
  }
});

// Видео курса — отдельный файл (необязательный, вместо/вместе со ссылкой)
const uploadVideo = makeMemoryUploader({
  maxSizeMB: 300,
  fileFilter: (req, file, cb) => {
    const okExt = /\.(mp4|webm|mov|avi|mkv|m4v)$/i.test(file.originalname || '');
    const okMime = /^video\//i.test(file.mimetype || '');
    if (okExt || okMime) return cb(null, true);
    cb(new Error('bad_file_type'));
  }
});

// Excel-файл с базой тестовых вопросов (билеты/варианты) — тоже читается прямо
// из памяти, на диск не пишется.
const uploadImport = makeMemoryUploader({ maxSizeMB: 20 });

async function uploadToStorage(folder, file) {
  if (!supabaseStorage.isConfigured()) {
    throw new Error(
      'Supabase Storage не настроен: задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в переменных окружения'
    );
  }
  const { url } = await supabaseStorage.uploadBuffer(folder, file.originalname, file.buffer, file.mimetype);
  return url;
}

// Категория курса (раздел обучения: «Охрана труда», «Пожарная безопасность» и т.п.) —
// обычная строка; лишние пробелы убираем, чтобы «Охрана труда » и «Охрана труда» не считались разными.
function cleanCategory(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 80);
}

const MAX_VARIANTS = 10;
const QUESTIONS_PER_VARIANT = 10;

function clampVariant(n) {
  const v = parseInt(n, 10);
  if (!v || v < 1) return 1;
  if (v > MAX_VARIANTS) return MAX_VARIANTS;
  return v;
}

// Вид курса: 'internal' (наш), 'external' (провела другая организация), 'no_protocol' (без протокола).
// Старые клиенты присылают только is_external — тогда true = 'external'. Ничего не прислали -> null (не менять).
const COURSE_KINDS = ['internal', 'external', 'no_protocol'];
function resolveCourseKind(course_kind, is_external) {
  if (COURSE_KINDS.includes(course_kind)) return course_kind;
  if (is_external === true || is_external === 'true') return 'external';
  if (is_external === false || is_external === 'false') return 'internal';
  return null;
}

// ===================== Список / карточка курса =====================

// List courses
// Фильтр по объекту/отделу (единый фильтр на всех вкладках, поддерживает мульти-выбор —
// несколько значений через запятую, см. lib/multiFilter.js): считаем только сотрудников
// выбранных объектов и/или отделов. Параметры $1 (объекты) и $2 (отделы) — пустой массив,
// если фильтр не задан (тогда условие не сужает выборку).
const ORG_SQL = `(cardinality($1::text[]) = 0 OR u.object = ANY($1::text[])) AND (cardinality($2::text[]) = 0 OR u.department = ANY($2::text[])) AND (cardinality($3::text[]) = 0 OR COALESCE(u.staff_category, 'employee') = ANY($3::text[]))`;
// $3 — категория сотрудника (необязательный фильтр дашборда): 'manager' | 'specialist' | 'employee', через запятую; пусто — все
const STAFF_CATS = ['manager', 'specialist', 'employee'];
function orgParams(req) {
  return [splitMulti(req.query.object), splitMulti(req.query.department), splitMulti(req.query.category).filter(c => STAFF_CATS.includes(c))];
}

// Для кого обязателен курс: 'all' (все) | 'employee' (сотрудники) | 'specialist' (специалисты) | 'manager' (руководители) | 'matrix' (по должностям из матрицы)
// 'matrix' — «согласно матрице»: обязателен только для должностей, отмеченных в «Курсы → Курсы по должностям»
const MANDATORY_FOR = ['all', 'employee', 'specialist', 'manager', 'matrix'];
function normalizeMandatoryFor(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  return MANDATORY_FOR.includes(s) ? s : null;
}

// SQL-условие «курс c обязателен для сотрудника u». c и u — алиасы таблиц в запросе.
// Для 'matrix' смотрим привязки курса к должностям (course_positions): объект/отдел/должность сотрудника
// сравниваются без учёта регистра и лишних пробелов (одна и та же функция с обеих сторон, поэтому
// результат не зависит от локали БД). Нет ни одной привязки — курс не обязателен никому.
function mandatoryForSql(c, u) {
  const n = (x) => `lower(btrim(regexp_replace(COALESCE(${x}, ''), '\\s+', ' ', 'g')))`;
  return `(${c}.mandatory_for = 'all'
      OR ${c}.mandatory_for = COALESCE(${u}.staff_category, 'employee')
      OR (${c}.mandatory_for = 'matrix' AND EXISTS (
            SELECT 1 FROM course_positions cp
             WHERE cp.course_id = ${c}.id
               AND ${n('cp.object')} = ${n(u + '.object')}
               AND ${n('cp.department')} = ${n(u + '.department')}
               AND ${n('cp.position')} = ${n(u + '.position')})))`;
}

router.get('/', authRequired, async (req, res) => {
  try {
    // untrained_count считается только для обязательных курсов (is_mandatory) —
    // сколько активных сотрудников ещё ни разу не сдали этот курс ('passed').
    // Нужно, чтобы на карточке курса и на главной странице сразу видеть
    // сотрудников, которых добавили в систему, но обучение по БиОТ они ещё не прошли.
    const result = await query(`
      SELECT c.*, (SELECT COUNT(*)::int FROM questions q WHERE q.course_id = c.id) as questions_count,
        CASE WHEN c.is_mandatory THEN (
          SELECT COUNT(*)::int FROM users u
          WHERE u.role = 'employee' AND u.active = 1 AND ${ORG_SQL}
            AND ${mandatoryForSql('c', 'u')}
            AND NOT EXISTS (
              SELECT 1 FROM assignments a
              WHERE a.user_id = u.id AND a.course_id = c.id AND a.status = 'passed'
            )
        ) ELSE NULL END AS untrained_count
      FROM courses c ORDER BY c.created_at DESC
    `, orgParams(req));
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Сводная статистика по каждому курсу для главной страницы (п.5 запроса —
// разбивка статистики по видам курсов) + общее число сотрудников, которые ещё
// не прошли хотя бы один обязательный курс (п.4 запроса).
router.get('/stats/summary', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const coursesRes = await query(`
      SELECT c.id, c.title_ru, c.title_kz, c.category_ru, c.category_kz, c.is_mandatory, c.mandatory_for,
        (SELECT COUNT(*)::int FROM users u WHERE u.role = 'employee' AND u.active = 1 AND ${ORG_SQL}) AS total_employees,
        -- «Прошли обучение» — только ДЕЙСТВУЮЩЕЕ обучение по этому курсу: берём актуальную
        -- (последнюю) запись 'passed' по каждому сотруднику и убираем из неё тех, у кого срок
        -- уже истёк — они показываются отдельно в «Просрочено» (см. overdue ниже), а не одновременно
        -- в обеих графах.
        (SELECT COUNT(DISTINCT a.user_id)::int FROM assignments a JOIN users u ON u.id = a.user_id
           WHERE u.role = 'employee' AND a.course_id = c.id AND a.status = 'passed' AND ${ORG_SQL}
            AND NOT (NULLIF(a.next_test_date, '') IS NOT NULL AND NULLIF(a.next_test_date, '')::timestamptz < NOW())
            AND NOT EXISTS (
              SELECT 1 FROM assignments n
              WHERE n.user_id = a.user_id AND n.course_id = a.course_id AND n.status = 'passed'
                AND (COALESCE(n.test_date, '') > COALESCE(a.test_date, '')
                     OR (COALESCE(n.test_date, '') = COALESCE(a.test_date, '') AND n.id > a.id))
            )) AS trained_employees,
        (SELECT COUNT(*)::int FROM assignments a JOIN users u ON u.id = a.user_id
           WHERE u.role = 'employee' AND a.course_id = c.id AND a.status IN ('pending','in_progress') AND ${ORG_SQL}) AS pending,
        (SELECT COUNT(*)::int FROM assignments a JOIN users u ON u.id = a.user_id
           WHERE u.role = 'employee' AND a.course_id = c.id AND a.status = 'failed' AND ${ORG_SQL}) AS failed,
        (SELECT COUNT(*)::int FROM assignments a JOIN users u ON u.id = a.user_id
           WHERE u.role = 'employee' AND a.course_id = c.id AND a.status = 'passed' AND ${ORG_SQL}
            AND NULLIF(a.next_test_date, '') IS NOT NULL AND NULLIF(a.next_test_date, '')::timestamptz < NOW()
            -- только актуальная запись: если сотрудник уже пересдал курс, старая просроченная не считается
            AND NOT EXISTS (
              SELECT 1 FROM assignments n
              WHERE n.user_id = a.user_id AND n.course_id = a.course_id AND n.status = 'passed'
                AND (COALESCE(n.test_date, '') > COALESCE(a.test_date, '')
                     OR (COALESCE(n.test_date, '') = COALESCE(a.test_date, '') AND n.id > a.id))
            )) AS overdue,
        CASE WHEN c.is_mandatory THEN (
          SELECT COUNT(*)::int FROM users u
          WHERE u.role = 'employee' AND u.active = 1 AND ${ORG_SQL}
            AND ${mandatoryForSql('c', 'u')}
            AND NOT EXISTS (
              SELECT 1 FROM assignments a WHERE a.user_id = u.id AND a.course_id = c.id AND a.status = 'passed'
            )
        ) ELSE NULL END AS untrained
      FROM courses c
      ORDER BY c.title_ru
    `, orgParams(req));

    const overallRes = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM users u WHERE u.role = 'employee' AND u.active = 1 AND ${ORG_SQL}) AS total_employees,
        (SELECT COUNT(DISTINCT u.id)::int
           FROM users u
           WHERE u.role = 'employee' AND u.active = 1 AND ${ORG_SQL}
             AND EXISTS (
               SELECT 1 FROM courses c
               WHERE c.is_mandatory = true
                 AND ${mandatoryForSql('c', 'u')}
                 AND NOT EXISTS (
                   SELECT 1 FROM assignments a
                   WHERE a.user_id = u.id AND a.course_id = c.id AND a.status = 'passed'
                 )
             )
        ) AS employees_missing_mandatory
    `, orgParams(req));

    res.json({ courses: coursesRes.rows, overall: overallRes.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Excel-шаблон для загрузки тестов (10 билетов x 10 вопросов x 4 варианта ответа)
// Должен быть объявлен раньше '/:id', иначе Express примет "questions-template.xlsx" за id
router.get('/questions-template.xlsx', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Тесты');
    ws.columns = [
      { header: 'Вариант (1-10)', key: 'variant', width: 14 },
      { header: 'Вопрос RU', key: 'qru', width: 45 },
      { header: 'Вопрос KZ', key: 'qkz', width: 45 },
      { header: 'Ответ 1 RU', key: 'o1ru', width: 25 },
      { header: 'Ответ 2 RU', key: 'o2ru', width: 25 },
      { header: 'Ответ 3 RU', key: 'o3ru', width: 25 },
      { header: 'Ответ 4 RU', key: 'o4ru', width: 25 },
      { header: 'Ответ 1 KZ', key: 'o1kz', width: 25 },
      { header: 'Ответ 2 KZ', key: 'o2kz', width: 25 },
      { header: 'Ответ 3 KZ', key: 'o3kz', width: 25 },
      { header: 'Ответ 4 KZ', key: 'o4kz', width: 25 },
      { header: 'Правильный (1-4)', key: 'correct', width: 16 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRow({
      variant: 1,
      qru: 'Пример вопроса на русском?',
      qkz: 'Мысал сұрақ қазақша?',
      o1ru: 'Вариант ответа 1', o2ru: 'Вариант ответа 2', o3ru: 'Вариант ответа 3', o4ru: 'Вариант ответа 4',
      o1kz: 'Жауап нұсқасы 1', o2kz: 'Жауап нұсқасы 2', o3kz: 'Жауап нұсқасы 3', o4kz: 'Жауап нұсқасы 4',
      correct: 1
    });
    ws.addRow({
      variant: 1,
      qru: '... (ещё 9 вопросов для варианта 1, всего рекомендуется 10)',
      qkz: '', o1ru: '', o2ru: '', o3ru: '', o4ru: '', o1kz: '', o2kz: '', o3kz: '', o4kz: '', correct: ''
    });

    const notes = wb.addWorksheet('Инструкция');
    notes.columns = [{ key: 'a', width: 100 }];
    [
      'Инструкция по заполнению файла для загрузки тестов:',
      '1. Заполните лист "Тесты", по одной строке на каждый вопрос.',
      `2. Всего рекомендуется до ${MAX_VARIANTS} вариантов (билетов), по ${QUESTIONS_PER_VARIANT} вопросов в каждом.`,
      '3. Колонка "Вариант" — номер билета от 1 до 10, все вопросы одного билета должны иметь одинаковый номер.',
      '4. Заполните все 4 варианта ответа на русском и казахском языках.',
      '5. В колонке "Правильный (1-4)" укажите номер верного варианта ответа (позиция в списке из 4 ответов).',
      '6. Загрузите готовый файл в карточке курса на вкладке "Тесты" кнопкой "Загрузить тест из Excel".',
      '7. При загрузке можно выбрать: заменить всю базу вопросов курса или добавить к уже существующим.'
    ].forEach(line => notes.addRow([line]));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="test_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: 'template_failed', details: e.message });
  }
});

// Single course with questions (includes correct_index — admin/superadmin only,
// otherwise employees could fetch the answer key before taking the test)
router.get('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const courseRes = await query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    const course = courseRes.rows[0];
    if (!course) return res.status(404).json({ error: 'not_found' });
    const questionsRes = await query(
      'SELECT * FROM questions WHERE course_id = $1 ORDER BY variant_number, sort_order',
      [req.params.id]
    );
    res.json({ course, questions: questionsRes.rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Create course
router.post('/', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { title_ru, title_kz, description_ru, description_kz, video_url, video_url_ru, video_url_kz, time_limit_minutes, pass_score_percent, validity_months, category_ru, category_kz, no_expiry, is_mandatory, card_color, is_external, course_kind } = req.body;
  if (!title_ru || !title_kz) return res.status(400).json({ error: 'missing_title' });
  const kind = resolveCourseKind(course_kind, is_external) || 'internal';

  try {
    // Цвет не выбран -> первый свободный из палитры, чтобы у нового вида обучения был свой цвет
    let cardColor = normalizeCardColor(card_color);
    if (!cardColor) {
      const used = (await query('SELECT card_color FROM courses WHERE card_color IS NOT NULL')).rows.map((r) => r.card_color);
      cardColor = pickFreeColor(used);
    }
    const result = await query(`
      INSERT INTO courses (title_ru, title_kz, description_ru, description_kz, video_url, video_url_ru, video_url_kz, time_limit_minutes, pass_score_percent, validity_months, created_by, category_ru, category_kz, no_expiry, is_mandatory, card_color, is_external, course_kind)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id
    `, [
      title_ru, title_kz, description_ru || '', description_kz || '', video_url || '',
      video_url_ru || '', video_url_kz || '',
      time_limit_minutes || 20, pass_score_percent || 80, validity_months || 12, req.user.id,
      cleanCategory(category_ru), cleanCategory(category_kz), no_expiry === true || no_expiry === 'true',
      is_mandatory === true || is_mandatory === 'true',
      cardColor,
      kind !== 'internal',
      kind
    ]);
    const mf = normalizeMandatoryFor(req.body.mandatory_for);
    if (mf) await query('UPDATE courses SET mandatory_for = $1 WHERE id = $2', [mf, result.rows[0].id]);
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update course
router.put('/:id', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { title_ru, title_kz, description_ru, description_kz, video_url, video_url_ru, video_url_kz, time_limit_minutes, pass_score_percent, validity_months, category_ru, category_kz, no_expiry, is_mandatory, card_color, is_external, course_kind } = req.body;
  try {
    const prev = (await query('SELECT no_expiry, is_external FROM courses WHERE id = $1', [req.params.id])).rows[0];
    // is_external не пришёл (старый клиент) -> null -> COALESCE оставляет прежнее значение
    const kind = resolveCourseKind(course_kind, is_external); // null -> не менять
    const external = kind === null ? null : kind !== 'internal';
    // Тип курса (наш / внешний) нельзя переключать, когда по нему уже есть назначения: наши записи
    // имеют протокол, подпись и сертификат, внешние — нет, и «на лету» их не превратить друг в друга.
    if (prev && external !== null && external !== !!prev.is_external) {
      const used = await query('SELECT 1 FROM assignments WHERE course_id = $1 LIMIT 1', [req.params.id]);
      if (used.rows.length) {
        return res.status(409).json({ error: 'external_locked', message: 'Тип курса (внешний / наш) нельзя изменить, пока по нему есть назначения или записи. Создайте отдельный курс.' });
      }
    }
    // no_expiry не пришёл (старый клиент) -> null -> COALESCE оставляет прежнее значение
    const noExpiry = (no_expiry === undefined || no_expiry === null) ? null : (no_expiry === true || no_expiry === 'true');
    // is_mandatory не пришёл (старый клиент) -> null -> COALESCE оставляет прежнее значение
    const mandatory = (is_mandatory === undefined || is_mandatory === null) ? null : (is_mandatory === true || is_mandatory === 'true');
    // category_* не пришли (старый клиент) -> null -> COALESCE оставляет прежнее значение
    await query(`
      UPDATE courses
      SET title_ru=$1, title_kz=$2, description_ru=$3, description_kz=$4, video_url=$5,
          video_url_ru=$6, video_url_kz=$7, time_limit_minutes=$8, pass_score_percent=$9, validity_months=$10,
          category_ru=COALESCE($12, category_ru), category_kz=COALESCE($13, category_kz),
          no_expiry=COALESCE($14, no_expiry),
          is_mandatory=COALESCE($15, is_mandatory),
          card_color=COALESCE($16, card_color),
          is_external=COALESCE($17, is_external),
          course_kind=COALESCE($18, course_kind)
      WHERE id=$11
    `, [
      title_ru, title_kz, description_ru, description_kz, video_url,
      video_url_ru || '', video_url_kz || '', time_limit_minutes, pass_score_percent, validity_months, req.params.id,
      category_ru === undefined ? null : cleanCategory(category_ru),
      category_kz === undefined ? null : cleanCategory(category_kz),
      noExpiry,
      mandatory,
      // не пришёл/некорректный -> null -> COALESCE оставляет прежний цвет
      normalizeCardColor(card_color),
      external,
      kind
    ]);

    // Переключили «бессрочный»: приводим уже сданные тесты этого курса в соответствие.
    //  - стал бессрочным  -> у сданных убираем дату «следующее прохождение» (нечего продлевать);
    //  - перестал быть бессрочным -> считаем её заново: дата сдачи + срок действия курса (мес.).
    if (prev && noExpiry === true && !prev.no_expiry) {
      await query(`UPDATE assignments SET next_test_date = NULL WHERE course_id = $1 AND status = 'passed'`, [req.params.id]);
    } else if (prev && noExpiry === false && prev.no_expiry) {
      const months = parseInt(validity_months, 10) || 12;
      await query(`
        UPDATE assignments
        SET next_test_date = to_char((test_date::timestamptz + make_interval(months => $2)) AT TIME ZONE 'UTC',
                                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE course_id = $1 AND status = 'passed' AND test_date IS NOT NULL AND next_test_date IS NULL
      `, [req.params.id, months]);
    }
    const mfu = normalizeMandatoryFor(req.body.mandatory_for);
    if (mfu) await query('UPDATE courses SET mandatory_for = $1 WHERE id = $2', [mfu, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete course
router.delete('/:id', authRequired, requireRole('superadmin'), async (req, res) => {
  try {
    await query('DELETE FROM courses WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ===================== Материалы (презентация/PDF), отдельно RU и KZ =====================

function langCol(base, lang) {
  // lang должен быть 'ru' или 'kz' — иначе используем legacy-колонку без языка
  return (lang === 'ru' || lang === 'kz') ? `${base}_${lang}` : base;
}

// Upload material file. :lang = ru|kz — материалы на разных языках грузятся отдельно (п.3 запроса)
router.post('/:id/material/:lang', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  uploadMaterial.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file_type', message: 'Допустимы файлы PDF, PPT или PPTX' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const col = langCol('material_pdf_path', req.params.lang);
    try {
      const url = await uploadToStorage('materials', req.file);
      await query(`UPDATE courses SET ${col} = $1 WHERE id = $2`, [url, req.params.id]);
      res.json({ [col]: url });
    } catch (e) {
      res.status(500).json({ error: 'upload_error', message: e.message, details: e.message });
    }
  });
});

// Remove material file for a given language (course can exist without materials)
router.delete('/:id/material/:lang', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const col = langCol('material_pdf_path', req.params.lang);
  try {
    await query(`UPDATE courses SET ${col} = NULL WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ===================== Видео (файл или ссылка, необязательно), отдельно RU и KZ =====================

// Upload video file. :lang = ru|kz
router.post('/:id/video/:lang', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  uploadVideo.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file_type', message: 'Допустимы видеофайлы (mp4, webm, mov и т.п.)' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const col = langCol('video_path', req.params.lang);
    try {
      const url = await uploadToStorage('videos', req.file);
      await query(`UPDATE courses SET ${col} = $1 WHERE id = $2`, [url, req.params.id]);
      res.json({ [col]: url });
    } catch (e) {
      res.status(500).json({ error: 'upload_error', message: e.message, details: e.message });
    }
  });
});

// Remove video (file and/or link) for a given language — video is optional and may simply not exist
router.delete('/:id/video/:lang', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const pathCol = langCol('video_path', req.params.lang);
  const urlCol = langCol('video_url', req.params.lang);
  try {
    await query(`UPDATE courses SET ${pathCol} = NULL, ${urlCol} = '' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// ===================== Тесты: варианты (билеты) =====================

// Сводка по вариантам — сколько вопросов заполнено в каждом из 10 билетов
// Список активных сотрудников, которые ещё ни разу не сдали этот курс (п.4 запроса).
// Работает для любого курса, но осмысленно использовать именно для обязательных.
router.get('/:id/untrained', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.last_name, u.first_name, u.object, u.department, u.position, u.staff_category,
        EXISTS (
          SELECT 1 FROM assignments a WHERE a.user_id = u.id AND a.course_id = $1
        ) AS has_assignment
      FROM users u
      WHERE u.role = 'employee' AND u.active = 1
        AND EXISTS (SELECT 1 FROM courses mc WHERE mc.id = $1
                    AND ${mandatoryForSql('mc', 'u')})
        AND (cardinality($2::text[]) = 0 OR u.object = ANY($2::text[]))
        AND (cardinality($3::text[]) = 0 OR u.department = ANY($3::text[]))
        AND (cardinality($4::text[]) = 0 OR COALESCE(u.staff_category, 'employee') = ANY($4::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM assignments a WHERE a.user_id = u.id AND a.course_id = $1 AND a.status = 'passed'
        )
      ORDER BY u.last_name, u.first_name
    `, [req.params.id, ...orgParams(req)]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.get('/:id/variants', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await query(
      'SELECT variant_number, COUNT(*)::int AS count FROM questions WHERE course_id = $1 GROUP BY variant_number ORDER BY variant_number',
      [req.params.id]
    );
    const counts = {};
    result.rows.forEach(r => { counts[r.variant_number] = r.count; });
    const variants = [];
    for (let i = 1; i <= MAX_VARIANTS; i++) {
      variants.push({ variant_number: i, count: counts[i] || 0 });
    }
    res.json({ variants, target_per_variant: QUESTIONS_PER_VARIANT, max_variants: MAX_VARIANTS });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Bulk import вопросов из Excel — автоматическая загрузка теста
// mode=replace (по умолчанию) удаляет все текущие вопросы курса перед загрузкой; mode=append — добавляет к существующим
router.post('/:id/questions/import', authRequired, requireRole('admin', 'superadmin'), (req, res) => {
  uploadImport.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file_type', message: 'Загрузите файл Excel (.xlsx)' });
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    const mode = req.query.mode === 'append' ? 'append' : 'replace';
    const headerMap = {
      'вариант': 'variant', 'вариант (1-10)': 'variant', 'билет': 'variant', '№ варианта': 'variant', 'номер варианта': 'variant',
      'вопрос ru': 'question_ru', 'вопрос (ru)': 'question_ru', 'вопрос рус': 'question_ru',
      'вопрос kz': 'question_kz', 'вопрос (kz)': 'question_kz', 'вопрос қаз': 'question_kz',
      'ответ 1 ru': 'o1ru', 'ответ 2 ru': 'o2ru', 'ответ 3 ru': 'o3ru', 'ответ 4 ru': 'o4ru',
      'ответ 1 kz': 'o1kz', 'ответ 2 kz': 'o2kz', 'ответ 3 kz': 'o3kz', 'ответ 4 kz': 'o4kz',
      'правильный': 'correct', 'правильный (1-4)': 'correct', 'правильный ответ': 'correct', 'номер правильного': 'correct'
    };

    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      const ws = wb.worksheets[0];
      if (!ws) return res.status(400).json({ error: 'empty_file' });

      const headerRow = ws.getRow(1);
      const colByField = {};
      headerRow.eachCell((cell, colNumber) => {
        const key = String(cell.value || '').trim().toLowerCase();
        if (headerMap[key]) colByField[headerMap[key]] = colNumber;
      });

      const required = ['variant', 'question_ru', 'question_kz', 'o1ru', 'o2ru', 'o3ru', 'o4ru', 'o1kz', 'o2kz', 'o3kz', 'o4kz', 'correct'];
      const missing = required.filter(f => !colByField[f]);
      if (missing.length) {
        return res.status(400).json({
          error: 'missing_columns',
          message: 'В файле не хватает колонок. Скачайте актуальный шаблон и заполните его без изменения заголовков.'
        });
      }

      const rows = [];
      const errors = [];
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const get = (f) => String(row.getCell(colByField[f]).value ?? '').trim();

        const variantRaw = get('variant');
        const question_ru = get('question_ru');
        const question_kz = get('question_kz');
        if (!variantRaw && !question_ru && !question_kz) continue; // пустая строка

        const variant = parseInt(variantRaw, 10);
        if (!variant || variant < 1 || variant > MAX_VARIANTS) {
          errors.push(`Строка ${r}: номер варианта должен быть от 1 до ${MAX_VARIANTS}`);
          continue;
        }
        if (!question_ru || !question_kz) {
          errors.push(`Строка ${r}: не заполнен текст вопроса (RU/KZ)`);
          continue;
        }
        const opts_ru = [get('o1ru'), get('o2ru'), get('o3ru'), get('o4ru')];
        const opts_kz = [get('o1kz'), get('o2kz'), get('o3kz'), get('o4kz')];
        if (opts_ru.some(o => !o) || opts_kz.some(o => !o)) {
          errors.push(`Строка ${r}: заполните все 4 варианта ответа на RU и KZ`);
          continue;
        }
        const correct = parseInt(get('correct'), 10);
        if (!correct || correct < 1 || correct > 4) {
          errors.push(`Строка ${r}: номер правильного ответа должен быть от 1 до 4`);
          continue;
        }

        rows.push({ variant, question_ru, question_kz, opts_ru, opts_kz, correct_index: correct - 1 });
      }

      if (!rows.length) {
        return res.status(400).json({ error: 'no_valid_rows', errors });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (mode === 'replace') {
          await client.query('DELETE FROM questions WHERE course_id = $1', [req.params.id]);
        }
        const sortCounters = {};
        for (const row of rows) {
          sortCounters[row.variant] = (sortCounters[row.variant] || 0) + 1;
          await client.query(`
            INSERT INTO questions (course_id, question_ru, question_kz, options_ru, options_kz, correct_index, sort_order, variant_number)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [
            req.params.id, row.question_ru, row.question_kz,
            JSON.stringify(row.opts_ru), JSON.stringify(row.opts_kz),
            row.correct_index, sortCounters[row.variant], row.variant
          ]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      res.json({ imported: rows.length, skipped: errors.length, errors, mode });
    } catch (e) {
      console.error('Import questions error:', e);
      res.status(500).json({ error: 'import_failed', message: e.message });
    }
  });
});

// Add question
router.post('/:id/questions', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { question_ru, question_kz, options_ru, options_kz, correct_index, sort_order, variant_number } = req.body;
  try {
    const result = await query(`
      INSERT INTO questions (course_id, question_ru, question_kz, options_ru, options_kz, correct_index, sort_order, variant_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
    `, [
      req.params.id, question_ru, question_kz,
      typeof options_ru === 'string' ? options_ru : JSON.stringify(options_ru),
      typeof options_kz === 'string' ? options_kz : JSON.stringify(options_kz),
      correct_index, sort_order || 0, clampVariant(variant_number)
    ]);
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Update question
router.put('/:id/questions/:qid', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  const { question_ru, question_kz, options_ru, options_kz, correct_index, sort_order, variant_number } = req.body;
  try {
    await query(`
      UPDATE questions
      SET question_ru=$1, question_kz=$2, options_ru=$3, options_kz=$4, correct_index=$5, sort_order=$6, variant_number=$7
      WHERE id=$8
    `, [
      question_ru, question_kz,
      typeof options_ru === 'string' ? options_ru : JSON.stringify(options_ru),
      typeof options_kz === 'string' ? options_kz : JSON.stringify(options_kz),
      correct_index, sort_order || 0, clampVariant(variant_number), req.params.qid
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete question
router.delete('/:id/questions/:qid', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query('DELETE FROM questions WHERE id = $1', [req.params.qid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Delete all questions of one variant (удобно перед ручным пересозданием билета)
router.delete('/:id/variants/:variant', authRequired, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await query('DELETE FROM questions WHERE course_id = $1 AND variant_number = $2', [req.params.id, clampVariant(req.params.variant)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
