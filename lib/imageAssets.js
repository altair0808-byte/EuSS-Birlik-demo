// Загрузка и подготовка изображений для бланков (логотип, печать, подпись).
// Логика — как в certificatePdf.js (data:image / https-ссылка Supabase / локальный файл;
// у печати и подписи белые поля становятся прозрачными и обрезаются), вынесена в модуль,
// чтобы её могли использовать и удостоверения (idCardPdf.js / idCardDocx.js).
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

let sharp = null;
try { sharp = require('sharp'); } catch (e) {
  console.warn('[imageAssets] пакет sharp не найден — печать и подпись вставляются как есть (без автообрезки полей)');
}

function fetchRemoteBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) {
        resp.resume();
        return reject(new Error('HTTP ' + resp.statusCode + ' for ' + url));
      }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks)));
      resp.on('error', reject);
    }).on('error', reject);
  });
}

async function resolveImageBuffer(imgVal) {
  if (!imgVal || typeof imgVal !== 'string') return null;
  try {
    if (imgVal.startsWith('data:image')) {
      const idx = imgVal.indexOf('base64,');
      if (idx !== -1) return Buffer.from(imgVal.slice(idx + 7), 'base64');
    }
    if (/^https?:\/\//i.test(imgVal)) return await fetchRemoteBuffer(imgVal);
    const localPath = path.join(__dirname, '..', imgVal.replace(/^\//, ''));
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
  } catch (e) {
    console.error('Error resolving image buffer:', e.message);
  }
  return null;
}

const cache = new Map();

// Белая «бумага» вокруг печати/подписи -> прозрачная, лишние поля обрезаются.
async function trimStampLikeImage(buf, cacheKey) {
  if (!sharp || !buf) return buf;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
  try {
    const { data, info } = await sharp(buf, { limitInputPixels: 50e6 })
      .rotate()
      .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const at = (x, y) => (y * width + x) * 4;
    const isPaper = (i) => data[i + 3] > 200 && Math.min(data[i], data[i + 1], data[i + 2]) >= 225;
    const paperCorners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)].filter(isPaper).length;
    if (paperCorners >= 3) {
      for (let i = 0; i < data.length; i += 4) {
        const m = Math.min(data[i], data[i + 1], data[i + 2]);
        if (m >= 235) data[i + 3] = 0;
        else if (m > 190) data[i + 3] = Math.round(data[i + 3] * (235 - m) / 45);
      }
    }
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 40) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return buf;
    const pad = 2;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const cw = Math.min(width, maxX + pad + 1) - left;
    const ch = Math.min(height, maxY + pad + 1) - top;
    const out = await sharp(data, { raw: { width, height, channels: 4 } })
      .extract({ left, top, width: cw, height: ch }).png().toBuffer();
    if (cacheKey) {
      if (cache.size > 12) cache.clear();
      cache.set(cacheKey, out);
    }
    return out;
  } catch (e) {
    console.error('Не удалось подготовить изображение печати/подписи, используется исходное:', e.message);
    return buf;
  }
}

async function resolveCleanImage(imgVal) {
  const buf = await resolveImageBuffer(imgVal);
  if (!buf) return null;
  const key = /^https?:\/\//i.test(imgVal || '') ? imgVal : null;
  return trimStampLikeImage(buf, key);
}

module.exports = { resolveImageBuffer, resolveCleanImage };
