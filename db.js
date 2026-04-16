const Datastore = require("@seald-io/nedb");
const path      = require("path");

const db = {
  videos:   new Datastore({ filename: path.join(__dirname, "data_videos.db"),   autoload: true }),
  codes:    new Datastore({ filename: path.join(__dirname, "data_codes.db"),     autoload: true }),
  sessions: new Datastore({ filename: path.join(__dirname, "data_sessions.db"),  autoload: true }),
  payments: new Datastore({ filename: path.join(__dirname, "data_payments.db"),  autoload: true }),
};

// Auto-cleanup expired sessions every hour
setInterval(() => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  db.sessions.remove({ createdAt: { $lt: cutoff } }, { multi: true });
}, 60 * 60 * 1000);

module.exports = db;