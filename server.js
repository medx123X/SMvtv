const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'smvtv_super_secret_key_2026';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://smvtvuser:Smvtv2026@ac-ts6bogs-shard-00-00.1hifndc.mongodb.net:27017,ac-ts6bogs-shard-00-01.1hifndc.mongodb.net:27017,ac-ts6bogs-shard-00-02.1hifndc.mongodb.net:27017/?ssl=true&replicaSet=atlas-kpxoq7-shard-0&authSource=admin&appName=SMVtv';
// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API — get all anime
app.get('/api/anime', (req, res) => {
  fs.readFile(path.join(__dirname, 'database.json'), 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Error reading database' });
    try { res.json(JSON.parse(data)); }
    catch (e) { res.status(500).json({ error: 'Invalid JSON' }); }
  });
});

// REGISTER
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password)
      return res.status(400).json({ error: 'All fields are required' });

    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Check if user exists
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      if (existingUser.email === email.toLowerCase())
        return res.status(400).json({ error: 'Email already in use' });
      if (existingUser.username === username)
        return res.status(400).json({ error: 'Username already taken' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({ username, email, password: hashedPassword });
    await user.save();

    // Generate token
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ token, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: 'All fields are required' });

    // Find user
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user)
      return res.status(400).json({ error: 'Invalid email or password' });

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ error: 'Invalid email or password' });

    // Generate token
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// VERIFY TOKEN (check if logged in)
app.get('/api/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ username: decoded.username });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));