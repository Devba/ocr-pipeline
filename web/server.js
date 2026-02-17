const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const express = require('express');
const geoip = require('geoip-lite');
const i18next = require('i18next');
const i18nextBackend = require('i18next-fs-backend');
const i18nextMiddleware = require('i18next-http-middleware');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const { v1: docAiV1 } = require('@google-cloud/documentai');
const { GoogleAuth } = require('google-auth-library');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 8000;

const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const WORK_DIR = path.join(DATA_DIR, 'work');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const LOCALES_DIR = path.join(BASE_DIR, 'locales');

const AUTH_DIR = path.join(DATA_DIR, 'auth');
const AUTH_STATE_PATH = path.join(AUTH_DIR, 'state.json');

const AUTH_COOKIE_NAME = String(process.env.AUTH_COOKIE_NAME || 'mscr_session').trim();
const AUTH_SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 14 * 24 * 60 * 60 * 1000);
const AUTH_MAGICLINK_TTL_MS = Number(process.env.AUTH_MAGICLINK_TTL_MS || 15 * 60 * 1000);
const AUTH_METAMASK_NONCE_TTL_MS = Number(process.env.AUTH_METAMASK_NONCE_TTL_MS || 10 * 60 * 1000);
const AUTH_TOKEN_SECRET = String(
  process.env.AUTH_TOKEN_SECRET
  || process.env.FACE_ANTIBOT_SECRET
  || 'change-this-auth-secret',
).trim();

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.heic', '.heif', '.pdf']);
const mockDocuments = new Map();
const SUPPORTED_LANGUAGES = ['es', 'en', 'pt', 'fr', 'zh', 'ar'];
const LANGUAGE_OPTIONS = [
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'English' },
  { code: 'pt', label: 'Português' },
  { code: 'fr', label: 'Français' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
];
const RTL_LANGUAGES = new Set(['ar']);
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const OCR_COOLDOWN_MS = (() => {
  const raw = Number(process.env.OCR_COOLDOWN_MS || 15 * 1000);
  if (!Number.isFinite(raw)) {
    return 15 * 1000;
  }
  return Math.max(0, Math.min(10 * 60 * 1000, Math.round(raw)));
})();
const FACE_ANTIBOT_ENABLED = process.env.FACE_ANTIBOT_ENABLED === '1';
const FACE_ANTIBOT_TEST_MODE = process.env.FACE_ANTIBOT_TEST_MODE !== '0';
const FACE_CHALLENGE_TTL_MS = Number(process.env.FACE_ANTIBOT_CHALLENGE_TTL_MS || 2 * 60 * 1000);
const FACE_CHALLENGE_SECRET = String(process.env.FACE_ANTIBOT_SECRET || 'change-this-face-antibot-secret');
const PAYPAL_ENV = String(process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const PAYPAL_CLIENT_ID = String(process.env.PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_CLIENT_SECRET = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
const PAYPAL_CURRENCY = String(process.env.PAYPAL_CURRENCY || 'EUR').toUpperCase();
const PAYPAL_UNLOCK_AMOUNT = String(process.env.PAYPAL_UNLOCK_AMOUNT || '1.00');
const PAYPAL_ENABLED = Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET);
const PAYPAL_API_BASE = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const SIMULATE_PAYMENT_ENABLED = String(process.env.SIMULATE_PAYMENT_ENABLED || '').trim() === '1';

const DOC_AI_ENABLED = process.env.DOC_AI_ENABLED === '1';
const DOC_AI_PROJECT_ID = String(process.env.DOC_AI_PROJECT_ID || '').trim();
const DOC_AI_LOCATION = String(process.env.DOC_AI_LOCATION || 'us').trim();
const DOC_AI_PROCESSOR_ID = String(process.env.DOC_AI_PROCESSOR_ID || '').trim();
const DOC_AI_PROCESSOR_VERSION_ID = String(process.env.DOC_AI_PROCESSOR_VERSION_ID || '').trim();
const DOC_AI_SUMMARY_CHARS = Number(process.env.DOC_AI_SUMMARY_CHARS || 1200);
const DOC_AI_DEBUG_LOG = String(process.env.DOC_AI_DEBUG_LOG || '').trim() === '1';
const DOC_AI_LANGUAGE_HINTS = String(process.env.DOC_AI_LANGUAGE_HINTS || 'es,la')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .slice(0, 8);

const POSTPROCESS_ENABLED = String(process.env.POSTPROCESS_ENABLED || '').trim() === '1';
const POSTPROCESS_PROVIDER = String(process.env.POSTPROCESS_PROVIDER || 'vertex').trim().toLowerCase();
const POSTPROCESS_MAX_CHARS = (() => {
  const raw = Number(process.env.POSTPROCESS_MAX_CHARS || 20000);
  return Number.isFinite(raw) ? Math.max(2000, Math.min(200000, Math.round(raw))) : 20000;
})();
const POSTPROCESS_TIMEOUT_MS = (() => {
  const raw = Number(process.env.POSTPROCESS_TIMEOUT_MS || 20000);
  return Number.isFinite(raw) ? Math.max(2000, Math.min(120000, Math.round(raw))) : 20000;
})();
const VERTEX_PROJECT_ID = String(process.env.VERTEX_PROJECT_ID || DOC_AI_PROJECT_ID || '').trim();
const VERTEX_LOCATION = String(process.env.VERTEX_LOCATION || 'us-central1').trim();
const VERTEX_MODEL = String(process.env.VERTEX_MODEL || 'gemini-1.5-flash').trim();
const POSTPROCESS_LANGUAGE_HINTS = String(process.env.POSTPROCESS_LANGUAGE_HINTS || DOC_AI_LANGUAGE_HINTS.join(','))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .slice(0, 8);

const DOC_AI_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
};

const OPENCLAW_WEBHOOK_SECRET = String(process.env.OPENCLAW_WEBHOOK_SECRET || '').trim();
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').trim() === '1';
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim();
const SMTP_FROM = String(process.env.SMTP_FROM || '').trim();
const ALERT_EMAIL_TO = String(process.env.ALERT_EMAIL_TO || '').trim();
const BOT_CONTACT_EMAIL = String(process.env.BOT_CONTACT_EMAIL || SMTP_FROM || '').trim();
const LANGUAGE_COUNTRIES = {
  es: new Set(['ES', 'MX', 'AR', 'CO', 'PE', 'VE', 'CL', 'EC', 'GT', 'CU', 'BO', 'DO', 'HN', 'PY', 'SV', 'NI', 'CR', 'PA', 'UY']),
  pt: new Set(['PT', 'BR', 'AO', 'MZ', 'CV', 'GW', 'ST', 'TL']),
  fr: new Set(['FR', 'BE', 'CH', 'LU', 'MC', 'SN', 'CI', 'CM']),
  zh: new Set(['CN', 'TW', 'HK', 'MO', 'SG']),
  ar: new Set(['SA', 'AE', 'QA', 'KW', 'OM', 'BH', 'IQ', 'JO', 'LB', 'SY', 'PS', 'YE', 'EG', 'LY', 'SD', 'MA', 'DZ', 'TN']),
};
const lastOcrAtByIp = new Map();
const faceCheckChallenges = new Map();
const paypalOrders = new Map();

const ADMIN_STATS_TOKEN = String(process.env.ADMIN_STATS_TOKEN || '').trim();
const METRICS_IP_SECRET = String(process.env.METRICS_IP_SECRET || FACE_CHALLENGE_SECRET).trim();

const metricsState = {
  startedAt: Date.now(),
  totalRequests: 0,
  totalErrors: 0,
  docAi: {
    requests: 0,
    pages: 0,
    bytes: 0,
    errors: 0,
    lastAt: 0,
    lastMs: 0,
    lastPages: 0,
    lastBytes: 0,
    lastError: '',
  },
  postprocess: {
    runs: 0,
    skippedTooLong: 0,
    errors: 0,
    lastAt: 0,
    lastMs: 0,
    lastError: '',
    lastProvider: '',
    lastModel: '',
  },
  statusCounts: new Map(),
  methodCounts: new Map(),
  pathCounts: new Map(),
  botUserAgentHits: 0,
  honeypotHits: 0,
  faceCheckFails: 0,
  cooldownHits: 0,
  rateLimitHits: 0,
  unsupportedFormatHits: 0,
  uniqueVisitors: new Map(),
  recentEvents: [],
};

