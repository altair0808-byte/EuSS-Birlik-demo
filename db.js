const { Pool, types } = require('pg');

// BIGSERIAL (int8) драйвер pg по умолчанию отдаёт СТРОКОЙ ("12"), а фронтенд сравнивает
// id строго (===) с числом из onclick="editUser(12)". Из-за этого «Изменить», вкладки
// статистики по курсам и т.п. молча ничего не делали. Приводим int8 к числу (id и счётчики
// гарантированно помещаются в Number).
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));
const bcrypt = require('bcryptjs');
const { computeFioFields } = require('./lib/fio.js');
const { generatePublicUid } = require('./lib/publicUid');
const { CARD_COLOR_PALETTE } = require('./lib/cardColors');
const { SEED_OBJECT, DEPARTMENT_RENAMES, SEED_STRUCTURE } = require('./lib/orgSeed');

// Список должностей объекта Dome 6 (файл "Dome 6 MT position - 19.09.2025.xlsx",
// присланный 25.09.2026) — сеется в справочник positions_list один раз, только если
// справочник ещё пуст (см. использование ниже, в initDb()), чтобы не затирать то,
// что администратор уже мог добавить сам. Каждая должность хранится на двух языках:
// «ru» — используется как значение в карточке сотрудника, «kz» — для отображения
// интерфейса на казахском (см. posLabel() в index.html). Перевод должности
// "Camp Manager" на русский в файле отсутствовал (стояла пустая ячейка) — заполнено
// вручную как «Менеджер городка».
const SEED_POSITIONS = [
    { ru: 'Менеджер городка', kz: 'Қалашық Менеджері' },
    { ru: 'Инспектор Управления людских ресурсов', kz: 'Мамандар бөлімі инспекторы' },
    { ru: 'Делопроизводитель', kz: 'Іс жүргізуші' },
    { ru: 'Ведущий координатор отдела обучения', kz: 'Оқыту бөлімінің жетекші үйлестірушісі' },
    { ru: 'Административный служащий', kz: 'Әкімшілік кеңсе қызметкері' },
    { ru: 'Бухгалтер по расчету с дебиторами', kz: 'Қарызға алушылармен есеп айрысу есепшісі' },
    { ru: 'Калькулятор', kz: 'Калькулятор' },
    { ru: 'Технический администратор Бирлик', kz: 'Бірлік Техникалық әкімші' },
    { ru: 'Консультант материального контроля', kz: 'Материалдық бақылау жөніндегі кеңесшісі' },
    { ru: 'Специалист по технике безопасности', kz: 'Техника қауіпсізідігі жөніндегі маман' },
    { ru: 'Консультант по пищевой гигиене', kz: 'Тамақ гигиенасы бойынша кеңесші' },
    { ru: 'Работник спортзала', kz: 'Спортзал қызметкері' },
    { ru: 'Заведующий по оформлению пропусков', kz: 'Рұқсатнама рәсімдеу жөніндегі меңгерушісі' },
    { ru: 'Специалист по ИТ', kz: 'Ақпараттық технология маманы' },
    { ru: 'Менеджер склада', kz: 'Қойма Менеджері' },
    { ru: 'Работник по складу', kz: 'Қойма қызметкері' },
    { ru: 'Подсобный рабочий', kz: 'Жұмысшы' },
    { ru: 'Ведущий специалист по коммерческим вопросам', kz: 'Коммерция сұрақтары бойынша жетекші маманы' },
    { ru: 'Начальник отдела ГУ', kz: 'МҚК бөлімінің Бастығы' },
    { ru: 'Бригадир ГУ', kz: 'МҚК Бастығы' },
    { ru: 'Бригадир прачечной', kz: 'Кір жуу бөлімінің бригадиры' },
    { ru: 'Работник хозяйственной службы', kz: 'Шаруашылық қызметінің қызметкері' },
    { ru: 'Обслуживающий прачечной', kz: 'Кір жуушы' },
    { ru: 'Грузчик', kz: 'Жүк көтеруші' },
    { ru: 'Начальник отдела размещения и перевахтовок', kz: 'Орналастыру және вахта алмасу бөл. Бастығы' },
    { ru: 'Работник отдела размещения', kz: 'Орналастыру бөлімінің қызметкері' },
    { ru: 'Менеджер отдела Техобслуживания', kz: 'Техникалық қызмет көрсету бөлімі Менеджері' },
    { ru: 'Главный электрик', kz: 'Бас электрик' },
    { ru: 'Техник по газовому оборудованию и ремонту бытовых приборов', kz: 'Газ жабдықтары мен тұрмыстық құрылғыларын жөндеу жөніндегі техник' },
    { ru: 'Работник - Сантехник', kz: 'Сантехника қызметкері' },
    { ru: 'Техник - Электрик', kz: 'Техник - Электр маманы' },
    { ru: 'Работник по ремонту и обслуживанию систем отопления, вентиляции и кондиционирования воздуха', kz: 'Жылыту, желдету және ауаны баптауды жөндеу және техникалық қызмет көрсету бойынша қызметкері' },
    { ru: 'Уборщик территории', kz: 'Территория тазалаушы' },
    { ru: 'Работник мастер', kz: 'Шебер қызметкері' },
    { ru: 'Работник - Дезинфектор', kz: 'Зарарсыздандыру қызметкері' },
    { ru: 'Работник сварщик', kz: 'Дәнекерлеу қызметкері' },
    { ru: 'Работник по ремонту замков', kz: 'Құлыптар бойынша қызметкер' },
    { ru: 'Консультант Колл-центра', kz: 'Байланыс орталығының кеңесшісі' },
    { ru: 'Администратор базы данных CMMS', kz: 'CMMS дерекқорының әкімшісі' },
    { ru: 'Ведущий электромонтер охранно-пожарной сигнализации', kz: 'Қауіпсіздік және Өрт дабылдамасының электр жетекші маманы' },
    { ru: 'Оператор большегрузного оборудование', kz: 'Ауыр техника операторы' },
    { ru: 'Шеф подразделения по приготовлению пищи', kz: 'Тамақ дайындау бөлімшесінің басшысы' },
    { ru: 'Руководитель Отдела Общественного питания', kz: 'Қоғамдық тамақтандыру бөлімінің басшысы' },
    { ru: 'Бригадир Столовой', kz: 'Асхана бригадирі' },
    { ru: 'Бригадир Пекарни', kz: 'Наубайхана бригадирі' },
    { ru: 'Пекарь-повар', kz: 'Наубайшы-аспаз' },
    { ru: 'Кондитер-повар', kz: 'Тәтті тағамдар дайындайтын маман-аспаз' },
    { ru: 'Работник мясник', kz: 'Қасапшы қызметкері' },
    { ru: 'Старший Повар', kz: 'Аға аспаз' },
    { ru: 'Повар', kz: 'Аспаз' },
    { ru: 'Помощник повара', kz: 'Аспаз көмекшісі' },
    { ru: 'Кухонный работник', kz: 'Ас бөлме  қызметкері' },
    { ru: 'Работник бармен', kz: 'Бармен қызметкері' },
    { ru: 'Продавец', kz: 'Сатушы' },
    { ru: 'Официант / Официантка', kz: 'Даяршы' },
    { ru: 'Супервайзер по эксплуатации Транспорта Тенгиза', kz: 'Теңіз бойынша көліктерді пайдалану Супервайзері' },
    { ru: 'Профессиональный водитель', kz: 'Кәсіби жүргізуші' },
    { ru: 'Водитель', kz: 'Жүргізуші' }
];

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('FATAL: DATABASE_URL не задана в переменных окружения!');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString && connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Хелпер для SQL запросов
async function query(text, params) {
  return pool.query(text, params);
}

