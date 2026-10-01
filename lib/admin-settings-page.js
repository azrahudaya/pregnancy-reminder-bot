"use strict";

// Halaman pengaturan admin web.
//
// Kenapa halaman ini ada: tanpa halaman ini, setiap perubahan perilaku bot harus lewat
// sunting .env lalu restart service, dan itu lambat serta rawan salah saat kondisi darurat
// (misalnya saat WhatsApp mulai membatasi nomor).
//
// Aturan yang dipegang halaman ini:
// - setiap kolom punya label yang benar-benar terhubung ke inputnya
// - status simpan diumumkan lewat aria-live, bukan hanya warna
// - ada tiga keadaan: memuat, berhasil, dan gagal
// - semua tombol bisa dicapai keyboard dan tingginya minimal 44px
// - tidak memakai em dash, dan tidak menampilkan angka karangan

const { ADMIN_CSS, icon } = require("./admin-ui");

const FIELD_GROUPS = [
  {
    slug: "pengiriman",
    title: "Pengiriman",
    note: "Angka ini yang menahan pola kirim menyerupai broadcast.",
    fields: [
      ["send_min_gap_ms", "Jeda minimum antar pesan (ms)"],
      ["send_jitter_ms", "Tambahan jeda acak (ms)"],
      ["send_max_per_minute", "Kuota per menit"],
      ["send_max_per_hour", "Kuota per jam"],
      ["send_max_per_day", "Kuota per hari"],
    ],
  },
  {
    slug: "jam-kirim",
    title: "Jam kirim",
    note: "Pengingat terjadwal hanya keluar di jendela ini. Balasan percakapan tidak dibatasi.",
    fields: [
      ["send_window_start_hour", "Jam mulai (0 sampai 23)"],
      ["send_window_end_hour", "Jam akhir (0 sampai 23)"],
      ["send_window_end_minute", "Menit akhir (0 sampai 59)"],
      ["reminder_skip_weekday", "Hari tanpa pengingat (1 = Senin, -1 = tidak ada)"],
    ],
  },
  {
    slug: "pengingat",
    title: "Pengingat",
    note: "Batas ini mencegah pengiriman berulang ke nomor bermasalah.",
    fields: [
      ["reminder_stale_after_minutes", "Batas hangus pengingat (menit)"],
      ["max_send_attempts", "Maksimum percobaan kirim per user per hari"],
      ["max_messages_per_user_per_day", "Maksimum pesan per user per hari"],
      ["poll_days_limit", "Poll sampai hari ke berapa"],
      ["onboarding_daily_limit", "Maksimum user baru per hari"],
      ["reminder_log_retention_days", "Simpan catatan pengingat (hari)"],
    ],
  },
];

function renderField(key, label) {
  const id = `setting-${key}`;
  return `
            <div class="field">
              <label for="${id}">${label}</label>
              <input id="${id}" name="${key}" type="number" inputmode="numeric" autocomplete="off" aria-describedby="${id}-hint">
              <p class="hint" id="${id}-hint"></p>
            </div>`;
}

function renderGroup(group) {
  return `
        <section class="panel" aria-labelledby="grup-${group.slug}">
          <div class="panel-head"><h2 id="grup-${group.slug}">${icon("sliders")}${group.title}</h2></div>
          <div class="panel-body">
            <p class="hint">${group.note}</p>
            <div class="grid-fields">${group.fields.map(([key, label]) => renderField(key, label)).join("")}</div>
          </div>
        </section>`;
}

