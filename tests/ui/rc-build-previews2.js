#!/usr/bin/env node
"use strict";
// Bangun pratinjau dashboard dan detail user dengan HTML asli + jaringan dimock.
const fs = require("fs");
const mod = require(require("path").resolve(__dirname, "..", "..", "index.js"));

const MOCK_BASE = `<script>
  (function () {
    const state = { calls: [] };
    window.__mockState = state;
    const panelRows = [{ wa_id: '628111222333@c.us', note: 'bidan desa', source: 'panel', created_at: '2026-10-02T11:20:00+07:00', from_env: false }];
    const envRows = ['6282240269818@c.us'];
    function json(body, status) {
      return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
    }
    window.fetch = function (url, options) {
      const method = (options && options.method) || 'GET';
      const path = String(url).split('?')[0];
      state.calls.push(method + ' ' + path + (options && options.body ? ' ' + options.body : ''));
      if (path.indexOf('/admin/api/users/') === 0 && path.indexOf('/actions') > 0) {
        const payload = JSON.parse((options && options.body) || '{}');
        return json({ ok: true, action: payload.action, status: 'active' });
      }
      if (path.indexOf('/admin/api/users/') === 0 && path.indexOf('/logs') > 0) {
        return json({ logs: [], page: 0, limit: 20, total: 0 });
      }
      if (path.indexOf('/admin/api/users/') === 0) {
        return json({
          user: { wa_id: '628111222333@c.us', name: 'Aulia Rachmawati', status: 'active', reminder_time: '19:00', hpht_iso: '2026-03-29', total_logs: 4, total_answered: 2, total_sudah: 2, total_belum: 1 },
          totals: { total_sudah: 2, total_belum: 1 },
          delivery: [],
          postpartum: [],
        });
      }
      if (path === '/admin/api/health') {
        return json({ client: { ready: true, lastReadyAt: '2026-10-02T05:23:37.000Z' }, guard: { paused: false, withinSendWindow: true, lastDay: 3, dailyCap: 900, sent: 4, failures: 0, config: { windowStartHour: 6, windowEndHour: 21, windowEndMinute: 30 } }, runtime: { enforce_allowlist: true, dry_run: false, maintenance_mode: false } });
      }
      if (path === '/admin/api/summary' && location.search.indexOf('summaryfail') >= 0) {
        return json({ ok: false, error: 'failed' }, 500);
      }
      if (path === '/admin/api/summary') {
        return json({
          needsAction: [],
          users: { total: 2, runnable: 2 },
          reminders: { date: '2026-10-02', todayWaiting: 1, todaySudah: 1, todayBelum: 0 },
          weekly: [
            { date: '2026-09-26', sent: 0, answered: 0, sudah: 0, belum: 0, percent: null },
            { date: '2026-09-27', sent: 3, answered: 2, sudah: 1, belum: 1, percent: 67 },
            { date: '2026-09-28', sent: 4, answered: 3, sudah: 3, belum: 0, percent: 75 },
            { date: '2026-09-29', sent: 4, answered: 0, sudah: 0, belum: 0, percent: 0 },
            { date: '2026-09-30', sent: 2, answered: 2, sudah: 2, belum: 0, percent: 100 },
            { date: '2026-10-01', sent: 5, answered: 4, sudah: 3, belum: 1, percent: 80 },
            { date: '2026-10-02', sent: 4, answered: 3, sudah: 2, belum: 1, percent: 75 },
          ],
        });
      }
      if (path === '/admin/api/users') {
        return json({ users: [{ wa_id: '6285794961470@c.us', name: 'Aulia Rachmawati', status: 'active', reminder_time: '19:00', total_logs: 0, total_answered: 0 }] });
      }
      if (path === '/admin/api/logs') {
        return json({ logs: [] });
      }
      if (path === '/admin/api/allowlist') {
        return json({ ok: true, panel: panelRows, env: envRows });
      }
      return json({ ok: false, error: 'tidak dikenal' }, 404);
    };
  })();
</script>
`;

function build(source, out) {
  const marker = '    <script nonce="preview">';
  if (!source.includes(marker)) {
    throw new Error("penanda script tidak ditemukan di " + out);
  }
  fs.writeFileSync(out, source.replace(marker, MOCK_BASE + marker));
  console.log("pratinjau:", out);
}

build(mod.renderAdminDashboardPage({ nonce: "preview", csrf: "preview-csrf" }), "/tmp/rc-preview-dashboard.html");
build(mod.renderAdminUserDetailPage("628111222333@c.us", { nonce: "preview", csrf: "preview-csrf" }), "/tmp/rc-preview-detail.html");
