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
    
    // For public users, only count approved bookings
    if (!req.session.user) {
      bookingsQuery = bookingsQuery.eq('status', 'approved');
    }
    
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

// Fallback for POST /day/:date (e.g. after form submits with 302 semantics on some clients)
router.post('/day/:date', (req, res) => {
  const date = req.params.date;
  res.redirect(303, `/day/${date}`);
});

// Fallback: if any POST is sent to /calendar (e.g. from some clients),
// redirect to the main GET /calendar so it does not error.
router.post('/calendar', (req, res) => {
  res.redirect('/calendar');
});

// API endpoint to get booking details for reservation proof
router.get('/api/booking/:id', async (req, res) => {
  try {
    const id = req.params.id;
    
    // First get the booking
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', id)
      .single();
    
    if (bookingError) {
      console.error('Supabase booking error:', bookingError);
      return res.status(500).json({ error: 'Database error: ' + bookingError.message });
    }
    
    if (!booking) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    
    // Then get the room details separately
    let roomData = null;
    if (booking.room_id) {
      const { data: room, error: roomError } = await supabase
        .from('rooms')
        .select('*')
        .eq('id', booking.room_id)
        .single();
      
      if (!roomError && room) {
        roomData = room;
      }
    }
    
    res.json({ 
      booking: { 
        ...booking, 
        room_name: roomData?.name || '',
        room_capacity: roomData?.capacity,
        room_facilities: roomData?.facilities
      } 
    });
  } catch (e) {
    console.error('GET /api/booking/:id error:', e);
    res.status(500).json({ error: 'Internal server error: ' + e.message });
  }
});

