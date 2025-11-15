const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'app.sqlite');

function openDb() {
  return new sqlite3.Database(dbPath);
}

async function ensureDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb();

  await run(db, `PRAGMA foreign_keys = ON;`);

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      capacity INTEGER,
      facilities TEXT
    );`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      borrower_org TEXT NOT NULL,
      event_name TEXT NOT NULL,
      date TEXT NOT NULL, -- legacy start_date
      start_time TEXT NOT NULL, -- HH:mm
      end_time TEXT NOT NULL, -- HH:mm
      committee_name TEXT,
      contact TEXT,
      notes TEXT,
      doc_path TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );`
  );

  await run(db, `CREATE INDEX IF NOT EXISTS idx_bookings_room_date ON bookings(room_id, date);`);

  // Migrate to multi-day: add start_date and end_date if missing, and backfill from legacy 'date'
  const cols = await all(db, `PRAGMA table_info(bookings);`);
  const hasStartDate = cols.some(c => c.name === 'start_date');
  const hasEndDate = cols.some(c => c.name === 'end_date');
  const hasDocPath = cols.some(c => c.name === 'doc_path');
  if (!hasStartDate) {
    try { await run(db, `ALTER TABLE bookings ADD COLUMN start_date TEXT;`); } catch (e) {}
  }
  if (!hasEndDate) {
    try { await run(db, `ALTER TABLE bookings ADD COLUMN end_date TEXT;`); } catch (e) {}
  }
  if (!hasDocPath) {
    try { await run(db, `ALTER TABLE bookings ADD COLUMN doc_path TEXT;`); } catch (e) {}
  }
  // Backfill null start_date/end_date from legacy date
  try {
    await run(db, `UPDATE bookings SET start_date = COALESCE(start_date, date), end_date = COALESCE(end_date, date) WHERE start_date IS NULL OR end_date IS NULL;`);
  } catch (e) {}
  // Helpful index for range queries
  await run(db, `CREATE INDEX IF NOT EXISTS idx_bookings_room_range ON bookings(room_id, start_date, end_date);`);

  // Seed rooms
  const rooms = ['PASAMOAN', 'PANGLAWUNGAN', 'ADILUHUNG', 'PANINEUNGAN', 'PAMAGEUHAN'];
  for (const name of rooms) {
    await run(db, `INSERT OR IGNORE INTO rooms(name) VALUES (?)`, [name]);
  }

  // Ensure columns exist (for migrations on existing DB)
  const roomCols = await all(db, `PRAGMA table_info(rooms);`);
  const hasCapacity = roomCols.some(c => c.name === 'capacity');
  const hasFacilities = roomCols.some(c => c.name === 'facilities');
  if (!hasCapacity) { try { await run(db, `ALTER TABLE rooms ADD COLUMN capacity INTEGER;`);} catch(e){} }
  if (!hasFacilities) { try { await run(db, `ALTER TABLE rooms ADD COLUMN facilities TEXT;`);} catch(e){} }

  // Seed default capacity/facilities if empty
  const defaults = {
    PASAMOAN: { capacity: 80, facilities: 'Kursi, Meja, Sound System, Proyektor, AC' },
    PANGLAWUNGAN: { capacity: 120, facilities: 'Kursi, Meja, Panggung, Sound System, Proyektor, AC' },
    ADILUHUNG: { capacity: 60, facilities: 'Kursi, Meja, TV/Display, AC' },
    PANINEUNGAN: { capacity: 40, facilities: 'Kursi, Meja, Whiteboard, AC' },
    PAMAGEUHAN: { capacity: 200, facilities: 'Kursi, Meja, Panggung, Lighting, Sound System, Proyektor, AC' }
  };
  for (const name of rooms) {
    const d = defaults[name];
    await run(db, `UPDATE rooms SET capacity = COALESCE(capacity, ?), facilities = COALESCE(facilities, ?)
                   WHERE name = ?`, [d.capacity, d.facilities, name]);
  }

  // Seed default admin if none
  const admin = await get(db, `SELECT COUNT(1) AS c FROM admins`);
  if (admin.c === 0) {
    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASS || 'Admin123!';
    const hash = bcrypt.hashSync(password, 10);
    await run(db, `INSERT INTO admins(username, password_hash) VALUES (?, ?)`, [username, hash]);
    console.log(`Seeded default admin username=${username}`);
  }

  db.close();
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function withDb(fn) {
  const db = openDb();
  return fn(db).finally(() => db.close());
}

async function checkOverlap(db, { id = null, room_id, start_date, end_date, start_time, end_time }) {
  // Overlap if date ranges intersect AND time ranges intersect
  const params = [room_id, end_date, start_date, end_time, start_time];
  let sql = `SELECT COUNT(1) AS c FROM bookings
    WHERE room_id = ?
      AND start_date <= ? AND end_date >= ?
      AND start_time < ? AND end_time > ?`;
  if (id) {
    sql += ' AND id != ?';
    params.push(id);
  }
  const r = await get(db, sql, params);
  return r.c > 0;
}

module.exports = { ensureDb, withDb, openDb, run, all, get, checkOverlap };
