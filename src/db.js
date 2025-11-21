const bcrypt = require('bcryptjs');
const { supabase } = require('./supabaseClient');

// Inisialisasi dan seeding berbasis Supabase (BUKAN SQLite lagi)
async function ensureDb() {
  // Seed rooms jika kosong
  const { data: existingRooms, error: roomsErr } = await supabase
    .from('rooms')
    .select('id')
    .limit(1);

  if (!roomsErr && (!existingRooms || existingRooms.length === 0)) {
    const defaults = [
      { name: 'PASAMOAN', capacity: 80, facilities: 'Kursi, Meja, Sound System, Proyektor, AC' },
      { name: 'PANGLAWUNGAN', capacity: 120, facilities: 'Kursi, Meja, Panggung, Sound System, Proyektor, AC' },
      { name: 'ADILUHUNG', capacity: 60, facilities: 'Kursi, Meja, TV/Display, AC' },
      { name: 'PANINEUNGAN', capacity: 40, facilities: 'Kursi, Meja, Whiteboard, AC' },
      { name: 'PAMAGEUHAN', capacity: 200, facilities: 'Kursi, Meja, Panggung, Lighting, Sound System, Proyektor, AC' },
    ];

    const { error: insertRoomsErr } = await supabase.from('rooms').insert(defaults);
    if (insertRoomsErr) {
      console.error('Gagal seeding rooms ke Supabase:', insertRoomsErr);
    }
  }

  // Pastikan setiap room punya capacity/facilities terisi (jika sebelumnya kosong)
  const defaultsMap = {
    PASAMOAN: { capacity: 80, facilities: 'Kursi, Meja, Sound System, Proyektor, AC' },
    PANGLAWUNGAN: { capacity: 120, facilities: 'Kursi, Meja, Panggung, Sound System, Proyektor, AC' },
    ADILUHUNG: { capacity: 60, facilities: 'Kursi, Meja, TV/Display, AC' },
    PANINEUNGAN: { capacity: 40, facilities: 'Kursi, Meja, Whiteboard, AC' },
    PAMAGEUHAN: { capacity: 200, facilities: 'Kursi, Meja, Panggung, Lighting, Sound System, Proyektor, AC' },
  };

  const { data: roomsAll, error: roomsAllErr } = await supabase
    .from('rooms')
    .select('id,name,capacity,facilities');
  if (!roomsAllErr && roomsAll) {
    for (const r of roomsAll) {
      const d = defaultsMap[r.name];
      if (!d) continue;
      if (r.capacity == null || r.facilities == null) {
        const { error: updErr } = await supabase
          .from('rooms')
          .update({
            capacity: r.capacity == null ? d.capacity : r.capacity,
            facilities: r.facilities == null ? d.facilities : r.facilities,
          })
          .eq('id', r.id);
        if (updErr) console.error('Gagal update default room info:', updErr);
      }
    }
  }

  // Seed admin jika belum ada
  const { data: adminRows, error: adminErr } = await supabase
    .from('admins')
    .select('id')
    .limit(1);
  if (!adminErr && (!adminRows || adminRows.length === 0)) {
    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASS || 'Admin123!';
    const hash = bcrypt.hashSync(password, 10);
    const { error: insErr } = await supabase
      .from('admins')
      .insert({ username, password_hash: hash });
    if (insErr) {
      console.error('Gagal seeding admin default ke Supabase:', insErr);
    } else {
      console.log(`Seeded default admin username=${username} (Supabase)`);
    }
  }
}

// Cek bentrok booking menggunakan Supabase
async function checkOverlap(_, { id = null, room_id, start_date, end_date, start_time, end_time }) {
  let query = supabase
    .from('bookings')
    .select('id')
    .eq('room_id', room_id)
    .lte('start_date', end_date)
    .gte('end_date', start_date)
    .lt('start_time', end_time)
    .gt('end_time', start_time);

  if (id) {
    query = query.neq('id', id);
  }

  const { data, error } = await query;
  if (error) {
    console.error('checkOverlap Supabase error:', error);
    throw error;
  }
  return data && data.length > 0;
}

// Stub fungsi-fungsi lama berbasis SQLite (masih diekspor agar require tidak gagal).
// Semua pemanggilan terhadap fungsi ini harus dihapus saat refactor route selesai.
function openDb() {
  throw new Error('openDb (SQLite) tidak lagi didukung. Route harus direfactor ke Supabase.');
}
function run() {
  throw new Error('run (SQLite) tidak lagi didukung. Route harus direfactor ke Supabase.');
}
function all() {
  throw new Error('all (SQLite) tidak lagi didukung. Route harus direfactor ke Supabase.');
}
function get() {
  throw new Error('get (SQLite) tidak lagi didukung. Route harus direfactor ke Supabase.');
}
function withDb() {
  throw new Error('withDb (SQLite) tidak lagi didukung. Route harus direfactor ke Supabase.');
}

module.exports = { ensureDb, withDb, openDb, run, all, get, checkOverlap, supabase };
