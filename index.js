"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { DateTime } = require("luxon");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth, Poll } = require("whatsapp-web.js");
const { createSendGuard } = require("./lib/send-guard");
const { renderAdminSettingsPage } = require("./lib/admin-settings-page");
const { ADMIN_CSS, icon } = require("./lib/admin-ui");
const { loadEnvFile } = require("./lib/env-file");

// Muat .env sebelum konstanta di bawah dibaca. Env dari shell/systemd tetap menang.
loadEnvFile(path.join(__dirname, ".env"));

const TIMEZONE = "Asia/Jakarta";
const PREGNANCY_WEEKS_LIMIT = Number(process.env.PREGNANCY_WEEKS_LIMIT || 42);
const HPL_DAYS_FROM_HPHT = 280;
const DELIVERY_VALIDATION_START_WEEK = Number(
  process.env.DELIVERY_VALIDATION_START_WEEK || 39,
);
const REMINDER_POLL_QUESTION = "Sudah minum tablet FE hari ini? 💊😊";
// Pertanyaan yang sama kata per kata, dikirim ke semua user setiap hari, adalah sinyal
// konten yang paling mudah dikenali. Varian di bawah dipilih deterministik per user dan
// tanggal. Opsinya sengaja dibiarkan sama supaya parsing jawaban tidak pernah pecah.
const REMINDER_POLL_VARIANTS = [
  REMINDER_POLL_QUESTION,
  "Tablet FE hari ini sudah diminum, Bu? 💊",
  "Pengingat: sudah konsumsi tablet tambah darah hari ini? 🩺",
  "Bagaimana tablet FE hari ini, sudah atau belum? 💗",
  "Sudah diminum belum tablet FE-nya hari ini? 🤰",
  "Cek sebentar: tablet FE hari ini sudah masuk? 💊",
  "Pengingat tablet FE hari ini ya, Bu 💊",
];
const REMINDER_POLL_OPTIONS = ["Sudah ✅", "Belum ⏳"];
const DELIVERY_VALIDATION_POLL_QUESTION = "Apakah Ibu sudah melahirkan?";
const DELIVERY_VALIDATION_POLL_OPTIONS = [
  "Sudah melahirkan",
  "Belum melahirkan",
];
const DELIVERY_ARTICLE_URL = "https://remindcares.web.app";
const POSTPARTUM_POLL_OPTIONS = ["Sudah ✅", "Belum ⏳"];
const ENFORCE_ALLOWLIST = /^(1|true)$/i.test(
  process.env.ENFORCE_ALLOWLIST || "",
);
const ADMIN_WA_IDS = parseWaIdList(process.env.ADMIN_WA_IDS);
const ALLOWLIST_WA_IDS = parseWaIdList(process.env.ALLOWLIST_WA_IDS);
const MAX_MESSAGES_PER_MINUTE = Number(
  process.env.RATE_LIMIT_MAX_PER_MINUTE || 20,
);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_COOLDOWN_MS = Number(
  process.env.RATE_LIMIT_COOLDOWN_MS || 120000,
);
const MAX_POLL_RESPONSES_PER_DAY = Number(
  process.env.POLL_MAX_RESPONSES_PER_DAY || 2,
);
const ADMIN_WEB_ENABLED = !/^(0|false)$/i.test(
  process.env.ADMIN_WEB_ENABLED || "",
);
const ADMIN_WEB_PORT = Number(process.env.ADMIN_WEB_PORT || 3030);
const ADMIN_WEB_USER = process.env.ADMIN_WEB_USER || "admin";
const ADMIN_WEB_PASSWORD = (process.env.ADMIN_WEB_PASSWORD || "").trim();
const ADMIN_WEB_SESSION_TTL_MS = Number(
  process.env.ADMIN_WEB_SESSION_TTL_MS || 8 * 60 * 60 * 1000,
);
const REMINDER_LOG_RETENTION_DAYS = Number(
  process.env.REMINDER_LOG_RETENTION_DAYS || 180,
);
const POLL_RETRY_BASE_DELAY_MS = Number(
  process.env.POLL_RETRY_BASE_DELAY_MS || 5 * 60 * 1000,
);
const POLL_RETRY_MAX_DELAY_MS = Number(
  process.env.POLL_RETRY_MAX_DELAY_MS || 30 * 60 * 1000,
);
// Paralel 10 pengiriman pada satu page Puppeteer memicu error intermiten yang lalu
// dianggap gagal kirim (duplikat poll) dan membentuk pola kirim bergelombang.
// Serialisasi sudah ditangani antrean sendGuard, jadi default 1.
const REMINDER_LOOP_CONCURRENCY = Number(
  process.env.REMINDER_LOOP_CONCURRENCY || 1,
);
const ADMIN_WEB_COOKIE_SECURE = (() => {
  const explicit = String(process.env.ADMIN_WEB_COOKIE_SECURE || "").trim();
  if (explicit) {
    return /^(1|true)$/i.test(explicit);
  }
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
})();
const DISABLE_SANDBOX =
  /^(1|true)$/i.test(process.env.PUPPETEER_NO_SANDBOX || "") ||
  /^(1|true)$/i.test(process.env.DISABLE_CHROME_SANDBOX || "");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "remindcare.db");
// Nomor bot, format internasional tanpa tanda plus, contoh 6281234567890.
// Kalau diisi, penautan tidak memakai QR: WhatsApp meminta kode 8 digit yang diketik
// di Perangkat tertaut > Tautkan dengan nomor telepon. Dipakai untuk server tanpa layar.
const WA_PAIRING_NUMBER = String(process.env.WA_PAIRING_NUMBER || "").replace(
  /[^0-9]/g,
  "",
);
const PAIRING_CODE_PATH = path.join(DATA_DIR, "pairing-code.txt");
const PAIRING_CODE_REFRESH_MS = Number(
  process.env.WA_PAIRING_CODE_REFRESH_MS || 180000,
);
const ADMIN_WEB_HOST = process.env.ADMIN_WEB_HOST || "127.0.0.1";
const ADMIN_WEB_TRUST_PROXY = /^(1|true)$/i.test(
  process.env.ADMIN_WEB_TRUST_PROXY || "",
);
const MAX_SEND_ATTEMPTS = Number(process.env.MAX_SEND_ATTEMPTS || 4);
const ADMIN_LOGIN_MAX_ATTEMPTS = Number(
  process.env.ADMIN_LOGIN_MAX_ATTEMPTS || 5,
);
const ADMIN_LOGIN_WINDOW_MS = Number(
  process.env.ADMIN_LOGIN_WINDOW_MS || 15 * 60 * 1000,
);
const PASSWORD_FILE_MODE = 0o600;
const REMINDER_STALE_AFTER_MINUTES = Number(
  process.env.REMINDER_STALE_AFTER_MINUTES || 30,
);
// Semua pengiriman keluar lewat guard ini: jeda acak, antrean serial, kuota global,
// jendela jam kirim, dan circuit breaker. Lihat lib/send-guard.js.
const sendGuard = createSendGuard({
  dataDir: DATA_DIR,
  localNow: () => {
    const current = DateTime.now().setZone(TIMEZONE);
    return { hour: current.hour, minute: current.minute };
  },
});
let activeClient = null;
let clientReady = false;
let lastClientReadyAt = null;
let lastDisconnectedAt = null;
let lastDisconnectReason = null;
let lastBreakerTrips = 0;
const lastAckByMessageId = new Map();
const adminLoginAttempts = new Map();
let reminderLoopRunning = false;
let lastCleanupDate = null;
const rateLimitState = new Map();
const adminSessions = new Map();
const deleteConfirmState = new Map();
const editConfirmState = new Map();
const ACTION_CONFIRM_WINDOW_MS = 5 * 60 * 1000;
// WhatsApp Web bisa mengirim event message yang sama dua kali saat sesi reconnect
// (binding halaman ter-inject dua kali). Simpan id pesan yang sudah diproses sebentar
// supaya balasan bot tidak terkirim dobel.
const processedMessageIds = new Map();
const PROCESSED_MESSAGE_TTL_MS = 5 * 60 * 1000;

const QUESTIONS = [
  { field: "name", text: "Halo, aku RemindCare. Boleh tahu nama Ibu? \u{1F60A}" },
  { field: "age", text: "Usia berapa? 🎂" },
  { field: "pregnancy_number", text: "Kehamilan ke berapa? 🤰" },
  {
    field: "hpht",
    text: "HPHT (Hari Pertama Haid Terakhir) kapan? Format tanggal-bulan-tahun, contoh: 31-01-2024 📅",
  },
  {
    field: "routine_meds",
    text: "Apakah rutin mengkonsumsi obat? (ya/tidak) 💊",
    type: "yesno",
  },
  {
    field: "tea",
    text: "Masih mengkonsumsi teh? (ya/tidak) 🍵",
    type: "yesno",
  },
  {
    field: "reminder_person",
    text: "Siapa yang biasanya mengingatkan Ibu untuk minum obat? \u{1F465}",
  },
  {
    field: "allow_remindcare",
    text: "Mau diingatkan RemindCare untuk minum obat? (ya/tidak) 🔔",
    type: "yesno",
  },
  {
    field: "reminder_time",
    text: "RemindCare bakal mengingatkan tiap hari lewat WhatsApp. Mau diingatkan setiap jam berapa? (format 24 jam, contoh 17:00) ⏰",
    type: "time",
  },
];

const DELIVERY_QUESTIONS = [
  {
    field: "delivery_date",
    text: "Tanggal melahirkan kapan? (contoh: 31-01-2026)",
    type: "date",
  },
  {
    field: "delivery_time",
    text: "Jam melahirkan pukul berapa? (format 24 jam, contoh: 14:30)",
    type: "time",
  },
  {
    field: "delivery_place",
    text: "Tempat melahirkan di mana? (rumah/puskesmas/klinik/rumah sakit)",
  },
  {
    field: "delivery_birth_attendant",
    text: "Siapa penolong persalinannya? (contoh: bidan/dokter)",
  },
  {
    field: "delivery_with_complication",
    text: "Apakah persalinan dengan penyulit? (ya/tidak)",
    type: "yesno",
  },
  {
    field: "baby_gender",
    text: "Jenis kelamin bayi apa? (laki-laki/perempuan)",
  },
  {
    field: "baby_birth_weight",
    text: "Berat badan bayi saat lahir berapa gram? (contoh: 3200 gram)",
    type: "weight_gram",
  },
  {
    field: "mother_current_complaint",
    text: "Apakah ada keluhan Ibu saat ini? (jika tidak ada, tulis: tidak ada)",
  },
];

const LABOR_PHASE_MESSAGES = {
  37: "Minggu ke-37: Ini fase awal aterm. Tetap tenang, istirahat cukup, dan perhatikan kontraksi teratur.",
  38: "Minggu ke-38: Ini fase persiapan akhir. Pastikan perlengkapan persalinan siap dan pendamping mudah dihubungi.",
  39: "Minggu ke-39: Ini fase menunggu persalinan aktif. Pantau gerakan janin dan tanda mulas yang makin teratur.",
  40: "Minggu ke-40: Ini fase HPL. Sebagian ibu melahirkan tepat HPL, sebagian sedikit sebelum/sesudah HPL.",
  41: "Minggu ke-41: Ini fase pemantauan lanjutan. Tetap kontrol sesuai anjuran tenaga kesehatan dan waspadai tanda bahaya.",
};

const POSTPARTUM_VISIT_SCHEDULES = [
  {
    code: "KFKN1",
    kind: "KF + KN",
    label: "KF/KN 1",
    startHours: 6,
    endHours: 48,
    windowText: "6 jam - 2 hari (48 jam) pasca persalinan",
    focusText:
      "Ibu: cegah perdarahan, deteksi infeksi, cek rahim & tekanan darah. Bayi: cek napas, suhu/kehangatan, tali pusat, dan menyusu dini.",
  },
  {
    code: "KFKN2",
    kind: "KF + KN",
    label: "KF/KN 2",
    startHours: 72,
    endHours: 168,
    windowText: "3 - 7 hari pasca persalinan",
    focusText:
      "Ibu: pastikan ASI/laktasi lancar dan tidak ada bahaya nifas. Bayi: pantau infeksi, kuning, berat badan, dan kemampuan menyusu.",
  },
  {
    code: "KFKN3",
    kind: "KF + KN",
    label: "KF/KN 3",
    startHours: 192,
    endHours: 672,
    windowText: "8 - 28 hari pasca persalinan",
    focusText:
      "Ibu: pemulihan fisik dan konseling KB pascasalin. Bayi: pantau pertumbuhan, kenaikan berat badan, dan dukungan ASI eksklusif.",
  },
  {
    code: "KF4",
    kind: "KF",
    label: "KF 4",
    startHours: 696,
    endHours: 1008,
    windowText: "29 - 42 hari pasca persalinan",
    focusText:
      "Pemeriksaan kesehatan umum akhir masa nifas dan pemantapan metode KB.",
  },
];

const POSTPARTUM_VISIT_BY_CODE = new Map(
  POSTPARTUM_VISIT_SCHEDULES.map((item) => [item.code, item]),
);
const LEGACY_POSTPARTUM_VISIT_GROUPS = [
  { code: "KFKN1", legacyCodes: ["KF1", "KN1"] },
  { code: "KFKN2", legacyCodes: ["KF2", "KN2"] },
  { code: "KFKN3", legacyCodes: ["KF3", "KN3"] },
];

const REMINDER_TEMPLATES = [
  "Pengingat hari ini: tablet FE diminum ya, Bu. \u{1F48A}",
  "Saatnya tablet FE hari ini. \u{1F48A}",
  "Jangan lupa tablet FE hari ini, tubuh sedang butuh zat besi. \u{1F48A}",
  "Tablet FE hari ini diminum setelah makan ya. \u{1F48A}",
  "Sudah sempat minum tablet FE hari ini, Bu? \u{1F48A}",
  "Pengingat tablet FE hari ini, diminum ya. \u{1F48A}",
  "Tablet FE membantu mencegah anemia, jadi diminum hari ini ya. \u{1F48A}",
  "Ayo minum tablet FE hari ini ya, Bu. \u{1F48A}",
  "Ini pengingat tablet FE hari ini. \u{1F48A}",
  "Tablet FE hari ini diminum dulu ya sebelum aktivitas. \u{1F48A}",
];