const MAX_RECENT_EVENTS = 200;
const UNIQUE_VISITOR_TTL_MS = 24 * 60 * 60 * 1000;
const BOT_UA_REGEX = /\b(bot|spider|crawler|crawl|slurp)\b|\b(curl|wget|python-requests|httpclient|go-http-client)\b/i;

function hashIpForMetrics(ip) {
  const raw = String(ip || 'unknown');
  if (!METRICS_IP_SECRET) {
    return raw;
  }
  return crypto
    .createHmac('sha256', METRICS_IP_SECRET)
    .update(raw)
    .digest('hex')
    .slice(0, 16);
}

function normalizePathForMetrics(req) {
  const raw = String(req.path || '/');
  if (raw.startsWith('/static/')) {
    return '/static/*';
  }
  return raw;
}

function incMapCounter(map, key, amount = 1) {
  const current = Number(map.get(key) || 0);
  map.set(key, current + amount);
}

function pushRecentEvent(event) {
  metricsState.recentEvents.push(event);
  if (metricsState.recentEvents.length > MAX_RECENT_EVENTS) {
    metricsState.recentEvents.splice(0, metricsState.recentEvents.length - MAX_RECENT_EVENTS);
  }
}

function markBotReason(res, reason) {
  if (!res.locals) {
    return;
  }
  if (!Array.isArray(res.locals.botReasons)) {
    res.locals.botReasons = [];
  }
  if (reason && !res.locals.botReasons.includes(reason)) {
    res.locals.botReasons.push(reason);
  }
}

function pruneUniqueVisitors(now) {
  for (const [key, lastSeenAt] of metricsState.uniqueVisitors.entries()) {
    if (now - Number(lastSeenAt || 0) > UNIQUE_VISITOR_TTL_MS) {
      metricsState.uniqueVisitors.delete(key);
    }
  }
}

function buildMetricsSnapshot(recentLimit = 50) {
  const now = Date.now();
  pruneUniqueVisitors(now);

  const safeRecentLimit = Math.max(10, Math.min(200, Number(recentLimit) || 50));

  const topEntries = (map, limit = 20) =>
    Array.from(map.entries())
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, limit)
      .map(([key, value]) => ({ key, count: Number(value) }));

  return {
    ok: true,
    startedAt: metricsState.startedAt,
    uptimeSeconds: Math.round((now - metricsState.startedAt) / 1000),
    totalRequests: metricsState.totalRequests,
    totalErrors: metricsState.totalErrors,
    docAi: {
      enabled: DOC_AI_ENABLED,
      configured: isDocAiConfigured(),
      requests: Number(metricsState.docAi.requests || 0),
      pages: Number(metricsState.docAi.pages || 0),
      bytes: Number(metricsState.docAi.bytes || 0),
      errors: Number(metricsState.docAi.errors || 0),
      lastAt: Number(metricsState.docAi.lastAt || 0),
      lastMs: Number(metricsState.docAi.lastMs || 0),
      lastPages: Number(metricsState.docAi.lastPages || 0),
      lastBytes: Number(metricsState.docAi.lastBytes || 0),
      lastError: String(metricsState.docAi.lastError || ''),
    },
    postprocess: {
      enabled: POSTPROCESS_ENABLED,
      provider: POSTPROCESS_PROVIDER,
      model: POSTPROCESS_PROVIDER === 'vertex' ? `${VERTEX_LOCATION}/${VERTEX_MODEL}` : '',
      runs: Number(metricsState.postprocess.runs || 0),
      skippedTooLong: Number(metricsState.postprocess.skippedTooLong || 0),
      errors: Number(metricsState.postprocess.errors || 0),
      lastAt: Number(metricsState.postprocess.lastAt || 0),
      lastMs: Number(metricsState.postprocess.lastMs || 0),
      lastError: String(metricsState.postprocess.lastError || ''),
      lastProvider: String(metricsState.postprocess.lastProvider || ''),
      lastModel: String(metricsState.postprocess.lastModel || ''),
    },
    uniqueVisitors24h: metricsState.uniqueVisitors.size,
    bots: {
      botUserAgentHits: metricsState.botUserAgentHits,
      honeypotHits: metricsState.honeypotHits,
      faceCheckFails: metricsState.faceCheckFails,
      cooldownHits: metricsState.cooldownHits,
      rateLimitHits: metricsState.rateLimitHits,
      unsupportedFormatHits: metricsState.unsupportedFormatHits,
    },
    topPaths: topEntries(metricsState.pathCounts),
    statusCounts: topEntries(metricsState.statusCounts, 50),
    methodCounts: topEntries(metricsState.methodCounts, 20),
    recentEvents: metricsState.recentEvents.slice(-safeRecentLimit),
  };
}

function shouldRunPostprocess() {
  if (!POSTPROCESS_ENABLED) {
    return false;
  }
  if (POSTPROCESS_PROVIDER !== 'vertex') {
    return false;
  }
  return Boolean(VERTEX_PROJECT_ID && VERTEX_LOCATION && VERTEX_MODEL);
}

function buildPostprocessPrompt(rawText) {
  const hints = POSTPROCESS_LANGUAGE_HINTS.length > 0 ? POSTPROCESS_LANGUAGE_HINTS.join(', ') : 'es, la';
  return [
    'Corrige y moderniza esta transcripción OCR de un manuscrito antiguo (España, s. XVIII–XIX).',
    'Mantén la fidelidad al texto original: no inventes contenido ni nombres.',
    'Corrige errores típicos de OCR en letra cursiva antigua (confusiones i/l, rn/m, s/f, etc.).',
    'Respeta saltos de línea y párrafos cuando tenga sentido; no lo conviertas todo en un solo bloque.',
    'Completa abreviaturas comunes SOLO cuando sea muy probable; si dudas, conserva el original.',
    `Idiomas/pistas: ${hints}.`,
    '',
    'Devuelve únicamente el texto corregido, sin explicaciones.',
    '',
    'Texto crudo:',
    rawText,
  ].join('\n');
}

async function generateWithVertex(prompt, { jobId } = {}) {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!accessToken) {
    throw new Error('VERTEX_NO_TOKEN');
  }

  const endpoint = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(VERTEX_PROJECT_ID)}/locations/${encodeURIComponent(VERTEX_LOCATION)}/publishers/google/models/${encodeURIComponent(VERTEX_MODEL)}:generateContent`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POSTPROCESS_TIMEOUT_MS);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      topP: 0.95,
    },
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`VERTEX_HTTP_${response.status}`);
      err.details = text.slice(0, 500);
      throw err;
    }

    const data = await response.json();
    const out = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (!out) {
      throw new Error('VERTEX_EMPTY');
    }
    if (DOC_AI_DEBUG_LOG) {
      console.log(`[postprocess] job=${jobId || 'n/a'} provider=vertex model=${VERTEX_MODEL} inChars=${prompt.length} outChars=${out.length}`);
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

async function postprocessTextIfEnabled(rawText, { jobId } = {}) {
  if (!shouldRunPostprocess()) {
    return { ok: false, skipped: true, text: rawText, meta: { provider: POSTPROCESS_PROVIDER, model: '' } };
  }

  const normalized = String(rawText || '').trim();
  if (!normalized) {
    return { ok: false, skipped: true, text: rawText, meta: { provider: POSTPROCESS_PROVIDER, model: '' } };
  }

  if (normalized.length > POSTPROCESS_MAX_CHARS) {
    metricsState.postprocess.skippedTooLong += 1;
    return {
      ok: false,
      skipped: true,
      text: rawText,
      meta: { provider: POSTPROCESS_PROVIDER, model: `${VERTEX_LOCATION}/${VERTEX_MODEL}`, reason: 'too_long' },
    };
  }

  metricsState.postprocess.runs += 1;
  metricsState.postprocess.lastAt = Date.now();
  metricsState.postprocess.lastProvider = 'vertex';
  metricsState.postprocess.lastModel = `${VERTEX_LOCATION}/${VERTEX_MODEL}`;
  const startedAt = Date.now();

  try {
    const prompt = buildPostprocessPrompt(normalized);
    const corrected = await generateWithVertex(prompt, { jobId });
    metricsState.postprocess.lastMs = Date.now() - startedAt;
    metricsState.postprocess.lastError = '';
    return {
      ok: true,
      skipped: false,
      text: corrected,
      meta: { provider: 'vertex', model: `${VERTEX_LOCATION}/${VERTEX_MODEL}`, ms: metricsState.postprocess.lastMs },
    };
  } catch (error) {
    metricsState.postprocess.errors += 1;
    metricsState.postprocess.lastMs = Date.now() - startedAt;
    metricsState.postprocess.lastError = String(error?.message || 'POSTPROCESS_ERROR').slice(0, 240);
    return {
      ok: false,
      skipped: false,
      text: rawText,
      meta: { provider: 'vertex', model: `${VERTEX_LOCATION}/${VERTEX_MODEL}`, error: metricsState.postprocess.lastError },
    };
  }
}

function isValidMoneyAmount(value) {
  const normalized = String(value || '').trim();
  return /^\d+(?:\.\d{1,2})?$/.test(normalized) && Number(normalized) > 0;
}

async function getPayPalAccessToken() {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`, 'utf8').toString('base64');
  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });

  if (!response.ok) {
    throw new Error('PAYPAL_OAUTH_FAILED');
  }

  const data = await response.json();
  if (!data?.access_token) {
    throw new Error('PAYPAL_OAUTH_NO_TOKEN');
  }
  return String(data.access_token);
}

