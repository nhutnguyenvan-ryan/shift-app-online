require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DATABASE ──────────────────────────────────────────────────────────────────
// Dùng PostgreSQL trên Render (free tier), hoặc fallback in-memory nếu chưa có DB
let db = null;
let memStore = { config: null, editors: [], owner: process.env.OWNER_EMAIL || '' };

if (process.env.DATABASE_URL) {
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  // Init tables
  db.query(`
    CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT);
  `).catch(console.error);
}

async function dbGet(key) {
  if (!db) return memStore[key] ?? null;
  const r = await db.query('SELECT value FROM kv_store WHERE key=$1', [key]);
  return r.rows[0] ? JSON.parse(r.rows[0].value) : null;
}
async function dbSet(key, value) {
  if (!db) { memStore[key] = value; return; }
  await db.query(
    'INSERT INTO kv_store(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
    [key, JSON.stringify(value)]
  );
}

// ── SESSION ───────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'shiftiq-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 ngày
  }
}));

// ── PASSPORT / GOOGLE OAUTH ───────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || 'PLACEHOLDER',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'PLACEHOLDER',
  callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  done(null, {
    id: profile.id,
    email: profile.emails?.[0]?.value || '',
    name: profile.displayName,
    photo: profile.photos?.[0]?.value || ''
  });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ── ROLE HELPER ───────────────────────────────────────────────────────────────
async function getRole(email) {
  if (!email) return 'viewer';
  const owner = await dbGet('owner') || process.env.OWNER_EMAIL || '';
  console.log('DEBUG getRole:', email, '| owner:', owner); // ← thêm dòng này
  if (email === owner) return 'owner';
  const editors = await dbGet('editors') || [];
  if (editors.includes(email)) return 'editor';
  return 'viewer';
}

// ── API: ME ───────────────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  const user = req.user || null;
  const role = user ? await getRole(user.email) : 'viewer';
  res.json({ user, role });
});

// ── API: SHEET PROXY ──────────────────────────────────────────────────────────
// Fetch Apps Script / Google Sheets URL phía server để tránh CORS
// Client gọi: GET /api/fetch-sheet?url=...&type=inflow
app.get('/api/fetch-sheet', async (req, res) => {
  // Cho phép viewer fetch (chỉ đọc data)
  const targetUrl = req.query.url;
  const type = req.query.type || 'inflow';
  if (!targetUrl) return res.status(400).json({ error: 'Missing url param' });

  // Chỉ cho phép fetch từ Google domains
  const allowed = /^https:\/\/(script\.google\.com|docs\.google\.com|sheets\.googleapis\.com)/;
  if (!allowed.test(targetUrl)) {
    return res.status(403).json({ error: 'URL không được phép — chỉ hỗ trợ Google domains' });
  }

  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const upstream = await fetch(targetUrl + (targetUrl.includes('?') ? '&' : '?') + 'type=' + type, {
      headers: {
        'Accept': 'application/json, text/csv, text/plain, */*',
        'User-Agent': 'ShiftIQ-Server/1.0'
      },
      redirect: 'follow'
    });

    const contentType = upstream.headers.get('content-type') || '';
    const text = await upstream.text();

    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream HTTP ${upstream.status}`, detail: text.slice(0, 200) });
    }

    // Trả về raw text + content-type để client tự parse
    res.setHeader('Content-Type', contentType || 'text/plain');
    res.setHeader('X-Upstream-Status', upstream.status);
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── API: CONFIG ───────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  const config = await dbGet('config');
  res.json({ config });
});

app.post('/api/config', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const role = await getRole(req.user.email);
  if (role === 'viewer') return res.status(403).json({ error: 'Forbidden' });
  await dbSet('config', req.body);
  res.json({ ok: true });
});

// ── API: USERS ────────────────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const role = await getRole(req.user.email);
  if (role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const editors = await dbGet('editors') || [];
  res.json({ editors });
});

app.post('/api/users/editors', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const role = await getRole(req.user.email);
  if (role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const editors = await dbGet('editors') || [];
  if (!editors.includes(email)) { editors.push(email); await dbSet('editors', editors); }
  res.json({ ok: true });
});

app.delete('/api/users/editors/:email', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const role = await getRole(req.user.email);
  if (role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const email = decodeURIComponent(req.params.email);
  const editors = (await dbGet('editors') || []).filter(e => e !== email);
  await dbSet('editors', editors);
  res.json({ ok: true });
});

// ── STATIC FILES ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ShiftIQ running on port ${PORT}`);
  if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'PLACEHOLDER') {
    console.warn('⚠️  GOOGLE_CLIENT_ID chưa được set — Google OAuth sẽ không hoạt động');
  }
});
