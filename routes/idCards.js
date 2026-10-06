// Роуты УДОСТОВЕРЕНИЙ (отдельно от сертификатов — routes/certificate.js).
//
//   GET  /api/id-cards/mine             — свои удостоверения (сотрудник)
//   GET  /api/id-cards/me               — МОЙ общий QR + список моих удостоверений с цветом (сотрудник)
//   GET  /api/id-cards/uid/:uid/pdf     — PDF по UID удостоверения
//   GET  /api/id-cards/uid/:uid/docx    — Word по UID удостоверения
//   GET  /api/id-cards/verify/:uid      — ПУБЛИЧНО, для QR / страницы проверки
//   GET  /api/id-cards/:id              — по id НАЗНАЧЕНИЯ (кнопка «Удостоверение» в интерфейсе)
const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const router = express.Router();
const { query } = require('../db');
const { authRequired } = require('./auth');
const {
  ensureIdCardForAssignment,
  getIdCardFullByUid,
  getIdCardFullByAssignmentId,
  listMyIdCards
} = require('../idCardService');
const { getCommitteeSignaturesForProtocol } = require('../certificateService');
const { getPersonForCard, toPublicPayload } = require('../personService');
const { buildIdCardPdfBuffer } = require('../idCardPdf');
const { buildIdCardDocx } = require('../idCardDocx');

function buildVerifyUrl(req, uid) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}/verify/${encodeURIComponent(uid)}`;
}

// Адрес личной страницы, зашитый в общий QR (один на сотрудника, на всех его удостоверениях).
// PUBLIC_BASE_URL (если задан) важнее заголовка Host: QR на бумаге постоянный, и адрес в нём
// не должен зависеть от того, с какого хоста админ нажал «скачать».
function buildPersonUrl(req, publicUid) {
  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (base) return `${base}/p/${encodeURIComponent(publicUid)}`;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('host')}/p/${encodeURIComponent(publicUid)}`;
}

// Что зашить в QR удостоверения: общая страница сотрудника /p/<public_uid>, как только она
// есть на сервере (person.html, этап 7); до этого — прежняя проверка по /verify/<UD-…>,
// чтобы QR на выданных бланках никогда не вёл в пустоту.
function qrUrlForCard(req, card) {
  const hasPersonPage = fs.existsSync(path.join(__dirname, '..', 'person.html'));
  return (hasPersonPage && card.public_uid) ? buildPersonUrl(req, card.public_uid) : buildVerifyUrl(req, card.card_uid);
}

// Протокол ещё не подписан председателем — понятный ответ вместо 500 (текст покажет интерфейс).
function sendCardError(res, e, fallback) {
  if (e && e.code === 'protocol_not_signed') return res.status(409).json({ error: 'protocol_not_signed', message: e.message });
  if (!res.headersSent) res.status(500).json({ error: fallback, details: e.message });
  return null;
}

async function loadSettings() {
  const sRes = await query('SELECT * FROM settings WHERE id = 1');
  return sRes.rows[0] || {};
}

router.get('/mine', authRequired, async (req, res) => {
  try {
    res.json(await listMyIdCards(req.user.id));
  } catch (e) {
    res.status(500).json({ error: 'db_error', details: e.message });
  }
});

// Сотрудник определяется ТОЛЬКО по токену (req.user.id), никаких id в параметрах.
// Роут объявлен до '/:id', иначе 'me' был бы принят за id назначения.
router.get('/me', authRequired, async (req, res) => {
  try {
    const person = await getPersonForCard(req.user.id);
    if (!person) return res.status(404).json({ error: 'not_found' });
    const url = buildPersonUrl(req, person.user.public_uid);
    const qr_svg = await QRCode.toString(url, {
      type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b2c5a', light: '#ffffff' }
    });
    const pub = toPublicPayload(person, person.employer);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      public_uid: person.user.public_uid,
      hire_date: person.user.hire_date || null,
      url,
      qr_svg,
      overall_status: person.overall_status,
      courses_count: person.cards.length,
      // courses — как на публичной странице; assignment_id/card_uid нужны кнопкам «Скачать» (авторизованный вид)
      courses: pub.courses.map((c, i) => ({
        ...c,
        assignment_id: person.cards[i].assignment_id,
        card_uid: person.cards[i].card_uid
      }))
    });
  } catch (e) {
    console.error('ID card (me) error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'id_card_error', details: e.message });
  }
});

