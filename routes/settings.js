const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authRequired, requireRole } = require('./auth');
const { makeMemoryUploader } = require('../upload');
const supabaseStorage = require('../supabaseStorage');

const imageUpload = makeMemoryUploader({
  maxSizeMB: 8,
  fileFilter: (req, file, cb) => {
    const ok = /^image\//i.test(file.mimetype || '') || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.originalname || '');
    if (ok) return cb(null, true);
    cb(new Error('bad_file_type'));
  }
});

// Загружает файл (буфер из памяти) в Supabase Storage и возвращает публичную
// ссылку. Файл загружается ОДИН раз — дальше в базе хранится только ссылка,
// повторных загрузок того же файла при сохранении других настроек не требуется.
async function uploadToStorage(folder, file) {
  if (!supabaseStorage.isConfigured()) {
    throw new Error(
      'Supabase Storage не настроен: задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в переменных окружения'
    );
  }
  const { url } = await supabaseStorage.uploadBuffer(folder, file.originalname, file.buffer, file.mimetype);
  return url;
}

const TAGLINE_MAX = 120;

router.get('/', authRequired, async (req, res) => {
  try {
    const result = await query('SELECT * FROM settings WHERE id = 1');
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.get('/public', async (req, res) => {
  try {
    const result = await query('SELECT company_name, logo_path, logo_data FROM settings WHERE id = 1');
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Настройки комиссии, нумерации сертификатов и слогана на удостоверении (нумерация протоколов живёт во вкладке «Протоколы»). Комиссия — два председателя (без "членов
// комиссии"): у каждого своё ФИО, должность и подпись. На сертификате
// используется только ОДИН из них — тот, что выбран переключателем
// active_chairman (1 или 2) — его данные и печать; второй не показывается.
router.put('/', authRequired, requireRole('superadmin'), async (req, res) => {
  const {
    company_name,
    chairman1_name, chairman1_position,
    chairman2_name, chairman2_position,
    active_chairman,
    certificate_prefix, certificate_digits, certificate_next_number,
    tagline_kz, tagline_ru, tagline_en
  } = req.body;

  // Слоган в шапке удостоверения (KZ / RU / EN). Правило простое:
  //   поле не передано (undefined / null) — значение в базе не трогаем;
  //   передана пустая строка — слоган этого языка очищен, на бланке строка не печатается;
  //   иначе — обрезаем пробелы и ограничиваем длину (строка на бланке одна, ~420 px).
  const cleanTagline = (v) => (v === undefined || v === null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, TAGLINE_MAX));

  try {
    const actChair = active_chairman !== undefined ? (parseInt(active_chairman, 10) === 2 ? 2 : 1) : null;
    const result = await query(
      `UPDATE settings SET
        company_name = COALESCE($1, company_name),
        chairman1_name = COALESCE($2, chairman1_name),
        chairman1_position = COALESCE($3, chairman1_position),
        chairman2_name = COALESCE($4, chairman2_name),
        chairman2_position = COALESCE($5, chairman2_position),
        active_chairman = COALESCE($6, active_chairman),
        certificate_prefix = COALESCE($7, certificate_prefix),
        certificate_digits = COALESCE($8, certificate_digits),
        certificate_next_number = COALESCE($9, certificate_next_number),
        tagline_kz = COALESCE($10, tagline_kz),
        tagline_ru = COALESCE($11, tagline_ru),
        tagline_en = COALESCE($12, tagline_en)
      WHERE id = 1
      RETURNING *`,
      [
        company_name,
        chairman1_name, chairman1_position,
        chairman2_name, chairman2_position,
        actChair,
        certificate_prefix,
        certificate_digits !== undefined ? Number(certificate_digits) : null,
        certificate_next_number !== undefined ? Number(certificate_next_number) : null,
        cleanTagline(tagline_kz),
        cleanTagline(tagline_ru),
        cleanTagline(tagline_en)
      ]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Справочники «Отдел» / «Должность» (п.1 запроса) — единые списки для выпадающих
// списков в карточке сотрудника, чтобы избежать разнобоя в написании (не «Инженер»,
// «инженер», «Инженер ТБ» и т.п. вперемешку).
// «Должность» — двуязычный справочник: каждая запись хранится как {ru, kz}. В самой
// карточке сотрудника по-прежнему хранится ОДНО (русское) значение position — это
// «канонический» текст, который используется в фильтрах, экспорте и т.п. Казахский
// вариант — только для отображения интерфейса на казахском (сопоставление по ru,
// см. posLabel() на фронтенде): вторая колонка сотрудникам не добавлялась специально,
// чтобы не переделывать все места, где используется user.position.
function normalizePositions(arr) {
  if (!Array.isArray(arr)) return undefined;
  const seen = new Map();
  arr.forEach(v => {
    // поддержка и старого формата (просто строка), и нового ({ru, kz})
    const ru = String((typeof v === 'string' ? v : (v && v.ru)) || '').trim();
    const kz = String((v && typeof v === 'object' ? v.kz : '') || '').trim();
    if (!ru) return;
    const prev = seen.get(ru);
    seen.set(ru, { ru, kz: kz || (prev ? prev.kz : '') });
  });
  return [...seen.values()].sort((a, b) => a.ru.localeCompare(b.ru, 'ru'));
}

// Структура «Объект → Отдел → Должность».
//  - objects    — список объектов (массив строк);
//  - positions  — общий справочник должностей [{ru, kz}] (как и раньше);
//  - structure  — [{ object, departments: [{ name, positions: [<ru>, ...] }] }]:
//                 какие отделы есть в объекте и какие должности закреплены за отделом;
//  - departments — плоский список всех отделов (производный, для старых мест сайта:
//                 фильтры, зоны ассистентов, предупреждения при импорте из Excel).
// Порядок отделов/должностей внутри структуры сохраняется как задан.
function cleanNames(arr) {
  if (!Array.isArray(arr)) return undefined;
  return [...new Set(arr.map(v => String(v || '').trim()).filter(Boolean))];
}

function normalizeStructure(raw, objects, positionsCatalog) {
  if (!Array.isArray(raw)) return undefined;
  const known = new Set((positionsCatalog || []).map(p => p.ru));
  const byObject = new Map();
  raw.forEach(o => {
    const name = String((o && o.object) || '').trim();
    if (!name || !objects.includes(name)) return; // отделы удалённого объекта не храним
    const deps = byObject.get(name) || new Map();
    (Array.isArray(o.departments) ? o.departments : []).forEach(d => {
      const dn = String((d && d.name) || '').trim();
      if (!dn) return;
      const list = deps.get(dn) || [];
      (Array.isArray(d.positions) ? d.positions : []).forEach(p => {
        const ru = String((typeof p === 'string' ? p : p && p.ru) || '').trim();
        if (ru && known.has(ru) && !list.includes(ru)) list.push(ru);
      });
      deps.set(dn, list);
    });
    byObject.set(name, deps);
  });
  return objects.map(obj => ({
    object: obj,
    departments: [...(byObject.get(obj) || new Map()).entries()].map(([name, positions]) => ({ name, positions }))
  }));
}

function allDepartmentsOf(structure) {
  return [...new Set((structure || []).flatMap(o => o.departments.map(d => d.name)))]
    .sort((a, b) => a.localeCompare(b, 'ru'));
}

function dictionariesPayload(row) {
  const structure = Array.isArray(row.org_structure) ? row.org_structure : [];
  return {
    objects: Array.isArray(row.objects_list) ? row.objects_list : [],
    departments: allDepartmentsOf(structure).length ? allDepartmentsOf(structure) : (Array.isArray(row.departments_list) ? row.departments_list : []),
    positions: normalizePositions(row.positions_list) || [],
    structure
  };
}

const DICT_COLUMNS = 'departments_list, positions_list, objects_list, org_structure';

router.get('/dictionaries', authRequired, async (req, res) => {
  try {
    const result = await query(`SELECT ${DICT_COLUMNS} FROM settings WHERE id = 1`);
    res.json(dictionariesPayload(result.rows[0] || {}));
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Сохраняет справочники целиком: фронтенд присылает итоговое состояние (objects, positions,
// structure). Чего в теле нет — остаётся как в базе. Порядок: сначала общий справочник
// должностей, затем объекты, затем структура — в ней остаются только существующие объекты и
// должности из справочника (удалил должность из справочника — она пропадает и из отделов).
// Список отделов пересчитывается из структуры.
// ТЗ §9: весь роутер settings — только суперадмин.
router.put('/dictionaries', authRequired, requireRole('superadmin'), async (req, res) => {
  try {
    const cur = (await query(`SELECT ${DICT_COLUMNS} FROM settings WHERE id = 1`)).rows[0] || {};
    const positions = normalizePositions(req.body.positions) || normalizePositions(cur.positions_list) || [];
    const objects = cleanNames(req.body.objects) || (Array.isArray(cur.objects_list) ? cur.objects_list : []);
    const structure = normalizeStructure(
      req.body.structure !== undefined ? req.body.structure : cur.org_structure,
      objects, positions
    ) || [];
    const departments = allDepartmentsOf(structure);
    const result = await query(
      `UPDATE settings SET
        objects_list = $1::jsonb,
        positions_list = $2::jsonb,
        org_structure = $3::jsonb,
        departments_list = $4::jsonb
      WHERE id = 1
      RETURNING ${DICT_COLUMNS}`,
      [JSON.stringify(objects), JSON.stringify(positions), JSON.stringify(structure), JSON.stringify(departments)]
    );
    res.json(dictionariesPayload(result.rows[0] || {}));
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.post('/logo', authRequired, requireRole('superadmin'), (req, res) => {
  imageUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file', message: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
    try {
      const url = await uploadToStorage('logo', req.file);
      const result = await query(
        'UPDATE settings SET logo_path = $1, logo_data = NULL WHERE id = 1 RETURNING *',
        [url]
      );
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: 'upload_error', message: e.message, details: e.message });
    }
  });
});

router.post('/stamp', authRequired, requireRole('superadmin'), (req, res) => {
  imageUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file', message: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
    try {
      const url = await uploadToStorage('stamp', req.file);
      const result = await query(
        'UPDATE settings SET stamp_path = $1, stamp_data = NULL WHERE id = 1 RETURNING *',
        [url]
      );
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: 'upload_error', message: e.message, details: e.message });
    }
  });
});

// Подпись одного из двух председателей: ?chairman=1 или ?chairman=2
router.post('/signature', authRequired, requireRole('superadmin'), (req, res) => {
  imageUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'bad_file', message: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Файл не выбран' });
    const chairNum = req.query.chairman === '2' ? 2 : 1;
    const colSig = chairNum === 2 ? 'chairman2_signature' : 'chairman1_signature';

    try {
      const url = await uploadToStorage('signature', req.file);
      const result = await query(
        `UPDATE settings SET ${colSig} = $1 WHERE id = 1 RETURNING *`,
        [url]
      );
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: 'upload_error', message: e.message, details: e.message });
    }
  });
});

module.exports = router;
