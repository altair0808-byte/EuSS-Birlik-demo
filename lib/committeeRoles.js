// Роли комиссии по проверке знаний для электронного подписания протоколов
// (см. routes/signatures.js, routes/protocols.js, protocolPdf.js, routes/users.js).
// Порядок в массиве — порядок строк в блоке подписания протокола и в PDF.
const COMMITTEE_ROLES = ['chairman', 'biot_engineer', 'member'];

const COMMITTEE_ROLE_LABELS = {
  chairman: 'Председатель комиссии',
  biot_engineer: 'Инженер по БиОТ',
  member: 'Член комиссии (представитель работников)'
};

module.exports = { COMMITTEE_ROLES, COMMITTEE_ROLE_LABELS };
