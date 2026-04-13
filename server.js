const express = require("express");
const multer  = require("multer");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");
const db      = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const VIDEOS_DIR = path.join(__dirname, "videos");
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// Serve public HTML files
app.use(express.static(path.join(__dirname)));

const ADMIN_SECRET = process.env.ADMIN_SECRET || "zabu-admin-secret-2024";
const SESSION_MS   = 24 * 60 * 60 * 1000;

/* ── HELPERS ── */
function generateToken() {
  return "ZT_" + Math.random().toString(36).substring(2, 12) + Date.now();
}
function generateCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "ZABU-";
  for (let i = 0; i < 5; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}

/* ── MIDDLEWARE ── */
function adminAuth(req, res, next) {
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET)
    return res.status(403).json({ ok: false, message: "Admin access required" });
  next();
}

function visitorAuth(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.status(403).json({ ok: false, message: "No token" });

  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!session) return res.status(403).json({ ok: false, message: "Invalid session" });

  const elapsed = Date.now() - new Date(session.created_at).getTime();
  if (elapsed > SESSION_MS) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return res.status(401).json({ ok: false, message: "Session expired", expired: true });
  }
  next();
}

/* ── VIDEOS (protected) ── */
app.use("/videos", visitorAuth, express.static(VIDEOS_DIR));

/* ── UPLOAD ── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEOS_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith("video/") ? cb(null, true) : cb(new Error("Only video files allowed"));
  },
});

app.post("/upload", adminAuth, (req, res) => {
  upload.single("video")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, message: err.message });
    if (!req.file) return res.status(400).json({ ok: false, message: "No file received" });
    try {
      db.prepare("INSERT INTO videos (filename) VALUES (?)").run(req.file.filename);
      console.log("Video uploaded:", req.file.filename);
      res.json({ ok: true, message: "Uploaded", filename: req.file.filename });
    } catch (e) {
      res.status(500).json({ ok: false, message: "DB error" });
    }
  });
});

app.get("/videos-list", visitorAuth, (req, res) => {
  try {
    const videos = db.prepare("SELECT filename, created_at FROM videos ORDER BY id DESC").all();
    res.json({ ok: true, videos });
  } catch (e) {
    res.status(500).json({ ok: false, message: "DB error" });
  }
});

app.delete("/delete/:filename", adminAuth, (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(VIDEOS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, message: "Not found" });
  fs.unlink(filePath, (err) => {
    if (err) return res.status(500).json({ ok: false, message: "Delete failed" });
    db.prepare("DELETE FROM videos WHERE filename = ?").run(filename);
    res.json({ ok: true });
  });
});

/* ── PAYMENTS ── */
app.post("/submit-payment", (req, res) => {
  const phone  = String(req.body.phone  || "").trim();
  const tx_ref = String(req.body.tx_ref || "").trim();
  if (!phone || !tx_ref) return res.status(400).json({ ok: false, message: "Phone and transaction ID required" });
  if (phone.length < 9)  return res.status(400).json({ ok: false, message: "Invalid phone number" });
  if (tx_ref.length < 4) return res.status(400).json({ ok: false, message: "Transaction ID too short" });

  const existing = db.prepare("SELECT id FROM payments WHERE tx_ref = ?").get(tx_ref);
  if (existing) return res.status(400).json({ ok: false, message: "This transaction ID has already been used" });

  db.prepare("INSERT INTO payments (phone, tx_ref, status) VALUES (?, ?, 'pending')").run(phone, tx_ref);
  console.log("Payment pending:", phone, tx_ref);
  res.json({ ok: true, pending: true, message: "Payment submitted!" });
});

app.get("/check-payment", (req, res) => {
  const phone  = req.query.phone;
  const tx_ref = req.query.tx_ref;
  if (!phone || !tx_ref) return res.status(400).json({ ok: false });

  const row = db.prepare(
    "SELECT status, code FROM payments WHERE phone = ? AND tx_ref = ? ORDER BY id DESC LIMIT 1"
  ).get(phone, tx_ref);

  if (!row) return res.json({ ok: false, status: "not_found" });
  res.json({ ok: true, status: row.status, code: row.code || null });
});

app.get("/payments", adminAuth, (req, res) => {
  const payments = db.prepare("SELECT * FROM payments ORDER BY created_at DESC").all();
  res.json({ ok: true, payments });
});

app.post("/approve-payment/:id", adminAuth, (req, res) => {
  const code = generateCode();
  db.prepare("UPDATE payments SET status='approved', code=? WHERE id=?").run(code, req.params.id);
  db.prepare("INSERT OR IGNORE INTO access_codes (code) VALUES (?)").run(code);
  res.json({ ok: true, code });
});

app.post("/reject-payment/:id", adminAuth, (req, res) => {
  db.prepare("UPDATE payments SET status='rejected' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* ── ACCESS CODES ── */
app.post("/generate-manual-code", adminAuth, (req, res) => {
  const code = generateCode();
  db.prepare("INSERT INTO access_codes (code) VALUES (?)").run(code);
  res.json({ ok: true, code });
});

app.post("/verify-code", (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ ok: false, message: "Code required" });

  const row = db.prepare("SELECT * FROM access_codes WHERE code = ? AND used = 0").get(code);
  if (!row) return res.status(401).json({ ok: false, message: "Invalid or already used code" });

  const token = generateToken();
  db.prepare("INSERT INTO sessions (token) VALUES (?)").run(token);
  db.prepare("UPDATE access_codes SET used = 1 WHERE code = ?").run(code);
  console.log("Access granted:", code);
  res.json({ ok: true, token });
});

/* ── SESSION STATUS ── */
app.get("/session-status", (req, res) => {
  const token = req.headers["authorization"];
  if (!token) return res.json({ valid: false });

  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!session) return res.json({ valid: false });

  const elapsed   = Date.now() - new Date(session.created_at).getTime();
  const remaining = SESSION_MS - elapsed;
  if (remaining <= 0) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return res.json({ valid: false, expired: true });
  }
  res.json({
    valid:       true,
    hoursLeft:   Math.floor(remaining / 3600000),
    minutesLeft: Math.floor((remaining % 3600000) / 60000),
  });
});

/* ── ADMIN VIDEO LIST (no auth needed for admin panel) ── */
app.get("/admin-videos-list", adminAuth, (req, res) => {
  const videos = db.prepare("SELECT filename, created_at FROM videos ORDER BY id DESC").all();
  res.json({ ok: true, videos });
});

/* ── ROOT REDIRECT ── */
app.get("/", (req, res) => res.redirect("/gate.html"));

/* ── START ── */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`\n🎬 ZABU → http://localhost:${PORT}\n`));