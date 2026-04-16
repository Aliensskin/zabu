const express    = require("express");
const multer     = require("multer");
const cors       = require("cors");
const path       = require("path");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const db         = require("./db");
const videos = [
  {
    filename: "Yvonne-Nakankaka-Viral-Sextape-1",
    url: "https://player.cloudinary.com/embed/?cloud_name=djog6tfpk&public_id=zabu-videos%2Fy1bsjhjwycloiskj2gco"
  },
  {
    filename: "Jollybonney-Sextape-Coco-Leak",
    url: "https://player.cloudinary.com/embed/?cloud_name=djog6tfpk&public_id=zabu-videos%2Fe8icbrlqnvkk69wxp4vt"
  },
  {
    filename: "Busoga-School-Girl-Sextape",
    url: "https://player.cloudinary.com/embed/?cloud_name=djog6tfpk&public_id=zabu-videos%2Fl0nnhlv61bqofjbnfrv9"
  },
  {
    filename: "Video 2",
    url: "https://player.cloudinary.com/embed/?cloud_name=djog6tfpk&public_id=zabu-videos%2Fe8icbrlqnvkk69wxp4vt"
  }
  ,
  {
    filename: "Video 2",
    url: "https://player.cloudinary.com/embed/?cloud_name=djog6tfpk&public_id=zabu-videos%2Fe8icbrlqnvkk69wxp4vt"
  }
];
const app = express();
app.use(cors());
app.use(express.json());

// Serve HTML
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "public")));

/* ── CONFIG ── */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || "zabu-admin-secret-2024";

/* ── HELPERS ── */
function generateToken() {
  return "ZT_" + Math.random().toString(36).substring(2, 12) + Date.now();
}

function generateCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "ZABU-";
  for (let i = 0; i < 5; i++) {
    code += c[Math.floor(Math.random() * c.length)];
  }
  return code;
}

/* ── AUTH ── */
function adminAuth(req, res, next) {
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false });
  }
  next();
}

/* ── VIDEO UPLOAD ── */
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "zabu-videos",
    resource_type: "video",
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.post("/upload", adminAuth, upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false });

  db.videos.insert({
    filename: req.file.originalname,
    url: req.file.path,
    publicId: req.file.filename,
    createdAt: new Date(),
  }, () => {
    res.json({ ok: true });
  });
});
/* ── GET VIDEOS (PROTECTED) ── */
app.get("/videos-list", (req, res) => {
  const token = req.headers["authorization"];

  if (!token) {
    return res.status(403).json({ ok: false });
  }

  db.sessions.findOne({ token }, (err, session) => {
    if (err || !session) {
      return res.status(403).json({ ok: false });
    }

    const SESSION_MS = 24 * 60 * 60 * 1000;
    const elapsed = Date.now() - new Date(session.createdAt).getTime();

    if (elapsed > SESSION_MS) {
      return res.json({ ok: false, expired: true });
    }

    return res.json({
      ok: true,
      videos: videos
    });
  });
});
/* ───────────────────────── */
/* ── PAYMENTS (FIXED) ───── */
/* ───────────────────────── */

/* SUBMIT */
app.post("/submit-payment", (req, res) => {
  const phone  = String(req.body.phone || "").trim();
  const tx_ref = String(req.body.tx_ref || "").trim().toUpperCase();

  if (!phone || !tx_ref) {
    return res.status(400).json({ ok: false, message: "Missing fields" });
  }

  db.payments.findOne({ tx_ref }, (err, existing) => {
    if (existing) {
      return res.status(400).json({ ok: false, message: "Already used" });
    }

    db.payments.insert({
      phone,
      tx_ref,
      status: "pending",
      code: null,
      createdAt: new Date()
    }, () => {
      console.log("🟡 PAYMENT SUBMITTED:", phone, tx_ref);
      res.json({ ok: true });
    });
  });
});

/* 🔥 CHECK (FINAL FIX) */
app.get("/check-payment", (req, res) => {
  const tx_ref = String(req.query.tx_ref || "").trim().toUpperCase();

  if (!tx_ref) return res.json({ ok: false });

  db.payments.findOne({ tx_ref }, (err, row) => {
    if (err || !row) {
      return res.json({ ok: false, status: "not_found" });
    }

    console.log("🔎 CHECK:", row.tx_ref, row.status, row.code);

    return res.json({
      ok: true,
      status: row.status,
      code: row.code || null
    });
  });
});

/* ADMIN VIEW */
app.get("/payments", adminAuth, (req, res) => {
  db.payments.find({}).sort({ createdAt: -1 }).exec((err, docs) => {
    res.json({ ok: true, payments: docs });
  });
});

/* 🔥 APPROVE (REAL FIX) */
app.post("/approve-payment/:id", adminAuth, (req, res) => {
  const code = generateCode();

  db.payments.findOne({ _id: req.params.id }, (err, payment) => {
    if (!payment) {
      return res.status(404).json({ ok: false });
    }

    db.payments.update(
      { _id: req.params.id },
      { $set: { status: "approved", code: code } },
      {},
      () => {

        // SAVE CODE FOR LOGIN
        db.codes.insert({
          code,
          used: false,
          createdAt: new Date()
        });

        console.log("🟢 APPROVED:", payment.tx_ref, "→", code);

        res.json({ ok: true, code });
      }
    );
  });
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

/* ── VERIFY CODE ── */
app.post("/verify-code", (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();

  db.codes.findOne({ code, used: false }, (err, row) => {
    if (!row) {
      return res.status(401).json({ ok: false });
    }

    const token = generateToken();

    db.sessions.insert({
      token,
      createdAt: new Date()
    }, () => {

      db.codes.update(
        { code },
        { $set: { used: true } },
        {}
      );

      console.log("🎬 ACCESS GRANTED:", code);

      res.json({ ok: true, token });
    });
  });
});

/* ROOT */
app.get("/", (req, res) => res.redirect("/gate.html"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 ZABU running on ${PORT}`));