function renderAdminSettingsPage(options = {}) {
  const nonce = options && options.nonce ? String(options.nonce) : "";
  const csrf = options && options.csrf ? String(options.csrf) : "";
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="${csrf}">
    <title>Pengaturan - RemindCare Admin</title>
    <style nonce="${nonce}">${ADMIN_CSS}
      .hint { margin: 0; color: var(--muted); font-size: 11.5px; }
      .panel-body .grid-fields { margin-top: 10px; }
      .hint:empty { display: none; }
      .field .hint { margin-top: 3px; }
      .status-line { margin: 0; color: var(--muted); font-size: 12px; }
      .status-line[data-tone="bad"] { color: var(--bad); }
      .status-line[data-tone="ok"] { color: var(--ok); }
      .status-line[data-tone="warn"] { color: var(--warn); }
      .kv.health { border-top: none; }
      .kv.health > div { border-top: none; }
      .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .btn-row > button { flex: 0 1 auto; }
      .trace { color: var(--muted); font-size: 11.5px; margin: 8px 0 0; }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">
        ${icon("sliders")}
        <h1>Pengaturan</h1>
        <span class="tag">berlaku langsung, tanpa restart</span>
      </div>
      <div class="row">
        <a class="btn" href="/admin">${icon("chevron")}Daftar user</a>
        <form method="post" action="/admin/logout">
          <input type="hidden" name="_csrf" value="${csrf}">
          <button type="submit" class="btn-icon" aria-label="Keluar dari panel admin" title="Keluar">${icon("logout")}</button>
        </form>
      </div>
    </header>

    <div class="wrap">
      <section class="panel" aria-labelledby="judul-darurat">
        <div class="panel-head">
          <h2 id="judul-darurat">${icon("alert")}Kendali darurat</h2>
          <span class="status-line" id="status-darurat" data-tone="info" role="status" aria-live="polite">Memuat status.</span>
        </div>
        <div class="panel-body">
          <div class="btn-row">
            <button type="button" id="aksi-pause">${icon("alert")}Jeda 24 jam</button>
            <button type="button" id="aksi-resume">${icon("check")}Lanjutkan</button>
            <button type="button" id="aksi-dry-on">${icon("toggle")}Simulasi aktif</button>
            <button type="button" id="aksi-dry-off">${icon("toggle")}Simulasi mati</button>
            <button type="button" id="aksi-maint-on">${icon("shield")}Masuk perawatan</button>
            <button type="button" id="aksi-maint-off">${icon("check")}Keluar perawatan</button>
          </div>
        </div>
      </section>

      <section class="panel" aria-labelledby="judul-kesehatan">
        <div class="panel-head">
          <h2 id="judul-kesehatan">${icon("plug")}Status bot</h2>
          <span class="muted" id="kesehatan-diperbarui">-</span>
        </div>
        <dl class="kv health" id="kesehatan">
          <div><dt>Status</dt><dd id="h-status">memuat</dd></div>
        </dl>
        <p class="status-line" id="status-kesehatan" data-tone="info" role="status" aria-live="polite" style="padding:10px 12px 0"></p>
      </section>

      <form id="form-pengaturan" novalidate>
        ${FIELD_GROUPS.map(renderGroup).join("")}

        <section class="panel" aria-labelledby="judul-akses">
          <div class="panel-head"><h2 id="judul-akses">${icon("shield")}Akses dan mode</h2></div>
          <div class="panel-body">
            <div class="check"><input type="checkbox" id="setting-enforce_allowlist" name="enforce_allowlist"><label for="setting-enforce_allowlist">Hanya layani nomor yang ada di allowlist</label></div>
            <div class="check"><input type="checkbox" id="setting-dry_run" name="dry_run"><label for="setting-dry_run">Mode simulasi: catat, jangan kirim</label></div>
            <div class="check"><input type="checkbox" id="setting-maintenance_mode" name="maintenance_mode"><label for="setting-maintenance_mode">Mode perawatan: hentikan pengingat terjadwal</label></div>
            <div class="field" style="margin-top:10px">
              <label for="setting-emergency_pause_until">Jeda darurat sampai</label>
              <input type="text" id="setting-emergency_pause_until" name="emergency_pause_until" autocomplete="off" placeholder="kosong berarti tidak dijeda" aria-describedby="setting-emergency_pause_until-hint">
              <p class="hint" id="setting-emergency_pause_until-hint"></p>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-body">
            <div class="btn-row" style="margin-top:0">
              <button type="submit" class="btn-primary">${icon("check")}Simpan</button>
              <button type="button" id="aksi-muat-ulang" class="btn">${icon("rotate")}Muat ulang nilai</button>
            </div>
            <p class="status-line" id="status-simpan" data-tone="info" role="status" aria-live="polite" style="margin-top:8px">Belum ada perubahan.</p>
            <p class="trace">Nilai awal dari .env. Nilai yang disimpan di sini menimpanya.</p>
          </div>
        </section>
      </form>
    </div>

    <script nonce="${nonce}">
      const CSRF_TOKEN = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
      function csrfHeaders(extra) {
        return Object.assign({ 'X-CSRF-Token': CSRF_TOKEN }, extra || {});
      }
      const setText = (id, value) => {
        const node = document.getElementById(id);
        if (node) node.textContent = value;
      };
      const setTone = (id, tone, text) => {
        const node = document.getElementById(id);
        if (!node) return;
        node.dataset.tone = tone;
        node.textContent = text;
      };
      const numberFields = ${JSON.stringify(
        FIELD_GROUPS.flatMap((group) => group.fields.map(([key]) => key)),
      )};
      const booleanFields = ["enforce_allowlist", "dry_run", "maintenance_mode"];

      let currentSettings = {};

      function fillForm(settings) {
        currentSettings = settings || {};
        numberFields.forEach((key) => {
          const input = document.getElementById("setting-" + key);
          if (!input) return;
          input.value = settings[key] === null || settings[key] === undefined ? "" : settings[key];
          const min = settings[key + "__min"];
          const max = settings[key + "__max"];
          setText(
            "setting-" + key + "-hint",
            min === null || min === undefined ? "" : "Rentang " + min + " sampai " + max,
          );
        });
        booleanFields.forEach((key) => {
          const input = document.getElementById("setting-" + key);
          if (input) input.checked = Number(settings[key]) === 1;
        });
        const pauseInput = document.getElementById("setting-emergency_pause_until");
        if (pauseInput) pauseInput.value = settings.emergency_pause_until || "";
      }

      async function loadSettings() {
        setTone("status-simpan", "info", "Memuat pengaturan...");
        try {
          const res = await fetch("/admin/api/settings", { credentials: "same-origin", headers: csrfHeaders() });
          if (res.status === 401) {
            setTone("status-simpan", "bad", "Sesi berakhir. Muat ulang halaman lalu masuk lagi.");
            return;
          }
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          fillForm(data.settings);
          setTone("status-simpan", "info", "Nilai terbaru sudah dimuat.");
        } catch (err) {
          setTone("status-simpan", "bad", "Gagal memuat pengaturan: " + err.message);
        }
      }

      function collectChanges() {
        const payload = {};
        numberFields.forEach((key) => {
          const input = document.getElementById("setting-" + key);
          if (!input || input.value === "") return;
          if (String(input.value) !== String(currentSettings[key])) payload[key] = Number(input.value);
        });
        booleanFields.forEach((key) => {
          const input = document.getElementById("setting-" + key);
          if (!input) return;
          const next = input.checked ? 1 : 0;
          if (next !== Number(currentSettings[key])) payload[key] = next;
        });
        return payload;
      }

      async function saveSettings(event) {
        event.preventDefault();
        const payload = collectChanges();
        if (Object.keys(payload).length === 0) {
          setTone("status-simpan", "info", "Tidak ada nilai yang berubah.");
          return;
        }
        setTone("status-simpan", "info", "Menyimpan " + Object.keys(payload).length + " nilai...");
        try {
          const res = await fetch("/admin/api/settings", {
            method: "POST",
            credentials: "same-origin",
            headers: csrfHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(payload),
          });
          if (res.status === 401) {
            setTone("status-simpan", "bad", "Sesi berakhir. Muat ulang halaman lalu masuk lagi.");
            return;
          }
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "HTTP " + res.status);
          fillForm(data.settings);
          const appliedCount = Object.keys(data.applied || {}).length;
          if (data.rejected && data.rejected.length) {
            setTone(
              "status-simpan",
              "warn",
              "Tersimpan " + appliedCount + " nilai, ditolak: " + data.rejected.join("; "),
            );
          } else {
            setTone("status-simpan", "ok", "Tersimpan " + appliedCount + " nilai dan langsung berlaku.");
          }
          loadHealth();
        } catch (err) {
          setTone("status-simpan", "bad", "Gagal menyimpan: " + err.message);
        }
      }

      function renderHealth(data) {
        const guard = data.guard || {};
        const rows = [
          ["Status kirim", guard.paused ? "Dijeda" : guard.dryRun ? "Mode simulasi" : "Normal"],
          ["Client WhatsApp", data.client && data.client.ready ? "Siap" : "Belum siap"],
          ["Siap sejak", data.client && data.client.lastReadyAt ? data.client.lastReadyAt : "belum pernah"],
          ["Terputus terakhir", data.client && data.client.lastDisconnectedAt ? data.client.lastDisconnectedAt : "tidak ada"],
          ["Pesan terkirim (sesi ini)", String(guard.sent || 0)],
          ["Disimulasikan", String(guard.simulated || 0)],
          ["Gagal kirim", String(guard.failures || 0)],
          ["Pemicu jeda otomatis", String(guard.breakerTrips || 0)],
          ["Kirim menit terakhir", (guard.lastMinute || 0) + " dari " + (guard.config ? guard.config.maxPerMinute : "-")],
          ["Kirim jam terakhir", (guard.lastHour || 0) + " dari " + (guard.config ? guard.config.maxPerHour : "-")],
          ["Kirim hari ini", (guard.lastDay || 0) + " dari " + (guard.dailyCap || "-")],
          ["Database", data.database && data.database.ok ? "Sehat" : "Perlu diperiksa: " + (data.database ? data.database.result : "-")],
          ["Jumlah user", String(data.users || 0)],
          ["Waktu server", data.serverTime ? data.serverTime.replace("T", " ").slice(0, 19) : "-"],
        ];
        const container = document.getElementById("kesehatan");
        if (!container) return;
        container.innerHTML = "";
        rows.forEach(([label, value]) => {
          const wrap = document.createElement("div");
          const dt = document.createElement("dt");
          dt.textContent = label;
          const dd = document.createElement("dd");
          dd.textContent = value;
          wrap.appendChild(dt);
          wrap.appendChild(dd);
          container.appendChild(wrap);
        });

        const runtime = data.runtime || {};
        const modeParts = [];
        modeParts.push(runtime.dry_run ? "mode simulasi aktif" : "pengiriman normal");
        modeParts.push(runtime.maintenance_mode ? "mode perawatan aktif" : "mode perawatan mati");
        modeParts.push(runtime.enforce_allowlist ? "allowlist aktif" : "allowlist mati");
        setText("status-darurat", "Mode sekarang: " + modeParts.join(", ") + ".");
      }

      async function loadHealth() {
        try {
          const res = await fetch("/admin/api/health", { credentials: "same-origin", headers: csrfHeaders() });
          if (res.status === 401) {
            setTone("status-kesehatan", "bad", "Sesi berakhir. Muat ulang halaman lalu masuk lagi.");
            return;
          }
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          renderHealth(data);
          setTone("status-kesehatan", "info", "");
          const stamp = new Date();
          setText(
            "kesehatan-diperbarui",
            "Diperbarui " + stamp.toLocaleTimeString("id-ID") + ", otomatis setiap 15 detik.",
          );
        } catch (err) {
          setTone(
            "status-kesehatan",
            "bad",
            "Gagal membaca status bot: " + err.message + ". Pastikan proses bot masih berjalan.",
          );
        }
      }

      const EMERGENCY_IMPACT = {
        pause: "Semua pengiriman terjadwal berhenti selama 24 jam. Balasan percakapan tetap jalan.",
        resume: "Pengiriman terjadwal aktif kembali mulai tick berikutnya.",
        dry_run_on: "Pengiriman dicatat tetapi tidak dikirim ke user.",
        dry_run_off: "Pengiriman kembali benar-benar dikirim ke user.",
        maintenance_on: "Semua pengingat terjadwal berhenti tanpa batas waktu sampai dimatikan.",
        maintenance_off: "Pengingat terjadwal aktif kembali.",
      };

      async function emergency(action, label, button) {
        const impact = EMERGENCY_IMPACT[action] || "";
        if (!window.confirm(label + (impact ? ". " + impact : "") + " Lanjutkan?")) return;
        const buttons = Array.from(document.querySelectorAll(".actions button"));
        buttons.forEach((b) => { b.disabled = true; });
        if (button) button.textContent = "Menjalankan...";
        setTone("status-darurat", "info", "Menjalankan: " + label + "...");
        try {
          const res = await fetch("/admin/api/emergency", {
            method: "POST",
            credentials: "same-origin",
            headers: csrfHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ action: action, hours: 24 }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "HTTP " + res.status);
          setTone("status-darurat", "ok", "Selesai: " + label + ".");
          loadHealth();
          loadSettings();
        } catch (err) {
          setTone("status-darurat", "bad", "Gagal: " + err.message);
        } finally {
          buttons.forEach((b) => { b.disabled = false; });
          if (button) button.textContent = label;
        }
      }

      document.getElementById("form-pengaturan").addEventListener("submit", saveSettings);
      document.getElementById("aksi-muat-ulang").addEventListener("click", loadSettings);
      const EMERGENCY_BUTTONS = [
        ["aksi-pause", "pause", "Jeda semua pengiriman 24 jam"],
        ["aksi-resume", "resume", "Lanjutkan pengiriman sekarang"],
        ["aksi-dry-on", "dry_run_on", "Aktifkan mode simulasi"],
        ["aksi-dry-off", "dry_run_off", "Matikan mode simulasi"],
        ["aksi-maint-on", "maintenance_on", "Masuk mode perawatan"],
        ["aksi-maint-off", "maintenance_off", "Keluar mode perawatan"],
      ];
      for (const [id, action, label] of EMERGENCY_BUTTONS) {
        const node = document.getElementById(id);
        if (node) {
          node.addEventListener("click", () => emergency(action, label, node));
        }
      }

      loadSettings();
      loadHealth();
      setInterval(loadHealth, 15000);
    </script>
  </body>
</html>`;
}

module.exports = { renderAdminSettingsPage, FIELD_GROUPS };