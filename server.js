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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

app.post("/upload", adminAuth, upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: "No file received" });

  const videoData = {
    filename:    req.file.originalname,
    url:         req.file.path,        // Cloudinary URL
    publicId:    req.file.filename,    // Cloudinary public_id for deletion
    createdAt:   new Date(),
  };

  db.videos.insert(videoData, (err, doc) => {
    if (err) return res.status(500).json({ ok: false, message: "DB error" });
    console.log("Video uploaded to Cloudinary:", doc.url);
    res.json({ ok: true, message: "Uploaded", video: doc });
  });
});

app.get("/videos-list", visitorAuth, (req, res) => {
  db.videos.find({}).sort({ createdAt: -1 }).exec((err, docs) => {
    if (err) return res.status(500).json({ ok: false, message: "DB error" });
    res.json({ ok: true, videos: docs });
  });
});

app.delete("/delete/:id", adminAuth, (req, res) => {
  db.videos.findOne({ _id: req.params.id }, (err, video) => {
    if (err || !video) return res.status(404).json({ ok: false, message: "Not found" });

    // Delete from Cloudinary
    cloudinary.uploader.destroy(video.publicId, { resource_type: "video" }, (cErr) => {
      if (cErr) console.error("Cloudinary delete error:", cErr);
    });

    db.videos.remove({ _id: req.params.id }, {}, (err2) => {
      if (err2) return res.status(500).json({ ok: false, message: "DB error" });
      res.json({ ok: true });
    });
  });
});

/* ── PAYMENTS ── */
app.post("/submit-payment", (req, res) => {
  const phone  = String(req.body.phone  || "").trim();
  const tx_ref = String(req.body.tx_ref || "").trim();
  if (!phone || !tx_ref) return res.status(400).json({ ok: false, message: "Phone and transaction ID required" });
  if (phone.length < 9)  return res.status(400).json({ ok: false, message: "Invalid phone number" });
  if (tx_ref.length < 4) return res.status(400).json({ ok: false, message: "Transaction ID too short" });

  db.payments.findOne({ tx_ref }, (err, existing) => {
    if (existing) return res.status(400).json({ ok: false, message: "This transaction ID has already been used" });

    db.payments.insert({ phone, tx_ref, status: "pending", code: null, createdAt: new Date() }, (err2) => {
      if (err2) return res.status(500).json({ ok: false, message: "DB error" });
      console.log("Payment pending:", phone, tx_ref);
      res.json({ ok: true, pending: true, message: "Payment submitted!" });
    });
  });
});

app.get("/check-payment", (req, res) => {
  const { phone, tx_ref } = req.query;
  if (!phone || !tx_ref) return res.status(400).json({ ok: false });

  db.payments
    .find({ phone: phone, tx_ref: tx_ref })
    .sort({ createdAt: -1 })
    .exec((err, rows) => {

      if (err || !rows || rows.length === 0) {
        return res.json({ ok: false, status: "not_found" });
      }

      const row = rows[0]; // latest record

      return res.json({
        ok: true,
        status: row.status,
        code: row.code || null
      });
    });
});

app.get("/payments", adminAuth, (req, res) => {
  db.payments.find({}).sort({ createdAt: -1 }).exec((err, docs) => {
    if (err) return res.status(500).json({ ok: false, message: "DB error" });
    res.json({ ok: true, payments: docs });
  });
});

app.post("/approve-payment/:id", adminAuth, (req, res) => {
  const code = generateCode();

  db.payments.update(
    { _id: req.params.id },
    { $set: { status: "approved", code: code } },
    {},
    (err) => {
      if (err) return res.status(500).json({ ok: false, message: "Failed" });

      // FORCE FETCH UPDATED RECORD (important fix)
      db.payments.findOne({ _id: req.params.id }, (err2, updated) => {
        if (err2 || !updated) {
          return res.status(500).json({ ok: false, message: "Update check failed" });
        }

        console.log("APPROVED CODE GENERATED:", updated.code);

        return res.json({
          ok: true,
          code: updated.code,
          status: updated.status
        });
      });
    }
  );
});

app.post("/reject-payment/:id", adminAuth, (req, res) => {
  db.payments.update({ _id: req.params.id }, { $set: { status: "rejected" } }, {}, (err) => {
    if (err) return res.status(500).json({ ok: false, message: "Failed" });
    res.json({ ok: true });
  });
});

/* ── ACCESS CODES ── */
app.post("/generate-manual-code", adminAuth, (req, res) => {
  const code = generateCode();
  db.codes.insert({ code, used: false, createdAt: new Date() }, (err) => {
    if (err) return res.status(500).json({ ok: false, message: "Failed" });
    res.json({ ok: true, code });
  });
});

app.post("/verify-code", (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ ok: false, message: "Code required" });

  db.codes.findOne({ code, used: false }, (err, row) => {
    if (err || !row) return res.status(401).json({ ok: false, message: "Invalid or already used code" });

    const token = generateToken();
    db.sessions.insert({ token, createdAt: new Date() }, (err2) => {
      if (err2) return res.status(500).json({ ok: false, message: "Session error" });
      db.codes.update({ code }, { $set: { used: true } }, {});
      console.log("Access granted:", code);
      res.json({ ok: true, token });
    });
  });
});

/* ── SESSION STATUS ── */
app.get("/session-status", (req, res) => {
  const token = req.headers["authorization"];
  if (!token) return res.json({ valid: false });

  db.sessions.findOne({ token }, (err, session) => {
    if (err || !session) return res.json({ valid: false });

    const elapsed   = Date.now() - new Date(session.createdAt).getTime();
    const remaining = SESSION_MS - elapsed;
    if (remaining <= 0) {
      db.sessions.remove({ token }, {});
      return res.json({ valid: false, expired: true });
    }
    res.json({
      valid:       true,
      hoursLeft:   Math.floor(remaining / 3600000),
      minutesLeft: Math.floor((remaining % 3600000) / 60000),
    });
  });
});

/* ── ADMIN VIDEO LIST ── */
app.get("/admin-videos-list", adminAuth, (req, res) => {
  db.videos.find({}).sort({ createdAt: -1 }).exec((err, docs) => {
    if (err) return res.status(500).json({ ok: false, message: "DB error" });
    res.json({ ok: true, videos: docs });
  });
});

/* ── ROOT ── */
app.get("/", (req, res) => res.redirect("/gate.html"));

/* ── START ── */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`\n🎬 ZABU → http://localhost:${PORT}\n`));