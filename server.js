require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const axios = require("axios");

const { validateOrder } = require("./middleware/validateOrder");
const orderStore = require("./services/orderStore");

const app = express();
const PORT = process.env.PORT || 3000;

const ALIGHTMOTION_API_BASE = "https://sylvatica.my.id/api/tools/alightmotion";
const ALIGHTMOTION_APIKEY = process.env.ALIGHTMOTION_APIKEY || "";
const ALIGHTMOTION_TIMEOUT = Number(process.env.ALIGHTMOTION_TIMEOUT_MS || 20000);

/* ------------------------------------------------------------------ */
/* Security & parsing middleware                                       */
/* ------------------------------------------------------------------ */

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin tidak diizinkan oleh kebijakan CORS"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

const orderLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.RATE_LIMIT_MAX || 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Terlalu banyak permintaan. Silakan coba lagi beberapa saat lagi.",
  },
});

const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use("/api", globalLimiter);

/* ------------------------------------------------------------------ */
/* Static frontend                                                     */
/* ------------------------------------------------------------------ */

app.use(express.static(path.join(__dirname, "public")));

/* ------------------------------------------------------------------ */
/* Helper: notifikasi admin (stub - isi sesuai kebutuhan: WA API,       */
/* email SMTP, Telegram bot, dsb. Saat ini hanya log ke console.)       */
/* ------------------------------------------------------------------ */

function notifyAdmin(order) {
  console.log("=== 🔔 ORDER BARU MASUK ===");
  console.log(`ID       : ${order.id}`);
  console.log(`Email    : ${order.email}`);
  console.log(`Paket    : ${order.package}`);
  console.log(`Waktu    : ${order.createdAt}`);
  console.log("Silakan proses order ini secara manual lalu update statusnya.");
  console.log("============================");

  // TODO (opsional): kirim notifikasi otomatis, contoh:
  // - Kirim pesan via WhatsApp Business API resmi
  // - Kirim email via SMTP (nodemailer)
  // - Kirim ke Telegram bot admin
}

/* ------------------------------------------------------------------ */
/* API Routes                                                          */
/* ------------------------------------------------------------------ */

/**
 * POST /api/order
 * Menerima { email, package }, menyimpan order dengan status "pending",
 * memberi notifikasi ke admin untuk diproses manual (via lisensi/akses
 * resmi yang dimiliki admin), lalu mengembalikan ID order ke client.
 */
app.post("/api/order", orderLimiter, validateOrder, async (req, res) => {
  const { email, package: pkg, options, url } = req.body;

  try {
    const order = orderStore.createOrder({ email, pkg });

    // Integrasi API hanya dijalankan bila API key dikonfigurasi di server.
    // API key TIDAK pernah dikirim ke browser.
    if (!ALIGHTMOTION_APIKEY) {
      notifyAdmin(order);
      return res.status(200).json({
        success: true,
        message: "Order berhasil dibuat dan menunggu konfigurasi API/konfirmasi admin.",
        data: { orderId: order.id, package: order.package, status: order.status },
      });
    }

    const params = {
      email,
      options: typeof options === "string" && options.trim() ? options.trim() : pkg,
      url: typeof url === "string" ? url.trim() : "",
      apikey: ALIGHTMOTION_APIKEY,
    };

    const apiResponse = await axios.get(ALIGHTMOTION_API_BASE, {
      params,
      timeout: ALIGHTMOTION_TIMEOUT,
      validateStatus: () => true,
    });

    const apiData = apiResponse.data;

    if (apiResponse.status < 200 || apiResponse.status >= 300) {
      console.error("Alight Motion API error:", apiResponse.status, apiData);
      notifyAdmin(order);
      return res.status(502).json({
        success: false,
        message: "API aktivasi sedang bermasalah. Order tersimpan dan dapat diproses admin.",
        data: { orderId: order.id, package: order.package, status: order.status },
      });
    }

    console.log(`API Alight Motion berhasil dipanggil untuk order ${order.id}`);

    return res.status(200).json({
      success: true,
      message: "Order berhasil dikirim ke layanan API.",
      data: {
        orderId: order.id,
        package: order.package,
        status: order.status,
        api: apiData,
      },
    });
  } catch (err) {
    console.error("Gagal memproses order:", err.message);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat memproses order. Silakan coba lagi.",
    });
  }
});

/**
 * POST /api/alightmotion
 * Proxy terkontrol untuk API Sylvatica. API key hanya berada di server.
 */
app.post("/api/alightmotion", orderLimiter, async (req, res) => {
  if (!ALIGHTMOTION_APIKEY) {
    return res.status(503).json({ success: false, message: "API key belum dikonfigurasi di server." });
  }

  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const options = typeof req.body?.options === "string" ? req.body.options.trim() : "";
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ success: false, message: "Email tidak valid." });
  }

  try {
    const apiResponse = await axios.get(ALIGHTMOTION_API_BASE, {
      params: { email, options, url, apikey: ALIGHTMOTION_APIKEY },
      timeout: ALIGHTMOTION_TIMEOUT,
      validateStatus: () => true,
    });

    return res.status(apiResponse.status).json({
      success: apiResponse.status >= 200 && apiResponse.status < 300,
      data: apiResponse.data,
    });
  } catch (err) {
    console.error("Proxy API error:", err.message);
    return res.status(502).json({ success: false, message: "Gagal terhubung ke API Alight Motion." });
  }
});

/**
 * GET /api/order/status?email=...
 * Mengembalikan daftar order milik email tertentu (untuk halaman status).
 */
app.get("/api/order/status", statusLimiter, (req, res) => {
  const email = (req.query.email || "").toString().trim().toLowerCase();
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!email || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ success: false, message: "Email tidak valid." });
  }

  const orders = orderStore.getOrdersByEmail(email).map((o) => ({
    orderId: o.id,
    package: o.package,
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  }));

  return res.json({ success: true, data: orders });
});

/**
 * PATCH /api/order/:id/status
 * Endpoint ADMIN untuk mengubah status order secara manual setelah
 * diproses. Dilindungi header x-admin-key sederhana (ganti dengan auth
 * yang lebih kuat untuk production, mis. JWT/session admin).
 */
app.patch("/api/order/:id/status", (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Tidak diizinkan." });
  }

  const { status } = req.body || {};
  const allowedStatus = ["pending", "processing", "completed", "rejected"];
  if (!allowedStatus.includes(status)) {
    return res.status(400).json({ success: false, message: "Status tidak valid." });
  }

  const updated = orderStore.updateOrderStatus(req.params.id, status);
  if (!updated) {
    return res.status(404).json({ success: false, message: "Order tidak ditemukan." });
  }

  return res.json({ success: true, data: updated });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "ok", time: new Date().toISOString() });
});

/* ------------------------------------------------------------------ */
/* Error handling                                                      */
/* ------------------------------------------------------------------ */

app.use((err, req, res, next) => {
  if (err && err.message === "Origin tidak diizinkan oleh kebijakan CORS") {
    return res.status(403).json({ success: false, message: "Origin tidak diizinkan." });
  }
  next(err);
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Terjadi kesalahan pada server." });
});

app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "Endpoint tidak ditemukan." });
});

app.listen(PORT, () => {
  console.log(`✅ AlightPRO backend berjalan di http://localhost:${PORT}`);
});
