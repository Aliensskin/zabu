const express    = require("express");
const multer     = require("multer");
const cors       = require("cors");
const path       = require("path");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const db         = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

// Serve HTML files
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "public")));

/* ── CLOUDINARY CONFIG ── */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ── CONSTANTS ── */
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

  db.sessions.findOne({ token }, (err, session) => {
    if (err || !session) return res.status(403).json({ ok: false, message: "Invalid session" });

    const elapsed = Date.now() - new Date(session.createdAt).getTime();
    if (elapsed > SESSION_MS) {
      db.sessions.remove({ token }, {});
      return res.status(401).json({ ok: false, message: "Session expired", expired: true });
    }
    next();
  });
}

/* ── CLOUDINARY UPLOAD ── */
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:         "zabu-videos",
    resource_type:  "video",
    allowed_formats: ["mp4", "mov", "avi", "mkv", "webm"],
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.post("/upload", adminAuth, upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: "No file received" });

  const videoData = {
    filename:  req.file.originalname,
    url:       req.file.path,
    publicId:  req.file.filename,
    createdAt: new Date(),
  };

  db.videos.insert(videoData, (err, doc) => {
    if (err) return res.status(500).json({ ok: false, message: "DB error" });
    res.json({ ok: true, video: doc });
  });
});

/* ── PAYMENTS ── */

/* SUBMIT PAYMENT (normalized) */
app.post("/submit-payment", (req, res) => {
  const phone  = String(req.body.phone || "").trim();
  const tx_ref = String(req.body.tx_ref || "").trim().toUpperCase();

  if (!phone || !tx_ref)
    return res.status(400).json({ ok: false, message: "Phone and transaction ID required" });

  db.payments.findOne({ tx_ref }, (err, existing) => {
    if (existing)
      return res.status(400).json({ ok: false, message: "Transaction already used" });

    db.payments.insert({
      phone,
      tx_ref,
      status: "pending",
      code: null,
      createdAt: new Date()
    }, (err2) => {
      if (err2) return res.status(500).json({ ok: false });
      res.json({ ok: true, pending: true });
    });
  });
});

/* 🔥 FIXED CHECK PAYMENT (robust match) */
app.get("/check-payment", (req, res) => {
  const phone  = String(req.query.phone || "").trim();
  const tx_ref = String(req.query.tx_ref || "").trim().toUpperCase();

  if (!phone || !tx_ref) {
    return res.status(400).json({ ok: false });
  }

  db.payments.find({}).sort({ createdAt: -1 }).exec((err, rows) => {

    if (err || !rows || rows.length === 0) {
      return res.json({ ok: false, status: "not_found" });
    }

    const match = rows.find(p =>
      p.phone === phone && p.tx_ref === tx_ref
    );

    if (!match) {
      return res.json({ ok: false, status: "not_found" });
    }

    return res.json({
      ok: true,
      status: match.status,
      code: match.code || null
    });
  });
});

/* ADMIN VIEW */
app.get("/payments", adminAuth, (req, res) => {
  db.payments.find({}).sort({ createdAt: -1 }).exec((err, docs) => {
    if (err) return res.status(500).json({ ok: false });
    res.json({ ok: true, payments: docs });
  });
});

/* APPROVE PAYMENT */
app.post("/approve-payment/:id", adminAuth, (req, res) => {
  const code = generateCode();

  db.payments.update(
    { _id: req.params.id },
    { $set: { status: "approved", code: code } },
    {},
    (err) => {
      if (err) return res.status(500).json({ ok: false });

      // ALSO SAVE CODE
      db.codes.insert({ code, used: false, createdAt: new Date() });

      res.json({ ok: true, code });
    }
  );
});

/* REJECT */
app.post("/reject-payment/:id", adminAuth, (req, res) => {
  db.payments.update(
    { _id: req.params.id },
    { $set: { status: "rejected" } },
    {},
    () => res.json({ ok: true })
  );
});

/* VERIFY CODE */
app.post("/verify-code", (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();

  db.codes.findOne({ code, used: false }, (err, row) => {
    if (!row) return res.status(401).json({ ok: false });

    const token = generateToken();

    db.sessions.insert({ token, createdAt: new Date() }, () => {
      db.codes.update({ code }, { $set: { used: true } }, {});
      res.json({ ok: true, token });
    });
  });
});

/* ROOT */
app.get("/", (req, res) => res.redirect("/gate.html"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`ZABU running on ${PORT}`));