const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/calendar');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { data, error } = await supabase
      .from('admins')
      .select('*')
      .eq('username', username)
      .limit(1);

    if (error) {
      console.error(error);
      return res.render('login', { error: 'Terjadi kesalahan' });
    }

    const admin = data && data[0];
    if (!admin) return res.render('login', { error: 'Username atau password salah' });

    const ok = bcrypt.compareSync(password, admin.password_hash);
    if (!ok) return res.render('login', { error: 'Username atau password salah' });
    req.session.user = { id: admin.id, username: admin.username };
    res.redirect('/calendar');
  } catch (e) {
    console.error(e);
    res.render('login', { error: 'Terjadi kesalahan' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = { router, requireAuth };