router.get('/uid/:uid/pdf', authRequired, async (req, res) => {
  try {
    const card = await getIdCardFullByUid(req.params.uid);
    if (!card) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && Number(req.user.id) !== Number(card.employee_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const settings = await loadSettings();
    const sigs = card.is_external ? null : await getCommitteeSignaturesForProtocol(card.protocol_id);
    const buffer = await buildIdCardPdfBuffer(card, settings, qrUrlForCard(req, card), sigs);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="id_card_${encodeURIComponent(card.card_number || card.card_uid)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('ID card PDF (uid) error:', e);
    sendCardError(res, e, 'id_card_error');
  }
});

router.get('/uid/:uid/docx', authRequired, async (req, res) => {
  try {
    const card = await getIdCardFullByUid(req.params.uid);
    if (!card) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && Number(req.user.id) !== Number(card.employee_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const settings = await loadSettings();
    const sigs = card.is_external ? null : await getCommitteeSignaturesForProtocol(card.protocol_id);
    const { buffer, fileName } = await buildIdCardDocx(card, settings, qrUrlForCard(req, card), sigs);
    const asciiName = `id_card_${String(card.card_number || card.card_uid).replace(/[^A-Za-z0-9_-]/g, '')}.docx`;
    const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (e) {
    console.error('ID card DOCX (uid) error:', e);
    sendCardError(res, e, 'docx_error');
  }
});

// Публичная проверка удостоверения (без авторизации) — страница /verify/:uid
router.get('/verify/:uid', async (req, res) => {
  try {
    const card = await getIdCardFullByUid(req.params.uid);
    if (!card) return res.status(404).json({ found: false });
    res.json({
      found: true,
      document_type: 'id_card',
      status: card.status,
      card_number: card.card_number,
      certificate_number: card.card_number,
      certificate_uid: card.card_uid,
      card_uid: card.card_uid,
      full_name: `${card.last_name || ''} ${card.first_name || ''}`.trim(),
      course_title_ru: card.title_ru,
      course_title_kz: card.title_kz,
      protocol_number: card.protocol_number,
      is_external: !!card.is_external,
      issue_date: card.issue_date,
      expiry_date: card.expiry_date
    });
  } catch (e) {
    console.error('ID card verify error:', e);
    res.status(500).json({ found: false, error: 'server_error' });
  }
});

// По id назначения — как «Скачать сертификат», только удостоверение
router.get('/:id', authRequired, async (req, res) => {
  const assignmentId = req.params.id;
  try {
    const aRes = await query('SELECT user_id, status FROM assignments WHERE id = $1', [assignmentId]);
    const a = aRes.rows[0];
    if (!a) return res.status(404).json({ error: 'not_found' });
    if (req.user.role === 'employee' && Number(req.user.id) !== Number(a.user_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (a.status !== 'passed') return res.status(400).json({ error: 'not_passed' });

    await ensureIdCardForAssignment(assignmentId);
    const card = await getIdCardFullByAssignmentId(assignmentId);
    if (!card) return res.status(404).json({ error: 'not_found' });

    const settings = await loadSettings();
    const sigs = card.is_external ? null : await getCommitteeSignaturesForProtocol(card.protocol_id);
    const buffer = await buildIdCardPdfBuffer(card, settings, qrUrlForCard(req, card), sigs);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="id_card_${encodeURIComponent(card.card_number || card.id)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('ID card generation error:', e);
    sendCardError(res, e, 'id_card_error');
  }
});

module.exports = router;
module.exports.buildPersonUrl = buildPersonUrl;
