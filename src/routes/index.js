const express = require('express');
const dayjs = require('dayjs');
const { openDb, all, get, run, checkOverlap } = require('../db');
const { requireAuth } = require('./auth');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const router = express.Router();

// Upload setup for booking documents
const docsDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'docs');
function ensureDir(p){ try { fs.mkdirSync(p, { recursive: true }); } catch(e){} }
ensureDir(docsDir);
const storageDocs = multer.diskStorage({
  destination: function(req, file, cb){ ensureDir(docsDir); cb(null, docsDir); },
  filename: function(req, file, cb){
    const ts = Date.now();
    const ext = path.extname(file.originalname) || '';
    cb(null, `${ts}${ext}`);
  }
});
const uploadDoc = multer({ storage: storageDocs });

router.get('/', (req, res) => res.redirect('/calendar'));

router.get('/calendar', async (req, res) => {
  const db = openDb();
  try {
    const rooms = await all(db, `SELECT * FROM rooms ORDER BY name`);
    const monthParam = req.query.month; // YYYY-MM
    const room_id = req.query.room_id || '';
    const reveal = req.query.reveal === '1';
    const base = monthParam ? dayjs(monthParam + '-01') : dayjs();
    const firstDay = base.startOf('month');
    const lastDay = base.endOf('month');

    // Build calendar grid
    const startGrid = firstDay.startOf('week');
    const endGrid = lastDay.endOf('week');
    const days = [];
    let d = startGrid;
    while (d.isBefore(endGrid) || d.isSame(endGrid, 'day')) {
      days.push(d);
      d = d.add(1, 'day');
    }

    // Counts per day for badge (multi-day aware)
    const counts = {};
    const monthFirst = firstDay.format('YYYY-MM-DD');
    const monthLast = lastDay.format('YYYY-MM-DD');
    const bookings = await all(
      db,
      `SELECT start_date, end_date FROM bookings
       WHERE start_date <= ? AND end_date >= ? ${room_id ? 'AND room_id = ?' : ''}`,
      room_id ? [monthLast, monthFirst, room_id] : [monthLast, monthFirst]
    );
    bookings.forEach(b => {
      let cur = dayjs(b.start_date);
      const end = dayjs(b.end_date);
      // Clamp to current month range
      if (cur.isBefore(firstDay)) cur = firstDay;
      const endClamp = end.isAfter(lastDay) ? lastDay : end;
      while (cur.isBefore(endClamp) || cur.isSame(endClamp, 'day')) {
        const key = cur.format('YYYY-MM-DD');
        counts[key] = (counts[key] || 0) + 1;
        cur = cur.add(1, 'day');
      }
    });

    res.render('calendar', {
      rooms,
      room_id,
      reveal,
      baseMonth: base.format('YYYY-MM'),
      prevMonth: base.subtract(1, 'month').format('YYYY-MM'),
      nextMonth: base.add(1, 'month').format('YYYY-MM'),
      days,
      firstDay,
      lastDay,
      counts,
      dayjs,
    });
  } catch (e) {
    console.error('POST /book error:', e);
    const msg = e && (e.message || (typeof e.toString === 'function' ? e.toString() : null)) || 'Error';
    res.status(500).send(msg);
  } finally {
    db.close();
  }
});

router.get('/day/:date', async (req, res) => {
  const db = openDb();
  try {
    const date = req.params.date; // YYYY-MM-DD
    const room_id = req.query.room_id || '';
    const reveal = req.query.reveal === '1';
    const rooms = await all(db, `SELECT * FROM rooms ORDER BY name`);
    const bookings = await all(
      db,
      `SELECT b.*, r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id
       WHERE ? BETWEEN b.start_date AND b.end_date ${room_id ? 'AND b.room_id = ?' : ''}
       ORDER BY b.start_time`,
      room_id ? [date, room_id] : [date]
    );

    res.render('day', {
      date,
      rooms,
      room_id,
      bookings,
      dayjs,
      reveal,
    });
  } catch (e) {
    console.error('POST /book error:', e);
    res.status(500).send((e && (e.stack || e.message)) ? (e.stack || e.message) : 'Error');
  } finally {
    db.close();
  }
});

