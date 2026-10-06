// Минимальный клиент Google Drive (REST API v3) — без новых npm-зависимостей:
// только глобальный fetch (Node 18+; в Dockerfile Node 20) и уже установленный jsonwebtoken.
//
// Два способа авторизации (достаточно одного):
//
//  1) СЕРВИСНЫЙ АККАУНТ (рекомендуется, если у организации Google Workspace и есть Общий диск):
//       GDRIVE_SERVICE_ACCOUNT_JSON  — содержимое JSON-ключа (можно base64)
//     Сервисный аккаунт НЕ имеет своего места в Диске, поэтому корневая папка должна лежать на
//     ОБЩЕМ ДИСКЕ (Shared Drive), куда сервисный аккаунт добавлен участником. Иначе Google
//     отвечает «storageQuotaExceeded» при первой же загрузке.
//
//  2) OAUTH ОБЫЧНОГО АККАУНТА (личный gmail или пользователь Workspace без Общего диска):
//       GDRIVE_OAUTH_CLIENT_ID, GDRIVE_OAUTH_CLIENT_SECRET, GDRIVE_OAUTH_REFRESH_TOKEN
//     Файлы создаются от имени этого пользователя и занимают его место в Диске.
//
// Общее:
//   GDRIVE_ROOT_FOLDER_ID — id папки, внутри которой сайт создаёт «Протоколы» и папки объектов
//                           (последняя часть ссылки .../folders/<ЭТО>).
const jwt = require('jsonwebtoken');

const SCOPE = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const REQUEST_TIMEOUT_MS = 90 * 1000;

let tokenCache = { token: null, expiresAt: 0 };
const folderCache = new Map(); // "rootId/сегмент/сегмент" -> id папки

function parseServiceAccount() {
  const raw = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text.startsWith('{')) {
    try { text = Buffer.from(text, 'base64').toString('utf8'); } catch (e) { /* ниже упадёт на JSON.parse */ }
  }
  const sa = JSON.parse(text);
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GDRIVE_SERVICE_ACCOUNT_JSON: в ключе нет client_email / private_key');
  }
  // Ключ в переменных окружения часто приходит с литеральными "\n"
  sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
  return sa;
}

function authMode() {
  if (process.env.GDRIVE_SERVICE_ACCOUNT_JSON) return 'service_account';
  if (process.env.GDRIVE_OAUTH_CLIENT_ID && process.env.GDRIVE_OAUTH_CLIENT_SECRET && process.env.GDRIVE_OAUTH_REFRESH_TOKEN) {
    return 'oauth';
  }
  return null;
}

function rootFolderId() {
  return String(process.env.GDRIVE_ROOT_FOLDER_ID || '').trim();
}

function isConfigured() {
  return Boolean(authMode() && rootFolderId());
}

class DriveError extends Error {
  constructor(message, { status, reason } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status || null;
    this.reason = reason || null;
  }
}

async function fetchWithTimeout(url, opts = {}) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    // сеть / таймаут / DNS — «облако недоступно»; очередь повторит позже
    throw new DriveError(`Нет связи с Google: ${e.message}`, { status: 0, reason: 'network' });
  }
}

async function requestToken() {
  const mode = authMode();
  let body;
  let tokenUrl;
  if (mode === 'service_account') {
    const sa = parseServiceAccount();
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
      sa.private_key,
      { algorithm: 'RS256' }
    );
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    tokenUrl = sa.token_uri || 'https://oauth2.googleapis.com/token';
  } else if (mode === 'oauth') {
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.GDRIVE_OAUTH_CLIENT_ID,
      client_secret: process.env.GDRIVE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GDRIVE_OAUTH_REFRESH_TOKEN
    });
    tokenUrl = 'https://oauth2.googleapis.com/token';
  } else {
    throw new DriveError('Google Drive не настроен (см. env.example: GDRIVE_*)', { reason: 'not_configured' });
  }

  const res = await fetchWithTimeout(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new DriveError(
      `Google не выдал токен доступа: ${data.error_description || data.error || res.status}`,
      { status: res.status, reason: 'auth' }
    );
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + Math.max(60, (data.expires_in || 3600) - 120) * 1000 };
  return tokenCache.token;
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  return requestToken();
}

