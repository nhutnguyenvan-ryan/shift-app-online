require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER_EMAIL = process.env.OWNER_EMAIL;

// ─── Data store (JSON file) ──────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ configs: {}, sharedConfig: null }));
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({ editors: [] }));
}
ensureDataDir();

function readData() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function writeData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
function readUsers() { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
function writeUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

// ─── Passport / Google OAuth ─────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${process.env.BASE_URL}/auth/google/callback`
}, (accessToken, refreshToken, profile, done) => {
  const email = profile.emails[0].value;
  const user = {
    id: profile.id,
    email,
    name: profile.displayName,
    photo: profile.photos[0]?.value
  };
  return done(null, user);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Role helpers ─────────────────────────────────────────────────────────────
function getRole(email) {
  if (!email) return 'viewer';
  if (email === OWNER_EMAIL) return 'owner';
  const users = readUsers();
  if (users.editors.includes(email)) return 'editor';
  return 'viewer';
}

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function requireEditor(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  const role = getRole(req.user.email);
  if (role === 'owner' || role === 'editor') return next();
  res.status(403).json({ error: 'Editor access required' });
}

function requireOwner(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  if (getRole(req.user.email) !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ user: null, role: 'viewer' });
  res.json({ user: req.user, role: getRole(req.user.email) });
});

// ─── User management (owner only) ────────────────────────────────────────────
app.get('/api/users', requireOwner, (req, res) => {
  res.json(readUsers());
});

app.post('/api/users/editors', requireOwner, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const users = readUsers();
  if (!users.editors.includes(email)) users.editors.push(email);
  writeUsers(users);
  res.json({ success: true, editors: users.editors });
});

app.delete('/api/users/editors/:email', requireOwner, (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const users = readUsers();
  users.editors = users.editors.filter(e => e !== email);
  writeUsers(users);
  res.json({ success: true, editors: users.editors });
});

// ─── Config save/load ─────────────────────────────────────────────────────────
// Save current config (editor/owner only)
app.post('/api/config', requireEditor, (req, res) => {
  const data = readData();
  data.sharedConfig = { ...req.body, savedBy: req.user.email, savedAt: new Date().toISOString() };
  writeData(data);
  res.json({ success: true });
});

// Load shared config (all roles including viewer)
app.get('/api/config', (req, res) => {
  const data = readData();
  res.json({ config: data.sharedConfig, role: req.isAuthenticated() ? getRole(req.user.email) : 'viewer' });
});

// ─── Serve app ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Shift Scheduling App running at http://localhost:${PORT}`);
  console.log(`   Owner: ${OWNER_EMAIL}`);
  console.log(`   Google OAuth callback: ${process.env.BASE_URL}/auth/google/callback\n`);
});
