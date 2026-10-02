#!/usr/bin/env python3
"""Uji klik halaman pengaturan: penguncian tombol darurat, baris hasil aksi, state galat,
label tombol, dan target sentuh di layar kecil."""
from playwright.sync_api import sync_playwright

results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print(("PASS " if ok else "FAIL ") + label + (" | " + str(detail) if detail != "" else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 960})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append("console:" + m.text) if m.type == "error" and "ERR_FILE_NOT_FOUND" not in m.text else None)
    page.goto("file:///tmp/rc-preview-settings.html")
    page.wait_for_function("document.querySelectorAll('.btn-row button').length >= 6")

    labels = page.eval_on_selector_all(".btn-row button", "els => els.map(b => b.textContent.trim())")
    check("label tombol simulasi berbentuk perintah", "Aktifkan simulasi" in labels and "Matikan simulasi" in labels, labels[:4])

    page.on("dialog", lambda d: d.accept())
    page.click("#aksi-pause")
    page.wait_for_timeout(300)
    disabled_mid = page.eval_on_selector_all(".btn-row button", "els => els.filter(b => b.disabled).length")
    total_btn = page.eval_on_selector_all(".btn-row button", "els => els.length")
    emergency_off = page.eval_on_selector_all(
        "#aksi-pause, #aksi-resume, #aksi-dry-on, #aksi-dry-off, #aksi-maint-on, #aksi-maint-off",
        "els => els.filter(b => b.disabled).length",
    )
    check("keenam tombol darurat terkunci saat aksi berjalan", emergency_off == 6, emergency_off)
    check("tombol lain ikut terkunci supaya tidak bentrok", disabled_mid == total_btn, [disabled_mid, total_btn])

    page.wait_for_function("document.getElementById('hasil-darurat').textContent.indexOf('Selesai') === 0", timeout=8000)
    hasil = page.inner_text("#hasil-darurat")
    status = page.inner_text("#status-darurat")
    check("hasil aksi ditulis di baris terpisah", "Selesai" in hasil, hasil)
    check("baris hasil tidak tertimpa status mode", "Selesai" in hasil and "Mode sekarang" in status, [hasil, status])
    check(
        "konfirmasi memuat dampak aksi",
        "pengiriman terjadwal berhenti" in hasil.lower(),
        hasil,
    )
    check("tombol dilepas setelah aksi selesai", page.eval_on_selector_all(".btn-row button", "els => els.filter(b => b.disabled).length") == 0, True)

    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(200)
    box = page.evaluate("(() => { const row = document.querySelector('.check'); const box = row ? row.getBoundingClientRect() : null; return { h: box ? box.height : 0, doc: document.documentElement.scrollWidth, win: window.innerWidth }; })()")
    check("baris checkbox minimal 44 px di ponsel", box["h"] >= 44, box)
    check("halaman pengaturan tidak overflow di 390 px", box["doc"] <= box["win"] + 1, box)
    page.close()

    fail = browser.new_page(viewport={"width": 1280, "height": 960})
    fail.goto("file:///tmp/rc-preview-settings.html?fail=1")
    fail.wait_for_function("document.getElementById('status-kesehatan').textContent.length > 0 && document.getElementById('status-kesehatan').textContent.indexOf('Gagal') >= 0")
    status_galat = fail.inner_text("#status-darurat")
    check(
        "status darurat menjelaskan kegagalan, bukan menggantung",
        "Memuat status." not in status_galat and "tidak terbaca" in status_galat,
        status_galat,
    )
    ket = fail.inner_text("#status-kesehatan")
    check("baris kesehatan menjelaskan langkah berikutnya", "Pastikan proses bot masih berjalan" in ket, ket)
    fail.close()

    check("tidak ada error JavaScript di halaman pengaturan", not errs, errs[:2])
    browser.close()

failed = [r for r in results if not r[1]]
print("\nRINGKASAN: " + str(len(results) - len(failed)) + "/" + str(len(results)) + " PASS")
raise SystemExit(1 if failed else 0)
