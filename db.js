const Database = require("better-sqlite3");
const path     = require("path");

const db = new Database(path.join(__dirname, "zabu.db"));

// Use WAL mode for better performance
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    filename   TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS access_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT UNIQUE NOT NULL,
    used       INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT,
    tx_ref     TEXT,
    status     TEXT DEFAULT 'pending',
    code       TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Clean expired sessions on startup
db.prepare(`DELETE FROM sessions WHERE datetime(created_at, '+24 hours') < datetime('now')`).run();

module.exports = db;