function findBrowserExecutable() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 =
    process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  const candidates = [
    // Chrome/Edge asli yang terpasang jauh lebih baik daripada Chromium unduhan Puppeteer.
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(
      programFilesX86,
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Chromium", "Application", "chrome.exe"),
    path.join(programFilesX86, "Chromium", "Application", "chrome.exe"),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function detectChromeMajor(executablePath) {
  if (!executablePath) {
    return null;
  }
  try {
    const { execFileSync } = require("child_process");
    const output = execFileSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const match = String(output).match(/(\d+)\.\d+\.\d+\.\d+/);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

// User-Agent harus sesuai browser yang benar-benar dijalankan. Bawaan library adalah
// macOS Chrome/101 (versi 2022) sementara proses di sini headless di mesin lain,
// dan ketidakcocokan itu sendiri adalah jejak automation.
function buildUserAgent(executablePath) {
  const major = detectChromeMajor(executablePath);
  if (!major) {
    return null;
  }
  if (process.platform === "win32") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  if (process.platform === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Dua proses yang berbagi .wwebjs_auth/session membuat WhatsApp melihat dua sesi untuk
// nomor yang sama; sesi bisa di-invalidate paksa, dan itu pemicu tinjauan akun.
const LOCK_PATH = path.join(DATA_DIR, "bot.lock");

function acquireInstanceLock() {
  ensureDataDir();
  try {
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return;
  } catch (err) {
    let stale = false;
    try {
      const pid = Number(String(fs.readFileSync(LOCK_PATH, "utf8")).trim());
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid, 0);
      }
    } catch (checkErr) {
      stale = true;
    }
    if (!stale) {
      throw new Error(
        `Instance lain sudah berjalan (${LOCK_PATH}). Hentikan proses itu dulu.`,
      );
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid), "utf8");
    console.warn("Lock instance basi ditemukan dan dipakai ulang.");
  }
}

function releaseInstanceLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch (err) {
    // Lock sudah tidak ada, tidak perlu tindakan.
  }
}

const MAX_INIT_ATTEMPTS = Number(process.env.WA_INIT_MAX_ATTEMPTS || 10);

async function initClientWithRetry(client, attempt = 1) {
  try {
    await client.initialize();
  } catch (err) {
    console.error(`Gagal menginisialisasi WhatsApp (percobaan ${attempt}):`, err);
    if (attempt >= MAX_INIT_ATTEMPTS) {
      console.error("Menyerah menginisialisasi WhatsApp. Periksa sesi dan jaringan.");
      return;
    }
    const delayMs = Math.min(15 * 60 * 1000, 30000 * 2 ** (attempt - 1));
    setTimeout(() => initClientWithRetry(client, attempt + 1), delayMs);
  }
}

function resolveClient(candidate) {
  // Jangan mengirim sebelum WhatsApp Web benar-benar siap: percobaan kirim di detik
  // awal pairing berubah menjadi error storm serentak untuk semua user.
  if (!clientReady || !sendGuard.isReady()) {
    return null;
  }
  if (candidate && typeof candidate.sendMessage === "function") {
    return candidate;
  }
  if (activeClient && typeof activeClient.sendMessage === "function") {
    return activeClient;
  }
  return null;
}

function normalizeWaIdInput(input) {
  if (!input) {
    return null;
  }
  const trimmed = String(input).trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("@")) {
    return trimmed;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  return `${digits}@c.us`;
}

// Satu ibu bisa muncul sebagai dua alamat berbeda: nomor (@c.us) dan alamat
// perangkat (@lid). Tanpa penyatuan, allowlist bisa meleset dan pengingat bisa
// dikirim dua kali ke orang yang sama. Tabel alias menyimpan pemetaan itu.
async function ensureAliasTable(db) {
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS user_aliases (
      alias TEXT PRIMARY KEY,
      canonical TEXT NOT NULL,
      first_seen TEXT,
      last_seen TEXT
    )`,
  );
}

async function getCanonicalWaId(db, waId) {
  if (!waId) {
    return waId;
  }
  const row = await dbGet(db, "SELECT canonical FROM user_aliases WHERE alias = ?", [waId]);
  return row && row.canonical ? row.canonical : waId;
}

async function recordAlias(db, alias, canonical) {
  if (!alias || !canonical || alias === canonical) {
    return;
  }
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `INSERT INTO user_aliases (alias, canonical, first_seen, last_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical, last_seen = excluded.last_seen`,
    [alias, canonical, nowIso, nowIso],
  );
}

// Alamat cadangan untuk pengiriman: kalau alamat asal @lid gagal, coba nomor aslinya,
// dan sebaliknya. Daftar ini dibaca dari alias yang pernah tercatat.
async function getAlternateChatIds(db, waId) {
  const alternates = [];
  if (!waId || typeof waId !== "string") {
    return alternates;
  }
  const direct = await dbGet(db, "SELECT canonical FROM user_aliases WHERE alias = ?", [waId]);
  if (direct && direct.canonical && direct.canonical !== waId) {
    alternates.push(direct.canonical);
  }
  const reverse = await dbAll(
    db,
    "SELECT alias FROM user_aliases WHERE canonical = ? AND alias <> ?",
    [direct && direct.canonical ? direct.canonical : waId, waId],
  );
  for (const row of reverse || []) {
    if (row && row.alias && !alternates.includes(row.alias)) {
      alternates.push(row.alias);
    }
  }
  return alternates;
}

// Muat seluruh pemetaan alias dari DB ke cache memori saat boot. Cache ini dipakai
// pengiriman terjadwal supaya pesan ke identitas @lid (yang sendMessage-nya sering
// mengembalikan hasil kosong) tetap punya alamat cadangan tanpa menunggu pesan masuk.
async function loadAliasCache(db) {
  const rows = await dbAll(db, "SELECT alias, canonical FROM user_aliases");
  const byWaId = new Map();
  for (const row of rows || []) {
    if (!row || !row.alias || !row.canonical) {
      continue;
    }
    if (!byWaId.has(row.canonical)) {
      byWaId.set(row.canonical, []);
    }
    if (!byWaId.get(row.canonical).includes(row.alias)) {
      byWaId.get(row.canonical).push(row.alias);
    }
    if (!byWaId.has(row.alias)) {
      byWaId.set(row.alias, []);
    }
    if (!byWaId.get(row.alias).includes(row.canonical)) {
      byWaId.get(row.alias).push(row.canonical);
    }
  }
  for (const [waId, alternates] of byWaId) {
    rememberAlternates(waId, alternates);
  }
}

// Ubah alamat pengirim pesan menjadi satu identitas kanonik. Nomor asli dari kontak
// dipakai lebih dulu karena alamat @lid hanya berlaku untuk sesi perangkat.
async function resolveSenderIdentity(db, client, msg) {
  const raw = msg && msg.from ? String(msg.from) : "";
  if (!raw) {
    return { raw, waId: raw, aliases: [] };
  }
  const existing = await getCanonicalWaId(db, raw);
  if (existing !== raw) {
    return { raw, waId: existing, aliases: [raw] };
  }
  if (!raw.endsWith("@lid")) {
    return { raw, waId: raw, aliases: [] };
  }
  let numberId = null;
  try {
    const contact =
      typeof msg.getContact === "function" ? await msg.getContact() : null;
    const number = contact && contact.number ? String(contact.number).replace(/\D/g, "") : "";
    if (number) {
      numberId = `${number}@c.us`;
    }
  } catch (err) {
    console.warn("Gagal membaca kontak untuk pemetaan identitas:", err.message);
  }
  if (!numberId) {
    return { raw, waId: raw, aliases: [] };
  }
  const canonicalUser = await getUser(db, numberId);
  if (!canonicalUser) {
    return { raw, waId: raw, aliases: [numberId] };
  }
  await recordAlias(db, raw, numberId);
  return { raw, waId: numberId, aliases: [raw] };
}

function parseWaIdList(raw) {
  if (!raw) {
    return new Set();
  }
  const items = String(raw)
    .split(",")
    .map((item) => normalizeWaIdInput(item))
    .filter(Boolean);
  return new Set(items);
}

function isUnsupportedDirectTarget(chatId) {
  if (!chatId) {
    return true;
  }
  const normalized = String(chatId).trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  // WhatsApp Web kini juga memakai alamat @lid. Alamat itu sah dan dipakai apa adanya;
  // yang perlu terlihat hanyalah format asing supaya kegagalan kirim tidak menumpuk diam.
  const knownUserSuffix =
    normalized.endsWith("@c.us") || normalized.endsWith("@lid");
  if (!knownUserSuffix && normalized.includes("@")) {
    console.warn("Target dengan format id tidak dikenal:", chatId);
  }
  return (
    normalized.endsWith("@newsletter") ||
    normalized.endsWith("@broadcast") ||
    normalized.endsWith("@g.us")
  );
}

function isRateLimitEnabled() {
  return (
    Number.isFinite(MAX_MESSAGES_PER_MINUTE) && MAX_MESSAGES_PER_MINUTE > 0
  );
}

function getMaxPollResponsesPerDay() {
  return Number.isFinite(MAX_POLL_RESPONSES_PER_DAY) &&
    MAX_POLL_RESPONSES_PER_DAY > 0
    ? MAX_POLL_RESPONSES_PER_DAY
    : null;
}

function isEditDataCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return (
    /^(edit|ubah|reset)\s+(data|profil|jawaban)$/.test(normalized) ||
    /^(edit|ubah|reset)\s+data\s+(profil|diri)$/.test(normalized)
  );
}

function isEditDeliveryCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return /^(edit|ubah|reset)\s+(data\s+)?persalinan$/.test(normalized);
}

function isDeliveryCheckCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "persalinan" ||
    /^(cek|konfirmasi|status)\s+persalinan$/.test(normalized)
  );
}

function isEditMenuCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return /^(edit|ubah|reset)$/.test(normalized);
}

function isCancelCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return /^(batal|cancel)(\s+edit)?$/.test(normalized);
}

// Saat onboarding, perintah seperti start, stop, dan ubah jam sebelumnya ikut tersimpan
// sebagai jawaban pertanyaan (nama sempat terisi kata start). Perintah ini selalu dikenali.
function isReminderControlCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = String(text).trim().toLowerCase();
  return (
    /^(start|mulai|stop|berhenti|lanjut|resume)$/.test(normalized) ||
    /^(ubah|set|ganti)\s+jam(\s+\d.*)?$/.test(normalized) ||
    /^jam\s+\d{1,2}([:.]\d{1,2})?$/.test(normalized)
  );
}

function isAlwaysCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return (
    /^(help|menu|info|informasi|about|website|delete|hapus|batal|cancel)$/.test(
      normalized,
    ) ||
    isReminderControlCommand(normalized) ||
    isDeliveryCheckCommand(normalized) ||
    isEditDataCommand(normalized) ||
    isEditDeliveryCommand(normalized) ||
    isEditMenuCommand(normalized)
  );
}

function checkDeleteConfirmation(waId) {
  const nowMs = Date.now();
  const existing = deleteConfirmState.get(waId);
  if (existing && nowMs - existing < ACTION_CONFIRM_WINDOW_MS) {
    deleteConfirmState.delete(waId);
    return true;
  }
  deleteConfirmState.set(waId, nowMs);
  return false;
}

function checkEditConfirmation(waId, action) {
  const nowMs = Date.now();
  const key = `${waId}::${action}`;
  const existing = editConfirmState.get(key);
  if (existing && nowMs - existing < ACTION_CONFIRM_WINDOW_MS) {
    editConfirmState.delete(key);
    return true;
  }
  editConfirmState.set(key, nowMs);
  return false;
}

function clearPendingConfirmation(waId) {
  let cleared = false;
  if (deleteConfirmState.has(waId)) {
    deleteConfirmState.delete(waId);
    cleared = true;
  }
  const prefix = `${waId}::`;
  for (const key of editConfirmState.keys()) {
    if (key.startsWith(prefix)) {
      editConfirmState.delete(key);
      cleared = true;
    }
  }
  return cleared;
}

function checkRateLimit(waId) {
  if (!isRateLimitEnabled()) {
    return { allowed: true };
  }

  const nowMs = Date.now();
  const windowMs =
    Number.isFinite(RATE_LIMIT_WINDOW_MS) && RATE_LIMIT_WINDOW_MS > 0
      ? RATE_LIMIT_WINDOW_MS
      : 60000;
  const cooldownMs =
    Number.isFinite(RATE_LIMIT_COOLDOWN_MS) && RATE_LIMIT_COOLDOWN_MS >= 0
      ? RATE_LIMIT_COOLDOWN_MS
      : 120000;

  const state = rateLimitState.get(waId) || {
    timestamps: [],
    blockedUntil: 0,
    lastWarnedAt: 0,
  };
  if (nowMs < state.blockedUntil) {
    const shouldWarn = nowMs - state.lastWarnedAt > 10000;
    if (shouldWarn) {
      state.lastWarnedAt = nowMs;
      rateLimitState.set(waId, state);
    }
    return { allowed: false, warn: shouldWarn };
  }

  state.timestamps = state.timestamps.filter((ts) => nowMs - ts < windowMs);
  state.timestamps.push(nowMs);

  if (state.timestamps.length > MAX_MESSAGES_PER_MINUTE) {
    state.blockedUntil = nowMs + cooldownMs;
    state.lastWarnedAt = nowMs;
    rateLimitState.set(waId, state);
    return { allowed: false, warn: true };
  }

  rateLimitState.set(waId, state);
  return { allowed: true };
}

function getDisplayName(user) {
  const rawName = user && user.name ? String(user.name).trim() : "";
  return rawName ? rawName : "Bunda";
}

function getTimeGreeting(now) {
  const hour = now.hour;
  if (hour >= 4 && hour < 11) {
    return "Selamat pagi";
  }
  if (hour >= 11 && hour < 15) {
    return "Selamat siang";
  }
  if (hour >= 15 && hour < 18) {
    return "Selamat sore";
  }
  return "Selamat malam";
}

function pickReminderTemplate(user, dateKey) {
  const key = `${user && user.wa_id ? user.wa_id : ""}-${dateKey}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 2147483647;
  }
  const index =
    REMINDER_TEMPLATES.length > 0
      ? Math.abs(hash) % REMINDER_TEMPLATES.length
      : 0;
  return REMINDER_TEMPLATES[index] || "";
}

function buildReminderMessage(user, now) {
  const greeting = getTimeGreeting(now);
  const name = getDisplayName(user);
  const template = pickReminderTemplate(user, toDateKey(now));
  // Link yang sama dikirim ke banyak penerima setiap hari adalah salah satu pemicu
  // pemblokiran paling dikenal, jadi baris tautan hanya muncul sekali seminggu.
  const withArticleLink = Boolean(now && now.isValid && now.weekday === 1);
  const articleLine = withArticleLink
    ? "\nBaca artikel di remindcares.web.app"
    : "";
  return `${greeting}, ${name}.\n${template}${articleLine}`;
}

function pickPollVariant(user, dateKey) {
  const key = `${(user && user.wa_id) || ""}-${dateKey}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 2147483647;
  }
  const index =
    REMINDER_POLL_VARIANTS.length > 0
      ? Math.abs(hash) % REMINDER_POLL_VARIANTS.length
      : 0;
  return REMINDER_POLL_VARIANTS[index] || REMINDER_POLL_QUESTION;
}

function buildReminderQuestion(user, now) {
  const dateKey =
    now && now.isValid ? toDateKey(now) : toDateKey(nowWib());
  return pickPollVariant(user, dateKey);
}

function getProgramDay(user, now = nowWib()) {
  if (!user || !user.created_at) {
    return null;
  }
  const created = DateTime.fromISO(String(user.created_at), { zone: TIMEZONE });
  if (!created.isValid) {
    return null;
  }
  return Math.max(1, Math.floor(now.diff(created, "days").days) + 1);
}

function getHphtDate(user) {
  if (!user || !user.hpht_iso) {
    return null;
  }
  const parsed = DateTime.fromISO(String(user.hpht_iso), { zone: TIMEZONE });
  if (!parsed.isValid) {
    return null;
  }
  return parsed.startOf("day");
}

function getHplDate(user) {
  const hpht = getHphtDate(user);
  if (!hpht) {
    return null;
  }
  return hpht.plus({ days: HPL_DAYS_FROM_HPHT }).startOf("day");
}

function getGestationalWeek(user, now) {
  const hpht = getHphtDate(user);
  if (!hpht) {
    return null;
  }
  const diffDays = Math.floor(now.startOf("day").diff(hpht, "days").days);
  if (!Number.isFinite(diffDays) || diffDays < 0) {
    return null;
  }
  return Math.floor(diffDays / 7) + 1;
}

function formatDateId(value) {
  if (!value) {
    return "-";
  }
  const parsed =
    typeof value === "string"
      ? DateTime.fromISO(value, { zone: TIMEZONE })
      : value.setZone(TIMEZONE);
  if (!parsed || !parsed.isValid) {
    return String(value);
  }
  return parsed.setLocale("id").toFormat("dd LLLL yyyy");
}

function formatDateTimeId(value) {
  if (!value) {
    return "-";
  }
  const parsed =
    typeof value === "string"
      ? DateTime.fromISO(value, { zone: TIMEZONE })
      : value.setZone(TIMEZONE);
  if (!parsed || !parsed.isValid) {
    return String(value);
  }
  return parsed.setLocale("id").toFormat("dd LLLL yyyy HH:mm");
}

function toYesNoLabel(value) {
  if (value === 1 || value === true || String(value) === "1") {
    return "Ya";
  }
  if (value === 0 || value === false || String(value) === "0") {
    return "Tidak";
  }
  return "-";
}

function getReminderStatusLabel(user) {
  if (!user) {
    return "-";
  }
  if (user.status === "completed") {
    return "Selesai";
  }
  if (Number(user.allow_remindcare) === 1 && user.status === "active") {
    return "Aktif";
  }
  if (user.status === "paused" || Number(user.allow_remindcare) === 0) {
    return "Dijeda";
  }
  if (user.status === "onboarding") {
    return "Pendataan awal";
  }
  return String(user.status || "-");
}

function getStatusIcon(status) {
  if (status === "done") {
    return "✅";
  }
  if (status === "fail") {
    return "❌";
  }
  return "🔄";
}

function withStatusIcon(status, text) {
  return `${getStatusIcon(status)} ${text}`;
}

function buildPostpartumVisitStatusText(log, dueAt, now) {
  if (log && log.response === "Sudah") {
    return withStatusIcon(
      "done",
      `Tercapai (${formatDateTimeId(log.response_at)})`,
    );
  }
  if (log && log.response === "Belum") {
    return withStatusIcon(
      "fail",
      `Belum tercapai (${formatDateTimeId(log.response_at)})`,
    );
  }
  if (!dueAt || !dueAt.isValid) {
    return withStatusIcon("wait", "Menunggu data persalinan");
  }
  if (now < dueAt) {
    return withStatusIcon("wait", "Belum masuk jadwal");
  }
  if (log && log.sent_at) {
    return withStatusIcon("wait", "Menunggu konfirmasi");
  }
  return withStatusIcon("wait", "Menunggu pengingat");
}

function buildUserInfoMessage(user, postpartumLogs, now = nowWib()) {
  const name = getDisplayName(user);
  const hpht = getHphtDate(user);
  const hpl = getHplDate(user);
  const week = getGestationalWeek(user, now);
  const deliveryAt = getDeliveryDateTime(user);
  const today = toDateKey(now);
  const deliveryValidationActive = isDeliveryValidationActive(user, now);
  const pendingDeliveryStage = getPendingDeliveryPollStage(user);
  const deliveryConfirmed = hasConfirmedDelivery(user);
  const startWeek =
    Number.isFinite(DELIVERY_VALIDATION_START_WEEK) &&
    DELIVERY_VALIDATION_START_WEEK > 0
      ? Math.floor(DELIVERY_VALIDATION_START_WEEK)
      : 39;
  const logByCode = new Map(
    (Array.isArray(postpartumLogs) ? postpartumLogs : []).map((item) => [
      item.visit_code,
      item,
    ]),
  );

  const visitLines = [];
  let confirmedVisits = 0;
  let failedVisits = 0;
  for (let i = 0; i < POSTPARTUM_VISIT_SCHEDULES.length; i += 1) {
    const visit = POSTPARTUM_VISIT_SCHEDULES[i];
    const log = logByCode.get(visit.code) || null;
    if (log && log.response === "Sudah") {
      confirmedVisits += 1;
    } else if (log && log.response === "Belum") {
      failedVisits += 1;
    }
    const dueAt = deliveryAt ? getPostpartumDueAt(deliveryAt, visit) : null;
    const dueText = dueAt ? formatDateTimeId(dueAt) : "-";
    const statusText = buildPostpartumVisitStatusText(log, dueAt, now);
    const goalText = String(visit.focusText || "-").trim();
    visitLines.push(
      `${i + 1}. *${visit.label}* (${visit.windowText})\nJadwal: ${dueText}\nStatus: ${statusText}\nFokus: ${goalText}`,
    );
  }

  const deliveryStep = Number(user && user.delivery_data_step ? user.delivery_data_step : 0);
  const collectingDeliveryText =
    Number.isFinite(deliveryStep) && deliveryStep > 0
      ? withStatusIcon(
          "wait",
          `Sedang isi data persalinan (tahap ${deliveryStep} dari ${DELIVERY_QUESTIONS.length})`,
        )
      : withStatusIcon("done", "Data persalinan tidak sedang diisi");

  const accountStatusLabel = getReminderStatusLabel(user);
  const accountStatusText =
    accountStatusLabel === "Aktif" || accountStatusLabel === "Selesai"
      ? withStatusIcon("done", accountStatusLabel)
      : accountStatusLabel === "Dijeda"
        ? withStatusIcon("fail", accountStatusLabel)
        : withStatusIcon("wait", accountStatusLabel);

  const feReminderText =
    Number(user && user.allow_remindcare) === 1 &&
    user &&
    user.status === "active" &&
    user.reminder_time
      ? withStatusIcon("done", `Aktif setiap hari jam ${user.reminder_time} WIB`)
      : !user || !user.reminder_time
        ? withStatusIcon("wait", "Jam pengingat belum disetel")
        : withStatusIcon("fail", "Pengingat FE sedang tidak aktif");

  let deliveryReminderText = withStatusIcon("wait", "Menunggu data HPHT");
  if (deliveryConfirmed) {
    deliveryReminderText = withStatusIcon(
      "done",
      "Validasi persalinan selesai (sudah terkonfirmasi melahirkan)",
    );
  } else if (deliveryValidationActive) {
    if (pendingDeliveryStage) {
      deliveryReminderText = withStatusIcon(
        "wait",
        "Poll validasi persalinan terkirim, menunggu jawaban",
      );
    } else if (user && user.delivery_hpl_poll_sent_date === today) {
      deliveryReminderText = withStatusIcon(
        "done",
        "Poll validasi persalinan hari ini sudah dikirim",
      );
    } else {
      deliveryReminderText = withStatusIcon(
        "wait",
        "Pengingat validasi persalinan aktif, menunggu jadwal kirim",
      );
    }
  } else if (week) {
    deliveryReminderText = withStatusIcon(
      "wait",
      `Belum masuk fase validasi persalinan (minggu ${week}/${startWeek})`,
    );
  }

  let postpartumReminderText = withStatusIcon("wait", "Menunggu data persalinan");
  if (deliveryAt) {
    if (confirmedVisits === POSTPARTUM_VISIT_SCHEDULES.length) {
      postpartumReminderText = withStatusIcon(
        "done",
        "Semua target kunjungan KF/KN sudah tercapai",
      );
    } else if (failedVisits > 0) {
      postpartumReminderText = withStatusIcon(
        "fail",
        `Ada ${failedVisits} kunjungan yang belum tercapai`,
      );
    } else {
      postpartumReminderText = withStatusIcon(
        "wait",
        `Progres berjalan (${confirmedVisits}/${POSTPARTUM_VISIT_SCHEDULES.length})`,
      );
    }
  }

  const lines = [
    `*Info Penting RemindCare* - ${name}`,
    "",
    "*Status Pengingat*",
    `*Status akun:* ${accountStatusText}`,
    `*Pengingat tablet FE:* ${feReminderText}`,
    `*Pengingat validasi persalinan:* ${deliveryReminderText}`,
    `*Pengingat kunjungan KF/KN:* ${postpartumReminderText}`,
    "",
    "*Data Kehamilan*",
    `*HPHT:* ${formatDateId(hpht || (user ? user.hpht_iso : null))}`,
    `*HPL:* ${formatDateId(hpl)}`,
    `*Usia kehamilan saat ini:* ${week ? `${week} minggu` : "-"}`,
    "",
    "*Data Persalinan*",
    `*Status input persalinan:* ${collectingDeliveryText}`,
    `*Tanggal/jam persalinan:* ${deliveryAt ? formatDateTimeId(deliveryAt) : "-"}`,
    `*Tempat persalinan:* ${user && user.delivery_place ? user.delivery_place : "-"}`,
    `*Penolong persalinan:* ${
      user && user.delivery_birth_attendant ? user.delivery_birth_attendant : "-"
    }`,
    `*Penyulit persalinan:* ${
      user && user.delivery_with_complication ? user.delivery_with_complication : "-"
    }`,
    `*Jenis kelamin bayi:* ${user && user.baby_gender ? user.baby_gender : "-"}`,
    `*BB lahir bayi:* ${user && user.baby_birth_weight ? user.baby_birth_weight : "-"}`,
    "",
    "*Target & Progres Kunjungan KF/KN*",
    `*Target kunjungan:* ${POSTPARTUM_VISIT_SCHEDULES.length} kunjungan`,
    `*Progres tercapai:* ${confirmedVisits}/${POSTPARTUM_VISIT_SCHEDULES.length}`,
    "",
    "*Rincian Kunjungan*",
    ...visitLines,
    "",
    "*Catatan Harian*",
    `*Obat rutin:* ${toYesNoLabel(user ? user.routine_meds : null)}`,
    `*Konsumsi teh:* ${toYesNoLabel(user ? user.tea : null)}`,
  ];

  return lines.join("\n");
}

function buildLaborPhaseMessage(user, now) {
  if (
    user &&
    (user.delivery_hpl_response === "Sudah" ||
      user.delivery_hpl3_response === "Sudah")
  ) {
    return null;
  }
  const week = getGestationalWeek(user, now);
  if (!week || week < 37 || week > 41) {
    return null;
  }
  const template = LABOR_PHASE_MESSAGES[week];
  if (!template) {
    return null;
  }
  if (week !== 40) {
    return template;
  }
  const hpl = getHplDate(user);
  const hplText = hpl ? formatDateId(hpl) : "-";
  return `${template}\nPerkiraan HPL Ibu: ${hplText}.`;
}

function getDeliveryValidationStageDue(user, now) {
  const startWeek =
    Number.isFinite(DELIVERY_VALIDATION_START_WEEK) &&
    DELIVERY_VALIDATION_START_WEEK > 0
      ? Math.floor(DELIVERY_VALIDATION_START_WEEK)
      : 39;
  const week = getGestationalWeek(user, now);
  if (!week || week < startWeek) {
    return null;
  }
  if (hasConfirmedDelivery(user)) {
    return null;
  }

  const today = toDateKey(now.startOf("day"));
  return user.delivery_hpl_poll_sent_date === today ? null : "week39_daily";
}

function isDeliveryValidationActive(user, now) {
  const startWeek =
    Number.isFinite(DELIVERY_VALIDATION_START_WEEK) &&
    DELIVERY_VALIDATION_START_WEEK > 0
      ? Math.floor(DELIVERY_VALIDATION_START_WEEK)
      : 39;
  const week = getGestationalWeek(user, now);
  if (!week || week < startWeek) {
    return false;
  }
  return !hasConfirmedDelivery(user);
}

function getPendingDeliveryPollStage(user) {
  if (!user || !user.delivery_poll_stage) {
    return null;
  }
  if (user.delivery_poll_stage === "manual") {
    return hasConfirmedDelivery(user) ? null : "manual";
  }
  if (user.delivery_poll_stage === "week39_daily") {
    return hasConfirmedDelivery(user) ? null : "week39_daily";
  }
  if (user.delivery_poll_stage === "hpl" && !user.delivery_hpl_response) {
    return "hpl";
  }
  if (user.delivery_poll_stage === "hpl3" && !user.delivery_hpl3_response) {
    return "hpl3";
  }
  return null;
}

function buildDeliveryValidationMessage(user, now, stage) {
  const greeting = getTimeGreeting(now);
  const name = getDisplayName(user);
  if (stage === "manual") {
    return `${greeting}, ${name}.\nKami ingin memastikan apakah Ibu sudah melahirkan ya.`;
  }
  if (stage === "week39_daily") {
    const week = getGestationalWeek(user, now);
    const weekLabel = week ? `minggu ke-${week}` : "masa akhir kehamilan";
    return `${greeting}, ${name}.\nMemasuki ${weekLabel}, kami ingin memastikan apakah Ibu sudah melahirkan ya.`;
  }
  const hpl = getHplDate(user);
  const hplText = hpl ? formatDateId(hpl) : "-";
  if (stage === "hpl3") {
    return `${greeting}, ${name}.\nHari ini adalah H+3 dari HPL (${hplText}). Kami ingin memastikan kondisi Ibu ya.`;
  }
  return `${greeting}, ${name}.\nHari ini adalah HPL (${hplText}). Kami ingin memastikan kondisi Ibu ya.`;
}

function buildDeliveryValidationQuestion() {
  return DELIVERY_VALIDATION_POLL_QUESTION;
}

function parseDeliveryValidationAnswer(input) {
  if (!input) {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (
    normalized.includes("sudah melahir") ||
    normalized.includes("udah melahir")
  ) {
    return "Sudah";
  }
  if (normalized.includes("belum melahir")) {
    return "Belum";
  }
  // Pertanyaannya berbunyi apakah Ibu sudah melahirkan, jadi jawaban pendek seperti
  // sudah, belum, ya, atau tidak adalah jawaban yang sah dan tidak boleh buntu.
  if (/^(sudah|udah|ya|iya|yes|benar)$/.test(normalized)) {
    return "Sudah";
  }
  if (/^(belum|blm|tidak|tdk|no|nggak|engga)$/.test(normalized)) {
    return "Belum";
  }
  return null;
}

function getDeliveryDateTime(user) {
  if (!user || !user.delivery_date_iso || !user.delivery_time) {
    return null;
  }
  const parsed = DateTime.fromISO(
    `${String(user.delivery_date_iso).trim()}T${String(user.delivery_time).trim()}`,
    { zone: TIMEZONE },
  );
  if (!parsed.isValid) {
    return null;
  }
  return parsed;
}

function validateDeliveryDateIso(deliveryDateIso, user, now = nowWib()) {
  if (!deliveryDateIso) {
    return { valid: false, message: "Tanggal melahirkan belum valid." };
  }
  const deliveryDate = DateTime.fromISO(String(deliveryDateIso), {
    zone: TIMEZONE,
  }).startOf("day");
  if (!deliveryDate.isValid) {
    return { valid: false, message: "Tanggal melahirkan belum valid." };
  }
  if (deliveryDate > now.startOf("day")) {
    return {
      valid: false,
      message: "Tanggal melahirkan tidak boleh lebih dari hari ini.",
    };
  }
  const hpht = getHphtDate(user);
  if (hpht && deliveryDate < hpht.startOf("day")) {
    return {
      valid: false,
      message: "Tanggal melahirkan tidak boleh sebelum tanggal HPHT.",
    };
  }
  return { valid: true, message: "" };
}

function validateDeliveryDateTime(
  user,
  deliveryDateIso,
  deliveryTime,
  now = nowWib(),
) {
  if (!deliveryDateIso || !deliveryTime) {
    return { valid: false, message: "Tanggal/jam melahirkan belum lengkap." };
  }
  const deliveryAt = getDeliveryDateTime({
    delivery_date_iso: deliveryDateIso,
    delivery_time: deliveryTime,
  });
  if (!deliveryAt) {
    return {
      valid: false,
      message: "Tanggal atau jam melahirkan belum valid.",
    };
  }
  const baseDateCheck = validateDeliveryDateIso(deliveryDateIso, user, now);
  if (!baseDateCheck.valid) {
    return baseDateCheck;
  }
  if (deliveryAt > now.plus({ minutes: 10 })) {
    return {
      valid: false,
      message: "Jam melahirkan tidak boleh di masa depan.",
    };
  }
  const hpht = getHphtDate(user);
  if (hpht && deliveryAt < hpht.startOf("day")) {
    return {
      valid: false,
      message: "Tanggal/jam melahirkan tidak boleh sebelum HPHT.",
    };
  }
  return { valid: true, message: "" };
}

function hasConfirmedDelivery(user) {
  if (!user) {
    return false;
  }
  const hplResponse = String(user.delivery_hpl_response || "")
    .trim()
    .toLowerCase();
  const hpl3Response = String(user.delivery_hpl3_response || "")
    .trim()
    .toLowerCase();
  if (hplResponse === "sudah" || hpl3Response === "sudah") {
    return true;
  }
  if (user.delivery_data_completed_at) {
    return true;
  }
  const deliveryStep = Number(user.delivery_data_step || 0);
  return Number.isFinite(deliveryStep) && deliveryStep > 0;
}

function isPostpartumMonitoringActive(user) {
  return Boolean(
    user &&
    user.delivery_data_completed_at &&
    user.delivery_date_iso &&
    user.delivery_time,
  );
}

function getPostpartumDueAt(deliveryAt, visit) {
  if (!deliveryAt || !deliveryAt.isValid || !visit) {
    return null;
  }
  return deliveryAt.plus({ hours: visit.startHours });
}

function buildPostpartumEducationMessage(user, now) {
  const name = getDisplayName(user);
  return `Selamat atas kelahiran buah hati, ${name}. 🤍\nRemindCare akan terus menemani Ibu sampai masa krusial ini selesai.\nMasa nifas dan masa neonatal adalah masa yang sangat penting bagi ibu dan bayi. Pada periode ini, risiko gangguan kesehatan masih tinggi sehingga pemantauan rutin sangat diperlukan untuk memastikan ibu dan bayi dalam kondisi sehat.\nRemindCare akan mengingatkan jadwal kunjungan KF dan KN sesuai waktu yang dianjurkan.\nBaca artikel lanjutan di: ${DELIVERY_ARTICLE_URL}`;
}

function buildPostpartumVisitMessage(user, visit) {
  const greeting = getTimeGreeting(nowWib());
  const name = getDisplayName(user);
  const focusText = String(visit.focusText || "").trim();
  const formattedFocus = focusText.replace(/\. Bayi:/, ".\n- Bayi:");
  return `${greeting}, ${name}. 👩‍🍼\nPengingat kunjungan ${visit.label} (${visit.kind}). 📅\nRentang waktu: ${visit.windowText}.\nFokus kunjungan:\n- ${formattedFocus}\nYuk periksa ke tenaga kesehatan/fasilitas kesehatan ya. 🏥\nBaca artikel lanjutan di: ${DELIVERY_ARTICLE_URL}`;
}

function buildPostpartumVisitQuestion(visit) {
  return `Apakah Ibu sudah melakukan kunjungan ${visit.label}?`;
}

function previewOf(value, fallback = "[pesan]") {
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  if (value && typeof value === "object") {
    const name = value.pollName || value.name || value.question;
    if (typeof name === "string" && name) {
      return `[poll] ${name}`;
    }
  }
  return fallback;
}

// WhatsApp Web kini sering mengirim pesan dari alamat @lid, dan pengiriman balik
// ke @lid itu sendiri kerap menghasilkan hasil kosong. Kontrak di sini tetap sama
// seperti panggilan mentah: objek pesan saat benar-benar terkirim, null saat gagal.
// Tidak ada lagi id buatan sendiri, karena id palsu membuat vote poll tidak pernah
// cocok dengan pesan tersimpan dan membuat sistem mengira poll sudah terkirim.
// Id asli WhatsApp selalu memuat alamat JID (misalnya "true_62812...@c.us_3EB0...").
// Nilai lain dianggap bukan bukti pengiriman, sehingga tidak boleh dicatat sebagai terkirim.
function isRealSentMessage(result) {
  const serialized = result && result.id ? String(result.id._serialized || "") : "";
  return serialized.includes("@");
}

// Alamat cadangan terakhir yang diketahui per identitas, dipakai balasan percakapan
// supaya balasan tidak hilang hanya karena alamat asal @lid menolak pengiriman.
const identityAlternates = new Map();

function rememberAlternates(waId, alternates) {
  if (!waId || !Array.isArray(alternates) || alternates.length === 0) {
    return;
  }
  identityAlternates.set(waId, alternates.slice());
}

function chatIdCandidates(chatId, alternates) {
  const known = identityAlternates.get(chatId) || [];
  const merged = [];
  for (const item of [...(Array.isArray(alternates) ? alternates : []), ...known]) {
    if (typeof item === "string" && item && item !== chatId && !merged.includes(item)) {
      merged.push(item);
    }
  }
  alternates = merged;
  const list = [chatId];
  for (const alt of Array.isArray(alternates) ? alternates : []) {
    if (typeof alt === "string" && alt && !list.includes(alt)) {
      list.push(alt);
    }
  }
  return list;
}

async function deliverMessage(resolved, chatId, payload, alternates) {
  const candidates = chatIdCandidates(chatId, alternates);
  for (const target of candidates) {
    if (isUnsupportedDirectTarget(target)) {
      continue;
    }
    let result = null;
    try {
      result = await resolved.sendMessage(target, payload, { sendSeen: false });
    } catch (err) {
      console.warn("Kirim gagal ke", target, ":", err && err.message ? err.message : err);
      continue;
    }
    if (isRealSentMessage(result)) {
      if (target !== chatId) {
        console.warn("Kirim berhasil lewat identitas cadangan:", chatId, "->", target);
      }
      return result;
    }
  }
  return null;
}

function sendText(client, chatId, text, sendOptions = {}) {
  const resolved = resolveClient(client);
  if (!resolved) {
    console.error("Client belum siap untuk mengirim pesan.");
    return null;
  }
  if (isUnsupportedDirectTarget(chatId)) {
    console.warn("Lewati kirim pesan ke target non-user:", chatId);
    return null;
  }
  return sendGuard.send(
    () => deliverMessage(resolved, chatId, text, sendOptions.alternates),
    {
      kind: sendOptions.kind,
      label: chatId,
      preview: previewOf(text),
    },
  );
}

function sendPoll(client, chatId, poll, sendOptions = {}) {
  const resolved = resolveClient(client);
  if (!resolved) {
    console.error("Client belum siap untuk mengirim pesan.");
    return null;
  }
  if (isUnsupportedDirectTarget(chatId)) {
    console.warn("Lewati kirim polling ke target non-user:", chatId);
    return null;
  }
  return sendGuard.send(
    () => deliverMessage(resolved, chatId, poll, sendOptions.alternates),
    {
      kind: sendOptions.kind,
      label: chatId,
      preview: previewOf(poll, "[poll]"),
    },
  );
}

function nowWib() {
  return DateTime.now().setZone(TIMEZONE);
}

function toDateKey(dt) {
  return dt.toFormat("yyyy-LL-dd");
}

function getRetryDelayMs(failCount) {
  const base =
    Number.isFinite(POLL_RETRY_BASE_DELAY_MS) && POLL_RETRY_BASE_DELAY_MS > 0
      ? POLL_RETRY_BASE_DELAY_MS
      : 5 * 60 * 1000;
  const capped =
    Number.isFinite(POLL_RETRY_MAX_DELAY_MS) && POLL_RETRY_MAX_DELAY_MS > 0
      ? POLL_RETRY_MAX_DELAY_MS
      : 30 * 60 * 1000;
  const safeFailCount =
    Number.isFinite(Number(failCount)) && Number(failCount) > 0
      ? Number(failCount)
      : 0;
  if (safeFailCount <= 0) {
    return 0;
  }
  const delay = base * 2 ** (safeFailCount - 1);
  return delay > capped ? capped : delay;
}

function canAttemptByBackoff(lastAttemptAt, failCount, now = nowWib()) {
  const safeFailCount =
    Number.isFinite(Number(failCount)) && Number(failCount) > 0
      ? Number(failCount)
      : 0;
  if (safeFailCount <= 0) {
    return true;
  }
  if (!lastAttemptAt) {
    return true;
  }
  const attemptedAt = DateTime.fromISO(String(lastAttemptAt), {
    zone: TIMEZONE,
  });
  if (!attemptedAt.isValid) {
    return true;
  }
  const delayMs = getRetryDelayMs(safeFailCount);
  return now.toMillis() - attemptedAt.toMillis() >= delayMs;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function writePasswordFile(passwordFile, password) {
  fs.writeFileSync(passwordFile, password, {
    encoding: "utf8",
    mode: PASSWORD_FILE_MODE,
  });
  try {
    fs.chmodSync(passwordFile, PASSWORD_FILE_MODE);
  } catch (err) {
    console.warn("Gagal mengatur izin file password admin:", err.message);
  }
}

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString("hex");
}

function getAdminPasswordConfig() {
  ensureDataDir();
  if (ADMIN_WEB_PASSWORD) {
    return { password: ADMIN_WEB_PASSWORD, source: "env", filePath: null };
  }
  const passwordFile = path.join(DATA_DIR, "admin_web_password.txt");
  if (fs.existsSync(passwordFile)) {
    try {
      fs.chmodSync(passwordFile, PASSWORD_FILE_MODE);
    } catch (err) {
      console.warn("Gagal mengatur izin file password admin:", err.message);
    }
    const stored = fs.readFileSync(passwordFile, "utf8").trim();
    if (stored) {
      return { password: stored, source: "file", filePath: passwordFile };
    }
  }
  const randomPart = crypto
    .randomBytes(18)
    .toString("base64")
    .replace(/[+/=]/g, "");
  const generated = `Rc-${randomPart}`;
  writePasswordFile(passwordFile, generated);
  return { password: generated, source: "generated", filePath: passwordFile };
}

function parseCookies(header) {
  const cookies = {};
  if (!header) {
    return cookies;
  }
  const parts = header.split(";");
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.split("=");
    if (!rawKey) {
      continue;
    }
    const key = rawKey.trim();
    const value = rawValue.join("=").trim();
    if (!key) {
      continue;
    }
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function isPasswordMatch(input, expected) {
  if (!input || !expected) {
    return false;
  }
  const inputBuffer = Buffer.from(String(input));
  const expectedBuffer = Buffer.from(String(expected));
  if (inputBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

// Sumber kebenaran pemeriksaan password: hash scrypt di tabel settings kalau ada.
// File plaintext hanya catatan operator (mode 600), bukan satu-satunya penyimpan.
async function ensureAdminPasswordHash(db, passwordConfig) {
  const existing = await getSetting(db, "admin_password_hash", null);
  const existingSalt = await getSetting(db, "admin_password_hash_salt", null);
  if (
    existing &&
    existingSalt &&
    isPasswordMatch(scryptHash(passwordConfig.password, existingSalt), existing)
  ) {
    return;
  }
  // Hash lama tidak cocok lagi (password diputar ulang), jadi hash ikut diperbarui.
  const salt = crypto.randomBytes(16).toString("hex");
  await setSetting(db, "admin_password_hash_salt", salt);
  await setSetting(db, "admin_password_hash", scryptHash(passwordConfig.password, salt));
}

async function verifyAdminPassword(db, input, passwordConfig) {
  const hash = await getSetting(db, "admin_password_hash", null);
  const salt = await getSetting(db, "admin_password_hash_salt", null);
  if (hash && salt) {
    return isPasswordMatch(scryptHash(input, salt), hash);
  }
  return isPasswordMatch(input, passwordConfig.password);
}

function clientIp(req) {
  if (ADMIN_WEB_TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// Percobaan login gagal berulang adalah jalan masuk paling umum untuk panel yang
// memuat data kesehatan, jadi batasi per alamat IP.
function checkAdminLoginAllowed(ip, nowMs = Date.now()) {
  const entry = adminLoginAttempts.get(ip);
  if (!entry) {
    return { allowed: true };
  }
  entry.stamps = entry.stamps.filter(
    (ts) => nowMs - ts < ADMIN_LOGIN_WINDOW_MS,
  );
  if (entry.stamps.length >= ADMIN_LOGIN_MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterMs:
        ADMIN_LOGIN_WINDOW_MS - (nowMs - entry.stamps[0]),
    };
  }
  return { allowed: true };
}

function registerAdminLoginFailure(ip, username, nowMs = Date.now()) {
  const entry = adminLoginAttempts.get(ip) || { stamps: [] };
  entry.stamps.push(nowMs);
  adminLoginAttempts.set(ip, entry);
  console.warn(
    `Login admin gagal dari ${ip} (user: ${username || "-"}), percobaan dalam jendela: ${entry.stamps.length}`,
  );
}

function clearAdminLoginFailures(ip) {
  adminLoginAttempts.delete(ip);
}

function createAdminSession() {
  const token = crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, "");
  const csrf = crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, "");
  const ttl =
    Number.isFinite(ADMIN_WEB_SESSION_TTL_MS) && ADMIN_WEB_SESSION_TTL_MS > 0
      ? ADMIN_WEB_SESSION_TTL_MS
      : 8 * 60 * 60 * 1000;
  // token ikut disimpan supaya logout bisa mencabut sesi ini di sisi server
  adminSessions.set(token, { expiresAt: Date.now() + ttl, csrf, token });
  return { token, csrf };
}

function destroyAdminSession(token) {
  if (token) {
    adminSessions.delete(token);
  }
}

function getAdminSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.rc_admin;
  if (!token) {
    return null;
  }
  const session = adminSessions.get(token);
  if (!session) {
    return null;
  }
  if (session.expiresAt && Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}

function setAdminCookie(res, token) {
  const ttlMs =
    Number.isFinite(ADMIN_WEB_SESSION_TTL_MS) && ADMIN_WEB_SESSION_TTL_MS > 0
      ? ADMIN_WEB_SESSION_TTL_MS
      : 8 * 60 * 60 * 1000;
  const maxAgeSeconds = Math.floor(ttlMs / 1000);
  const expires = new Date(Date.now() + ttlMs).toUTCString();
  const parts = [
    `rc_admin=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${expires}`,
  ];
  if (ADMIN_WEB_COOKIE_SECURE) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminCookie(res) {
  const parts = [
    "rc_admin=",
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (ADMIN_WEB_COOKIE_SECURE) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// JSON.stringify tidak meng-escape karakter kurung sudut, sehingga nilai apa pun yang
// masuk ke blok <script> bisa menutup tag lalu menyuntik kode (XSS).
function escapeForScriptContext(value) {
  return JSON.stringify(value === null || value === undefined ? "" : String(value))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function renderAdminLoginPage(message, options = {}) {
  const nonce = options && options.nonce ? String(options.nonce) : "";
  const alert = message ? `<div class="banner" role="alert">${icon("alert")}<p>${escapeHtml(message)}</p></div>` : "";
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Masuk - RemindCare Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style nonce="${nonce}">${ADMIN_CSS}
      main.login { min-height: 100dvh; display: grid; place-items: center; padding: 20px; }
      .login-card { width: 100%; max-width: 360px; }
      .login-card .panel-body { display: grid; gap: 12px; padding: 14px; }
      .login-card h1 { font-size: 14px; }
    </style>
  </head>
  <body>
    <main class="login">
      <div class="login-card">
        <div class="panel">
          <div class="panel-head">
            <h2>${icon("pulse")}RemindCare Admin</h2>
            <span class="badge">panel internal</span>
          </div>
          <div class="panel-body">
            ${alert}
            <form method="post" action="/admin/login">
              <div class="field">
                <label for="login-username">Username</label>
                <input id="login-username" name="username" type="text" autocomplete="username" placeholder="admin">
              </div>
              <div class="field" style="margin-top:10px">
                <label for="login-password">Password</label>
                <input id="login-password" name="password" type="password" autocomplete="current-password" required>
              </div>
              <button type="submit" class="btn-primary" style="margin-top:12px;width:100%">${icon("logout")}Masuk</button>
            </form>
          </div>
        </div>
      </div>
    </main>
  </body>
</html>`;
}

function renderAdminDashboardPage(options = {}) {
  const nonce = options && options.nonce ? String(options.nonce) : "";
  const csrf = options && options.csrf ? String(options.csrf) : "";
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="${csrf}">
    <title>RemindCare Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style nonce="${nonce}">${ADMIN_CSS}
      .kv.kv-6 > div { border-top: none; }
      .modes { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 12px 12px; }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">
        ${icon("pulse")}
        <h1>RemindCare</h1>
        <span class="tag">admin pengingat</span>
      </div>
      <div class="row">
        <span class="muted num" id="last-updated">memuat</span>
        <button type="button" id="refresh-btn">${icon("refresh")}Muat ulang</button>
        <a class="btn" href="/admin/settings">${icon("sliders")}Pengaturan</a>
        <details class="pop">
          <summary class="btn">${icon("download")}Ekspor</summary>
          <div class="panel">
            <a href="/admin/api/export/users.csv" download>${icon("download")}Data user</a>
            <a href="/admin/api/export/reminder_logs.csv" download>${icon("download")}Catatan pengingat</a>
            <a href="/admin/api/export/postpartum_logs.csv" download>${icon("download")}Catatan nifas</a>
          </div>
        </details>
        <form method="post" action="/admin/logout">
          <input type="hidden" name="_csrf" value="${csrf}">
          <button type="submit" class="btn-icon" aria-label="Keluar dari panel admin" title="Keluar">${icon("logout")}</button>
        </form>
      </div>
    </header>

    <div class="wrap">
      <div class="banner" id="error-banner" role="alert" hidden>
        ${icon("alert")}
        <p id="error-text"></p>
        <button type="button" id="error-retry">${icon("rotate")}Coba lagi</button>
      </div>

      <section class="panel" id="status-panel" aria-labelledby="status-title">
        <div class="panel-head">
          <h2 id="status-title">${icon("plug")}Status bot</h2>
          <span class="badge" id="status-badge">memuat</span>
        </div>
        <dl class="kv kv-6">
          <div><dt>Sesi WhatsApp</dt><dd id="fact-client">-</dd></div>
          <div><dt>Siap sejak</dt><dd id="fact-ready">-</dd></div>
          <div><dt>Jendela kirim</dt><dd id="fact-window">-</dd></div>
          <div><dt>Kuota hari ini</dt><dd id="fact-quota" class="num">-</dd></div>
          <div><dt>Terkirim</dt><dd id="fact-sent" class="num">-</dd></div>
          <div><dt>Gagal</dt><dd id="fact-failed" class="num">-</dd></div>
        </dl>
        <div class="modes" id="status-chips"></div>
        <p class="note" id="status-note" role="status" aria-live="polite" style="padding:0 12px 12px;margin:0" hidden></p>
      </section>

      <section class="panel" aria-labelledby="action-title">
        <div class="panel-head">
          <h2 id="action-title">${icon("alert")}Perlu tindakan</h2>
          <span class="badge" id="action-count">memuat</span>
        </div>
        <ul class="tasks" id="action-list">
          <li class="empty">Memuat.</li>
        </ul>
      </section>

      <section class="panel" aria-labelledby="today-title">
        <div class="panel-head">
          <h2 id="today-title">${icon("clock")}Hari ini</h2>
          <span class="muted" id="today-date"></span>
        </div>
        <div class="metrics">
          <div class="metric"><div class="k">Menunggu jawaban</div><div class="v" id="today-waiting">-</div></div>
          <div class="metric"><div class="k">Dijawab sudah</div><div class="v" id="today-sudah">-</div></div>
          <div class="metric"><div class="k">Dijawab belum</div><div class="v" id="today-belum">-</div></div>
          <div class="metric"><div class="k">Tidak terkirim</div><div class="v" id="today-blocked">-</div></div>
        </div>
      </section>

      <section class="panel" aria-labelledby="users-title">
        <div class="panel-head">
          <h2 id="users-title">${icon("users")}User</h2>
          <div class="row">
            <span class="search-wrap">${icon("search")}<input id="users-search" class="search" type="search" autocomplete="off" aria-label="Cari nama atau nomor WhatsApp" placeholder="Cari nama atau nomor"></span>
            <div class="seg" role="group" aria-label="Filter fase">
              <button type="button" class="phase-filter" data-phase-filter="all" aria-pressed="true">Semua</button>
              <button type="button" class="phase-filter" data-phase-filter="onboarding" aria-pressed="false">Onboarding</button>
              <button type="button" class="phase-filter" data-phase-filter="kehamilan" aria-pressed="false">Kehamilan</button>
              <button type="button" class="phase-filter" data-phase-filter="persalinan" aria-pressed="false">Persalinan</button>
              <button type="button" class="phase-filter" data-phase-filter="pasca_kehamilan" aria-pressed="false">Nifas</button>
            </div>
          </div>
        </div>
        <p class="note" id="users-note" hidden style="padding:10px 12px 0"></p>
        <div class="table-wrap">
          <table>
            <caption id="users-count">memuat</caption>
            <thead>
              <tr>
                <th scope="col">Nama</th>
                <th scope="col">Fase</th>
                <th scope="col">Status</th>
                <th scope="col">Jam</th>
                <th scope="col">Jawaban terakhir</th>
                <th scope="col">Progres</th>
              </tr>
            </thead>
            <tbody id="users-body" aria-busy="true">
              <tr><td colspan="6" class="muted">Memuat.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel" aria-labelledby="logs-title">
        <div class="panel-head">
          <h2 id="logs-title">${icon("list")}Catatan pengingat</h2>
          <button type="button" id="logs-toggle">${icon("list")}Tampilkan 50</button>
        </div>
        <p class="note" id="logs-note" hidden style="padding:10px 12px 0"></p>
        <ul class="feed" id="logs-body" aria-busy="true">
          <li class="empty">Memuat.</li>
        </ul>
      </section>
    </div>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>

    <script nonce="${nonce}">
      const CSRF_TOKEN = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
      function csrfHeaders(extra) { return Object.assign({ 'X-CSRF-Token': CSRF_TOKEN }, extra || {}); }
      const ICON_LINK = '${icon("link", 14)}';
      const ICON_CHECK_BUTTON = '${icon("check", 14)}';
      const ICON_SHIELD_BUTTON = '${icon("shield", 14)}';
      const ICON_ROTATE_BUTTON = '${icon("rotate", 14)}';
      const toast = document.getElementById('toast');
      function showToast(text) {
        toast.textContent = text;
        toast.classList.add('show');
        clearTimeout(window.__toastTimer);
        window.__toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
      }
      function fmt(v) { return v === null || v === undefined || v === '' ? '-' : v; }
      function fmtDt(v) {
        if (!v) return '-';
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      }
      function clampPct(v) { return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0; }
      function classifyPhase(user) {
        if (Number(user.postpartum_total || 0) > 0 || user.delivery_date_iso) return 'pasca_kehamilan';
        const labor = Number(user.delivery_data_step || 0) > 0 || !!user.delivery_poll_stage || !!user.delivery_hpl_poll_sent_date ||
          !!user.delivery_hpl3_poll_sent_date || user.delivery_hpl_response === 'Sudah' || user.delivery_hpl3_response === 'Sudah';
        if (labor) return 'persalinan';
        if (user.status === 'onboarding' || !user.hpht_iso) return 'onboarding';
        return 'kehamilan';
      }
      const PHASE_LABEL = { onboarding: 'Onboarding', kehamilan: 'Kehamilan', persalinan: 'Persalinan', pasca_kehamilan: 'Nifas' };
      const PHASE_TONE = { onboarding: 'badge', kehamilan: 'badge badge-ok', persalinan: 'badge badge-warn', pasca_kehamilan: 'badge badge-accent' };
      const STATUS_LABEL = { active: 'Aktif', paused: 'Dijeda', completed: 'Selesai', onboarding: 'Pendataan' };
      const STATUS_TONE = { active: 'badge badge-ok', paused: 'badge badge-warn', completed: 'badge', onboarding: 'badge badge-accent' };
      function badge(tone, text) {
        const span = document.createElement('span');
        span.className = tone;
        span.textContent = text;
        return span;
      }
      function setText(id, text) { const n = document.getElementById(id); if (n) n.textContent = text; }
      function progress(user) {
        const logs = Number(user.total_logs || 0);
        const answered = Number(user.total_answered || 0);
        const ppTotal = Number(user.postpartum_total || 0);
        const done = !!user.delivery_data_completed_at || !!user.delivery_date_iso;
        return {
          fe: logs > 0 ? clampPct((answered * 100) / logs) : 0,
          pp: ppTotal > 0 ? clampPct((Number(user.postpartum_sudah || 0) * 100) / ppTotal) : 0,
          labor: done ? 'Selesai' : (Number(user.delivery_data_step || 0) > 0 ? 'Proses' : 'Belum'),
          started: logs > 0 || ppTotal > 0 || done,
        };
      }
      async function fetchJson(url, options) {
        const res = await fetch(url, Object.assign({ headers: csrfHeaders({ Accept: 'application/json' }) }, options || {}));
        if (res.status === 401) { window.location.href = '/admin/login?expired=1'; throw new Error('Sesi berakhir'); }
        if (!res.ok) throw new Error('kode ' + res.status);
        return res.json();
      }
      let healthCache = null;
      let summaryCache = null;
      let usersCache = [];
      let logsCache = [];
      let logsOpen = false;
      let phaseFilter = 'all';
      let keyword = '';

      function renderStatus() {
        const health = healthCache || {};
        const guard = health.guard || {};
        const client = health.client || {};
        const cfg = guard.config || {};
        const runtime = health.runtime || {};
        const ready = !!client.ready;
        const paused = !!guard.paused;
        let tone = 'badge badge-ok';
        let text = 'Siap';
        if (!ready) { tone = 'badge badge-bad'; text = 'Sesi putus'; }
        else if (paused) { tone = 'badge badge-bad'; text = 'Dijeda'; }
        else if (runtime.maintenance_mode) { tone = 'badge badge-bad'; text = 'Mode perawatan'; }
        else if (runtime.dry_run) { tone = 'badge badge-warn'; text = 'Mode simulasi'; }
        else if (Number(guard.failures || 0) > 0) { tone = 'badge badge-warn'; text = 'Ada gagal kirim'; }
        const badgeNode = document.getElementById('status-badge');
        badgeNode.className = tone;
        badgeNode.textContent = text;
        setText('fact-client', ready ? 'Tersambung' : 'Tidak tersambung');
        setText('fact-ready', client.lastReadyAt ? fmtDt(client.lastReadyAt) : 'belum pernah');
        const win = cfg.windowStartHour === undefined ? '-' : cfg.windowStartHour + ':00 sampai ' + cfg.windowEndHour + ':' + String(cfg.windowEndMinute || 0).padStart(2, '0');
        setText('fact-window', guard.withinSendWindow === false ? win + ', di luar jendela' : win);
        setText('fact-quota', (guard.lastDay || 0) + ' / ' + (guard.dailyCap === undefined ? '-' : guard.dailyCap));
        setText('fact-sent', String(guard.sent || 0));
        setText('fact-failed', String(guard.failures || 0));
        const chips = document.getElementById('status-chips');
        chips.innerHTML = '';
        const mods = [
          [runtime.maintenance_mode ? 'Perawatan aktif' : 'Perawatan mati', runtime.maintenance_mode ? 'badge badge-bad' : 'badge'],
          [runtime.dry_run ? 'Simulasi aktif' : 'Kirim nyata', runtime.dry_run ? 'badge badge-warn' : 'badge badge-ok'],
          [runtime.enforce_allowlist ? 'Allowlist aktif' : 'Allowlist mati', runtime.enforce_allowlist ? 'badge' : 'badge badge-warn'],
        ];
        for (const [label, tone2] of mods) chips.appendChild(badge(tone2, label));
        const note = document.getElementById('status-note');
        if (health.alert) {
          note.hidden = false;
          note.textContent = 'Alarm ' + health.alert.kind + ' ' + fmtDt(health.alert.at) + ': ' + (health.alert.detail || '');
        } else {
          note.hidden = true;
        }
      }

      const ACTIONS = {
        resume: { label: 'Aktifkan', cls: 'btn-primary', icon: 'check' },
        unblock: { label: 'Buka blokir', cls: 'btn', icon: 'shield' },
        clear_send_failures: { label: 'Reset', cls: 'btn', icon: 'rotate' },
      };
      function pickAction(reason) {
        if (reason === 'blocked') return 'unblock';
        if (reason === 'send_failure') return 'clear_send_failures';
        return 'resume';
      }
      async function runAction(waId, action, button) {
        button.disabled = true;
        try {
          const res = await fetchJson('/admin/api/users/' + encodeURIComponent(waId) + '/actions', {
            method: 'POST',
            headers: csrfHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ action }),
          });
          if (!res.ok) throw new Error(res.error || 'gagal');
          showToast('Selesai: ' + (ACTIONS[action] || {}).label);
          await loadAll(false);
        } catch (err) {
          showToast('Gagal: ' + err.message);
          button.disabled = false;
        }
      }
      function renderActions() {
        const list = document.getElementById('action-list');
        const items = (summaryCache && summaryCache.needsAction) || [];
        list.innerHTML = '';
        document.getElementById('action-count').textContent = items.length ? items.length + ' user' : 'tidak ada';
        if (!items.length) {
          const li = document.createElement('li');
          li.className = 'empty';
          li.textContent = 'Tidak ada yang perlu dikerjakan.';
          list.appendChild(li);
          return;
        }
        for (const item of items) {
          const action = ACTIONS[pickAction(item.reason)] ? pickAction(item.reason) : 'resume';
          const meta = ACTIONS[action];
          const li = document.createElement('li');
          li.className = 'task';
          const left = document.createElement('div');
          left.style.minWidth = '0';
          const name = document.createElement('div');
          name.className = 'task-name';
          name.textContent = item.name || item.wa_id;
          const why = document.createElement('div');
          why.className = 'task-why';
          why.textContent = item.detail;
          left.appendChild(name);
          left.appendChild(why);
          const right = document.createElement('div');
          right.className = 'row';
          const link = document.createElement('a');
          link.className = 'btn btn-icon';
          link.href = '/admin/users/' + encodeURIComponent(item.wa_id);
          link.setAttribute('aria-label', 'Buka detail ' + (item.name || item.wa_id));
          link.title = 'Detail';
          link.innerHTML = ICON_LINK;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = meta.cls;
          btn.innerHTML = meta.icon === 'check' ? ICON_CHECK_BUTTON : (meta.icon === 'shield' ? ICON_SHIELD_BUTTON : ICON_ROTATE_BUTTON);
          btn.appendChild(document.createTextNode(meta.label));
          btn.addEventListener('click', () => runAction(item.wa_id, action, btn));
          right.appendChild(link);
          right.appendChild(btn);
          li.appendChild(left);
          li.appendChild(right);
          list.appendChild(li);
        }
      }
      function renderToday() {
        const summary = summaryCache || {};
        const rem = summary.reminders || {};
        const users = summary.users || {};
        setText('today-date', rem.date || '');
        setText('today-waiting', fmt(rem.todayWaiting));
        setText('today-sudah', fmt(rem.todaySudah));
        setText('today-belum', fmt(rem.todayBelum));
        setText('today-blocked', fmt(users.total === undefined ? '-' : users.total - (users.runnable || 0)));
      }
      function phaseCounts() {
        const counts = { onboarding: 0, kehamilan: 0, persalinan: 0, pasca_kehamilan: 0 };
        for (const user of usersCache) counts[classifyPhase(user)] += 1;
        return counts;
      }
      function renderUsers() {
        const tbody = document.getElementById('users-body');
        const counts = phaseCounts();
        const filtered = usersCache.filter((user) => {
          if (phaseFilter !== 'all' && classifyPhase(user) !== phaseFilter) return false;
          if (!keyword) return true;
          return String(user.wa_id || '').toLowerCase().includes(keyword) || String(user.name || '').toLowerCase().includes(keyword);
        });
        for (const btn of document.querySelectorAll('.phase-filter')) {
          const key = btn.getAttribute('data-phase-filter');
          btn.setAttribute('aria-pressed', key === phaseFilter ? 'true' : 'false');
        }
        document.getElementById('users-count').textContent =
          filtered.length + ' dari ' + usersCache.length + ' user · ' +
          Object.keys(counts).map((k) => PHASE_LABEL[k] + ' ' + counts[k]).join(' · ');
        tbody.innerHTML = '';
        if (!filtered.length) {
          const tr = document.createElement('tr');
          const td = document.createElement('td');
          td.colSpan = 6;
          td.className = 'muted';
          td.textContent = usersCache.length ? 'Tidak ada yang cocok dengan filter.' : 'Belum ada user.';
          tr.appendChild(td);
          tbody.appendChild(tr);
          return;
        }
        for (const user of filtered) {
          const phase = classifyPhase(user);
          const p = progress(user);
          const tr = document.createElement('tr');
          const nameCell = document.createElement('td');
          nameCell.className = 'name-cell';
          const link = document.createElement('a');
          link.className = 'row-link';
          link.href = '/admin/users/' + encodeURIComponent(user.wa_id);
          link.textContent = fmt(user.name);
          nameCell.appendChild(link);
          tr.appendChild(nameCell);
          const phaseCell = document.createElement('td');
          phaseCell.appendChild(badge(PHASE_TONE[phase], PHASE_LABEL[phase]));
          tr.appendChild(phaseCell);
          const statusCell = document.createElement('td');
          statusCell.appendChild(badge(STATUS_TONE[user.status] || 'badge', STATUS_LABEL[user.status] || fmt(user.status)));
          tr.appendChild(statusCell);
          const timeCell = document.createElement('td');
          timeCell.className = 'num';
          timeCell.textContent = fmt(user.reminder_time);
          tr.appendChild(timeCell);
          const answerCell = document.createElement('td');
          answerCell.textContent = user.last_response ? user.last_response + ' ' + fmt(user.last_response_date) : 'belum ada';
          tr.appendChild(answerCell);
          const progressCell = document.createElement('td');
          if (!p.started) {
            progressCell.className = 'muted';
            progressCell.textContent = 'belum mulai';
          } else {
            const bits = ['FE ' + p.fe + '%'];
            if (p.labor !== 'Belum') bits.push('Persalinan ' + p.labor);
            if (p.pp > 0 || p.labor === 'Selesai') bits.push('KF/KN ' + p.pp + '%');
            progressCell.className = 'num';
            progressCell.textContent = bits.join(' · ');
          }
          tr.appendChild(progressCell);
          tbody.appendChild(tr);
        }
      }
      function renderLogs() {
        const list = document.getElementById('logs-body');
        const limit = logsOpen ? 50 : 10;
        list.innerHTML = '';
        if (!logsCache.length) {
          const li = document.createElement('li');
          li.className = 'empty';
          li.textContent = 'Belum ada catatan pengingat.';
          list.appendChild(li);
          return;
        }
        for (const log of logsCache.slice(0, limit)) {
          const li = document.createElement('li');
          const left = document.createElement('div');
          left.style.minWidth = '0';
          const who = document.createElement('div');
          who.textContent = fmt(log.name) + ' · ' + String(fmt(log.response)).toLowerCase();
          const when = document.createElement('div');
          when.className = 'when num';
          when.textContent = fmt(log.reminder_date) + ' · dicatat ' + fmtDt(log.created_at);
          left.appendChild(who);
          left.appendChild(when);
          const right = document.createElement('div');
          right.className = 'when num';
          right.textContent = 'sudah ' + fmt(log.response_sudah_count) + ' · belum ' + fmt(log.response_belum_count);
          li.appendChild(left);
          li.appendChild(right);
          list.appendChild(li);
        }
        const toggle = document.getElementById('logs-toggle');
        toggle.hidden = logsCache.length <= 10;
        toggle.lastChild.textContent = logsOpen ? 'Tampilkan 10' : 'Tampilkan 50';
      }
      function syncUrl() {
        const params = new URLSearchParams();
        if (phaseFilter !== 'all') params.set('phase', phaseFilter);
        if (keyword) params.set('q', keyword);
        const q = params.toString();
        history.replaceState(null, '', q ? '?' + q : location.pathname);
      }
      function readUrl() {
        const params = new URLSearchParams(location.search);
        const asked = params.get('phase') || 'all';
        const known = Array.from(document.querySelectorAll('.phase-filter')).map((b) => b.getAttribute('data-phase-filter'));
        phaseFilter = known.includes(asked) ? asked : 'all';
        keyword = (params.get('q') || '').trim().toLowerCase();
        document.getElementById('users-search').value = keyword;
      }
      async function guard(noteId, task) {
        try {
          await task();
          const n = document.getElementById(noteId);
          if (n) { n.hidden = true; n.textContent = ''; }
          return { ok: true, error: '' };
        } catch (err) {
          const n = document.getElementById(noteId);
          if (n) { n.hidden = false; n.textContent = 'Bagian ini gagal dimuat: ' + err.message + '. Menampilkan hasil muat sebelumnya.'; }
          return { ok: false, error: err.message };
        }
      }
      async function loadAll(withToast) {
        const btn = document.getElementById('refresh-btn');
        const banner = document.getElementById('error-banner');
        banner.hidden = true;
        btn.disabled = true;
        const results = await Promise.all([
          guard('status-note', async () => { healthCache = await fetchJson('/admin/api/health'); renderStatus(); }),
          guard('users-note', async () => { summaryCache = await fetchJson('/admin/api/summary'); renderToday(); renderActions(); }),
          guard('users-note', async () => { const d = await fetchJson('/admin/api/users'); usersCache = d.users || []; renderUsers(); }),
          guard('logs-note', async () => { const d = await fetchJson('/admin/api/logs'); logsCache = d.logs || []; renderLogs(); }),
        ]);
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          document.getElementById('error-text').textContent = 'Sebagian data gagal dimuat (' + failed.map((r) => r.error).join(', ') + '). Bagian yang gagal ditandai.';
          banner.hidden = false;
          setText('last-updated', 'gagal ' + new Date().toLocaleTimeString('id-ID'));
        } else {
          setText('last-updated', new Date().toLocaleTimeString('id-ID'));
          if (withToast) showToast('Data diperbarui');
        }
        btn.disabled = false;
      }
      document.getElementById('refresh-btn').addEventListener('click', () => loadAll(true));
      document.getElementById('error-retry').addEventListener('click', () => loadAll(true));
      document.getElementById('logs-toggle').addEventListener('click', () => { logsOpen = !logsOpen; renderLogs(); });
      for (const btn of document.querySelectorAll('.phase-filter')) {
        btn.addEventListener('click', () => { phaseFilter = btn.getAttribute('data-phase-filter') || 'all'; syncUrl(); renderUsers(); });
      }
      document.getElementById('users-search').addEventListener('input', (event) => {
        keyword = String(event.target.value || '').trim().toLowerCase();
        syncUrl();
        renderUsers();
      });
      readUrl();
      loadAll(false);
    </script>
  </body>