// Инициализация структуры таблиц и создание суперадмина
async function initDb() {
  // Автоматические миграции для расширенного функционала
  await pool.query(`
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS logo_data TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS stamp_data TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman1_name TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman1_position TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman1_signature TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman2_name TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman2_position TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS chairman2_signature TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS active_chairman INTEGER DEFAULT 1;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS protocol_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE);
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS protocol_open_date DATE;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS protocol_close_date DATE;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS user_answers JSONB;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS protocol_id BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS permanent_certificate_number TEXT;
    -- № пропуска ТШО (TCO Badge) — попадает в колонку «ТШО рұқсатнама / № пропуска ТШО» Word-протокола
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tco_badge TEXT;

    -- Кадровый статус сотрудника: 'active' (работает), 'fired' (уволен), 'maternity' (в декрете).
    -- Уволенные и находящиеся в декрете сразу переносятся во вкладку «Архив» и перестают
    -- учитываться в статистике и списках для назначения тестов — см. routes/users.js
    -- (эндпоинт PATCH /api/users/:id/employment-status) и index.html (вкладка "Архив").
    -- Поле active при этом синхронизируется автоматически (0 — вход в систему заблокирован).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_status TEXT NOT NULL DEFAULT 'active';
    -- Дата увольнения / дата начала декретного отпуска (необязательно, для карточки в архиве)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status_date DATE;
    UPDATE users SET employment_status = 'active' WHERE employment_status IS NULL;

    -- Категория сотрудника: 'employee' (обычный сотрудник) или 'manager' (руководитель —
    -- руководящая должность). Дашборд у обоих одинаковый, различаются только обязательные курсы.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_category TEXT NOT NULL DEFAULT 'employee';
    -- Дата начала работы в компании (для стажа в дашборде сотрудника, у QR-кода и в удостоверении)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS hire_date DATE;
    -- Конец отпуска. Значение employment_status='maternity' сохранено для совместимости со старыми
    -- данными, но в интерфейсе это теперь «Отпуск» (у всех), а не только декрет:
    -- status_date = начало отпуска, status_date_end = конец отпуска (после неё сотрудник
    -- автоматически возвращается из архива в штат).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status_date_end DATE;
    -- Причина отпуска: sick (больничный), maternity (декрет — беременность и роды),
    -- childcare (по уходу за ребёнком), annual (ежегодный), unpaid (без сохранения зарплаты),
    -- study (учебный), other (другое — тогда пояснение в leave_note).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS leave_reason TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS leave_note TEXT;

    -- Вахтовый метод работы: текущая вахта сотрудника.
    -- rotation_arrival — дата заезда на вахту, rotation_days — срок вахты (14 / 21 / 28 или любой),
    -- rotation_departure — дата отъезда (по умолчанию заезд + срок, можно поправить вручную).
    -- Статус «на вахте / дома» нигде не хранится — он считается на лету по сегодняшней дате
    -- (см. routes/users.js: ROTATION_SELECT), поэтому сам переключается в день заезда и после отъезда.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS rotation_arrival DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS rotation_days INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS rotation_departure DATE;

    -- Овертайм на вахте: сотрудника оставили на несколько дней сверх вахты.
    -- overtime_from / overtime_to — период «с … по» (включительно), без часов.
    -- Пока сегодняшняя дата внутри периода, сотрудник считается «на вахте» (см. routes/users.js: ROT_ON_SQL).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS overtime_from DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS overtime_to DATE;

    -- Защита от дублей сотрудников (п.9 запроса): "УТЯШЕВ АЛТАИР" / "утяшев алтаир" /
    -- "Утяшев Алтаир" должны считаться одной записью, а поиск должен работать и по
    -- русскому написанию, и по английской транслитерации (Altair/Utyashev).
    -- full_name_normalized — "фамилия имя" в нижнем регистре (сравнение дублей).
    -- full_name_translit — латинская транслитерация ФИО (поиск по-английски).
    -- Заполняются в JS при создании/изменении сотрудника (см. lib/fio.js, routes/users.js).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name_normalized TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name_translit TEXT;
    CREATE INDEX IF NOT EXISTS idx_users_full_name_normalized ON users(full_name_normalized);
    CREATE INDEX IF NOT EXISTS idx_users_full_name_translit ON users(full_name_translit);

    -- Быстрый поиск максимального уже выданного номера сертификата (используется
    -- новой, устойчивой к ручным номерам логикой присвоения — см. routes/assignments.js).
    CREATE INDEX IF NOT EXISTS idx_assignments_certificate_number ON assignments(certificate_number);
    CREATE INDEX IF NOT EXISTS idx_users_permanent_certificate_number ON users(permanent_certificate_number);
    UPDATE assignments a SET certificate_number = u.login FROM users u
      WHERE a.user_id = u.id AND u.login IS NOT NULL AND u.login <> ''
        AND a.certificate_number IS NOT NULL AND a.certificate_number IS DISTINCT FROM u.login;

    -- Материалы и видео курса отдельно на русском и казахском языке (п.3 запроса):
    -- раньше был один файл на курс, теперь администратор может загрузить свою
    -- методичку/презентацию и своё видео для каждого языка отдельно.
    -- Старые колонки material_pdf_path / video_path / video_url оставлены как есть
    -- (используются как запасной вариант для курсов, созданных до этого обновления).
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS material_pdf_path_ru TEXT;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS material_pdf_path_kz TEXT;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS video_path_ru TEXT;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS video_path_kz TEXT;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS video_url_ru TEXT;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS video_url_kz TEXT;

    -- Обязательный курс (например, вводный инструктаж по БиОТ) — все активные
    -- сотрудники должны его пройти. Позволяет отдельно показывать тех, кто ещё
    -- не прошёл обучение по такому курсу: на карточке курса и в общей
    -- статистике на главной странице (см. routes/courses.js: GET /:id/untrained
    -- и GET /stats/summary).
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_mandatory BOOLEAN NOT NULL DEFAULT FALSE;
    -- Для кого курс обязателен (имеет смысл при is_mandatory = TRUE):
    -- 'all' — для всех, 'employee' — только для сотрудников, 'manager' — только для руководителей.
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS mandatory_for TEXT NOT NULL DEFAULT 'all';

    -- Справочники «Отдел» / «Должность» (п.1 запроса): фиксированные списки значений,
    -- которые администратор ведёт во вкладке «Настройки», чтобы при добавлении/редактировании
    -- сотрудника отдел и должность выбирались из выпадающего списка, а не вписывались вручную
    -- в произвольном виде (иначе одна и та же должность оказывается записана по-разному).
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS departments_list JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS positions_list JSONB NOT NULL DEFAULT '[]'::jsonb;

    -- Структура «Объект → Отдел → Должность»: выпадающие списки в карточке сотрудника
    -- зависят друг от друга (выбрал объект — видишь только его отделы, выбрал отдел —
    -- только его должности). objects_list — список объектов (массив строк);
    -- org_structure — массив вида
    --   [{ "object": "Бирлик", "departments": [{ "name": "Administration", "positions": ["<рус. название должности>", ...] }] }]
    -- Должности ссылаются на справочник positions_list по русскому названию.
    -- Массивы (а не объекты) — потому что JSONB не сохраняет порядок ключей.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS objects_list JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS org_structure JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // Протоколы комиссии: администратор "открывает" протокол на диапазон дат —
  // всем сотрудникам, кто пройдёт проверку знаний внутри этого диапазона,
  // номер протокола присваивается автоматически (см. routes/protocols.js
  // и POST /api/assignments/:id/submit в routes/assignments.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS protocols (
      id BIGSERIAL PRIMARY KEY,
      protocol_number TEXT NOT NULL,
      open_date DATE NOT NULL,
      close_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','revoked')),
      created_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Если таблица settings была создана ранее без колонки id, пересоздаем ее с правильной структурой
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'settings'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'id'
      ) THEN
        DROP TABLE public.settings CASCADE;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      last_name TEXT NOT NULL,
      first_name TEXT NOT NULL,
      object TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT '',
      login TEXT UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL CHECK(role IN ('superadmin','admin','assistant','employee')),
      active SMALLINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS courses (
      id BIGSERIAL PRIMARY KEY,
      title_ru TEXT NOT NULL,
      title_kz TEXT NOT NULL,
      description_ru TEXT DEFAULT '',
      description_kz TEXT DEFAULT '',
      material_pdf_path TEXT,
      video_url TEXT,
      time_limit_minutes INT NOT NULL DEFAULT 20,
      pass_score_percent INT NOT NULL DEFAULT 80,
      validity_months INT NOT NULL DEFAULT 12,
      created_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS questions (
      id BIGSERIAL PRIMARY KEY,
      course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      question_ru TEXT NOT NULL,
      question_kz TEXT NOT NULL,
      options_ru TEXT NOT NULL,
      options_kz TEXT NOT NULL,
      correct_index INT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      variant_number INT NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      protocol_number TEXT NOT NULL,
      protocol_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','passed','failed')),
      retake_allowed SMALLINT NOT NULL DEFAULT 0,
      attempts_used INT NOT NULL DEFAULT 0,
      score_percent INT,
      focus_violations INT NOT NULL DEFAULT 0,
      certificate_number TEXT,
      test_date TEXT,
      next_test_date TEXT,
      assigned_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY CHECK (id = 1),
      company_name TEXT DEFAULT 'ТОО «Компания»',
      chairman_name TEXT DEFAULT '',
      member2_name TEXT DEFAULT '',
      member3_name TEXT DEFAULT '',
      logo_path TEXT,
      stamp_path TEXT,
      signature_path TEXT,
      protocol_prefix TEXT DEFAULT '',
      protocol_next_number INT DEFAULT 1,
      certificate_prefix TEXT DEFAULT '',
      certificate_digits INT DEFAULT 4,
      certificate_next_number INT DEFAULT 1
    );

    INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);

  // Сотрудника можно создать/импортировать только по ФИО, без логина и пароля,
  // и назначить их позже через карточку профиля — поэтому эти поля больше не обязательны.
  // (Перенесено сюда, после CREATE TABLE users выше — ALTER TABLE на несуществующей
  // таблице ломает initDb() на совсем свежей базе.)
  await pool.query(`
    ALTER TABLE users ALTER COLUMN login DROP NOT NULL;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
  `);

  // ===================== Роль «Ассистент» + ИИН (ТЗ: роли/ИИН/PDF=копия Word) =====================
  // Новая системная роль 'assistant' — наблюдатель уровня руководителя/табельщика/координатора,
  // ограниченный выданной зоной (объекты/отделы). Снимаем старый CHECK и ставим новый со
  // включённой 'assistant' (роли не сносим, только расширяем — см. routes/users.js validateRole()).
  // (Перенесено сюда же — по той же причине: должно идти после CREATE TABLE users.)
  await pool.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('superadmin','admin','assistant','employee'));

    -- Зона видимости ассистента: если оба массива пусты — трактуем как "доступа нет"
    -- (безопасный дефолт), а не "доступ ко всем". См. lib/multiFilter.js:scopedFilter().
    ALTER TABLE users ADD COLUMN IF NOT EXISTS assistant_objects TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS assistant_departments TEXT[] NOT NULL DEFAULT '{}';

    -- ИИН (Individual Identification Number, Казахстан) — 12 цифр, поле карточки сотрудника.
    -- Не форсируем уникальность на уровне БД (возможны дубли при переходном импорте) и
    -- намеренно НЕ выводим в Word/PDF протокол (повышенная чувствительность персональных данных).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS iin TEXT;
    CREATE INDEX IF NOT EXISTS idx_users_iin ON users(iin);
  `);

  // ===================== Журнал действий (для суперадмина) =====================
  // Кто (админ / ассистент) и когда добавил или изменил сотрудника, назначил курс и т.д.
  // Намеренно БЕЗ внешнего ключа на users: при удалении учётной записи админа журнал остаётся,
  // а имя и роль исполнителя хранятся в самой записи (actor_name / actor_role).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_id BIGINT,
      actor_name TEXT NOT NULL DEFAULT '',
      actor_role TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id BIGINT,
      entity_name TEXT NOT NULL DEFAULT '',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
  `);

  // ГРУППЫ ОБУЧЕНИЯ: заявка на курс, который проходят много людей сразу (см. routes/trainingSessions.js).
  // Пока заявка 'planned' — это просто список; при закрытии всем присутствующим разом вносится прохождение
  // (обычные записи в assignments). Для курса «без протокола» номер протокола не нужен.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_sessions (
      id BIGSERIAL PRIMARY KEY,
      course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'completed')),
      planned_date DATE,
      protocol_number TEXT NOT NULL DEFAULT '',
      protocol_date DATE,
      test_date DATE,
      next_test_date DATE,
      score_percent INT,
      created_by BIGINT,
      completed_by BIGINT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS training_session_members (
      session_id BIGINT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attended BOOLEAN NOT NULL DEFAULT FALSE,
      assignment_id BIGINT REFERENCES assignments(id) ON DELETE SET NULL,
      PRIMARY KEY (session_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_training_sessions_course ON training_sessions(course_id);
    CREATE INDEX IF NOT EXISTS idx_training_sessions_status ON training_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_training_session_members_user ON training_session_members(user_id);
  `);

  await pool.query(`
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS variant_number INT NOT NULL DEFAULT 1;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS video_path TEXT;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS category_ru TEXT DEFAULT '';
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS category_kz TEXT DEFAULT '';
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS no_expiry BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS assigned_variant INT;
    CREATE INDEX IF NOT EXISTS idx_questions_course_variant ON questions(course_id, variant_number);

    ALTER TABLE settings ADD COLUMN IF NOT EXISTS member2_name TEXT DEFAULT '';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS member3_name TEXT DEFAULT '';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS protocol_prefix TEXT DEFAULT '';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS protocol_next_number INT DEFAULT 1;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS certificate_prefix TEXT DEFAULT '';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS certificate_digits INT DEFAULT 4;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS certificate_next_number INT DEFAULT 1;
  `);

  // ===================== Модуль электронного подписания протоколов =====================
  // Профиль подписанта (п.1 запроса): образец подписи хранится прямо в карточке
  // пользователя как base64 PNG, полученный с canvas на фронтенде (палец на телефоне,
  // стилус на планшете, мышь на компьютере — см. index.html, signaturePad*). Это тот же
  // подход, что уже используется для логотипа/печати/подписи председателя в settings
  // (logo_data/stamp_data/chairman1_signature) — локальный диск сервера не persistent.
  // committee_role — роль пользователя в комиссии по проверке знаний; назначается
  // администратором в карточке сотрудника (routes/users.js). Без этой роли аккаунт
  // не может ни сохранить подпись, ни подписать протокол (routes/signatures.js).
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS committee_role TEXT;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_committee_role_check;
    ALTER TABLE users ADD CONSTRAINT users_committee_role_check
      CHECK (committee_role IS NULL OR committee_role IN ('chairman','biot_engineer','member'));
    ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_data TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_updated_at TIMESTAMPTZ;

    -- Протокол «запечатывается», когда его подписали все три роли комиссии (п.8 запроса):
    -- редактирование блокируется, а итоговый PDF с подписями сохраняется тут же (signed_pdf_data),
    -- чтобы при повторном скачивании отдавался ровно тот же файл и та же контрольная сумма (pdf_hash).
    ALTER TABLE protocols ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE protocols ADD COLUMN IF NOT EXISTS signed_docx_data TEXT;
    ALTER TABLE protocols ADD COLUMN IF NOT EXISTS fully_signed_at TIMESTAMPTZ;
    ALTER TABLE protocols ADD COLUMN IF NOT EXISTS pdf_hash TEXT;
    ALTER TABLE protocols ADD COLUMN IF NOT EXISTS signed_pdf_data TEXT;
    ALTER TABLE protocols ADD COLUMN IF NOT EXISTS pdf_version INT NOT NULL DEFAULT 1;

    -- Журнал подписания (п.5 запроса): одна запись на подпись одной роли одного протокола
    -- (ФИО/роль — через user_id, дата/время — signed_at, IP и браузер/устройство — ниже).
    CREATE TABLE IF NOT EXISTS protocol_signatures (
      id BIGSERIAL PRIMARY KEY,
      protocol_id BIGINT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
      committee_role TEXT NOT NULL CHECK (committee_role IN ('chairman','biot_engineer','member')),
      user_id BIGINT NOT NULL REFERENCES users(id),
      signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address TEXT,
      user_agent TEXT,
      UNIQUE (protocol_id, committee_role)
    );
  `);

  // ===================== ЭТАП 2: Аннулирование протокола → удостоверение =====================
  // Протокол — источник истины: если он аннулирован (администратором вручную) или удалён,
  // все удостоверения, выданные на его основании, должны автоматически получить статус
  // REVOKED (см. certificateService.js:revokeCertificatesForProtocol() и
  // routes/protocols.js: POST /:id/revoke, DELETE /:id). Раньше status мог быть только
  // 'open'/'closed' — расширяем чек-констрейнт существующих баз до 'revoked' (в CREATE TABLE
  // выше это уже учтено для новых баз, ALTER нужен для уже развёрнутых).
  await pool.query(`
    ALTER TABLE protocols DROP CONSTRAINT IF EXISTS protocols_status_check;
    ALTER TABLE protocols ADD CONSTRAINT protocols_status_check CHECK (status IN ('open','closed','revoked'));
    ALTER TABLE protocols ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
    ALTER TABLE protocols ADD COLUMN IF NOT EXISTS revoked_by BIGINT;
    ALTER TABLE protocols ADD COLUMN IF NOT EXISTS revoke_reason TEXT;
  `);

  // ===================== ЭТАП 1: Фундамент удостоверений БиОТ =====================
  // Отдельная таблица удостоверений — не путать с "сертификатом" (assignments.certificate_number),
  // это следующий уровень: у каждого пройденного назначения (assignment) с проверкой знаний
  // появляется ровно одно удостоверение (см. certificateService.js:ensureCertificateForAssignment()).
  //   certificate_number — НЕ генерируется отдельно, всегда равен логину сотрудника (users.login);
  //   certificate_uid    — внутренний уникальный идентификатор вида BIOT-2026-AB12CD (QR/API/проверка);
  //   protocol_id        — подтягивается из assignments.protocol_id (может быть NULL для исторических
  //                        записей, внесённых без привязки к строке в таблице protocols); именно отсюда
  //                        на следующем этапе будут наследоваться подписи комиссии — отдельной таблицы
  //                        подписей удостоверений не создаём;
  //   verification_token — резерв под ЭТАП 2 (строгая проверка подлинности через API), сейчас страница
  //                        /verify/:uid ищет удостоверение только по certificate_uid;
  //   assignment_id/course_id — сверх исходного списка полей, нужны технически: сотрудник может иметь
  //                        несколько удостоверений (по одному на каждый пройденный курс БиОТ).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS certificates (
      id BIGSERIAL PRIMARY KEY,
      employee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assignment_id BIGINT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      protocol_id BIGINT REFERENCES protocols(id) ON DELETE SET NULL,
      course_id BIGINT REFERENCES courses(id) ON DELETE SET NULL,
      certificate_number TEXT NOT NULL,
      certificate_uid TEXT NOT NULL UNIQUE,
      issue_date DATE,
      expiry_date DATE,
      status TEXT NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','EXPIRED','REVOKED')),
      verification_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (assignment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_certificates_employee ON certificates(employee_id);
    CREATE INDEX IF NOT EXISTS idx_certificates_uid ON certificates(certificate_uid);
  `);

  // УДОСТОВЕРЕНИЯ — отдельный документ, НЕ сертификат (см. idCardService.js).
  // Сертификат остаётся как был (таблица certificates выше). Удостоверение — второй
  // документ на то же назначение, со своим номером (= логин сотрудника), своим UID
  // (UD-...) и своим бланком. Миграция накатывается автоматически при старте сервера.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS id_cards (
      id BIGSERIAL PRIMARY KEY,
      employee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assignment_id BIGINT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      protocol_id BIGINT REFERENCES protocols(id) ON DELETE SET NULL,
      course_id BIGINT REFERENCES courses(id) ON DELETE SET NULL,
      card_number TEXT NOT NULL,
      card_uid TEXT NOT NULL UNIQUE,
      issue_date DATE,
      expiry_date DATE,
      status TEXT NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','EXPIRED','REVOKED')),
      verification_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (assignment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_id_cards_employee ON id_cards(employee_id);
    CREATE INDEX IF NOT EXISTS idx_id_cards_uid ON id_cards(card_uid);
  `);

  // ОЧЕРЕДЬ ВЫГРУЗКИ В GOOGLE DRIVE (запасное хранилище, см. driveSync.js). Событие на сайте только
  // добавляет сюда строку; отправляет фоновый воркер, при недоступности облака — повторяет.
  // Без внешних ключей: удаление протокола/назначения не должно блокироваться очередью.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drive_outbox (
      id BIGSERIAL PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('protocol_pdf','protocol_docx','id_card')),
      protocol_id BIGINT,
      assignment_id BIGINT,
      base_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','skipped')),
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT,
      drive_file_id TEXT,
      drive_path TEXT,
      uploaded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_drive_outbox_due ON drive_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_drive_outbox_protocol ON drive_outbox(protocol_id);
  `);

  // ===================== Единое удостоверение сотрудника =====================
  // Один бланк на сотрудника со списком всех его курсов и ОДНИМ постоянным QR на
  // /p/<public_uid>. public_uid не зависит ни от логина, ни от курсов и не меняется.
  // DEFAULT задаёт формат для новых сотрудников на стороне БД (чтобы не править каждый
  // INSERT в routes/users.js); существующим значения раздаём ниже (lib/publicUid.js).
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS public_uid TEXT;
    ALTER TABLE users ALTER COLUMN public_uid
      SET DEFAULT ('P-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_uid ON users(public_uid);

    -- Слоган в шапке бланка (3 языка) — редактируется в «Настройках», а не зашит в бланк.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS tagline_kz TEXT DEFAULT 'ҚАУІПСІЗ ЖҰМЫС — ЖАРҚЫН БОЛАШАҚ';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS tagline_ru TEXT DEFAULT 'БЕЗОПАСНЫЙ ТРУД – УСТОЙЧИВОЕ РАЗВИТИЕ';
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS tagline_en TEXT DEFAULT 'SAFE WORK – SUSTAINABLE FUTURE';
  `);

  // Курсы по должностям: какие курсы обязательны для «Объект → Отдел → Должность»
  // (routes/coursePositions.js, lib/positionCourses.js). key — нормализованная тройка.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS course_positions (
      id BIGSERIAL PRIMARY KEY,
      course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      object TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      UNIQUE (course_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_course_positions_key ON course_positions(key);
  `);

  // Веб-пуши (lib/push.js, routes/push.js): подписки устройств и журнал уже отправленных напоминаний
  // о сроке обучения (чтобы одно и то же напоминание по одной записи не уходило дважды).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'ru',
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS push_log (
      id BIGSERIAL PRIMARY KEY,
      assignment_id BIGINT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (assignment_id, kind)
    );
  `);

  // Личные медицинские книжки (routes/medbooks.js, lib/medbook.js):
  //  medbook_positions — должности («Объект → Отдел → Должность»), которым книжка нужна, и период напоминания (6/12 мес.);
  //  medbook_records   — дата начала книжки у конкретного сотрудника (manual = внесён вне должности);
  //  medbook_push_log  — какие напоминания о сроке уже отправлены (чтобы не слать дважды).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS medbook_positions (
      id BIGSERIAL PRIMARY KEY,
      object TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL UNIQUE,
      period_months SMALLINT NOT NULL CHECK (period_months IN (6, 12))
    );
    CREATE TABLE IF NOT EXISTS medbook_records (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      start_date DATE NOT NULL,
      period_months SMALLINT NOT NULL DEFAULT 12 CHECK (period_months IN (6, 12)),
      manual BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by BIGINT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS medbook_push_log (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires DATE NOT NULL,
      kind TEXT NOT NULL,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, expires, kind)
    );
  `);

  // Цвет удостоверения по виду обучения: у каждого курса свой (см. lib/cardColors.js).
  await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS card_color TEXT;`);

  // ВНЕШНИЙ курс: обучение проводила НЕ наша компания. По такому курсу нет теста, нашего протокола,
  // подписей комиссии, печати и сертификата — только удостоверение с датами и номером внешнего
  // протокола (assignments.protocol_number хранит его как обычный текст, в таблицу protocols он
  // не попадает и с нашими протоколами не смешивается). Нужен для учёта и отслеживания сроков.
  await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT FALSE;`);
  // ВИД КУРСА (course_kind): 'internal' — наш курс (тест, протокол, подписи, удостоверение);
  // 'external' — обучение провела другая организация (номер её протокола вносится как текст);
  // 'no_protocol' — курс, который оформляется без протокола вообще.
  // Для 'external' и 'no_protocol' удостоверение НЕ выпускается: обучение видно на странице по QR
  // (/p/<public_uid>) как «пройден» и входит в статистику. is_external остаётся флагом «без нашего
  // теста/протокола/удостоверения» и всегда = (course_kind <> 'internal').
  await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS course_kind TEXT NOT NULL DEFAULT 'internal';`);
  await pool.query(`UPDATE courses SET course_kind = 'external' WHERE is_external = TRUE AND course_kind = 'internal';`);
  await pool.query(`UPDATE courses SET is_external = (course_kind <> 'internal') WHERE is_external <> (course_kind <> 'internal');`);

  // КАТЕГОРИЯ НА ГЛАВНОЙ (main_group): 'biot' | 'internal' | 'external' — в какой из трёх категорий
  // курс показывается в «Статистике по курсам» на главной странице. Для существующих курсов
  // выводится из вида курса: internal → biot, no_protocol → internal, external → external.
  // Разовое заполнение трогает только курсы, где main_group ещё пуст, поэтому повторные запуски безопасны.
  await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS main_group TEXT;`);
  await pool.query(`UPDATE courses SET main_group = CASE course_kind
      WHEN 'internal' THEN 'biot'
      WHEN 'external' THEN 'external'
      ELSE 'internal' END
    WHERE main_group IS NULL;`);

  // Разовая раздача цветов существующим курсам — по порядку создания, разные, пока хватает палитры.
  try {
    const noColor = await pool.query('SELECT id FROM courses WHERE card_color IS NULL ORDER BY id');
    if (noColor.rows.length) {
      const used = (await pool.query('SELECT card_color FROM courses WHERE card_color IS NOT NULL')).rows.map((r) => r.card_color);
      const usedSet = new Set(used.map((c) => c.toUpperCase()));
      let n = usedSet.size;
      for (const c of noColor.rows) {
        const free = CARD_COLOR_PALETTE.find((x) => !usedSet.has(x.hex.toUpperCase()));
        const hex = free ? free.hex : CARD_COLOR_PALETTE[n % CARD_COLOR_PALETTE.length].hex;
        usedSet.add(hex.toUpperCase());
        n += 1;
        await pool.query('UPDATE courses SET card_color = $1 WHERE id = $2 AND card_color IS NULL', [hex, c.id]);
      }
      console.log(`[migrate] Заданы цвета удостоверений для ${noColor.rows.length} курсов`);
    }
  } catch (e) {
    console.error('Ошибка выдачи card_color:', e.message);
  }

  // Разовая раздача public_uid сотрудникам, созданным до этого обновления.
  try {
    const noUid = await pool.query('SELECT id FROM users WHERE public_uid IS NULL');
    let filled = 0;
    for (const u of noUid.rows) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await pool.query('UPDATE users SET public_uid = $1 WHERE id = $2 AND public_uid IS NULL', [generatePublicUid(), u.id]);
          filled += 1;
          break;
        } catch (e) {
          if (e.code !== '23505') throw e; // 23505 = коллизия уникального индекса, пробуем другой uid
        }
      }
    }
    if (filled) console.log(`[migrate] Выданы public_uid для ${filled} сотрудников`);
  } catch (e) {
    console.error('Ошибка выдачи public_uid:', e.message);
  }

  // Разовое заполнение full_name_normalized/full_name_translit для сотрудников,
  // созданных до этого обновления (новые записи заполняются сразу в routes/users.js).
  try {
    const toBackfill = await pool.query(
      `SELECT id, last_name, first_name FROM users WHERE full_name_normalized IS NULL`
    );
    for (const u of toBackfill.rows) {
      const { normalized, translit } = computeFioFields(u.last_name, u.first_name);
      await pool.query(
        `UPDATE users SET full_name_normalized = $1, full_name_translit = $2 WHERE id = $3`,
        [normalized, translit, u.id]
      );
    }
    if (toBackfill.rows.length) {
      console.log(`[migrate] Заполнены поля нормализации ФИО для ${toBackfill.rows.length} сотрудников`);
    }
  } catch (e) {
    console.error('Ошибка заполнения full_name_normalized/full_name_translit:', e.message);
  }

  const superLogin = process.env.SUPERADMIN_LOGIN || '8888';
  const superPass = process.env.SUPERADMIN_PASSWORD || '88885555';
  const existing = await pool.query('SELECT id FROM users WHERE login = $1', [superLogin]);
  if (existing.rows.length === 0) {
    const hash = bcrypt.hashSync(superPass, 10);
    await pool.query(
      `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role)
       VALUES ($1, $2, '', '', 'Суперадминистратор', $3, $4, 'superadmin')`,
      ['Super', 'Admin', superLogin, hash]
    );
    console.log(`[seed] Суперадмин создан в Supabase: логин=${superLogin}`);
  }

  // Сеем справочник должностей (SEED_POSITIONS выше) один раз — только если он ещё
  // пуст, чтобы ничего не затереть, если администратор уже успел завести свои значения.
  try {
    const posRow = await pool.query('SELECT positions_list FROM settings WHERE id = 1');
    const current = (posRow.rows[0] && posRow.rows[0].positions_list) || [];
    if (Array.isArray(current) && current.length === 0) {
      await pool.query('UPDATE settings SET positions_list = $1::jsonb WHERE id = 1', [JSON.stringify(SEED_POSITIONS)]);
      console.log(`[seed] Справочник «Должность» заполнен: ${SEED_POSITIONS.length} записей (ru/kz)`);
    }
  } catch (e) {
    console.error('Ошибка заполнения справочника должностей:', e.message);
  }

  await migrateOrgStructure();
}