router.post('/book', requireAuth, uploadDoc.single('doc'), async (req, res) => {
  const db = openDb();
  try {
    console.log('POST /book body:', req.body);
    console.log('POST /book file:', req.file ? req.file.filename : null);
    const { room_id, borrower_org, event_name, start_date, end_date, start_time, end_time, committee_name, contact, notes } = req.body;
    if (!room_id || !borrower_org || !event_name || !start_date || !end_date || !start_time || !end_time) {
      return res.status(400).send('Data wajib belum lengkap');
    }
    if (start_date > end_date) return res.status(400).send('Tanggal mulai harus <= tanggal selesai');
    if (start_time >= end_time) return res.status(400).send('Jam mulai harus < jam selesai');

    const overlap = await checkOverlap(db, { room_id, start_date, end_date, start_time, end_time });
    if (overlap) return res.status(409).send('Jadwal bertabrakan');

    let doc_path = null;
    if (req.file) {
      doc_path = path.posix.join('/uploads/docs', req.file.filename);
    }
    await run(
      db,
      `INSERT INTO bookings(room_id, borrower_org, event_name, date, start_time, end_time, committee_name, contact, notes, start_date, end_date, doc_path)
       VALUES (?,?,?,?,?,?,?,?,?, ?, ?, ?)`,
      [room_id, borrower_org, event_name, start_date, start_time, end_time, committee_name || null, contact || null, notes || null, start_date, end_date, doc_path]
    );
    res.redirect(`/day/${start_date}?room_id=${room_id}`);
  } catch (e) {
    console.error(e);
    res.status(500).send(e && e.message ? e.message : 'Error');
  } finally {
    db.close();
  }
});