</html>`;
}

function renderAdminUserDetailPage(waId, options = {}) {
  const nonce = options && options.nonce ? String(options.nonce) : "";
  const csrf = options && options.csrf ? String(options.csrf) : "";
  const safeWaId = escapeHtml(waId || "");
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="${csrf}">
    <title>Detail user - RemindCare Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style nonce="${nonce}">${ADMIN_CSS}
      .kv.kv-3 > div { border-top: none; }
      .pager { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">
        ${icon("pulse")}
        <h1 id="name">Detail user</h1>
        <span class="tag num" id="wa">${safeWaId}</span>
      </div>
      <div class="row">
        <a class="btn" href="/admin">${icon("chevron")}Daftar user</a>
        <a class="btn" href="/admin/api/users/${encodeURIComponent(waId || "")}/export.csv" download>${icon("download")}CSV</a>
      </div>
    </header>

    <div class="wrap">
      <p class="note" id="page-note" role="status" aria-live="polite"></p>

      <section class="panel" aria-labelledby="ringkasan-title">
        <div class="panel-head">
          <h2 id="ringkasan-title">${icon("users")}Ringkasan</h2>
          <span id="status-badge" class="badge">-</span>
        </div>
        <dl class="kv kv-3">
          <div><dt>Fase</dt><dd id="phase">-</dd></div>
          <div><dt>Status</dt><dd id="status">-</dd></div>
          <div><dt>Jam pengingat</dt><dd id="time" class="num">-</dd></div>
          <div><dt>Tanggal persalinan</dt><dd id="delivery-date" class="num">-</dd></div>
          <div><dt>Total sudah</dt><dd id="sudah" class="num">-</dd></div>
          <div><dt>Total belum</dt><dd id="belum" class="num">-</dd></div>
        </dl>
      </section>

      <section class="panel" aria-labelledby="persalinan-title">
        <div class="panel-head"><h2 id="persalinan-title">${icon("check")}Data persalinan</h2></div>
        <div class="table-wrap">
          <table>
            <caption>Terisi setelah user menjawab pertanyaan validasi persalinan.</caption>
            <thead><tr><th scope="col">Item</th><th scope="col">Nilai</th></tr></thead>
            <tbody id="delivery-body" aria-busy="true"><tr><td colspan="2" class="muted">Memuat.</td></tr></tbody>
          </table>
        </div>
      </section>

      <section class="panel" aria-labelledby="nifas-title">
        <div class="panel-head"><h2 id="nifas-title">${icon("clock")}Kunjungan nifas dan bayi</h2></div>
        <div class="table-wrap">
          <table>
            <caption>Baris muncul setelah jadwal KF atau KN pertama dikirim.</caption>
            <thead><tr><th scope="col">Kunjungan</th><th scope="col">Status</th><th scope="col">Tanggal</th></tr></thead>
            <tbody id="pp-body" aria-busy="true"><tr><td colspan="3" class="muted">Memuat.</td></tr></tbody>
          </table>
        </div>
      </section>

      <section class="panel" aria-labelledby="riwayat-title">
        <div class="panel-head">
          <h2 id="riwayat-title">${icon("list")}Riwayat pengingat</h2>
          <span class="muted num" id="page-info">-</span>
        </div>
        <div class="table-wrap">
          <table>
            <caption>20 baris per halaman.</caption>
            <thead><tr><th scope="col">Tanggal</th><th scope="col">Jawaban</th><th scope="col">Sudah</th><th scope="col">Belum</th><th scope="col">Dicatat</th></tr></thead>
            <tbody id="logs-body" aria-busy="true"><tr><td colspan="5" class="muted">Memuat.</td></tr></tbody>
          </table>
        </div>
        <div class="pager">
          <button type="button" id="prev" class="btn-icon" aria-label="Halaman sebelumnya" title="Sebelumnya" style="transform:scaleX(-1)">${icon("chevron")}</button>
          <button type="button" id="next" class="btn-icon" aria-label="Halaman berikutnya" title="Berikutnya">${icon("chevron")}</button>
        </div>
      </section>
    </div>

    <script nonce="${nonce}">
      const waId = ${escapeForScriptContext(waId || "")};
      let page = 0;
      const limit = 20;
      const CSRF_TOKEN = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
      function csrfHeaders(extra) { return Object.assign({ 'X-CSRF-Token': CSRF_TOKEN }, extra || {}); }
      function fmt(v) { return v === null || v === undefined || v === '' ? '-' : v; }
      function fmtDt(v) {
        if (!v) return '-';
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      }
      function classifyPhase(user) {
        if (Number(user.postpartum_total || 0) > 0 || user.delivery_date_iso) return 'pasca_kehamilan';
        const labor = Number(user.delivery_data_step || 0) > 0 || !!user.delivery_poll_stage || !!user.delivery_hpl_poll_sent_date ||
          !!user.delivery_hpl3_poll_sent_date || user.delivery_hpl_response === 'Sudah' || user.delivery_hpl3_response === 'Sudah';
        if (labor) return 'persalinan';
        if (user.status === 'onboarding' || !user.hpht_iso) return 'onboarding';
        return 'kehamilan';
      }
      const PHASE_LABEL = { onboarding: 'Onboarding', kehamilan: 'Kehamilan', persalinan: 'Persalinan', pasca_kehamilan: 'Nifas' };
      const STATUS_LABEL = { active: 'Aktif', paused: 'Dijeda', completed: 'Selesai', onboarding: 'Pendataan' };
      const STATUS_TONE = { active: 'badge badge-ok', paused: 'badge badge-warn', completed: 'badge', onboarding: 'badge badge-accent' };
      function setNote(text) { document.getElementById('page-note').textContent = text || ''; }
      function setBusy(id, busy) { const n = document.getElementById(id); if (n) n.setAttribute('aria-busy', busy ? 'true' : 'false'); }
      async function fetchJson(url) {
        const res = await fetch(url, { headers: csrfHeaders({ Accept: 'application/json' }) });
        if (res.status === 401) { window.location.href = '/admin/login?expired=1'; throw new Error('Sesi berakhir'); }
        if (!res.ok) { const err = new Error('kode ' + res.status); err.status = res.status; throw err; }
        return res.json();
      }
      function fillRows(tbody, rows, mapper, emptyText, colspan, rowHeader) {
        tbody.innerHTML = '';
        tbody.setAttribute('aria-busy', 'false');
        if (!rows || !rows.length) {
          const tr = document.createElement('tr');
          const td = document.createElement('td');
          td.colSpan = colspan;
          td.className = 'muted';
          td.textContent = emptyText;
          tr.appendChild(td);
          tbody.appendChild(tr);
          return;
        }
        for (const row of rows) {
          const tr = document.createElement('tr');
          mapper(row).forEach((cell, index) => {
            const head = !!rowHeader && index === 0;
            const node = document.createElement(head ? 'th' : 'td');
            if (head) node.setAttribute('scope', 'row');
            node.textContent = fmt(cell);
            tr.appendChild(node);
          });
          tbody.appendChild(tr);
        }
      }
      async function loadDetail() {
        setNote('');
        setBusy('delivery-body', true);
        setBusy('pp-body', true);
        try {
          const data = await fetchJson('/admin/api/users/' + encodeURIComponent(waId));
          const user = data.user || {};
          document.getElementById('name').textContent = fmt(user.name);
          document.getElementById('wa').textContent = fmt(user.wa_id);
          document.getElementById('status').textContent = STATUS_LABEL[user.status] || fmt(user.status);
          document.getElementById('phase').textContent = PHASE_LABEL[classifyPhase(user)];
          document.getElementById('time').textContent = fmt(user.reminder_time);
          document.getElementById('delivery-date').textContent = fmt(user.delivery_date_iso || user.delivery_date);
          document.getElementById('sudah').textContent = fmt(data.totals && data.totals.total_sudah);
          document.getElementById('belum').textContent = fmt(data.totals && data.totals.total_belum);
          const badgeNode = document.getElementById('status-badge');
          badgeNode.className = STATUS_TONE[user.status] || 'badge';
          badgeNode.textContent = STATUS_LABEL[user.status] || fmt(user.status);
          const deliveryRows = [
            ['Validasi HPL', user.delivery_hpl_response],
            ['Validasi HPL +3', user.delivery_hpl3_response],
            ['Tanggal melahirkan', user.delivery_date_iso || user.delivery_date],
            ['Jam melahirkan', user.delivery_time],
            ['Tempat melahirkan', user.delivery_place],
            ['Penolong persalinan', user.delivery_birth_attendant],
            ['Penyulit persalinan', user.delivery_with_complication],
            ['Jenis kelamin bayi', user.baby_gender],
            ['Berat badan bayi', user.baby_birth_weight],
            ['Keluhan ibu', user.mother_current_complaint],
            ['Data selesai diisi', user.delivery_data_completed_at],
          ].filter((row) => row[1] !== null && row[1] !== undefined && row[1] !== '');
          fillRows(document.getElementById('delivery-body'), deliveryRows, (r) => r, 'Belum ada data persalinan.', 2, true);
          fillRows(document.getElementById('pp-body'), data.postpartum_logs || [],
            (x) => [x.visit_label || x.visit_code, x.response || 'Pending', fmtDt(x.response_at || x.sent_at || x.due_at)],
            'Belum ada riwayat kunjungan nifas.', 3, false);
        } catch (err) {
          setBusy('delivery-body', false);
          setBusy('pp-body', false);
          if (err.status === 404) setNote('Nomor ' + waId + ' tidak ditemukan di database.');
          else if (err.message !== 'Sesi berakhir') setNote('Gagal memuat detail: ' + err.message + '.');
        }
      }
      async function loadLogs() {
        setBusy('logs-body', true);
        try {
          const data = await fetchJson('/admin/api/users/' + encodeURIComponent(waId) + '/logs?limit=' + limit + '&offset=' + page * limit);
          const rows = data.logs || [];
          const total = Number(data.total || 0);
          fillRows(document.getElementById('logs-body'), rows,
            (x) => [x.reminder_date, x.response || 'Pending', x.response_sudah_count, x.response_belum_count, fmtDt(x.created_at)],
            'Belum ada riwayat pengingat.', 5, false);
          const pages = Math.max(1, Math.ceil(total / limit));
          document.getElementById('page-info').textContent = 'halaman ' + (page + 1) + ' dari ' + pages + ' · ' + total + ' baris';
          document.getElementById('prev').disabled = page <= 0;
          document.getElementById('next').disabled = page + 1 >= pages;
        } catch (err) {
          setBusy('logs-body', false);
          if (err.message !== 'Sesi berakhir') setNote('Gagal memuat riwayat: ' + err.message + '.');
        }
      }
      document.getElementById('prev').addEventListener('click', () => { if (page > 0) { page -= 1; loadLogs(); } });
      document.getElementById('next').addEventListener('click', () => { page += 1; loadLogs(); });
      loadDetail();
      loadLogs();
    </script>
  </body>
</html>`;
}

