// Нормализация и транслитерация ФИО (п.9 доработки: «Сотрудники и защита от дублей»).
//
// Задача: «УТЯШЕВ АЛТАИР», «утяшев алтаир» и «Утяшев Алтаир» должны считаться
// одной и той же записью, а поиск — одинаково находить сотрудника и по
// русскому написанию, и по английской транслитерации («Utyashev», «Altair»).
//
// Транслитерация — не перевод (Привет -> Privet, а не Hello): используется
// таблица соответствия букв ГОСТ 7.79-2000 (система Б) / близкая к загранпаспортной,
// плюс казахские буквы (әғқңөұүhі), т.к. в системе встречаются казахские ФИО.

const TRANSLIT_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Казахские буквы
  ә: 'a', ғ: 'gh', қ: 'q', ң: 'ng', ө: 'o', ұ: 'u', ү: 'u', h: 'h', і: 'i'
};

/**
 * Приводит ФИО (или любую строку) к единому формату для сравнения:
 * нижний регистр, ё -> е, схлопнутые пробелы, обрезка краёв.
 * "УТЯШЕВ   Алтаир" -> "утяшев алтаир"
 */
function normalizeFio(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Транслитерирует кириллическую строку в латиницу побуквенно (не перевод).
 * "Утяшев Алтаир" -> "Utyashev Altair"
 */
function transliterate(str) {
  const s = String(str || '');
  let out = '';
  for (const ch of s) {
    const lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(TRANSLIT_MAP, lower)) {
      out += TRANSLIT_MAP[lower];
    } else {
      out += ch;
    }
  }
  // Капитализация первой буквы каждого слова — как в примере из ТЗ (Utyashev Altair)
  return out.replace(/(^|\s)([a-z])/g, (m, sep, c) => sep + c.toUpperCase());
}

/**
 * Строит вспомогательные поля для поиска/дедупа по фамилии+имени сотрудника:
 * - normalized: "фамилия имя" в нижнем регистре, для точного сравнения дублей;
 * - translit: латинская транслитерация "Фамилия Имя", для поиска по-английски.
 */
function computeFioFields(lastName, firstName) {
  const full = `${lastName || ''} ${firstName || ''}`.trim();
  return {
    normalized: normalizeFio(full),
    translit: transliterate(full)
  };
}

module.exports = { normalizeFio, transliterate, computeFioFields };

// ---------------------------------------------------------------------------
// Защита от дублей сотрудников.
//
// Два уровня совпадения:
//  - 'strong'   — это почти наверняка один человек: те же слова в другом регистре / порядке
//                 («Иван Иванов» = «Иванов Иван»), русское и латинское написание
//                 («Утяшев Алтаир» = «Utyashev Altair»), казахские буквы вместо русских
//                 (Қасымов = Касымов), ё/е, лишнее отчество. Новая запись блокируется.
//  - 'possible' — очень похоже: отличие в 1–2 символа (опечатка, «Utiashev» вместо «Utyashev»,
//                 «Aleksandr» вместо «Alexander»). Админ может подтвердить, что это другой человек.
// Отдел/объект/должность в сравнении не участвуют — сотрудник мог перейти в другой отдел.
// ---------------------------------------------------------------------------

// Казахские буквы -> ближайшие русские (для сравнения, не для отображения)
const KZ_TO_RU = { ә: 'а', ғ: 'г', қ: 'к', ң: 'н', ө: 'о', ұ: 'у', ү: 'у', һ: 'х', і: 'и' };

