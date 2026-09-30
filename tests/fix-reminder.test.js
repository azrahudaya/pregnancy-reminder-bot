"use strict";

const assert = require("assert");
const { execFileSync } = require("child_process");
const path = require("path");
const sqlite3 = require("sqlite3");

const mod = require("../index.js");

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

function memoryDb() {
  const db = new sqlite3.Database(":memory:");
  return db;
}

async function run() {
  await test("isRealSentMessage hanya menerima hasil dengan id asli", () => {
    assert.strictEqual(mod.isRealSentMessage({ id: { _serialized: "true_123@c.us" } }), true);
    assert.strictEqual(mod.isRealSentMessage({ id: { _serialized: "lid-poll-1700000000000" } }), false);
    assert.strictEqual(mod.isRealSentMessage(null), false);
    assert.strictEqual(mod.isRealSentMessage({}), false);
  });

  await test("chatIdCandidates menyusun target unik dan memakai alamat ingatan", () => {
    const first = mod.chatIdCandidates("204930287689898@lid", ["6282240269818@c.us", "6282240269818@c.us"]);
    assert.deepStrictEqual(first, ["204930287689898@lid", "6282240269818@c.us"]);
    mod.rememberAlternates("111@lid", ["111@c.us"]);
    const second = mod.chatIdCandidates("111@lid", []);
    assert.deepStrictEqual(second, ["111@lid", "111@c.us"]);
  });

  await test("deliverMessage memakai alamat cadangan saat alamat asal gagal", async () => {
    const calls = [];
    const resolved = {
      async sendMessage(target) {
        calls.push(target);
        if (target.endsWith("@lid")) {
          return null;
        }
        return { id: { _serialized: "true_9@c.us" } };
      },
    };
    const result = await mod.deliverMessage(
      resolved,
      "204930287689898@lid",
      "halo",
      ["6282240269818@c.us"],
    );
    assert.ok(result && result.id && result.id._serialized);
    assert.deepStrictEqual(calls, ["204930287689898@lid", "6282240269818@c.us"]);
  });

  await test("deliverMessage tetap null kalau semua target gagal", async () => {
    const resolved = { async sendMessage() { return null; } };
    const result = await mod.deliverMessage(resolved, "204930287689898@lid", "halo", ["6282240269818@c.us"]);
    assert.strictEqual(result, null);
  });

  await test("deliverMessage melewati target yang melempar error", async () => {
    const calls = [];
    const resolved = {
      async sendMessage(target) {
        calls.push(target);
        if (target.endsWith("@lid")) {
          throw new Error("bad wid");
        }
        return { id: { _serialized: "true_10@c.us" } };
      },
    };
    const result = await mod.deliverMessage(resolved, "9@lid", "halo", ["62@c.us"]);
    assert.ok(result);
    assert.deepStrictEqual(calls, ["9@lid", "62@c.us"]);
  });

  await test("envNumber membaca env dan menolak nilai tidak sah", () => {
    assert.strictEqual(mod.envNumber("TIDAK_ADA_ENV_INI", 42), 42);
    process.env.RC_TEST_ENVNUMBER = "500";
    assert.strictEqual(mod.envNumber("RC_TEST_ENVNUMBER", 900), 500);
    process.env.RC_TEST_ENVNUMBER = "abc";
    assert.strictEqual(mod.envNumber("RC_TEST_ENVNUMBER", 900), 900);
    delete process.env.RC_TEST_ENVNUMBER;
  });

  await test("fallback runtime setting mengikuti env yang sama dengan guard", () => {
    const script = "const m=require('./index.js'); console.log(m.settingsSnapshot().send_max_per_day);";
    const out = execFileSync(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, SEND_MAX_PER_DAY: "500", SEND_MIN_GAP_MS: "6000" },
      encoding: "utf8",
    });
    assert.strictEqual(out.trim(), "500");
  });

  await test("canAttemptFlow menahan percobaan cepat dan mengizinkan setelah jeda", () => {
    const now = Date.now();
    assert.strictEqual(mod.canAttemptFlow("62@c.us", "unit-flow", now), true);
    mod.markFlowAttempt("62@c.us", "unit-flow", now);
    assert.strictEqual(mod.canAttemptFlow("62@c.us", "unit-flow", now + 1000), false);
    assert.strictEqual(mod.canAttemptFlow("62@c.us", "unit-flow", now + 16 * 60 * 1000), true);
  });

  await test("tabel alias menyimpan dan mengembalikan pemetaan identitas", async () => {
    const db = memoryDb();
    try {
      await mod.ensureAliasTable(db);
      await mod.recordAlias(db, "204930287689898@lid", "6282240269818@c.us");
      assert.strictEqual(
        await mod.getCanonicalWaId(db, "204930287689898@lid"),
        "6282240269818@c.us",
      );
      assert.strictEqual(await mod.getCanonicalWaId(db, "6282240269818@c.us"), "6282240269818@c.us");
      const alternates = await mod.getAlternateChatIds(db, "204930287689898@lid");
      assert.deepStrictEqual(alternates, ["6282240269818@c.us"]);
      const reverse = await mod.getAlternateChatIds(db, "6282240269818@c.us");
      assert.deepStrictEqual(reverse, ["204930287689898@lid"]);
      await mod.recordAlias(db, "204930287689898@lid", "6282240269818@c.us");
      const rows = await new Promise((resolve, reject) =>
        db.all("SELECT COUNT(*) AS c FROM user_aliases", (err, r) => (err ? reject(err) : resolve(r))),
      );
      assert.strictEqual(rows[0].c, 1);
    } finally {
      db.close();
    }
  });

  await test("buildNeedsAction menandai user yang tidak akan menerima pengingat", () => {
    const items = mod.buildNeedsAction([
      { wa_id: "a@c.us", name: "punya jam tapi belum jalan", status: "onboarding", reminder_time: "10:30", allow_remindcare: 1, is_blocked: 0 },
      { wa_id: "b@c.us", name: "aktif tanpa jam", status: "active", reminder_time: null, allow_remindcare: 1, is_blocked: 0 },
      { wa_id: "c@c.us", name: "gagal kirim", status: "active", reminder_time: "07:00", allow_remindcare: 1, is_blocked: 0, fe_poll_fail_count: 3 },
      { wa_id: "d@c.us", name: "diblokir", status: "active", reminder_time: "07:00", allow_remindcare: 1, is_blocked: 1 },
      { wa_id: "e@c.us", name: "sehat", status: "active", reminder_time: "07:00", allow_remindcare: 1, is_blocked: 0, fe_poll_fail_count: 0 },
      { wa_id: "f@c.us", name: "selesai", status: "completed", reminder_time: "07:00", allow_remindcare: 0, is_blocked: 0 },
    ]);
    const byId = Object.fromEntries(items.map((x) => [x.wa_id, x]));
    assert.strictEqual(byId["a@c.us"].reason, "not_running");
    assert.strictEqual(byId["b@c.us"].reason, "no_time");
    assert.strictEqual(byId["c@c.us"].reason, "send_failure");
    assert.strictEqual(byId["d@c.us"].reason, "blocked");
    assert.strictEqual(byId["e@c.us"], undefined);
    assert.strictEqual(byId["f@c.us"], undefined);
  });

  await test("reconcileRunnableUsers mengaktifkan user yang jamnya sudah terisi", async () => {
    const db = memoryDb();
    try {
      await mod.ensureSettingsTable(db);
      await new Promise((resolve, reject) => db.run(
        "CREATE TABLE IF NOT EXISTS users (wa_id TEXT PRIMARY KEY, status TEXT, reminder_time TEXT, allow_remindcare INTEGER, is_blocked INTEGER)",
        (err) => (err ? reject(err) : resolve()),
      ));
      const insert = (wa, status, time, allow, blocked) => new Promise((resolve, reject) => db.run(
        "INSERT INTO users (wa_id, status, reminder_time, allow_remindcare, is_blocked) VALUES (?,?,?,?,?)",
        [wa, status, time, allow, blocked], (err) => (err ? reject(err) : resolve()),
      ));
      await insert("jam-terisi@c.us", "onboarding", "10:30", 1, 0);
      await insert("tanpa-jam@c.us", "onboarding", null, 1, 0);
      await insert("diblokir@c.us", "onboarding", "09:00", 1, 1);
      await insert("menolak@c.us", "onboarding", "09:00", 0, 0);
      const changed = await mod.reconcileRunnableUsers(db);
      assert.strictEqual(changed, 1, "hanya satu user yang boleh diaktifkan");
      const rows = await new Promise((resolve, reject) => db.all(
        "SELECT wa_id, status FROM users ORDER BY wa_id",
        (err, r) => (err ? reject(err) : resolve(r)),
      ));
      const map = Object.fromEntries(rows.map((r) => [r.wa_id, r.status]));
      assert.strictEqual(map["jam-terisi@c.us"], "active");
      assert.strictEqual(map["tanpa-jam@c.us"], "onboarding");
      assert.strictEqual(map["diblokir@c.us"], "onboarding");
      assert.strictEqual(map["menolak@c.us"], "onboarding");
    } finally {
      db.close();
    }
  });

  await test("halaman admin memuat perbaikan layout, fokus, dan CSRF", () => {
    const settings = require("../lib/admin-settings-page.js");
    const ctx = { nonce: "n0nce", csrf: "csrf-token" };
    const dashboard = mod.renderAdminDashboardPage(ctx);
    const detail = mod.renderAdminUserDetailPage("6282240269818@c.us", ctx);
    const settingsPage = settings.renderAdminSettingsPage(ctx);

    for (const [name, html] of [
      ["dashboard", dashboard],
      ["detail", detail],
      ["settings", settingsPage],
    ]) {
      assert.ok(/--focus:\s*#4f46e5/.test(html), `${name} memakai token fokus kontras`);
      assert.ok(/outline:\s*3px solid var\(--focus\)/.test(html), `${name} memakai focus ring solid`);
      assert.ok(html.includes('meta name="csrf-token"'), `${name} memuat meta CSRF`);
      assert.ok(html.includes("Plus Jakarta Sans"), `${name} memakai font yang dipilih`);
      assert.ok(!html.includes("fonts.googleapis.com/css2?family=Lato"), `${name} tidak memuat font yang tidak dipakai`);
    }
    for (const [name, html] of [
      ["dashboard", dashboard],
      ["settings", settingsPage],
    ]) {
      assert.ok(html.includes('grid-template-columns: minmax(0, 1fr)'), `${name} memakai kolom grid yang bisa menyusut`);
      assert.ok(html.includes('value="csrf-token"'), `${name} form logout membawa CSRF`);
    }
    // kokpit operasional: status bot dulu, lalu tindakan, lalu angka hari ini
    assert.ok(dashboard.includes('id="status-panel"'), "dashboard punya blok status bot");
    assert.ok(dashboard.includes('id="action-list"'), "dashboard punya daftar perlu tindakan");
    assert.ok(dashboard.includes('id="today-waiting"'), "dashboard punya angka pengingat hari ini");
    assert.ok(dashboard.includes("a.row-link"), "dashboard memakai tautan baris yang bisa difokus");
    assert.ok(!dashboard.includes("row-clickable"), "dashboard tidak memakai baris yang hanya bisa diklik mouse");
    assert.ok(dashboard.includes('aria-describedby') === false, "dashboard tidak butuh deskripsi tambahan pada input cari");
    assert.ok(settingsPage.includes('aria-describedby="setting-'), "halaman pengaturan menghubungkan hint ke input");
    assert.ok(detail.includes(".table-wrap,.table-wrap table{max-width:100%}"), "detail membatasi lebar tabel");
  });

  console.log("semua tes perbaikan reminder lulus");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
