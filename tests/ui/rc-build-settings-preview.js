#!/usr/bin/env node
"use strict";
// Pratinjau halaman pengaturan untuk uji klik: HTML asli + jaringan dimock.
const fs = require("fs");
const settingsPage = require(require("path").resolve(__dirname, "..", "..", "lib", "admin-settings-page.js"));
const renderAdminSettingsPage = settingsPage.renderAdminSettingsPage || settingsPage;

const MOCK = `<script>
  (function () {
    const params = new URLSearchParams(location.search);
    const state = { calls: [] };
    window.__mockState = state;
    function json(body, status) {
      return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
    }
    window.fetch = function (url, options) {
      const path = String(url).split('?')[0];
      const method = (options && options.method) || 'GET';
      state.calls.push(method + ' ' + path);
      if (path === '/admin/api/health' && params.has('fail')) {
        return json({ ok: false, error: 'failed' }, 500);
      }
      if (path === '/admin/api/health') {
        return json({ client: { ready: true, lastReadyAt: '2026-10-02T05:33:58.000Z' }, guard: { paused: false, withinSendWindow: true, lastDay: 3, dailyCap: 900, sent: 4, failures: 0, config: { windowStartHour: 6, windowEndHour: 21, windowEndMinute: 30 } }, runtime: { enforce_allowlist: true, dry_run: false, maintenance_mode: false } });
      }
      if (path === '/admin/api/settings') {
        return json({ ok: true, settings: { send_max_per_day: 500, onboarding_daily_limit: 20, reminder_skip_weekday: 7, enforce_allowlist: 1, dry_run: 0, maintenance_mode: 0 } });
      }
      if (path === '/admin/api/emergency') {
        return new Promise((resolve) => setTimeout(() => resolve(json({ ok: true, runtime: { dry_run: false, maintenance_mode: false, enforce_allowlist: true } })), 1200));
      }
      return json({ ok: false, error: 'tidak dikenal' }, 404);
    };
  })();
</script>
`;

const marker = '    <script nonce="preview">';
const html = renderAdminSettingsPage({ nonce: "preview", csrf: "preview-csrf" });
if (!html.includes(marker)) {
  throw new Error("penanda script tidak ditemukan di halaman pengaturan");
}
fs.writeFileSync("/tmp/rc-preview-settings.html", html.replace(marker, MOCK + marker));
console.log("pratinjau: /tmp/rc-preview-settings.html");