function openDb() {
  const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error("Gagal membuka database:", err.message);
      process.exit(1);
    }
  });
  // Satu koneksi dipakai bersama oleh loop pengingat dan admin web. Tanpa busy_timeout
  // dan WAL, gaya pakai itu menghasilkan SQLITE_BUSY acak dan 500 di admin.
  db.configure("busyTimeout", 5000);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.on("error", (err) => {
    console.error("Error database:", err.message);
  });
  return db;
}

async function checkDbIntegrity(db) {
  try {
    const row = await dbGet(db, "PRAGMA integrity_check");
    const result = row ? String(Object.values(row)[0]) : "unknown";
    return { ok: result === "ok", result };
  } catch (err) {
    return { ok: false, result: err.message };
  }
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function ensureColumn(db, table, column, definition) {
  const rows = await dbAll(db, `PRAGMA table_info(${table})`);
  const exists = rows.some((row) => row.name === column);
  if (!exists) {
    await dbRun(db, `ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function ensureUserColumns(db) {
  await ensureColumn(
    db,
    "users",
    "is_admin",
    "is_admin INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "is_allowed",
    "is_allowed INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "is_blocked",
    "is_blocked INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "last_labor_phase_message_date",
    "last_labor_phase_message_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "last_reminder_text_date",
    "last_reminder_text_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "last_delivery_poll_message_id",
    "last_delivery_poll_message_id TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_stage",
    "delivery_poll_stage TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "fe_poll_last_attempt_at",
    "fe_poll_last_attempt_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "fe_poll_fail_count",
    "fe_poll_fail_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_last_attempt_at",
    "delivery_poll_last_attempt_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_fail_count",
    "delivery_poll_fail_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_intro_stage",
    "delivery_poll_intro_stage TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_intro_date",
    "delivery_poll_intro_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl_poll_sent_date",
    "delivery_hpl_poll_sent_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl_response",
    "delivery_hpl_response TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl_response_at",
    "delivery_hpl_response_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl3_poll_sent_date",
    "delivery_hpl3_poll_sent_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl3_response",
    "delivery_hpl3_response TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl3_response_at",
    "delivery_hpl3_response_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_data_step",
    "delivery_data_step INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(db, "users", "delivery_date", "delivery_date TEXT");
  await ensureColumn(
    db,
    "users",
    "delivery_date_iso",
    "delivery_date_iso TEXT",
  );
  await ensureColumn(db, "users", "delivery_time", "delivery_time TEXT");
  await ensureColumn(db, "users", "delivery_place", "delivery_place TEXT");
  await ensureColumn(
    db,
    "users",
    "delivery_birth_attendant",
    "delivery_birth_attendant TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_with_complication",
    "delivery_with_complication TEXT",
  );
  await ensureColumn(db, "users", "baby_gender", "baby_gender TEXT");
  await ensureColumn(
    db,
    "users",
    "baby_birth_weight",
    "baby_birth_weight TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "mother_current_complaint",
    "mother_current_complaint TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_data_completed_at",
    "delivery_data_completed_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "postpartum_education_sent_at",
    "postpartum_education_sent_at TEXT",
  );
}

async function ensureReminderLogColumns(db) {
  await ensureColumn(
    db,
    "reminder_logs",
    "response_count",
    "response_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "reminder_logs",
    "response_sudah_count",
    "response_sudah_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "reminder_logs",
    "response_belum_count",
    "response_belum_count INTEGER NOT NULL DEFAULT 0",
  );
}

async function ensurePostpartumLogColumns(db) {
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "reminder_text_sent_at",
    "reminder_text_sent_at TEXT",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "last_attempt_at",
    "last_attempt_at TEXT",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "fail_count",
    "fail_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "response_count",
    "response_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "response_sudah_count",
    "response_sudah_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "response_belum_count",
    "response_belum_count INTEGER NOT NULL DEFAULT 0",
  );
}

function pickIsoMin(values) {
  const filtered = (values || []).filter(Boolean).sort();
  return filtered.length > 0 ? filtered[0] : null;
}

function pickIsoMax(values) {
  const filtered = (values || []).filter(Boolean).sort();
  return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}

function scoreLegacyPostpartumLog(log) {
  if (!log) {
    return 0;
  }
  if (log.response === "Sudah") {
    return 100;
  }
  if (log.response === "Belum") {
    return 80;
  }
  if (log.poll_message_id) {
    return 50;
  }
  if (log.sent_at) {
    return 40;
  }
  if (log.reminder_text_sent_at) {
    return 30;
  }
  return 10;
}

function buildMergedLegacyPostpartumLogRows(waId, visit, legacyLogs) {
  const rows = Array.isArray(legacyLogs) ? legacyLogs.filter(Boolean) : [];
  if (!waId || !visit || rows.length === 0) {
    return null;
  }

  const ranked = [...rows].sort((a, b) => {
    const scoreDiff = scoreLegacyPostpartumLog(b) - scoreLegacyPostpartumLog(a);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  });
  const base = ranked[0];
  if (!base) {
    return null;
  }

  const nowIso = nowWib().toISO();
  const response = rows.some((item) => item.response === "Sudah")
    ? "Sudah"
    : rows.some((item) => item.response === "Belum")
      ? "Belum"
      : null;
  const responseRows = rows.filter((item) => item.response === response);
  const pollSource = [...rows]
    .filter((item) => item.poll_message_id)
    .sort((a, b) => String(b.sent_at || "").localeCompare(String(a.sent_at || "")))[0];

  const responseCount = rows.reduce((total, item) => {
    const count = Number(item.response_count || 0);
    return Number.isFinite(count) && count > 0 ? total + count : total;
  }, 0);
  const responseSudahCount = rows.reduce((total, item) => {
    const count = Number(item.response_sudah_count || 0);
    return Number.isFinite(count) && count > 0 ? total + count : total;
  }, 0);
  const responseBelumCount = rows.reduce((total, item) => {
    const count = Number(item.response_belum_count || 0);
    return Number.isFinite(count) && count > 0 ? total + count : total;
  }, 0);

  return {
    wa_id: waId,
    visit_code: visit.code,
    visit_kind: visit.kind,
    visit_label: visit.label,
    window_text: visit.windowText,
    benefit_text: visit.focusText,
    due_at: pickIsoMin(rows.map((item) => item.due_at)) || nowIso,
    reminder_text_sent_at: pickIsoMin(rows.map((item) => item.reminder_text_sent_at)),
    sent_at: pickIsoMin(rows.map((item) => item.sent_at)),
    poll_message_id: pollSource ? pollSource.poll_message_id : null,
    last_attempt_at: pickIsoMax(rows.map((item) => item.last_attempt_at)),
    fail_count: Math.max(
      0,
      ...rows.map((item) => {
        const count = Number(item.fail_count || 0);
        return Number.isFinite(count) && count >= 0 ? count : 0;
      }),
    ),
    response,
    response_count: responseCount,
    response_sudah_count: responseSudahCount,
    response_belum_count: responseBelumCount,
    response_at:
      responseRows.length > 0
        ? pickIsoMax(responseRows.map((item) => item.response_at))
        : null,
    created_at: pickIsoMin(rows.map((item) => item.created_at)) || nowIso,
    updated_at: pickIsoMax(rows.map((item) => item.updated_at)) || nowIso,
  };
}

async function migrateLegacyPostpartumVisitLogs(db) {
  const legacyCodes = LEGACY_POSTPARTUM_VISIT_GROUPS.flatMap(
    (item) => item.legacyCodes,
  );
  if (legacyCodes.length === 0) {
    return;
  }

  const placeholders = legacyCodes.map(() => "?").join(", ");
  const legacyRows = await dbAll(
    db,
    `SELECT *
     FROM postpartum_visit_logs
     WHERE visit_code IN (${placeholders})
     ORDER BY wa_id ASC, id ASC`,
    legacyCodes,
  );
  if (!legacyRows || legacyRows.length === 0) {
    return;
  }

  const rowsByUser = new Map();
  for (const row of legacyRows) {
    if (!rowsByUser.has(row.wa_id)) {
      rowsByUser.set(row.wa_id, []);
    }
    rowsByUser.get(row.wa_id).push(row);
  }

  for (const [waId, rows] of rowsByUser.entries()) {
    for (const group of LEGACY_POSTPARTUM_VISIT_GROUPS) {
      const visit = POSTPARTUM_VISIT_BY_CODE.get(group.code);
      if (!visit) {
        continue;
      }
      const relatedLegacy = rows.filter((row) =>
        group.legacyCodes.includes(row.visit_code),
      );
      if (relatedLegacy.length === 0) {
        continue;
      }

      const existingGrouped = await dbGet(
        db,
        `SELECT id FROM postpartum_visit_logs WHERE wa_id = ? AND visit_code = ?`,
        [waId, group.code],
      );
      if (!existingGrouped) {
        const merged = buildMergedLegacyPostpartumLogRows(
          waId,
          visit,
          relatedLegacy,
        );
        if (merged) {
          await dbRun(
            db,
            `INSERT INTO postpartum_visit_logs (
              wa_id,
              visit_code,
              visit_kind,
              visit_label,
              window_text,
              benefit_text,
              due_at,
              reminder_text_sent_at,
              sent_at,
              poll_message_id,
              last_attempt_at,
              fail_count,
              response,
              response_count,
              response_sudah_count,
              response_belum_count,
              response_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              merged.wa_id,
              merged.visit_code,
              merged.visit_kind,
              merged.visit_label,
              merged.window_text,
              merged.benefit_text,
              merged.due_at,
              merged.reminder_text_sent_at,
              merged.sent_at,
              merged.poll_message_id,
              merged.last_attempt_at,
              merged.fail_count,
              merged.response,
              merged.response_count,
              merged.response_sudah_count,
              merged.response_belum_count,
              merged.response_at,
              merged.created_at,
              merged.updated_at,
            ],
          );
        }
      }

      const legacyPlaceholders = group.legacyCodes.map(() => "?").join(", ");
      await dbRun(
        db,
        `DELETE FROM postpartum_visit_logs
         WHERE wa_id = ? AND visit_code IN (${legacyPlaceholders})`,
        [waId, ...group.legacyCodes],
      );
    }
  }
}

async function ensureSettingsTable(db) {
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    )`,
  );
}

async function getSetting(db, key, fallback = null) {
  const row = await dbGet(db, "SELECT value FROM settings WHERE key = ?", [key]);
  return row && row.value !== null && row.value !== undefined
    ? row.value
    : fallback;
}

async function setSetting(db, key, value) {
  await dbRun(
    db,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [
      key,
      value === null || value === undefined ? null : String(value),
      nowWib().toISO(),
    ],
  );
}

async function initDb(db) {
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT UNIQUE NOT NULL,
      name TEXT,
      age TEXT,
      pregnancy_number TEXT,
      hpht TEXT,
      hpht_iso TEXT,
      routine_meds INTEGER,
      tea INTEGER,
      reminder_person TEXT,
      allow_remindcare INTEGER,
      reminder_time TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_allowed INTEGER NOT NULL DEFAULT 0,
      is_blocked INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'onboarding',
      onboarding_step INTEGER NOT NULL DEFAULT 1,
      last_reminder_date TEXT,
      last_poll_message_id TEXT,
      last_labor_phase_message_date TEXT,
      last_reminder_text_date TEXT,
      last_delivery_poll_message_id TEXT,
      delivery_poll_stage TEXT,
      fe_poll_last_attempt_at TEXT,
      fe_poll_fail_count INTEGER NOT NULL DEFAULT 0,
      delivery_poll_last_attempt_at TEXT,
      delivery_poll_fail_count INTEGER NOT NULL DEFAULT 0,
      delivery_poll_intro_stage TEXT,
      delivery_poll_intro_date TEXT,
      delivery_hpl_poll_sent_date TEXT,
      delivery_hpl_response TEXT,
      delivery_hpl_response_at TEXT,
      delivery_hpl3_poll_sent_date TEXT,
      delivery_hpl3_response TEXT,
      delivery_hpl3_response_at TEXT,
      delivery_data_step INTEGER NOT NULL DEFAULT 0,
      delivery_date TEXT,
      delivery_date_iso TEXT,
      delivery_time TEXT,
      delivery_place TEXT,
      delivery_birth_attendant TEXT,
      delivery_with_complication TEXT,
      baby_gender TEXT,
      baby_birth_weight TEXT,
      mother_current_complaint TEXT,
      delivery_data_completed_at TEXT,
      postpartum_education_sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS reminder_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT NOT NULL,
      reminder_date TEXT NOT NULL,
      response TEXT,
      response_count INTEGER NOT NULL DEFAULT 0,
      response_sudah_count INTEGER NOT NULL DEFAULT 0,
      response_belum_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(wa_id, reminder_date)
    )`,
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS postpartum_visit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT NOT NULL,
      visit_code TEXT NOT NULL,
      visit_kind TEXT NOT NULL,
      visit_label TEXT NOT NULL,
      window_text TEXT NOT NULL,
      benefit_text TEXT NOT NULL,
      due_at TEXT NOT NULL,
      reminder_text_sent_at TEXT,
      sent_at TEXT,
      poll_message_id TEXT,
      last_attempt_at TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      response TEXT,
      response_count INTEGER NOT NULL DEFAULT 0,
      response_sudah_count INTEGER NOT NULL DEFAULT 0,
      response_belum_count INTEGER NOT NULL DEFAULT 0,
      response_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(wa_id, visit_code)
    )`,
  );

  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_users_active_loop
     ON users (status, allow_remindcare, is_blocked, reminder_time, last_reminder_date)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_postpartum_logs_wa_due
     ON postpartum_visit_logs (wa_id, due_at, sent_at, response)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_postpartum_logs_poll
     ON postpartum_visit_logs (wa_id, poll_message_id)`,
  );

  await ensureUserColumns(db);
  await ensureReminderLogColumns(db);
  await ensurePostpartumLogColumns(db);
  await migrateLegacyPostpartumVisitLogs(db);

  await ensureAliasTable(db);
  await loadAliasCache(db);
  await reconcileRunnableUsers(db);
}

async function getUser(db, waId) {
  return dbGet(db, "SELECT * FROM users WHERE wa_id = ?", [waId]);
}

async function createUser(db, waId, options = {}) {
  const nowIso = nowWib().toISO();
  const isAdmin = options.is_admin ? 1 : 0;
  const isAllowed = options.is_allowed ? 1 : 0;
  const isBlocked = options.is_blocked ? 1 : 0;
  await dbRun(
    db,
    `INSERT INTO users (
      wa_id,
      status,
      onboarding_step,
      is_admin,
      is_allowed,
      is_blocked,
      created_at,
      updated_at
    )
     VALUES (?, 'onboarding', 1, ?, ?, ?, ?, ?)`,
    [waId, isAdmin, isAllowed, isBlocked, nowIso, nowIso],
  );
}

async function ensureUser(db, waId, seed = {}) {
  let user = await getUser(db, waId);
  let isNew = false;

  if (!user) {
    await createUser(db, waId, seed);
    user = await getUser(db, waId);
    isNew = true;
    return { user, isNew };
  }

  const updates = {};
  if (seed.is_admin && !user.is_admin) {
    updates.is_admin = 1;
  }
  if (seed.is_allowed && !user.is_allowed) {
    updates.is_allowed = 1;
  }
  if (seed.is_blocked && !user.is_blocked) {
    updates.is_blocked = 1;
  }

  if (Object.keys(updates).length > 0) {
    await updateUser(db, waId, updates);
    user = { ...user, ...updates };
  }

  return { user, isNew };
}

async function updateUser(db, waId, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return;
  }

  const nowIso = nowWib().toISO();
  const setClause = keys.map((key) => `${key} = ?`).join(", ");
  const params = keys.map((key) => updates[key]);
  params.push(nowIso, waId);

  await dbRun(
    db,
    `UPDATE users SET ${setClause}, updated_at = ? WHERE wa_id = ?`,
    params,
  );
}

function parseYesNo(input) {
  if (!input) {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (/\b(ya|iya|yes|y|ok|mau|boleh)\b/.test(normalized)) {
    return true;
  }
  if (/\b(tidak|tdk|no|gak|ga|nggak|belum)\b/.test(normalized)) {
    return false;
  }
  return null;
}

function normalizeTimeInput(input) {
  if (!input) {
    return null;
  }
  const raw = input.trim().toLowerCase();
  const cleaned = raw.replace(/\s+/g, "").replace(".", ":");

  let hour;
  let minute;

  if (/^\d{1,2}$/.test(cleaned)) {
    hour = Number(cleaned);
    minute = 0;
  } else if (/^\d{1,2}:\d{1,2}$/.test(cleaned)) {
    const parts = cleaned.split(":");
    hour = Number(parts[0]);
    minute = Number(parts[1]);
  } else if (/^\d{3,4}$/.test(cleaned)) {
    if (cleaned.length === 3) {
      hour = Number(cleaned.slice(0, 1));
      minute = Number(cleaned.slice(1));
    } else {
      hour = Number(cleaned.slice(0, 2));
      minute = Number(cleaned.slice(2));
    }
  } else {
    return null;
  }

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeBirthWeightGram(input) {
  if (!input) {
    return null;
  }
  const raw = String(input).trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (/\b(kg|kilogram|kilo)\b/.test(raw)) {
    return null;
  }
  const match = raw.match(/(\d[\d.,]*)/);
  if (!match || !match[1]) {
    return null;
  }
  const gramsText = match[1].replace(/\D/g, "");
  if (!gramsText) {
    return null;
  }
  const grams = Number(gramsText);
  if (!Number.isFinite(grams) || grams <= 0) {
    return null;
  }
  return `${Math.round(grams)} gram`;
}

function parseHpht(input) {
  const raw = input ? input.trim() : "";
  if (!raw) {
    return { raw: "", iso: null };
  }

  const patterns = [
    { regex: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/, order: "ymd" },
    { regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/, order: "dmy" },
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern.regex);
    if (!match) {
      continue;
    }

    let year;
    let month;
    let day;

    if (pattern.order === "ymd") {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else {
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
    }

    const parsed = DateTime.fromObject(
      { year, month, day },
      { zone: TIMEZONE },
    );
    if (parsed.isValid) {
      return { raw, iso: parsed.toFormat("yyyy-LL-dd") };
    }
  }

  return { raw, iso: null };
}

function parsePollAnswer(input) {
  if (!input) {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (normalized.includes("sudah") || normalized.includes("udah")) {
    return "Sudah";
  }
  if (normalized.includes("belum")) {
    return "Belum";
  }
  return null;
}

function parseAdminCommand(text) {
  if (!text) {
    return null;
  }
  const match = text.trim().match(/^admin(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  const rest = (match[1] || "").trim();
  if (!rest) {
    return { action: "help", args: [], rawArgs: "" };
  }
  const parts = rest.split(/\s+/);
  const action = parts[0].toLowerCase();
  const rawArgs = rest.slice(action.length).trim();
  return { action, args: parts.slice(1), rawArgs };
}

async function purgeOldLogs(db, retentionDays, now = nowWib()) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }
  const cutoff = now.minus({ days: retentionDays }).toFormat("yyyy-LL-dd");
  const result = await dbRun(
    db,
    "DELETE FROM reminder_logs WHERE reminder_date < ?",
    [cutoff],
  );
  return result && typeof result.changes === "number" ? result.changes : 0;
}

async function getUserStats(db) {
  const total = await dbGet(db, "SELECT COUNT(*) as count FROM users");
  const active = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE status = 'active'",
  );
  const allowed = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE is_allowed = 1",
  );
  const blocked = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE is_blocked = 1",
  );
  return {
    total: total ? total.count : 0,
    active: active ? active.count : 0,
    allowed: allowed ? allowed.count : 0,
    blocked: blocked ? blocked.count : 0,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }
  let text = String(value);
  // Excel, LibreOffice, dan Google Sheets mengeksekusi nilai yang diawali salah satu
  // karakter ini sebagai formula. Isi dari percakapan WhatsApp bisa sampai ke CSV,
  // jadi setiap nilai diberi awalan aman sebelum dikutip.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(rows, columns) {
  const header = columns.map((col) => csvEscape(col.label)).join(",");
  const lines = rows.map((row) =>
    columns.map((col) => csvEscape(row[col.key])).join(","),
  );
  return [header, ...lines].join("\n");
}

function buildPostpartumSnapshot(postpartumLogs) {
  const logs = Array.isArray(postpartumLogs) ? postpartumLogs : [];
  const byCode = new Map(logs.map((item) => [item.visit_code, item]));
  const total = logs.length;
  const sent = logs.filter((item) => item.sent_at).length;
  const sudah = logs.filter((item) => item.response === "Sudah").length;
  const belum = logs.filter((item) => item.response === "Belum").length;
  const pending = logs.filter((item) => item.sent_at && !item.response).length;

  const snapshot = {
    postpartum_total: total,
    postpartum_sent: sent,
    postpartum_sudah: sudah,
    postpartum_belum: belum,
    postpartum_pending: pending,
  };

  const confirmedDates = [];
  for (const visit of POSTPARTUM_VISIT_SCHEDULES) {
    const key = visit.code.toLowerCase();
    const log = byCode.get(visit.code) || null;
    const confirmedAt =
      log && log.response === "Sudah" ? log.response_at || null : null;
    snapshot[`${key}_confirmed_at`] = confirmedAt;
    if (confirmedAt) {
      confirmedDates.push(confirmedAt);
    }
  }
  snapshot.postpartum_last_confirmed_at = pickIsoMax(confirmedDates);

  return snapshot;
}

