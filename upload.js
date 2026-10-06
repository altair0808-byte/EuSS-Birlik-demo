const multer = require('multer');
const path = require('path');
const fs = require('fs');

// options: { maxSizeMB, fileFilter(req, file, cb) }
// Оставлено для обратной совместимости / временных файлов (например, Excel-импорт
// читается один раз сразу после загрузки и на диске больше не нужен).
function makeUploader(subdir, options = {}) {
  const dest = path.join(__dirname, 'uploads', subdir);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, dest),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = `${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`;
      cb(null, name);
    }
  });
  const maxSizeMB = options.maxSizeMB || 25;
  return multer({
    storage,
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
    fileFilter: options.fileFilter
  });
}

// Загрузка в память (буфер), без записи на диск сервера — используется для всего,
// что должно попасть в Supabase Storage (логотип, печать, подписи, материалы,
// видео курсов, импорт Excel). Так файл ни разу не касается локального
// (эфемерного) диска сервера.
function makeMemoryUploader(options = {}) {
  const maxSizeMB = options.maxSizeMB || 25;
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
    fileFilter: options.fileFilter
  });
}

module.exports = { makeUploader, makeMemoryUploader };
