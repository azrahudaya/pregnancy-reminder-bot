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

const FIELD_GROUPS = [
  {
    title: "Pengiriman",
    note: "Angka-angka ini yang menahan pola kirim menyerupai broadcast.",
    fields: [
      ["send_min_gap_ms", "Jeda minimum antar pesan (ms)", "number"],
      ["send_jitter_ms", "Tambahan jeda acak (ms)", "number"],
      ["send_max_per_minute", "Kuota per menit", "number"],
      ["send_max_per_hour", "Kuota per jam", "number"],
      ["send_max_per_day", "Kuota per hari", "number"],
    ],
  },
  {
    title: "Jam kirim",
    note: "Pengingat terjadwal hanya keluar di dalam jendela ini. Balasan percakapan tidak dibatasi.",
    fields: [
      ["send_window_start_hour", "Jam mulai kirim (0 sampai 23)", "number"],
      ["send_window_end_hour", "Jam akhir kirim (0 sampai 23)", "number"],
      ["send_window_end_minute", "Menit akhir kirim (0 sampai 59)", "number"],
      ["reminder_skip_weekday", "Hari tanpa pengingat, 1 sampai 7 (1 = Senin), isi -1 untuk tidak ada jeda", "number"],
    ],
  },
  {
    title: "Pengingat",
    note: "Batas ini mencegah pengiriman berulang ke nomor yang bermasalah.",
    fields: [
      ["reminder_stale_after_minutes", "Batas hangus pengingat (menit, 0 = langsung hangus)", "number"],
      ["max_send_attempts", "Maksimum percobaan kirim per user per hari", "number"],
      ["max_messages_per_user_per_day", "Maksimum pesan per user per hari", "number"],
      ["poll_days_limit", "Poll hanya sampai hari ke berapa", "number"],
      ["onboarding_daily_limit", "Maksimum user baru per hari saat sesi masih muda", "number"],
      ["reminder_log_retention_days", "Simpan catatan pengingat berapa hari", "number"],
    ],
  },
];

function renderField(key, label, type) {
  const id = `setting-${key}`;
  return `
        <div class="field">
          <label for="${id}">${label}</label>
          <input id="${id}" name="${key}" type="${type}" inputmode="numeric" autocomplete="off">
          <p class="hint" id="${id}-hint"></p>
        </div>`;
}

function renderGroup(group) {
  return `
      <section class="panel" aria-labelledby="grup-${group.title.replace(/\s+/g, "-").toLowerCase()}">
        <h2 id="grup-${group.title.replace(/\s+/g, "-").toLowerCase()}">${group.title}</h2>
        <p class="hint">${group.note}</p>
        ${group.fields.map(([key, label, type]) => renderField(key, label, type)).join("")}
      </section>`;
}

