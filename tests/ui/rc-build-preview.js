#!/usr/bin/env node
"use strict";
// Bangun pratinjau dashboard admin untuk uji klik: HTML asli dari index.js, dengan
// jaringan diganti mock supaya bisa dijalankan tanpa sesi admin dan tanpa server.
const fs = require("fs");
const mod = require(require("path").resolve(__dirname, "..", "..", "index.js"));

const html = mod.renderAdminDashboardPage({ nonce: "preview", csrf: "preview-csrf" });

const mock = `<script>
  (function () {
    const state = {
      panel: [{ wa_id: '628111222333@c.us', note: 'bidan desa', source: 'panel', created_at: '2026-10-02T11:20:00+07:00' }],
      env: ['6282240269818@c.us', '6285794961470@c.us'],
      failList: new URLSearchParams(location.search).has('fail'),
    };
    window.__mockState = state;
    function json(body, status) {
      return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
    }
    window.fetch = function (url, options) {
      const path = String(url).split('?')[0];
      const method = (options && options.method) || 'GET';
      if (path === '/admin/api/health') {
        return json({ client: { ready: true, lastReadyAt: '2026-10-02T04:10:53.000Z' }, guard: { paused: false, withinSendWindow: true, lastDay: 3, dailyCap: 900, sent: 12, failures: 0, config: { windowStartHour: 6, windowEndHour: 21, windowEndMinute: 30 } }, runtime: { enforce_allowlist: true, dry_run: false, maintenance_mode: false } });
      }
      if (path === '/admin/api/summary') {
        return json({ needsAction: [], users: { total: 2, runnable: 2 } });
      }
      if (path === '/admin/api/users') {
        return json({ users: [{ wa_id: '6285794961470@c.us', name: 'Aulia Rachmawati', status: 'active', reminder_time: '19:00', total_logs: 0, total_answered: 0 }] });
      }
      if (path === '/admin/api/logs') {
        return json({ logs: [] });
      }
      if (path === '/admin/api/allowlist' && method === 'GET') {
        if (state.failList) return json({ ok: false, error: 'failed' }, 500);
        return json({ ok: true, panel: state.panel, env: state.env });
      }
      if (path === '/admin/api/allowlist/actions' && method === 'POST') {
        const payload = JSON.parse(options.body || '{}');
        const digits = String(payload.wa_id || '').replace(/\\D/g, '');
        const withCountry = digits.startsWith('0') ? '62' + digits.slice(1) : digits;
        if (!/^\\d{8,15}$/.test(withCountry)) {
          return json({ ok: false, error: 'Format nomor tidak sah. Contoh: 6281234567890 atau 08123456789.' }, 400);
        }
        const waId = withCountry + '@c.us';
        if (payload.action === 'add') {
          const already = state.panel.some(function (e) { return e.wa_id === waId; }) || state.env.indexOf(waId) >= 0;
          if (!already) state.panel.push({ wa_id: waId, note: payload.note || '', source: 'panel', created_at: new Date().toISOString() });
          return json({ ok: true, action: 'add', wa_id: waId, already: already, from_env: state.env.indexOf(waId) >= 0, panel: state.panel, env: state.env });
        }
        state.panel = state.panel.filter(function (e) { return e.wa_id !== waId; });
        return json({ ok: true, action: 'remove', wa_id: waId, existed: true, revoked: false, from_env: state.env.indexOf(waId) >= 0, panel: state.panel, env: state.env });
      }
      return json({ ok: false, error: 'tidak dikenal' }, 404);
    };
  })();
</script>
`;

const marker = '    <script nonce="preview">';
if (!html.includes(marker)) {
  throw new Error("penanda script tidak ditemukan");
}
const out = html.replace(marker, mock + marker);
fs.writeFileSync("/tmp/rc-dashboard-preview.html", out);
console.log("pratinjau ditulis:", out.length, "byte");
