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

const app = express();
const PORT = process.env.PORT || 8000;

const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const WORK_DIR = path.join(DATA_DIR, 'work');
const LOCALES_DIR = path.join(BASE_DIR, 'locales');

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.heic', '.heif']);
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
const OCR_COOLDOWN_MS = 15 * 1000;
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

const OPENCLAW_WEBHOOK_SECRET = String(process.env.OPENCLAW_WEBHOOK_SECRET || '').trim();
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').trim() === '1';
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim();
const SMTP_FROM = String(process.env.SMTP_FROM || '').trim();
const ALERT_EMAIL_TO = String(process.env.ALERT_EMAIL_TO || '').trim();
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

function buildMetricsSnapshot() {
  const now = Date.now();
  pruneUniqueVisitors(now);

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
    recentEvents: metricsState.recentEvents.slice(-50),
  };
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
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM || !ALERT_EMAIL_TO) {
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

    if (ext) {
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        metricsState.unsupportedFormatHits += 1;
        const err = new Error(req.t('errors.unsupportedFormat'));
        err.code = 'UNSUPPORTED_FORMAT';
        return cb(err);
      }
    } else if (!looksLikeImage) {
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
    paymentMessage: '',
    ...extra,
  };
}

function renderPage(req, res, extra = {}) {
  return res.render('index', buildViewModel(req, extra));
}

function ocrCooldownMiddleware(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const lastAt = lastOcrAtByIp.get(ip);
  if (lastAt && now - lastAt < OCR_COOLDOWN_MS) {
    metricsState.cooldownHits += 1;
    markBotReason(res, 'cooldown');
    const waitSeconds = Math.ceil((OCR_COOLDOWN_MS - (now - lastAt)) / 1000);
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
  renderPage(req, res);
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
  return res.json(buildMetricsSnapshot());
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
    if (!clientPreprocessed) {
      await preprocessImage(req.file.path, preprocessedPath, selectedProfile);
    }

    const summaryText = buildMockSummary(selectedLanguage);
    const fullText = buildMockFullDocument(selectedLanguage);
    mockDocuments.set(jobId, { summaryText, fullText, language: selectedLanguage });

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

  const doc = mockDocuments.get(documentId);
  if (!doc) {
    res.status(404);
    return renderPage(req, res, {
      error: i18next.t('errors.documentNotFound', { lng: selectedLanguage }),
      selectedLanguage,
    });
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

  const language = doc.language || selectedLanguage;
  const methodLabel = paymentMethod === 'paypal'
    ? i18next.t('payment.paypalLabel', { lng: language })
    : i18next.t('payment.metamaskLabel', { lng: language });
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