// Aturan "perlu tindakan": setiap kondisi di bawah berarti user TIDAK akan menerima
// pengingat hari ini, atau pengiriman ke dia sedang bermasalah. Dashboard memakai daftar
// ini supaya operator tidak perlu menebak dari angka nol.
function buildNeedsAction(users) {
  const items = [];
  for (const user of users || []) {
    const status = String(user.status || "");
    const reason = (() => {
      if (user.is_blocked) {
        return { code: "blocked", text: "Nomor diblokir", action: "Buka blokir" };
      }
      if (status === "completed") {
        return null;
      }
      if (user.reminder_time && status !== "active") {
        return {
          code: "not_running",
          text: `Punya jam ${user.reminder_time} tetapi status ${status || "kosong"}`,
          action: "Aktifkan pengingat",
        };
      }
      if (!user.reminder_time && status === "active") {
        return {
          code: "no_time",
          text: "Aktif tetapi belum punya jam pengingat",
          action: "Isi jam pengingat",
        };
      }
      if (status === "paused" || Number(user.allow_remindcare) === 0) {
        return { code: "paused", text: "Pengingat sedang dijeda", action: "Lanjutkan" };
      }
      const failCount = Math.max(
        Number(user.fe_poll_fail_count || 0),
        Number(user.delivery_poll_fail_count || 0),
      );
      if (failCount >= 2) {
        return {
          code: "send_failure",
          text: `Gagal kirim ${failCount} kali beruntun`,
          action: "Periksa nomor dan reset penghitung",
        };
      }
      return null;
    })();
    if (reason) {
      items.push({
        wa_id: user.wa_id,
        name: user.name || null,
        reason: reason.code,
        detail: reason.text,
        action: reason.action,
      });
    }
  }
  return items;
}

async function getAdminSummary(db) {
  const total = await dbGet(db, "SELECT COUNT(*) as count FROM users");
  const active = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE status = 'active'",
  );
  const paused = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE status = 'paused'",
  );
  const completed = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE status = 'completed'",
  );
  const allowed = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE is_allowed = 1",
  );
  const blocked = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE is_blocked = 1",
  );
  const today = toDateKey(nowWib());
  const todaySudah = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM reminder_logs WHERE reminder_date = ? AND response = 'Sudah'",
    [today],
  );
  const todayBelum = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM reminder_logs WHERE reminder_date = ? AND response = 'Belum'",
    [today],
  );
  const runnable = await dbGet(
    db,
    `SELECT COUNT(*) as count FROM users
     WHERE status = 'active' AND allow_remindcare = 1 AND reminder_time IS NOT NULL AND is_blocked = 0`,
  );
  const waiting = await dbGet(
    db,
    `SELECT COUNT(*) as count FROM users
     WHERE status = 'active' AND allow_remindcare = 1 AND reminder_time IS NOT NULL
       AND is_blocked = 0 AND (last_reminder_date IS NULL OR last_reminder_date <> ?)`,
    [today],
  );
  const onboarding = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE status = 'onboarding'",
  );
  const actionRows = await dbAll(
    db,
    `SELECT wa_id, name, status, reminder_time, allow_remindcare, is_blocked,
            fe_poll_fail_count, delivery_poll_fail_count
     FROM users ORDER BY name COLLATE NOCASE`,
  );
  return {
    users: {
      total: total ? total.count : 0,
      active: active ? active.count : 0,
      paused: paused ? paused.count : 0,
      completed: completed ? completed.count : 0,
      allowed: allowed ? allowed.count : 0,
      blocked: blocked ? blocked.count : 0,
      runnable: runnable ? runnable.count : 0,
      onboarding: onboarding ? onboarding.count : 0,
    },
    reminders: {
      todaySudah: todaySudah ? todaySudah.count : 0,
      todayBelum: todayBelum ? todayBelum.count : 0,
      todayWaiting: waiting ? waiting.count : 0,
      date: today,
    },
    needsAction: buildNeedsAction(actionRows),
  };
}

async function getAdminUsers(db) {
  return dbAll(
    db,
    `SELECT
      u.wa_id,
      u.name,
      u.status,
      u.hpht_iso,
      u.reminder_time,
      u.delivery_data_step,
      u.delivery_poll_stage,
      u.delivery_hpl_poll_sent_date,
      u.delivery_hpl3_poll_sent_date,
      u.delivery_hpl_response,
      u.delivery_hpl3_response,
      u.delivery_date_iso,
      u.delivery_time,
      u.delivery_place,
      u.delivery_birth_attendant,
      u.delivery_with_complication,
      u.baby_gender,
      u.baby_birth_weight,
      u.mother_current_complaint,
      u.delivery_data_completed_at,
      COALESCE(pv.postpartum_total, 0) as postpartum_total,
      COALESCE(pv.postpartum_sent, 0) as postpartum_sent,
      COALESCE(pv.postpartum_sudah, 0) as postpartum_sudah,
      COALESCE(pv.postpartum_belum, 0) as postpartum_belum,
      rl_last.reminder_date as last_response_date,
      rl_last.response as last_response,
      COALESCE(agg.total_logs, 0) as total_logs,
      COALESCE(agg.total_answered, 0) as total_answered,
      COALESCE(agg.total_sudah, 0) as total_sudah,
      COALESCE(agg.total_belum, 0) as total_belum
     FROM users u
     LEFT JOIN (
       SELECT wa_id,
              COUNT(*) as total_logs,
              SUM(CASE WHEN response IS NOT NULL THEN 1 ELSE 0 END) as total_answered,
              SUM(CASE WHEN response = 'Sudah' THEN 1 ELSE 0 END) as total_sudah,
              SUM(CASE WHEN response = 'Belum' THEN 1 ELSE 0 END) as total_belum
       FROM reminder_logs
       GROUP BY wa_id
     ) agg ON agg.wa_id = u.wa_id
     LEFT JOIN (
       SELECT wa_id,
              COUNT(*) as postpartum_total,
              SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) as postpartum_sent,
              SUM(CASE WHEN response = 'Sudah' THEN 1 ELSE 0 END) as postpartum_sudah,
              SUM(CASE WHEN response = 'Belum' THEN 1 ELSE 0 END) as postpartum_belum
       FROM postpartum_visit_logs
       GROUP BY wa_id
     ) pv ON pv.wa_id = u.wa_id
     LEFT JOIN reminder_logs rl_last
       ON rl_last.wa_id = u.wa_id
       AND rl_last.reminder_date = (
         SELECT MAX(reminder_date)
         FROM reminder_logs
         WHERE wa_id = u.wa_id
       )
     ORDER BY u.created_at DESC`,
  );
}

async function deleteUserData(db, waId) {
  await dbRun(db, "DELETE FROM postpartum_visit_logs WHERE wa_id = ?", [waId]);
  await dbRun(db, "DELETE FROM reminder_logs WHERE wa_id = ?", [waId]);
  await dbRun(db, "DELETE FROM users WHERE wa_id = ?", [waId]);
}

function hasAnyDeliveryRecord(user) {
  if (!user) {
    return false;
  }
  const step = Number(user.delivery_data_step || 0);
  if (Number.isFinite(step) && step > 0) {
    return true;
  }
  if (
    user.delivery_data_completed_at ||
    user.delivery_date ||
    user.delivery_date_iso ||
    user.delivery_time ||
    user.delivery_place ||
    user.delivery_birth_attendant ||
    user.delivery_with_complication ||
    user.baby_gender ||
    user.baby_birth_weight ||
    user.mother_current_complaint
  ) {
    return true;
  }
  const hplResponse = String(user.delivery_hpl_response || "")
    .trim()
    .toLowerCase();
  const hpl3Response = String(user.delivery_hpl3_response || "")
    .trim()
    .toLowerCase();
  return hplResponse === "sudah" || hpl3Response === "sudah";
}

async function restartUserDataFromBeginning(db, waId) {
  await clearPostpartumVisitLogs(db, waId);
  await updateUser(db, waId, {
    status: "onboarding",
    onboarding_step: 1,
    name: null,
    age: null,
    pregnancy_number: null,
    hpht: null,
    hpht_iso: null,
    routine_meds: null,
    tea: null,
    reminder_person: null,
    allow_remindcare: null,
    reminder_time: null,
    last_reminder_date: null,
    last_poll_message_id: null,
    last_labor_phase_message_date: null,
    last_reminder_text_date: null,
    last_delivery_poll_message_id: null,
    delivery_poll_stage: null,
    fe_poll_last_attempt_at: null,
    fe_poll_fail_count: 0,
    delivery_poll_last_attempt_at: null,
    delivery_poll_fail_count: 0,
    delivery_poll_intro_stage: null,
    delivery_poll_intro_date: null,
    delivery_hpl_poll_sent_date: null,
    delivery_hpl_response: null,
    delivery_hpl_response_at: null,
    delivery_hpl3_poll_sent_date: null,
    delivery_hpl3_response: null,
    delivery_hpl3_response_at: null,
    delivery_data_step: 0,
    delivery_date: null,
    delivery_date_iso: null,
    delivery_time: null,
    delivery_place: null,
    delivery_birth_attendant: null,
    delivery_with_complication: null,
    baby_gender: null,
    baby_birth_weight: null,
    mother_current_complaint: null,
    delivery_data_completed_at: null,
    postpartum_education_sent_at: null,
  });
}

async function getUserDetail(db, waId) {
  const user = await dbGet(db, "SELECT * FROM users WHERE wa_id = ?", [waId]);
  const totals = await dbGet(
    db,
    `SELECT
       SUM(CASE WHEN response = 'Sudah' THEN 1 ELSE 0 END) as total_sudah,
       SUM(CASE WHEN response = 'Belum' THEN 1 ELSE 0 END) as total_belum
     FROM reminder_logs
     WHERE wa_id = ?`,
    [waId],
  );
  const logs = await dbAll(
    db,
    `SELECT
       reminder_date,
       response,
       response_sudah_count,
       response_belum_count,
       created_at
     FROM reminder_logs
     WHERE wa_id = ?
     ORDER BY reminder_date DESC, id DESC`,
    [waId],
  );
  const postpartumLogs = await dbAll(
    db,
    `SELECT
       visit_code,
       visit_kind,
       visit_label,
       window_text,
       benefit_text,
       due_at,
       reminder_text_sent_at,
       sent_at,
       poll_message_id,
       last_attempt_at,
       fail_count,
       response,
       response_count,
       response_sudah_count,
       response_belum_count,
       response_at,
       created_at,
       updated_at
     FROM postpartum_visit_logs
     WHERE wa_id = ?
     ORDER BY due_at ASC, id ASC`,
    [waId],
  );
  const postpartumTotals = await dbGet(
    db,
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) as sent,
       SUM(CASE WHEN response = 'Sudah' THEN 1 ELSE 0 END) as sudah,
       SUM(CASE WHEN response = 'Belum' THEN 1 ELSE 0 END) as belum
     FROM postpartum_visit_logs
     WHERE wa_id = ?`,
    [waId],
  );
  return {
    user,
    totals: {
      total_sudah: totals && totals.total_sudah ? totals.total_sudah : 0,
      total_belum: totals && totals.total_belum ? totals.total_belum : 0,
    },
    logs,
    postpartum_logs: postpartumLogs,
    postpartum_totals: {
      total:
        postpartumTotals && postpartumTotals.total ? postpartumTotals.total : 0,
      sent:
        postpartumTotals && postpartumTotals.sent ? postpartumTotals.sent : 0,
      sudah:
        postpartumTotals && postpartumTotals.sudah ? postpartumTotals.sudah : 0,
      belum:
        postpartumTotals && postpartumTotals.belum ? postpartumTotals.belum : 0,
    },
  };
}

async function getRecentLogs(db, limit = 50) {
  return dbAll(
    db,
    `SELECT
      rl.reminder_date,
      u.name,
      response,
      response_sudah_count,
      response_belum_count,
      rl.created_at
     FROM reminder_logs rl
     LEFT JOIN users u ON u.wa_id = rl.wa_id
     ORDER BY rl.reminder_date DESC, rl.id DESC
     LIMIT ?`,
    [limit],
  );
}

async function getUserLogsPaged(db, waId, limit = 20, offset = 0) {
  const safeLimit = Number.isFinite(Number(limit))
    ? Math.min(200, Math.max(1, Number(limit)))
    : 20;
  const safeOffset = Number.isFinite(Number(offset))
    ? Math.max(0, Number(offset))
    : 0;
  const totalRow = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM reminder_logs WHERE wa_id = ?",
    [waId],
  );
  const logs = await dbAll(
    db,
    `SELECT
      reminder_date,
      response,
      response_sudah_count,
      response_belum_count,
      created_at
     FROM reminder_logs
     WHERE wa_id = ?
     ORDER BY reminder_date DESC, id DESC
     LIMIT ? OFFSET ?`,
    [waId, safeLimit, safeOffset],
  );
  return {
    total: totalRow && totalRow.count ? totalRow.count : 0,
    logs,
    limit: safeLimit,
    offset: safeOffset,
  };
}

async function handleAdminCommand(db, client, user, text) {
  const parsed = parseAdminCommand(text);
  if (!parsed) {
    return false;
  }

  if (!user.is_admin) {
    await sendText(
      client,
      user.wa_id,
      "Perintah admin hanya untuk admin ya. 🔒",
    );
    return true;
  }

  const { action, rawArgs } = parsed;
  if (action === "help") {
    await sendText(
      client,
      user.wa_id,
      "Perintah admin: admin stats, admin allow <wa_id>, admin block <wa_id>, admin unblock <wa_id>, admin purge logs <hari>. 🛠️",
    );
    return true;
  }

  if (action === "stats") {
    const stats = await getUserStats(db);
    await sendText(
      client,
      user.wa_id,
      `Stat user: total ${stats.total}, aktif ${stats.active}, allowed ${stats.allowed}, blocked ${stats.blocked}. 📊`,
    );
    return true;
  }

  if (action === "allow" || action === "block" || action === "unblock") {
    const target = normalizeWaIdInput(rawArgs);
    if (!target) {
      await sendText(
        client,
        user.wa_id,
        "Format: admin allow|block|unblock <wa_id>. ✍️",
      );
      return true;
    }

    const { user: targetUser } = await ensureUser(db, target);
    const updates = {};
    if (action === "allow") {
      updates.is_allowed = 1;
      updates.is_blocked = 0;
    } else if (action === "block") {
      updates.is_blocked = 1;
    } else if (action === "unblock") {
      updates.is_blocked = 0;
    }

    await updateUser(db, targetUser.wa_id, updates);
    await sendText(client, user.wa_id, `OK ${action} ${targetUser.wa_id}. ✅`);
    return true;
  }

  if (action === "purge") {
    const parts = rawArgs.split(/\s+/).filter(Boolean);
    let daysInput = null;
    if (parts.length === 1) {
      daysInput = parts[0];
    } else if (parts.length >= 2 && parts[0].toLowerCase() === "logs") {
      daysInput = parts[1];
    }
    const days = daysInput ? Number(daysInput) : REMINDER_LOG_RETENTION_DAYS;
    const removed = await purgeOldLogs(db, days);
    await sendText(
      client,
      user.wa_id,
      `Log dibersihkan: ${removed} baris (retensi ${Number.isFinite(days) ? days : "-"} hari). 🧹`,
    );
    return true;
  }

  await sendText(
    client,
    user.wa_id,
    "Perintah admin tidak dikenali. Ketik: admin help. 🤔",
  );
  return true;
}

function isGreeting(input) {
  if (!input) {
    return false;
  }
  const normalized = input.trim().toLowerCase();
  return /^(halo|hai|hi|hey|hei|assalamualaikum|salam)$/.test(normalized);
}

function shouldSkipToday(reminderTime, now) {
  const [hour, minute] = reminderTime.split(":").map(Number);
  const scheduled = now.set({ hour, minute, second: 0, millisecond: 0 });
  return now > scheduled;
}

function shouldSendNow(reminderTime, now) {
  if (!reminderTime) {
    return false;
  }
  const [hour, minute] = String(reminderTime).split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false;
  }
  const scheduled = now.set({ hour, minute, second: 0, millisecond: 0 });
  if (now < scheduled) {
    return false;
  }
  // Pengingat yang terlewat (misal bot baru hidup sore hari) hangus, tidak dikejar.
  // Tanpa batas ini, satu kali restart mengirim pengingat ke SEMUA user sekaligus.
  const staleLimit = getReminderStaleMinutes();
  return now.diff(scheduled, "minutes").minutes <= staleLimit;
}

function shouldSendBeforeReminder(reminderTime, now, leadHours = 2) {
  if (!reminderTime) {
    return false;
  }
  const [hour, minute] = String(reminderTime).split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false;
  }
  const scheduled = now.set({ hour, minute, second: 0, millisecond: 0 });
  const leadMoment = scheduled.minus({ hours: leadHours });
  return now >= leadMoment && now < scheduled;
}

function isPregnancyActive(user, now) {
  const start = getHphtDate(user);
  if (!start) {
    return true;
  }
  const weeksLimit =
    Number.isFinite(PREGNANCY_WEEKS_LIMIT) && PREGNANCY_WEEKS_LIMIT > 0
      ? PREGNANCY_WEEKS_LIMIT
      : 42;
  const end = start.plus({ weeks: weeksLimit }).endOf("day");
  return now <= end;
}

async function ensureReminderLog(db, waId, dateKey) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `INSERT OR IGNORE INTO reminder_logs (
      wa_id,
      reminder_date,
      response,
      response_count,
      response_sudah_count,
      response_belum_count,
      created_at
    )
     VALUES (?, ?, NULL, 0, 0, 0, ?)`,
    [waId, dateKey, nowIso],
  );
}

async function recordDailyResponse(db, waId, dateKey, response) {
  await ensureReminderLog(db, waId, dateKey);
  const log = await dbGet(
    db,
    `SELECT response_sudah_count, response_belum_count
     FROM reminder_logs
     WHERE wa_id = ? AND reminder_date = ?`,
    [waId, dateKey],
  );
  const sudahCount =
    log && Number.isFinite(Number(log.response_sudah_count))
      ? Number(log.response_sudah_count)
      : 0;
  const belumCount =
    log && Number.isFinite(Number(log.response_belum_count))
      ? Number(log.response_belum_count)
      : 0;
  const limit = getMaxPollResponsesPerDay();
  const isSudah = response === "Sudah";
  const currentCount = isSudah ? sudahCount : belumCount;
  const allowed = limit === null || currentCount < limit;
  const nextSudah = isSudah && allowed ? sudahCount + 1 : sudahCount;
  const nextBelum = !isSudah && allowed ? belumCount + 1 : belumCount;
  await dbRun(
    db,
    `UPDATE reminder_logs
     SET response = ?, response_sudah_count = ?, response_belum_count = ?
     WHERE wa_id = ? AND reminder_date = ?`,
    [response, nextSudah, nextBelum, waId, dateKey],
  );
  return { allowed, limit, count: currentCount };
}

async function clearPostpartumVisitLogs(db, waId) {
  await dbRun(db, "DELETE FROM postpartum_visit_logs WHERE wa_id = ?", [waId]);
}

async function getPostpartumVisitLogs(db, waId) {
  return dbAll(
    db,
    `SELECT
      id,
      wa_id,
      visit_code,
      visit_kind,
      visit_label,
      window_text,
      benefit_text,
      due_at,
      reminder_text_sent_at,
      sent_at,
      poll_message_id,
      last_attempt_at,
      fail_count,
      response,
      response_count,
      response_sudah_count,
      response_belum_count,
      response_at,
      created_at,
      updated_at
     FROM postpartum_visit_logs
     WHERE wa_id = ?
     ORDER BY due_at ASC, id ASC`,
    [waId],
  );
}

async function getPostpartumVisitLogByPollMessageId(db, waId, pollMessageId) {
  if (!pollMessageId) {
    return null;
  }
  return dbGet(
    db,
    `SELECT *
     FROM postpartum_visit_logs
     WHERE wa_id = ? AND poll_message_id = ?`,
    [waId, pollMessageId],
  );
}

async function getLatestPendingPostpartumVisitLog(db, waId) {
  return dbGet(
    db,
    `SELECT *
     FROM postpartum_visit_logs
     WHERE wa_id = ?
       AND poll_message_id IS NOT NULL
       AND response IS NULL
     ORDER BY sent_at DESC, id DESC
     LIMIT 1`,
    [waId],
  );
}

async function ensurePostpartumVisitLog(db, waId, visit, dueAt) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `INSERT OR IGNORE INTO postpartum_visit_logs (
      wa_id,
      visit_code,
      visit_kind,
      visit_label,
      window_text,
      benefit_text,
      due_at,
      reminder_text_sent_at,
      sent_at,
      poll_message_id,
      last_attempt_at,
      fail_count,
      response,
      response_count,
      response_sudah_count,
      response_belum_count,
      response_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, 0, 0, 0, NULL, ?, ?)`,
    [
      waId,
      visit.code,
      visit.kind,
      visit.label,
      visit.windowText,
      visit.focusText,
      dueAt.toISO(),
      nowIso,
      nowIso,
    ],
  );
}

async function markPostpartumVisitSent(db, waId, visitCode, pollMessageId) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `UPDATE postpartum_visit_logs
     SET sent_at = ?,
         poll_message_id = ?,
         last_attempt_at = ?,
         fail_count = 0,
         updated_at = ?
     WHERE wa_id = ? AND visit_code = ?`,
    [nowIso, pollMessageId, nowIso, nowIso, waId, visitCode],
  );
}

async function markPostpartumVisitTextSent(db, waId, visitCode) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `UPDATE postpartum_visit_logs
     SET reminder_text_sent_at = COALESCE(reminder_text_sent_at, ?),
         updated_at = ?
     WHERE wa_id = ? AND visit_code = ?`,
    [nowIso, nowIso, waId, visitCode],
  );
}

async function markPostpartumVisitSendFailed(db, waId, visitCode, failCount) {
  const nowIso = nowWib().toISO();
  const nextFailCount =
    Number.isFinite(Number(failCount)) && Number(failCount) >= 0
      ? Number(failCount) + 1
      : 1;
  await dbRun(
    db,
    `UPDATE postpartum_visit_logs
     SET last_attempt_at = ?,
         fail_count = ?,
         updated_at = ?
     WHERE wa_id = ? AND visit_code = ?`,
    [nowIso, nextFailCount, nowIso, waId, visitCode],
  );
}

// Jawaban mis-tap pada kunjungan nifas tidak bisa dihapus, jadi perlu jalan koreksi.
function parsePostpartumCorrection(input) {
  if (!input) {
    return null;
  }
  const match = String(input)
    .trim()
    .toLowerCase()
    .match(/^koreksi\s+(?:kunjungan\s+)?(kfkn|kf|kn)[\s-]?([1-4])\s+(sudah|belum)$/);
  if (!match) {
    return null;
  }
  const prefix = match[1].toUpperCase();
  const number = match[2];
  const rawCode = prefix === "KFKN" ? `KFKN${number}` : `${prefix}${number}`;
  return {
    rawCode,
    response: match[3] === "sudah" ? "Sudah" : "Belum",
  };
}

function resolveVisitCode(rawCode) {
  const code = String(rawCode || "").toUpperCase();
  if (POSTPARTUM_VISIT_BY_CODE.has(code)) {
    return code;
  }
  for (const group of LEGACY_POSTPARTUM_VISIT_GROUPS) {
    if (group.legacyCodes && group.legacyCodes.includes(code)) {
      return group.code;
    }
  }
  return null;
}

async function applyPostpartumCorrection(db, client, user, correction) {
  const code = resolveVisitCode(correction.rawCode);
  if (!code) {
    return false;
  }
  const visitLog = await dbGet(
    db,
    `SELECT * FROM postpartum_visit_logs WHERE wa_id = ? AND visit_code = ? ORDER BY id DESC LIMIT 1`,
    [user.wa_id, code],
  );
  if (!visitLog) {
    await sendText(
      client,
      user.wa_id,
      `Belum ada catatan kunjungan ${code}. Ketik *info* untuk lihat status kunjungan.`,
    );
    return true;
  }
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `UPDATE postpartum_visit_logs SET response = ?, response_at = ?, updated_at = ? WHERE id = ?`,
    [correction.response, nowIso, nowIso, visitLog.id],
  );
  await sendText(
    client,
    user.wa_id,
    `Catatan ${code} diperbarui menjadi ${correction.response.toLowerCase()}. Ketik *info* untuk lihat ringkasannya.`,
  );
  return true;
}

async function recordPostpartumVisitResponse(db, visitLog, response) {
  const sudahCount =
    visitLog && Number.isFinite(Number(visitLog.response_sudah_count))
      ? Number(visitLog.response_sudah_count)
      : 0;
  const belumCount =
    visitLog && Number.isFinite(Number(visitLog.response_belum_count))
      ? Number(visitLog.response_belum_count)
      : 0;
  const responseCount =
    visitLog && Number.isFinite(Number(visitLog.response_count))
      ? Number(visitLog.response_count)
      : 0;
  const limit = getMaxPollResponsesPerDay();
  const isSudah = response === "Sudah";
  const currentCount = isSudah ? sudahCount : belumCount;
  const allowed = limit === null || currentCount < limit;
  const nextSudah = isSudah && allowed ? sudahCount + 1 : sudahCount;
  const nextBelum = !isSudah && allowed ? belumCount + 1 : belumCount;
  const nextResponseCount = allowed ? responseCount + 1 : responseCount;
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `UPDATE postpartum_visit_logs
     SET response = ?,
         response_count = ?,
         response_sudah_count = ?,
         response_belum_count = ?,
         response_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      response,
      nextResponseCount,
      nextSudah,
      nextBelum,
      nowIso,
      nowIso,
      visitLog.id,
    ],
  );
  return { allowed, limit, count: currentCount };
}

async function hasCompletedFinalPostpartumVisit(db, waId) {
  const row = await dbGet(
    db,
    `SELECT id
     FROM postpartum_visit_logs
     WHERE wa_id = ?
       AND visit_code = 'KF4'
       AND response = 'Sudah'
     LIMIT 1`,
    [waId],
  );
  return Boolean(row);
}

async function completeUserAfterFinalPostpartumVisit(db, client, user) {
  if (!user || user.status === "completed") {
    return false;
  }
  await updateUser(db, user.wa_id, {
    status: "completed",
    allow_remindcare: 0,
  });
  await sendText(
    client,
    user.wa_id,
    "Selamat, kunjungan KF 4 sudah tercatat. Program RemindCare selesai, jadi pengingat tablet FE tidak akan dikirim lagi. Jika ada program atau kehamilan baru, ketik *edit data* untuk isi ulang dari awal.",
  );
  return true;
}

// Teks terjadwal di luar poll tidak punya kolom backoff sendiri. Supaya scheduler 30 detik
// tidak menembak ulang aliran yang baru gagal, jeda percobaan disimpan per aliran di memori
// proses. Ini bukan pengganti kolom persisten, hanya penahan retry cepat dalam satu proses.
const flowAttempts = new Map();
const FLOW_RETRY_MIN_MS = 15 * 60 * 1000;

function flowKey(waId, flow) {
  return `${waId}:${flow}`;
}

function canAttemptFlow(waId, flow, nowMs = Date.now()) {
  const last = flowAttempts.get(flowKey(waId, flow));
  if (!last) {
    return true;
  }
  return nowMs - last >= FLOW_RETRY_MIN_MS;
}

function markFlowAttempt(waId, flow, nowMs = Date.now()) {
  flowAttempts.set(flowKey(waId, flow), nowMs);
  if (flowAttempts.size > 2000) {
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    for (const [key, ts] of flowAttempts.entries()) {
      if (ts < cutoff) {
        flowAttempts.delete(key);
      }
    }
  }
}

// Satu titik untuk semua pengingat berbentuk teks: hitung kuota harian, hormati jeda
// percobaan aliran, dan catat kuota hanya ketika benar-benar terkirim.
async function sendReminderText(db, client, user, text, dateKey, now, flow = "reminder_text") {
  if (isOverDailyMessageQuota(user, dateKey)) {
    console.warn("Kuota pesan harian penuh untuk", user.wa_id, "aliran", flow);
    return null;
  }
  if (!canAttemptFlow(user.wa_id, flow)) {
    return null;
  }
  markFlowAttempt(user.wa_id, flow);
  const sent = await sendText(client, user.wa_id, text);
  if (!sent) {
    return null;
  }
  noteScheduledSend(user.wa_id, dateKey);
  if (now && now.toISO) {
    console.log("Terkirim", flow, "ke", user.wa_id, "pada", now.toISO());
  }
  return sent;
}

async function sendPostpartumEducationIfNeeded(db, client, user, now) {
  if (
    !isPostpartumMonitoringActive(user) ||
    user.postpartum_education_sent_at
  ) {
    return false;
  }
  const sent = await sendReminderText(
    db,
    client,
    user,
    buildPostpartumEducationMessage(user, now),
    toDateKey(now),
    now,
    "postpartum_education",
  );
  if (!sent) {
    return false;
  }
  await updateUser(db, user.wa_id, {
    postpartum_education_sent_at: now.toISO(),
  });
  return true;
}

