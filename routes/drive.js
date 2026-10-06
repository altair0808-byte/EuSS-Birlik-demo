// Запасное хранилище в Google Drive — управление (только суперадмин). Сама выгрузка идёт в фоне: driveSync.js.
//   GET  /api/drive/status      — настроено ли, счётчики очереди, последние проблемы
//   POST /api/drive/check       — проверка доступа к корневой папке
//   POST /api/drive/export-all  — «Выгрузить всё, что уже есть» (протоколы + удостоверения задним числом)
//   POST /api/drive/retry       — вернуть в очередь задачи, исчерпавшие попытки
const express = require('express');
const router = express.Router();
const { authRequired, requireRole } = require('./auth');
const { logAction } = require('../lib/audit');
const drive = require('../lib/googleDrive');
const sync = require('../driveSync');

router.use(authRequired, requireRole('superadmin'));

router.get('/status', async (req, res) => {
  try {
    res.json(await sync.getStatus());
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

router.post('/check', async (req, res) => {
  try {
    const info = await drive.checkAccess();
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(400).json({ error: 'drive_check_failed', message: e.message });
  }
});

router.post('/export-all', async (req, res) => {
  try {
    if (!drive.isConfigured()) {
      return res.status(400).json({ error: 'not_configured', message: 'Google Drive не настроен: задайте переменные GDRIVE_* на сервере (см. env.example)' });
    }
    const r = await sync.enqueueEverything(req);
    await logAction(req, 'drive_export_all', { entityType: 'drive', details: r });
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('Drive export-all error:', e);
    res.status(500).json({ error: 'export_error', message: e.message });
  }
});

router.post('/retry', async (req, res) => {
  try {
    res.json({ ok: true, requeued: await sync.retryFailed() });
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

module.exports = router;