function normalizeLanguage(value) {
  if (!value) {
    return 'en';
  }
  const normalized = String(value).toLowerCase();
  return SUPPORTED_LANGUAGES.includes(normalized) ? normalized : 'en';
}

function getCountryFromIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const rawIp = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ? String(forwarded).split(',')[0].trim() : req.ip);

  if (!rawIp) {
    return null;
  }

  const normalizedIp = rawIp.replace('::ffff:', '');
  const geo = geoip.lookup(normalizedIp);
  return geo?.country || null;
}

function detectLanguageFromCountry(countryCode) {
  if (!countryCode) {
    return 'en';
  }

  for (const [language, countries] of Object.entries(LANGUAGE_COUNTRIES)) {
    if (countries.has(countryCode)) {
      return language;
    }
  }

  return 'en';
}

function resolveLanguage(req) {
  return normalizeLanguage(req.body?.language || req.query?.lng || req.ipLanguage || req.language);
}

function extractBearerToken(req) {
  const auth = String(req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const q = req.query?.token;
  return q ? String(q).trim() : '';
}

function createSmtpTransportIfConfigured() {
  if (!SMTP_HOST || !SMTP_PORT) {
    return null;
  }

  const auth = SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth,
  });
}

async function sendAlertEmail(subject, text) {
  const transport = createSmtpTransportIfConfigured();
  if (!transport) {
    throw new Error('SMTP_NOT_CONFIGURED');
  }

  if (!SMTP_FROM || !ALERT_EMAIL_TO) {
    throw new Error('SMTP_ALERT_TARGET_NOT_CONFIGURED');
  }

  await transport.sendMail({
    from: SMTP_FROM,
    to: ALERT_EMAIL_TO,
    subject,
    text,
  });
}

function tLang(req, key, options = {}) {
  const language = resolveLanguage(req);
  return i18next.t(key, { lng: language, ...options });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const rawIp = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ? String(forwarded).split(',')[0].trim() : req.ip || 'unknown');

  return String(rawIp).replace('::ffff:', '');
}

function signFacePayload(encodedPayload) {
  return crypto
    .createHmac('sha256', FACE_CHALLENGE_SECRET)
    .update(encodedPayload)
    .digest('base64url');
}

function issueFaceChallenge(req) {
  const now = Date.now();
  const nonce = crypto.randomBytes(18).toString('base64url');
  const payload = {
    nonce,
    iat: now,
    exp: now + FACE_CHALLENGE_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signFacePayload(encodedPayload);
  const token = `${encodedPayload}.${signature}`;

  faceCheckChallenges.set(nonce, {
    ip: getClientIp(req),
    issuedAt: now,
    expiresAt: payload.exp,
    used: false,
  });

  return { token, expiresAt: payload.exp };
}

function verifyFaceChallenge(req, token) {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }

  const [encodedPayload, receivedSignature] = parts;
  const expectedSignature = signFacePayload(encodedPayload);

  const receivedBuffer = Buffer.from(receivedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (_error) {
    return false;
  }

  const nonce = payload?.nonce;
  const exp = Number(payload?.exp || 0);
  const now = Date.now();

  if (!nonce || !exp || now > exp) {
    return false;
  }

  const challenge = faceCheckChallenges.get(nonce);
  if (!challenge || challenge.used) {
    return false;
  }

  if (challenge.ip !== getClientIp(req)) {
    return false;
  }

  if (now > challenge.expiresAt) {
    faceCheckChallenges.delete(nonce);
    return false;
  }

  challenge.used = true;
  challenge.usedAt = now;
  faceCheckChallenges.set(nonce, challenge);
  return true;
}

function cleanupFaceChallenges() {
  const now = Date.now();
  for (const [nonce, challenge] of faceCheckChallenges.entries()) {
    const shouldDeleteExpired = now > challenge.expiresAt;
    const shouldDeleteUsed = challenge.used && now - (challenge.usedAt || challenge.issuedAt || 0) > 5 * 60 * 1000;
    if (shouldDeleteExpired || shouldDeleteUsed) {
      faceCheckChallenges.delete(nonce);
    }
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(BASE_DIR, 'templates'));
app.set('trust proxy', true);

app.use((req, res, next) => {
  const startNs = process.hrtime.bigint();
  res.locals.botReasons = [];

  const clientIp = getClientIp(req);
  const visitorKey = hashIpForMetrics(clientIp);
  metricsState.uniqueVisitors.set(visitorKey, Date.now());

  const ua = String(req.headers['user-agent'] || '');
  if (ua && BOT_UA_REGEX.test(ua)) {
    metricsState.botUserAgentHits += 1;
    markBotReason(res, 'bot_ua');
  }

  res.on('finish', () => {
    const endNs = process.hrtime.bigint();
    const durationMs = Number(endNs - startNs) / 1_000_000;

    metricsState.totalRequests += 1;
    incMapCounter(metricsState.methodCounts, String(req.method || 'GET').toUpperCase());
    incMapCounter(metricsState.pathCounts, normalizePathForMetrics(req));
    incMapCounter(metricsState.statusCounts, String(res.statusCode || 0));

    if (res.statusCode >= 400) {
      metricsState.totalErrors += 1;
    }

    pushRecentEvent({
      at: Date.now(),
      ip: visitorKey,
      method: String(req.method || 'GET').toUpperCase(),
      path: normalizePathForMetrics(req),
      status: res.statusCode,
      ms: Math.round(durationMs),
      ua: ua ? ua.slice(0, 160) : '',
      botReasons: Array.isArray(res.locals.botReasons) ? res.locals.botReasons : [],
    });
  });

  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));
app.use(
  i18nextMiddleware.handle(i18next, {
    ignoreRoutes: ['/static'],
  }),
);
app.use((req, _res, next) => {
  req.ipCountry = getCountryFromIp(req);
  req.ipLanguage = detectLanguageFromCountry(req.ipCountry);
  next();
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  skip: (req) => {
    const method = String(req.method || '').toUpperCase();
    return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  },
  handler: (req, res) => {
    metricsState.rateLimitHits += 1;
    markBotReason(res, 'rate_limit');
    res.status(429);
    return renderPage(req, res, {
      error: tLang(req, 'errors.tooManyRequests'),
      selectedLanguage: resolveLanguage(req),
    });
  },
});

const ocrLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res) => {
    metricsState.rateLimitHits += 1;
    markBotReason(res, 'rate_limit');
    res.status(429);
    return renderPage(req, res, {
      error: tLang(req, 'errors.ocrRateLimit'),
      selectedLanguage: resolveLanguage(req),
    });
  },
});

app.use(generalLimiter);

app.use('/static', express.static(path.join(BASE_DIR, 'public')));

app.get('/robots.txt', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.sendFile(path.join(BASE_DIR, 'public', 'robots.txt'));
});

app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.sendFile(path.join(BASE_DIR, 'public', 'sitemap.xml'));
});