async function sendPostpartumVisitReminder(
  db,
  client,
  user,
  visit,
  visitLog,
  now,
) {
  if (
    !canAttemptByBackoff(
      visitLog && visitLog.last_attempt_at ? visitLog.last_attempt_at : null,
      visitLog && visitLog.fail_count ? visitLog.fail_count : 0,
      now,
    )
  ) {
    return false;
  }
  if (!takeSendAttempt(user.wa_id, `kf_${visit.code}`, toDateKey(now))) {
    return false;
  }

  if (!visitLog || !visitLog.reminder_text_sent_at) {
    const reminderText = buildPostpartumVisitMessage(user, visit);
    const textSent = await sendText(client, user.wa_id, reminderText);
    if (textSent) {
      await markPostpartumVisitTextSent(db, user.wa_id, visit.code);
    }
  }

  const poll = new Poll(
    buildPostpartumVisitQuestion(visit),
    POSTPARTUM_POLL_OPTIONS,
    {
      allowMultipleAnswers: false,
    },
  );
  const message = await sendPoll(client, user.wa_id, poll);
  if (!message || !message.id || !message.id._serialized) {
    console.error(
      "Gagal mengirim polling kunjungan untuk:",
      user.wa_id,
      visit.code,
    );
    await markPostpartumVisitSendFailed(
      db,
      user.wa_id,
      visit.code,
      visitLog && visitLog.fail_count ? visitLog.fail_count : 0,
    );
    if (isPermanentSendFailure(user.wa_id)) {
      await updateUser(db, user.wa_id, {
        allow_remindcare: 0,
        status: "paused",
      });
      console.warn(
        "Pengingat dihentikan untuk",
        user.wa_id,
        ": error pengiriman permanen.",
      );
    }
    return false;
  }

  noteScheduledSend(user.wa_id, toDateKey(now));
  await markPostpartumVisitSent(
    db,
    user.wa_id,
    visit.code,
    message.id._serialized,
  );
  return true;
}

async function processPostpartumVisitReminders(db, client, user, now) {
  if (!isPostpartumMonitoringActive(user)) {
    return;
  }
  const deliveryAt = getDeliveryDateTime(user);
  if (!deliveryAt) {
    return;
  }

  await sendPostpartumEducationIfNeeded(db, client, user, now);
  const logs = await getPostpartumVisitLogs(db, user.wa_id);
  const logByCode = new Map(logs.map((item) => [item.visit_code, item]));

  for (const visit of POSTPARTUM_VISIT_SCHEDULES) {
    const dueAt = getPostpartumDueAt(deliveryAt, visit);
    if (!dueAt) {
      continue;
    }

    let log = logByCode.get(visit.code);
    if (!log) {
      await ensurePostpartumVisitLog(db, user.wa_id, visit, dueAt);
      log = {
        visit_code: visit.code,
        reminder_text_sent_at: null,
        sent_at: null,
        last_attempt_at: null,
        fail_count: 0,
      };
      logByCode.set(visit.code, log);
    }

    if (log.sent_at || log.response || now < dueAt) {
      continue;
    }

    const sent = await sendPostpartumVisitReminder(
      db,
      client,
      user,
      visit,
      log,
      now,
    );
    if (sent) {
      break;
    }
  }
}

// Keputusan pemilik: begitu jam pengingat terisi, user harus benar-benar diingatkan.
// Tanpa pengaman ini, user yang punya jam tapi statusnya masih onboarding tidak pernah
// masuk scheduler, dan di dashboard terlihat sebagai "Aktif 0" tanpa penjelasan.
async function reconcileRunnableUsers(db) {
  const result = await dbRun(
    db,
    `UPDATE users
     SET status = 'active',
         allow_remindcare = 1
     WHERE reminder_time IS NOT NULL
       AND allow_remindcare = 1
       AND is_blocked = 0
       AND status = 'onboarding'`,
  );
  const changed = result && typeof result.changes === "number" ? result.changes : 0;
  if (changed > 0) {
    console.log(`${changed} user diaktifkan karena jam pengingat sudah terisi.`);
  }
  return changed;
}

async function sendDailyPoll(db, client, user, now, options = {}) {
  const skipReminderText = options && options.skipReminderText === true;
  if (
    !canAttemptByBackoff(
      user.fe_poll_last_attempt_at,
      user.fe_poll_fail_count,
      now,
    )
  ) {
    return false;
  }

  const dateKey = toDateKey(now);
  if (!takeSendAttempt(user.wa_id, "fe_poll", dateKey)) {
    return false;
  }

  // Setelah beberapa hari, pengingat berbentuk poll diturunkan frekuensinya: sebagian hari
  // cukup pesan teks. Jawaban teks tetap tercatat lewat jalur jawaban harian yang sudah ada.
  // Keputusan poll dihitung SEBELUM pesan pertama dikirim, karena menghitungnya setelah
  // pengiriman membuat hari mode teks mengirim pesan yang sama dua kali.
  const pollDaysLimit = Math.max(1, settingInt("poll_days_limit"));
  const programDay = getProgramDay(user, now);
  const usePoll =
    programDay === null || programDay <= pollDaysLimit || programDay % 2 === 0;

  const reminderAlreadySentToday = user.last_reminder_text_date === dateKey;
  if (!skipReminderText && !reminderAlreadySentToday) {
    const reminderText = buildReminderMessage(user, now);
    const reminderSent = await sendReminderText(db, client, user, reminderText, dateKey, now);
    if (reminderSent) {
      await updateUser(db, user.wa_id, { last_reminder_text_date: dateKey });
    }
    if (!usePoll) {
      if (!reminderSent) {
        return false;
      }
      await updateUser(db, user.wa_id, {
        last_reminder_date: dateKey,
        last_reminder_text_date: dateKey,
      });
      return true;
    }
  }

  if (!usePoll) {
    // Hari mode teks tanpa pengiriman sebelumnya (misalnya jendela kirim baru terbuka).
    const textOnly = await sendReminderText(
      db,
      client,
      user,
      buildReminderMessage(user, now),
      dateKey,
      now,
    );
    if (!textOnly) {
      return false;
    }
    await updateUser(db, user.wa_id, {
      last_reminder_date: dateKey,
      last_reminder_text_date: dateKey,
    });
    return true;
  }

  const poll = new Poll(buildReminderQuestion(user, now), REMINDER_POLL_OPTIONS, {
    allowMultipleAnswers: false,
  });

  const message = await sendPoll(client, user.wa_id, poll);
  if (!message || !message.id || !message.id._serialized) {
    console.error("Gagal mengirim polling untuk:", user.wa_id);
    const cappedAttempts =
      Number.isFinite(Number(user.fe_poll_fail_count)) &&
      Number(user.fe_poll_fail_count) >= 0
        ? Number(user.fe_poll_fail_count) + 1
        : 1;
    await updateUser(db, user.wa_id, {
      last_reminder_date: dateKey,
      fe_poll_last_attempt_at: now.toISO(),
      fe_poll_fail_count: Math.min(cappedAttempts, MAX_SEND_ATTEMPTS),
    });
    await ensureReminderLog(db, user.wa_id, dateKey);
    if (isPermanentSendFailure(user.wa_id)) {
      // Nomor tidak terdaftar atau diblokir: berhenti mencoba, jangan kirim berulang.
      await updateUser(db, user.wa_id, {
        allow_remindcare: 0,
        status: "paused",
      });
      console.warn(
        "Pengingat dihentikan untuk",
        user.wa_id,
        ": error pengiriman permanen.",
      );
    }
    return false;
  }

  noteScheduledSend(user.wa_id, dateKey);
  await updateUser(db, user.wa_id, {
    last_reminder_date: dateKey,
    last_poll_message_id: message.id._serialized,
    fe_poll_last_attempt_at: now.toISO(),
    fe_poll_fail_count: 0,
  });

  await ensureReminderLog(db, user.wa_id, dateKey);
  return true;
}

async function sendLaborPhaseMessage(db, client, user, now) {
  const today = toDateKey(now);
  if (user.last_labor_phase_message_date === today) {
    return false;
  }
  const phaseMessage = buildLaborPhaseMessage(user, now);
  if (!phaseMessage) {
    return false;
  }
  const sent = await sendReminderText(
    db,
    client,
    user,
    phaseMessage,
    today,
    now,
    "labor_phase",
  );
  if (!sent) {
    return false;
  }
  await updateUser(db, user.wa_id, { last_labor_phase_message_date: today });
  return true;
}

async function sendDeliveryValidationPoll(db, client, user, now, stage) {
  if (
    !canAttemptByBackoff(
      user.delivery_poll_last_attempt_at,
      user.delivery_poll_fail_count,
      now,
    )
  ) {
    return false;
  }

  const today = toDateKey(now);
  if (!takeSendAttempt(user.wa_id, `delivery_${stage}`, today)) {
    return false;
  }
  const shouldSendIntro =
    stage !== "week39_daily" &&
    (user.delivery_poll_intro_stage !== stage ||
      user.delivery_poll_intro_date !== today);
  if (shouldSendIntro) {
    const intro = buildDeliveryValidationMessage(user, now, stage);
    const introSent = await sendReminderText(
      db,
      client,
      user,
      intro,
      today,
      now,
      `delivery_intro_${stage}`,
    );
    if (introSent) {
      await updateUser(db, user.wa_id, {
        delivery_poll_intro_stage: stage,
        delivery_poll_intro_date: today,
      });
    }
  }

  const poll = new Poll(
    buildDeliveryValidationQuestion(),
    DELIVERY_VALIDATION_POLL_OPTIONS,
    { allowMultipleAnswers: false },
  );
  const message = await sendPoll(client, user.wa_id, poll);
  if (!message || !message.id || !message.id._serialized) {
    console.error("Gagal mengirim polling validasi lahir untuk:", user.wa_id);
    const cappedAttempts =
      Number.isFinite(Number(user.delivery_poll_fail_count)) &&
      Number(user.delivery_poll_fail_count) >= 0
        ? Number(user.delivery_poll_fail_count) + 1
        : 1;
    await updateUser(db, user.wa_id, {
      delivery_poll_last_attempt_at: now.toISO(),
      delivery_poll_fail_count: Math.min(cappedAttempts, MAX_SEND_ATTEMPTS),
    });
    if (isPermanentSendFailure(user.wa_id)) {
      await updateUser(db, user.wa_id, {
        allow_remindcare: 0,
        status: "paused",
      });
      console.warn(
        "Pengingat dihentikan untuk",
        user.wa_id,
        ": error pengiriman permanen.",
      );
    }
    return false;
  }

  noteScheduledSend(user.wa_id, today);
  const updates = {
    last_delivery_poll_message_id: message.id._serialized,
    delivery_poll_stage: stage,
    delivery_poll_last_attempt_at: now.toISO(),
    delivery_poll_fail_count: 0,
  };
  if (stage === "hpl3") {
    updates.delivery_hpl3_poll_sent_date = today;
  } else {
    updates.delivery_hpl_poll_sent_date = today;
  }
  await updateUser(db, user.wa_id, updates);
  return true;
}

function buildBelumDeliverySupportMessage() {
  const lines = [
    "Terima kasih sudah memberi kabar, Ibu. Tetap semangat ya.",
    "Tetap tenang dan pantau tanda persalinan seperti kontraksi teratur, keluar lendir bercampur darah, atau ketuban pecah.",
    "",
    "Yang sebaiknya dilakukan:",
    "1. Istirahat cukup dan jaga asupan cairan.",
    "2. Pantau gerakan janin secara berkala.",
    "3. Segera ke fasilitas kesehatan bila ada tanda bahaya.",
    "",
    `Baca artikel lanjutan di: ${DELIVERY_ARTICLE_URL}`,
  ];
  return lines.join("\n");
}

async function startDeliveryDataCollection(db, client, user) {
  await clearPostpartumVisitLogs(db, user.wa_id);
  await updateUser(db, user.wa_id, {
    delivery_poll_stage: null,
    last_delivery_poll_message_id: null,
    delivery_poll_last_attempt_at: null,
    delivery_poll_fail_count: 0,
    delivery_poll_intro_stage: null,
    delivery_poll_intro_date: null,
    delivery_data_step: 1,
    delivery_date: null,
    delivery_date_iso: null,
    delivery_time: null,
    delivery_place: null,
    delivery_birth_attendant: null,
    delivery_with_complication: null,
    baby_gender: null,
    baby_birth_weight: null,
    mother_current_complaint: null,
    delivery_data_completed_at: null,
    postpartum_education_sent_at: null,
  });
  await sendText(client, user.wa_id, DELIVERY_QUESTIONS[0].text);
}

async function handleDeliveryValidationResponse(
  db,
  client,
  user,
  response,
  stageHint = null,
) {
  if (response !== "Sudah" && response !== "Belum") {
    return false;
  }

  const stage =
    stageHint ||
    getPendingDeliveryPollStage(user) ||
    getDeliveryValidationStageDue(user, nowWib());
  if (!stage) {
    return false;
  }
  if (
    (stage === "week39_daily" || stage === "hpl") &&
    user.delivery_hpl_response === "Sudah"
  ) {
    return true;
  }
  if (stage === "hpl3" && user.delivery_hpl3_response === "Sudah") {
    return true;
  }

  const nowIso = nowWib().toISO();
  const updates = {
    delivery_poll_stage: null,
    last_delivery_poll_message_id: null,
    delivery_poll_last_attempt_at: null,
    delivery_poll_fail_count: 0,
  };
  if (stage === "hpl3") {
    updates.delivery_hpl3_response = response;
    updates.delivery_hpl3_response_at = nowIso;
  } else if (stage !== "manual") {
    updates.delivery_hpl_response = response;
    updates.delivery_hpl_response_at = nowIso;
  }
  await updateUser(db, user.wa_id, updates);

  if (response === "Belum") {
    await sendText(client, user.wa_id, buildBelumDeliverySupportMessage());
    return true;
  }

  await sendText(
    client,
    user.wa_id,
    "Terima kasih, Ibu. Selamat atas kelahirannya. Kami lanjutkan pendataan persalinan singkat ya.",
  );
  await startDeliveryDataCollection(db, client, user);
  return true;
}

async function handleDeliveryDataAnswer(db, client, user, text) {
  const step = Number(user.delivery_data_step || 0);
  if (!Number.isFinite(step) || step <= 0) {
    return false;
  }

  const question = DELIVERY_QUESTIONS[step - 1];
  if (!question) {
    await updateUser(db, user.wa_id, { delivery_data_step: 0 });
    return false;
  }

  const raw = text ? text.trim() : "";
  if (!raw) {
    await sendText(
      client,
      user.wa_id,
      "Jawaban belum terbaca. Bisa diulang ya?",
    );
    return true;
  }

  const updates = {};
  if (question.type === "date") {
    const parsed = parseHpht(raw);
    if (!parsed.iso) {
      await sendText(
        client,
        user.wa_id,
        "Format tanggal belum sesuai. Contoh: 31-01-2026.",
      );
      return true;
    }
    const dateValidation = validateDeliveryDateIso(parsed.iso, user, nowWib());
    if (!dateValidation.valid) {
      await sendText(client, user.wa_id, dateValidation.message);
      return true;
    }
    updates.delivery_date = parsed.raw;
    updates.delivery_date_iso = parsed.iso;
  } else if (question.type === "time") {
    const time = normalizeTimeInput(raw);
    if (!time) {
      await sendText(
        client,
        user.wa_id,
        "Format jam belum sesuai. Contoh: 14:30.",
      );
      return true;
    }
    const deliveryDateIso = user.delivery_date_iso || updates.delivery_date_iso;
    const datetimeValidation = validateDeliveryDateTime(
      user,
      deliveryDateIso,
      time,
      nowWib(),
    );
    if (!datetimeValidation.valid) {
      await sendText(client, user.wa_id, datetimeValidation.message);
      return true;
    }
    updates.delivery_time = time;
  } else if (question.type === "yesno") {
    const yesNo = parseYesNo(raw);
    if (yesNo === null) {
      await sendText(client, user.wa_id, "Jawab dengan *ya* atau *tidak* ya.");
      return true;
    }
    updates.delivery_with_complication = yesNo
      ? "Dengan penyulit"
      : "Tidak dengan penyulit";
  } else if (question.type === "weight_gram") {
    const weight = normalizeBirthWeightGram(raw);
    if (!weight) {
      await sendText(
        client,
        user.wa_id,
        "Format berat belum sesuai. Tulis dalam gram, contoh: 3200 gram.",
      );
      return true;
    }
    updates[question.field] = weight;
  } else {
    updates[question.field] = raw;
  }

  const nextStep = step + 1;
  if (nextStep > DELIVERY_QUESTIONS.length) {
    updates.delivery_data_step = 0;
    updates.delivery_data_completed_at = nowWib().toISO();
    updates.postpartum_education_sent_at = null;
    await updateUser(db, user.wa_id, updates);
    await clearPostpartumVisitLogs(db, user.wa_id);
    await sendText(
      client,
      user.wa_id,
      "Terima kasih, data persalinan sudah dicatat.\nBerikutnya RemindCare akan mengingatkan jadwal kunjungan KF/KN sesuai rentang waktunya.\nKalau ada yang perlu diubah, ketik *edit persalinan*.",
    );
    await sendPostpartumEducationIfNeeded(
      db,
      client,
      { ...user, ...updates },
      nowWib(),
    );
    return true;
  }

  await updateUser(db, user.wa_id, {
    ...updates,
    delivery_data_step: nextStep,
  });
  await sendText(client, user.wa_id, DELIVERY_QUESTIONS[nextStep - 1].text);
  return true;
}

async function handlePostpartumVisitResponse(
  db,
  client,
  user,
  visitLog,
  response,
) {
  if (!visitLog || (response !== "Sudah" && response !== "Belum")) {
    return false;
  }

  const result = await recordPostpartumVisitResponse(db, visitLog, response);
  if (!result.allowed) {
    const visitLabel =
      visitLog.visit_label || visitLog.visit_code || "kunjungan";
    const limitText =
      result.limit === null
        ? `Jawaban ${visitLabel} sudah tercatat sebelumnya.`
        : `Jawaban ${response.toLowerCase()} untuk ${visitLabel} sudah mencapai batas ${result.limit}x hari ini.`;
    await sendText(
      client,
      user.wa_id,
      `${limitText} Tidak perlu kirim ulang ya.`,
    );
    return true;
  }

  const visit = POSTPARTUM_VISIT_BY_CODE.get(visitLog.visit_code) || {
    label: visitLog.visit_label || visitLog.visit_code,
  };

  if (response === "Sudah") {
    await sendText(
      client,
      user.wa_id,
      visitLog.visit_code === "KF4"
        ? `Terima kasih, jawaban ${visit.label} sudah dicatat.`
        : `Terima kasih, jawaban ${visit.label} sudah dicatat. Tetap lanjutkan kunjungan berikutnya sesuai jadwal ya.`,
    );
    if (visitLog.visit_code === "KF4") {
      await completeUserAfterFinalPostpartumVisit(db, client, user);
    }
  } else {
    await sendText(
      client,
      user.wa_id,
      `Baik, jawaban ${visit.label} sudah dicatat. Mohon segera lakukan kunjungan ke tenaga kesehatan/fasilitas kesehatan.\nInfo lanjutan: ${DELIVERY_ARTICLE_URL}`,
    );
  }
  return true;
}

async function handleOnboardingAnswer(db, client, user, text) {
  const step = user.onboarding_step;
  const question = QUESTIONS[step - 1];

  if (!question) {
    await updateUser(db, user.wa_id, {
      status: "active",
      onboarding_step: 0,
    });
    return;
  }

  if (!text) {
    await sendText(
      client,
      user.wa_id,
      "Jawaban belum terbaca. Bisa diulang ya?",
    );
    return;
  }

  const updates = {};

  if (question.type === "yesno") {
    const yesNo = parseYesNo(text);
    if (yesNo === null) {
      await sendText(client, user.wa_id, "Jawab dengan *ya* atau *tidak* ya.");
      return;
    }
    updates[question.field] = yesNo ? 1 : 0;

    if (question.field === "allow_remindcare" && !yesNo) {
      await updateUser(db, user.wa_id, {
        ...updates,
        status: "active",
        onboarding_step: 0,
        reminder_time: null,
      });
      await sendText(
        client,
        user.wa_id,
        "Baik, RemindCare tidak akan mengingatkan dulu. Kalau berubah pikiran, ketik start. 👍",
      );
      return;
    }
  } else if (question.type === "time") {
    const time = normalizeTimeInput(text);
    if (!time) {
      await sendText(
        client,
        user.wa_id,
        "Format jam belum sesuai. Contoh: 17:00.",
      );
      return;
    }
    updates[question.field] = time;
  } else if (question.field === "hpht") {
    const parsed = parseHpht(text);
    if (!parsed.iso) {
      await sendText(
        client,
        user.wa_id,
        "Format HPHT belum sesuai. Contoh: 31-01-2024. \u{1F4C5}",
      );
      return;
    }
    if (
      DateTime.fromISO(parsed.iso, { zone: TIMEZONE }) > nowWib().startOf("day")
    ) {
      await sendText(
        client,
        user.wa_id,
        "Tanggal HPHT belum boleh di masa depan. Isi tanggal hari pertama haid terakhir yang sudah lewat. Contoh: 31-01-2024. \u{1F4C5}",
      );
      return;
    }
    updates.hpht = parsed.raw;
    updates.hpht_iso = parsed.iso;
  } else {
    updates[question.field] = text.trim();
  }

  const nextStep = step + 1;

  if (nextStep > QUESTIONS.length) {
    const now = nowWib();
    const reminderTime = updates.reminder_time || user.reminder_time;
    const shouldSkip = reminderTime
      ? shouldSkipToday(reminderTime, now)
      : false;
    const lastReminderDate = shouldSkip ? toDateKey(now) : null;

    await updateUser(db, user.wa_id, {
      ...updates,
      status: "active",
      onboarding_step: 0,
      last_reminder_date: lastReminderDate,
    });

    const finalTime = updates.reminder_time || user.reminder_time;
    await sendText(
      client,
      user.wa_id,
      `Siap! RemindCare akan mengingatkan setiap hari jam ${finalTime} WIB. ⏰✨`,
    );
    return;
  }

  await updateUser(db, user.wa_id, { ...updates, onboarding_step: nextStep });
  await sendText(
    client,
    user.wa_id,
    `Pertanyaan ${nextStep} dari ${QUESTIONS.length}\n\n${QUESTIONS[nextStep - 1].text}`,
  );
}

async function handleCommand(db, client, user, text) {
  if (!text) {
    return false;
  }

  if (await handleAdminCommand(db, client, user, text)) {
    return true;
  }

  const normalized = text.trim().toLowerCase();
  const isCancelCmd = isCancelCommand(normalized);
  const isDeleteCmd = /^(delete|hapus)$/.test(normalized);
  const isEditDataCmd = isEditDataCommand(normalized);
  const isEditDeliveryCmd = isEditDeliveryCommand(normalized);
  const isDeliveryCheckCmd = isDeliveryCheckCommand(normalized);
  const isEditMenuCmd = isEditMenuCommand(normalized);

  if (!isCancelCmd && !isDeleteCmd && !isEditDataCmd && !isEditDeliveryCmd) {
    clearPendingConfirmation(user.wa_id);
  }

  if (isCancelCmd) {
    const cleared = clearPendingConfirmation(user.wa_id);
    const deliveryStep = Number(user.delivery_data_step || 0);
    if (!cleared && Number.isFinite(deliveryStep) && deliveryStep > 0) {
      await updateUser(db, user.wa_id, { delivery_data_step: 0 });
      await sendText(
        client,
        user.wa_id,
        "Baik, pendataan persalinan dihentikan. Jawaban yang sudah masuk tetap tersimpan.\nKetik *edit persalinan* kalau mau mengisi ulang dari awal.",
      );
      return true;
    }
    await sendText(
      client,
      user.wa_id,
      cleared
        ? "Baik, konfirmasi edit/hapus dibatalkan."
        : "Tidak ada konfirmasi atau pendataan yang perlu dibatalkan saat ini.",
    );
    return true;
  }

  if (/^(help|menu)$/.test(normalized)) {
    await sendText(
      client,
      user.wa_id,
      `Menu:\n*start* - aktifkan pengingat\n*stop* - hentikan semua pengingat\n*ubah jam 17:00* - ganti jam pengingat\n*info* - ringkasan data dan jadwal pengingat\n*cek persalinan* - tanya status persalinan\n*edit* - daftar perintah edit data\n*batal* - batalkan konfirmasi atau pendataan yang sedang jalan\n*about* - info singkat\n*website* - alamat website\n*delete* - hapus akun`,
    );
    return true;
  }

  if (/^(info|informasi)$/.test(normalized)) {
    const postpartumLogs = await getPostpartumVisitLogs(db, user.wa_id);
    const infoText = buildUserInfoMessage(user, postpartumLogs, nowWib());
    await sendText(client, user.wa_id, infoText);
    return true;
  }

  if (isEditMenuCmd) {
    await sendText(
      client,
      user.wa_id,
      "Perintah edit:\n*edit data* untuk isi ulang semua data dari awal.\n*edit persalinan* untuk isi ulang data persalinan.\n\nPerintah persalinan:\n*cek persalinan* untuk konfirmasi apakah Ibu sudah melahirkan.",
    );
    return true;
  }

  if (isDeliveryCheckCmd) {
    if (!user.hpht_iso) {
      await sendText(
        client,
        user.wa_id,
        "Data kehamilan belum lengkap. Lengkapi dulu ya, lalu nanti cek lagi status persalinannya.",
      );
      return true;
    }

    const deliveryStep = Number(user.delivery_data_step || 0);
    if (Number.isFinite(deliveryStep) && deliveryStep > 0) {
      const currentQuestion = DELIVERY_QUESTIONS[deliveryStep - 1];
      await sendText(
        client,
        user.wa_id,
        currentQuestion
          ? `Data persalinan sedang diisi. Lanjutkan dari pertanyaan ini ya:\n${currentQuestion.text}`
          : "Data persalinan sedang diisi. Lanjutkan jawaban berikutnya ya.",
      );
      return true;
    }

    if (isPostpartumMonitoringActive(user)) {
      await sendText(
        client,
        user.wa_id,
        "Data persalinan sudah tercatat. Jika ada perubahan, ketik *edit persalinan* untuk isi ulang dari awal.",
      );
      return true;
    }

    if (hasAnyDeliveryRecord(user)) {
      await sendText(
        client,
        user.wa_id,
        "Data persalinan sudah pernah tercatat sebagian. Jika mau isi ulang, ketik *edit persalinan*.",
      );
      return true;
    }

    const sent = await sendDeliveryValidationPoll(
      db,
      client,
      user,
      nowWib(),
      "manual",
    );
    if (!sent) {
      await sendText(
        client,
        user.wa_id,
        "Pertanyaan persalinan belum berhasil dikirim. Coba lagi sebentar ya.",
      );
    }
    return true;
  }

  if (isEditDataCmd) {
    const confirmed = checkEditConfirmation(user.wa_id, "data");
    if (!confirmed) {
      await sendText(
        client,
        user.wa_id,
        "Perintah ini akan mengosongkan jawaban profil, kehamilan, dan persalinan lalu mulai dari pertanyaan pertama.\nKetik *edit data* sekali lagi dalam 5 menit untuk lanjut, atau ketik *batal*.",
      );
      return true;
    }
    await restartUserDataFromBeginning(db, user.wa_id);
    clearPendingConfirmation(user.wa_id);
    await sendText(
      client,
      user.wa_id,
      "Baik, data direset. Kita isi ulang dari awal ya.",
    );
    await sendText(client, user.wa_id, QUESTIONS[0].text);
    return true;
  }

  if (isEditDeliveryCmd) {
    if (!hasAnyDeliveryRecord(user)) {
      await sendText(
        client,
        user.wa_id,
        "Data persalinan belum ada untuk diedit. Nanti setelah ada konfirmasi melahirkan, data persalinan bisa diisi.",
      );
      return true;
    }
    const confirmed = checkEditConfirmation(user.wa_id, "delivery");
    if (!confirmed) {
      await sendText(
        client,
        user.wa_id,
        "Perintah ini akan mengosongkan data persalinan dan jadwal kunjungan nifas yang sudah dibuat.\nKetik *edit persalinan* sekali lagi dalam 5 menit untuk lanjut, atau ketik *batal*.",
      );
      return true;
    }
    clearPendingConfirmation(user.wa_id);
    await sendText(
      client,
      user.wa_id,
      "Baik, kita isi ulang data persalinan dari awal.",
    );
    await startDeliveryDataCollection(db, client, user);
    return true;
  }

  if (/^about$/.test(normalized)) {
    await sendText(
      client,
      user.wa_id,
      "RemindCare adalah tugas akhir mahasiswa Poltekkes Kemenkes Tasikmalaya jurusan kebidanan (Melva). Info dan kontak: remindcares.web.app",
    );
    return true;
  }

  if (/^website$/.test(normalized)) {
    await sendText(client, user.wa_id, "Website kami: remindcares.web.app");
    return true;
  }

  if (isDeleteCmd) {
    const confirmed = checkDeleteConfirmation(user.wa_id);
    if (!confirmed) {
      await sendText(
        client,
        user.wa_id,
        "Perintah ini menghapus data profil, kehamilan, persalinan, dan seluruh riwayat jawaban Ibu secara permanen dan tidak bisa dikembalikan.\nKetik *delete* sekali lagi dalam 5 menit untuk lanjut, atau ketik *batal*.",
      );
      return true;
    }
    clearPendingConfirmation(user.wa_id);
    await deleteUserData(db, user.wa_id);
    await sendText(
      client,
      user.wa_id,
      "Akun Ibu sudah dihapus. Kalau mau pakai lagi, cukup kirim pesan lagi ya.",
    );
    return true;
  }

  if (/^(stop|berhenti)$/.test(normalized)) {
    await updateUser(db, user.wa_id, { allow_remindcare: 0, status: "paused" });
    await sendText(
      client,
      user.wa_id,
      "Oke, semua pengingat dihentikan dulu. Ini termasuk pengingat tablet FE, validasi persalinan, kunjungan nifas.\nKetik *start* kapan saja kalau mau aktif lagi. \u23f8\ufe0f",
    );
    return true;
  }

  if (/^(start|mulai)$/.test(normalized)) {
    if (user.status === "completed") {
      await sendText(
        client,
        user.wa_id,
        "Program RemindCare untuk kehamilan ini sudah selesai, jadi pengingatnya tidak diaktifkan lagi.\nKalau ada kehamilan baru, ketik *edit data* untuk isi ulang dari awal.",
      );
      return true;
    }
    if (!user.reminder_time) {
      await updateUser(db, user.wa_id, {
        allow_remindcare: 1,
        status: "onboarding",
        onboarding_step: 9,
      });
      await sendText(client, user.wa_id, QUESTIONS[8].text);
      return true;
    }

    await updateUser(db, user.wa_id, {
      allow_remindcare: 1,
      status: "active",
    });
    await sendText(
      client,
      user.wa_id,
      `Siap, RemindCare aktif lagi jam ${user.reminder_time} WIB. ✅⏰`,
    );
    return true;
  }

  if (/^(ubah|set)\s+jam\b/.test(normalized) || /^jam\b/.test(normalized)) {
    const match = normalized.match(/(?:ubah|set)?\s*jam\s*(.*)$/);
    const timeInput = match && match[1] ? match[1] : "";
    const time = normalizeTimeInput(timeInput);
    if (!time) {
      await sendText(
        client,
        user.wa_id,
        "Format jam belum sesuai. Contoh: ubah jam 17:00.",
      );
      return true;
    }
    await updateUser(db, user.wa_id, {
      reminder_time: time,
      allow_remindcare: 1,
      status: "active",
    });
    await sendText(
      client,
      user.wa_id,
      `Jam pengingat diubah ke ${time} WIB. ✅⏰`,
    );
    return true;
  }

  return false;
}

