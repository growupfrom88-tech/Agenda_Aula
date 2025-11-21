const express = require('express');
const dayjs = require('dayjs');
const { supabase, checkOverlap } = require('../db');
const { requireAuth } = require('./auth');
const path = require('path');
const multer = require('multer');

const router = express.Router();

// Upload setup for booking documents (Supabase Storage)
const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

async function uploadBookingDocToStorage(file, start_date) {
  if (!file) return null;
  const date = dayjs(start_date || undefined);
  const folder = date.isValid() ? date.format('YYYY/MM/DD') : 'misc';
  const original = (file.originalname || 'doc').toLowerCase();
  const safeName = original.replace(/[^a-z0-9.]+/g, '-');
  const ext = path.extname(safeName) || '';
  const base = (ext ? safeName.slice(0, -ext.length) : safeName) || 'doc';
  const ts = Date.now();
  const objectPath = `${folder}/${ts}-${base}${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from('booking-docs')
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: true,
    });
  if (uploadErr) throw uploadErr;

  const { data: pub } = supabase.storage.from('booking-docs').getPublicUrl(objectPath);
  return pub && pub.publicUrl ? pub.publicUrl : null;
}

router.get('/', (req, res) => res.redirect('/calendar'));

router.get('/calendar', async (req, res) => {
  try {
    const { data: rooms, error: roomsErr } = await supabase
      .from('rooms')
      .select('*')
      .order('name');
    if (roomsErr) throw roomsErr;
    const monthParam = req.query.month; // YYYY-MM
    const room_id = req.query.room_id || '';
    const reveal = req.query.reveal === '1';
    const base = monthParam ? dayjs(monthParam + '-01') : dayjs();
    const firstDay = base.startOf('month');
    const lastDay = base.endOf('month');

    // Build calendar days only for current month (1..akhir bulan)
    const days = [];
    let d = firstDay;
    while (d.isBefore(lastDay) || d.isSame(lastDay, 'day')) {
      days.push(d);
      d = d.add(1, 'day');
    }
    const firstWeekday = firstDay.day(); // 0=Min .. 6=Sab
    const lastWeekday = lastDay.day();
    const tailCount = (6 - lastWeekday + 7) % 7; // berapa sel yang dibutuhkan di minggu terakhir
    const nextDays = [];
    let nd = lastDay.add(1, 'day');
    for (let i = 0; i < tailCount; i++) {
      nextDays.push(nd);
      nd = nd.add(1, 'day');
    }

    // Counts per day for badge (multi-day aware)
    const counts = {};
    const monthFirst = firstDay.format('YYYY-MM-DD');
    const monthLast = lastDay.format('YYYY-MM-DD');
    let bookingsQuery = supabase
      .from('bookings')
      .select('start_date,end_date')
      .lte('start_date', monthLast)
      .gte('end_date', monthFirst);
    if (room_id) bookingsQuery = bookingsQuery.eq('room_id', room_id);
    const { data: bookings, error: bookingsErr } = await bookingsQuery;
    if (bookingsErr) throw bookingsErr;
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
      nextDays,
      firstDay,
      lastDay,
      firstWeekday,
      counts,
      dayjs,
    });
  } catch (e) {
    console.error('GET /calendar error:', e);
    const msg =
      (e && (e.message || (typeof e.toString === 'function' ? e.toString() : null))) || 'Error';
    res.status(500).send(msg);
  }
});

router.get('/day/:date', async (req, res) => {
  try {
    const date = req.params.date; // YYYY-MM-DD
    const room_id = req.query.room_id || '';
    const reveal = req.query.reveal === '1';
    const { data: rooms, error: roomsErr } = await supabase
      .from('rooms')
      .select('*')
      .order('name');
    if (roomsErr) throw roomsErr;

    let bookingsQuery = supabase
      .from('bookings')
      .select('*, rooms(name)', { foreignTable: 'rooms' })
      .lte('start_date', date)
      .gte('end_date', date)
      .order('start_time');
    if (room_id) bookingsQuery = bookingsQuery.eq('room_id', room_id);
    const { data: bookingRows, error: bookingsErr } = await bookingsQuery;
    if (bookingsErr) throw bookingsErr;

    const bookings = (bookingRows || []).map((b) => ({
      ...b,
      room_name: b.rooms?.name || '',
    }));

    res.render('day', {
      date,
      rooms,
      room_id,
      bookings,
      dayjs,
      reveal,
    });
  } catch (e) {
    console.error('GET /day error:', e);
    res.status(500).send((e && (e.stack || e.message)) ? e.stack || e.message : 'Error');
  }
});

router.post('/book', requireAuth, uploadDoc.single('doc'), async (req, res) => {
  try {
    console.log('POST /book body:', req.body);
    console.log('POST /book file:', req.file ? req.file.originalname : null);
    const { room_id, borrower_org, event_name, start_date, end_date, start_time, end_time, committee_name, contact, notes } = req.body;
    if (!room_id || !borrower_org || !event_name || !start_date || !end_date || !start_time || !end_time) {
      return res.status(400).send('Data wajib belum lengkap');
    }
    if (start_date > end_date) return res.status(400).send('Tanggal mulai harus <= tanggal selesai');
    if (start_time >= end_time) return res.status(400).send('Jam mulai harus < jam selesai');

    const overlap = await checkOverlap(null, {
      room_id,
      start_date,
      end_date,
      start_time,
      end_time,
    });
    if (overlap) return res.status(409).send('Jadwal bertabrakan');

    let doc_path = null;
    if (req.file) {
      doc_path = await uploadBookingDocToStorage(req.file, start_date);
    }

    const { error: insertErr } = await supabase.from('bookings').insert({
      room_id,
      borrower_org,
      event_name,
      date: start_date,
      start_time,
      end_time,
      committee_name: committee_name || null,
      contact: contact || null,
      notes: notes || null,
      start_date,
      end_date,
      doc_path,
    });
    if (insertErr) throw insertErr;
    // Setelah simpan, kembali ke tampilan harian dengan filter default (semua ruangan)
    res.redirect(`/day/${start_date}`);
  } catch (e) {
    console.error('POST /book error:', e);
    res.status(500).send(e && e.message ? e.message : 'Error');
  }
});

router.post('/book/:id/delete', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const { data, error } = await supabase
      .from('bookings')
      .select('start_date, room_id')
      .eq('id', id)
      .limit(1);
    if (error) throw error;
    const b = data && data[0];
    if (!b) return res.status(404).send('Data tidak ditemukan');
    const { error: delErr } = await supabase.from('bookings').delete().eq('id', id);
    if (delErr) throw delErr;
    // Setelah hapus, kembali ke tampilan harian dengan filter default (semua ruangan)
    res.redirect(`/day/${b.start_date}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

router.post('/book/:id/update', requireAuth, uploadDoc.single('doc'), async (req, res) => {
  try {
    const id = req.params.id;
    const { room_id, borrower_org, event_name, start_date, end_date, start_time, end_time, committee_name, contact, notes } = req.body;
    if (!room_id || !borrower_org || !event_name || !start_date || !end_date || !start_time || !end_time) {
      return res.status(400).send('Data wajib belum lengkap');
    }
    if (start_date > end_date) return res.status(400).send('Tanggal mulai harus <= tanggal selesai');
    if (start_time >= end_time) return res.status(400).send('Jam mulai harus < jam selesai');

    const overlap = await checkOverlap(null, {
      id,
      room_id,
      start_date,
      end_date,
      start_time,
      end_time,
    });
    if (overlap) return res.status(409).send('Jadwal bertabrakan');
    const payload = {
      room_id,
      borrower_org,
      event_name,
      date: start_date,
      start_time,
      end_time,
      committee_name: committee_name || null,
      contact: contact || null,
      notes: notes || null,
      start_date,
      end_date,
      updated_at: new Date().toISOString(),
    };

    if (req.file) {
      payload.doc_path = await uploadBookingDocToStorage(req.file, start_date);
    }

    const { error: updErr } = await supabase
      .from('bookings')
      .update(payload)
      .eq('id', id);
    if (updErr) throw updErr;
    // Setelah update, kembali ke tampilan harian dengan filter default (semua ruangan)
    res.redirect(`/day/${start_date}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// Export PDF
router.get('/export/pdf', async (req, res) => {
  const PDFDocument = require('pdfkit');
  try {
    const scope = req.query.scope || 'month'; // 'day' or 'month'
    const date = req.query.date; // YYYY-MM or YYYY-MM-DD
    const room_id = req.query.room_id || '';

    let title = 'Agenda';
    let rows = [];
    if (scope === 'day') {
      title = `Agenda Harian ${date}`;
      let q = supabase
        .from('bookings')
        .select('*, rooms(name)', { foreignTable: 'rooms' })
        .lte('start_date', date)
        .gte('end_date', date)
        .order('start_time');
      if (room_id) q = q.eq('room_id', room_id);
      const { data, error } = await q;
      if (error) throw error;
      rows = (data || []).map((b) => ({ ...b, room_name: b.rooms?.name || '' }));
    } else {
      const base = dayjs((date || dayjs().format('YYYY-MM')) + '-01');
      const first = base.startOf('month').format('YYYY-MM-DD');
      const last = base.endOf('month').format('YYYY-MM-DD');
      title = `Agenda Bulanan ${base.format('MMMM YYYY')}`;
      let q = supabase
        .from('bookings')
        .select('*, rooms(name)', { foreignTable: 'rooms' })
        .lte('start_date', last)
        .gte('end_date', first)
        .order('start_date')
        .order('start_time');
      if (room_id) q = q.eq('room_id', room_id);
      const { data, error } = await q;
      if (error) throw error;
      rows = (data || []).map((b) => ({ ...b, room_name: b.rooms?.name || '' }));
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
      const dateStr =
        r.start_date === r.end_date ? r.start_date : `${r.start_date} s/d ${r.end_date}`;
      doc
        .fontSize(10)
        .text(
          `${dateStr} ${r.start_time}-${r.end_time} | ${r.room_name} | ${r.borrower_org} | ${r.event_name} | PIC: ${
            r.committee_name || '-'
          } | ${r.contact || '-'}`
        );
      if (r.notes) doc.fontSize(9).text(`Catatan: ${r.notes}`);
      doc.moveDown(0.5);
    });

    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// Rooms info page
router.get('/rooms', async (req, res) => {
  try {
    const { data: rooms, error: roomsErr } = await supabase
      .from('rooms')
      .select('*')
      .order('name');
    if (roomsErr) throw roomsErr;
    const placeholder = '/images/placeholder.svg';

    const items = await Promise.all(
      rooms.map(async (r) => {
        let images = [];
        try {
          const { data: photos, error } = await supabase
            .from('room_photos')
            .select('path')
            .eq('room_id', r.id)
            .order('created_at', { ascending: true });

          if (!error && photos && photos.length) {
            images = photos
              .slice(0, 6)
              .map((p) => supabase.storage.from('room-images').getPublicUrl(p.path).data.publicUrl);
          }
        } catch (e) {
          console.error('Load public room photos error', e);
        }

        if (images.length === 0) images = [placeholder];
        return { ...r, images };
      })
    );

    res.render('rooms', { rooms: items });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

module.exports = { router };
