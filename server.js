const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Explicit root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API to get all anime
app.get('/api/anime', (req, res) => {
    fs.readFile(path.join(__dirname, 'database.json'), 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading database.json:', err);
            return res.status(500).json({ error: 'Error reading database' });
        }
        try {
            res.json(JSON.parse(data));
        } catch (parseErr) {
            console.error('Error parsing database.json:', parseErr);
            res.status(500).json({ error: 'Invalid JSON in database' });
        }
    });
});

app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});
