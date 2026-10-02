#!/usr/bin/env node
"use strict";
// Penjaga di luar proses bot. Bot bisa mati, menggantung, atau kehilangan sesi WhatsApp
// tanpa ada yang tahu, dan alarm dari dalam bot tidak menolong kalau botnya sendiri yang
// rusak. Skrip ini dijalankan timer systemd, membaca berkas denyut dari bot, lalu mengirim
// alarm lewat jalur yang tidak bergantung WhatsApp: webhook generik atau Telegram.
//
// Pemakaian:
//   node scripts/watchdog.js             periksa sekali, kirim alarm kalau perlu
//   node scripts/watchdog.js --dry-run   cetak keputusan tanpa mengirim atau merestart
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DRY_RUN = process.argv.includes("--dry-run");
const ROOT = path.resolve(__dirname, "..");
// Setelan alarm hidup di .env yang sama dengan bot, dan penjaga tidak boleh bergantung
// pada systemd yang kebetulan sudah menyuntikkan variabelnya.
require(path.join(ROOT, "lib/env-file")).loadEnvFile(path.join(ROOT, ".env"));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const HEARTBEAT_FILE = path.join(DATA_DIR, "heartbeat.json");
const STATE_FILE = path.join(DATA_DIR, "watchdog-state.json");

const MAX_AGE_MS = Number(process.env.WATCHDOG_MAX_AGE_MS || 10 * 60 * 1000);
const NOT_READY_MS = Number(process.env.WATCHDOG_NOT_READY_MS || 20 * 60 * 1000);
const REPEAT_MS = Number(process.env.WATCHDOG_REPEAT_MS || 6 * 60 * 60 * 1000);
const SERVICE = String(process.env.WATCHDOG_SERVICE || "remindcare-bot");
const AUTO_RESTART = String(process.env.WATCHDOG_RESTART || "0") === "1";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return null;
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
  } catch (err) {
    console.error("Gagal menyimpan state penjaga:", err.message);
  }
}

function minutes(ms) {
  return Math.round(ms / 60000);
}

// Mengembalikan { problem } atau { problem: null } kalau semuanya wajar.
function inspect(state, nowMs) {
  if (!fs.existsSync(HEARTBEAT_FILE)) {
    return {
      problem: "berkas denyut belum ada, bot mungkin belum pernah jalan",
      state,
      alert: { kind: "watchdog-denyut", detail: "Berkas denyut tidak ditemukan." },
    };
  }
  const heartbeat = readJson(HEARTBEAT_FILE);
  const at = heartbeat ? Date.parse(heartbeat.at) : NaN;
  if (!heartbeat || !Number.isFinite(at)) {
    return {
      problem: "berkas denyut ada tetapi isinya tidak terbaca",
      state,
      alert: {
        kind: "watchdog-denyut",
        detail: `Isi ${HEARTBEAT_FILE} tidak bisa dibaca sebagai JSON berisi waktu.`,
      },
    };
  }
  const age = nowMs - at;
  if (age > MAX_AGE_MS) {
    return {
      problem: `denyut terakhir ${minutes(age)} menit lalu (batas ${minutes(MAX_AGE_MS)} menit)`,
      state,
      alert: {
        kind: "watchdog-denyut",
        detail: `Bot tidak menulis denyut selama ${minutes(age)} menit. Proses bisa menggantung atau mati.`,
      },
    };
  }
  if (heartbeat.ready !== true) {
    const since = state.notReadySince || nowMs;
    const nextState = { ...state, notReadySince: since };
    if (nowMs - since > NOT_READY_MS) {
      return {
        problem: `sesi WhatsApp belum siap ${minutes(nowMs - since)} menit`,
        state: nextState,
        alert: {
          kind: "watchdog-sesi",
          detail: `Proses hidup dan menulis denyut, tetapi sesi WhatsApp belum siap selama ${minutes(nowMs - since)} menit. Perlu pemindaian QR atau taut ulang.`,
        },
      };
    }
    return { problem: null, state: nextState, alert: null };
  }
  return { problem: null, state: { ...state, notReadySince: null }, alert: null };
}