async function handleDailyResponse(db, client, user, response) {
  const dateKey = toDateKey(nowWib());
  const result = await recordDailyResponse(db, user.wa_id, dateKey, response);
  if (!result.allowed) {
    const limitText =
      result.limit === null
        ? "Jawaban sudah tercatat sebelumnya."
        : `Jawaban ${response.toLowerCase()} sudah mencapai batas ${result.limit}x hari ini.`;
    await sendText(
      client,
      user.wa_id,
      `${limitText} Tidak perlu kirim ulang ya.`,
    );
    return;
  }

  if (response === "Sudah") {
    await sendText(
      client,
      user.wa_id,
      "Terima kasih. Semoga sehat selalu. 🌼",
    );
  } else if (response === "Belum") {
    await sendText(
      client,
      user.wa_id,
      "Baik, jangan lupa diminum ya. 💊🙂",
    );
  }
}

function isDuplicateMessage(msgId) {
  if (!msgId) {
    return false;
  }
  const nowMs = Date.now();
  const lastSeen = processedMessageIds.get(msgId);
  if (lastSeen && nowMs - lastSeen < PROCESSED_MESSAGE_TTL_MS) {
    return true;
  }
  processedMessageIds.set(msgId, nowMs);
  if (processedMessageIds.size > 2000) {
    for (const [id, ts] of processedMessageIds) {
      if (nowMs - ts >= PROCESSED_MESSAGE_TTL_MS) {
        processedMessageIds.delete(id);
      }
    }
  }
  return false;
}

async function handleMessage(db, client, msg) {
  if (msg.fromMe) {
    return;
  }
  if (msg.from.endsWith("@g.us") || msg.isStatus) {
    return;
  }
  const msgId = msg && msg.id ? String(msg.id._serialized || "") : "";
  if (isDuplicateMessage(msgId)) {
    return;
  }

  const text = msg.body ? msg.body.trim() : "";
  const identity = await resolveSenderIdentity(db, client, msg);
  const waId = identity.waId;
  const rawWaId = identity.raw;
  const alternates = identity.aliases;
  rememberAlternates(waId, alternates);
  if (isUnsupportedDirectTarget(waId)) {
    return;
  }
  if (!text && msg.hasMedia) {
    await sendText(
      client,
      waId,
      "Aku belum bisa membaca pesan suara atau gambar. Tolong ketik jawabannya ya.",
    );
    return;
  }
  const rateCheck = checkRateLimit(waId);
  if (!rateCheck.allowed) {
    if (rateCheck.warn) {
      await sendText(
        client,
        waId,
        "Terlalu banyak pesan. Coba lagi sebentar. ⏳",
      );
    }
    return;
  }

  const identityIds = [waId, rawWaId].filter(Boolean);
  const seed = {
    is_admin: identityIds.some((id) => ADMIN_WA_IDS.has(id)),
    is_allowed: identityIds.some((id) => ALLOWLIST_WA_IDS.has(id)),
  };
  const existingUser = await getUser(db, waId);
  if (
    !existingUser &&
    isAllowlistEnforced() &&
    !seed.is_allowed &&
    !seed.is_admin
  ) {
    await sendText(
      client,
      waId,
      "Nomor ini belum diizinkan. Hubungi admin. 🚫",
    );
    return;
  }
  if (!existingUser && !/^(start|mulai)$/.test(text.trim().toLowerCase())) {
    await sendText(
      client,
      waId,
      "Halo! 👋\nAku RemindCare, pengingat untuk menemani perjalanan ibu dari kehamilan, persalinan, masa nifas, hingga perawatan bayi. 🤍\n\nUntuk mulai, ketik *start* ya. ✨",
    );
    return;
  }

  const { user, isNew } = await ensureUser(db, waId, seed);

  if (user.is_blocked) {
    return;
  }

  if (isAllowlistEnforced() && !user.is_allowed && !user.is_admin) {
    await sendText(
      client,
      waId,
      "Nomor ini belum diizinkan. Hubungi admin. 🚫",
    );
    return;
  }

  if (isNew) {
    // Nomor/sesi baru yang langsung melayani banyak pendaftar adalah skenario blokir
    // paling umum, jadi jumlah user baru dibatasi sampai sesi cukup matang.
    const dailyLimit = Math.max(1, settingInt("onboarding_daily_limit"));
    const createdToday = await dbGet(
      db,
      "SELECT COUNT(*) AS c FROM users WHERE substr(created_at, 1, 10) = ?",
      [toDateKey(nowWib())],
    );
    const countToday = createdToday ? createdToday.c : 0;
    if (countToday > dailyLimit) {
      await sendText(
        client,
        waId,
        "Pendaftaran hari ini sudah penuh supaya pengiriman tetap aman. Coba lagi besok ya.",
      );
      await updateUser(db, waId, { status: "paused", allow_remindcare: 0 });
      sendAlert("pendaftaran-dibatasi", `User baru hari ini ${countToday}, batas ${dailyLimit}.`);
      return;
    }
    await sendText(
      client,
      waId,
      `Pertanyaan 1 dari ${QUESTIONS.length}\n\n${QUESTIONS[0].text}`,
    );
    return;
  }

  if (user.status === "onboarding" && isAlwaysCommand(text)) {
    if (await handleCommand(db, client, user, text)) {
      return;
    }
  }

  if (user.status === "onboarding") {
    if (!isAlwaysCommand(text)) {
      clearPendingConfirmation(user.wa_id);
    }
    await handleOnboardingAnswer(db, client, user, text);
    return;
  }

  const correction = parsePostpartumCorrection(text);
  if (correction && (await applyPostpartumCorrection(db, client, user, correction))) {
    return;
  }

  if (await handleCommand(db, client, user, text)) {
    return;
  }

  if (isGreeting(text)) {
    await sendText(
      client,
      waId,
      `Halo, ${getDisplayName(user)}. Aku RemindCare, pengingat tablet FE, persalinan, dan kunjungan nifas. Ketik *menu* untuk lihat perintah yang tersedia.`,
    );
    return;
  }

  if (Number(user.delivery_data_step || 0) > 0) {
    await handleDeliveryDataAnswer(db, client, user, text);
    return;
  }

  const deliveryValidationAnswer = parseDeliveryValidationAnswer(text);
  const pendingDeliveryStage = getPendingDeliveryPollStage(user);
  if (deliveryValidationAnswer && pendingDeliveryStage) {
    await handleDeliveryValidationResponse(
      db,
      client,
      user,
      deliveryValidationAnswer,
      pendingDeliveryStage,
    );
    return;
  }


  const pollAnswer = parsePollAnswer(text);
  if (pollAnswer) {
    const today = toDateKey(nowWib());
    const feAnsweredToday = user.last_reminder_date === today;
    const pendingPostpartumLog = await getLatestPendingPostpartumVisitLog(
      db,
      waId,
    );
    // Satu kata sudah atau belum bisa cocok untuk beberapa pertanyaan yang masih terbuka.
    // Aturan yang dipakai: pertanyaan yang belum dijawab menang atas pengingat tablet FE
    // yang sudah dikirim hari ini, supaya jawaban kunjungan nifas tidak tercatat sebagai
    // jawaban tablet FE.
    if (feAnsweredToday && pendingPostpartumLog) {
      await handlePostpartumVisitResponse(
        db,
        client,
        user,
        pendingPostpartumLog,
        pollAnswer,
      );
      return;
    }
    if (feAnsweredToday) {
      await handleDailyResponse(db, client, user, pollAnswer);
      return;
    }
    if (pendingPostpartumLog) {
      await handlePostpartumVisitResponse(
        db,
        client,
        user,
        pendingPostpartumLog,
        pollAnswer,
      );
      return;
    }

    await sendText(
      client,
      waId,
      "Belum ada pertanyaan aktif hari ini. Ketik *menu* untuk lihat perintah yang tersedia.",
    );
    return;
  }

  const fallbackText = isPostpartumMonitoringActive(user)
    ? "Aku belum paham pesan itu. Untuk lihat status kunjungan nifas, ketik *info* atau *menu*."
    : "Aku belum paham pesan itu. Untuk lihat jadwal dan status pengingat, ketik *info* atau *menu*.";
  await sendText(client, waId, fallbackText);
}

async function handleVoteUpdate(db, client, vote) {
  const waId = vote.voter;
  if (isUnsupportedDirectTarget(waId)) {
    return;
  }
  const user = await getUser(db, waId);
  if (!user) {
    return;
  }

  if (user.is_blocked) {
    return;
  }

  const rateCheck = checkRateLimit(waId);
  if (!rateCheck.allowed) {
    if (rateCheck.warn) {
      await sendText(
        client,
        waId,
        "Terlalu banyak pesan. Coba lagi sebentar. ⏳",
      );
    }
    return;
  }

  if (isAllowlistEnforced() && !user.is_allowed && !user.is_admin) {
    return;
  }

  const pollMessageId =
    vote.parentMessage && vote.parentMessage.id
      ? vote.parentMessage.id._serialized
      : null;

  if (!vote.selectedOptions || vote.selectedOptions.length === 0) {
    return;
  }

  const response = parsePollAnswer(vote.selectedOptions[0].name);
  if (!response) {
    return;
  }

  if (
    user.last_delivery_poll_message_id &&
    pollMessageId &&
    user.last_delivery_poll_message_id === pollMessageId
  ) {
    await handleDeliveryValidationResponse(
      db,
      client,
      user,
      response,
      getPendingDeliveryPollStage(user),
    );
    return;
  }

  const postpartumLog = await getPostpartumVisitLogByPollMessageId(
    db,
    waId,
    pollMessageId,
  );
  if (postpartumLog) {
    await handlePostpartumVisitResponse(
      db,
      client,
      user,
      postpartumLog,
      response,
    );
    return;
  }

  const isFePoll =
    user.last_poll_message_id &&
    pollMessageId &&
    user.last_poll_message_id === pollMessageId;
  if (!isFePoll) {
    return;
  }

  await handleDailyResponse(db, client, user, response);
}

// Anggaran percobaan kirim per user per hari per jenis pengingat. Tanpa batas ini,
// nomor yang gagal dicoba ulang setiap 30 menit sepanjang hari.
const sendAttemptBudget = new Map();

function takeSendAttempt(waId, kind, dateKey, max = null) {
  const limit = Number.isFinite(Number(max)) && Number(max) > 0
    ? Math.round(Number(max))
    : getMaxSendAttempts();
  const key = `${waId}:${kind}:${dateKey}`;
  const used = sendAttemptBudget.get(key) || 0;
  if (used >= limit) {
    return false;
  }
  sendAttemptBudget.set(key, used + 1);
  if (sendAttemptBudget.size > 2000) {
    for (const existing of sendAttemptBudget.keys()) {
      if (!existing.endsWith(dateKey)) {
        sendAttemptBudget.delete(existing);
      }
    }
  }
  return true;
}

function isPermanentSendFailure(waId) {
  const info = sendGuard.lastErrorFor(waId);
  return Boolean(info && info.permanent);
}

// Kuota pengiriman terjadwal per user per hari. Pada fase transisi (hamil tua, persalinan,
// nifas) satu user bisa menerima beberapa pesan dalam jendela yang sama, dan lonjakan ke
// satu orang mudah dilaporkan sebagai spam.
const scheduledSendCount = new Map();

function noteScheduledSend(waId, dateKey) {
  const key = `${waId}:${dateKey}`;
  scheduledSendCount.set(key, (scheduledSendCount.get(key) || 0) + 1);
  if (scheduledSendCount.size > 2000) {
    for (const existing of scheduledSendCount.keys()) {
      if (!existing.endsWith(dateKey)) {
        scheduledSendCount.delete(existing);
      }
    }
  }
}

function getScheduledSendCount(waId, dateKey) {
  return scheduledSendCount.get(`${waId}:${dateKey}`) || 0;
}

function isOverDailyMessageQuota(user, dateKey) {
  return (
    getScheduledSendCount(user.wa_id, dateKey) >=
    Math.max(1, settingInt("max_messages_per_user_per_day"))
  );
}

function getReminderLoopConcurrency() {
  if (!Number.isFinite(REMINDER_LOOP_CONCURRENCY)) {
    return 10;
  }
  const rounded = Math.floor(REMINDER_LOOP_CONCURRENCY);
  if (rounded <= 0) {
    return 1;
  }
  return rounded;
}

async function processUserReminderTick(db, client, user, now, today) {
  if (isAllowlistEnforced() && !user.is_allowed && !user.is_admin) {
    return;
  }

  const quotaReached = () => isOverDailyMessageQuota(user, today);

  const inPreReminderWindow = shouldSendBeforeReminder(
    user.reminder_time,
    now,
    2,
  );
  const canSendMainReminder = shouldSendNow(user.reminder_time, now);
  const postpartumActive = isPostpartumMonitoringActive(user);
  const deliveryConfirmed = hasConfirmedDelivery(user);
  const collectingDeliveryData =
    Number.isFinite(Number(user.delivery_data_step)) &&
    Number(user.delivery_data_step) > 0;
  if (
    postpartumActive &&
    (await hasCompletedFinalPostpartumVisit(db, user.wa_id))
  ) {
    await completeUserAfterFinalPostpartumVisit(db, client, user);
    return;
  }

  if (postpartumActive && inPreReminderWindow && !quotaReached()) {
    await processPostpartumVisitReminders(db, client, user, now);
  }

  const deliveryStage = getDeliveryValidationStageDue(user, now);
  if (
    inPreReminderWindow &&
    deliveryStage &&
    user.last_reminder_date !== today &&
    !quotaReached()
  ) {
    await sendDeliveryValidationPoll(db, client, user, now, deliveryStage);
  }


  if (!canSendMainReminder) {
    return;
  }

  // Satu hari dalam seminggu tanpa pengingat tablet FE. Pola harian pada jam yang sama,
  // tanpa jeda, mudah dikenali sebagai automation. Hari ini ditandai selesai supaya
  // tidak menumpuk dan tidak dikejar di tick berikutnya.
  const skipWeekday = settingInt("reminder_skip_weekday");
  if (skipWeekday >= 1 && skipWeekday <= 7 && now.weekday === skipWeekday) {
    if (user.last_reminder_date !== today) {
      await updateUser(db, user.wa_id, { last_reminder_date: today });
    }
    return;
  }

  if (quotaReached()) {
    return;
  }

  if (
    !isPregnancyActive(user, now) &&
    !postpartumActive &&
    deliveryConfirmed &&
    !collectingDeliveryData
  ) {
    await updateUser(db, user.wa_id, {
      status: "completed",
      allow_remindcare: 0,
    });
    await sendText(
      client,
      user.wa_id,
      "Masa pengingat kehamilan sudah selesai. Jika ingin lanjut, balas start.",
    );
    return;
  }

  await sendLaborPhaseMessage(db, client, user, now);

  const deliveryValidationActive = isDeliveryValidationActive(user, now);

  if (user.last_reminder_date === today) {
    return;
  }

  await sendDailyPoll(db, client, user, now, {
    skipReminderText: deliveryValidationActive,
  });
}

async function startReminderLoop(db, client) {
  const timer = setInterval(async () => {
    if (reminderLoopRunning) {
      return;
    }
    reminderLoopRunning = true;
    try {
      // Pengiriman terjadwal tidak boleh keluar di luar jam kirim maupun saat circuit
      // breaker aktif; keduanya tanda nomor perlu istirahat.
      if (settingBool("maintenance_mode")) {
        return;
      }
      if (!sendGuard.isWithinSendWindow()) {
        return;
      }
      if (sendGuard.isPaused()) {
        console.warn("Pengiriman dijeda (circuit breaker), tick pengingat dilewati.");
        return;
      }
      const guardStats = sendGuard.stats();
      if (guardStats.breakerTrips > lastBreakerTrips) {
        lastBreakerTrips = guardStats.breakerTrips;
        sendAlert(
          "circuit-breaker",
          `Pengiriman dijeda otomatis setelah ${guardStats.permanentFailures} kegagalan permanen.`,
        );
      }
      const now = nowWib();
      const today = toDateKey(now);

      if (lastCleanupDate !== today) {
        try {
          await purgeOldLogs(db, REMINDER_LOG_RETENTION_DAYS, now);
        } catch (err) {
          console.error("Gagal membersihkan log lama:", err);
        }
        lastCleanupDate = today;
      }

      const users = await dbAll(
        db,
        `SELECT * FROM users
         WHERE status = 'active'
         AND allow_remindcare = 1
         AND reminder_time IS NOT NULL
         AND is_blocked = 0`,
      );

      const concurrency = getReminderLoopConcurrency();
      for (let i = 0; i < users.length; i += concurrency) {
        const chunk = users.slice(i, i + concurrency);
        await Promise.all(
          chunk.map(async (user) => {
            try {
              await processUserReminderTick(db, client, user, now, today);
            } catch (err) {
              console.error("Gagal memproses reminder user:", user.wa_id, err);
            }
          }),
        );
      }
    } catch (err) {
      console.error("Gagal menjalankan pengingat:", err);
    } finally {
      reminderLoopRunning = false;
    }
  }, 30000);
  return timer;
}

// Aksi operator per user dari admin web. Semua aksi di sini mengubah satu user saja
// dan hasilnya dikembalikan ke pemanggil supaya bisa ditampilkan ke operator.
async function applyAdminUserAction(db, user, action, value) {
  if (action === "set_reminder_time") {
    const normalized = normalizeTimeInput(value);
    if (!normalized) {
      return { ok: false, error: "Format jam tidak sah, contoh: 19:30" };
    }
    await updateUser(db, user.wa_id, {
      reminder_time: normalized,
      allow_remindcare: 1,
      status: "active",
    });
    return { ok: true, action, reminder_time: normalized };
  }
  if (action === "pause") {
    await updateUser(db, user.wa_id, {
      allow_remindcare: 0,
      status: "paused",
    });
    return { ok: true, action, status: "paused" };
  }
  if (action === "resume") {
    await updateUser(db, user.wa_id, {
      allow_remindcare: 1,
      status: "active",
    });
    return { ok: true, action, status: "active" };
  }
  if (action === "complete") {
    await updateUser(db, user.wa_id, {
      allow_remindcare: 0,
      status: "completed",
    });
    return { ok: true, action, status: "completed" };
  }
  if (action === "unblock") {
    await updateUser(db, user.wa_id, {
      is_blocked: 0,
      allow_remindcare: 1,
      status: "active",
    });
    return { ok: true, action, status: "active" };
  }
  if (action === "clear_send_failures") {
    await updateUser(db, user.wa_id, {
      fe_poll_fail_count: 0,
      delivery_poll_fail_count: 0,
    });
    return { ok: true, action };
  }
  if (action === "delete_data") {
    if (String(value || "") !== "HAPUS") {
      return { ok: false, error: "Konfirmasi salah. Isi nilai HAPUS untuk menghapus data." };
    }
    await dbRun(db, "DELETE FROM postpartum_visit_logs WHERE wa_id = ?", [
      user.wa_id,
    ]);
    await dbRun(db, "DELETE FROM reminder_logs WHERE wa_id = ?", [user.wa_id]);
    await dbRun(db, "DELETE FROM users WHERE wa_id = ?", [user.wa_id]);
    console.warn("Data user dihapus atas permintaan operator:", user.wa_id);
    return { ok: true, action, deleted: user.wa_id };
  }
  return { ok: false, error: "Aksi tidak dikenal" };
}

// Pengaturan yang bisa diubah operator tanpa menyentuh kode dan tanpa restart.
// Setiap kunci punya tipe dan rentang yang sah: nilai di luar rentang ditolak,
// karena pengaturan yang salah justru bisa mematikan pengaman pengiriman.
// Nilai fallback di bawah WAJIB membaca env yang sama dengan lapisan pengiriman.
// Sebelumnya angka di sini ditulis tetap, sehingga nilai SEND_* di .env ditimpa
// diam-diam saat start dan operator mengira sudah menurunkan kuota padahal belum.
function envNumber(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const RUNTIME_SETTING_DEFS = {
  send_window_start_hour: { type: "int", min: 0, max: 23, fallback: envNumber("SEND_WINDOW_START_HOUR", 6), guardKey: "windowStartHour" },
  send_window_end_hour: { type: "int", min: 0, max: 23, fallback: envNumber("SEND_WINDOW_END_HOUR", 21), guardKey: "windowEndHour" },
  send_window_end_minute: { type: "int", min: 0, max: 59, fallback: envNumber("SEND_WINDOW_END_MINUTE", 30), guardKey: "windowEndMinute" },
  send_min_gap_ms: { type: "int", min: 1500, max: 60000, fallback: envNumber("SEND_MIN_GAP_MS", 3500), guardKey: "minGapMs" },
  send_jitter_ms: { type: "int", min: 0, max: 60000, fallback: envNumber("SEND_JITTER_MS", 2500), guardKey: "jitterMs" },
  send_max_per_minute: { type: "int", min: 1, max: 60, fallback: envNumber("SEND_MAX_PER_MINUTE", 12), guardKey: "maxPerMinute" },
  send_max_per_hour: { type: "int", min: 1, max: 1000, fallback: envNumber("SEND_MAX_PER_HOUR", 180), guardKey: "maxPerHour" },
  send_max_per_day: { type: "int", min: 1, max: 5000, fallback: envNumber("SEND_MAX_PER_DAY", 900), guardKey: "maxPerDay" },
  reminder_stale_after_minutes: { type: "int", min: 0, max: 720, fallback: envNumber("REMINDER_STALE_AFTER_MINUTES", 30) },
  max_send_attempts: { type: "int", min: 1, max: 20, fallback: envNumber("MAX_SEND_ATTEMPTS", 4) },
  reminder_log_retention_days: { type: "int", min: 7, max: 3650, fallback: envNumber("REMINDER_LOG_RETENTION_DAYS", 180) },
  enforce_allowlist: { type: "bool", fallback: ENFORCE_ALLOWLIST ? 1 : 0 },
  maintenance_mode: { type: "bool", fallback: 0 },
  dry_run: { type: "bool", fallback: 0 },
  emergency_pause_until: { type: "text", fallback: "" },
  onboarding_daily_limit: { type: "int", min: 1, max: 500, fallback: 20 },
  max_messages_per_user_per_day: { type: "int", min: 1, max: 20, fallback: 3 },
  poll_days_limit: { type: "int", min: 1, max: 365, fallback: 14 },
  reminder_skip_weekday: { type: "int", min: -1, max: 7, fallback: 7 },
};

const runtimeSettings = {};

function settingFallback(key) {
  const def = RUNTIME_SETTING_DEFS[key];
  return def ? def.fallback : null;
}

function coerceSetting(key, rawValue) {
  const def = RUNTIME_SETTING_DEFS[key];
  if (!def) {
    return { ok: false, error: `Pengaturan tidak dikenal: ${key}` };
  }
  if (def.type === "text") {
    return { ok: true, value: rawValue === null || rawValue === undefined ? "" : String(rawValue).trim() };
  }
  if (def.type === "bool") {
    const normalized = /^(1|true|ya|on)$/i.test(String(rawValue));
    return { ok: true, value: normalized ? 1 : 0 };
  }
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return { ok: false, error: `${key} harus angka` };
  }
  const rounded = Math.round(numeric);
  if (rounded < def.min || rounded > def.max) {
    return {
      ok: false,
      error: `${key} harus di antara ${def.min} dan ${def.max}`,
    };
  }
  return { ok: true, value: rounded };
}

function settingValue(key) {
  if (runtimeSettings[key] !== undefined) {
    return runtimeSettings[key];
  }
  return settingFallback(key);
}

function settingInt(key) {
  const value = Number(settingValue(key));
  return Number.isFinite(value) ? value : Number(settingFallback(key));
}

function settingBool(key) {
  return Boolean(Number(settingValue(key)));
}

function isAllowlistEnforced() {
  return settingBool("enforce_allowlist");
}

function getMaxSendAttempts() {
  return Math.max(1, settingInt("max_send_attempts"));
}

function getReminderStaleMinutes() {
  return Math.max(0, settingInt("reminder_stale_after_minutes"));
}

// Terapkan pengaturan ke guard pengiriman. Dipanggil saat start dan setiap kali
// pengaturan berubah dari halaman admin.
function applyGuardSettings() {
  const partial = {};
  for (const [key, def] of Object.entries(RUNTIME_SETTING_DEFS)) {
    if (def.guardKey) {
      partial[def.guardKey] = settingInt(key);
    }
  }
  sendGuard.setRuntimeConfig(partial);
  sendGuard.setDryRun(settingBool("dry_run"));
  const pauseUntil = String(settingValue("emergency_pause_until") || "");
  if (pauseUntil) {
    const until = DateTime.fromISO(pauseUntil, { zone: TIMEZONE });
    if (until.isValid && until > nowWib()) {
      const remaining = until.toMillis() - nowWib().toMillis();
      sendGuard.pause(remaining, "jeda darurat dari operator");
    }
  }
}

async function loadRuntimeSettings(db) {
  for (const key of Object.keys(RUNTIME_SETTING_DEFS)) {
    const stored = await getSetting(db, key, null);
    if (stored === null || stored === undefined || stored === "") {
      delete runtimeSettings[key];
      continue;
    }
    const coerced = coerceSetting(key, stored);
    if (coerced.ok) {
      runtimeSettings[key] = coerced.value;
    }
  }
  applyGuardSettings();
}

async function saveRuntimeSettings(db, patch) {
  const applied = {};
  const rejected = [];
  for (const [key, rawValue] of Object.entries(patch || {})) {
    const coerced = coerceSetting(key, rawValue);
    if (!coerced.ok) {
      rejected.push(coerced.error);
      continue;
    }
    runtimeSettings[key] = coerced.value;
    applied[key] = coerced.value;
    await setSetting(db, key, coerced.value);
  }
  applyGuardSettings();
  return { applied, rejected };
}

function settingsSnapshot() {
  const values = {};
  for (const [key, def] of Object.entries(RUNTIME_SETTING_DEFS)) {
    values[key] = settingValue(key);
    values[`${key}__min`] = def.min === undefined ? null : def.min;
    values[`${key}__max`] = def.max === undefined ? null : def.max;
    values[`${key}__type`] = def.type;
  }
  return values;
}

// Alarm: kondisi yang butuh perhatian manusia (sesi putus, breaker jalan, database tidak
// sehat) harus terlihat, bukan hanya tercatat di log yang tidak dibaca.
const alertSentAt = new Map();
let lastAlert = null;

function sendAlert(kind, detail) {
  const cooldownMs = Number(process.env.ALERT_COOLDOWN_MS || 30 * 60 * 1000);
  const nowMs = Date.now();
  const last = alertSentAt.get(kind) || 0;
  if (nowMs - last < cooldownMs) {
    return false;
  }
  alertSentAt.set(kind, nowMs);
  lastAlert = { kind, detail, at: nowWib().toISO() };
  console.error(`ALARM [${kind}] ${detail}`);
  const webhookUrl = String(process.env.ALERT_WEBHOOK_URL || "").trim();
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lastAlert),
    }).catch((err) => {
      console.error("Gagal mengirim alarm ke webhook:", err.message);
    });
  }
  return true;
}

