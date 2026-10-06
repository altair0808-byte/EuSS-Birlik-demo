// Загрузка файлов (логотип, печать, подписи, материалы курсов, видео) в Supabase
// Storage вместо локального диска сервера и вместо base64 в колонках базы.
//
// Зачем: на большинстве хостингов (Render/Railway/Heroku-подобные) локальный диск
// сбрасывается при каждом redeploy — загруженные файлы терялись. Также хранение
// логотипа/печати/подписи как base64 прямо в таблице settings раздувало базу и
// заставляло всё передавать заново при каждом сохранении настроек. Теперь файл
// загружается в Supabase Storage один раз, а в базе хранится только его
// публичная ссылка (URL) — при повторном сохранении других настроек файл заново
// не загружается.
//
// Требуются переменные окружения:
//   SUPABASE_URL              — например https://xxxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — Service role key проекта (Project Settings → API)
// (Это ДРУГИЕ значения, чем DATABASE_URL — тот используется для прямого
// подключения к Postgres, а эти два нужны для обращения к Supabase Storage API.)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'app-uploads';

let client = null;
let bucketConfirmed = false; // ставим true ТОЛЬКО после подтверждённого успеха

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы в переменных окружения — загрузка файлов недоступна'
    );
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });
  }
  return client;
}

function isBucketMissingError(err) {
  const msg = (err && (err.message || err.error || '')).toString().toLowerCase();
  return msg.includes('bucket not found') || msg.includes('not_found') || msg.includes('does not exist');
}

// Пытается создать bucket. Не бросает ошибку, если bucket уже есть (в т.ч. если
// создан кем-то параллельно) — бросает только если создание реально не удалось
// по другой причине (например, недостаточно прав у ключа).
async function createBucketIfMissing() {
  const supabase = getClient();
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (error && !/already exists|duplicate/i.test(error.message || '')) {
    throw new Error(
      `Не удалось создать bucket "${BUCKET}" в Supabase Storage: ${error.message}. ` +
      'Проверьте, что SUPABASE_SERVICE_ROLE_KEY — это именно service_role ключ (не anon), ' +
      'либо создайте bucket вручную в Supabase Dashboard → Storage.'
    );
  }
  bucketConfirmed = true;
}

function safeExt(originalName) {
  const m = /\.[a-zA-Z0-9]+$/.exec(originalName || '');
  return m ? m[0].toLowerCase() : '';
}

// Загружает буфер в Supabase Storage и возвращает публичную ссылку.
// folder: логическая подпапка внутри bucket'а (logo/stamp/signature/materials/videos/...)
// Если bucket ещё не создан (или создание в прошлый раз не удалось), пытаемся
// создать его прямо сейчас и повторить загрузку один раз.
async function uploadBuffer(folder, originalName, buffer, mimetype) {
  const supabase = getClient();
  const key = `${folder}/${Date.now()}_${Math.round(Math.random() * 1e9)}${safeExt(originalName)}`;

  if (!bucketConfirmed) {
    await createBucketIfMissing();
  }

  let { error } = await supabase.storage.from(BUCKET).upload(key, buffer, {
    contentType: mimetype || 'application/octet-stream',
    upsert: false
  });

  if (error && isBucketMissingError(error)) {
    // Bucket пропал/не создался — пробуем создать ещё раз и повторить один раз.
    bucketConfirmed = false;
    await createBucketIfMissing();
    ({ error } = await supabase.storage.from(BUCKET).upload(key, buffer, {
      contentType: mimetype || 'application/octet-stream',
      upsert: false
    }));
  }

  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
  return { url: data.publicUrl, key };
}

// Удаляет файл по ранее сохранённому ключу (необязательно — используется, чтобы
// не копить в Storage файлы, замененные новыми).
async function removeByKey(key) {
  if (!key) return;
  try {
    const supabase = getClient();
    await supabase.storage.from(BUCKET).remove([key]);
  } catch (e) {
    console.error('Не удалось удалить старый файл из Supabase Storage:', e.message);
  }
}

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

module.exports = { uploadBuffer, removeByKey, isConfigured, BUCKET };
