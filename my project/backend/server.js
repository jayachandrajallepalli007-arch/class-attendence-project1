const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const SECRET = process.env.JWT_SECRET || 'change-this-secret';
const FACE_THRESHOLD = 0.5; // lower = stricter matching
const db = new Database(path.join(__dirname, 'attendance.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, username TEXT UNIQUE, password TEXT, role TEXT, face TEXT);
CREATE TABLE IF NOT EXISTS subjects(id INTEGER PRIMARY KEY, name TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, subject_id INT, date TEXT, UNIQUE(subject_id, date));
CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY, student_id INT, subject_id INT, date TEXT, UNIQUE(student_id, subject_id, date));
`);

// First-run admin account (change the password after logging in / via env var)
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  db.prepare('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)')
    .run('Admin', 'admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10), 'admin');
  console.log('Admin created -> username: admin');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// Auth middleware: role is re-read from the DB, so admin changes apply instantly
const auth = (...roles) => (req, res, next) => {
  try {
    const t = (req.headers.authorization || '').split(' ')[1];
    const { id } = jwt.verify(t, SECRET);
    const u = db.prepare('SELECT id,name,username,role FROM users WHERE id=?').get(id);
    if (!u) return res.status(401).json({ error: 'Not logged in' });
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'Access denied' });
    req.user = u;
    next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
};

const today = () => new Date().toISOString().slice(0, 10);
const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u || !bcrypt.compareSync(password || '', u.password)) return res.status(400).json({ error: 'Wrong username or password' });
  res.json({ token: jwt.sign({ id: u.id }, SECRET, { expiresIn: '12h' }), user: { id: u.id, name: u.name, role: u.role } });
});

app.get('/api/me', auth(), (req, res) => res.json(req.user));

// ---------- ADMIN ONLY ----------
app.get('/api/users', auth('admin'), (req, res) =>
  res.json(db.prepare('SELECT id,name,username,role,face IS NOT NULL AS hasFace FROM users').all()));

app.post('/api/users', auth('admin'), (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password || !['admin', 'teacher', 'student'].includes(role))
    return res.status(400).json({ error: 'Fill all fields' });
  try {
    db.prepare('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)').run(name, username, bcrypt.hashSync(password, 10), role);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Username already exists' }); }
});

// Admin gives or removes access by changing the role
app.put('/api/users/:id/role', auth('admin'), (req, res) => {
  if (!['admin', 'teacher', 'student'].includes(req.body.role)) return res.status(400).json({ error: 'Bad role' });
  if (+req.params.id === req.user.id) return res.status(400).json({ error: "You can't change your own role" });
  db.prepare('UPDATE users SET role=? WHERE id=?').run(req.body.role, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth('admin'), (req, res) => {
  if (+req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  db.prepare('DELETE FROM attendance WHERE student_id=?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/face', auth('admin'), (req, res) => {
  const d = req.body.descriptor;
  if (!Array.isArray(d) || d.length !== 128) return res.status(400).json({ error: 'Bad face data' });
  db.prepare('UPDATE users SET face=? WHERE id=?').run(JSON.stringify(d), req.params.id);
  res.json({ ok: true });
});

app.post('/api/subjects', auth('admin'), (req, res) => {
  try { db.prepare('INSERT INTO subjects(name) VALUES(?)').run(req.body.name); res.json({ ok: true }); }
  catch { res.status(400).json({ error: 'Subject exists or name empty' }); }
});

// ---------- ADMIN + TEACHER ----------
app.get('/api/subjects', auth('admin', 'teacher'), (req, res) => res.json(db.prepare('SELECT * FROM subjects').all()));

app.post('/api/attendance/scan', auth('admin', 'teacher'), (req, res) => {
  const { subject_id, descriptor } = req.body;
  if (!subject_id || !Array.isArray(descriptor)) return res.status(400).json({ error: 'Missing data' });
  const students = db.prepare("SELECT id,name,face FROM users WHERE role='student' AND face IS NOT NULL").all();
  let best = null, bestD = 9;
  for (const s of students) {
    const d = dist(descriptor, JSON.parse(s.face));
    if (d < bestD) { bestD = d; best = s; }
  }
  if (!best || bestD > FACE_THRESHOLD) return res.status(404).json({ error: 'Face not recognised' });
  db.prepare('INSERT OR IGNORE INTO sessions(subject_id,date) VALUES(?,?)').run(subject_id, today());
  const r = db.prepare('INSERT OR IGNORE INTO attendance(student_id,subject_id,date) VALUES(?,?,?)').run(best.id, subject_id, today());
  res.json({ name: best.name, already: r.changes === 0 });
});

// ---------- STUDENT ----------
app.get('/api/my-attendance', auth('student'), (req, res) => {
  const rows = db.prepare(`SELECT s.name subject,
    (SELECT COUNT(*) FROM sessions WHERE subject_id=s.id) total,
    (SELECT COUNT(*) FROM attendance WHERE subject_id=s.id AND student_id=?) present
    FROM subjects s`).all(req.user.id);
  res.json(rows.map(r => ({ ...r, percent: r.total ? Math.round((r.present / r.total) * 100) : 0 })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port ' + PORT));