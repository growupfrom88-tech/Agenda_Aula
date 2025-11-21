require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const morgan = require('morgan');
const { router: authRouter } = require('./src/routes/auth');
const { router: appRouter } = require('./src/routes/index');
const { router: adminRoomsRouter } = require('./src/routes/adminRooms');
const { ensureDb } = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure DB and seeds
ensureDb()
  .then(() => console.log('Database ready'))
  .catch((e) => console.error('DB init error', e));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(morgan('dev'));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change_this_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// expose session to views
app.use((req, res, next) => {
  res.locals.authenticated = !!req.session.user;
  res.locals.user = req.session.user || null;
  next();
});

app.use('/', authRouter);
app.use('/', appRouter);
app.use('/', adminRoomsRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(err && err.message ? err.message : 'Internal Server Error');
});

if (process.env.VERCEL) {
  // Running on Vercel: export app for serverless function handler
  module.exports = app;
} else {
  // Local / traditional server mode
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}
