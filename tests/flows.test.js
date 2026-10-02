"use strict";

// Uji alur yang benar-benar dijalankan bot: pesan masuk, perintah admin, tindak lanjut
// harian, dan kanal alarm. Semua di sini berjalan di database sementara supaya tidak
// menyentuh data produksi.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "remindcare-flows-"));
const DATA_DIR = path.join(WORK, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.DATA_DIR = DATA_DIR;
process.env.ENFORCE_ALLOWLIST = "1";
process.env.ALLOWLIST_WA_IDS = "6282240269818";
process.env.ADMIN_WA_IDS = "6282240269818";
process.env.SEND_MIN_GAP_MS = "5";
process.env.SEND_JITTER_MS = "5";
process.env.REPLY_MIN_GAP_MS = "5";
process.env.REPLY_JITTER_MS = "5";
process.env.ALERT_COOLDOWN_MS = "0";

const mod = require("../index.js");

const ADMIN = "6282240269818@c.us";

async function test(name, fn) {
  try {
    await fn();
    console.log("ok -", name);
  } catch (err) {
    console.error("FAIL -", name);
    console.error(err);
    process.exit(1);
  }
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function makeClient(sent) {
  return {
    info: { wid: { _serialized: "6285800610000@c.us" } },
    async sendMessage(target, payload) {
      const body = payload && payload.body !== undefined ? payload.body : String(payload);
      sent.push({ target, body });
      return { id: { _serialized: `true_${target}_MSG${sent.length}` } };
    },
  };
}

let msgSeq = 0;
function makeMsg(from, body, options = {}) {
  msgSeq += 1;
  return {
    from,
    body,
    hasMedia: Boolean(options.hasMedia),
    isStatus: false,
    id: { _serialized: `MSG-${msgSeq}` },
    getContact: async () => ({ number: options.number || "" }),
  };
}

// Server penerima alarm: menggantikan Telegram dan webhook supaya yang diuji adalah isi
// permintaannya, bukan jaringan luar.
function startReceiver() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      bodies.push({ url: req.url, body: raw });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, bodies, port: server.address().port }));
  });
}

