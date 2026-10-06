// Стаж работы в компании: от даты начала работы (users.hire_date, 'YYYY-MM-DD') до сегодняшнего дня
// (по времени Алматы). Возвращает { years, months, days, totalDays } или null, если даты нет / она в будущем.
function almatyToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  return { y: parts[0], m: parts[1], d: parts[2] };
}

function calcTenure(hireDate) {
  const m = String(hireDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const h = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const t = almatyToday();
  const hUtc = Date.UTC(h.y, h.m - 1, h.d);
  const tUtc = Date.UTC(t.y, t.m - 1, t.d);
  if (tUtc < hUtc) return null;
  let years = t.y - h.y;
  let months = t.m - h.m;
  let days = t.d - h.d;
  if (days < 0) {
    months -= 1;
    // дней в предыдущем месяце относительно сегодняшней даты
    days += new Date(Date.UTC(t.y, t.m - 1, 0)).getUTCDate();
  }
  if (months < 0) { years -= 1; months += 12; }
  return { years, months, days, totalDays: Math.round((tUtc - hUtc) / 86400000) };
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Текст стажа: «2 года 3 месяца 5 дней» (ru) / «2 жыл 3 ай 5 күн» (kz).
// Нулевые части пропускаются; если всё по нулям — «менее 1 дня» / «1 күннен аз».
function formatTenure(hireDate, lang) {
  const t = calcTenure(hireDate);
  if (!t) return '';
  const kz = lang === 'kz';
  const parts = [];
  if (kz) {
    if (t.years) parts.push(`${t.years} жыл`);
    if (t.months) parts.push(`${t.months} ай`);
    if (t.days || !parts.length) parts.push(`${t.days} күн`);
  } else {
    if (t.years) parts.push(`${t.years} ${plural(t.years, 'год', 'года', 'лет')}`);
    if (t.months) parts.push(`${t.months} ${plural(t.months, 'месяц', 'месяца', 'месяцев')}`);
    if (t.days || !parts.length) parts.push(`${t.days} ${plural(t.days, 'день', 'дня', 'дней')}`);
  }
  return parts.join(' ');
}

// Короткая форма для удостоверения: «2 г. 3 мес. 5 дн.»
function formatTenureShort(hireDate) {
  const t = calcTenure(hireDate);
  if (!t) return '';
  const parts = [];
  if (t.years) parts.push(`${t.years} г.`);
  if (t.months) parts.push(`${t.months} мес.`);
  if (t.days || !parts.length) parts.push(`${t.days} дн.`);
  return parts.join(' ');
}

module.exports = { calcTenure, formatTenure, formatTenureShort };