async function deliver(payload) {
  const body = JSON.stringify(payload);
  const targets = [];
  const webhookUrl = String(process.env.ALERT_WEBHOOK_URL || "").trim();
  if (webhookUrl) {
    targets.push(webhookUrl);
  }
  const token = String(process.env.ALERT_TELEGRAM_TOKEN || "").trim();
  const chat = String(process.env.ALERT_TELEGRAM_CHAT_ID || "").trim();
  let telegramUrl = null;
  if (token && chat) {
    const apiBase = String(
      process.env.ALERT_TELEGRAM_API_BASE || "https://api.telegram.org",
    ).replace(/\/+$/, "");
    telegramUrl = `${apiBase}/bot${token}/sendMessage`;
    targets.push(telegramUrl);
  }
  if (targets.length === 0) {
    console.error(
      "Tidak ada jalur alarm di luar WhatsApp. Isi ALERT_WEBHOOK_URL atau ALERT_TELEGRAM_TOKEN dan ALERT_TELEGRAM_CHAT_ID.",
    );
    return false;
  }
  for (const url of targets) {
    const isTelegram = url === telegramUrl;
    const options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: isTelegram
        ? JSON.stringify({ chat_id: chat, text: `${payload.kind}: ${payload.detail}` })
        : body,
    };
    if (DRY_RUN) {
      console.log(`[dry-run] kirim ke ${url}: ${options.body}`);
      continue;
    }
    try {
      // Tanpa batas waktu, jalur alarm yang menggantung membuat penjaga ikut menggantung.
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(Number(process.env.ALERT_TIMEOUT_MS || 10000)),
      });
      if (!res.ok) {
        console.error(`Jalur alarm ${url} menolak: HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`Gagal mengirim alarm ke ${url}:`, err.message);
    }
  }
  return true;
}

function restartService() {
  if (!AUTO_RESTART) {
    return;
  }
  if (DRY_RUN) {
    console.log(`[dry-run] restart layanan ${SERVICE}`);
    return;
  }
  try {
    execFileSync("sudo", ["-n", "/usr/bin/systemctl", "restart", SERVICE]);
    console.log(`Layanan ${SERVICE} direstart oleh penjaga.`);
  } catch (err) {
    console.error(`Gagal merestart ${SERVICE}:`, err.message);
  }
}

async function main() {
  const nowMs = Date.now();
  const state = readJson(STATE_FILE) || {};
  const { problem, state: nextState, alert } = inspect(state, nowMs);
  const stamp = new Date(nowMs).toISOString();

  if (!problem) {
    if (state.lastProblem) {
      console.log(`Wajar kembali: masalah sebelumnya (${state.lastProblem}) tidak terlihat lagi.`);
    } else if (process.stdout.isTTY) {
      // Ringkasan hanya saat dijalankan manual: timer systemd tidak perlu menulis
      // "wajar" ke journal tiap lima menit.
      const heartbeat = readJson(HEARTBEAT_FILE) || {};
      console.log(
        `Wajar: denyut terakhir ${heartbeat.at || "tidak diketahui"}, sesi siap: ${heartbeat.ready === true}.`,
      );
    }
    writeState({ ...nextState, lastProblem: null, lastAlertAt: state.lastAlertAt || null });
    return;
  }

  const repeated = state.lastProblem === problem;
  const lastAlertAt = Number(state.lastAlertAt || 0);
  const cooledDown = nowMs - lastAlertAt > REPEAT_MS;
  console.error(`MASALAH: ${problem}`);

  if (!repeated || cooledDown) {
    const payload = { kind: alert.kind, detail: alert.detail, at: stamp, problem };
    const terkirim = await deliver(payload);
    // Kalau tidak ada jalur alarm yang bisa dipakai, waktu alarm tidak dicatat supaya
    // masalahnya tetap ditulis tiap kali diperiksa, bukan ditelan diam-diam.
    writeState({
      ...nextState,
      lastProblem: problem,
      lastAlertAt: terkirim ? nowMs : lastAlertAt,
    });
    restartService();
    return;
  }
  writeState({ ...nextState, lastProblem: problem, lastAlertAt });
  console.error(
    `Masalah yang sama belum diulang ke operator (batas ${minutes(REPEAT_MS)} menit).`,
  );
}

main().catch((err) => {
  console.error("Penjaga gagal jalan:", err);
  process.exitCode = 1;
});