async function run2() {
  const db = mod.__openDbForTest();
  await mod.__initDbForTest(db);
  await mod.ensureSettingsTable(db);
  await mod.setSetting(db, "enforce_allowlist", 1);
  await mod.loadRuntimeSettings(db);
  mod.__setSendReadyForTest(true);

  const nowIso = new Date().toISOString();
  await run(
    db,
    `INSERT OR REPLACE INTO users (wa_id, name, status, onboarding_step, is_admin, is_allowed,
      is_blocked, allow_remindcare, reminder_time, created_at, updated_at)
     VALUES (?, 'Admin', 'active', 0, 1, 1, 0, 1, '10:30', ?, ?)`,
    [ADMIN, nowIso, nowIso],
  );
  const adminRow = await get(db, "SELECT * FROM users WHERE wa_id = ?", [ADMIN]);
  const sent = [];
  const client = makeClient(sent);
  const PATIENT = "6285794961470@c.us";

  await test("start pada nomor hasil admin allow mengirim pertanyaan 1, tidak lompat ke jam", async () => {
    await mod.addPanelAllowedNumber(db, PATIENT, null, "panel", "admin");
    sent.length = 0;
    await mod.__handleMessageForTest(db, client, makeMsg(PATIENT, "start", { number: "6285794961470" }));
    assert.ok(
      sent.some((m) => /Pertanyaan 1 dari \d+/.test(m.body)),
      JSON.stringify(sent),
    );
    const row = await get(db, "SELECT * FROM users WHERE wa_id = ?", [PATIENT]);
    assert.strictEqual(Number(row.onboarding_step), 1);
    assert.strictEqual(row.status, "onboarding");
  });

  await test("jawaban nama tanpa huruf ditolak, nama benar lanjut ke pertanyaan 2", async () => {
    sent.length = 0;
    await mod.__handleMessageForTest(db, client, makeMsg(PATIENT, "12345", { number: "6285794961470" }));
    assert.ok(sent.some((m) => /belum berisi huruf/.test(m.body)), JSON.stringify(sent));
    sent.length = 0;
    await mod.__handleMessageForTest(db, client, makeMsg(PATIENT, "Aulia", { number: "6285794961470" }));
    assert.ok(sent.some((m) => /Pertanyaan 2 dari \d+/.test(m.body)), JSON.stringify(sent));
  });

  await test("usia di luar rentang diberi jalan keluar ke admin", async () => {
    sent.length = 0;
    await mod.__handleMessageForTest(db, client, makeMsg(PATIENT, "14", { number: "6285794961470" }));
    assert.ok(sent.some((m) => /hubungi admin/i.test(m.body)), JSON.stringify(sent));
  });

  await test("nomor asing tidak dapat balasan panduan media", async () => {
    sent.length = 0;
    await mod.__handleMessageForTest(
      db,
      client,
      makeMsg("628999999999@c.us", "", { hasMedia: true, number: "628999999999" }),
    );
    assert.ok(!sent.some((m) => /belum bisa membaca/.test(m.body)), JSON.stringify(sent));
  });

  await test("nomor diblokir tidak dapat balasan media", async () => {
    await run(
      db,
      `INSERT OR REPLACE INTO users (wa_id, status, onboarding_step, is_admin, is_allowed,
        is_blocked, created_at, updated_at) VALUES (?, 'active', 0, 0, 1, 1, ?, ?)`,
      ["628777000111@c.us", nowIso, nowIso],
    );
    sent.length = 0;
    await mod.__handleMessageForTest(
      db,
      client,
      makeMsg("628777000111@c.us", "", { hasMedia: true, number: "628777000111" }),
    );
    assert.deepStrictEqual(sent, []);
  });

  await test("nomor yang diizinkan tetap dapat panduan mengetik saat kirim media", async () => {
    sent.length = 0;
    await mod.__handleMessageForTest(db, client, makeMsg(ADMIN, "", { hasMedia: true, number: "6282240269818" }));
    assert.ok(sent.some((m) => /belum bisa membaca/.test(m.body)), JSON.stringify(sent));
  });

  await test("admin unblock menyalakan lagi pengingatnya", async () => {
    await run(
      db,
      "UPDATE users SET is_blocked = 1, allow_remindcare = 0, status = 'paused' WHERE wa_id = ?",
      ["628777000111@c.us"],
    );
    sent.length = 0;
    await mod.__handleAdminCommandForTest(db, client, adminRow, "admin unblock 628777000111");
    const row = await get(
      db,
      "SELECT is_blocked, allow_remindcare, status FROM users WHERE wa_id = ?",
      ["628777000111@c.us"],
    );
    assert.strictEqual(Number(row.is_blocked), 0);
    assert.strictEqual(Number(row.allow_remindcare), 1);
    assert.strictEqual(row.status, "active");
  });

  await test("admin allow menolak alamat perangkat dan merapikan nomor gaya lokal", async () => {
    sent.length = 0;
    await mod.__handleAdminCommandForTest(db, client, adminRow, "admin allow 204930287689898@lid");
    assert.ok(sent.some((m) => /Pakai nomor Ibu/.test(m.body)), JSON.stringify(sent));
    await mod.__handleAdminCommandForTest(db, client, adminRow, "admin allow 081234500099");
    const row = await get(db, "SELECT wa_id FROM users WHERE wa_id = ?", ["6281234500099@c.us"]);
    assert.ok(row, "nomor 08xx harus tersimpan sebagai 62xx");
  });

  await test("admin purge menolak argumen bukan angka", async () => {
    sent.length = 0;
    await mod.__handleAdminCommandForTest(db, client, adminRow, "admin purge abc");
    assert.ok(sent.some((m) => /angka hari/.test(m.body)), JSON.stringify(sent));
  });

  await test("denyut proses ditulis dan memuat kesiapan sesi", async () => {
    const payload = mod.writeHeartbeat({ phase: "uji" });
    const file = path.join(DATA_DIR, "heartbeat.json");
    assert.ok(fs.existsSync(file), "berkas denyut harus ada");
    const read = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(!Number.isNaN(Date.parse(read.at)), "waktu denyut harus bisa dibaca");
    assert.strictEqual(read.ready, true);
    assert.strictEqual(read.phase, "uji");
    assert.strictEqual(payload.pid, process.pid);
  });

  await test("pendataan yang berhenti didorong sekali sehari, bukan berulang", async () => {
    const lama = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await run(
      db,
      `INSERT OR REPLACE INTO users (wa_id, name, status, onboarding_step, is_admin, is_allowed,
        is_blocked, allow_remindcare, created_at, updated_at)
       VALUES (?, NULL, 'onboarding', 2, 0, 1, 0, 0, ?, ?)`,
      ["6285700000001@c.us", lama, lama],
    );
    sent.length = 0;
    const first = await mod.runDailyFollowUps(db, client, require("luxon").DateTime.now().setZone("Asia/Jakarta"), "2026-10-02");
    assert.strictEqual(first.nudged, 1, JSON.stringify(first));
    assert.ok(
      sent.some((m) => m.target === "6285700000001@c.us" && /Ketik \*start\*/.test(m.body)),
      JSON.stringify(sent),
    );
    const row = await get(db, "SELECT last_onboarding_nudge_date FROM users WHERE wa_id = ?", [
      "6285700000001@c.us",
    ]);
    assert.strictEqual(row.last_onboarding_nudge_date, "2026-10-02");
    sent.length = 0;
    const second = await mod.runDailyFollowUps(db, client, require("luxon").DateTime.now().setZone("Asia/Jakarta"), "2026-10-02");
    assert.strictEqual(second.nudged, 0, JSON.stringify(second));
    assert.deepStrictEqual(sent, []);
    assert.ok(first.stuck.includes("6285700000001@c.us"), JSON.stringify(first.stuck));
  });

  await test("pasien yang berhenti menjawab masuk daftar perlu tindakan", () => {
    const item = mod.buildNeedsAction([
      {
        wa_id: "6285711112222@c.us",
        status: "active",
        reminder_time: "19:00",
        allow_remindcare: 1,
        last_reminder_date: "2026-09-20",
        last_response_date: "2026-09-21",
      },
    ]);
    assert.strictEqual(item.length, 1);
    assert.strictEqual(item[0].reason, "no_answer");
    const hariIni = new Date().toISOString().slice(0, 10);
    const masihRajin = mod.buildNeedsAction([
      {
        wa_id: "6285711113333@c.us",
        status: "active",
        reminder_time: "19:00",
        allow_remindcare: 1,
        last_reminder_date: hariIni,
        last_response_date: hariIni,
      },
    ]);
    assert.deepStrictEqual(masihRajin, []);
    // Pasien baru yang belum pernah menjawab belum boleh dicap berhenti menjawab.
    const pasienBaru = mod.buildNeedsAction([
      {
        wa_id: "6285711114444@c.us",
        status: "active",
        reminder_time: "19:00",
        allow_remindcare: 1,
        last_reminder_date: hariIni,
        last_response_date: null,
        first_reminder_date: hariIni,
      },
    ]);
    assert.deepStrictEqual(pasienBaru, []);
    // Akun admin tidak ikut dihitung sebagai pasien.
    const admin = mod.buildNeedsAction([
      {
        wa_id: "6282240269818@c.us",
        status: "active",
        reminder_time: "10:30",
        allow_remindcare: 1,
        is_admin: 1,
        last_reminder_date: "2026-09-20",
        last_response_date: "2026-09-01",
      },
    ]);
    assert.deepStrictEqual(admin, []);
  });

  await test("alarm harian sampai ke webhook dan ke Telegram", async () => {
    const { server, bodies, port } = await startReceiver();
    process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
    process.env.ALERT_TELEGRAM_TOKEN = "token-uji";
    process.env.ALERT_TELEGRAM_CHAT_ID = "12345";
    process.env.ALERT_TELEGRAM_API_BASE = `http://127.0.0.1:${port}`;
    try {
      await run(
        db,
        `UPDATE users SET status = 'active', allow_remindcare = 1, reminder_time = '19:00',
          last_reminder_date = '2026-09-20'
         WHERE wa_id = ?`,
        [PATIENT],
      );
      // Jawaban terakhir dibaca dari catatan pengingat, bukan dari tabel users.
      await run(
        db,
        `INSERT OR REPLACE INTO reminder_logs (wa_id, reminder_date, response, created_at)
         VALUES (?, '2026-09-21', 'Sudah', ?)`,
        [PATIENT, new Date().toISOString()],
      );
      // Pasien yang baru mulai kemarin belum boleh dianggap berhenti menjawab.
      await run(
        db,
        `INSERT OR REPLACE INTO users (wa_id, name, status, onboarding_step, is_admin, is_allowed,
          is_blocked, allow_remindcare, reminder_time, last_reminder_date, created_at, updated_at)
         VALUES ('6285700000002@c.us', 'Pasien Baru', 'active', 9, 0, 1, 0, 1, '19:00', ?, ?, ?)`,
        [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10), nowIso, nowIso],
      );
      await run(
        db,
        `INSERT OR REPLACE INTO reminder_logs (wa_id, reminder_date, response, created_at)
         VALUES ('6285700000002@c.us', ?, NULL, ?)`,
        [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10), nowIso],
      );
      const hasil = await mod.runDailyFollowUps(
        db,
        client,
        require("luxon").DateTime.now().setZone("Asia/Jakarta"),
        "2026-10-03",
      );
      assert.ok(hasil.silent.includes(PATIENT), JSON.stringify(hasil.silent));
      assert.ok(!hasil.silent.includes("6285700000002@c.us"), "pasien baru tidak boleh masuk daftar sepi");
      assert.ok(!hasil.silent.includes(ADMIN), "akun admin tidak boleh masuk daftar sepi");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const hook = bodies.find((b) => b.url === "/hook" && /pasien-sepi/.test(b.body));
      const telegram = bodies.find(
        (b) => b.url.includes("/bottoken-uji/sendMessage") && /pasien-sepi/.test(b.body),
      );
      assert.ok(hook, "webhook harus menerima alarm: " + JSON.stringify(bodies));
      assert.ok(telegram, "Telegram harus menerima alarm: " + JSON.stringify(bodies));
      const isiHook = JSON.parse(hook.body);
      assert.strictEqual(isiHook.kind, "pasien-sepi");
      assert.ok(/tidak menjawab pengingat/.test(isiHook.detail), isiHook.detail);
      const isiTelegram = JSON.parse(telegram.body);
      assert.strictEqual(isiTelegram.chat_id, "12345");
      assert.ok(/pasien-sepi/.test(isiTelegram.text), isiTelegram.text);
    } finally {
      delete process.env.ALERT_WEBHOOK_URL;
      delete process.env.ALERT_TELEGRAM_TOKEN;
      delete process.env.ALERT_TELEGRAM_CHAT_ID;
      delete process.env.ALERT_TELEGRAM_API_BASE;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  db.close();
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log("semua uji alur lulus");
}

run2().catch((err) => {
  console.error("Uji alur gagal:", err);
  process.exit(1);
});