function renderAdminSettingsPage() {
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Pengaturan RemindCare</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg: #f7f7f7;
        --panel: #ffffff;
        --text: #0f0f0f;
        --muted: #5c5c5c;
        --border: #cfcfcf;
        --border-strong: #8a8a8a;
        --shadow: 0 8px 26px rgba(0,0,0,0.06);
        --warn: #8a4b00;
        --warn-bg: #fff4e5;
        --ok: #0b6b3a;
        --ok-bg: #eaf7ef;
        --bad: #8c1d1d;
        --bad-bg: #fdecec;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Lato", sans-serif;
        background: linear-gradient(180deg, #ffffff 0%, #f4f4f4 100%);
        color: var(--text);
      }
      .container { width: min(1080px, 100%); margin: 0 auto; }
      header {
        padding: 28px 28px 18px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      h1 { margin: 0; font-size: 24px; }
      h2 { margin: 0 0 6px; font-size: 16px; }
      .subtitle { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      button, .ghost {
        min-height: 44px;
        padding: 10px 18px;
        border-radius: 999px;
        border: 1px solid var(--border-strong);
        background: #111;
        color: #fff;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
        font-size: 13px;
        font-family: inherit;
      }
      .ghost { background: #fff; color: #111; }
      .ghost:hover, button:hover { border-color: #111; }
      button:focus-visible, .ghost:focus-visible, input:focus-visible {
        outline: 2px solid #111;
        outline-offset: 2px;
      }
      main { padding: 0 28px 40px; display: grid; gap: 20px; }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 18px;
        box-shadow: var(--shadow);
      }
      .grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .field { display: grid; gap: 6px; }
      label { font-size: 13px; font-weight: 700; }
      input[type="number"], input[type="text"] {
        min-height: 44px;
        padding: 8px 10px;
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        font-size: 14px;
        font-family: inherit;
        background: #fff;
        color: var(--text);
      }
      .hint { margin: 0; color: var(--muted); font-size: 12px; }
      .status-line {
        margin: 0;
        padding: 10px 12px;
        border-radius: 10px;
        font-size: 13px;
        border: 1px solid var(--border);
        background: #fafafa;
      }
      .status-line[data-tone="ok"] { background: var(--ok-bg); border-color: var(--ok); color: var(--ok); }
      .status-line[data-tone="warn"] { background: var(--warn-bg); border-color: var(--warn); color: var(--warn); }
      .status-line[data-tone="bad"] { background: var(--bad-bg); border-color: var(--bad); color: var(--bad); }
      .health-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        margin: 0;
      }
      .health-grid div { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
      .health-grid dt { font-size: 12px; color: var(--muted); }
      .health-grid dd { margin: 4px 0 0; font-size: 15px; font-weight: 700; }
      .checkbox-row { display: flex; align-items: center; gap: 10px; min-height: 44px; }
      .checkbox-row input { width: 24px; height: 24px; }
      .checkbox-row label { font-weight: 400; font-size: 14px; }
      .footer-note { color: var(--muted); font-size: 12px; margin: 0; }
      @media (max-width: 560px) {
        header { padding: 20px 16px 12px; }
        main { padding: 0 16px 32px; }
      }
      @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <div>
          <h1>Pengaturan</h1>
          <p class="subtitle">Perubahan berlaku langsung tanpa restart. Nilai di luar rentang ditolak.</p>
        </div>
        <div class="actions">
          <a class="ghost" href="/admin">Kembali ke daftar user</a>
          <form method="post" action="/admin/logout"><button type="submit">Keluar</button></form>
        </div>
      </header>
      <main>
        <section class="panel" aria-labelledby="judul-darurat">
          <h2 id="judul-darurat">Kendali darurat</h2>
          <p class="hint">Dipakai saat WhatsApp memberi peringatan, atau saat alur perlu diuji tanpa mengirim ke user.</p>
          <div class="actions">
            <button type="button" id="aksi-pause">Jeda semua pengiriman 24 jam</button>
            <button type="button" id="aksi-resume" class="ghost">Lanjutkan pengiriman</button>
            <button type="button" id="aksi-dry-on" class="ghost">Aktifkan mode simulasi</button>
            <button type="button" id="aksi-dry-off" class="ghost">Matikan mode simulasi</button>
            <button type="button" id="aksi-maint-on" class="ghost">Masuk mode perawatan</button>
            <button type="button" id="aksi-maint-off" class="ghost">Keluar mode perawatan</button>
          </div>
          <p class="status-line" id="status-darurat" data-tone="info" role="status" aria-live="polite">
            Mode sekarang: memuat status.
          </p>
        </section>

        <section class="panel" aria-labelledby="judul-kesehatan">
          <h2 id="judul-kesehatan">Status bot</h2>
          <p class="hint" id="kesehatan-diperbarui">Diperbarui setiap 15 detik.</p>
          <dl class="health-grid" id="kesehatan">
            <div><dt>Status</dt><dd id="h-status">Memuat</dd></div>
          </dl>
          <p class="status-line" id="status-kesehatan" data-tone="info" role="status" aria-live="polite"></p>
        </section>

        <form id="form-pengaturan" novalidate>
          ${FIELD_GROUPS.map(renderGroup).join("")}

          <section class="panel" aria-labelledby="judul-akses">
            <h2 id="judul-akses">Akses dan mode</h2>
            <div class="checkbox-row">
              <input type="checkbox" id="setting-enforce_allowlist" name="enforce_allowlist">
              <label for="setting-enforce_allowlist">Hanya layani nomor yang ada di allowlist</label>
            </div>
            <div class="checkbox-row">
              <input type="checkbox" id="setting-dry_run" name="dry_run">
              <label for="setting-dry_run">Mode simulasi: catat pengiriman, jangan kirim</label>
            </div>
            <div class="checkbox-row">
              <input type="checkbox" id="setting-maintenance_mode" name="maintenance_mode">
              <label for="setting-maintenance_mode">Mode perawatan: hentikan semua pengingat terjadwal</label>
            </div>
            <div class="field">
              <label for="setting-emergency_pause_until">Jeda darurat aktif sampai</label>
              <input type="text" id="setting-emergency_pause_until" name="emergency_pause_until" autocomplete="off" placeholder="kosong berarti tidak sedang dijeda">
            </div>
          </section>

          <section class="panel">
            <div class="actions">
              <button type="submit">Simpan pengaturan</button>
              <button type="button" class="ghost" id="aksi-muat-ulang">Muat ulang nilai</button>
            </div>
            <p class="status-line" id="status-simpan" data-tone="info" role="status" aria-live="polite">
              Belum ada perubahan.
            </p>
            <p class="footer-note">Nilai awal datang dari .env. Nilai yang tersimpan di sini menimpanya.</p>
          </section>
        </form>
      </main>
    </div>

    <script>
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
          const res = await fetch("/admin/api/settings", { credentials: "same-origin" });
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
            headers: { "Content-Type": "application/json" },
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
          const res = await fetch("/admin/api/health", { credentials: "same-origin" });
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

      async function emergency(action, label) {
        if (!window.confirm(label + "?")) return;
        setTone("status-darurat", "info", "Menjalankan: " + label + "...");
        try {
          const res = await fetch("/admin/api/emergency", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: action, hours: 24 }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "HTTP " + res.status);
          setTone("status-darurat", "ok", "Selesai: " + label + ".");
          loadHealth();
          loadSettings();
        } catch (err) {
          setTone("status-darurat", "bad", "Gagal: " + err.message);
        }
      }

      document.getElementById("form-pengaturan").addEventListener("submit", saveSettings);
      document.getElementById("aksi-muat-ulang").addEventListener("click", loadSettings);
      document.getElementById("aksi-pause").addEventListener("click", () =>
        emergency("pause", "Jeda semua pengiriman 24 jam"),
      );
      document.getElementById("aksi-resume").addEventListener("click", () =>
        emergency("resume", "Lanjutkan pengiriman sekarang"),
      );
      document.getElementById("aksi-dry-on").addEventListener("click", () =>
        emergency("dry_run_on", "Aktifkan mode simulasi"),
      );
      document.getElementById("aksi-dry-off").addEventListener("click", () =>
        emergency("dry_run_off", "Matikan mode simulasi"),
      );
      document.getElementById("aksi-maint-on").addEventListener("click", () =>
        emergency("maintenance_on", "Masuk mode perawatan"),
      );
      document.getElementById("aksi-maint-off").addEventListener("click", () =>
        emergency("maintenance_off", "Keluar mode perawatan"),
      );

      loadSettings();
      loadHealth();
      setInterval(loadHealth, 15000);
    </script>
  </body>
</html>`;
}

module.exports = { renderAdminSettingsPage, FIELD_GROUPS };