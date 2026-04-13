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

app.use(express.static(path.join(__dirname, "public")));

const ADMIN_SECRET = process.env.ADMIN_SECRET || "zabu-admin-secret-2024";
const SESSION_MS   = 24 * 60 * 60 * 1000;

function generateToken() {
  return "ZT_" + Math.random().toString(36).substring(2, 12) + Date.now();
}
function generateCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "ZABU-";
  for (let i = 0; i < 5; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}

function adminAuth(req, res, next) {
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET)
    return res.status(403).json({ ok: false, message: "Admin access required" });
  next();
}

function visitorAuth(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.status(403).json({ ok: false, message: "No token" });

  db.get("SELECT * FROM sessions WHERE token = ?", [token], (err, session) => {
    if (err || !session) return res.status(403).json({ ok: false, message: "Invalid session" });

    const elapsed = Date.now() - new Date(session.created_at).getTime();
    if (elapsed > SESSION_MS) {
      db.run("DELETE FROM sessions WHERE token = ?", [token]);
      return res.status(401).json({ ok: false, message: "Session expired", expired: true });
    }
    next();
  });
}

// Videos are protected — must have a valid session token
app.use("/videos", visitorAuth, express.static(VIDEOS_DIR));

// Video upload
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
    db.run("INSERT INTO videos (filename) VALUES (?)", [req.file.filename], (dbErr) => {
      if (dbErr) return res.status(500).json({ ok: false, message: "DB error" });
      console.log("Video uploaded:", req.file.filename);
      res.json({ ok: true, message: "Uploaded", filename: req.file.filename });
    });
  });
});

app.get("/videos-list", visitorAuth, (req, res) => {
  db.all("SELECT filename, created_at FROM videos ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, message: "DB error" });
    res.json({ ok: true, videos: rows });
  });
});

app.delete("/delete/:filename", adminAuth, (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(VIDEOS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, message: "Not found" });
  fs.unlink(filePath, (err) => {
    if (err) return res.status(500).json({ ok: false, message: "Delete failed" });
    db.run("DELETE FROM videos WHERE filename = ?", [filename]);
    res.json({ ok: true });
  });
});

app.post("/submit-payment", (req, res) => {
  const phone  = String(req.body.phone  || "").trim();
  const tx_ref = String(req.body.tx_ref || "").trim();
  if (!phone || !tx_ref) return res.status(400).json({ ok: false, message: "Phone and transaction ID required" });
  if (phone.length < 9) return res.status(400).json({ ok: false, message: "Invalid phone number" });
  if (tx_ref.length < 4) return res.status(400).json({ ok: false, message: "Transaction ID too short" });

  db.get("SELECT id FROM payments WHERE tx_ref = ?", [tx_ref], (err, existing) => {
    if (existing) return res.status(400).json({ ok: false, message: "This transaction ID has already been used" });
    // FIX 3: Save as PENDING — admin must approve before code is generated
    db.run(
      "INSERT INTO payments (phone, tx_ref, status) VALUES (?, ?, 'pending')",
      [phone, tx_ref],
      (err) => {
        if (err) return res.status(500).json({ ok: false, message: "DB error" });
        console.log("Payment pending:", phone, tx_ref);
        res.json({ ok: true, pending: true, message: "Payment submitted! Wait for admin approval. You will receive your code soon." });
      }
    );
  });
});

app.get("/payments", adminAuth, (req, res) => {
  db.all("SELECT * FROM payments ORDER BY created_at DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, message: "DB error" });
    res.json({ ok: true, payments: rows });
  });
});

app.post("/approve-payment/:id", adminAuth, (req, res) => {
  const code = generateCode();
  db.run("UPDATE payments SET status='approved', code=? WHERE id=?", [code, req.params.id], (err) => {
    if (err) return res.status(500).json({ ok: false, message: "Failed" });
    db.run("INSERT OR IGNORE INTO access_codes (code) VALUES (?)", [code]);
    res.json({ ok: true, code });
  });
});

app.post("/reject-payment/:id", adminAuth, (req, res) => {
  db.run("UPDATE payments SET status='rejected' WHERE id=?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ ok: false, message: "Failed" });
    res.json({ ok: true });
  });
});

app.post("/generate-manual-code", adminAuth, (req, res) => {
  const code = generateCode();
  db.run("INSERT INTO access_codes (code) VALUES (?)", [code], (err) => {
    if (err) return res.status(500).json({ ok: false, message: "Failed" });
    res.json({ ok: true, code });
  });
});

app.post("/verify-code", (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ ok: false, message: "Code required" });

  db.get("SELECT * FROM access_codes WHERE code = ? AND used = 0", [code], (err, row) => {
    if (err || !row) return res.status(401).json({ ok: false, message: "Invalid or already used code" });
    const token = generateToken();
    db.run("INSERT INTO sessions (token) VALUES (?)", [token], (err2) => {
      if (err2) return res.status(500).json({ ok: false, message: "Session error" });
      db.run("UPDATE access_codes SET used = 1 WHERE code = ?", [code]);
      console.log("Access granted:", code);
      res.json({ ok: true, token });
    });
  });
});

app.get("/session-status", (req, res) => {
  const token = req.headers["authorization"];
  if (!token) return res.json({ valid: false });
  db.get("SELECT * FROM sessions WHERE token = ?", [token], (err, session) => {
    if (err || !session) return res.json({ valid: false });
    const elapsed   = Date.now() - new Date(session.created_at).getTime();
    const remaining = SESSION_MS - elapsed;
    if (remaining <= 0) {
      db.run("DELETE FROM sessions WHERE token = ?", [token]);
      return res.json({ valid: false, expired: true });
    }
    res.json({
      valid: true,
      hoursLeft:   Math.floor(remaining / 3600000),
      minutesLeft: Math.floor((remaining % 3600000) / 60000),
    });
  });
});


// User polls this to check if their payment was approved
app.get("/check-payment", (req, res) => {
  const phone  = req.query.phone;
  const tx_ref = req.query.tx_ref;
  if (!phone || !tx_ref) return res.status(400).json({ ok: false, message: "Missing params" });

  db.get(
    "SELECT status, code FROM payments WHERE phone = ? AND tx_ref = ? ORDER BY id DESC LIMIT 1",
    [phone, tx_ref],
    (err, row) => {
      if (err || !row) return res.json({ ok: false, status: "not_found" });
      res.json({ ok: true, status: row.status, code: row.code || null });
    }
  );
});

app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get("/", (req, res) => res.redirect("/gate.html"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`\n🎬 ZABU → http://localhost:${PORT}\n`));