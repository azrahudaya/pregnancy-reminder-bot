"use strict";

// Satu sumber gaya untuk seluruh halaman admin. Dipakai bersama supaya dashboard,
// detail, pengaturan, dan login tidak pernah berbeda sendiri-sendiri.
//
// Alasan keputusan gaya (satu baris per keputusan):
// - Radius kecil 4, 6, dan 8 px, bukan pill, supaya kepadatan data terasa rapi dan tidak kekanak-kanakan.
// - Hanya satu bayangan tipis 1 px untuk panel; hierarki dibangun dari garis rambut dan jarak, bukan elevasi palsu.
// - Tidak ada strip warna di tepi kartu, tidak ada gradien, tidak ada glow: warna hanya dipakai untuk status.
// - Ikon 16 px stroke 1.5 dipakai hanya untuk aksi dan status nyata, bukan hiasan.
// - Tinggi kontrol 34 px di desktop dan 44 px di layar kecil; target sentuh tetap besar saat dibutuhkan.
// - Garis rambut panel dan tabel sengaja tetap tipis (kontras sekitar 1,2:1) karena hanya pengelompokan visual;
//   batas kontrol interaktif dan penanda status tetap di atas 3:1 (garis kontrol 3,3:1, fokus 6,1:1, teks badge 8:1).
// - Angka memakai tabular numeral supaya kolom angka sejajar.

const ICONS = {
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97"/><path d="M13.7 2.4v3.1h-3.1"/>',
  sliders: '<path d="M3 5h10M3 11h10"/><circle cx="6" cy="5" r="1.6"/><circle cx="10" cy="11" r="1.6"/>',
  download: '<path d="M8 3v7"/><path d="M5.4 7.4 8 10l2.6-2.6"/><path d="M3.5 12.5h9"/>',
  logout: '<path d="M6.5 3.5H3.8A1.3 1.3 0 0 0 2.5 4.8v6.4a1.3 1.3 0 0 0 1.3 1.3h2.7"/><path d="M7 8h6.2"/><path d="M10.8 5.6 13.2 8l-2.4 2.4"/>',
  chevron: '<path d="M6.2 3.8 10.4 8l-4.2 4.2"/>',
  alert: '<path d="M8 2.9 14 13H2z"/><path d="M8 6.6v3.1"/><path d="M8 11.4h.01"/>',
  check: '<circle cx="8" cy="8" r="5.4"/><path d="M5.9 8.2 7.4 9.7l2.8-3"/>',
  plug: '<path d="M6 2.8v2.6M10 2.8v2.6"/><path d="M4.6 5.4h6.8v2.3a3.4 3.4 0 0 1-3.4 3.4 3.4 3.4 0 0 1-3.4-3.4z"/><path d="M8 11.1v2.1"/>',
  clock: '<circle cx="8" cy="8" r="5.4"/><path d="M8 5.2V8l2 1.3"/>',
  users: '<circle cx="6.2" cy="6.4" r="2.1"/><path d="M2.8 12.6c0-1.9 1.5-3.3 3.4-3.3s3.4 1.4 3.4 3.3"/><path d="M10.8 6.1a1.8 1.8 0 0 0 0 3"/><path d="M13.2 12.6c0-1.5-.9-2.7-2.3-3.1"/>',
  pulse: '<path d="M2.6 8h2.1l1.4-3.4L8 11.4l1.5-3.4h3.9"/>',
  list: '<path d="M5.6 4.6h7.8M5.6 8h7.8M5.6 11.4h7.8"/><path d="M3.2 4.6h.01M3.2 8h.01M3.2 11.4h.01"/>',
  search: '<circle cx="7.2" cy="7.2" r="3.9"/><path d="M10.2 10.2 13.4 13.4"/>',
  shield: '<path d="M8 2.6 12.8 4v3.6c0 2.7-1.9 4.7-4.8 5.8-2.9-1.1-4.8-3.1-4.8-5.8V4z"/><path d="M6.4 7.9h3.2"/>',
  rotate: '<path d="M12.4 6.2A5 5 0 1 0 13 9.6"/><path d="M13.2 3v3.3h-3.3"/>',
  link: '<path d="M6.8 9.2 9.2 6.8"/><path d="M9.6 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1"/><path d="M6.4 11.4l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1"/>',
  toggle: '<path d="M3 5.2h6M11 5.2h2M3 10.8h2M7 10.8h6"/><circle cx="10" cy="5.2" r="1.5"/><circle cx="6" cy="10.8" r="1.5"/>',
};

