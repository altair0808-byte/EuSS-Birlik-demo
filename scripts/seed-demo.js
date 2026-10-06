// Наполнение ДЕМО-базы вымышленными данными.
// Самый простой способ: на демо-сервисе добавить переменную DEMO_SEED=yes — Server.js сам
// вызовет runSeed() при старте (после создания таблиц). Повторные запуски безопасны.
// Вручную: DEMO_SEED=yes DATABASE_URL=<ДЕМО-база> node scripts/seed-demo.js
// Защита: без DEMO_SEED=yes ничего не делает; если в базе уже есть >30 сотрудников — отказывается
// (похоже на боевую базу).
const bcrypt = require('bcryptjs');

const OBJ = 'Бирлик';
const DEPTS = ['Administration', 'Facility Maintenance (FM)', 'Hotel Services (HS)'];
const NAMES = [
  ['Иванов', 'Алексей'], ['Петрова', 'Мария'], ['Сидоров', 'Дмитрий'], ['Ахметов', 'Ерлан'],
  ['Нурланова', 'Айгерим'], ['Касымов', 'Бауыржан'], ['Смирнова', 'Елена'], ['Жумабаев', 'Асхат'],
  ['Кузнецов', 'Сергей'], ['Оспанова', 'Динара'], ['Попов', 'Андрей'], ['Сатыбалдиев', 'Нурлан'],
  ['Волкова', 'Ирина'], ['Токтаров', 'Марат'], ['Морозов', 'Игорь'], ['Абилова', 'Гульнара'],
  ['Лебедев', 'Павел'], ['Серикбаев', 'Тимур'], ['Орлова', 'Наталья'], ['Дюсенов', 'Руслан'],
];
const POSITIONS = ['Делопроизводитель', 'Административный служащий', 'Главный электрик', 'Работник - Сантехник', 'Грузчик', 'Работник мастер'];
const COURSES = [
  { ru: 'Вводный инструктаж по ОТ (демо)', kz: 'ЕҚ бойынша кіріспе нұсқаулық (демо)', group: 'biot', months: 12 },
  { ru: 'Пожарная безопасность (демо)', kz: 'Өрт қауіпсіздігі (демо)', group: 'biot', months: 12 },
  { ru: 'Работа на высоте (демо)', kz: 'Биіктікте жұмыс (демо)', group: 'external', months: 24 },
  { ru: 'Сервис и стандарты компании (демо)', kz: 'Компания стандарттары (демо)', group: 'internal', months: 12 },
];
const QUESTIONS = [
  ['Что делать при обнаружении возгорания?', ['Сообщить и эвакуироваться', 'Игнорировать', 'Ждать указаний']],
  ['Нужна ли каска на производственной площадке?', ['Да, всегда', 'Нет', 'Только летом']],
  ['Куда сообщать о несчастном случае?', ['Непосредственному руководителю', 'Никому', 'Соседу']],
  ['Что означает зелёный знак?', ['Эвакуационный выход', 'Запрет', 'Опасность']],
  ['Как часто проходится повторный инструктаж?', ['По графику компании', 'Никогда', 'Раз в 10 лет']],
];
const iso = d => d.toISOString().slice(0, 10);
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

async function runSeed(pool) {
  if (process.env.DEMO_SEED !== 'yes') return;
  const cnt = (await pool.query("SELECT COUNT(*)::int n FROM users WHERE role='employee'")).rows[0].n;
  if (cnt > 30) { console.error(`[demo] В базе уже ${cnt} сотрудников — похоже на боевую. Отмена.`); return; }
  if (cnt > 0) { console.log('[demo] Демо-данные уже есть, пропускаю.'); return; }

  const hash = bcrypt.hashSync('demo1234', 10);
  // демо-администратор и ассистент
  await pool.query(`INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role)
    VALUES ('Демо','Администратор',$1,'Administration','Администратор','demo_admin',$2,'admin')
    ON CONFLICT (login) DO NOTHING`, [OBJ, hash]);

  const courseIds = [];
  for (const c of COURSES) {
    const r = await pool.query(
      `INSERT INTO courses (title_ru, title_kz, time_limit_minutes, pass_score_percent, validity_months, main_group)
       VALUES ($1,$2,10,60,$3,$4) RETURNING id`, [c.ru, c.kz, c.months, c.group]);
    const id = r.rows[0].id; courseIds.push(id);
    let i = 0;
    for (const [q, opts] of QUESTIONS) {
      await pool.query(
        `INSERT INTO questions (course_id, question_ru, question_kz, options_ru, options_kz, correct_index, sort_order, variant_number)
         VALUES ($1,$2,$2,$3,$3,0,$4,1)`, [id, q, JSON.stringify(opts), i++]);
    }
  }

  const userIds = [];
  for (let i = 0; i < NAMES.length; i++) {
    const [ln, fn] = NAMES[i];
    const login = 'demo' + String(i + 1).padStart(2, '0');
    const r = await pool.query(
      `INSERT INTO users (last_name, first_name, object, department, position, login, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'employee') RETURNING id`,
      [ln, fn, OBJ, DEPTS[i % 3], POSITIONS[i % POSITIONS.length], login, bcrypt.hashSync(login, 10)]);
    userIds.push(r.rows[0].id);
  }

  // назначения: разные статусы, чтобы на дашборде было что смотреть
  let n = 1;
  for (let u = 0; u < userIds.length; u++) {
    for (let c = 0; c < courseIds.length; c++) {
      const k = (u + c) % 5;               // 0 passed, 1 passed(скоро истекает), 2 pending, 3 failed, 4 passed(просрочено)
      const status = k === 2 ? 'pending' : k === 3 ? 'failed' : 'passed';
      const next = k === 1 ? addDays(14) : k === 4 ? addDays(-20) : addDays(200);
      const test = status === 'passed' ? addDays(-150) : null;
      await pool.query(
        `INSERT INTO assignments (user_id, course_id, protocol_number, protocol_date, status, score_percent, attempts_used, test_date, next_test_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [userIds[u], courseIds[c], 'DEMO-' + (n++), addDays(-150), status,
         status === 'passed' ? 80 : status === 'failed' ? 40 : null, status === 'pending' ? 0 : 1,
         test, status === 'passed' ? next : null]);
    }
  }
  console.log(`[demo] Готово: ${userIds.length} сотрудников, ${courseIds.length} курса. Админ: demo_admin / demo1234; сотрудники: demo01..demo20 (пароль = логин).`);
}

module.exports = { runSeed };

if (require.main === module) {
  require('dotenv').config();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  runSeed(pool).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