app.get('/api/bot-info', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.json({
    ok: true,
    name: 'manuscritos.live',
    purpose: 'OCR for historical handwritten documents (Spanish/Latin).',
    botPolicy: {
      summary: 'Crawling public pages is allowed. Authenticated/private content is disallowed.',
      robotsTxt: '/robots.txt',
      sitemap: '/sitemap.xml',
      contact: BOT_CONTACT_EMAIL || null,
      rateLimits: {
        note: 'Interactive OCR endpoints are rate-limited. Do not bulk-submit OCR jobs.',
      },
      disallowedPaths: ['/admin/', '/ops/', '/auth/', '/gallery', '/unlock', '/face-check/', '/api/paypal/'],
    },
    api: {
      health: '/',
      stats: ADMIN_STATS_TOKEN ? '/admin/stats (token required)' : null,
    },
  });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const looksLikeImage = mime.startsWith('image/');
    const looksLikePdf = mime === 'application/pdf';

    if (ext) {
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        metricsState.unsupportedFormatHits += 1;
        const err = new Error(req.t('errors.unsupportedFormat'));
        err.code = 'UNSUPPORTED_FORMAT';
        return cb(err);
      }
    } else if (!looksLikeImage && !looksLikePdf) {
      metricsState.unsupportedFormatHits += 1;
      const err = new Error(req.t('errors.unsupportedFormat'));
      err.code = 'UNSUPPORTED_FORMAT';
      return cb(err);
    }
    cb(null, true);
  },
});

async function ensureDirs() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(WORK_DIR, { recursive: true });
  await fs.mkdir(JOBS_DIR, { recursive: true });
  await fs.mkdir(AUTH_DIR, { recursive: true });
}

async function loadAuthState() {
  try {
    const raw = await fs.readFile(AUTH_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      users: parsed?.users && typeof parsed.users === 'object' ? parsed.users : {},
      sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      magicLinks: parsed?.magicLinks && typeof parsed.magicLinks === 'object' ? parsed.magicLinks : {},
      metamaskNonces: parsed?.metamaskNonces && typeof parsed.metamaskNonces === 'object' ? parsed.metamaskNonces : {},
    };
  } catch (_error) {
    return { users: {}, sessions: {}, magicLinks: {}, metamaskNonces: {} };
  }
}

