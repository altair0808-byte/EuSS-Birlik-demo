// Разбирает значение query-параметра фильтра, которое теперь может быть не только
// одним значением, но и несколькими, через запятую (мульти-выбор объектов/отделов/
// должностей/статусов на фронте — см. index.html, компонент multiSelect). Раньше везде
// был просто `req.query.object` (одно значение) — теперь `splitMulti(req.query.object)`
// возвращает массив, который подставляется в SQL через `= ANY($n::text[])` вместо `= $n`.
// Совместимо со старыми ссылками/закладками с одним значением — просто массив из одного элемента.
function splitMulti(val) {
  if (val === undefined || val === null || val === '') return [];
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
  return String(val).split(',').map(v => v.trim()).filter(Boolean);
}

// Зона видимости роли "ассистент" (руководитель/табельщик/координатор, ТЗ: роли/ИИН/
// PDF=копия Word, §4): суперадмин выдаёт ассистенту список объектов и/или отделов
// (users.assistant_objects / assistant_departments), внутри которых он видит сотрудников,
// протоколы, сертификаты. Если у ассистента не выбран ни один объект/отдел — доступа нет
// (безопасный дефолт), а не "доступ ко всем".
//
// requestedObjects/requestedDepartments — то, что пользователь сам выбрал в фильтре UI
// (уже через splitMulti()). Для admin/superadmin возвращаются как есть (без ограничений).
// Для assistant — пересекаются с его зоной; noAccess=true означает "зона не выдана",
// вызывающий код должен вернуть пустой список без обращения к БД.
function scopedFilter(user, requestedObjects, requestedDepartments) {
  requestedObjects = requestedObjects || [];
  requestedDepartments = requestedDepartments || [];
  if (!user || user.role !== 'assistant') {
    return { objects: requestedObjects, departments: requestedDepartments, noAccess: false };
  }
  const zoneObjects = Array.isArray(user.assistant_objects) ? user.assistant_objects : [];
  const zoneDepartments = Array.isArray(user.assistant_departments) ? user.assistant_departments : [];
  if (zoneObjects.length === 0 && zoneDepartments.length === 0) {
    return { objects: [], departments: [], noAccess: true };
  }
  const objects = requestedObjects.length
    ? (zoneObjects.length ? requestedObjects.filter(o => zoneObjects.includes(o)) : requestedObjects)
    : zoneObjects;
  const departments = requestedDepartments.length
    ? (zoneDepartments.length ? requestedDepartments.filter(d => zoneDepartments.includes(d)) : requestedDepartments)
    : zoneDepartments;
  return { objects, departments, noAccess: false };
}

module.exports = { splitMulti, scopedFilter };
