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

app.set('trust proxy', 1);

// ── DATABASE ──────────────────────────────────────────────────────────────────
let db = null;
const memStore = { config: null, editors: [] };

if (process.env.DATABASE_URL) {
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  db.query(`
    CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS "session" (
      "sid"    varchar      NOT NULL COLLATE "default",
      "sess"   json         NOT NULL,
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

// ── SESSION ───────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

const sessionStore = db
  ? new PgSession({ pool: db, tableName: 'session', createTableIfMissing: true })
  : undefined;

app.use(session({
  store:             sessionStore,
  secret:            process.env.SESSION_SECRET || 'shiftiq-dev-secret',
  resave:            false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
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
    console.log('OAuth OK | user:', req.user?.email);
    res.redirect('/');
  }
);
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

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

// ── GOOGLE SHEETS API via Service Account ─────────────────────────────────────
// Tạo JWT access token từ Service Account key (không cần thư viện nặng)
async function getServiceAccountToken() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY chưa được set trong Environment Variables');

  let key;
  try { key = JSON.parse(keyJson); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY không phải JSON hợp lệ'); }

  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  };

  // Tạo JWT bằng crypto (built-in Node.js, không cần thư viện)
  const crypto = require('crypto');
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const toSign  = `${header}.${payload}`;

  // Private key từ service account JSON
  const privateKey = key.private_key;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(toSign);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = `${toSign}.${signature}`;

  // Đổi JWT → access token
  const { default: fetch } = await import('node-fetch');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Không lấy được token: ' + JSON.stringify(data));
  return data.access_token;
}

// Đọc 1 sheet từ Spreadsheet ID + tên tab, trả về mảng rows [{col:val,...}]
async function readSheet(spreadsheetId, sheetName) {
  const token = await getServiceAccountToken();
  const { default: fetch } = await import('node-fetch');
  const range = encodeURIComponent(`${sheetName}!A:Z`);
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`;
  const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data  = await resp.json();
  if (data.error) throw new Error(`Sheets API: ${data.error.message}`);
  const [headers, ...rows] = data.values || [];
  if (!headers) return [];
  return rows.map(r => Object.fromEntries(headers.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// Parse Spreadsheet ID từ URL hoặc raw ID
function parseSpreadsheetId(urlOrId) {
  const m = urlOrId.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(urlOrId.trim())) return urlOrId.trim();
  return null;
}

// ── API: FETCH SHEET (Service Account) ───────────────────────────────────────
// GET /api/fetch-sheet?spreadsheetId=...&sheet=Inflow&type=inflow
// hoặc  ?url=https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/...
app.get('/api/fetch-sheet', async (req, res) => {
  try {
    // Lấy spreadsheetId từ param url hoặc spreadsheetId
    let spreadsheetId = req.query.spreadsheetId;
    if (!spreadsheetId && req.query.url) {
      spreadsheetId = parseSpreadsheetId(req.query.url);
    }
    if (!spreadsheetId) {
      return res.status(400).json({ error: 'Cần truyền spreadsheetId hoặc url chứa Spreadsheet ID' });
    }

    const type      = (req.query.type || 'inflow').toLowerCase();
    const sheetName = req.query.sheet || (type === 'enqueue' ? 'Enqueue' : 'Inflow');

    console.log(`fetch-sheet | type:${type} sheet:${sheetName} id:${spreadsheetId}`);
    const rows = await readSheet(spreadsheetId, sheetName);

    // Helper: parse số với cả dấu chấm và dấu phẩy thập phân (vd: "0,034" → 0.034)
    const parseNum = v => parseFloat(String(v ?? '0').replace(',', '.')) || 0;

    // Chuẩn hoá output
    if (type === 'enqueue') {
      const out = rows.map(r => {
        const rec = { date: (r.date || r.Date || '').trim() };
        for (let h = 0; h < 24; h++) rec[`h${h}`] = parseNum(r[`h${h}`] || r[`H${h}`]);
        return rec;
      }).filter(r => r.date);
      return res.json(out);
    } else {
      const out = rows.map(r => ({
        date:   (r.date || r.Date || '').trim(),
        inflow: parseNum(r.inflow || r.Inflow)
      })).filter(r => r.date && r.inflow);
      return res.json(out);
    }
  } catch (err) {
    console.error('fetch-sheet error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: AI INSIGHT — via Groq API (OpenAI-compatible, free tier) ─────────────
// Groq: https://console.groq.com — đăng ký miễn phí, lấy API key ngay
// Model mặc định: llama3-8b-8192 (nhanh, miễn phí, không giới hạn egress)
app.post('/api/ai-insight', async (req, res) => {
  const { prompt, context } = req.body;
  if (!prompt || !context) return res.status(400).json({ error: 'Missing prompt or context' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return res.json({
      text: '⚙️ AI Insight is not activated. Please add the GROQ_API_KEY environment variable on Render to enable this feature. Get a free key at console.groq.com.',
      fallback: true
    });
  }

  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  try {
    const { default: fetch } = await import('node-fetch');
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0.5,
        messages: [
          {
            role: 'system',
            content: 'You are a senior Workforce Management expert specializing in E-commerce contact centers. Be concise, data-driven, and actionable.'
          },
          {
            role: 'user',
            content: `${prompt}\n\nData:\n${context}`
          }
        ]
      })
    });

    if (!upstream.ok) {
      const errData = await upstream.json().catch(() => ({}));
      const msg = errData?.error?.message || `Groq API error ${upstream.status}`;
      console.error('Groq API error:', msg);
      return res.status(502).json({ error: msg });
    }

    const data = await upstream.json();
    const text = data.choices?.[0]?.message?.content?.trim() || 'No response from AI.';
    res.json({ text });
  } catch (err) {
    console.error('AI insight error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── API: CONFIG ───────────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  console.log('/api/me | user:', req.user?.email || 'none');
  const user = req.user || null;
  const role = user ? await getRole(user.email) : 'viewer';
  res.json({ user, role });
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

// ── API: TRIGGER AUTO SCHEDULE FOR MAKE ───────────────────────────────────────
// POST /api/trigger-schedule
app.post('/api/trigger-schedule', async (req, res) => {
  try {
    // 1. Kiểm tra API Key bảo mật từ Make gửi sang
    const makeApiKey = req.headers['x-api-key'];
    const expectedKey = process.env.MAKE_API_KEY || 'a_secret_fallback_key_123';
    
    if (!makeApiKey || makeApiKey !== expectedKey) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    // 2. Lấy tham số cấu hình (nếu Make có truyền sang, ví dụ: spreadsheetId)
    const { spreadsheetId, sheetName } = req.body;

    console.log(`[Make Trigger] Chạy thuật toán xếp lịch tự động cho Sheet: ${spreadsheetId}`);

    // 3. GỌI LOGIC/THUẬT TOÁN XẾP LỊCH CỦA BẠN Ở ĐÂY
    // (Bạn hãy thay thế hàm `runYourSchedulingAlgorithm` bằng hàm xếp lịch thực tế trong code của bạn)
    const scheduleResult = await runYourSchedulingAlgorithm(spreadsheetId, sheetName);

    // 4. Trả kết quả JSON về cho Make để Agent 2 xử lý tiếp
    res.json({
      status: 'success',
      generated_at: new Date().toISOString(),
      data: scheduleResult 
      /* Cấu trúc data trả về nên là mảng các dòng: 
         [{ "id": "NV01", "name": "Nguyen Van A", "date": "2026-07-08", "hours": 8, "off": false }, ...] 
      */
    });

  } catch (err) {
    console.error('Trigger schedule error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hàm mô phỏng thuật toán của bạn (Hãy kết nối với logic xếp lịch thực tế của bạn nhé)
async function runYourSchedulingAlgorithm(spreadsheetId, sheetName) {
  // Logic thuật toán tự động tính toán ca kíp dựa trên Inflow/Enqueue...
  // ...
  return [
    { id: "NV01", name: "Nhút Nguyễn", date: "2026-07-13", shift: "Morning", hours: 8, off: false },
    { id: "NV02", name: "Ryan Van", date: "2026-07-13", shift: "Off", hours: 0, off: true }
  ];
}

// ── STATIC ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  const inPublic = path.join(__dirname, 'public', 'index.html');
  const inRoot   = path.join(__dirname, 'index.html');
  res.sendFile(fs.existsSync(inPublic) ? inPublic : inRoot);
});

app.listen(PORT, () => console.log(`ShiftIQ on port ${PORT}`));