async function saveAuthState(state) {
  const safe = {
    users: state?.users && typeof state.users === 'object' ? state.users : {},
    sessions: state?.sessions && typeof state.sessions === 'object' ? state.sessions : {},
    magicLinks: state?.magicLinks && typeof state.magicLinks === 'object' ? state.magicLinks : {},
    metamaskNonces: state?.metamaskNonces && typeof state.metamaskNonces === 'object' ? state.metamaskNonces : {},
  };
  const tmpPath = `${AUTH_STATE_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(safe, null, 2) + '\n', 'utf8');
  await fs.rename(tmpPath, AUTH_STATE_PATH);
}

function parseCookies(header) {
  const value = String(header || '');
  const out = {};
  value.split(';').forEach((part) => {
    const [k, ...rest] = part.trim().split('=');
    if (!k) return;
    out[k] = decodeURIComponent(rest.join('=') || '');
  });
  return out;
}

function buildSetCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(String(value || ''))}`];
  const maxAge = options.maxAge;
  if (typeof maxAge === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}`);
  }
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (options.secure !== false) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function randomId(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHmac('sha256', AUTH_TOKEN_SECRET || 'auth-secret')
    .update(String(token || ''))
    .digest('hex');
}

async function createSession(res, userId) {
  const state = await loadAuthState();
  const sessionId = randomId(24);
  const now = Date.now();
  state.sessions[sessionId] = {
    userId: String(userId),
    createdAt: now,
    expiresAt: now + AUTH_SESSION_TTL_MS,
  };
  await saveAuthState(state);
  res.setHeader('Set-Cookie', buildSetCookie(AUTH_COOKIE_NAME, sessionId, { maxAge: AUTH_SESSION_TTL_MS }));
  return sessionId;
}

async function clearSession(res, sessionId) {
  if (sessionId) {
    const state = await loadAuthState();
    delete state.sessions[String(sessionId)];
    await saveAuthState(state);
  }
  res.setHeader('Set-Cookie', buildSetCookie(AUTH_COOKIE_NAME, '', { maxAge: 0 }));
}

async function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie);
  const sessionId = cookies[AUTH_COOKIE_NAME];
  if (!sessionId) {
    return null;
  }

  const state = await loadAuthState();
  const session = state.sessions?.[sessionId];
  if (!session) {
    return null;
  }
  const now = Date.now();
  if (session.expiresAt && now > Number(session.expiresAt)) {
    delete state.sessions[sessionId];
    await saveAuthState(state);
    return null;
  }
  const user = state.users?.[session.userId];
  return user ? { id: session.userId, ...user } : null;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 200) return '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return '';
  return email;
}

function normalizeEthAddress(value) {
  const raw = String(value || '').trim();
  try {
    return ethers.getAddress(raw);
  } catch (_error) {
    return '';
  }
}

function requireAuth(req, res, next) {
  getUserFromRequest(req)
    .then((user) => {
      if (!user) {
        return res.redirect('/login');
      }
      req.currentUser = user;
      next();
    })
    .catch(() => res.redirect('/login'));
}

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function safeJobId(raw) {
  const value = String(raw || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(value)) {
    return '';
  }
  return value;
}

function buildJobPaths(jobId, originalExt = '') {
  const ext = originalExt && /^[.][a-z0-9]{1,8}$/i.test(originalExt) ? originalExt.toLowerCase() : '';
  const jobDir = path.join(JOBS_DIR, jobId);
  return {
    jobDir,
    originalPath: path.join(jobDir, `original${ext || '.bin'}`),
    preprocessedPath: path.join(jobDir, 'preprocessed.png'),
    thumbPath: path.join(jobDir, 'thumb.jpg'),
    summaryPath: path.join(jobDir, 'summary.txt'),
    fullPath: path.join(jobDir, 'full.txt'),
    fullRawPath: path.join(jobDir, 'full_raw.txt'),
    metaPath: path.join(jobDir, 'meta.json'),
  };
}

async function createJobThumbnail({ sourcePath, thumbPath }) {
  if (!sourcePath || !thumbPath) {
    return false;
  }
  if (!await pathExists(sourcePath)) {
    return false;
  }

  try {
    await sharp(sourcePath)
      .rotate()
      .resize({ width: 420, height: 420, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toFile(thumbPath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function persistJob({
  jobId,
  uploadedFile,
  preprocessedPath,
  summaryText,
  fullText,
  fullTextRaw,
  userId,
  language,
  profile,
  psm,
  engine,
  clientPreprocessed,
  ipHash,
  postprocess,
}) {
  const safeId = safeJobId(jobId);
  if (!safeId) {
    return;
  }

  const originalExt = path.extname(String(uploadedFile?.filename || uploadedFile?.originalname || '')).toLowerCase();
  const paths = buildJobPaths(safeId, originalExt);
  await fs.mkdir(paths.jobDir, { recursive: true });

  if (uploadedFile?.path && await pathExists(uploadedFile.path)) {
    try {
      await fs.rename(uploadedFile.path, paths.originalPath);
    } catch (_error) {
      await fs.copyFile(uploadedFile.path, paths.originalPath);
    }
  }

  if (preprocessedPath && await pathExists(preprocessedPath)) {
    try {
      await fs.rename(preprocessedPath, paths.preprocessedPath);
    } catch (_error) {
      await fs.copyFile(preprocessedPath, paths.preprocessedPath);
    }
  }

  const uploadMime = String(uploadedFile?.mimetype || '').toLowerCase();
  const uploadExt = path.extname(String(uploadedFile?.originalname || '')).toLowerCase();
  const looksLikePdf = uploadMime === 'application/pdf' || uploadExt === '.pdf';

  let hasThumb = false;
  if (!looksLikePdf) {
    const thumbSource = await pathExists(paths.preprocessedPath) ? paths.preprocessedPath : paths.originalPath;
    hasThumb = await createJobThumbnail({ sourcePath: thumbSource, thumbPath: paths.thumbPath });
  }

  await fs.writeFile(paths.summaryPath, String(summaryText || '').trimEnd() + '\n', 'utf8');
  await fs.writeFile(paths.fullPath, String(fullText || '').trimEnd() + '\n', 'utf8');
  if (fullTextRaw) {
    await fs.writeFile(paths.fullRawPath, String(fullTextRaw || '').trimEnd() + '\n', 'utf8');
  }

  const meta = {
    id: safeId,
    createdAt: new Date().toISOString(),
    engine: String(engine || 'mock'),
    language: String(language || ''),
    profile: String(profile || ''),
    psm: String(psm || ''),
    clientPreprocessed: Boolean(clientPreprocessed),
    postprocess: postprocess || null,
    userId: userId ? String(userId) : '',
    ip: String(ipHash || ''),
    upload: uploadedFile ? {
      originalName: String(uploadedFile.originalname || ''),
      mimeType: String(uploadedFile.mimetype || ''),
      size: Number(uploadedFile.size || 0),
      storedAs: path.basename(paths.originalPath),
    } : null,
    files: {
      original: path.basename(paths.originalPath),
      preprocessed: await pathExists(paths.preprocessedPath) ? path.basename(paths.preprocessedPath) : null,
      thumb: hasThumb ? path.basename(paths.thumbPath) : null,
      summary: path.basename(paths.summaryPath),
      full: path.basename(paths.fullPath),
      fullRaw: fullTextRaw ? path.basename(paths.fullRawPath) : null,
      meta: path.basename(paths.metaPath),
    },
  };

  await fs.writeFile(paths.metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

async function loadJobFromDisk(jobId) {
  const safeId = safeJobId(jobId);
  if (!safeId) {
    return null;
  }

  const paths = buildJobPaths(safeId);
  if (!await pathExists(paths.metaPath)) {
    return null;
  }

  try {
    const metaRaw = await fs.readFile(paths.metaPath, 'utf8');
    const meta = JSON.parse(metaRaw);
    const summaryText = await fs.readFile(paths.summaryPath, 'utf8').catch(() => '');
    const fullText = await fs.readFile(paths.fullPath, 'utf8').catch(() => '');
    return {
      summaryText: String(summaryText || '').trim(),
      fullText: String(fullText || '').trim(),
      language: String(meta?.language || ''),
    };
  } catch (_error) {
    return null;
  }
}

async function preprocessImage(inputPath, outputPath, profile) {
  const baseImage = sharp(inputPath).rotate().grayscale();

  if (profile === 'historico') {
    const metadata = await baseImage.metadata();
    const currentWidth = metadata.width || 1200;
    const scaledWidth = Math.max(1, Math.round(currentWidth * 1.6));

    await baseImage
      .resize({ width: scaledWidth, kernel: sharp.kernel.lanczos3 })
      .normalise()
      .median(3)
      .threshold(170)
      .png()
      .toFile(outputPath);
    return;
  }

  await baseImage.normalise().sharpen().png().toFile(outputPath);
}

function buildMockSummary(language) {
  const lines = i18next.t('mock.summaryLines', {
    lng: language,
    returnObjects: true,
  });
  return Array.isArray(lines) ? lines.join('\n') : '';
}

function buildMockFullDocument(language) {
  const lines = i18next.t('mock.fullDocumentLines', {
    lng: language,
    returnObjects: true,
  });
  return Array.isArray(lines) ? lines.join('\n') : '';
}

function isDocAiConfigured() {
  return Boolean(DOC_AI_ENABLED && DOC_AI_PROJECT_ID && DOC_AI_LOCATION && DOC_AI_PROCESSOR_ID);
}

function getDocAiMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return DOC_AI_MIME_BY_EXT[ext] || 'application/octet-stream';
}

function buildDocAiProcessorName(client) {
  if (DOC_AI_PROCESSOR_VERSION_ID) {
    return client.processorVersionPath(DOC_AI_PROJECT_ID, DOC_AI_LOCATION, DOC_AI_PROCESSOR_ID, DOC_AI_PROCESSOR_VERSION_ID);
  }
  return client.processorPath(DOC_AI_PROJECT_ID, DOC_AI_LOCATION, DOC_AI_PROCESSOR_ID);
}

async function runDocAiOcr(filePath, context = {}) {
  const startedAt = Date.now();
  const client = new docAiV1.DocumentProcessorServiceClient({
    apiEndpoint: `${DOC_AI_LOCATION}-documentai.googleapis.com`,
  });

  const name = buildDocAiProcessorName(client);
  const content = await fs.readFile(filePath);
  const mimeType = getDocAiMimeType(filePath);

  metricsState.docAi.requests += 1;
  metricsState.docAi.bytes += content.length;
  metricsState.docAi.lastAt = Date.now();
  metricsState.docAi.lastBytes = content.length;

  let result;
  try {
    const baseRequest = {
      name,
      rawDocument: {
        content,
        mimeType,
      },
    };

    const requestWithHints = DOC_AI_LANGUAGE_HINTS.length > 0
      ? {
        ...baseRequest,
        processOptions: {
          ocrConfig: {
            hints: {
              languageHints: DOC_AI_LANGUAGE_HINTS,
            },
          },
        },
      }
      : baseRequest;

    try {
      [result] = await client.processDocument(requestWithHints);
    } catch (error) {
      // Fallback seguro si el processor no acepta hints / opciones.
      if (DOC_AI_LANGUAGE_HINTS.length > 0) {
        [result] = await client.processDocument(baseRequest);
      } else {
        throw error;
      }
    }
  } catch (error) {
    metricsState.docAi.errors += 1;
    metricsState.docAi.lastError = String(error?.message || 'DOC_AI_ERROR').slice(0, 240);
    throw error;
  } finally {
    metricsState.docAi.lastMs = Date.now() - startedAt;
  }

  const pagesLen = Array.isArray(result?.document?.pages) ? result.document.pages.length : 0;
  const pages = pagesLen > 0 ? pagesLen : (mimeType.startsWith('image/') ? 1 : 0);
  metricsState.docAi.pages += pages;
  metricsState.docAi.lastPages = pages;

  if (DOC_AI_DEBUG_LOG) {
    const jobId = context?.jobId ? String(context.jobId) : '';
    const textChars = String(result?.document?.text || '').length;
    console.log(`[docai] job=${jobId || 'n/a'} mime=${mimeType} bytes=${content.length} pages=${pages} chars=${textChars} ms=${metricsState.docAi.lastMs}`);
  }

  const text = String(result?.document?.text || '').trim();
  return text;
}

function buildSummaryFromFullText(fullText) {
  const maxChars = Number.isFinite(DOC_AI_SUMMARY_CHARS) ? Math.max(200, Math.min(10000, DOC_AI_SUMMARY_CHARS)) : 1200;
  const normalized = String(fullText || '').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trim()}…`;
}

function buildViewModel(req, extra = {}) {
  const explicitLanguage = extra.selectedLanguage || req.body?.language || req.query?.lng;
  const currentLanguage = normalizeLanguage(
    explicitLanguage || req.ipLanguage || req.language,
  );
  const usedFallback = !explicitLanguage && (!req.ipCountry || req.ipLanguage === 'en');
  const t = (key, options = {}) => req.t(key, { lng: currentLanguage, ...options });
  const detectedCountry = req.ipCountry || 'N/A';
  const detectedLanguageLabel =
    LANGUAGE_OPTIONS.find((option) => option.code === (req.ipLanguage || 'en'))?.label || 'English';
  const detectionMessage = usedFallback
    ? t('ui.detectedLanguageFallback', { country: detectedCountry })
    : t('ui.detectedLanguageByIp', { language: detectedLanguageLabel, country: detectedCountry });

  return {
    t,
    currentLanguage,
    languageOptions: LANGUAGE_OPTIONS,
    isRtl: RTL_LANGUAGES.has(currentLanguage),
    error: null,
    summaryText: '',
    fullText: '',
    documentId: '',
    selectedProfile: 'historico',
    selectedPsm: '6',
    selectedLanguage: currentLanguage,
    detectedCountry,
    detectedLanguageLabel,
    detectionMessage,
    antiBotConfig: {
      faceCheckEnabled: FACE_ANTIBOT_ENABLED,
      faceCheckTestMode: FACE_ANTIBOT_TEST_MODE,
      faceChallengeEndpoint: '/face-check/challenge',
      faceChallengeTtlMs: FACE_CHALLENGE_TTL_MS,
    },
    paymentConfig: {
      paypalEnabled: PAYPAL_ENABLED,
      paypalClientId: PAYPAL_CLIENT_ID,
      paypalCurrency: PAYPAL_CURRENCY,
      paypalUnlockAmount: PAYPAL_UNLOCK_AMOUNT,
      paypalCreateOrderEndpoint: '/api/paypal/create-order',
      paypalCaptureOrderEndpoint: '/api/paypal/capture-order',
    },
    simulatePaymentEnabled: SIMULATE_PAYMENT_ENABLED,
    paymentMessage: '',
    currentUser: req.currentUser || null,
    ...extra,
  };
}