function startAdminServer(db) {
  if (!ADMIN_WEB_ENABLED) {
    return;
  }
  if (!Number.isFinite(ADMIN_WEB_PORT) || ADMIN_WEB_PORT <= 0) {
    console.warn("Admin web tidak dijalankan: port tidak valid.");
    return;
  }

  const passwordConfig = getAdminPasswordConfig();

  const app = express();
  if (ADMIN_WEB_TRUST_PROXY) {
    app.set("trust proxy", true);
  }
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const renderContext = (req, res) => ({
    nonce: res.locals.nonce,
    csrf: req.adminSession ? req.adminSession.csrf : "",
  });

  app.use((req, res, next) => {
    // Nonce dibuat per respons supaya script inline tetap diizinkan tanpa membuka
    // 'unsafe-inline' pada Content-Security-Policy.
    const nonce = crypto.randomBytes(16).toString("base64");
    res.locals.nonce = nonce;
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
    );
    if (ADMIN_WEB_COOKIE_SECURE) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });


  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

  // Semua permintaan yang mengubah keadaan wajib membawa token CSRF milik sesi.
  // Cookie SameSite saja tidak cukup: browser tetap mengirim cookie pada permintaan
  // yang dipicu halaman same-site lain, dan itu cukup untuk menjeda pengiriman bot.
  const requireCsrf = (req, res, next) => {
    if (safeMethods.has(String(req.method || "").toUpperCase())) {
      return next();
    }
    const session = req.adminSession;
    if (!session || !session.csrf) {
      res.status(403).json({ ok: false, error: "csrf" });
      return;
    }
    const sent = String(
      (req.headers && req.headers["x-csrf-token"]) ||
        (req.body && req.body._csrf) ||
        "",
    );
    if (!sent || sent !== session.csrf) {
      res.status(403).json({ ok: false, error: "csrf" });
      return;
    }
    const origin = String((req.headers && req.headers.origin) || "");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch (err) {
        originHost = "";
      }
      if (originHost && originHost !== req.headers.host) {
        res.status(403).json({ ok: false, error: "origin" });
        return;
      }
    }
    return next();
  };

  const requireAdmin = (req, res, next) => {
    const session = getAdminSession(req);
    if (session) {
      req.adminSession = session;
      return next();
    }
    const wantsJson =
      req.path.startsWith("/admin/api") ||
      (req.headers.accept || "").includes("application/json");
    if (wantsJson) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.redirect("/admin/login");
  };

  app.get("/admin/login", (req, res) => {
    const expired = String(req.query.expired || "") === "1";
    res.send(
      renderAdminLoginPage(
        expired ? "Sesi berakhir. Silakan masuk lagi." : "",
        { nonce: res.locals.nonce },
      ),
    );
  });

  app.post("/admin/login", async (req, res) => {
    const ip = clientIp(req);
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const gate = checkAdminLoginAllowed(ip);
    if (!gate.allowed) {
      res
        .status(429)
        .send(
          renderAdminLoginPage(
            "Terlalu banyak percobaan masuk. Coba lagi beberapa menit lagi.",
            { nonce: res.locals.nonce },
          ),
        );
      return;
    }

    const usernameOk = username === ADMIN_WEB_USER;
    const passwordOk = await verifyAdminPassword(db, password, passwordConfig);
    if (!usernameOk || !passwordOk) {
      registerAdminLoginFailure(ip, username);
      res
        .status(401)
        .send(
          renderAdminLoginPage("Username atau password salah.", {
            nonce: res.locals.nonce,
          }),
        );
      return;
    }

    clearAdminLoginFailures(ip);
    const session = createAdminSession();
    setAdminCookie(res, session.token);
    res.redirect("/admin");
  });

  app.post("/admin/logout", requireAdmin, requireCsrf, (req, res) => {
    destroyAdminSession(req.adminSession ? req.adminSession.token : null);
    clearAdminCookie(res);
    res.redirect("/admin/login");
  });

  app.get("/admin", requireAdmin, (req, res) => {
    res.send(renderAdminDashboardPage(renderContext(req, res)));
  });

  app.get("/admin/settings", requireAdmin, (req, res) => {
    res.send(renderAdminSettingsPage(renderContext(req, res)));
  });

  app.get("/admin/api/settings", requireAdmin, async (req, res) => {
    try {
      res.json({ ok: true, settings: settingsSnapshot() });
    } catch (err) {
      console.error("Kesalahan pada API admin:", err);
      res.status(500).json({ ok: false, error: "failed" });
    }
  });

  app.post("/admin/api/settings", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const result = await saveRuntimeSettings(db, req.body || {});
      res.json({
        ok: true,
        applied: result.applied,
        rejected: result.rejected,
        settings: settingsSnapshot(),
      });
    } catch (err) {
      console.error("Kesalahan pada API admin:", err);
      res.status(500).json({ ok: false, error: "failed" });
    }
  });

  app.get("/admin/api/health", requireAdmin, async (req, res) => {
    try {
      const integrity = await checkDbIntegrity(db);
      const stats = sendGuard.stats();
      const totalUsers = await dbGet(db, "SELECT COUNT(*) AS c FROM users");
      res.json({
        ok: true,
        guard: stats,
        database: integrity,
        users: totalUsers ? totalUsers.c : 0,
        runtime: {
          maintenance_mode: settingBool("maintenance_mode"),
          dry_run: settingBool("dry_run"),
          enforce_allowlist: settingBool("enforce_allowlist"),
        },
        client: {
          ready: clientReady,
          lastReadyAt: lastClientReadyAt,
          lastDisconnectedAt: lastDisconnectedAt,
          lastDisconnectReason: lastDisconnectReason,
        },
        alert: lastAlert,
        serverTime: nowWib().toISO(),
      });
    } catch (err) {
      console.error("Kesalahan pada API admin:", err);
      res.status(500).json({ ok: false, error: "failed" });
    }
  });

  app.post("/admin/api/emergency", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const action = String((req.body && req.body.action) || "");
      const hours = Number((req.body && req.body.hours) || 24);
      if (action === "pause") {
        const safeHours = Number.isFinite(hours)
          ? Math.min(168, Math.max(1, Math.round(hours)))
          : 24;
        const until = nowWib().plus({ hours: safeHours });
        await saveRuntimeSettings(db, {
          emergency_pause_until: until.toISO(),
        });
        sendGuard.pause(safeHours * 3600000, "jeda darurat dari operator");
        res.json({ ok: true, pausedUntil: until.toISO() });
        return;
      }
      if (action === "resume") {
        await saveRuntimeSettings(db, { emergency_pause_until: "" });
        sendGuard.resume();
        res.json({ ok: true, resumed: true });
        return;
      }
      if (action === "maintenance_on" || action === "maintenance_off") {
        await saveRuntimeSettings(db, {
          maintenance_mode: action === "maintenance_on" ? 1 : 0,
        });
        res.json({ ok: true, maintenance_mode: settingBool("maintenance_mode") });
        return;
      }
      if (action === "dry_run_on" || action === "dry_run_off") {
        await saveRuntimeSettings(db, {
          dry_run: action === "dry_run_on" ? 1 : 0,
        });
        res.json({ ok: true, dry_run: settingBool("dry_run") });
        return;
      }
      res.status(400).json({ ok: false, error: "Aksi darurat tidak dikenal" });
    } catch (err) {
      console.error("Kesalahan pada API admin:", err);
      res.status(500).json({ ok: false, error: "failed" });
    }
  });

  app.post("/admin/api/users/:waId/actions", requireAdmin, requireCsrf, async (req, res) => {
    try {
      const waId = String(req.params.waId || "").trim();
      if (!/^[0-9A-Za-z@._:-]{3,64}$/.test(waId)) {
        res.status(400).json({ ok: false, error: "Format nomor tidak sah" });
        return;
      }
      const user = await getUser(db, waId);
      if (!user) {
        res.status(404).json({ ok: false, error: "User tidak ditemukan" });
        return;
      }
      const action = String((req.body && req.body.action) || "");
      const value = req.body ? req.body.value : undefined;
      const outcome = await applyAdminUserAction(db, user, action, value);
      if (!outcome.ok) {
        res.status(400).json(outcome);
        return;
      }
      res.json(outcome);
    } catch (err) {
      console.error("Kesalahan pada API admin:", err);
      res.status(500).json({ ok: false, error: "failed" });
    }
  });

  app.get("/admin/users/:waId", requireAdmin, (req, res) => {
    const waId = String(req.params.waId || "").trim();
    // Nilai ini masuk ke HTML dan blok script halaman detail, jadi formatnya dibatasi.
    if (!/^[0-9A-Za-z@._:-]{3,64}$/.test(waId)) {
      res.status(400).send("Invalid user");
      return;
    }
    res.send(renderAdminUserDetailPage(waId, renderContext(req, res)));
  });

  app.get("/admin/api/summary", requireAdmin, async (req, res) => {
    try {
      const summary = await getAdminSummary(db);
      res.json(summary);
    } catch (err) {
      console.error("Gagal mengambil ringkasan admin:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get("/admin/api/users", requireAdmin, async (req, res) => {
    try {
      const users = await getAdminUsers(db);
      res.json({ users });
    } catch (err) {
      console.error("Gagal mengambil data user:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get("/admin/api/users/:waId", requireAdmin, async (req, res) => {
    const waId = String(req.params.waId || "").trim();
    if (!waId) {
      res.status(400).json({ error: "invalid" });
      return;
    }
    try {
      const detail = await getUserDetail(db, waId);
      if (!detail.user) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      console.error("Gagal mengambil detail user:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get("/admin/api/users/:waId/logs", requireAdmin, async (req, res) => {
    const waId = String(req.params.waId || "").trim();
    if (!waId) {
      res.status(400).json({ error: "invalid" });
      return;
    }
    const limit = Number(req.query.limit || 20);
    const offset = Number(req.query.offset || 0);
    try {
      const paged = await getUserLogsPaged(db, waId, limit, offset);
      res.json(paged);
    } catch (err) {
      console.error("Gagal mengambil logs user paged:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get(
    "/admin/api/users/:waId/export.csv",
    requireAdmin,
    async (req, res) => {
      const waId = String(req.params.waId || "").trim();
      if (!waId) {
        res.status(400).json({ error: "invalid" });
        return;
      }
      try {
        const detail = await getUserDetail(db, waId);
        if (!detail.user) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const postpartumSnapshot = buildPostpartumSnapshot(
          detail.postpartum_logs || [],
        );
        const deliverySnapshot = {
          delivery_hpl_response: detail.user.delivery_hpl_response,
          delivery_hpl3_response: detail.user.delivery_hpl3_response,
          delivery_date:
            detail.user.delivery_date_iso || detail.user.delivery_date,
          delivery_time: detail.user.delivery_time,
          delivery_place: detail.user.delivery_place,
          delivery_birth_attendant: detail.user.delivery_birth_attendant,
          delivery_with_complication: detail.user.delivery_with_complication,
          baby_gender: detail.user.baby_gender,
          baby_birth_weight: detail.user.baby_birth_weight,
          mother_current_complaint: detail.user.mother_current_complaint,
          delivery_data_completed_at: detail.user.delivery_data_completed_at,
        };
        const logs =
          detail.logs && detail.logs.length > 0
            ? detail.logs
            : [
                {
                  reminder_date: null,
                  response: null,
                  response_sudah_count: null,
                  response_belum_count: null,
                  created_at: null,
                },
              ];
        const rows = logs.map((log) => ({
          ...log,
          ...deliverySnapshot,
          ...postpartumSnapshot,
        }));
        const csv = buildCsv(rows, [
          { key: "reminder_date", label: "reminder_date" },
          { key: "response", label: "response" },
          { key: "response_sudah_count", label: "response_sudah_count" },
          { key: "response_belum_count", label: "response_belum_count" },
          { key: "created_at", label: "created_at" },
          { key: "delivery_hpl_response", label: "delivery_hpl_response" },
          { key: "delivery_hpl3_response", label: "delivery_hpl3_response" },
          { key: "delivery_date", label: "delivery_date" },
          { key: "delivery_time", label: "delivery_time" },
          { key: "delivery_place", label: "delivery_place" },
          {
            key: "delivery_birth_attendant",
            label: "delivery_birth_attendant",
          },
          {
            key: "delivery_with_complication",
            label: "delivery_with_complication",
          },
          { key: "baby_gender", label: "baby_gender" },
          { key: "baby_birth_weight", label: "baby_birth_weight" },
          {
            key: "mother_current_complaint",
            label: "mother_current_complaint",
          },
          {
            key: "delivery_data_completed_at",
            label: "delivery_data_completed_at",
          },
          { key: "postpartum_total", label: "postpartum_total" },
          { key: "postpartum_sent", label: "postpartum_sent" },
          { key: "postpartum_sudah", label: "postpartum_sudah" },
          { key: "postpartum_belum", label: "postpartum_belum" },
          { key: "postpartum_pending", label: "postpartum_pending" },
          { key: "kfkn1_confirmed_at", label: "kfkn1_confirmed_at" },
          { key: "kfkn2_confirmed_at", label: "kfkn2_confirmed_at" },
          { key: "kfkn3_confirmed_at", label: "kfkn3_confirmed_at" },
          { key: "kf4_confirmed_at", label: "kf4_confirmed_at" },
          {
            key: "postpartum_last_confirmed_at",
            label: "postpartum_last_confirmed_at",
          },
        ]);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${waId.replace(/[^a-zA-Z0-9_-]/g, "_")}-logs.csv"`,
        );
        res.send(csv);
      } catch (err) {
        console.error("Gagal export log user:", err);
        res.status(500).json({ error: "failed" });
      }
    },
  );

  app.get("/admin/api/logs", requireAdmin, async (req, res) => {
    try {
      const logs = await getRecentLogs(db, 50);
      res.json({ logs });
    } catch (err) {
      console.error("Gagal mengambil log:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get("/admin/api/export/users.csv", requireAdmin, async (req, res) => {
    try {
      const users = await getAdminUsers(db);
      const csv = buildCsv(users, [
        { key: "wa_id", label: "wa_id" },
        { key: "name", label: "name" },
        { key: "status", label: "status" },
        { key: "reminder_time", label: "reminder_time" },
        { key: "last_response_date", label: "last_response_date" },
        { key: "last_response", label: "last_response" },
        { key: "total_sudah", label: "total_sudah" },
        { key: "total_belum", label: "total_belum" },
        { key: "delivery_hpl_response", label: "delivery_hpl_response" },
        { key: "delivery_hpl3_response", label: "delivery_hpl3_response" },
        { key: "delivery_date_iso", label: "delivery_date_iso" },
        { key: "delivery_time", label: "delivery_time" },
        { key: "delivery_place", label: "delivery_place" },
        { key: "delivery_birth_attendant", label: "delivery_birth_attendant" },
        {
          key: "delivery_with_complication",
          label: "delivery_with_complication",
        },
        { key: "baby_gender", label: "baby_gender" },
        { key: "baby_birth_weight", label: "baby_birth_weight" },
        { key: "mother_current_complaint", label: "mother_current_complaint" },
        {
          key: "delivery_data_completed_at",
          label: "delivery_data_completed_at",
        },
        { key: "postpartum_total", label: "postpartum_total" },
        { key: "postpartum_sent", label: "postpartum_sent" },
        { key: "postpartum_sudah", label: "postpartum_sudah" },
        { key: "postpartum_belum", label: "postpartum_belum" },
      ]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="users.csv"');
      res.send(csv);
    } catch (err) {
      console.error("Gagal export users:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get(
    "/admin/api/export/reminder_logs.csv",
    requireAdmin,
    async (req, res) => {
      try {
        const logs = await dbAll(
          db,
          `SELECT
          reminder_date,
          wa_id,
          response,
          response_sudah_count,
          response_belum_count,
          created_at
         FROM reminder_logs
         ORDER BY reminder_date DESC, id DESC`,
        );
        const csv = buildCsv(logs, [
          { key: "reminder_date", label: "reminder_date" },
          { key: "wa_id", label: "wa_id" },
          { key: "response", label: "response" },
          { key: "response_sudah_count", label: "response_sudah_count" },
          { key: "response_belum_count", label: "response_belum_count" },
          { key: "created_at", label: "created_at" },
        ]);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="reminder_logs.csv"',
        );
        res.send(csv);
      } catch (err) {
        console.error("Gagal export log:", err);
        res.status(500).json({ error: "failed" });
      }
    },
  );

  app.get(
    "/admin/api/export/postpartum_logs.csv",
    requireAdmin,
    async (req, res) => {
      try {
        const logs = await dbAll(
          db,
          `SELECT
            wa_id,
            visit_code,
            visit_kind,
            visit_label,
            window_text,
            benefit_text,
            due_at,
            reminder_text_sent_at,
            sent_at,
            poll_message_id,
            last_attempt_at,
            fail_count,
            response,
            response_count,
            response_sudah_count,
            response_belum_count,
            response_at,
            created_at,
            updated_at
           FROM postpartum_visit_logs
           ORDER BY due_at DESC, id DESC`,
        );
        const csv = buildCsv(logs, [
          { key: "wa_id", label: "wa_id" },
          { key: "visit_code", label: "visit_code" },
          { key: "visit_kind", label: "visit_kind" },
          { key: "visit_label", label: "visit_label" },
          { key: "window_text", label: "window_text" },
          { key: "benefit_text", label: "benefit_text" },
          { key: "due_at", label: "due_at" },
          { key: "reminder_text_sent_at", label: "reminder_text_sent_at" },
          { key: "sent_at", label: "sent_at" },
          { key: "poll_message_id", label: "poll_message_id" },
          { key: "last_attempt_at", label: "last_attempt_at" },
          { key: "fail_count", label: "fail_count" },
          { key: "response", label: "response" },
          { key: "response_count", label: "response_count" },
          { key: "response_sudah_count", label: "response_sudah_count" },
          { key: "response_belum_count", label: "response_belum_count" },
          { key: "response_at", label: "response_at" },
          { key: "created_at", label: "created_at" },
          { key: "updated_at", label: "updated_at" },
        ]);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="postpartum_visit_logs.csv"',
        );
        res.send(csv);
      } catch (err) {
        console.error("Gagal export postpartum log:", err);
        res.status(500).json({ error: "failed" });
      }
    },
  );

  const server = app.listen(ADMIN_WEB_PORT, ADMIN_WEB_HOST, () => {
    console.log(
      `Admin web berjalan di http://${ADMIN_WEB_HOST}:${ADMIN_WEB_PORT}/admin`,
    );
    if (ADMIN_WEB_HOST !== "127.0.0.1" && ADMIN_WEB_HOST !== "localhost") {
      console.warn(
        "PERINGATAN: admin web terbuka ke jaringan. Data yang dilayani termasuk data kesehatan pasien. Pakai reverse proxy TLS atau SSH tunnel.",
      );
    }
    if (passwordConfig.source === "generated") {
      // Password tidak dicetak ke stdout: stdout masuk ke journald atau log PM2,
      // dan itu berarti password ikut tersimpan di berkas log.
      console.log(
        `Password admin baru dibuat, tersimpan di ${passwordConfig.filePath} (mode 600)`,
      );
    }
    ensureAdminPasswordHash(db, passwordConfig).catch((err) => {
      console.error("Gagal menyimpan hash password admin:", err.message);
    });
  });
}

// Nilai env angka yang salah tulis pernah mematikan kontrol keamanan secara senyap
// (NaN membuat rate limit dianggap nonaktif). Sekarang bot menolak start.
const NUMERIC_ENV_KEYS = [
  "PREGNANCY_WEEKS_LIMIT",
  "DELIVERY_VALIDATION_START_WEEK",
  "REMINDER_LOG_RETENTION_DAYS",
  "REMINDER_STALE_AFTER_MINUTES",
  "MAX_SEND_ATTEMPTS",
  "RATE_LIMIT_MAX_PER_MINUTE",
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_COOLDOWN_MS",
  "POLL_MAX_RESPONSES_PER_DAY",
  "POLL_RETRY_BASE_DELAY_MS",
  "POLL_RETRY_MAX_DELAY_MS",
  "REMINDER_LOOP_CONCURRENCY",
  "ADMIN_WEB_PORT",
  "ADMIN_WEB_SESSION_TTL_MS",
  "ADMIN_LOGIN_MAX_ATTEMPTS",
  "ADMIN_LOGIN_WINDOW_MS",
  "SEND_MIN_GAP_MS",
  "SEND_JITTER_MS",
  "REPLY_MIN_GAP_MS",
  "REPLY_JITTER_MS",
  "SEND_MAX_PER_MINUTE",
  "SEND_MAX_PER_HOUR",
  "SEND_MAX_PER_DAY",
  "SEND_MAX_QUEUE_WAIT_MS",
  "SEND_FAIL_BREAKER",
  "SEND_PAUSE_MS",
  "SEND_WINDOW_START_HOUR",
  "SEND_WINDOW_END_HOUR",
  "SEND_WINDOW_END_MINUTE",
  "SEND_WARMUP_DAY1_MAX",
  "SEND_WARMUP_DAY8_MAX",
  "WA_INIT_MAX_ATTEMPTS",
];

function validateEnv(env = process.env) {
  const invalid = [];
  for (const key of NUMERIC_ENV_KEYS) {
    const raw = env[key];
    if (raw === undefined || String(raw).trim() === "") {
      continue;
    }
    if (!Number.isFinite(Number(raw))) {
      invalid.push(`${key}="${raw}"`);
    }
  }
  return invalid;
}

function assertEnvOrExit(env = process.env) {
  const invalid = validateEnv(env);
  if (invalid.length) {
    console.error("Konfigurasi env tidak valid, nilai berikut harus angka:");
    for (const item of invalid) {
      console.error(`  ${item}`);
    }
    console.error("Perbaiki .env sebelum menjalankan ulang.");
    process.exit(1);
  }
}

// Opsi penautan tanpa QR. Objek kosong berarti jalur QR seperti biasa.
function pairingOptions(rawNumber) {
  const phoneNumber = String(rawNumber || "").replace(/[^0-9]/g, "");
  if (!phoneNumber) {
    return {};
  }
  return {
    pairWithPhoneNumber: {
      phoneNumber,
      showNotification: false,
      intervalMs: PAIRING_CODE_REFRESH_MS,
    },
  };
}

async function main() {
  ensureDataDir();
  assertEnvOrExit();
  acquireInstanceLock();
  const db = openDb();
  await initDb(db);
  await ensureSettingsTable(db);
  await loadRuntimeSettings(db);
  const integrity = await checkDbIntegrity(db);
  if (!integrity.ok) {
    sendAlert("database", `integrity_check: ${integrity.result}`);
  }
  startAdminServer(db);

  const executablePath = findBrowserExecutable();
  if (executablePath) {
    console.log(`Menggunakan browser: ${executablePath}`);
  }

  const runningAsRoot =
    typeof process.getuid === "function" && process.getuid() === 0;
  const disableSandbox = DISABLE_SANDBOX || runningAsRoot;
  if (runningAsRoot && !DISABLE_SANDBOX) {
    console.warn("Running as root, otomatis menonaktifkan sandbox Chromium.");
  }
  const puppeteerArgs = disableSandbox
    ? ["--no-sandbox", "--disable-setuid-sandbox"]
    : [];

  const userAgent = buildUserAgent(executablePath);
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: process.env.WA_CLIENT_ID || "remindcare",
    }),
    deviceName: process.env.WA_DEVICE_NAME || "RemindCare",
    browserName: "Chrome",
    ...pairingOptions(WA_PAIRING_NUMBER),
    ...(userAgent ? { userAgent } : {}),
    puppeteer: {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        ...puppeteerArgs,
        "--disable-blink-features=AutomationControlled",
        "--lang=id-ID",
        "--window-size=1280,900",
      ],
    },
  });
  activeClient = client;

  let reminderTimer = null;

  // Tanpa penghentian rapi, restart di tengah penulisan SQLite atau saat Chromium
  // memegang profil sesi berisiko merusak DB dan mengunci .wwebjs_auth.
  const shutdown = async (signal) => {
    console.log(`Menerima ${signal}, menghentikan RemindCare dengan rapi...`);
    sendGuard.setReady(false);
    if (reminderTimer) {
      clearInterval(reminderTimer);
      reminderTimer = null;
    }
    try {
      await client.destroy();
    } catch (err) {
      console.error("Gagal menutup client WhatsApp:", err);
    }
    try {
      await new Promise((resolve) => db.close(resolve));
    } catch (err) {
      console.error("Gagal menutup database:", err);
    }
    releaseInstanceLock();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  client.on("qr", (qr) => {
    qrcode.generate(qr, { small: true });
  });

  // Kode pairing juga ditulis ke berkas supaya bisa dibaca lewat SSH, tanpa perlu
  // memindai QR dari layar terminal.
  client.on("code", (code) => {
    console.log(`Kode pairing WhatsApp: ${code}`);
    try {
      fs.writeFileSync(PAIRING_CODE_PATH, `${code}${os.EOL}`, { mode: 0o600 });
    } catch (err) {
      console.error("Gagal menulis berkas kode pairing:", err.message);
    }
  });

  client.on("ready", () => {
    clientReady = true;
    lastClientReadyAt = nowWib().toISO();
    sendGuard.setReady(true);
    console.log("RemindCare siap digunakan.");
    try {
      if (fs.existsSync(PAIRING_CODE_PATH)) {
        fs.unlinkSync(PAIRING_CODE_PATH);
      }
    } catch (err) {
      console.error("Gagal menghapus berkas kode pairing:", err.message);
    }
    if (!reminderTimer) {
      reminderTimer = startReminderLoop(db, client);
    }
  });

  client.on("change_state", (state) => {
    console.log("Status WhatsApp:", state);
  });

  // Sesi terputus hampir selalu mendahului pembatasan sementara. Saat itu terjadi,
  // hentikan pengiriman dan tunggu intervensi manusia, jangan auto-login berulang.
  client.on("auth_failure", (message) => {
    sendAlert("auth-gagal", `Sesi perlu ditautkan ulang: ${message}`);
    clientReady = false;
    sendGuard.setReady(false);
    sendGuard.pause(6 * 60 * 60 * 1000, `auth_failure: ${message}`);
    console.error("AUTH FAILURE, sesi perlu ditautkan ulang:", message);
  });

  client.on("disconnected", (reason) => {
    sendAlert("sesi-putus", `WhatsApp memutus sesi: ${reason}`);
    clientReady = false;
    lastDisconnectedAt = nowWib().toISO();
    lastDisconnectReason = String(reason || "tidak diketahui");
    sendGuard.setReady(false);
    console.error("TERPUTUS dari WhatsApp:", reason);
  });

  client.on("message_ack", (msg, ack) => {
    if (msg && msg.id) {
      lastAckByMessageId.set(msg.id._serialized, ack);
    }
  });

  client.on("message", async (msg) => {
    try {
      await handleMessage(db, client, msg);
    } catch (err) {
      console.error("Gagal memproses pesan:", err);
    }
  });

  client.on("vote_update", async (vote) => {
    try {
      await handleVoteUpdate(db, client, vote);
    } catch (err) {
      console.error("Gagal memproses vote:", err);
    }
  });

  await initClientWithRetry(client);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("RemindCare gagal dijalankan:", err);
  });
}

module.exports = {
  pairingOptions,
  // jembatan uji: hanya untuk menguji siklus hidup sesi admin tanpa membuka server
  __createAdminSessionForTest: createAdminSession,
  __destroyAdminSessionForTest: destroyAdminSession,
  __peekAdminSessionForTest: (token) => (token ? adminSessions.get(token) || null : null),
  renderAdminLoginPage,
  renderAdminDashboardPage,
  renderAdminUserDetailPage,
  isRealSentMessage,
  isDuplicateMessage,
  chatIdCandidates,
  deliverMessage,
  rememberAlternates,
  ensureAliasTable,
  getCanonicalWaId,
  recordAlias,
  getAlternateChatIds,
  loadAliasCache,
  resolveSenderIdentity,
  canAttemptFlow,
  markFlowAttempt,
  sendReminderText,
  envNumber,
  parseYesNo,
  normalizeTimeInput,
  parseHpht,
  shouldSendNow,
  getHplDate,
  getDeliveryValidationStageDue,
  buildLaborPhaseMessage,
  parseDeliveryValidationAnswer,
  getDeliveryDateTime,
  getPostpartumDueAt,
  buildPostpartumSnapshot,
  getRetryDelayMs,
  canAttemptByBackoff,
  validateDeliveryDateIso,
  validateDeliveryDateTime,
  isDeliveryCheckCommand,
  escapeForScriptContext,
  validateEnv,
  takeSendAttempt,
  checkAdminLoginAllowed,
  registerAdminLoginFailure,
  clearAdminLoginFailures,
  clientIp,
  checkDbIntegrity,
  ensureSettingsTable,
  getSetting,
  setSetting,
  coerceSetting,
  settingsSnapshot,
  saveRuntimeSettings,
  loadRuntimeSettings,
  getMaxSendAttempts,
  isAllowlistEnforced,
  applyAdminUserAction,
  getProgramDay,
  pickPollVariant,
  buildReminderQuestion,
  getScheduledSendCount,
  noteScheduledSend,
  isOverDailyMessageQuota,
  sendAlert,
  reconcileRunnableUsers,
  buildNeedsAction,
  isReminderControlCommand,
  parsePostpartumCorrection,
  resolveVisitCode,
};
