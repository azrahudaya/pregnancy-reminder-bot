"use strict";

// Uji integrasi panel admin lewat HTTP sungguhan: login, sesi, CSRF, daftar akses nomor,
// dan halaman detail user. Server dan database berjalan di direktori sementara.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "remindcare-http-"));
const DATA_DIR = path.join(WORK, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const PASSWORD = "uji-panel-123";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

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

let bot = null;
let port = 0;

function request(method, urlPath, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: options.headers || {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", (err) => resolve({ status: 0, error: err.message }));
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function run() {
  port = await freePort();
  process.env.DATA_DIR = DATA_DIR;
  process.env.ADMIN_WEB_ENABLED = "1";
  process.env.ADMIN_WEB_HOST = "127.0.0.1";
  process.env.ADMIN_WEB_PORT = String(port);
  process.env.ADMIN_WEB_PASSWORD = PASSWORD;
  process.env.ADMIN_WA_IDS = "628111222333";
  process.env.ALLOWLIST_WA_IDS = "628111222333";
  process.env.ENFORCE_ALLOWLIST = "1";

  bot = require("../index.js");
  const db = bot.__openDbForTest();
  await bot.__initDbForTest(db);
  await bot.ensureSettingsTable(db);
  await bot.loadRuntimeSettings(db);
  const server = await bot.__startAdminServerForTest(db);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const origin = "http://127.0.0.1:" + port;
  let sessionCookie = "";
  let csrf = "";

  await test("halaman login dilayani dengan header aman", async () => {
    const res = await request("GET", "/admin/login");
    assert.strictEqual(res.status, 200);
    assert.ok(!res.headers["x-powered-by"], "x-powered-by harus dimatikan");
    assert.ok(
      String(res.headers["content-security-policy"] || "").includes("nonce-"),
      "CSP dengan nonce harus ada",
    );
    assert.ok(res.body.includes("<h1>"), "halaman login memakai h1");
    assert.ok(!res.body.includes("<h2>"), "tidak ada h2 yang melompati tingkat");
  });

  await test("halaman dan API tanpa sesi ditolak", async () => {
    const halaman = await request("GET", "/admin");
    assert.strictEqual(halaman.status, 302);
    const api = await request("GET", "/admin/api/allowlist");
    assert.strictEqual(api.status, 401);
    const health = await request("GET", "/admin/api/health");
    assert.strictEqual(health.status, 401);
  });

  await test("login dari situs lain ditolak, password salah ditolak", async () => {
    const lintasSitus = await request("POST", "/admin/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://situs-lain.example" },
      body: "username=admin&password=" + PASSWORD,
    });
    assert.strictEqual(lintasSitus.status, 403);
    const salah = await request("POST", "/admin/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
      body: "username=admin&password=salah",
    });
    assert.strictEqual(salah.status, 401);
  });

  await test("login benar memberi cookie HttpOnly SameSite=Strict", async () => {
    const res = await request("POST", "/admin/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
      body: "username=admin&password=" + PASSWORD,
    });
    assert.strictEqual(res.status, 302);
    const cookie = String(res.headers["set-cookie"] || "");
    assert.ok(/HttpOnly/i.test(cookie), cookie);
    assert.ok(/SameSite=Strict/i.test(cookie), cookie);
    sessionCookie = cookie.split(";")[0];
  });

  await test("dashboard terbuka dengan sesi dan memuat panel akses", async () => {
    const res = await request("GET", "/admin", { headers: { Cookie: sessionCookie } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes("Akses nomor"), "panel akses nomor harus dirender");
    csrf = (res.body.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
    assert.ok(csrf, "token CSRF harus tersedia");
  });

  await test("halaman detail user memuat tindakan operator", async () => {
    const res = await request("GET", "/admin/users/628111222333%40c.us", {
      headers: { Cookie: sessionCookie },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes("aksi-pause"), "tombol jeda harus ada");
    assert.ok(res.body.includes("aksi-simpan-jam"), "tombol ubah jam harus ada");
  });

  await test("aksi tanpa token CSRF ditolak", async () => {
    const res = await request("POST", "/admin/api/allowlist/actions", {
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ action: "add", wa_id: "081234567890" }),
    });
    assert.strictEqual(res.status, 403);
  });

  await test("tambah nomor 08xx diseragamkan dan daftar menyebut asal barisnya", async () => {
    const res = await request("POST", "/admin/api/allowlist/actions", {
      headers: { "Content-Type": "application/json", Cookie: sessionCookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({ action: "add", wa_id: "081234567890" }),
    });
    const data = JSON.parse(res.body || "{}");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.wa_id, "6281234567890@c.us");
    assert.ok(Array.isArray(data.panel));
    assert.ok(
      data.panel.every((row) => typeof row.from_env === "boolean"),
      "tiap baris harus punya penanda asal",
    );
  });

  await test("nomor tidak sah ditolak dengan pesan contoh", async () => {
    const res = await request("POST", "/admin/api/allowlist/actions", {
      headers: { "Content-Type": "application/json", Cookie: sessionCookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({ action: "add", wa_id: "nomor bidan" }),
    });
    const data = JSON.parse(res.body || "{}");
    assert.strictEqual(res.status, 400);
    assert.ok(/Format nomor tidak sah/.test(data.error || ""), data.error);
  });

  await test("cabut menerima alamat perangkat apa adanya", async () => {
    const res = await request("POST", "/admin/api/allowlist/actions", {
      headers: { "Content-Type": "application/json", Cookie: sessionCookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({ action: "remove", wa_id: "204930287689898@lid" }),
    });
    assert.strictEqual(res.status, 200);
  });

  await test("kesehatan bot terbaca dengan sesi", async () => {
    const res = await request("GET", "/admin/api/health", { headers: { Cookie: sessionCookie } });
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body || "{}");
    assert.ok(data.guard, "ringkasan guard harus ikut");
  });

  await test("logout mematikan sesi", async () => {
    const res = await request("POST", "/admin/logout", {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sessionCookie,
        "X-CSRF-Token": csrf,
      },
      body: "_csrf=" + encodeURIComponent(csrf || ""),
    });
    assert.strictEqual(res.status, 302);
    const after = await request("GET", "/admin", { headers: { Cookie: sessionCookie } });
    assert.strictEqual(after.status, 302);
  });

  await new Promise((resolve) => (server && typeof server.close === "function" ? server.close(resolve) : resolve()));
  db.close();
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log("semua uji panel admin lulus");
}

run().catch((err) => {
  console.error("Uji panel admin gagal:", err);
  process.exit(1);
});
