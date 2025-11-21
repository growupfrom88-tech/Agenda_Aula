const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { supabase } = require('../db');
const { requireAuth } = require('./auth');

const router = express.Router();

// Multer in-memory storage untuk upload ke Supabase Storage
const upload = multer({ storage: multer.memoryStorage() });

router.get('/admin/rooms', requireAuth, async (req, res) => {
  try {
    const { data: rooms, error: roomsErr } = await supabase
      .from('rooms')
      .select('*')
      .order('name');
    if (roomsErr) throw roomsErr;

    // Ambil foto dari Supabase Storage via tabel room_photos
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
            images = photos.map((p) => {
              const { data } = supabase.storage.from('room-images').getPublicUrl(p.path);
              return { url: data.publicUrl, name: p.path };
            });
          }
        } catch (e) {
          console.error('Load photos error', e);
        }
        return { ...r, images };
      })
    );

    res.render('admin/rooms', { rooms: items });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// Tambah ruangan baru
router.post('/admin/rooms/create', requireAuth, async (req, res) => {
  try {
    const { name, capacity, facilities } = req.body;
    const { error } = await supabase.from('rooms').insert({
      name,
      capacity: capacity ? parseInt(capacity, 10) : null,
      facilities: facilities || null,
    });
    if (error) throw error;
    res.redirect('/admin/rooms');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

router.post('/admin/rooms/:id/update', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const { name, capacity, facilities } = req.body;
    const { error } = await supabase
      .from('rooms')
      .update({
        name,
        capacity: capacity ? parseInt(capacity, 10) : null,
        facilities: facilities || null,
      })
      .eq('id', id);
    if (error) throw error;
    res.redirect('/admin/rooms');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

router.post('/admin/rooms/:id/upload', requireAuth, upload.array('photos', 10), async (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  try {
    if (!req.files || req.files.length === 0) {
      return res.redirect('/admin/rooms');
    }

    for (const file of req.files) {
      const ext = path.extname(file.originalname) || '.jpg';
      const ts = Date.now();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const storagePath = `rooms/${roomId}/${ts}-${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from('room-images')
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype || 'image/jpeg',
          upsert: false,
        });

      if (uploadErr) {
        console.error('Supabase upload error', uploadErr);
        continue;
      }

      const { error: insertErr } = await supabase
        .from('room_photos')
        .insert({ room_id: roomId, path: storagePath });

      if (insertErr) {
        console.error('Supabase room_photos insert error', insertErr);
      }
    }

    res.redirect('/admin/rooms');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error upload foto');
  }
});

router.post('/admin/rooms/:id/photos/delete', requireAuth, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id, 10);
    const { filename } = req.body; // sekarang berisi path di Storage
    if (!filename) return res.redirect('/admin/rooms');

    // Hapus file dari Storage
    const { error: storageErr } = await supabase.storage
      .from('room-images')
      .remove([filename]);
    if (storageErr) {
      console.error('Supabase storage delete error', storageErr);
    }

    // Hapus metadata dari DB Supabase
    const { error: dbErr } = await supabase
      .from('room_photos')
      .delete()
      .eq('room_id', roomId)
      .eq('path', filename);
    if (dbErr) {
      console.error('Supabase room_photos delete error', dbErr);
    }

    res.redirect('/admin/rooms');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

// Hapus ruangan beserta fotonya
router.post('/admin/rooms/:id/delete', requireAuth, async (req, res) => {
  const id = String(req.params.id);
  try {
    // Hapus metadata foto di Supabase dan file di Storage
    try {
      const { data: photos, error } = await supabase
        .from('room_photos')
        .select('path')
        .eq('room_id', parseInt(id, 10));

      if (!error && photos && photos.length) {
        const paths = photos.map((p) => p.path);
        const { error: storageErr } = await supabase.storage
          .from('room-images')
          .remove(paths);
        if (storageErr) {
          console.error('Supabase storage bulk delete error', storageErr);
        }

        const { error: dbErr } = await supabase
          .from('room_photos')
          .delete()
          .eq('room_id', parseInt(id, 10));
        if (dbErr) {
          console.error('Supabase room_photos bulk delete error', dbErr);
        }
      }
    } catch (e) {
      console.error('Error deleting room photos', e);
    }

    // Hapus data ruangan dari Supabase
    const { error: roomErr } = await supabase.from('rooms').delete().eq('id', id);
    if (roomErr) throw roomErr;

    res.redirect('/admin/rooms');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

module.exports = { router };