// Один запрос к Drive с авто-обновлением токена при 401 и понятными ошибками.
async function driveFetch(url, opts = {}, retriedAuth = false) {
  const token = await getToken();
  const res = await fetchWithTimeout(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (res.status === 401 && !retriedAuth) {
    tokenCache = { token: null, expiresAt: 0 };
    return driveFetch(url, opts, true);
  }
  if (!res.ok) {
    let reason = '';
    let message = '';
    try {
      const j = await res.json();
      const e = j.error || {};
      message = e.message || '';
      reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
    } catch (e) { /* тело не JSON */ }
    let hint = '';
    if (reason === 'storageQuotaExceeded') {
      hint = ' — у сервисного аккаунта нет своего места в Диске: корневая папка должна быть на Общем диске, куда он добавлен (или используйте OAuth-авторизацию обычного аккаунта)';
    } else if (res.status === 404) {
      hint = ' — папка/файл не найдены или у аккаунта нет к ним доступа (проверьте GDRIVE_ROOT_FOLDER_ID и доступ)';
    }
    throw new DriveError(`Google Drive ${res.status}${reason ? ' ' + reason : ''}: ${message || 'ошибка'}${hint}`, { status: res.status, reason });
  }
  return res;
}

// Экранирование значения в строке запроса Drive: q="name = 'X'"
function qEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Имя файла/папки безопасно для Drive и читаемо: без слэшей/управляющих, без пустого результата.
function sanitizeName(s, fallback = 'Без названия') {
  const cleaned = String(s == null ? '' : s)
    .replace(/[\\/\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned || fallback;
}

const LIST_PARAMS = 'supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives';

async function findFolder(parentId, name) {
  const q = `name = '${qEscape(name)}' and '${qEscape(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const res = await driveFetch(`${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name)')}&pageSize=10&orderBy=createdTime&${LIST_PARAMS}`);
  const data = await res.json();
  return (data.files && data.files[0]) ? data.files[0].id : null;
}

async function createFolder(parentId, name) {
  const res = await driveFetch(`${API}/files?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
  });
  const data = await res.json();
  return data.id;
}

// Создаёт цепочку папок root/seg1/seg2/... (существующие переиспользует) и возвращает id последней.
// Вызывать нужно из ОДНОГО воркера (см. driveSync.js: последовательная обработка + advisory-lock),
// иначе два параллельных вызова могут создать две одноимённые папки.
async function ensureFolderPath(segments) {
  let parent = rootFolderId();
  if (!parent) throw new DriveError('Не задан GDRIVE_ROOT_FOLDER_ID', { reason: 'not_configured' });
  let keyPath = parent;
  for (const raw of segments) {
    const name = sanitizeName(raw);
    keyPath += '/' + name;
    let id = folderCache.get(keyPath);
    if (!id) {
      id = await findFolder(parent, name);
      if (!id) id = await createFolder(parent, name);
      folderCache.set(keyPath, id);
    }
    parent = id;
  }
  return parent;
}

function clearFolderCache() {
  folderCache.clear();
}

// Файл, ранее загруженный сайтом под этим ключом (защита от дублей при повторной отправке:
// если прошлая попытка дошла до Google, но ответ потерялся, повтор ОБНОВИТ файл, а не создаст копию).
// Ключ хранится в appProperties — они видны только тому же приложению/сервисному аккаунту.
async function findFileByKey(key) {
  const q = `appProperties has { key='euss_key' and value='${qEscape(key)}' } and trashed = false`;
  const res = await driveFetch(`${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name,parents)')}&pageSize=5&${LIST_PARAMS}`);
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

function multipartBody(metadata, content, mimeType) {
  const boundary = 'euss_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  return { body: Buffer.concat([head, content, tail]), contentType: `multipart/related; boundary=${boundary}` };
}

// Загружает буфер в папку path (массив сегментов от корня). Идемпотентно по key.
// Возвращает { fileId, folderId }.
async function uploadFile({ key, segments, fileName, buffer, mimeType }) {
  const name = sanitizeName(fileName, 'file');
  let attemptedRecovery = false;
  // При 404 на родителе (папку удалили вручную) сбрасываем кэш папок и пробуем один раз заново.
  for (;;) {
    const folderId = await ensureFolderPath(segments);
    try {
      const existing = await findFileByKey(key);
      if (existing) {
        const { body, contentType } = multipartBody({ name }, buffer, mimeType);
        await driveFetch(`${UPLOAD}/files/${existing.id}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
          method: 'PATCH', headers: { 'Content-Type': contentType }, body
        });
        return { fileId: existing.id, folderId, updated: true };
      }
      const { body, contentType } = multipartBody(
        { name, parents: [folderId], appProperties: { euss_key: key } }, buffer, mimeType
      );
      const res = await driveFetch(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {
        method: 'POST', headers: { 'Content-Type': contentType }, body
      });
      const data = await res.json();
      return { fileId: data.id, folderId, updated: false };
    } catch (e) {
      if (e instanceof DriveError && e.status === 404 && !attemptedRecovery) {
        attemptedRecovery = true;
        clearFolderCache();
        continue;
      }
      throw e;
    }
  }
}

// Проверка доступа к корневой папке (для кнопки «Проверить подключение»).
async function checkAccess() {
  if (!isConfigured()) throw new DriveError('Google Drive не настроен (см. env.example: GDRIVE_*)', { reason: 'not_configured' });
  const res = await driveFetch(`${API}/files/${encodeURIComponent(rootFolderId())}?supportsAllDrives=true&fields=${encodeURIComponent('id,name,mimeType,driveId,capabilities(canAddChildren)')}`);
  const f = await res.json();
  if (f.mimeType !== FOLDER_MIME) throw new DriveError('GDRIVE_ROOT_FOLDER_ID указывает не на папку');
  if (f.capabilities && f.capabilities.canAddChildren === false) {
    throw new DriveError('У аккаунта нет прав добавлять файлы в корневую папку (нужна роль «Редактор»)');
  }
  return { name: f.name, sharedDrive: Boolean(f.driveId), mode: authMode() };
}

module.exports = {
  isConfigured, authMode, DriveError, sanitizeName, ensureFolderPath, uploadFile, checkAccess, clearFolderCache,
  _internal: { qEscape, multipartBody }
};
