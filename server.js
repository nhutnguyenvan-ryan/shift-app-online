require('dotenv').config();
console.log('ENV OWNER_EMAIL:', JSON.stringify(process.env.OWNER_EMAIL));

const express    = require('express');
const session    = require('express-session');
const passport   = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Pool }   = require('pg');
const PgSession  = require('connect-pg-simple')(session);
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// Render chạy sau reverse proxy — bắt buộc để cookie secure hoạt động
app.set('trust proxy', 1);

// ── DATABASE ──────────────────────────────────────────────────────────────────
let db = null;
const memStore = { config: null, editors: [] };

if (process.env.DATABASE_URL) {
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  // Tạo bảng kv_store (data) và session (connect-pg-simple)
  db.query(`
    CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS "session" (
      "sid"    varchar   NOT NULL COLLATE "default",
      "sess"   json      NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `).then(() => console.log('DB tables ready'))
    .catch(e  => console.error('DB init error:', e.message));
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

// ── SESSION — lưu vào PostgreSQL nếu có DB, fallback MemoryStore ─────────────
app.use(express.json({ limit: '10mb' }));

const sessionStore = db
  ? new PgSession({ pool: db, tableName: 'session', createTableIfMissing: true })
  : undefined; // undefined = MemoryStore (chỉ dùng khi dev local)

app.use(session({
  store:             sessionStore,
  secret:            process.env.SESSION_SECRET || 'shiftiq-dev-secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   true,   // HTTPS only (Render luôn HTTPS)
    sameSite: 'lax',  // cho phép redirect sau OAuth
    maxAge:   7 * 24 * 60 * 60 * 1000
  }
}));

// ── PASSPORT ──────────────────────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID     || 'PLACEHOLDER',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'PLACEHOLDER',
  callbackURL:  process.env.GOOGLE_CALLBACK_URL  || '/auth/google/callback'
}, (_at, _rt, profile, done) => {
  done(null, {
    id:    profile.id,
    email: profile.emails?.[0]?.value || '',
    name:  profile.displayName,
    photo: profile.photos?.[0]?.value || ''
  });
}));

passport.serializeUser((user, done)   => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    console.log('OAuth OK | user:', req.user?.email, '| sid:', req.sessionID);
    res.redirect('/');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ── ROLE ──────────────────────────────────────────────────────────────────────
async function getRole(email) {
  if (!email) return 'viewer';
  const owner = await dbGet('owner') || process.env.OWNER_EMAIL || '';
  console.log('getRole | email:', email, '| owner:', owner);
  if (email === owner) return 'owner';
  const editors = await dbGet('editors') || [];
  if (editors.includes(email)) return 'editor';
  return 'viewer';
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  console.log('/api/me | sid:', req.sessionID, '| user:', req.user?.email || 'none');
  const user = req.user || null;
  const role = user ? await getRole(user.email) : 'viewer';
  res.json({ user, role });
});

app.get('/api/fetch-sheet', async (req, res) => {
  const targetUrl = req.query.url;
  const type      = req.query.type || 'inflow';
  if (!targetUrl) return res.status(400).json({ error: 'Missing url param' });
  const allowed = /^https:\/\/(script\.google\.com|docs\.google\.com|sheets\.googleapis\.com)/;
  if (!allowed.test(targetUrl)) return res.status(403).json({ error: 'URL không được phép' });
  try {
    const { default: fetch } = await import('node-fetch');
    const upstream = await fetch(
      targetUrl + (targetUrl.includes('?') ? '&' : '?') + 'type=' + type,
      { headers: { Accept: 'application/json, text/csv, */*', 'User-Agent': 'ShiftIQ/1.0' }, redirect: 'follow' }
    );
    const ct   = upstream.headers.get('content-type') || '';
    const text = await upstream.text();
    if (!upstream.ok) return res.status(502).json({ error: `Upstream ${upstream.status}`, detail: text.slice(0,200) });
    res.setHeader('Content-Type', ct || 'text/plain');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/config', async (req, res) => {
  res.json({ config: await dbGet('config') });
});

app.post('/api/config', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (await getRole(req.user.email) === 'viewer') return res.status(403).json({ error: 'Forbidden' });
  await dbSet('config', req.body);
  res.json({ ok: true });
});

app.get('/api/users', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (await getRole(req.user.email) !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  res.json({ editors: await dbGet('editors') || [] });
});

app.post('/api/users/editors', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (await getRole(req.user.email) !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const editors = await dbGet('editors') || [];
  if (!editors.includes(email)) { editors.push(email); await dbSet('editors', editors); }
  res.json({ ok: true });
});

app.delete('/api/users/editors/:email', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (await getRole(req.user.email) !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const email   = decodeURIComponent(req.params.email);
  const editors = (await dbGet('editors') || []).filter(e => e !== email);
  await dbSet('editors', editors);
  res.json({ ok: true });
});

// ── STATIC — tìm index.html ở public/ hoặc root ──────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  const inPublic = path.join(__dirname, 'public', 'index.html');
  const inRoot   = path.join(__dirname, 'index.html');
  res.sendFile(fs.existsSync(inPublic) ? inPublic : inRoot);
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`ShiftIQ on port ${PORT}`));
