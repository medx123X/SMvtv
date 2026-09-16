require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JWT_SECRET || !DATABASE_URL) {
  console.error('❌ Missing required env vars: JWT_SECRET and/or DATABASE_URL. See .env.example');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Postgres (Neon) connection ────────────────────────────────────────
const sql = neon(DATABASE_URL);

let dbReady = global._dbReady || null;
function ensureSchema() {
  if (dbReady) return dbReady;
  dbReady = sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      watchlist TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
    .then(() => { console.log('✅ Postgres connected'); })
    .catch(err => { dbReady = null; console.error('❌ Postgres error:', err); throw err; });
  global._dbReady = dbReady;
  return dbReady;
}

// Ensure DB is ready before handling any /api route that needs it
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/anime') return next(); // file-based, no DB
  try { await ensureSchema(); next(); }
  catch (err) { res.status(503).json({ error: 'Database unavailable', detail: err.message }); }
});

// ── User helpers (replace Mongoose model) ─────────────────────────────
function toPublicUser(row) {
  return row && { id: row.id, username: row.username, email: row.email, watchlist: row.watchlist };
}

// ── Auth Middleware ──────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Root ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Anime API ────────────────────────────────────────────────────────
app.get('/api/anime', (req, res) => {
  fs.readFile(path.join(__dirname, 'database.json'), 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Error reading database' });
    try { res.json(JSON.parse(data)); }
    catch (e) { res.status(500).json({ error: 'Invalid JSON' }); }
  });
});

// ── REGISTER ─────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const lowerEmail = email.toLowerCase();
    const [existingUser] = await sql`
      SELECT * FROM users WHERE email = ${lowerEmail} OR username = ${username} LIMIT 1
    `;
    if (existingUser) {
      if (existingUser.email === lowerEmail)
        return res.status(400).json({ error: 'Email already in use' });
      if (existingUser.username === username)
        return res.status(400).json({ error: 'Username already taken' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [user] = await sql`
      INSERT INTO users (username, email, password)
      VALUES (${username}, ${lowerEmail}, ${hashedPassword})
      RETURNING id, username
    `;

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, username: user.username });
  } catch (err) {
    console.error('REGISTER ERROR:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// ── LOGIN ────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'All fields are required' });

    const [user] = await sql`SELECT * FROM users WHERE email = ${email.toLowerCase()} LIMIT 1`;
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// ── VERIFY TOKEN ─────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

// ── WATCHLIST: Get ───────────────────────────────────────────────────
app.get('/api/watchlist', authMiddleware, async (req, res) => {
  try {
    const [user] = await sql`SELECT watchlist FROM users WHERE id = ${req.user.id}`;
    res.json({ watchlist: user ? user.watchlist : [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── WATCHLIST: Add ───────────────────────────────────────────────────
app.post('/api/watchlist', authMiddleware, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const [user] = await sql`SELECT watchlist FROM users WHERE id = ${req.user.id}`;
    if (user.watchlist.includes(title))
      return res.status(400).json({ error: 'already_added' });

    const [updated] = await sql`
      UPDATE users SET watchlist = array_append(watchlist, ${title})
      WHERE id = ${req.user.id}
      RETURNING watchlist
    `;
    res.json({ watchlist: updated.watchlist });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── WATCHLIST: Remove ────────────────────────────────────────────────
app.delete('/api/watchlist', authMiddleware, async (req, res) => {
  try {
    const { title } = req.body;
    const [updated] = await sql`
      UPDATE users SET watchlist = array_remove(watchlist, ${title})
      WHERE id = ${req.user.id}
      RETURNING watchlist
    `;
    res.json({ watchlist: updated.watchlist });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
}

module.exports = app;