router.post('/book/:id/delete', requireAuth, async (req, res) => {
  const db = openDb();
  try {
    const id = req.params.id;
    const b = await get(db, `SELECT start_date as date, room_id FROM bookings WHERE id = ?`, [id]);
    if (!b) return res.status(404).send('Data tidak ditemukan');
    await run(db, `DELETE FROM bookings WHERE id = ?`, [id]);
    res.redirect(`/day/${b.date}?room_id=${b.room_id}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  } finally {
    db.close();
  }
});

router.post('/book/:id/update', requireAuth, uploadDoc.single('doc'), async (req, res) => {
  const db = openDb();
  try {
    const id = req.params.id;
    const { room_id, borrower_org, event_name, start_date, end_date, start_time, end_time, committee_name, contact, notes } = req.body;
    if (!room_id || !borrower_org || !event_name || !start_date || !end_date || !start_time || !end_time) {
      return res.status(400).send('Data wajib belum lengkap');
    }
    if (start_date > end_date) return res.status(400).send('Tanggal mulai harus <= tanggal selesai');
    if (start_time >= end_time) return res.status(400).send('Jam mulai harus < jam selesai');

    const overlap = await checkOverlap(db, { id, room_id, start_date, end_date, start_time, end_time });
    if (overlap) return res.status(409).send('Jadwal bertabrakan');

    let setDoc = '';
    const cur = await get(db, `SELECT doc_path FROM bookings WHERE id=?`, [id]);
    if (req.file) {
      const newPath = path.posix.join('/uploads/docs', req.file.filename);
      setDoc = ', doc_path = ?';
      // delete old file if exists
      if (cur && cur.doc_path) {
        try {
          const abs = path.join(__dirname, '..', '..', 'public', cur.doc_path.replace(/^\//, ''));
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } catch(e){}
      }
    }
    await run(
      db,
      `UPDATE bookings SET room_id=?, borrower_org=?, event_name=?, date=?, start_time=?, end_time=?, committee_name=?, contact=?, notes=?, start_date=?, end_date=?${setDoc}, updated_at=datetime('now')
       WHERE id=?`,
      req.file
        ? [room_id, borrower_org, event_name, start_date, start_time, end_time, committee_name || null, contact || null, notes || null, start_date, end_date, path.posix.join('/uploads/docs', req.file.filename), id]
        : [room_id, borrower_org, event_name, start_date, start_time, end_time, committee_name || null, contact || null, notes || null, start_date, end_date, id]
    );
    res.redirect(`/day/${start_date}?room_id=${room_id}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  } finally {
    db.close();
  }
});

// Export PDF
router.get('/export/pdf', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const db = openDb();
  try {
    const scope = req.query.scope || 'month'; // 'day' or 'month'
    const date = req.query.date; // YYYY-MM or YYYY-MM-DD
    const room_id = req.query.room_id || '';

    let title = 'Agenda';
    let rows = [];
    if (scope === 'day') {
      title = `Agenda Harian ${date}`;
      rows = await all(
        db,
        `SELECT b.*, r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id
         WHERE ? BETWEEN b.start_date AND b.end_date ${room_id ? 'AND b.room_id = ?' : ''} ORDER BY b.start_time`,
        room_id ? [date, room_id] : [date]
      );
    } else {
      const base = dayjs((date || dayjs().format('YYYY-MM')) + '-01');
      const first = base.startOf('month').format('YYYY-MM-DD');
      const last = base.endOf('month').format('YYYY-MM-DD');
      title = `Agenda Bulanan ${base.format('MMMM YYYY')}`;
      rows = await all(
        db,
        `SELECT b.*, r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id
         WHERE b.start_date <= ? AND b.end_date >= ? ${room_id ? 'AND b.room_id = ?' : ''} ORDER BY b.start_date, b.start_time`,
        room_id ? [last, first, room_id] : [last, first]
      );
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="agenda.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(res);

    doc.fontSize(16).text('Sistem Informasi Agenda Peminjaman Aula', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(title, { align: 'center' });
    doc.moveDown();

    rows.forEach((r) => {
      const dateStr = r.start_date === r.end_date ? r.start_date : `${r.start_date} s/d ${r.end_date}`;
      doc.fontSize(10).text(
        `${dateStr} ${r.start_time}-${r.end_time} | ${r.room_name} | ${r.borrower_org} | ${r.event_name} | PIC: ${r.committee_name || '-'} | ${r.contact || '-'}`
      );
      if (r.notes) doc.fontSize(9).text(`Catatan: ${r.notes}`);
      doc.moveDown(0.5);
    });

    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  } finally {
    db.close();
  }
});

// Export ICS
router.get('/export/ics', async (req, res) => {
  const ics = require('ics');
  const db = openDb();
  try {
    const scope = req.query.scope || 'month';
    const date = req.query.date; // YYYY-MM or YYYY-MM-DD
    const room_id = req.query.room_id || '';

    let rows = [];
    if (scope === 'day') {
      rows = await all(
        db,
        `SELECT b.*, r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id
         WHERE ? BETWEEN b.start_date AND b.end_date ${room_id ? 'AND b.room_id = ?' : ''} ORDER BY b.start_time`,
        room_id ? [date, room_id] : [date]
      );
    } else {
      const base = dayjs((date || dayjs().format('YYYY-MM')) + '-01');
      const first = base.startOf('month').format('YYYY-MM-DD');
      const last = base.endOf('month').format('YYYY-MM-DD');
      rows = await all(
        db,
        `SELECT b.*, r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id
         WHERE b.start_date <= ? AND b.end_date >= ? ${room_id ? 'AND b.room_id = ?' : ''} ORDER BY b.start_date, b.start_time`,
        room_id ? [last, first, room_id] : [last, first]
      );
    }

    const events = rows.map((r) => {
      const [ys, ms, ds] = (r.start_date || r.date).split('-').map((n) => parseInt(n, 10));
      const [ye, me, de] = (r.end_date || r.date).split('-').map((n) => parseInt(n, 10));
      const [sh, sm] = r.start_time.split(':').map((n) => parseInt(n, 10));
      const [eh, em] = r.end_time.split(':').map((n) => parseInt(n, 10));
      return {
        title: `${r.event_name} - ${r.room_name}`,
        description: `${r.borrower_org}${r.notes ? '\nCatatan: ' + r.notes : ''}`,
        start: [ys, ms, ds, sh, sm],
        end: [ye, me, de, eh, em],
        location: r.room_name,
        organizer: { name: r.committee_name || '', email: '' },
      };
    });

    ics.createEvents(events, (error, value) => {
      if (error) {
        console.error(error);
        return res.status(500).send('Gagal membuat ICS');
      }
      res.setHeader('Content-Type', 'text/calendar');
      res.setHeader('Content-Disposition', 'attachment; filename="agenda.ics"');
      res.send(value);
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  } finally {
    db.close();
  }
});

module.exports = { router };
// Rooms info page
router.get('/rooms', async (req, res) => {
  const db = openDb();
  try {
    const rooms = await all(db, `SELECT * FROM rooms ORDER BY name`);
    const baseDir = path.join(__dirname, '..', '..', 'public', 'images', 'rooms');
    const placeholder = '/images/placeholder.svg';
    const items = rooms.map((r) => {
      const dir = path.join(baseDir, String(r.id));
      let images = [];
      try {
        if (fs.existsSync(dir)) {
          images = fs
            .readdirSync(dir)
            .filter((f) => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f))
            .slice(0, 6) // limit gallery
            .map((f) => path.posix.join('/images/rooms', String(r.id), f));
        }
      } catch (e) {}
      if (images.length === 0) images = [placeholder];
      return { ...r, images };
    });
    res.render('rooms', { rooms: items });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  } finally {
    db.close();
  }
});