function icon(name, size = 16) {
  const body = ICONS[name];
  if (!body) {
    return "";
  }
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const ADMIN_CSS = `
      @font-face {
        font-family: "Plus Jakarta Sans";
        font-style: normal;
        font-weight: 400 700;
        font-display: swap;
        src: url("/assets/fonts/plus-jakarta-sans-latin.woff2") format("woff2");
      }
      :root {
        --bg: #fbfbfc;
        --panel: #ffffff;
        --text: #18181b;
        --muted: #71717a;
        --line: #e6e6ea;
        --line-strong: #c9cad1;
        --control-border: #8b8d97;
        --placeholder: #71717a;
        --focus: #4f46e5;
        --accent: #4f46e5;
        --accent-ink: #ffffff;
        --accent-soft: #f2f2ff;
        --ok: #14532d;
        --ok-bg: #f1f8f3;
        --warn: #7c2d12;
        --warn-bg: #fdf6ee;
        --bad: #7f1d1d;
        --bad-bg: #fdf3f3;
        --r-1: 4px;
        --r-2: 6px;
        --r-3: 8px;
        --ctl-h: 34px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: "Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 13px;
        line-height: 1.45;
        -webkit-font-smoothing: antialiased;
      }
      a { color: inherit; }
      h1, h2, h3 { margin: 0; font-weight: 600; letter-spacing: -0.01em; }
      .num { font-variant-numeric: tabular-nums; }
      .muted { color: var(--muted); font-size: 12px; }
      .ic { flex: none; vertical-align: -2px; }
      .wrap { width: min(1140px, 100%); margin: 0 auto; padding: 0 20px 36px; }
      .topbar {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
        margin-bottom: 20px;
      }
      .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .brand h1 { font-size: 14px; }
      .brand .tag { color: var(--muted); font-size: 12px; padding-left: 8px; border-left: 1px solid var(--line); }
      .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
      .row > * { min-width: 0; }
      .spacer { flex: 1 1 auto; }

      button, .btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        height: var(--ctl-h); padding: 0 10px; border-radius: var(--r-2);
        border: 1px solid var(--control-border); background: #fff; color: var(--text);
        font-family: inherit; font-size: 12.5px; font-weight: 550; cursor: pointer; text-decoration: none;
        white-space: nowrap;
      }
      button:hover, .btn:hover { background: #fafafa; border-color: var(--text); }
      button:disabled { opacity: .55; cursor: default; }
      .btn-primary, button.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
      .btn-primary:hover, button.btn-primary:hover { background: #4338ca; border-color: #4338ca; }
      .btn-icon { width: var(--ctl-h); padding: 0; }
      .link-btn { border: none; background: none; height: auto; padding: 0; color: var(--accent); font-weight: 550; }
      .link-btn:hover { background: none; text-decoration: underline; }
      :where(button, a, input, summary, [tabindex]):focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-3); }
      .panel + .panel { margin-top: 12px; }
      .panel-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 10px 12px; border-bottom: 1px solid var(--line); min-width: 0;
      }
      .panel-head h2 { font-size: 13px; display: flex; align-items: center; gap: 6px; }
      .panel-body { padding: 12px; }
      .panel-body.flush { padding: 0; }

      .badge {
        display: inline-flex; align-items: center; gap: 4px; border-radius: var(--r-1);
        border: 1px solid var(--line); background: #fafafa; color: var(--muted);
        padding: 1px 6px; font-size: 11px; font-weight: 550;
      }
      .badge-ok { background: var(--ok-bg); color: var(--ok); border-color: #cfe6d6; }
      .badge-warn { background: var(--warn-bg); color: var(--warn); border-color: #ecd6bd; }
      .badge-bad { background: var(--bad-bg); color: var(--bad); border-color: #edcccc; }
      .badge-accent { background: var(--accent-soft); color: #3730a3; border-color: #d6d6f7; }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }

      .kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); }
      .kv > div { padding: 9px 12px; border-right: 1px solid var(--line); border-top: 1px solid var(--line); }
      .kv > div:last-child { border-right: none; }
      .kv dt { color: var(--muted); font-size: 11.5px; display: flex; align-items: center; gap: 5px; }
      .kv dd { margin: 3px 0 0; font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }

      .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
      .metric { padding: 10px 12px; border-right: 1px solid var(--line); }
      .metric:last-child { border-right: none; }
      .metric .k { color: var(--muted); font-size: 11.5px; }
      .metric .v { font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }

      .seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--r-2); overflow: hidden; max-width: 100%; }
      .seg button { border: none; border-right: 1px solid var(--line); border-radius: 0; background: #fff; height: var(--ctl-h); padding: 0 10px; color: var(--muted); }
      .seg button:last-child { border-right: none; }
      .seg button[aria-pressed="true"] { background: var(--accent-soft); color: #3730a3; font-weight: 600; }
      .seg button:hover { background: #fafafa; }

      .tasks { margin: 0; padding: 0; list-style: none; }
      .task { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-top: 1px solid var(--line); }
      .task:first-child { border-top: none; }
      .task-why { color: var(--muted); font-size: 11.5px; }
      .task-name { font-weight: 550; overflow-wrap: anywhere; }

      .empty { padding: 12px; color: var(--muted); font-size: 12.5px; }

      .table-wrap { overflow-x: auto; max-width: 100%; }
      table { width: 100%; border-collapse: collapse; min-width: 640px; }
      caption { text-align: left; padding: 8px 12px; color: var(--muted); font-size: 11.5px; }
      th, td { text-align: left; padding: 8px 12px; border-top: 1px solid var(--line); white-space: nowrap; }
      th { color: var(--muted); font-size: 11.5px; font-weight: 600; background: #fafafa; }
      tbody tr:hover { background: #fcfcfd; }
      td.name-cell { padding: 0; }
      a.row-link { display: flex; align-items: center; height: 44px; padding: 0 12px; font-weight: 550; color: var(--accent); text-decoration: none; }
      a.row-link:hover { text-decoration: underline; }

      .feed { margin: 0; padding: 0; list-style: none; }
      .feed li { display: flex; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--line); font-size: 12.5px; }
      .feed li:first-child { border-top: none; }
      .feed .when { color: var(--muted); font-size: 11.5px; }

      .search {
        height: var(--ctl-h); border: 1px solid var(--control-border); border-radius: var(--r-2);
        padding: 0 10px 0 30px; font-family: inherit; font-size: 12.5px; background: #fff; min-width: 0; flex: 1 1 200px;
      }
      .search::placeholder { color: var(--placeholder); }
      .search-wrap { position: relative; display: flex; flex: 1 1 200px; min-width: 0; }
      .search-wrap .ic { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--muted); }

      .note { margin: 0 0 10px; color: var(--bad); font-size: 12px; }
      .note[hidden] { display: none; }
      .banner { display: flex; align-items: center; gap: 10px; border: 1px solid #edcccc; background: var(--bad-bg); color: var(--bad); border-radius: var(--r-3); padding: 10px 12px; font-size: 12.5px; margin-bottom: 12px; }
      .banner[hidden] { display: none; }
      .banner p { margin: 0; }

      fieldset { border: none; margin: 0; padding: 0; }
      label { font-size: 12px; color: var(--muted); }
      input[type="text"], input[type="number"], input[type="password"], select {
        width: 100%; height: var(--ctl-h); border: 1px solid var(--control-border); border-radius: var(--r-2);
        padding: 0 10px; font-family: inherit; font-size: 12.5px; background: #fff; color: var(--text);
      }
      input::placeholder { color: var(--placeholder); }
      .field { display: grid; gap: 4px; }
      .grid-fields { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
      .check { display: flex; align-items: center; gap: 8px; min-height: 34px; }
      .check input { width: 16px; height: 16px; accent-color: var(--accent); }

      .toast { position: fixed; right: 16px; bottom: 16px; background: var(--text); color: #fff; border-radius: var(--r-2); padding: 9px 12px; font-size: 12.5px; opacity: 0; transform: translateY(6px); transition: opacity .15s ease, transform .15s ease; pointer-events: none; }
      .toast.show { opacity: 1; transform: translateY(0); }

      details.pop { position: relative; }
      details.pop summary { list-style: none; }
      details.pop summary::-webkit-details-marker { display: none; }
      details.pop > .panel { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; width: 250px; }
      details.pop > .panel a { display: flex; align-items: center; gap: 6px; padding: 7px 10px; text-decoration: none; border-top: 1px solid var(--line); font-size: 12.5px; }
      details.pop > .panel a:first-of-type { border-top: none; }
      details.pop > .panel a:hover { background: #fafafa; }

      [hidden] { display: none !important; }

      /* Di bawah 900 px kontrol dinaikkan ke 44 px supaya nyaman disentuh di tablet dan ponsel. */
      @media (max-width: 900px) {
        :root { --ctl-h: 44px; }
        .wrap { padding: 0 14px 28px; }
        .topbar { padding: 12px 14px; }
        .brand .tag { display: none; }
        .kv > div { border-right: none; }
        .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .metric { border-right: none; }
        .seg { width: 100%; flex-wrap: wrap; overflow: visible; border: none; gap: 4px; }
        .seg button { border: 1px solid var(--line); border-radius: var(--r-2); }
        .seg button:last-child { border-right: 1px solid var(--line); }
        .check { min-height: 44px; }
        .task { flex-wrap: wrap; }
        .task .row { width: 100%; }
        .task .row > * { flex: 1 1 auto; }
        details.pop > .panel { left: 0; right: auto; width: 100%; }
      }
      @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

module.exports = { ADMIN_CSS, ICONS, icon };
