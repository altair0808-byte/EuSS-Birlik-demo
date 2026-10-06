// Вспомогательные функции бланка удостоверения (общие для PDF и Word):
// цвета, даты, статусы, имя председателя, выбор подписанта комиссии.
const DEFAULT_COLOR = '#1D4ED8';

function hexToRgb(hex) {
  const h = String(hex || DEFAULT_COLOR).replace('#', '');
  const n = parseInt(h.length === 6 ? h : '1D4ED8', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
// mix(a, b, t): t=0 -> a, t=1 -> b
function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
function cardPalette(cardColor) {
  const base = /^#[0-9A-Fa-f]{6}$/.test(String(cardColor || '')) ? cardColor.toUpperCase() : DEFAULT_COLOR;
  return {
    base,
    dark: mix(base, '#0B1B33', 0.45),   // заголовки
    soft: mix(base, '#FFFFFF', 0.86),   // фон боковой полосы, шапки таблицы
    mid: mix(base, '#FFFFFF', 0.55),    // ромбы
    line: mix(base, '#FFFFFF', 0.70)    // тонкие линии
  };
}

function toDateOnly(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function fmtDate(v) {
  const s = toDateOnly(v);
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
}
// «Сформировано» — по времени Казахстана
function todayKz() {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
}

const STATUS = {
  VALID:   { kz: 'ЖАРАМДЫ', ru: 'ДЕЙСТВИТЕЛЬНО', en: 'VALID', fg: '#0F7A3C', bg: '#E8F6EE', border: '#7CC49A', pill: 'ДЕЙСТВИТЕЛЬНО' },
  EXPIRED: { kz: 'МЕРЗІМІ АЯҚТАЛДЫ', ru: 'СРОК ИСТЁК', en: 'EXPIRED', fg: '#B45309', bg: '#FFF4E0', border: '#F0C27B', pill: 'СРОК ИСТЁК' },
  REVOKED: { kz: 'ЖОЙЫЛДЫ', ru: 'АННУЛИРОВАНО', en: 'REVOKED', fg: '#B91C1C', bg: '#FDECEC', border: '#F0A5A5', pill: 'АННУЛИРОВАНО' }
};

// «Иванов Иван Иванович» -> «Иванов И.И.»; уже сокращённое («Иванов И.И.») не трогаем.
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  const initials = parts.slice(1).map((p) => (p.includes('.') ? p : p[0].toUpperCase() + '.')).join('');
  return `${parts[0]} ${initials}`;
}

// Председатель для бланка.
//  • есть протокол (committeeSignatures — массив из getCommitteeSignaturesForProtocol):
//    берём председателя ИЗ ПРОТОКОЛА; если он ещё не подписал — бланк не выдаётся
//    (ошибка с code = 'protocol_not_signed');
//  • протокола нет (историческая запись) — председатель из «Настроек», как на сертификате.
function resolveChairman(settings, committeeSignatures) {
  const s = settings || {};
  if (Array.isArray(committeeSignatures)) {
    const ch = committeeSignatures.find((m) => m.role === 'chairman');
    if (!ch || !ch.signed) {
      const err = new Error('Протокол ещё не подписан председателем комиссии — удостоверение будет доступно после подписания.');
      err.code = 'protocol_not_signed';
      throw err;
    }
    return { name: shortName(ch.name), signature_data: ch.signature_data || null, fromProtocol: true };
  }
  const second = parseInt(s.active_chairman, 10) === 2;
  return {
    name: shortName(second ? s.chairman2_name : (s.chairman1_name || s.chairman_name)),
    signature_data: second ? s.chairman2_signature : s.chairman1_signature,
    fromProtocol: false
  };
}

// Печать на бланке удостоверения (координаты в пикселях макета 1280x905). Раньше 146x146 в точке
// (450; 692). Теперь 219x219 (x1.5) в точке (387; 638): правый край (606) не доходит до текста
// «Актуальный статус — по QR-коду» (x=608), верх (638) — ниже таблицы (её низ y=628).
const CARD_STAMP = { x: 387, y: 638, size: 219 };

module.exports = { CARD_STAMP, cardPalette, fmtDate, toDateOnly, todayKz, STATUS, shortName, resolveChairman, mix, DEFAULT_COLOR };