function stripMarks(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function collapseRepeats(s) {
  return s.replace(/(.)\1+/g, '$1');
}

// «Мягкий» ключ слова: кириллица -> латиница по таблице, казахские буквы приведены к русским,
// й = и, повторы букв схлопнуты, всё кроме букв выброшено.
function mildKey(token) {
  let s = String(token || '').toLowerCase().replace(/ё/g, 'е').replace(/й/g, 'и');
  s = s.replace(/[әғқңөұүһі]/g, ch => KZ_TO_RU[ch] || ch);
  let out = '';
  for (const ch of s) {
    out += Object.prototype.hasOwnProperty.call(TRANSLIT_MAP, ch) ? TRANSLIT_MAP[ch] : ch;
  }
  out = stripMarks(out).replace(/[^a-z]/g, '');
  return collapseRepeats(out);
}

// «Жёсткий» ключ: сводит разные латинские написания одного звука к одному
// (ya/ia/ja, kh/h, sh/sch/shch, ts/c, y/i/j, x=ks, w=v, q=k и т.д.)
function looseKey(token) {
  let s = mildKey(token);
  s = s.replace(/shch|sch|tch/g, 's')
       .replace(/zh/g, 'z').replace(/sh/g, 's').replace(/ch/g, 'c').replace(/kh/g, 'h').replace(/gh/g, 'g')
       .replace(/ts/g, 'c').replace(/ph/g, 'f').replace(/ck/g, 'k')
       .replace(/q/g, 'k').replace(/x/g, 'ks').replace(/w/g, 'v')
       .replace(/[yj]/g, 'i');
  s = collapseRepeats(s);
  s = s.replace(/i(?=[aeou])/g, ''); // ia/iu/io/ie после y->i: «Utiashev» ~ «Utyashev»
  return collapseRepeats(s);
}

// Слова ФИО: дефис и точки считаем пробелами; пустые отбрасываем
function nameTokens(lastName, firstName) {
  return `${lastName || ''} ${firstName || ''}`
    .toLowerCase()
    .replace(/[-–—.,_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Расстояние Дамерау–Левенштейна (вставка/удаление/замена/перестановка соседних = 1)
function editDistance(a, b) {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d = [];
  for (let i = 0; i <= n; i++) { d.push(new Array(m + 1).fill(0)); d[i][0] = i; }
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[n][m];
}

// Сколько отличий допустимо в одном слове: короткие слова («Ли», «Ян») почти не прощаем
function allowedTokenDistance(len) {
  if (len <= 2) return 0;
  if (len <= 4) return 1;
  return 2;
}

// Перебор перестановок (слов в ФИО 2–4, так что дёшево)
function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((x, i) => {
    permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach(p => out.push([x].concat(p)));
  });
  return out;
}

// Сопоставляет слова меньшего набора со словами большего (порядок не важен).
// Возвращает минимальные (total, maxToken, ok) по ключам keyFn либо null.
function bestAssignment(small, large, keyFn, distFn) {
  const sk = small.map(keyFn);
  const lk = large.map(keyFn);
  let best = null;
  const idx = lk.map((_, i) => i);
  // выбираем для каждого слова из small отдельное слово из large
  const pick = (pos, used, total, maxTok, ok) => {
    if (!ok) return;
    if (pos === sk.length) {
      if (!best || total < best.total) best = { total, maxTok };
      return;
    }
    for (const j of idx) {
      if (used.has(j)) continue;
      const dist = distFn(sk[pos], lk[j]);
      const limit = allowedTokenDistance(Math.min(sk[pos].length, lk[j].length));
      used.add(j);
      pick(pos + 1, used, total + dist, Math.max(maxTok, dist), dist <= limit);
      used.delete(j);
    }
  };
  pick(0, new Set(), 0, 0, true);
  return best;
}

/**
 * Сравнивает два ФИО. Возвращает 'strong', 'possible' или null.
 * Порядок слов не важен, язык написания (рус/лат/каз) не важен.
 */
function compareFio(a, b) {
  const ta = nameTokens(a.last_name, a.first_name);
  const tb = nameTokens(b.last_name, b.first_name);
  if (!ta.length || !tb.length) return null;
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  // Меньший набор должен содержать минимум 2 слова (фамилия + имя); иначе «Иван» совпадёт с любым Иваном
  if (small.length < 2) return null;

  const mild = bestAssignment(small, large, mildKey, (x, y) => (x === y ? 0 : 99));
  if (mild && mild.total === 0) return 'strong';

  const loose = bestAssignment(small, large, looseKey, editDistance);
  if (loose && loose.total <= 2) return loose.total === 0 ? 'possible' : 'possible';
  return null;
}

module.exports.mildKey = mildKey;
module.exports.looseKey = looseKey;
module.exports.editDistance = editDistance;
module.exports.compareFio = compareFio;