// API endpoint to get available rooms for a specific date/time
router.get('/api/available-rooms', async (req, res) => {
  try {
    const { start_date, end_date, start_time, end_time, exclude_booking_id } = req.query;
    
    if (!start_date || !end_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Get all rooms
    const { data: rooms, error: roomsErr } = await supabase
      .from('rooms')
      .select('*')
      .order('name');
    if (roomsErr) throw roomsErr;

    // Get bookings that overlap with the requested time
    let bookingsQuery = supabase
      .from('bookings')
      .select('room_id, id')
      .lte('start_date', end_date)
      .gte('end_date', start_date)
      .lt('start_time', end_time)
      .gt('end_time', start_time)
      .in('status', ['pending', 'approved']); // Only consider pending and approved bookings

    // Exclude current booking when editing
    if (exclude_booking_id) {
      bookingsQuery = bookingsQuery.neq('id', exclude_booking_id);
    }

    const { data: bookings, error: bookingsErr } = await bookingsQuery;

    if (bookingsErr) throw bookingsErr;

    // Get booked room IDs
    const bookedRoomIds = new Set((bookings || []).map(b => b.room_id));

    // Filter available rooms
    const availableRooms = rooms.filter(room => !bookedRoomIds.has(room.id));

    res.json({ rooms: availableRooms });
  } catch (e) {
    console.error('GET /api/available-rooms error:', e);
    res.status(500).json({ error: 'Internal server error' });
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
    
    // For public users, only show approved bookings
    if (!req.session.user) {
      bookingsQuery = bookingsQuery.eq('status', 'approved');
    }
    
    const { data: bookingRows, error: bookingsErr } = await bookingsQuery;
    if (bookingsErr) throw bookingsErr;

    const bookings = (bookingRows || []).map((b) => ({
      ...b,
      room_name: b.rooms?.name || '',
    }));

    const baseDay = dayjs(date);
    const prevDate = baseDay.subtract(1, 'day').format('YYYY-MM-DD');
    const nextDate = baseDay.add(1, 'day').format('YYYY-MM-DD');

    res.render('day', {
      date,
      rooms,
      room_id,
      bookings,
      dayjs,
      reveal,
      prevDate,
      nextDate,
    });
  } catch (e) {
    console.error('GET /day error:', e);
    res.status(500).send((e && (e.stack || e.message)) ? e.stack || e.message : 'Error');
  }
});

router.post('/book', uploadDoc.single('doc'), async (req, res) => {
  try {
    console.log('POST /book body:', req.body);
    console.log('POST /book file:', req.file ? req.file.originalname : null);
    const { room_id, borrower_org, event_name, start_date, end_date, start_time, end_time, committee_name, contact, notes, participant_count } = req.body;
    if (!room_id || !borrower_org || !event_name || !start_date || !end_date || !start_time || !end_time) {
      return res.status(400).send('Data wajib belum lengkap');
    }
    if (start_date > end_date) return res.status(400).send('Tanggal mulai harus <= tanggal selesai');
    if (start_time >= end_time) return res.status(400).send('Jam mulai harus < jam selesai');

    // Still check overlap as a safety measure, but rooms should be filtered on frontend
    const overlap = await checkOverlap(null, {
      room_id,
      start_date,
      end_date,
      start_time,
      end_time,
    });
    if (overlap) return res.status(409).send('Ruangan sudah dipesan pada waktu tersebut. Silakan pilih ruangan atau waktu lain.');

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
      participant_count: participant_count ? parseInt(participant_count, 10) : null,
      status: 'pending', // Default status for new bookings
    });
    if (insertErr) throw insertErr;
    // Setelah simpan, kembali ke tampilan harian dengan filter default (semua ruangan)
    res.redirect(303, `/day/${start_date}`);
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
    res.redirect(303, `/day/${b.start_date}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// Admin approval endpoint
router.post('/book/:id/approve', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const { error: updErr } = await supabase
      .from('bookings')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', id);
    if (updErr) throw updErr;
    
    // Get booking details for redirect
    const { data: booking } = await supabase
      .from('bookings')
      .select('start_date')
      .eq('id', id)
      .single();
    
    res.redirect(303, `/day/${booking?.start_date || dayjs().format('YYYY-MM-DD')}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// Admin rejection endpoint
router.post('/book/:id/reject', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const { error: updErr } = await supabase
      .from('bookings')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', id);
    if (updErr) throw updErr;
    
    // Get booking details for redirect
    const { data: booking } = await supabase
      .from('bookings')
      .select('start_date')
      .eq('id', id)
      .single();
    
    res.redirect(303, `/day/${booking?.start_date || dayjs().format('YYYY-MM-DD')}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

router.post('/book/:id/update', requireAuth, uploadDoc.single('doc'), async (req, res) => {
  try {
    const id = req.params.id;
    const { room_id, borrower_org, event_name, start_date, end_date, start_time, end_time, committee_name, contact, notes, participant_count, status } = req.body;
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
      participant_count: participant_count ? parseInt(participant_count, 10) : null,
    };

    // Only admin can change status
    if (status && req.session.user) {
      payload.status = status;
    }

    if (req.file) {
      payload.doc_path = await uploadBookingDocToStorage(req.file, start_date);
    }

    const { error: updErr } = await supabase
      .from('bookings')
      .update(payload)
      .eq('id', id);
    if (updErr) throw updErr;
    // Setelah update, kembali ke tampilan harian dengan filter default (semua ruangan)
    res.redirect(303, `/day/${start_date}`);
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

// Print reservation proof for single booking
router.get('/print/reservation-single/:id', requireAuth, async (req, res) => {
  const PDFDocument = require('pdfkit');
  try {
    const id = req.params.id;
    
    // Get booking first
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', id)
      .single();
    
    if (bookingError) throw bookingError;
    if (!booking) return res.status(404).send('Booking tidak ditemukan');

    // Get room details separately
    let roomData = null;
    if (booking.room_id) {
      const { data: room, error: roomError } = await supabase
        .from('rooms')
        .select('*')
        .eq('id', booking.room_id)
        .single();
      
      if (!roomError && room) {
        roomData = room;
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bukti-reservasi-${booking.id}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    // Header
    doc.fontSize(18).text('BUKTI RESERVASI', { align: 'center' });
    doc.fontSize(10).text('Sistem Informasi Agenda Aula Pusbangkom BPW', { align: 'center' });
    doc.moveDown();

    // Line separator
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown();

    // Informasi Pemohon
    doc.fontSize(12).text('INFORMASI PEMOHON', { underline: true });
    doc.fontSize(10);
    doc.text(`Instansi: ${booking.borrower_org}`);
    doc.text(`Nama Kegiatan: ${booking.event_name}`);
    doc.text(`PIC: ${booking.committee_name || '-'}`);
    doc.text(`Kontak: ${booking.contact || '-'}`);
    doc.moveDown();

    // Status Permohonan
    doc.fontSize(12).text('STATUS PERMOHONAN', { underline: true });
    doc.fontSize(10);
    
    const statusText = booking.status === 'approved' ? 'DISETUJUI / APPROVED' : 
                      booking.status === 'rejected' ? 'DITOLAK / REJECTED' : 'MENUNGGU / PENDING';
    
    // Status badge
    if (booking.status === 'approved') {
      doc.fillColor('#16a34a').text(statusText);
    } else if (booking.status === 'rejected') {
      doc.fillColor('#dc2626').text(statusText);
    } else {
      doc.fillColor('#ca8a04').text(statusText);
    }
    doc.fillColor('black'); // Reset color
    
    doc.text(`Tanggal Pengajuan: ${dayjs(booking.created_at || booking.date).format('DD MMMM YYYY HH:mm')}`);
    doc.moveDown();

    // Detail Peminjaman
    doc.fontSize(12).text('DETAIL PEMINJAMAN', { underline: true });
    doc.fontSize(10);
    doc.text(`Ruangan: ${roomData?.name || '-'}`);
    doc.text(`Kapasitas: ${roomData?.capacity || '-'}`);
    doc.text(`Fasilitas: ${roomData?.facilities || '-'}`);
    
    const dateStr = booking.start_date === booking.end_date 
      ? dayjs(booking.start_date).format('DD MMMM YYYY')
      : `${dayjs(booking.start_date).format('DD MMMM YYYY')} - ${dayjs(booking.end_date).format('DD MMMM YYYY')}`;
    doc.text(`Tanggal: ${dateStr}`);
    doc.text(`Waktu: ${dayjs('1970-01-01T' + booking.start_time).format('HH:mm')} - ${dayjs('1970-01-01T' + booking.end_time).format('HH:mm')}`);
    doc.text(`Jumlah Peserta: ${booking.participant_count || '-'}`);
    doc.text(`Keterangan: ${booking.notes || '-'}`);
    doc.moveDown();

    // Footer
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown();
    doc.fontSize(8).text('Dokumen ini diterbitkan secara elektronik oleh Sistem Informasi Agenda Aula Pusbangkom BPW', { align: 'center' });
    doc.text('Status: Sah & Valid', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(8).text(`Dicetak pada: ${dayjs().format('DD MMMM YYYY HH:mm')}`, { align: 'center' });

    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// Print reservation proof per room per day
router.get('/print/reservation', requireAuth, async (req, res) => {
  const PDFDocument = require('pdfkit');
  try {
    const date = req.query.date; // YYYY-MM-DD
    const room_id = req.query.room_id || '';

    if (!date) {
      return res.status(400).send('Tanggal harus diisi');
    }

    let q = supabase
      .from('bookings')
      .select('*, rooms(name, capacity, facilities)', { foreignTable: 'rooms' })
      .lte('start_date', date)
      .gte('end_date', date)
      .eq('status', 'approved')
      .order('start_time');

    if (room_id) {
      q = q.eq('room_id', room_id);
    }

    const { data: bookings, error } = await q;
    if (error) throw error;

    // Group by room
    const roomsMap = {};
    bookings.forEach(b => {
      const roomName = b.rooms?.name || 'Unknown';
      if (!roomsMap[roomName]) {
        roomsMap[roomName] = {
          name: roomName,
          capacity: b.rooms?.capacity || '-',
          facilities: b.rooms?.facilities || '-',
          bookings: []
        };
      }
      roomsMap[roomName].bookings.push(b);
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bukti-reservasi-${date}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(res);

    // Header
    doc.fontSize(16).text('BUKTI RESERVASI RUANGAN', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Tanggal: ${dayjs(date).format('DD MMMM YYYY')}`, { align: 'center' });
    doc.moveDown();

    // Content for each room
    Object.values(roomsMap).forEach(room => {
      doc.fontSize(14).text(`Ruangan: ${room.name}`, { underline: true });
      doc.fontSize(10).text(`Kapasitas: ${room.capacity}`);
      doc.fontSize(10).text(`Fasilitas: ${room.facilities}`);
      doc.moveDown();

      room.bookings.forEach(booking => {
        doc.fontSize(11).text(`• ${booking.start_time} - ${booking.end_time}`, { continued: true });
        doc.text(` | ${booking.event_name}`, { continued: true });
        doc.text(` | ${booking.borrower_org}`, { continued: true });
        doc.text(` | Peserta: ${booking.participant_count || '-'}`);
        if (booking.committee_name) {
          doc.fontSize(9).text(`  PIC: ${booking.committee_name}`, { indent: 20 });
        }
        if (booking.contact) {
          doc.fontSize(9).text(`  Kontak: ${booking.contact}`, { indent: 20 });
        }
        doc.moveDown(0.3);
      });

      doc.moveDown();
      doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown();
    });

    // Footer
    doc.fontSize(10).text(`Dicetak pada: ${dayjs().format('DD MMMM YYYY HH:mm')}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(8).text('Sistem Informasi Agenda Aula Pusbangkom BPW', { align: 'center' });

    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// Monthly booking report
router.get('/reports/monthly', requireAuth, async (req, res) => {
  try {
    const monthParam = req.query.month || dayjs().format('YYYY-MM');
    const base = dayjs(monthParam + '-01');
    const firstDay = base.startOf('month').format('YYYY-MM-DD');
    const lastDay = base.endOf('month').format('YYYY-MM-DD');

    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*, rooms(name)')
      .lte('start_date', lastDay)
      .gte('end_date', firstDay)
      .order('start_date')
      .order('start_time');

    if (error) throw error;

    // Group by status
    const stats = {
      total: bookings.length,
      pending: 0,
      approved: 0,
      rejected: 0
    };

    bookings.forEach(b => {
      if (b.status === 'pending') stats.pending++;
      else if (b.status === 'approved') stats.approved++;
      else if (b.status === 'rejected') stats.rejected++;
    });

    // Group by room
    const roomStats = {};
    bookings.forEach(b => {
      const roomName = b.rooms?.name || 'Unknown';
      if (!roomStats[roomName]) {
        roomStats[roomName] = { count: 0, totalParticipants: 0 };
      }
      roomStats[roomName].count++;
      roomStats[roomName].totalParticipants += b.participant_count || 0;
    });

    res.render('reports/monthly', {
      month: monthParam,
      prevMonth: base.subtract(1, 'month').format('YYYY-MM'),
      nextMonth: base.add(1, 'month').format('YYYY-MM'),
      bookings: bookings.map(b => ({ ...b, room_name: b.rooms?.name || '' })),
      stats,
      roomStats,
      dayjs
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// Export monthly report as PDF
router.get('/reports/monthly/pdf', requireAuth, async (req, res) => {
  const PDFDocument = require('pdfkit');
  try {
    const monthParam = req.query.month || dayjs().format('YYYY-MM');
    const base = dayjs(monthParam + '-01');
    const firstDay = base.startOf('month').format('YYYY-MM-DD');
    const lastDay = base.endOf('month').format('YYYY-MM-DD');

    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*, rooms(name)')
      .lte('start_date', lastDay)
      .gte('end_date', firstDay)
      .order('start_date')
      .order('start_time');

    if (error) throw error;

    // Calculate statistics
    const stats = {
      total: bookings.length,
      pending: 0,
      approved: 0,
      rejected: 0
    };

    bookings.forEach(b => {
      if (b.status === 'pending') stats.pending++;
      else if (b.status === 'approved') stats.approved++;
      else if (b.status === 'rejected') stats.rejected++;
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="laporan-bulanan-${monthParam}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(res);

    // Header
    doc.fontSize(16).text('LAPORAN BULANAN PEMINJAMAN RUANGAN', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Periode: ${base.format('MMMM YYYY')}`, { align: 'center' });
    doc.moveDown();

    // Statistics
    doc.fontSize(12).text('Ringkasan Statistik:', { underline: true });
    doc.fontSize(10);
    doc.text(`Total Peminjaman: ${stats.total}`);
    doc.text(`Disetujui: ${stats.approved}`);
    doc.text(`Menunggu: ${stats.pending}`);
    doc.text(`Ditolak: ${stats.rejected}`);
    doc.moveDown();

    // Bookings table
    doc.fontSize(12).text('Daftar Peminjaman:', { underline: true });
    doc.moveDown(0.5);

    const tableTop = doc.y;
    const itemHeight = 30;
    const headers = ['Tanggal', 'Ruangan', 'Kegiatan', 'Instansi', 'Status', 'Peserta'];
    const colWidths = [90, 80, 140, 120, 60, 50];

    // Draw header row
    doc.fontSize(9).font('Helvetica-Bold');
    headers.forEach((header, i) => {
      doc.text(header, 40 + colWidths.slice(0, i).reduce((a, b) => a + b, 0), tableTop, {
        width: colWidths[i],
        align: 'left'
      });
    });

    // Draw separator line
    doc.moveTo(40, tableTop + 12).lineTo(40 + colWidths.reduce((a, b) => a + b, 0), tableTop + 12).stroke();

    // Draw rows
    doc.font('Helvetica').fontSize(8);
    bookings.forEach((booking, i) => {
      const y = tableTop + itemHeight + (i * itemHeight);
      
      // Check if we need a new page
      if (y > 750) {
        doc.addPage();
        doc.fontSize(9).font('Helvetica-Bold');
        headers.forEach((header, i) => {
          doc.text(header, 40 + colWidths.slice(0, i).reduce((a, b) => a + b, 0), 40, {
            width: colWidths[i],
            align: 'left'
          });
        });
        doc.moveTo(40, 52).lineTo(40 + colWidths.reduce((a, b) => a + b, 0), 52).stroke();
        doc.font('Helvetica').fontSize(8);
      }

      const dateStr = booking.start_date === booking.end_date 
        ? dayjs(booking.start_date).format('DD MMM YYYY')
        : `${dayjs(booking.start_date).format('DD MMM')} - ${dayjs(booking.end_date).format('DD MMM YYYY')}`;
      
      const statusText = booking.status === 'approved' ? 'Disetujui' 
                        : booking.status === 'rejected' ? 'Ditolak' 
                        : 'Menunggu';

      const row = [
        dateStr,
        booking.rooms?.name || '-',
        booking.event_name || '-',
        booking.borrower_org || '-',
        statusText,
        booking.participant_count?.toString() || '-'
      ];

      const currentY = y > 750 ? 70 : y;

      row.forEach((text, i) => {
        doc.text(text, 40 + colWidths.slice(0, i).reduce((a, b) => a + b, 0), currentY, {
          width: colWidths[i],
          align: 'left'
        });
      });
    });

    // Footer
    doc.fontSize(10).text(`Dicetak pada: ${dayjs().format('DD MMMM YYYY HH:mm')}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(8).text('Sistem Informasi Agenda Aula Pusbangkom BPW', { align: 'center' });

    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

module.exports = { router };
