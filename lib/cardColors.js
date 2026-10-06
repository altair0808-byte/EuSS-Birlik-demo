// Цвет удостоверения по виду обучения (courses.card_color).
// Хранится как #RRGGBB. Палитра — только стартовый набор: цвет любого курса можно
// поменять в карточке курса. Цвета подобраны тёмными, чтобы белый текст на плашках
// бланка оставался читаемым.
const CARD_COLOR_PALETTE = [
  { hex: '#1D4ED8', name: 'Синий' },
  { hex: '#15803D', name: 'Зелёный' },
  { hex: '#C2410C', name: 'Оранжевый' },
  { hex: '#B91C1C', name: 'Красный' },
  { hex: '#6D28D9', name: 'Фиолетовый' },
  { hex: '#0F766E', name: 'Бирюзовый' },
  { hex: '#A16207', name: 'Золотистый' },
  { hex: '#BE185D', name: 'Розовый' },
  { hex: '#334155', name: 'Графитовый' },
  { hex: '#0369A1', name: 'Голубой' },
  { hex: '#4D7C0F', name: 'Оливковый' },
  { hex: '#7C2D12', name: 'Коричневый' }
];

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

function isValidCardColor(v) {
  return typeof v === 'string' && HEX_RE.test(v.trim());
}

// Приводит значение из запроса к #RRGGBB (верхний регистр) или null, если оно не задано/некорректно.
function normalizeCardColor(v) {
  return isValidCardColor(v) ? v.trim().toUpperCase() : null;
}

// Первый цвет палитры, которого нет среди usedColors; если все заняты — по кругу.
function pickFreeColor(usedColors) {
  const used = new Set((usedColors || []).map((c) => String(c || '').toUpperCase()));
  const free = CARD_COLOR_PALETTE.find((c) => !used.has(c.hex.toUpperCase()));
  if (free) return free.hex;
  return CARD_COLOR_PALETTE[(used.size) % CARD_COLOR_PALETTE.length].hex;
}

module.exports = { CARD_COLOR_PALETTE, isValidCardColor, normalizeCardColor, pickFreeColor };
