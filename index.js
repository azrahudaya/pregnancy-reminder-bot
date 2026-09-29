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
const ADMIN_WEB_COOKIE_SECURE =
  /^(1|true)$/i.test(process.env.ADMIN_WEB_COOKIE_SECURE || "") ||
  String(process.env.NODE_ENV || "").toLowerCase() === "production";
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
    () => resolved.sendMessage(chatId, text, { sendSeen: false }),
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
    () => resolved.sendMessage(chatId, poll, { sendSeen: false }),
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
  const ttl =
    Number.isFinite(ADMIN_WEB_SESSION_TTL_MS) && ADMIN_WEB_SESSION_TTL_MS > 0
      ? ADMIN_WEB_SESSION_TTL_MS
      : 8 * 60 * 60 * 1000;
  adminSessions.set(token, { expiresAt: Date.now() + ttl });
  return token;
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
  return token;
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

function renderAdminLoginPage(message) {
  const alert = message
    ? `<div class="alert" role="alert">${escapeHtml(message)}</div>`
    : "";
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>RemindCare Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg: #f7f7f7;
        --panel: #ffffff;
        --text: #111111;
        --muted: #666666;
        --border: #e3e3e3;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Lato", sans-serif;
        background: radial-gradient(circle at top, #ffffff 0%, #f2f2f2 60%, #ededed 100%);
        color: var(--text);
        min-height: 100vh;
        min-height: 100dvh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: 100%;
        max-width: 420px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: 0 18px 45px rgba(0,0,0,0.08);
        padding: 32px;
        display: grid;
        gap: 16px;
      }
      h1 {
        margin: 0;
        font-size: 24px;
      }
      .sub {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
      }
      form {
        display: grid;
        gap: 14px;
      }
      label {
        font-size: 13px;
        color: var(--muted);
        display: grid;
        gap: 6px;
      }
      input {
        padding: 12px 14px;
        border-radius: 10px;
        border: 1px solid var(--border);
        font-size: 15px;
        font-family: inherit;
        background: #fff;
        min-height: 44px;
        width: 100%;
      }
      button {
        padding: 12px 16px;
        border-radius: 999px;
        border: none;
        background: #111;
        color: #fff;
        font-weight: 700;
        cursor: pointer;
        transition: transform 0.2s ease;
        min-height: 44px;
        font-size: 15px;
        font-family: inherit;
      }
      button:hover {
        transform: translateY(-1px);
      }
      input:focus-visible, button:focus-visible {
        outline: 2px solid #111;
        outline-offset: 2px;
      }
      .alert {
        background: #fdecec;
        border: 1px solid #8c1d1d;
        color: #8c1d1d;
        padding: 12px 14px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 700;
        animation: slideIn 0.35s ease;
      }
      @keyframes slideIn {
        from { opacity: 0; transform: translateY(-6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        * { animation: none !important; transition: none !important; }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div>
        <h1>RemindCare Admin</h1>
        <p class="sub">Masuk untuk akses dashboard</p>
      </div>
      ${alert}
      <form method="post" action="/admin/login">
        <label>Username (opsional)
          <input name="username" autocomplete="username" placeholder="admin">
        </label>
        <label>Password
          <input type="password" name="password" autocomplete="current-password" placeholder="Password" required>
        </label>
        <button type="submit">Masuk</button>
      </form>
    </div>
  </body>
</html>`;
}

function renderAdminDashboardPage() {
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>RemindCare Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg: #f7f7f7;
        --panel: #ffffff;
        --text: #0f0f0f;
        --muted: #666666;
        --border: #e3e3e3;
        --border-strong: #8a8a8a;
        --shadow: 0 8px 26px rgba(0,0,0,0.06);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Lato", sans-serif;
        background: linear-gradient(180deg, #ffffff 0%, #f4f4f4 100%);
        color: var(--text);
      }
      .container {
        width: min(1280px, 100%);
        margin: 0 auto;
      }
      header {
        padding: 28px 28px 18px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      h1 {
        margin: 0;
        font-size: 24px;
      }
      .subtitle {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 13px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      button, .ghost {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 10px 16px;
        border-radius: 999px;
        border: 1px solid var(--border-strong);
        background: #111;
        color: #fff;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
        font-size: 13px;
        font-family: inherit;
        transition: transform 0.2s ease;
      }
      .ghost {
        background: #fff;
        color: #111;
      }
      button:hover, .ghost:hover {
        transform: translateY(-1px);
      }
      button:focus-visible, .ghost:focus-visible, .phase-filter:focus-visible, input:focus-visible, summary:focus-visible, tbody tr.row-clickable:focus-visible {
        outline: 2px solid #111;
        outline-offset: 2px;
      }
      main {
        padding: 0 28px 40px;
        display: grid;
        gap: 24px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 14px;
        box-shadow: var(--shadow);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 14px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 16px;
        box-shadow: var(--shadow);
      }
      .card .label {
        font-size: 12px;
        color: var(--muted);
      }
      .card .value {
        font-size: 22px;
        font-weight: 700;
        margin-top: 8px;
        overflow-wrap: anywhere;
        word-break: break-word;
        line-height: 1.25;
      }
      .section-title {
        font-size: 15px;
        font-weight: 700;
        margin: 0;
      }
      .section-head {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .users-tools {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .search-input {
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        padding: 9px 12px;
        font-size: 13px;
        min-width: 260px;
        min-height: 44px;
        background: #fff;
      }
      .phase-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 14px;
      }
      .phase-card {
        background: #fff;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 14px;
      }
      .phase-card .label {
        font-size: 12px;
        color: var(--muted);
      }
      .phase-card .value {
        font-size: 20px;
        font-weight: 700;
        margin-top: 8px;
      }
      .phase-filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
      }
      .phase-filter {
        border: 1px solid var(--border-strong);
        background: #fff;
        color: #222;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 12px;
        font-weight: 700;
        min-height: 44px;
      }
      .phase-filter[aria-pressed="true"] {
        background: #111;
        color: #fff;
        border: 2px solid #111;
      }
      .phase-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 700;
        border: 1px solid transparent;
      }
      .phase-kehamilan {
        background: #eef8f1;
        color: #1f5f35;
        border-color: currentColor;
      }
      .phase-persalinan {
        background: #fff4e8;
        color: #8a4b12;
        border-color: currentColor;
      }
      .phase-pasca {
        background: #eaf2ff;
        color: #1f457d;
        border-color: currentColor;
      }
      .phase-onboarding {
        background: #f3f3f3;
        color: #4d4d4d;
        border-color: currentColor;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        overflow: hidden;
        font-size: 13px;
      }
      .table-wrap {
        width: 100%;
        overflow-x: auto;
        border-radius: 14px;
      }
      th, td {
        text-align: left;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      th {
        background: #f2f2f2;
        font-weight: 700;
      }
      th:first-child,
      td:first-child {
        position: sticky;
        left: 0;
        z-index: 1;
        background: var(--panel);
        border-right: 2px solid var(--border-strong);
      }
      th:first-child {
        background: #f2f2f2;
      }
      tbody tr:hover {
        background: #fafafa;
      }
      tbody tr.row-clickable {
        cursor: pointer;
      }
      tbody tr.row-clickable:hover {
        background: #f3f3f3;
      }
      tbody tr.row-clickable:hover td:first-child {
        background: #f3f3f3;
      }
      .muted {
        color: var(--muted);
        font-size: 12px;
      }
      .grid {
        display: grid;
        gap: 14px;
      }
      .progress-badges {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .progress-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 700;
        border: 1px solid var(--border-strong);
        background: #fff;
      }
      .progress-ok {
        background: #edf9f0;
        border-color: currentColor;
        color: #1e6239;
      }
      .progress-warn {
        background: #fff3ef;
        border-color: currentColor;
        color: #8b3f1c;
      }
      .progress-info {
        background: #eef3ff;
        border-color: currentColor;
        color: #244b86;
      }
      .toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #111;
        color: #fff;
        padding: 12px 16px;
        border-radius: 12px;
        opacity: 0;
        transform: translateY(8px);
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      .error-banner {
        display: grid;
        gap: 10px;
        border: 1px solid #8c1d1d;
        background: #fdecec;
        color: #8c1d1d;
        border-radius: 14px;
        padding: 14px;
        font-size: 13px;
      }
      .error-banner[hidden] {
        display: none;
      }
      .error-banner p {
        margin: 0;
      }
      .stale-note {
        margin: 0 0 10px;
        color: #8c1d1d;
        font-size: 12px;
      }
      .stale-note[hidden] {
        display: none;
      }
      .table-hint {
        display: none;
        margin: 0 0 10px;
      }
      h2.section-title {
        margin-bottom: 10px;
      }
      .export-menu summary {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 44px;
        padding: 10px 16px;
        border-radius: 999px;
        border: 1px solid var(--border-strong);
        background: #fff;
        color: #111;
        font-size: 13px;
        font-weight: 700;
        list-style: none;
        cursor: pointer;
      }
      .export-menu summary::after {
        content: "";
        width: 8px;
        height: 8px;
        border-right: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        transform: rotate(45deg);
      }
      .export-menu[open] summary::after {
        transform: rotate(-135deg);
      }
      .export-menu > .muted {
        margin: 8px 0 0;
      }
      .export-menu > a.ghost {
        margin-top: 8px;
      }
      @media (max-width: 720px) {
        header, main { padding: 16px; }
        .actions { width: 100%; }
        .actions > * { flex: 1 1 auto; }
        .search-input { min-width: 180px; width: 100%; }
        .users-tools { width: 100%; }
        .phase-filters { width: 100%; overflow-x: auto; white-space: nowrap; padding-bottom: 2px; }
        table { font-size: 12px; }
        .table-hint { display: block; }
        .card .value {
          font-size: 18px;
        }
      }
      @media (max-width: 420px) {
        .stats, .phase-stats { grid-template-columns: 1fr; }
        .section-head { align-items: flex-start; }
        .card .value { font-size: 17px; }
      }
      @media (prefers-reduced-motion: reduce) {
        * { animation: none !important; transition: none !important; }
      }
    </style>
  </head>
  <body>
    <header class="container">
      <div>
        <h1>RemindCare Admin</h1>
        <div class="subtitle">Dashboard ringkas pengguna dan pengingat</div>
        <div class="muted">Data terakhir tersinkron: <span id="last-updated">-</span></div>
      </div>
      <div class="actions">
              <button type="button" id="refresh-btn">Muat ulang</button>
              <a class="ghost" href="/admin/settings">Pengaturan</a>
              <details class="export-menu">
                <summary>Ekspor data (CSV)</summary>
                <p class="muted">Isi setiap berkas adalah data seluruh user, termasuk nomor WhatsApp dan tanggal persalinan. Berkasi yang sudah diunduh bisa dibuka siapa pun yang memegangnya, jadi simpan di tempat yang aman.</p>
                <a class="ghost" href="/admin/api/export/users.csv" download>Data user</a>
                <a class="ghost" href="/admin/api/export/reminder_logs.csv" download>Catatan pengingat</a>
                <a class="ghost" href="/admin/api/export/postpartum_logs.csv" download>Catatan nifas</a>
              </details>
              <form method="post" action="/admin/logout">
                <button type="submit" class="ghost">Keluar</button>
              </form>
            </div>
    </header>
    <main class="container">
      <div class="error-banner" id="error-banner" role="alert" hidden>
        <p id="error-text"></p>
        <div class="actions">
          <button type="button" class="ghost" id="error-retry">Coba muat ulang</button>
        </div>
      </div>

      <section id="stats-section">
        <h2 class="section-title">Ringkasan hari ini</h2>
        <div class="stats">
          <div class="card"><div class="label">Total user</div><div class="value" id="stat-users-total">-</div></div>
          <div class="card"><div class="label">Aktif</div><div class="value" id="stat-users-active">-</div></div>
          <div class="card"><div class="label">Dijeda</div><div class="value" id="stat-users-paused">-</div></div>
          <div class="card"><div class="label">Selesai</div><div class="value" id="stat-users-completed">-</div></div>
          <div class="card"><div class="label">Sudah (hari ini)</div><div class="value" id="stat-today-sudah">-</div></div>
          <div class="card"><div class="label">Belum (hari ini)</div><div class="value" id="stat-today-belum">-</div></div>
        </div>
      </section>

      <section class="grid panel">
        <h2 class="section-title">Klasifikasi fase</h2>
        <div class="phase-stats">
          <div class="phase-card"><div class="label">Onboarding</div><div class="value" id="phase-onboarding">-</div></div>
          <div class="phase-card"><div class="label">Kehamilan</div><div class="value" id="phase-kehamilan">-</div></div>
          <div class="phase-card"><div class="label">Persalinan</div><div class="value" id="phase-persalinan">-</div></div>
          <div class="phase-card"><div class="label">Pasca Kehamilan</div><div class="value" id="phase-pasca">-</div></div>
        </div>
      </section>

      <section class="grid panel">
        <div class="section-head">
          <h2 class="section-title">Daftar user</h2>
          <div class="users-tools">
            <input id="users-search" class="search-input" type="search" autocomplete="off" aria-label="Cari user berdasarkan nama atau nomor WhatsApp" placeholder="Cari nama / nomor WA">
            <div class="phase-filters" role="group" aria-label="Filter fase">
              <button type="button" class="phase-filter" data-phase-filter="all" aria-pressed="true">Semua</button>
              <button type="button" class="phase-filter" data-phase-filter="onboarding" aria-pressed="false">Onboarding</button>
              <button type="button" class="phase-filter" data-phase-filter="kehamilan" aria-pressed="false">Kehamilan</button>
              <button type="button" class="phase-filter" data-phase-filter="persalinan" aria-pressed="false">Persalinan</button>
              <button type="button" class="phase-filter" data-phase-filter="pasca_kehamilan" aria-pressed="false">Pasca Kehamilan</button>
            </div>
            <p class="muted" id="users-count" role="status" aria-live="polite">Menampilkan semua user.</p>
          </div>
        </div>
        <p class="muted table-hint">Geser tabel ke samping untuk melihat kolom lain. Kolom nama tetap menempel di kiri.</p>
        <p class="stale-note" id="users-note" hidden></p>
        <div class="table-wrap">
        <table>
          <caption class="muted">Daftar user beserta fase, status pengingat, dan progress program. Nama user adalah tautan ke halaman detail dan bisa dibuka dengan Enter.</caption>
          <thead>
            <tr>
              <th scope="col">Nama</th>
              <th scope="col">Fase</th>
              <th scope="col">Status pengingat</th>
              <th scope="col">Jam pengingat</th>
              <th scope="col">Tanggal respon terakhir</th>
              <th scope="col">Jawaban terakhir</th>
              <th scope="col">Progress program</th>
            </tr>
          </thead>
          <tbody id="users-body" aria-busy="true">
            <tr><td colspan="7" class="muted">Memuat daftar user...</td></tr>
          </tbody>
        </table>
        </div>
      </section>

      <section class="grid panel">
        <div class="section-head">
          <h2 class="section-title">Catatan pengingat terbaru</h2>
          <p class="muted">Menampilkan 50 catatan terbaru dari seluruh user.</p>
        </div>
        <p class="stale-note" id="logs-note" hidden></p>
        <div class="table-wrap">
        <table>
          <caption class="muted">Catatan pengingat terbaru dari seluruh user.</caption>
          <thead>
            <tr>
              <th scope="col">Tanggal pengingat</th>
              <th scope="col">Nama</th>
              <th scope="col">Jawaban</th>
              <th scope="col">Jumlah jawaban sudah</th>
              <th scope="col">Jumlah jawaban belum</th>
              <th scope="col">Waktu dicatat</th>
            </tr>
          </thead>
          <tbody id="logs-body" aria-busy="true">
            <tr><td colspan="6" class="muted">Memuat catatan pengingat...</td></tr>
          </tbody>
        </table>
        </div>
      </section>
    </main>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>

    <script>
      const toast = document.getElementById('toast');
      function showToast(message) {
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(window.__toastTimer);
        window.__toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
      }
      function fmt(value) {
        return value === null || value === undefined || value === '' ? '-' : value;
      }
      function fmtDateTime(value) {
        if (!value) return '-';
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return String(value);
        return parsed.toLocaleString('id-ID');
      }
      function classifyPhase(user) {
        const hasPostpartum = Number(user.postpartum_total || 0) > 0 || !!user.delivery_date_iso;
        if (hasPostpartum) {
          return 'pasca_kehamilan';
        }
        const hasLaborSignals =
          (Number(user.delivery_data_step || 0) > 0) ||
          !!user.delivery_poll_stage ||
          !!user.delivery_hpl_poll_sent_date ||
          !!user.delivery_hpl3_poll_sent_date ||
          user.delivery_hpl_response === 'Sudah' ||
          user.delivery_hpl3_response === 'Sudah';
        if (hasLaborSignals) {
          return 'persalinan';
        }
        if (user.status === 'onboarding' || !user.hpht_iso) {
          return 'onboarding';
        }
        return 'kehamilan';
      }
      function phaseLabel(phase) {
        if (phase === 'kehamilan') return 'Kehamilan';
        if (phase === 'persalinan') return 'Persalinan';
        if (phase === 'pasca_kehamilan') return 'Pasca Kehamilan';
        return 'Onboarding';
      }
      function statusLabel(status) {
        if (status === 'active') return 'Aktif';
        if (status === 'paused') return 'Dijeda';
        if (status === 'completed') return 'Selesai';
        if (status === 'onboarding') return 'Pendataan awal';
        return fmt(status);
      }
      function phaseBadgeClass(phase) {
        if (phase === 'kehamilan') return 'phase-kehamilan';
        if (phase === 'persalinan') return 'phase-persalinan';
        if (phase === 'pasca_kehamilan') return 'phase-pasca';
        return 'phase-onboarding';
      }
      function clampPercent(value) {
        if (!Number.isFinite(value)) return 0;
        if (value < 0) return 0;
        if (value > 100) return 100;
        return Math.round(value);
      }
      function computeProgress(user, postpartumLogs) {
        const totalLogs = Number(user.total_logs || 0);
        const totalAnswered = Number(user.total_answered || 0);
        const fePct = totalLogs > 0 ? clampPercent((totalAnswered * 100) / totalLogs) : 0;

        const deliveryDone = !!user.delivery_data_completed_at || !!user.delivery_date_iso;
        const deliveryState = deliveryDone
          ? 'Selesai'
          : (Number(user.delivery_data_step || 0) > 0 || user.delivery_hpl_response === 'Sudah' || user.delivery_hpl3_response === 'Sudah')
            ? 'Proses'
            : 'Belum';

        const ppTotal = Number(user.postpartum_total || ((postpartumLogs || []).length || 0));
        const ppSudah = Number(user.postpartum_sudah || ((postpartumLogs || []).filter((x) => x.response === 'Sudah').length || 0));
        const ppPct = ppTotal > 0 ? clampPercent((ppSudah * 100) / ppTotal) : 0;


        return {
          feText: 'FE ' + fePct + '%',
          feClass: fePct >= 70 ? 'progress-ok' : (fePct > 0 ? 'progress-info' : 'progress-warn'),
          deliveryText: 'Persalinan ' + deliveryState,
          deliveryClass: deliveryState === 'Selesai' ? 'progress-ok' : (deliveryState === 'Proses' ? 'progress-info' : 'progress-warn'),
          postpartumText: 'KF/KN ' + ppPct + '%',
          postpartumClass: ppPct >= 75 ? 'progress-ok' : (ppPct > 0 ? 'progress-info' : 'progress-warn'),
        };
      }
      function createProgressBadges(progress) {
        const wrap = document.createElement('div');
        wrap.className = 'progress-badges';
        const rows = [
          [progress.feText, progress.feClass],
          [progress.deliveryText, progress.deliveryClass],
          [progress.postpartumText, progress.postpartumClass],
        ];
        for (const [text, cls] of rows) {
          const badge = document.createElement('span');
          badge.className = 'progress-badge ' + cls;
          badge.textContent = text;
          wrap.appendChild(badge);
        }
        return wrap;
      }
      async function fetchJson(url) {
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (res.status === 401) {
          window.location.href = '/admin/login?expired=1';
          throw new Error('Sesi berakhir. Silakan masuk lagi.');
        }
        if (!res.ok) {
          throw new Error('Permintaan gagal dengan kode ' + res.status);
        }
        return res.json();
      }
      function renderPhaseStats(users) {
        const counts = {
          onboarding: 0,
          kehamilan: 0,
          persalinan: 0,
          pasca_kehamilan: 0
        };
        for (const user of users) {
          counts[classifyPhase(user)] += 1;
        }
        document.getElementById('phase-onboarding').textContent = counts.onboarding;
        document.getElementById('phase-kehamilan').textContent = counts.kehamilan;
        document.getElementById('phase-persalinan').textContent = counts.persalinan;
        document.getElementById('phase-pasca').textContent = counts.pasca_kehamilan;
        const labels = {
          all: 'Semua',
          onboarding: 'Onboarding',
          kehamilan: 'Kehamilan',
          persalinan: 'Persalinan',
          pasca_kehamilan: 'Pasca Kehamilan'
        };
        const filterCounts = { all: users.length, ...counts };
        for (const btn of document.querySelectorAll('.phase-filter')) {
          const key = btn.getAttribute('data-phase-filter');
          btn.textContent = labels[key] + ' (' + (filterCounts[key] || 0) + ')';
        }
      }
      let usersCache = [];
      let activePhaseFilter = 'all';
      let searchKeyword = '';
      function renderUsersTable() {
        const tbody = document.getElementById('users-body');
        const filtered = usersCache.filter((user) => {
          const phaseOk =
            activePhaseFilter === 'all' || classifyPhase(user) === activePhaseFilter;
          if (!phaseOk) return false;
          if (!searchKeyword) return true;
          const haystack = [user.wa_id, user.name].map((x) => String(x || '').toLowerCase()).join(' ');
          return haystack.includes(searchKeyword);
        });
        tbody.innerHTML = '';
        const countNode = document.getElementById('users-count');
        if (countNode) {
          countNode.textContent = 'Menampilkan ' + filtered.length + ' dari ' + usersCache.length + ' user.';
        }
        if (!filtered.length) {
          const emptyText = usersCache.length
            ? 'Tidak ada user yang cocok dengan pencarian atau filter ini. Longgarkan filter untuk melihat user lain.'
            : 'Belum ada user terdaftar. User baru muncul setelah percakapan WhatsApp pertama selesai didata.';
          tbody.innerHTML = '<tr><td colspan="7" class="muted">' + emptyText + '</td></tr>';
          return;
        }
        for (const user of filtered) {
          const tr = document.createElement('tr');
          tr.classList.add('row-clickable');
          tr.dataset.waId = user.wa_id;
          tr.addEventListener('click', () => {
            window.location.href = '/admin/users/' + encodeURIComponent(user.wa_id);
          });
          const cells = [
            user.name,
            phaseLabel(classifyPhase(user)),
            statusLabel(user.status),
            user.reminder_time,
            user.last_response_date,
            user.last_response
          ];
          cells.forEach((value, index) => {
            const td = document.createElement('td');
            if (index === 0) {
              const link = document.createElement('a');
              link.href = '/admin/users/' + encodeURIComponent(user.wa_id);
              link.textContent = fmt(value);
              td.appendChild(link);
            } else if (index === 1) {
              const badge = document.createElement('span');
              const phase = classifyPhase(user);
              badge.className = 'phase-badge ' + phaseBadgeClass(phase);
              badge.textContent = phaseLabel(phase);
              td.appendChild(badge);
            } else {
              td.textContent = fmt(value);
            }
            tr.appendChild(td);
          });
          const tdProgress = document.createElement('td');
          tdProgress.appendChild(createProgressBadges(computeProgress(user)));
          tr.appendChild(tdProgress);
          tbody.appendChild(tr);
        }
      }
      async function loadSummary() {
        const data = await fetchJson('/admin/api/summary');
        document.getElementById('stat-users-total').textContent = fmt(data.users.total);
        document.getElementById('stat-users-active').textContent = fmt(data.users.active);
        document.getElementById('stat-users-paused').textContent = fmt(data.users.paused);
        document.getElementById('stat-users-completed').textContent = fmt(data.users.completed);
        document.getElementById('stat-today-sudah').textContent = fmt(data.reminders.todaySudah);
        document.getElementById('stat-today-belum').textContent = fmt(data.reminders.todayBelum);
      }
      async function loadUsers() {
        const data = await fetchJson('/admin/api/users');
        usersCache = data.users || [];
        renderPhaseStats(usersCache);
        renderUsersTable();
      }
      async function loadLogs() {
        const data = await fetchJson('/admin/api/logs');
        const tbody = document.getElementById('logs-body');
        tbody.innerHTML = '';
        if (!data.logs.length) {
          tbody.innerHTML = '<tr><td colspan="6" class="muted">Belum ada log.</td></tr>';
          return;
        }
        for (const log of data.logs) {
          const tr = document.createElement('tr');
          const cells = [
              log.reminder_date,
              log.name,
              log.response,
              log.response_sudah_count,
              log.response_belum_count,
              fmtDateTime(log.created_at)
            ];
          for (const value of cells) {
            const td = document.createElement('td');
            td.textContent = fmt(value);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
      }
      const refreshBtn = document.getElementById('refresh-btn');
      const errorBanner = document.getElementById('error-banner');
      const errorText = document.getElementById('error-text');
      function setPanelNote(id, text) {
        const node = document.getElementById(id);
        if (!node) return;
        if (text) {
          node.textContent = text;
          node.hidden = false;
        } else {
          node.textContent = '';
          node.hidden = true;
        }
      }
      function showErrorBanner(message) {
        errorText.textContent = message;
        errorBanner.hidden = false;
      }
      function hideErrorBanner() {
        errorBanner.hidden = true;
        errorText.textContent = '';
      }
      async function loadPanel(task) {
        const body = document.getElementById(task.bodyId);
        if (body) body.setAttribute('aria-busy', 'true');
        try {
          await task.run();
          if (task.noteId) setPanelNote(task.noteId, '');
          return { ok: true, error: '' };
        } catch (err) {
          if (task.noteId) {
            setPanelNote(
              task.noteId,
              'Panel ini gagal diperbarui: ' + err.message + '. Isi di bawah adalah hasil muat terakhir yang berhasil.'
            );
          }
          return { ok: false, error: err.message };
        } finally {
          if (body) body.setAttribute('aria-busy', 'false');
        }
      }
      async function loadAll() {
        hideErrorBanner();
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Memuat...';
        const tasks = [
          { noteId: 'users-note', bodyId: 'users-body', run: loadUsers },
          { noteId: 'logs-note', bodyId: 'logs-body', run: loadLogs },
          { noteId: null, bodyId: 'stats-section', run: loadSummary }
        ];
        const results = await Promise.all(tasks.map((task) => loadPanel(task)));
        const failed = results.filter((result) => !result.ok);
        if (failed.length) {
          showErrorBanner(
            'Sebagian data gagal dimuat (' + failed.map((result) => result.error).join('; ') + '). Panel yang gagal ditandai di atas tabelnya. Angka dan tabel yang masih tampil berasal dari muat terakhir yang berhasil.'
          );
          document.getElementById('last-updated').textContent = 'Gagal memperbarui: ' + new Date().toLocaleString('id-ID');
        } else {
          document.getElementById('last-updated').textContent = new Date().toLocaleString('id-ID');
          showToast('Data sudah diperbarui.');
        }
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Muat ulang';
      }
      document.getElementById('error-retry').addEventListener('click', () => loadAll());
      document.getElementById('refresh-btn').addEventListener('click', () => loadAll());
      function syncUrlState() {
        const params = new URLSearchParams();
        if (activePhaseFilter !== 'all') params.set('phase', activePhaseFilter);
        if (searchKeyword) params.set('q', searchKeyword);
        const query = params.toString();
        history.replaceState(null, '', query ? '?' + query : location.pathname);
      }
      function paintFilterState() {
        for (const btn of document.querySelectorAll('.phase-filter')) {
          const isActive = btn.getAttribute('data-phase-filter') === activePhaseFilter;
          btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
      }
      function readUrlState() {
        const params = new URLSearchParams(location.search);
        const asked = params.get('phase') || 'all';
        const knownPhases = Array.from(document.querySelectorAll('.phase-filter')).map((btn) => btn.getAttribute('data-phase-filter'));
        activePhaseFilter = knownPhases.includes(asked) ? asked : 'all';
        searchKeyword = (params.get('q') || '').trim().toLowerCase();
        const search = document.getElementById('users-search');
        if (search) search.value = searchKeyword;
        paintFilterState();
      }
      function setPhaseFilter(next) {
        activePhaseFilter = next || 'all';
        paintFilterState();
        syncUrlState();
        renderUsersTable();
      }
      for (const btn of document.querySelectorAll('.phase-filter')) {
        btn.addEventListener('click', () => {
          setPhaseFilter(btn.getAttribute('data-phase-filter'));
        });
      }
      document.getElementById('users-search').addEventListener('input', (event) => {
        searchKeyword = String(event.target.value || '').trim().toLowerCase();
        syncUrlState();
        renderUsersTable();
      });
      readUrlState();
      loadAll();
    </script>
  </body>
</html>`;
}

function renderAdminUserDetailPage(waId) {
  const safeWaId = escapeHtml(waId || "");
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Detail User - RemindCare Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
    <style>
      :root { --bg:#f7f7f7; --panel:#fff; --text:#0f0f0f; --muted:#666; --border:#e3e3e3; --border-strong:#8a8a8a; --shadow:0 8px 26px rgba(0,0,0,.06); }
      *{box-sizing:border-box} body{margin:0;font-family:"Lato",sans-serif;background:linear-gradient(180deg,#fff 0%,#f4f4f4 100%);color:var(--text)}
      .container{width:min(1080px,100%);margin:0 auto;padding:20px}
      .top{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between}
      .title{font-size:24px;font-weight:700;margin:0}
      .muted{color:var(--muted);font-size:12px}
      .btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 14px;border-radius:10px;border:1px solid var(--border-strong);background:#fff;color:#111;text-decoration:none;font-size:13px;font-weight:700}
      .panel{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:14px;box-shadow:var(--shadow);margin-top:14px}
      .panel-title{font-size:14px;font-weight:700;margin:0 0 10px}
      .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
      .label{font-size:12px;color:var(--muted)} .value{font-size:18px;font-weight:700;margin-top:6px;overflow-wrap:anywhere}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{text-align:left;padding:10px;border-bottom:1px solid var(--border);vertical-align:top;overflow-wrap:anywhere}
      th{background:#f2f2f2}
      .table-wrap{overflow:auto;border:1px solid var(--border);border-radius:12px}
      .pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}
      .pager button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 12px;border-radius:8px;border:1px solid var(--border-strong);background:#fff;font-size:13px;font-family:inherit;cursor:pointer}
      .pager button:disabled{color:var(--muted);cursor:default}
      a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #111;outline-offset:2px}
      .stale-note{color:#8c1d1d;font-size:12px;margin:10px 0 0}
      .stale-note:empty{display:none}
      @media (max-width:720px){.container{padding:14px}.value{font-size:16px}.top{flex-direction:column;align-items:stretch}}
      @media (max-width:420px){.grid{grid-template-columns:1fr}.pager{justify-content:space-between}}
      @media (prefers-reduced-motion: reduce){*{animation:none !important;transition:none !important}}
    </style>
  </head>
  <body>
    <div class="container">
      <div class="top">
        <div>
          <h1 class="title" id="name">Detail User</h1>
          <div class="muted" id="wa">${safeWaId}</div>
        </div>
        <div class="top">
          <a class="btn" href="/admin">Kembali</a>
          <a class="btn" id="csv" href="/admin/api/users/${encodeURIComponent(
            waId || "",
          )}/export.csv">Download CSV</a>
        </div>
      </div>

      <div class="panel">
        <h2 class="panel-title">Ringkasan user</h2>
        <div class="grid">
          <div><div class="label">Status</div><div class="value" id="status">-</div></div>
          <div><div class="label">Fase</div><div class="value" id="phase">-</div></div>
          <div><div class="label">Jam pengingat</div><div class="value" id="time">-</div></div>
          <div><div class="label">Tanggal persalinan</div><div class="value" id="delivery-date">-</div></div>
          <div><div class="label">Total sudah</div><div class="value" id="sudah">-</div></div>
          <div><div class="label">Total belum</div><div class="value" id="belum">-</div></div>
        </div>
      </div>
      <p class="stale-note" id="page-note" role="status" aria-live="polite"></p>

      <div class="panel">
        <h2 class="panel-title">Data persalinan</h2>
        <div class="table-wrap"><table><caption class="muted">Data persalinan user ini.</caption><thead><tr><th scope="col">Item</th><th scope="col">Nilai</th></tr></thead><tbody id="delivery-body" aria-busy="true"><tr><td colspan="2" class="muted">Memuat data persalinan...</td></tr></tbody></table></div>
      </div>

      <div class="panel">
        <h2 class="panel-title">Riwayat kunjungan nifas dan bayi</h2>
        <div class="table-wrap"><table><caption class="muted">Riwayat kunjungan nifas dan bayi user ini.</caption><thead><tr><th scope="col">Kunjungan</th><th scope="col">Status</th><th scope="col">Tanggal</th></tr></thead><tbody id="pp-body" aria-busy="true"><tr><td colspan="3" class="muted">Memuat riwayat kunjungan...</td></tr></tbody></table></div>
      </div>

      <div class="panel">
        <h2 class="panel-title">Riwayat pengingat</h2>
        <div class="table-wrap"><table><caption class="muted">Riwayat pengingat user ini, 20 baris per halaman.</caption><thead><tr><th scope="col">Tanggal</th><th scope="col">Jawaban</th><th scope="col">Sudah</th><th scope="col">Belum</th><th scope="col">Waktu dicatat</th></tr></thead><tbody id="logs-body" aria-busy="true"><tr><td colspan="5" class="muted">Memuat riwayat pengingat...</td></tr></tbody></table></div>
        <div class="pager">
          <button type="button" id="prev">Sebelumnya</button>
          <span class="muted" id="page-info">-</span>
          <button type="button" id="next">Berikutnya</button>
        </div>
      </div>
    </div>
    <script>
      const waId = ${escapeForScriptContext(waId || "")};
      let page = 0;
      const limit = 20;
      let totalLogs = 0;
      function fmt(v){ return v===null||v===undefined||v===''?'-':v; }
      function fmtDt(v){ if(!v) return '-'; const d=new Date(v); return Number.isNaN(d.getTime())?String(v):d.toLocaleString('id-ID'); }
      function classifyPhase(user){
        const hasPostpartum = Number(user.postpartum_total || 0) > 0 || !!user.delivery_date_iso;
        if (hasPostpartum) return 'pasca_kehamilan';
        const hasLaborSignals =
          Number(user.delivery_data_step || 0) > 0 ||
          !!user.delivery_poll_stage ||
          !!user.delivery_hpl_poll_sent_date ||
          !!user.delivery_hpl3_poll_sent_date ||
          user.delivery_hpl_response === 'Sudah' ||
          user.delivery_hpl3_response === 'Sudah';
        if (hasLaborSignals) return 'persalinan';
        if (user.status === 'onboarding' || !user.hpht_iso) return 'onboarding';
        return 'kehamilan';
      }
      function phaseLabel(phase){
        if (phase === 'kehamilan') return 'Kehamilan';
        if (phase === 'persalinan') return 'Persalinan';
        if (phase === 'pasca_kehamilan') return 'Pasca Kehamilan';
        return 'Onboarding';
      }
      function setPageNote(text){
        const node = document.getElementById('page-note');
        if (!node) return;
        node.textContent = text || '';
      }
      function setBusy(id, busy){
        const node = document.getElementById(id);
        if (node) node.setAttribute('aria-busy', busy ? 'true' : 'false');
      }
      async function fetchJson(url){
        const r = await fetch(url,{headers:{Accept:'application/json'}});
        if (r.status === 401) { window.location.href = '/admin/login?expired=1'; throw new Error('Sesi berakhir'); }
        if (!r.ok) { const err = new Error('Permintaan gagal dengan kode ' + r.status); err.status = r.status; throw err; }
        return r.json();
      }
      function renderRows(tbody, rows, mapper, emptyText, colspan, rowHeader){
        tbody.innerHTML = '';
        tbody.setAttribute('aria-busy', 'false');
        if(!rows || !rows.length){ tbody.innerHTML = '<tr><td colspan="'+colspan+'" class="muted">'+emptyText+'</td></tr>'; return; }
        rows.forEach((row)=>{
          const tr=document.createElement('tr');
          mapper(row).forEach((cell, index)=>{
            const isRowHeader = !!rowHeader && index === 0;
            const cellNode=document.createElement(isRowHeader ? 'th' : 'td');
            if (isRowHeader) cellNode.setAttribute('scope', 'row');
            cellNode.textContent=fmt(cell);
            tr.appendChild(cellNode);
          });
          tbody.appendChild(tr);
        });
      }
      async function loadDetail(){
        setPageNote('');
        ['delivery-body', 'pp-body'].forEach((id)=>setBusy(id, 'true'));
        try {
          const data = await fetchJson('/admin/api/users/' + encodeURIComponent(waId));
          const user = data.user || {};
          document.getElementById('name').textContent = fmt(user.name || 'Detail User');
          document.getElementById('wa').textContent = fmt(user.wa_id);
          document.getElementById('status').textContent = fmt(user.status);
          document.getElementById('phase').textContent = phaseLabel(classifyPhase(user));
          document.getElementById('time').textContent = fmt(user.reminder_time);
          document.getElementById('delivery-date').textContent = fmt(user.delivery_date_iso || user.delivery_date);
          document.getElementById('sudah').textContent = fmt(data.totals && data.totals.total_sudah);
          document.getElementById('belum').textContent = fmt(data.totals && data.totals.total_belum);
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
            ['Keluhan ibu saat ini', user.mother_current_complaint],
            ['Data selesai diisi', user.delivery_data_completed_at]
          ];
          const filledDeliveryRows = deliveryRows.filter((row) => row[1] !== null && row[1] !== undefined && row[1] !== '');
          renderRows(document.getElementById('delivery-body'), filledDeliveryRows, (r)=>r, 'Belum ada data persalinan untuk user ini.', 2, true);
          renderRows(
            document.getElementById('pp-body'),
            data.postpartum_logs || [],
            (x)=>[x.visit_label || x.visit_code, x.response || 'Pending', fmtDt(x.response_at || x.sent_at || x.due_at)],
            'Belum ada riwayat kunjungan nifas untuk user ini.',
            3,
            false
          );
        } catch (err) {
          setBusy('delivery-body', false);
          setBusy('pp-body', false);
          if (err.status === 404) {
            setPageNote('User dengan nomor ' + waId + ' tidak ditemukan di database. Periksa nomornya di daftar user, atau kembali ke daftar.');
          } else if (err.message !== 'Sesi berakhir') {
            setPageNote('Gagal memuat detail user: ' + err.message + '. Muat ulang halaman ini untuk mencoba lagi.');
          }
        }
      }
      async function loadLogs(){
        setBusy('logs-body', true);
        try {
          const data = await fetchJson('/admin/api/users/' + encodeURIComponent(waId) + '/logs?limit=' + limit + '&offset=' + (page * limit));
          totalLogs = Number(data.total || 0);
          renderRows(
            document.getElementById('logs-body'),
            data.logs || [],
            (x)=>[x.reminder_date, x.response, x.response_sudah_count, x.response_belum_count, fmtDt(x.created_at)],
            'Belum ada riwayat pengingat untuk user ini.',
            5,
            false
          );
          const totalPages = Math.max(1, Math.ceil(totalLogs / limit));
          document.getElementById('page-info').textContent = 'Halaman ' + (page + 1) + ' dari ' + totalPages;
          document.getElementById('prev').disabled = page <= 0;
          document.getElementById('next').disabled = page >= totalPages - 1;
        } catch (err) {
          setBusy('logs-body', false);
          document.getElementById('page-info').textContent = 'Riwayat gagal dimuat';
          if (err.status === 404) {
            document.getElementById('page-info').textContent = 'User tidak ditemukan';
          } else if (err.message !== 'Sesi berakhir') {
            setPageNote('Gagal memuat riwayat pengingat: ' + err.message + '. Muat ulang halaman ini untuk mencoba lagi.');
          }
        }
      }
      document.getElementById('prev').addEventListener('click', async ()=>{ if(page<=0) return; page -= 1; await loadLogs(); });
      document.getElementById('next').addEventListener('click', async ()=>{ const tp = Math.max(1, Math.ceil(totalLogs / limit)); if(page>=tp-1) return; page += 1; await loadLogs(); });
      Promise.all([loadDetail(), loadLogs()]);
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
  const text = String(value);
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
  return {
    users: {
      total: total ? total.count : 0,
      active: active ? active.count : 0,
      paused: paused ? paused.count : 0,
      completed: completed ? completed.count : 0,
      allowed: allowed ? allowed.count : 0,
      blocked: blocked ? blocked.count : 0,
    },
    reminders: {
      todaySudah: todaySudah ? todaySudah.count : 0,
      todayBelum: todayBelum ? todayBelum.count : 0,
    },
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

async function sendPostpartumEducationIfNeeded(db, client, user, now) {
  if (
    !isPostpartumMonitoringActive(user) ||
    user.postpartum_education_sent_at
  ) {
    return false;
  }
  const sent = await sendText(
    client,
    user.wa_id,
    buildPostpartumEducationMessage(user, now),
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
  if (!skipReminderText && user.last_reminder_text_date !== dateKey) {
    const reminderText = buildReminderMessage(user, now);
    const reminderSent = await sendText(client, user.wa_id, reminderText);
    if (reminderSent) {
      await updateUser(db, user.wa_id, { last_reminder_text_date: dateKey });
    }
  }

  // Setelah beberapa hari, pengingat berbentuk poll diturunkan frekuensinya: sebagian hari
  // cukup pesan teks. Jawaban teks tetap tercatat lewat jalur jawaban harian yang sudah ada.
  const pollDaysLimit = Math.max(1, settingInt("poll_days_limit"));
  const programDay = getProgramDay(user, now);
  const usePoll =
    programDay === null || programDay <= pollDaysLimit || programDay % 2 === 0;
  if (!usePoll) {
    const textOnly = await sendText(client, user.wa_id, buildReminderMessage(user, now));
    if (!textOnly) {
      return false;
    }
    await updateUser(db, user.wa_id, {
      last_reminder_date: dateKey,
      last_reminder_text_date: dateKey,
    });
    noteScheduledSend(user.wa_id, dateKey);
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
      fe_poll_last_attempt_at: now.toISO(),
      fe_poll_fail_count: Math.min(cappedAttempts, MAX_SEND_ATTEMPTS),
    });
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
  const sent = await sendText(client, user.wa_id, phaseMessage);
  if (!sent) {
    return false;
  }
  noteScheduledSend(user.wa_id, today);
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
    const introSent = await sendText(client, user.wa_id, intro);
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

async function handleMessage(db, client, msg) {
  if (msg.fromMe) {
    return;
  }
  if (msg.from.endsWith("@g.us") || msg.isStatus) {
    return;
  }

  const text = msg.body ? msg.body.trim() : "";
  const waId = msg.from;
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

  const seed = {
    is_admin: ADMIN_WA_IDS.has(waId),
    is_allowed: ALLOWLIST_WA_IDS.has(waId),
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
const RUNTIME_SETTING_DEFS = {
  send_window_start_hour: { type: "int", min: 0, max: 23, fallback: 6, guardKey: "windowStartHour" },
  send_window_end_hour: { type: "int", min: 0, max: 23, fallback: 21, guardKey: "windowEndHour" },
  send_window_end_minute: { type: "int", min: 0, max: 59, fallback: 30, guardKey: "windowEndMinute" },
  send_min_gap_ms: { type: "int", min: 1500, max: 60000, fallback: 3500, guardKey: "minGapMs" },
  send_jitter_ms: { type: "int", min: 0, max: 60000, fallback: 2500, guardKey: "jitterMs" },
  send_max_per_minute: { type: "int", min: 1, max: 60, fallback: 12, guardKey: "maxPerMinute" },
  send_max_per_hour: { type: "int", min: 1, max: 1000, fallback: 180, guardKey: "maxPerHour" },
  send_max_per_day: { type: "int", min: 1, max: 5000, fallback: 900, guardKey: "maxPerDay" },
  reminder_stale_after_minutes: { type: "int", min: 0, max: 720, fallback: 30 },
  max_send_attempts: { type: "int", min: 1, max: 20, fallback: 4 },
  reminder_log_retention_days: { type: "int", min: 7, max: 3650, fallback: 180 },
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
  app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });


  const requireAdmin = (req, res, next) => {
    const token = getAdminSession(req);
    if (token) {
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
          ),
        );
      return;
    }

    const usernameOk = !username || username === ADMIN_WEB_USER;
    const passwordOk = await verifyAdminPassword(db, password, passwordConfig);
    if (!usernameOk || !passwordOk) {
      registerAdminLoginFailure(ip, username);
      res
        .status(401)
        .send(renderAdminLoginPage("Username atau password salah."));
      return;
    }

    clearAdminLoginFailures(ip);
    const token = createAdminSession();
    setAdminCookie(res, token);
    res.redirect("/admin");
  });

  app.post("/admin/logout", requireAdmin, (req, res) => {
    clearAdminCookie(res);
    res.redirect("/admin/login");
  });

  app.get("/admin", requireAdmin, (req, res) => {
    res.send(renderAdminDashboardPage());
  });

  app.get("/admin/settings", requireAdmin, (req, res) => {
    res.send(renderAdminSettingsPage());
  });

  app.get("/admin/api/settings", requireAdmin, async (req, res) => {
    try {
      res.json({ ok: true, settings: settingsSnapshot() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/admin/api/settings", requireAdmin, async (req, res) => {
    try {
      const result = await saveRuntimeSettings(db, req.body || {});
      res.json({
        ok: true,
        applied: result.applied,
        rejected: result.rejected,
        settings: settingsSnapshot(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
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
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/admin/api/emergency", requireAdmin, async (req, res) => {
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
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/admin/api/users/:waId/actions", requireAdmin, async (req, res) => {
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
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/admin/users/:waId", requireAdmin, (req, res) => {
    const waId = String(req.params.waId || "").trim();
    // Nilai ini masuk ke HTML dan blok script halaman detail, jadi formatnya dibatasi.
    if (!/^[0-9A-Za-z@._:-]{3,64}$/.test(waId)) {
      res.status(400).send("Invalid user");
      return;
    }
    res.send(renderAdminUserDetailPage(waId));
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
  isReminderControlCommand,
  parsePostpartumCorrection,
  resolveVisitCode,
};
