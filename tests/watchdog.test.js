"use strict";
// Uji penjaga luar proses: keadaan wajar, denyut basi, denyut tidak ada, sesi belum siap,
// pengulangan alarm, dan mode dry-run. Penjaga dijalankan sebagai proses terpisah supaya
// penerima alarm di sini tetap bisa menjawab permintaannya.
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
let total = 0;
function check(label, ok, detail) {
  total += 1;
  if (!ok) {
    console.error("FAIL -", label, detail === undefined ? "" : "| " + detail);
    process.exit(1);
  }
  console.log("ok -", label);
  return true;
}

const bodies = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    bodies.push({ url: req.url, body: raw });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});

function runWatchdog(extraEnv, args) {
  const env = {
    ...process.env,
    DATA_DIR: WORK,
    ALERT_WEBHOOK_URL: `http://127.0.0.1:${server.address().port}/hook`,
    ALERT_TELEGRAM_TOKEN: "tok",
    ALERT_TELEGRAM_CHAT_ID: "42",
    ALERT_TELEGRAM_API_BASE: `http://127.0.0.1:${server.address().port}`,
    WATCHDOG_RESTART: "0",
    ...extraEnv,
  };
  return new Promise((resolve) => {
    execFile(
      "node",
      [path.join(REPO, "scripts/watchdog.js"), ...(args || [])],
      { env, encoding: "utf8", timeout: 20000 },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, out: String(stdout || "") + String(stderr || "") });
      },
    );
  });
}

function writeHeartbeat(ageMs, ready) {
  const at = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(path.join(WORK, "heartbeat.json"), JSON.stringify({ at, ready, pid: process.pid }));
}

server.listen(0, "127.0.0.1", async () => {
  // 1. denyut segar dan sesi siap
  writeHeartbeat(1000, true);
  let r = await runWatchdog({ WATCHDOG_MAX_AGE_MS: "600000" });
  check("denyut segar dilaporkan wajar", r.code === 0 && !/MASALAH/.test(r.out), r.out.trim().slice(0, 80));
  check("tidak ada alarm dikirim saat wajar", bodies.length === 0, bodies.length);

  // 2. denyut basi
  fs.rmSync(path.join(WORK, "watchdog-state.json"), { force: true });
  writeHeartbeat(30 * 60 * 1000, true);
  r = await runWatchdog({ WATCHDOG_MAX_AGE_MS: "600000" });
  check("denyut basi dilaporkan sebagai masalah", /MASALAH: denyut terakhir 30 menit lalu/.test(r.out), r.out.trim().slice(0, 100));
  await new Promise((res) => setTimeout(res, 300));
  const hook = bodies.find((b) => b.url === "/hook");
  const tg = bodies.find((b) => /\/bottok\/sendMessage/.test(b.url));
  check("webhook menerima alarm", Boolean(hook), JSON.stringify(bodies.map((b) => b.url)));
  check("telegram menerima alarm", Boolean(tg), JSON.stringify(bodies.map((b) => b.url)));
  if (hook) {
    const payload = JSON.parse(hook.body);
    check("payload alarm memuat jenis dan sebab", payload.kind === "watchdog-denyut" && /menggantung atau mati/.test(payload.detail), payload.detail);
  }

  // 3. masalah sama tidak diulang dalam jendela
  bodies.length = 0;
  r = await runWatchdog({ WATCHDOG_MAX_AGE_MS: "600000" });
  await new Promise((res) => setTimeout(res, 200));
  check("masalah sama tidak diulang", bodies.length === 0 && /belum diulang/.test(r.out), r.out.trim().slice(-60));

  // 4. masalah hilang
  writeHeartbeat(1000, true);
  r = await runWatchdog({ WATCHDOG_MAX_AGE_MS: "600000" });
  check("wajar kembali dilaporkan", /Wajar kembali/.test(r.out), r.out.trim());

  // 5. sesi WhatsApp belum siap terlalu lama. Alarm baru keluar setelah keadaan itu
  // bertahan, jadi penjaga harus jalan dua kali: pertama mencatat, kedua melaporkan.
  fs.rmSync(path.join(WORK, "watchdog-state.json"), { force: true });
  writeHeartbeat(1000, false);
  const sekali = await runWatchdog({ WATCHDOG_MAX_AGE_MS: "600000", WATCHDOG_NOT_READY_MS: "1" });
  check("sesi belum siap belum dilaporkan pada pemeriksaan pertama", !/MASALAH/.test(sekali.out), sekali.out.trim().slice(0, 70));
  writeHeartbeat(1000, false);
  r = await runWatchdog({ WATCHDOG_MAX_AGE_MS: "600000", WATCHDOG_NOT_READY_MS: "1" });
  check("sesi belum siap dilaporkan pada pemeriksaan berikutnya", /MASALAH: sesi WhatsApp belum siap/.test(r.out), r.out.trim().slice(0, 90));

  // 6. berkas denyut belum ada
  fs.rmSync(path.join(WORK, "heartbeat.json"), { force: true });
  fs.rmSync(path.join(WORK, "watchdog-state.json"), { force: true });
  r = await runWatchdog({ WATCHDOG_MAX_AGE_MS: "600000" });
  check("denyut yang belum ada dilaporkan", /MASALAH: berkas denyut belum ada/.test(r.out), r.out.trim().slice(0, 90));

  // 7. mode dry-run tidak mengirim
  fs.rmSync(path.join(WORK, "watchdog-state.json"), { force: true });
  bodies.length = 0;
  r = await runWatchdog({ WATCHDOG_MAX_AGE_MS: "600000" }, ["--dry-run"]);
  await new Promise((res) => setTimeout(res, 300));
  check(
    "dry-run mencetak rencana tanpa mengirim",
    bodies.length === 0 && /\[dry-run\] kirim ke/.test(r.out),
    r.out.trim().slice(0, 90),
  );

  fs.rmSync(WORK, { recursive: true, force: true });
  server.close();
  console.log("semua uji penjaga lulus (" + total + " pemeriksaan)");
});