function renderPage(req, res, extra = {}) {
  return res.render('index', buildViewModel(req, extra));
}

function renderLogin(req, res, extra = {}) {
  const currentLanguage = normalizeLanguage(req.query?.lng || req.body?.language || req.ipLanguage || req.language);
  const t = (key, options = {}) => req.t(key, { lng: currentLanguage, ...options });
  return res.render('login', {
    t,
    currentLanguage,
    isRtl: RTL_LANGUAGES.has(currentLanguage),
    error: '',
    info: '',
    ...extra,
  });
}

function renderGallery(req, res, extra = {}) {
  const currentLanguage = normalizeLanguage(req.query?.lng || req.body?.language || req.ipLanguage || req.language);
  const t = (key, options = {}) => req.t(key, { lng: currentLanguage, ...options });
  return res.render('gallery', {
    t,
    currentLanguage,
    isRtl: RTL_LANGUAGES.has(currentLanguage),
    currentUser: req.currentUser || null,
    jobs: [],
    ...extra,
  });
}

async function listJobsForUser(userId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobId = entry.name;
    if (!safeJobId(jobId)) continue;
    const metaPath = path.join(JOBS_DIR, jobId, 'meta.json');
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      if (String(meta?.userId || '') !== String(userId)) continue;
      jobs.push({
        id: jobId,
        createdAt: meta?.createdAt || '',
        engine: meta?.engine || '',
        language: meta?.language || '',
        thumb: meta?.files?.thumb || '',
      });
    } catch (_error) {
    }
  }
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return jobs.slice(0, safeLimit);
}

function ocrCooldownMiddleware(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const lastAt = lastOcrAtByIp.get(ip);
  if (lastAt && now - lastAt < OCR_COOLDOWN_MS) {
    metricsState.cooldownHits += 1;
    markBotReason(res, 'cooldown');
    const waitSeconds = Math.ceil((OCR_COOLDOWN_MS - (now - lastAt)) / 1000);
    res.setHeader('Retry-After', String(Math.max(1, waitSeconds)));
    res.status(429);
    return renderPage(req, res, {
      error: tLang(req, 'errors.cooldown', { seconds: waitSeconds }),
      selectedLanguage: resolveLanguage(req),
    });
  }

  lastOcrAtByIp.set(ip, now);
  return next();
}

function requestTimeoutMiddleware(timeoutMs) {
  return (req, res, next) => {
    res.setTimeout(timeoutMs, () => {
      if (res.headersSent) {
        return;
      }
      res.status(408);
      renderPage(req, res, {
        error: tLang(req, 'errors.requestTimeout'),
        selectedLanguage: resolveLanguage(req),
      });
    });
    next();
  };
}

app.get('/', (req, res) => {
  getUserFromRequest(req)
    .then((user) => {
      req.currentUser = user;
      renderPage(req, res);
    })
    .catch(() => renderPage(req, res));
});

app.get('/login', async (req, res) => {
  const user = await getUserFromRequest(req).catch(() => null);
  if (user) {
    return res.redirect('/gallery');
  }
  return renderLogin(req, res);
});

app.post('/logout', async (req, res) => {
  const cookies = parseCookies(req.headers?.cookie);
  const sessionId = cookies[AUTH_COOKIE_NAME];
  await clearSession(res, sessionId);
  return res.redirect('/');
});

app.post('/auth/email/start', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const lng = normalizeLanguage(req.body?.language || req.query?.lng || req.ipLanguage || req.language);
  if (!email) {
    return renderLogin(req, res, { error: i18next.t('errors.invalidRequest', { lng }) });
  }

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM || !SMTP_USER || !SMTP_PASS) {
    return renderLogin(req, res, { error: 'SMTP not configured (missing host/port/from/user/pass).' });
  }

  const state = await loadAuthState();
  let userId = Object.keys(state.users).find((id) => state.users[id]?.email === email);
  if (!userId) {
    userId = randomId(12);
    state.users[userId] = { email, createdAt: Date.now() };
  }

  const token = randomId(24);
  const tokenHash = hashToken(token);
  state.magicLinks[tokenHash] = {
    userId,
    email,
    createdAt: Date.now(),
    expiresAt: Date.now() + AUTH_MAGICLINK_TTL_MS,
    used: false,
  };

  await saveAuthState(state);

  const link = new URL('/auth/email/callback', `${req.protocol}://${req.get('host')}`);
  link.searchParams.set('token', token);
  link.searchParams.set('lng', lng);

  try {
    const transport = createSmtpTransportIfConfigured();
    if (!transport) {
      throw new Error('SMTP_NOT_CONFIGURED');
    }

    try {
      await transport.verify();
    } catch (error) {
      console.error('[auth] smtp verify failed:', {
        message: String(error?.message || ''),
        code: error?.code,
        responseCode: error?.responseCode,
      });
      throw error;
    }

    await transport.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: 'Login link - manuscritos.live',
      text: `Login link (valid for ~${Math.round(AUTH_MAGICLINK_TTL_MS / 60000)} minutes):\n\n${link.toString()}\n`,
    });
  } catch (error) {
    console.error('[auth] email send failed:', {
      message: String(error?.message || ''),
      code: error?.code,
      responseCode: error?.responseCode,
    });
    return renderLogin(req, res, { error: 'Could not send email. Check SMTP settings.' });
  }

  return renderLogin(req, res, { info: 'Check your email for the login link.' });
});

app.get('/auth/email/callback', async (req, res) => {
  const token = String(req.query?.token || '').trim();
  const lng = normalizeLanguage(req.query?.lng || req.ipLanguage || req.language);
  if (!token) {
    return renderLogin(req, res, { error: i18next.t('errors.invalidRequest', { lng }) });
  }

  const state = await loadAuthState();
  const tokenHash = hashToken(token);
  const entry = state.magicLinks?.[tokenHash];
  if (!entry || entry.used) {
    return renderLogin(req, res, { error: i18next.t('errors.invalidRequest', { lng }) });
  }
  if (entry.expiresAt && Date.now() > Number(entry.expiresAt)) {
    delete state.magicLinks[tokenHash];
    await saveAuthState(state);
    return renderLogin(req, res, { error: i18next.t('errors.invalidRequest', { lng }) });
  }

  entry.used = true;
  state.magicLinks[tokenHash] = entry;
  await saveAuthState(state);

  await createSession(res, entry.userId);
  return res.redirect('/gallery');
});

app.post('/auth/metamask/nonce', async (req, res) => {
  const address = normalizeEthAddress(req.body?.address);
  if (!address) {
    return res.status(400).json({ ok: false, error: 'invalid_address' });
  }

  const state = await loadAuthState();
  const nonce = randomId(16);
  state.metamaskNonces[address] = {
    nonce,
    createdAt: Date.now(),
    expiresAt: Date.now() + AUTH_METAMASK_NONCE_TTL_MS,
  };
  await saveAuthState(state);
  return res.json({ ok: true, address, nonce, domain: req.get('host') });
});

app.post('/auth/metamask/verify', async (req, res) => {
  const address = normalizeEthAddress(req.body?.address);
  const signature = String(req.body?.signature || '').trim();
  const nonce = String(req.body?.nonce || '').trim();
  if (!address || !signature || !nonce) {
    return res.status(400).json({ ok: false, error: 'invalid_request' });
  }

  const state = await loadAuthState();
  const entry = state.metamaskNonces?.[address];
  if (!entry || entry.nonce !== nonce || (entry.expiresAt && Date.now() > Number(entry.expiresAt))) {
    return res.status(400).json({ ok: false, error: 'nonce_invalid' });
  }

  const message = `Login to manuscritos.live\nAddress: ${address}\nNonce: ${nonce}`;
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (_error) {
    return res.status(400).json({ ok: false, error: 'bad_signature' });
  }
  if (normalizeEthAddress(recovered) !== address) {
    return res.status(400).json({ ok: false, error: 'bad_signature' });
  }

  delete state.metamaskNonces[address];
  let userId = Object.keys(state.users).find((id) => state.users[id]?.ethAddress === address);
  if (!userId) {
    userId = randomId(12);
    state.users[userId] = { ethAddress: address, createdAt: Date.now() };
  }
  await saveAuthState(state);

  await createSession(res, userId);
  return res.json({ ok: true });
});

