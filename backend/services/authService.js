const crypto = require('crypto');
const axios = require('axios');
const storage = require('./storageService');
const configService = require('./configService');

const sessions = new Map();
const attempts = new Map();
let certificates = null;
let certificateExpiry = 0;

function equal(left, right) {
  const first = crypto.createHash('sha256').update(String(left || '')).digest();
  const second = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(first, second);
}

function cookieToken(req) {
  return (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('ct_session='))?.slice(11);
}

function authenticate(req) {
  const token = cookieToken(req);
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return session;
}

function issueSession(req, res, user) {
  for (const [token, session] of sessions) if (session.expires < Date.now()) sessions.delete(token);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, expires: Date.now() + 8 * 60 * 60 * 1000 });
  const secure = req.secure || process.env.COOKIE_SECURE === 'true';
  res.cookie('ct_session', token, { httpOnly: true, sameSite: 'strict', secure, maxAge: 8 * 60 * 60 * 1000, path: '/' });
  res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
}

function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}

function rateLimit(req, res, next) {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  const key = req.ip;
  const entry = attempts.get(key) || { count: 0, until: now + 60000 };
  entry.count++;
  attempts.set(key, entry);
  if (entry.count > 10 || attempts.size > 10000) return res.status(429).json({ error: 'Too many login attempts; wait one minute' });
  next();
}

async function verifyFirebase(token, projectId) {
  if (typeof token !== 'string' || token.length > 16000 || !projectId) throw new Error('Firebase authentication is not configured');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid identity token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || !header.kid || claims.aud !== projectId || claims.iss !== 'https://securetoken.google.com/' + projectId || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128 || !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now || !Number.isFinite(claims.auth_time) || claims.auth_time > now) throw new Error('Invalid or expired identity token');
  if (!certificates || certificateExpiry <= Date.now()) {
    const response = await axios.get('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', { timeout: 5000 });
    certificates = response.data;
    const seconds = Number(String(response.headers['cache-control'] || '').match(/max-age=(\d+)/)?.[1] || 300);
    certificateExpiry = Date.now() + Math.min(seconds, 3600) * 1000;
  }
  const certificate = certificates[header.kid];
  if (!certificate || !crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), certificate, Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid token signature');
  return claims;
}

function mount(app) {
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin requests are prohibited' });
    next();
  });
  app.get('/api/auth/firebase-config', (req, res) => {
    const firebase = configService.loadConfig().firebase || {};
    res.json(Object.fromEntries(['apiKey', 'authDomain', 'projectId', 'appId'].filter(key => firebase[key]).map(key => [key, firebase[key]])));
  });
  app.post('/api/auth/login', rateLimit, (req, res) => {
    const expected = process.env.APP_ADMIN_PASSWORD;
    if (!expected || expected.length < 16) return res.status(503).json({ error: 'Administrator login requires APP_ADMIN_PASSWORD (at least 16 characters)' });
    if (typeof req.body.password !== 'string' || !equal(req.body.password, expected)) return res.status(401).json({ error: 'Invalid credentials' });
    const user = configService.loadConfig().users.find(entry => entry.id === 'usr_default');
    if (!user) return res.status(503).json({ error: 'Administrator account is not configured' });
    issueSession(req, res, user);
  });
  app.post('/api/auth/firebase-success', rateLimit, async (req, res) => {
    try {
      const config = configService.loadConfig();
      const claims = await verifyFirebase(req.body.idToken, config.firebase?.projectId);
      let user = config.users.find(entry => entry.firebaseUid === claims.sub);
      if (!user) {
        user = { id: 'usr_fb_' + crypto.createHash('sha256').update(claims.sub).digest('hex').slice(0, 24), firebaseUid: claims.sub, name: claims.name || 'User', email: claims.email_verified ? claims.email : '', phone: claims.phone_number || '', accounts: [], mappings: [] };
        config.users.push(user);
        configService.saveConfig(config);
      }
      issueSession(req, res, user);
    } catch (error) {
      res.status(401).json({ error: 'Firebase identity could not be verified' });
    }
  });
  for (const route of ['send-otp', 'verify-otp', 'google']) app.post('/api/auth/' + route, (req, res) => res.status(410).json({ error: 'Use verified Firebase authentication or administrator login' }));
  app.post('/api/auth/logout', (req, res) => {
    sessions.delete(cookieToken(req));
    res.clearCookie('ct_session', { path: '/' });
    res.json({ success: true });
  });
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/webhooks/')) {
      const secret = process.env.WEBHOOK_SECRET;
      if (!secret || secret.length < 32 || !equal(req.headers['x-webhook-secret'] || req.query.secret, secret)) return res.status(401).json({ error: 'Invalid webhook credentials' });
      return next();
    }
    const session = authenticate(req);
    if (!session) return res.status(401).json({ error: 'Authentication required' });
    req.userId = session.userId;
    req.headers['x-user-id'] = session.userId;
    const user = configService.loadConfig().users.find(entry => entry.id === session.userId);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    const match = req.path.match(/^\/(?:connect|portfolio|orders|accounts)\/([^/]+)/);
    const accountId = req.body?.accountId || req.body?.masterId || (match && !['cancel', 'modify'].includes(match[1]) ? decodeURIComponent(match[1]) : null);
    if (accountId && !user.accounts.some(account => account.id === accountId)) return res.status(404).json({ error: 'Account not found' });
    next();
  });
  app.get('/api/auth/me', (req, res) => {
    const user = configService.loadConfig().users.find(entry => entry.id === req.userId);
    res.json({ user: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
  });
}

module.exports = { mount, authenticate, sameOrigin, verifyFirebase };