// Одноразовая миграция «Объект → Отдел → Должность». Запускается только пока структура
// в настройках пуста (org_structure = []), поэтому повторные запуски сервера ничего не
// перезаписывают — дальше структуру ведёт суперадмин во вкладке «Настройки».
//  1) переименовывает отделы Admin / FM / HS (в справочнике, у сотрудников и в зонах
//     ассистентов) на Administration / Facility Maintenance (FM) / Hotel Services (HS);
//  2) заводит объект «Бирлик»;
//  3) закрепляет должности за отделами по файлу (lib/orgSeed.js);
//  4) отделы, которые уже были в справочнике, но которых нет в файле, не теряются —
//     переносятся в «Бирлик» без должностей.
async function migrateOrgStructure() {
  const client = await pool.connect();
  try {
    const cur = await client.query('SELECT departments_list, positions_list, objects_list, org_structure FROM settings WHERE id = 1');
    const row = cur.rows[0];
    if (!row) return;
    if (Array.isArray(row.org_structure) && row.org_structure.length > 0) return;

    const rename = (name) => {
      const key = String(name || '').trim().toLowerCase();
      return DEPARTMENT_RENAMES[key] || String(name || '').trim();
    };

    await client.query('BEGIN');

    // 1) переименование отделов
    const renamedUsers = await client.query(
      `UPDATE users SET department = CASE lower(btrim(department))
          WHEN 'admin' THEN $1::text WHEN 'fm' THEN $2::text WHEN 'hs' THEN $3::text END
       WHERE lower(btrim(department)) IN ('admin','fm','hs')`,
      [DEPARTMENT_RENAMES.admin, DEPARTMENT_RENAMES.fm, DEPARTMENT_RENAMES.hs]
    );
    await client.query(
      `UPDATE users SET assistant_departments = ARRAY(
          SELECT CASE lower(btrim(d)) WHEN 'admin' THEN $1::text WHEN 'fm' THEN $2::text WHEN 'hs' THEN $3::text ELSE d END
          FROM unnest(assistant_departments) WITH ORDINALITY AS t(d, ord) ORDER BY ord)
       WHERE EXISTS (SELECT 1 FROM unnest(assistant_departments) AS d WHERE lower(btrim(d)) IN ('admin','fm','hs'))`,
      [DEPARTMENT_RENAMES.admin, DEPARTMENT_RENAMES.fm, DEPARTMENT_RENAMES.hs]
    );
    const legacyDepartments = [...new Set(
      (Array.isArray(row.departments_list) ? row.departments_list : []).map(rename).filter(Boolean)
    )];

    // 2) объекты
    const objects = (Array.isArray(row.objects_list) ? row.objects_list : []).map(v => String(v || '').trim()).filter(Boolean);
    if (!objects.includes(SEED_OBJECT)) objects.unshift(SEED_OBJECT);

    // 3) должности в справочник (если вдруг чего-то не хватает) и структура по файлу
    const catalog = (Array.isArray(row.positions_list) ? row.positions_list : [])
      .map(p => ({ ru: String((typeof p === 'string' ? p : p && p.ru) || '').trim(), kz: String((p && typeof p === 'object' ? p.kz : '') || '').trim() }))
      .filter(p => p.ru);
    const have = new Set(catalog.map(p => p.ru));
    const departments = SEED_STRUCTURE.map(d => ({
      name: d.department,
      positions: d.positions.map(p => {
        if (!have.has(p.ru)) { catalog.push({ ru: p.ru, kz: p.kz }); have.add(p.ru); }
        return p.ru;
      })
    }));

    // 4) старые отделы, которых нет в файле, — в «Бирлик» без должностей
    const inStructure = new Set(departments.map(d => d.name));
    legacyDepartments.filter(n => !inStructure.has(n)).forEach(n => departments.push({ name: n, positions: [] }));

    const structure = [{ object: SEED_OBJECT, departments }];
    catalog.sort((a, b) => a.ru.localeCompare(b.ru, 'ru'));
    const allDepartments = [...new Set(departments.map(d => d.name))].sort((a, b) => a.localeCompare(b, 'ru'));

    await client.query(
      `UPDATE settings SET objects_list = $1::jsonb, org_structure = $2::jsonb,
              positions_list = $3::jsonb, departments_list = $4::jsonb WHERE id = 1`,
      [JSON.stringify(objects), JSON.stringify(structure), JSON.stringify(catalog), JSON.stringify(allDepartments)]
    );
    await client.query('COMMIT');
    console.log(`[migrate] Структура «Объект → Отдел → Должность»: объект «${SEED_OBJECT}», отделов: ${departments.length}; переименовано отделов у сотрудников: ${renamedUsers.rowCount}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Ошибка миграции структуры «Объект → Отдел → Должность»:', e.message);
  } finally {
    client.release();
  }
}

// Автовозврат из отпуска: когда дата окончания отпуска прошла, сотрудник снова становится
// действующим (active=1, employment_status='active'), даты отпуска очищаются.
async function restoreExpiredLeaves() {
  try {
    const r = await pool.query(
      `UPDATE users SET employment_status = 'active', active = 1, status_date = NULL, status_date_end = NULL,
              leave_reason = NULL, leave_note = NULL
       WHERE employment_status = 'maternity' AND status_date_end IS NOT NULL AND status_date_end < CURRENT_DATE
       RETURNING id`
    );
    return r.rowCount || 0;
  } catch (e) {
    console.error('restoreExpiredLeaves:', e.message);
    return 0;
  }
}

module.exports = { pool, query, initDb, restoreExpiredLeaves };