app.get('/gallery', requireAuth, async (req, res) => {
  const jobs = await listJobsForUser(req.currentUser.id, 60);
  return renderGallery(req, res, { jobs });
});

app.get('/gallery/:jobId', requireAuth, async (req, res) => {
  const jobId = safeJobId(req.params.jobId);
  if (!jobId) {
    return res.status(404).send('Not found');
  }
  const metaPath = path.join(JOBS_DIR, jobId, 'meta.json');
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    if (String(meta?.userId || '') !== String(req.currentUser.id)) {
      return res.status(404).send('Not found');
    }
    const summaryText = await fs.readFile(path.join(JOBS_DIR, jobId, 'summary.txt'), 'utf8').catch(() => '');
    const fullText = await fs.readFile(path.join(JOBS_DIR, jobId, 'full.txt'), 'utf8').catch(() => '');
    const fullRawText = meta?.files?.fullRaw
      ? await fs.readFile(path.join(JOBS_DIR, jobId, String(meta.files.fullRaw)), 'utf8').catch(() => '')
      : '';
    return renderGallery(req, res, {
      jobs: [],
      job: { id: jobId, meta },
      summaryText,
      fullText,
      fullRawText,
    });
  } catch (_error) {
    return res.status(404).send('Not found');
  }
});

app.get('/gallery/:jobId/file/:name', requireAuth, async (req, res) => {
  const jobId = safeJobId(req.params.jobId);
  const requested = String(req.params.name || '').trim();
  if (!jobId || !requested) {
    return res.status(404).send('Not found');
  }

  const metaPath = path.join(JOBS_DIR, jobId, 'meta.json');
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    if (String(meta?.userId || '') !== String(req.currentUser.id)) {
      return res.status(404).send('Not found');
    }

    const allowed = new Set();
    const files = meta?.files || {};
    for (const key of ['original', 'preprocessed', 'thumb', 'summary', 'full', 'fullRaw', 'meta']) {
      const name = files[key];
      if (name && typeof name === 'string') {
        allowed.add(name);
      }
    }

    if (!allowed.has(requested)) {
      return res.status(404).send('Not found');
    }

    const fullPath = path.join(JOBS_DIR, jobId, requested);
    return res.sendFile(fullPath);
  } catch (_error) {
    return res.status(404).send('Not found');
  }
});

app.post('/ops/openclaw/webhook', async (req, res) => {
  if (!OPENCLAW_WEBHOOK_SECRET) {
    return res.status(404).json({ ok: false });
  }

  const token = extractBearerToken(req);
  if (!token || token !== OPENCLAW_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const payload = req.body;
  const jobId = payload?.jobId || payload?.id || payload?.cronJobId || '';
  const name = payload?.name || payload?.jobName || 'OpenClaw';
  const ok = payload?.ok;
  const status = typeof ok === 'boolean' ? (ok ? 'OK' : 'ERROR') : String(payload?.status || 'EVENT');

  const subject = `[OpenClaw] ${name} ${status}${jobId ? ` (${jobId})` : ''}`;
  const text = JSON.stringify(payload, null, 2);

  try {
    await sendAlertEmail(subject, text);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'send_failed' });
  }
});

function extractAdminToken(req) {
  const auth = String(req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const q = req.query?.token;
  return q ? String(q).trim() : '';
}

function requireAdminStatsToken(req, res, next) {
  if (!ADMIN_STATS_TOKEN) {
    return res.status(404).send('Not found');
  }

  const token = extractAdminToken(req);
  if (!token || token !== ADMIN_STATS_TOKEN) {
    markBotReason(res, 'admin_denied');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  return next();
}

app.get('/admin/stats', requireAdminStatsToken, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const recent = req.query?.recent;
  return res.json(buildMetricsSnapshot(recent));
});

app.get('/admin/stats/dashboard', requireAdminStatsToken, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Token se valida por middleware; en el dashboard se reutiliza via query (?token=...)
  const token = extractAdminToken(req);
  const recent = Number(req.query?.recent || 200);
  return res.render('admin-stats', {
    token,
    recent: Number.isFinite(recent) ? Math.max(10, Math.min(200, recent)) : 200,
  });
});

app.get('/face-check/challenge', (req, res) => {
  if (!FACE_ANTIBOT_ENABLED && !FACE_ANTIBOT_TEST_MODE) {
    return res.status(404).json({ ok: false });
  }

  const { token, expiresAt } = issueFaceChallenge(req);
  return res.json({ ok: true, token, expiresAt });
});

