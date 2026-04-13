const sqlite3 = require("sqlite3").verbose();
const path    = require("path");

const db = new sqlite3.Database(path.join(__dirname, "zabu.db"));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS videos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    filename   TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS access_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT UNIQUE NOT NULL,
    used       INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT,
    tx_ref     TEXT,
    status     TEXT DEFAULT 'pending',
    code       TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Clean up expired sessions on startup
  db.run(`DELETE FROM sessions WHERE datetime(created_at, '+24 hours') < datetime('now')`);
});

module.exports = db;
