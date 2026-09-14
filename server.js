// server.js — Sổ Lớp: máy chủ quản lý trung tâm dạy học
// Chạy: npm install && npm start
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'trungtam.db');

// ---------- Database ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'staff',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dob TEXT,
  parent_phone TEXT,
  address TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  teacher TEXT,
  schedule_days TEXT,
  schedule_start TEXT,
  schedule_end TEXT,
  fee INTEGER DEFAULT 0,
  fee_type TEXT DEFAULT 'session'
);
CREATE TABLE IF NOT EXISTS class_students (
  class_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  PRIMARY KEY (class_id, student_id)
);
CREATE TABLE IF NOT EXISTS class_schedule (
  class_id TEXT NOT NULL,
  day TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  PRIMARY KEY (class_id, day)
);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  student_id TEXT,
  class_id TEXT,
  amount INTEGER DEFAULT 0,
  date TEXT,
  note TEXT,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  class_id TEXT,
  date TEXT,
  content TEXT,
  note TEXT,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS log_attendance (
  log_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  status TEXT,
  PRIMARY KEY (log_id, student_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Migration: add new receipt fields (sessions covered, discount, unpaid balance)
try { db.exec("ALTER TABLE receipts ADD COLUMN session_dates TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE receipts ADD COLUMN total_sessions INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE receipts ADD COLUMN discount_percent INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE receipts ADD COLUMN unpaid_amount INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE receipts ADD COLUMN sent INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE receipts ADD COLUMN billing_month TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE receipts ADD COLUMN paid INTEGER DEFAULT 1"); } catch (e) {}

// Migration: add legacy schedule columns if missing (older versions of this app)
try { db.exec("ALTER TABLE classes ADD COLUMN schedule_days TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE classes ADD COLUMN schedule_start TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE classes ADD COLUMN schedule_end TEXT"); } catch (e) {}

const DAY_LABELS = { mon:'Thứ 2', tue:'Thứ 3', wed:'Thứ 4', thu:'Thứ 5', fri:'Thứ 6', sat:'Thứ 7', sun:'Chủ nhật' };
const DAY_ORDER = ['mon','tue','wed','thu','fri','sat','sun'];
const DAY_INDEX = Object.fromEntries(DAY_ORDER.map((d,i)=>[d,i]));

// Migration: move any legacy single-time schedules (schedule_days/start/end on classes)
// into the new per-day class_schedule table, so old data isn't lost.
(function migrateLegacySchedules(){
  const legacyClasses = db.prepare("SELECT id, schedule_days, schedule_start, schedule_end FROM classes WHERE schedule_days IS NOT NULL AND schedule_days <> ''").all();
  const hasRows = db.prepare('SELECT COUNT(*) c FROM class_schedule WHERE class_id=?');
  const insert = db.prepare('INSERT OR IGNORE INTO class_schedule (class_id, day, start_time, end_time) VALUES (?,?,?,?)');
  legacyClasses.forEach(c => {
    if (hasRows.get(c.id).c > 0) return; // already migrated / has new-format data
    (c.schedule_days || '').split(',').filter(Boolean).forEach(day => {
      insert.run(c.id, day, c.schedule_start || '', c.schedule_end || '');
    });
  });
})();

function scheduleLabel(rows){
  // rows: [{day, start, end}] already sorted mon->sun
  if (!rows || rows.length === 0) return '';
  const groups = [];
  rows.forEach(r => {
    const key = `${r.start}|${r.end}`;
    let g = groups.find(g => g.key === key);
    if (!g) { g = { key, days: [], start: r.start, end: r.end }; groups.push(g); }
    g.days.push(r.day);
  });
  const parts = groups.map(g => {
    const dayText = g.days.map(d => DAY_LABELS[d]).join(', ');
    const timeText = (g.start && g.end) ? ` ${g.start}–${g.end}` : '';
    return `${dayText}${timeText}`;
  });
  return `${parts.join(' · ')} (${rows.length} buổi/tuần)`;
}

// Seed default admin account on first run
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync('Admin@123', 10);
  db.prepare('INSERT INTO users (id, username, password_hash, name, role, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, 'admin', hash, 'Quản trị viên', 'admin', new Date().toISOString());
  console.log('\n==============================================');
  console.log('Đã tạo tài khoản quản trị mặc định:');
  console.log('  Tên đăng nhập: admin');
  console.log('  Mật khẩu:      Admin@123');
  console.log('=> Hãy đăng nhập và đổi mật khẩu ngay!');
  console.log('==============================================\n');
}

const uid = () => crypto.randomUUID();

// ---------- App setup ----------
const app = express();
app.use(express.json({ limit: '8mb' })); // allow larger payloads (e.g. QR code images as base64)
app.use(session({
  store: new FileStore({ path: path.join(DATA_DIR, 'sessions'), logFn: () => {} }),
  secret: process.env.SESSION_SECRET || 'so-lop-doi-chuoi-bi-mat-nay-truoc-khi-dung-that',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 14, // 14 ngày
    secure: false, // đổi thành true nếu chạy sau HTTPS reverse proxy
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Chưa đăng nhập' });
  next();
}
function requireAdmin(req, res, next) {
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Chỉ quản trị viên mới thực hiện được' });
  next();
}
function publicUser(u) { return u ? { id: u.id, username: u.username, name: u.name, role: u.role } : null; }

// ---------- Auth routes ----------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  req.session.userId = u.id;
  res.json({ user: publicUser(u) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Chưa đăng nhập' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!u) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.json({ user: publicUser(u) });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!bcrypt.compareSync(oldPassword || '', u.password_hash)) {
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu mới phải từ 6 ký tự' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), u.id);
  res.json({ ok: true });
});

// ---------- User management (admin only) ----------
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, username, name, role, created_at FROM users ORDER BY created_at').all();
  res.json(rows);
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Tên đăng nhập và mật khẩu (>=6 ký tự) là bắt buộc' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username.trim());
  if (exists) return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
  const id = uid();
  db.prepare('INSERT INTO users (id, username, password_hash, name, role, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, username.trim(), bcrypt.hashSync(password, 10), name || username.trim(), role === 'admin' ? 'admin' : 'staff', new Date().toISOString());
  res.json({ id });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Không thể tự xóa chính mình' });
  const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  const target = db.prepare('SELECT role FROM users WHERE id=?').get(req.params.id);
  if (target && target.role === 'admin' && admins <= 1) {
    return res.status(400).json({ error: 'Phải còn ít nhất 1 quản trị viên' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Apply auth to all remaining /api routes
app.use('/api/students', requireAuth);
app.use('/api/classes', requireAuth);
app.use('/api/receipts', requireAuth);
app.use('/api/logs', requireAuth);
app.use('/api/settings', requireAuth);

// ---------- Center settings (payment info, QR code) ----------
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({ paymentInfo: map.paymentInfo || '', qrImage: map.qrImage || '' });
});
app.put('/api/settings', (req, res) => {
  const { paymentInfo, qrImage } = req.body || {};
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  if (paymentInfo !== undefined) upsert.run('paymentInfo', paymentInfo);
  if (qrImage !== undefined) upsert.run('qrImage', qrImage);
  res.json({ ok: true });
});

// ---------- Students ----------
app.get('/api/students', (req, res) => {
  res.json(db.prepare('SELECT id, name, dob, parent_phone AS parentPhone, address, note FROM students ORDER BY name').all());
});
app.post('/api/students', (req, res) => {
  const { name, dob, parentPhone, address, note } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Thiếu tên học sinh' });
  const id = uid();
  db.prepare('INSERT INTO students (id,name,dob,parent_phone,address,note) VALUES (?,?,?,?,?,?)')
    .run(id, name.trim(), dob || '', parentPhone || '', address || '', note || '');
  res.json({ id });
});
app.put('/api/students/:id', (req, res) => {
  const { name, dob, parentPhone, address, note } = req.body || {};
  db.prepare('UPDATE students SET name=?, dob=?, parent_phone=?, address=?, note=? WHERE id=?')
    .run(name || '', dob || '', parentPhone || '', address || '', note || '', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/students/:id', (req, res) => {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM class_students WHERE student_id=?').run(id);
    db.prepare('DELETE FROM students WHERE id=?').run(id);
  });
  tx(req.params.id);
  res.json({ ok: true });
});

// ---------- Classes ----------
function attachStudentIds(classes) {
  const stmt = db.prepare('SELECT student_id FROM class_students WHERE class_id=?');
  return classes.map(c => ({ ...c, studentIds: stmt.all(c.id).map(r => r.student_id) }));
}
const VALID_DAYS = new Set(DAY_ORDER);
function getSchedule(classId){
  const rows = db.prepare('SELECT day, start_time AS start, end_time AS end FROM class_schedule WHERE class_id=?').all(classId);
  return rows.sort((a,b) => DAY_INDEX[a.day] - DAY_INDEX[b.day]);
}
function attachSchedule(classes) {
  return classes.map(c => {
    const schedule = getSchedule(c.id);
    return { ...c, schedule, scheduleLabel: scheduleLabel(schedule) };
  });
}
function sanitizeSchedule(arr){
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr.filter(r => r && VALID_DAYS.has(r.day) && !seen.has(r.day) && seen.add(r.day))
    .map(r => ({ day: r.day, start: r.start || '', end: r.end || '' }));
}
function saveSchedule(classId, schedule){
  db.prepare('DELETE FROM class_schedule WHERE class_id=?').run(classId);
  const insert = db.prepare('INSERT INTO class_schedule (class_id, day, start_time, end_time) VALUES (?,?,?,?)');
  sanitizeSchedule(schedule).forEach(r => insert.run(classId, r.day, r.start, r.end));
}

const MONTHLY_SESSION_DIVISOR = 8; // fixed divisor to estimate per-session fee for month-based classes
function feePerSession(fee, feeType){
  if (feeType === 'month') return Math.round((Number(fee)||0) / MONTHLY_SESSION_DIVISOR / 1000) * 1000;
  return Number(fee) || 0;
}
app.get('/api/classes', (req, res) => {
  const rows = db.prepare('SELECT id, name, teacher, fee, fee_type AS feeType FROM classes ORDER BY name').all();
  const mapped = rows.map(r => ({ ...r, feePerSession: feePerSession(r.fee, r.feeType) }));
  res.json(attachStudentIds(attachSchedule(mapped)));
});

app.post('/api/classes', (req, res) => {
  const { name, teacher, schedule, fee, feeType, studentIds } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Thiếu tên lớp' });
  const id = uid();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO classes (id,name,teacher,fee,fee_type) VALUES (?,?,?,?,?)')
      .run(id, name.trim(), teacher || '', Number(fee) || 0, feeType === 'month' ? 'month' : 'session');
    saveSchedule(id, schedule);
    (studentIds || []).forEach(sid => {
      db.prepare('INSERT OR IGNORE INTO class_students (class_id, student_id) VALUES (?,?)').run(id, sid);
    });
  });
  tx();
  res.json({ id });
});
app.put('/api/classes/:id', (req, res) => {
  const { name, teacher, schedule, fee, feeType, studentIds } = req.body || {};
  const tx = db.transaction(() => {
    db.prepare('UPDATE classes SET name=?, teacher=?, fee=?, fee_type=? WHERE id=?')
      .run(name || '', teacher || '', Number(fee) || 0, feeType === 'month' ? 'month' : 'session', req.params.id);
    saveSchedule(req.params.id, schedule);
    db.prepare('DELETE FROM class_students WHERE class_id=?').run(req.params.id);
    (studentIds || []).forEach(sid => {
      db.prepare('INSERT OR IGNORE INTO class_students (class_id, student_id) VALUES (?,?)').run(req.params.id, sid);
    });
  });
  tx();
  res.json({ ok: true });
});
app.delete('/api/classes/:id', (req, res) => {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM class_students WHERE class_id=?').run(id);
    db.prepare('DELETE FROM class_schedule WHERE class_id=?').run(id);
    db.prepare('DELETE FROM classes WHERE id=?').run(id);
  });
  tx(req.params.id);
  res.json({ ok: true });
});