app.post('/api/paypal/create-order', async (req, res) => {
  const selectedLanguage = normalizeLanguage(req.body?.language || req.query?.lng || req.ipLanguage || req.language);

  if (!PAYPAL_ENABLED) {
    return res.status(400).json({ ok: false, error: i18next.t('errors.paypalNotConfigured', { lng: selectedLanguage }) });
  }

  const documentId = String(req.body?.document_id || '').trim();
  if (!documentId || !mockDocuments.has(documentId)) {
    return res.status(400).json({ ok: false, error: i18next.t('errors.documentNotFound', { lng: selectedLanguage }) });
  }

  if (!isValidMoneyAmount(PAYPAL_UNLOCK_AMOUNT)) {
    return res.status(500).json({ ok: false, error: i18next.t('errors.invalidRequest', { lng: selectedLanguage }) });
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: documentId,
            amount: {
              currency_code: PAYPAL_CURRENCY,
              value: PAYPAL_UNLOCK_AMOUNT,
            },
            description: `Unlock document ${documentId}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      return res.status(502).json({ ok: false, error: i18next.t('errors.paypalOrderFailed', { lng: selectedLanguage }) });
    }

    const data = await response.json();
    const orderId = String(data?.id || '').trim();
    if (!orderId) {
      return res.status(502).json({ ok: false, error: i18next.t('errors.paypalOrderFailed', { lng: selectedLanguage }) });
    }

    paypalOrders.set(orderId, {
      documentId,
      status: 'CREATED',
      createdAt: Date.now(),
      used: false,
    });

    return res.json({ ok: true, orderId });
  } catch (_error) {
    return res.status(502).json({ ok: false, error: i18next.t('errors.paypalOrderFailed', { lng: selectedLanguage }) });
  }
});

app.post('/api/paypal/capture-order', async (req, res) => {
  const selectedLanguage = normalizeLanguage(req.body?.language || req.query?.lng || req.ipLanguage || req.language);

  if (!PAYPAL_ENABLED) {
    return res.status(400).json({ ok: false, error: i18next.t('errors.paypalNotConfigured', { lng: selectedLanguage }) });
  }

  const orderId = String(req.body?.order_id || '').trim();
  const documentId = String(req.body?.document_id || '').trim();
  if (!orderId || !documentId) {
    return res.status(400).json({ ok: false, error: i18next.t('errors.invalidRequest', { lng: selectedLanguage }) });
  }

  const local = paypalOrders.get(orderId);
  if (!local || local.documentId !== documentId || local.used) {
    return res.status(400).json({ ok: false, error: i18next.t('errors.paypalCaptureFailed', { lng: selectedLanguage }) });
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      return res.status(502).json({ ok: false, error: i18next.t('errors.paypalCaptureFailed', { lng: selectedLanguage }) });
    }

    const data = await response.json();
    const status = String(data?.status || '');
    if (status !== 'COMPLETED') {
      return res.status(400).json({ ok: false, error: i18next.t('errors.paypalCaptureFailed', { lng: selectedLanguage }) });
    }

    local.status = 'CAPTURED';
    local.capturedAt = Date.now();
    paypalOrders.set(orderId, local);

    return res.json({ ok: true });
  } catch (_error) {
    return res.status(502).json({ ok: false, error: i18next.t('errors.paypalCaptureFailed', { lng: selectedLanguage }) });
  }
});

app.post('/', ocrLimiter, requestTimeoutMiddleware(45 * 1000), upload.single('image'), ocrCooldownMiddleware, async (req, res) => {
  req.currentUser = await getUserFromRequest(req).catch(() => null);
  const selectedProfile = req.body.profile || 'historico';
  const selectedPsm = req.body.psm || '6';
  const selectedLanguage = normalizeLanguage(req.body.language || req.query?.lng || req.ipLanguage || req.language);
  const clientPreprocessed = req.body.client_preprocessed === '1';

  if ((req.body.website_url || '').trim() !== '') {
    metricsState.honeypotHits += 1;
    markBotReason(res, 'honeypot');
    res.status(400);
    return renderPage(req, res, {
      error: i18next.t('errors.botBlocked', { lng: selectedLanguage }),
      selectedProfile,
      selectedPsm,
      selectedLanguage,
    });
  }

  if (!req.file) {
    res.status(400);
    return renderPage(req, res, {
      error: i18next.t('errors.selectImage', { lng: selectedLanguage }),
      selectedProfile,
      selectedPsm,
      selectedLanguage,
    });
  }

  if (FACE_ANTIBOT_ENABLED) {
    const faceCheckToken = req.body.face_check_token;
    if (!verifyFaceChallenge(req, faceCheckToken)) {
      metricsState.faceCheckFails += 1;
      markBotReason(res, 'face_check_fail');
      res.status(400);
      return renderPage(req, res, {
        error: i18next.t('errors.faceCheckInvalid', { lng: selectedLanguage }),
        selectedProfile,
        selectedPsm,
        selectedLanguage,
      });
    }
  }

  const jobId = path.parse(req.file.filename).name;
  const preprocessedPath = path.join(WORK_DIR, `${jobId}_preprocessed.png`);
  try {
    let ocrInputPath = req.file.path;
    const uploadExt = path.extname(String(req.file.originalname || req.file.filename || '')).toLowerCase();
    const uploadMime = String(req.file.mimetype || '').toLowerCase();
    const isPdf = uploadExt === '.pdf' || uploadMime === 'application/pdf';

    if (!clientPreprocessed && !isPdf) {
      await preprocessImage(req.file.path, preprocessedPath, selectedProfile);
      ocrInputPath = preprocessedPath;
    }

    let summaryText = '';
    let fullText = '';
    let fullTextRaw = '';
    let postprocessMeta = null;

    const engine = isDocAiConfigured() ? 'docai' : 'mock';
    if (engine === 'docai') {
      const raw = await runDocAiOcr(ocrInputPath, { jobId });
      const post = await postprocessTextIfEnabled(raw, { jobId });
      fullText = post.text;
      fullTextRaw = raw;
      postprocessMeta = post.meta;
      summaryText = buildSummaryFromFullText(fullText);
    } else {
      summaryText = buildMockSummary(selectedLanguage);
      fullText = buildMockFullDocument(selectedLanguage);
    }

    mockDocuments.set(jobId, { summaryText, fullText, language: selectedLanguage });

    const visitorKey = hashIpForMetrics(getClientIp(req));
    await persistJob({
      jobId,
      uploadedFile: req.file,
      preprocessedPath: ocrInputPath === preprocessedPath ? preprocessedPath : null,
      summaryText,
      fullText,
      fullTextRaw,
      userId: req.currentUser?.id || '',
      language: selectedLanguage,
      profile: selectedProfile,
      psm: selectedPsm,
      engine,
      clientPreprocessed: Boolean(clientPreprocessed && !isPdf),
      ipHash: visitorKey,
      postprocess: postprocessMeta || null,
    });

    return renderPage(req, res, {
      summaryText,
      fullText: '',
      documentId: jobId,
      selectedProfile,
      selectedPsm,
      selectedLanguage,
    });
  } catch (error) {
    res.status(500);
    return renderPage(req, res, {
      error: i18next.t('errors.prepareMock', { lng: selectedLanguage }),
      selectedProfile,
      selectedPsm,
      selectedLanguage,
    });
  }
});

app.post('/unlock', (req, res) => {
  const { document_id: documentId, payment_method: paymentMethod } = req.body;
  const selectedLanguage = normalizeLanguage(req.body.language || req.query?.lng || req.ipLanguage || req.language);

  if (!documentId || !paymentMethod) {
    res.status(400);
    return renderPage(req, res, {
      error: i18next.t('errors.missingPaymentData', { lng: selectedLanguage }),
      selectedLanguage,
    });
  }

  const finishUnlock = (doc) => {
    const language = doc.language || selectedLanguage;
    const methodLabel = paymentMethod === 'paypal'
      ? i18next.t('payment.paypalLabel', { lng: language })
      : (paymentMethod === 'simulate'
        ? i18next.t('payment.simulateLabel', { lng: language })
        : i18next.t('payment.metamaskLabel', { lng: language }));
    const paymentMessage = i18next.t('messages.paymentSuccess', {
      lng: language,
      method: methodLabel,
    });

    return renderPage(req, res, {
      summaryText: doc.summaryText,
      fullText: doc.fullText,
      documentId,
      selectedLanguage: language,
      paymentMessage,
    });
  };

  let doc = mockDocuments.get(documentId);
  if (!doc) {
    // Permite desbloquear tras reinicios leyendo resultado guardado en disco.
    // Nota: endpoint síncrono; usamos IIFE async y devolvemos.
    (async () => {
      const fromDisk = await loadJobFromDisk(documentId);
      if (!fromDisk) {
        res.status(404);
        return renderPage(req, res, {
          error: i18next.t('errors.documentNotFound', { lng: selectedLanguage }),
          selectedLanguage,
        });
      }
      doc = {
        summaryText: fromDisk.summaryText,
        fullText: fromDisk.fullText,
        language: fromDisk.language || selectedLanguage,
      };
      mockDocuments.set(documentId, doc);
      return finishUnlock(doc);
    })();
    return;
  }

  if (paymentMethod === 'paypal' && PAYPAL_ENABLED) {
    const orderId = String(req.body.paypal_order_id || '').trim();
    const local = orderId ? paypalOrders.get(orderId) : null;
    if (!orderId || !local || local.documentId !== documentId || local.status !== 'CAPTURED' || local.used) {
      res.status(400);
      return renderPage(req, res, {
        error: i18next.t('errors.paypalCaptureFailed', { lng: selectedLanguage }),
        selectedLanguage,
      });
    }
    local.used = true;
    paypalOrders.set(orderId, local);
  }

  if (paymentMethod === 'simulate') {
    if (!SIMULATE_PAYMENT_ENABLED) {
      res.status(404);
      return renderPage(req, res, {
        error: i18next.t('errors.invalidRequest', { lng: selectedLanguage }),
        selectedLanguage,
      });
    }
  }

  return finishUnlock(doc);
});

app.use((error, req, res, _next) => {
  const selectedLanguage = normalizeLanguage(req?.query?.lng || req?.body?.language || req?.ipLanguage || req?.language);
  const isFileTooLarge = error?.code === 'LIMIT_FILE_SIZE';
  res.status(400);
  renderPage(req, res, {
    error: isFileTooLarge
      ? i18next.t('errors.fileTooLarge', { lng: selectedLanguage, sizeMB: Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024)) })
      : (error.message || i18next.t('errors.invalidRequest', { lng: selectedLanguage })),
    selectedLanguage,
  });
});

async function initI18n() {
  await i18next
    .use(i18nextBackend)
    .use(i18nextMiddleware.LanguageDetector)
    .init({
      fallbackLng: 'en',
      preload: SUPPORTED_LANGUAGES,
      supportedLngs: SUPPORTED_LANGUAGES,
      ns: ['translation'],
      defaultNS: 'translation',
      backend: {
        loadPath: path.join(LOCALES_DIR, '{{lng}}/translation.json'),
      },
      detection: {
        order: ['querystring', 'body', 'header'],
        lookupQuerystring: 'lng',
        lookupBody: 'language',
      },
      interpolation: {
        escapeValue: false,
      },
    });
}

async function start() {
  await ensureDirs();
  await initI18n();
  const cleanupTimer = setInterval(cleanupFaceChallenges, 60 * 1000);
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor OCR en http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('No se pudo iniciar el servidor OCR:', error);
  process.exit(1);
});