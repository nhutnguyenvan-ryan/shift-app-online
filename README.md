# ShiftIQ – Workforce Scheduling Tool

Web app với Google OAuth, phân quyền Owner / Editor / Viewer.

---

## 🚀 Hướng dẫn deploy (15 phút)

### Bước 1 — Cài Node.js
Tải tại https://nodejs.org (v18+ recommended)

### Bước 2 — Cài dependencies
```bash
cd shift-app
npm install
```

### Bước 3 — Tạo Google OAuth credentials
1. Vào https://console.cloud.google.com
2. Tạo project mới (hoặc chọn project có sẵn)
3. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Authorized redirect URIs: thêm `http://localhost:3000/auth/google/callback`
6. Copy **Client ID** và **Client Secret**

### Bước 4 — Tạo file .env
```bash
cp .env.example .env
```
Mở `.env` và điền vào:
```
GOOGLE_CLIENT_ID=<paste Client ID>
GOOGLE_CLIENT_SECRET=<paste Client Secret>
BASE_URL=http://localhost:3000
SESSION_SECRET=<chuỗi random dài bất kỳ, vd: abc123xyz789qwerty>
OWNER_EMAIL=<your.email@gmail.com>
```

### Bước 5 — Chạy local
```bash
npm start
```
Mở browser: http://localhost:3000

---

## 🌐 Deploy lên production (Render.com — miễn phí)

1. Push code lên GitHub
2. Vào https://render.com → New → Web Service → chọn repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Thêm Environment Variables (giống .env nhưng `BASE_URL=https://your-app.onrender.com`)
6. Trong Google Cloud Console, thêm redirect URI: `https://your-app.onrender.com/auth/google/callback`

---

## 👥 Phân quyền

| Role   | Xem | Chạy optimizer | Upload data | Lưu config | Quản lý access |
|--------|-----|----------------|-------------|------------|----------------|
| Owner  | ✅  | ✅             | ✅          | ✅         | ✅             |
| Editor | ✅  | ✅             | ✅          | ✅         | ❌             |
| Viewer | ✅  | ❌             | ❌          | ❌         | ❌             |

**Thêm Editor:** Đăng nhập bằng owner account → click **⚙ Manage Access** → nhập email.

---

## 📁 Cấu trúc project
```
shift-app/
├── server.js          # Express server + OAuth + API
├── package.json
├── .env.example       # Template biến môi trường
├── data/              # Tự tạo khi chạy
│   ├── store.json     # Shared config (inflow, params)
│   └── users.json     # Danh sách editors
└── public/
    ├── index.html     # Main app
    ├── style.css      # Dark theme
    └── app.js         # Optimizer + UI logic
```

---

## 📊 Format file upload

**Daily Inflow (CSV):**
```csv
date,inflow
01.06.2026,77444
02.06.2026,83593
```

**%Enqueue (CSV) — optional:**
```csv
date,h0,h1,h2,...,h23
01.06.2026,0.034,0.029,...,0.039
```
Nếu không upload, tool tự dùng profile mặc định theo event type.