// ---------- Receipts ----------
function mapReceipt(r){
  const sessionDates = r.sessionDatesJson ? JSON.parse(r.sessionDatesJson) : [];
  const attendedCount = sessionDates.length;
  // "Học phí/buổi" = tổng tiền thu chia cho SỐ BUỔI CỦA LỚP trong kỳ (không chia theo số buổi học sinh có mặt),
  // vì học sinh vẫn phải đóng đủ học phí cả những buổi vắng.
  const sessionsForFee = Number(r.totalSessions) > 0 ? Number(r.totalSessions) : attendedCount;
  const feePerSessionActual = sessionsForFee > 0 ? Math.round((Number(r.amount)||0) / sessionsForFee / 1000) * 1000 : 0;
  const { sessionDatesJson, sentInt, paidInt, ...rest } = r;
  return { ...rest, sessionDates, attendedCount, avgPerSession: feePerSessionActual, sent: !!sentInt, paid: !!paidInt };
}
app.get('/api/receipts', (req, res) => {
  const rows = db.prepare(`SELECT id, student_id AS studentId, class_id AS classId, amount, date, note,
    session_dates AS sessionDatesJson, total_sessions AS totalSessions, discount_percent AS discountPercent, unpaid_amount AS unpaidAmount,
    sent AS sentInt, billing_month AS billingMonth, paid AS paidInt
    FROM receipts ORDER BY date DESC`).all();
  res.json(rows.map(mapReceipt));
});
app.post('/api/receipts', (req, res) => {
  const { studentId, classId, amount, date, note, sessionDates, totalSessions, discountPercent, unpaidAmount, billingMonth, sent, paid } = req.body || {};
  if (!studentId || !amount) return res.status(400).json({ error: 'Thiếu học sinh hoặc số tiền' });
  const id = uid();
  const paidValue = paid !== undefined ? (paid ? 1 : 0) : ((Number(unpaidAmount) || 0) > 0 ? 0 : 1);
  db.prepare(`INSERT INTO receipts (id, student_id, class_id, amount, date, note, created_by, session_dates, total_sessions, discount_percent, unpaid_amount, billing_month, sent, paid)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, studentId, classId || null, Number(amount) || 0, date || '', note || '', req.session.userId,
      JSON.stringify(Array.isArray(sessionDates) ? sessionDates : []), Number(totalSessions) || 0, Number(discountPercent) || 0, Number(unpaidAmount) || 0,
      billingMonth || '', sent ? 1 : 0, paidValue);
  res.json({ id });
});
app.put('/api/receipts/:id', (req, res) => {
  const { studentId, classId, amount, date, note, sessionDates, totalSessions, discountPercent, unpaidAmount, billingMonth, sent, paid } = req.body || {};
  const paidValue = paid !== undefined ? (paid ? 1 : 0) : ((Number(unpaidAmount) || 0) > 0 ? 0 : 1);
  db.prepare(`UPDATE receipts SET student_id=?, class_id=?, amount=?, date=?, note=?, session_dates=?, total_sessions=?, discount_percent=?, unpaid_amount=?, billing_month=?, sent=?, paid=? WHERE id=?`)
    .run(studentId, classId || null, Number(amount) || 0, date || '', note || '',
      JSON.stringify(Array.isArray(sessionDates) ? sessionDates : []), Number(totalSessions) || 0, Number(discountPercent) || 0, Number(unpaidAmount) || 0,
      billingMonth || '', sent ? 1 : 0, paidValue, req.params.id);
  res.json({ ok: true });
});
app.patch('/api/receipts/:id/sent', (req, res) => {
  const { sent } = req.body || {};
  db.prepare('UPDATE receipts SET sent=? WHERE id=?').run(sent ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
app.patch('/api/receipts/:id/paid', (req, res) => {
  const { paid } = req.body || {};
  db.prepare('UPDATE receipts SET paid=? WHERE id=?').run(paid ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/receipts/:id', (req, res) => {
  db.prepare('DELETE FROM receipts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Teaching logs ----------
function attachAttendance(logs) {
  const stmt = db.prepare('SELECT student_id, status FROM log_attendance WHERE log_id=?');
  return logs.map(l => {
    const att = {};
    stmt.all(l.id).forEach(r => { att[r.student_id] = r.status; });
    return { ...l, attendance: att };
  });
}
app.get('/api/logs', (req, res) => {
  const rows = db.prepare('SELECT id, class_id AS classId, date, content, note FROM logs ORDER BY date DESC').all();
  res.json(attachAttendance(rows));
});
app.post('/api/logs', (req, res) => {
  const { classId, date, content, note, attendance } = req.body || {};
  if (!classId) return res.status(400).json({ error: 'Thiếu lớp học' });
  const id = uid();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO logs (id, class_id, date, content, note, created_by) VALUES (?,?,?,?,?,?)')
      .run(id, classId, date || '', content || '', note || '', req.session.userId);
    Object.entries(attendance || {}).forEach(([sid, status]) => {
      db.prepare('INSERT INTO log_attendance (log_id, student_id, status) VALUES (?,?,?)').run(id, sid, status);
    });
  });
  tx();
  res.json({ id });
});
app.put('/api/logs/:id', (req, res) => {
  const { classId, date, content, note, attendance } = req.body || {};
  const tx = db.transaction(() => {
    db.prepare('UPDATE logs SET class_id=?, date=?, content=?, note=? WHERE id=?')
      .run(classId, date || '', content || '', note || '', req.params.id);
    db.prepare('DELETE FROM log_attendance WHERE log_id=?').run(req.params.id);
    Object.entries(attendance || {}).forEach(([sid, status]) => {
      db.prepare('INSERT INTO log_attendance (log_id, student_id, status) VALUES (?,?,?)').run(req.params.id, sid, status);
    });
  });
  tx();
  res.json({ ok: true });
});
app.delete('/api/logs/:id', (req, res) => {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM log_attendance WHERE log_id=?').run(id);
    db.prepare('DELETE FROM logs WHERE id=?').run(id);
  });
  tx(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Sổ Lớp đang chạy tại http://localhost:${PORT}`);
});
