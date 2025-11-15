const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { openDb, all, get, run } = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();

// Multer setup per-room directory
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const roomId = String(req.params.id);
    const dir = path.join(__dirname, '..', '..', 'public', 'images', 'rooms', roomId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const ts = Date.now();
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${ts}${ext}`);
  },
});
const upload = multer({ storage });

router.get('/admin/rooms', requireAuth, async (req, res) => {
  const db = openDb();
  try {
    const rooms = await all(db, `SELECT * FROM rooms ORDER BY name`);
    const baseDir = path.join(__dirname, '..', '..', 'public', 'images', 'rooms');
    const items = rooms.map((r) => {
      const dir = path.join(baseDir, String(r.id));
      let images = [];
      try {
        if (fs.existsSync(dir)) {
          images = fs
            .readdirSync(dir)
            .filter((f) => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f))
            .map((f) => ({ url: path.posix.join('/images/rooms', String(r.id), f), name: f }));
        }
      } catch (e) {}
      return { ...r, images };
    });
    res.render('admin/rooms', { rooms: items });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  } finally {
    db.close();
  }
});

router.post('/admin/rooms/:id/update', requireAuth, async (req, res) => {
  const db = openDb();
  try {
    const id = req.params.id;
    const { name, capacity, facilities } = req.body;
    await run(
      db,
      `UPDATE rooms SET name = ?, capacity = ?, facilities = ? WHERE id = ?`,
      [name, capacity ? parseInt(capacity, 10) : null, facilities || null, id]
    );
    res.redirect('/admin/rooms');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  } finally {
    db.close();
  }
});

router.post('/admin/rooms/:id/upload', requireAuth, upload.array('photos', 10), async (req, res) => {
  // Files already saved by multer
  res.redirect('/admin/rooms');
});

router.post('/admin/rooms/:id/photos/delete', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const { filename } = req.body;
    const filePath = path.join(__dirname, '..', '..', 'public', 'images', 'rooms', id, filename);
    if (filePath.includes('..')) return res.status(400).send('Invalid path');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.redirect('/admin/rooms');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

module.exports = { router };
