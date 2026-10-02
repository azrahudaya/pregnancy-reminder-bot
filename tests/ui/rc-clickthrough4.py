#!/usr/bin/env python3
"""Uji klik kartu Kepatuhan 7 hari: baris, badge, bar, state gagal, dan layar kecil."""
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
    page.goto("file:///tmp/rc-preview-dashboard.html")
    page.wait_for_function("document.querySelectorAll('#week-body tr').length === 7")

    rows = page.eval_on_selector_all(
        "#week-body tr",
        "els => els.map(tr => Array.from(tr.children).map(td => td.textContent.trim()))",
    )
    check("tujuh baris hari ditampilkan", len(rows) == 7, len(rows))
    check("header kartu benar", page.inner_text("#week-title").strip() == "Kepatuhan 7 hari", page.inner_text("#week-title"))
    check(
        "angka baris cocok dengan data",
        rows[1][:5] == ["2026-09-27", "3", "2", "1", "1"],
        rows[1][:5],
    )
    check(
        "hari tanpa pengingat tidak ditulis 0 persen",
        "tidak ada pengingat" in rows[0][5],
        rows[0][5],
    )
    check("persen hari dengan pengingat tampil", rows[2][5].startswith("75 persen"), rows[2][5])
    bar_ok = page.evaluate(
        "(() => { const tr = document.querySelectorAll('#week-body tr')[2]; const bar = tr.querySelector('.week-bar span'); return bar ? bar.style.width : ''; })()"
    )
    check("panjang bar mengikuti persen", bar_ok == "75%", bar_ok)
    check(
        "badge kartu memuat persen keseluruhan",
        "% dijawab" in page.inner_text("#week-badge"),
        page.inner_text("#week-badge"),
    )
    check(
        "aria-busy kartu dimatikan setelah render",
        page.get_attribute("#week-body", "aria-busy") == "false",
        page.get_attribute("#week-body", "aria-busy"),
    )
    hari_berbar = len([r for r in rows if "persen" in r[5]])
    jumlah_bar = page.eval_on_selector_all(".week-bar[aria-hidden='true']", "els => els.length")
    check("tiap bar hari berisi pengingat ditandai hiasan untuk pembaca layar", jumlah_bar == hari_berbar and hari_berbar > 0, [jumlah_bar, hari_berbar])
    check("tidak ada em dash di halaman", "\u2014" not in page.content(), True)

    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(200)
    kotak = page.evaluate(
        "(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }))()"
    )
    check("tanpa overflow di 390 px", kotak["doc"] <= kotak["win"] + 1, kotak)
    page.close()

    gagal = browser.new_page(viewport={"width": 1280, "height": 960})
    gagal.goto("file:///tmp/rc-preview-dashboard.html?summaryfail=1")
    gagal.wait_for_function("document.getElementById('week-badge').textContent === 'gagal'")
    isi = gagal.inner_text("#week-body")
    check("state gagal kartu terisi", "Ringkasan gagal dimuat" in isi, isi)
    check(
        "aria-busy tetap dimatikan saat gagal",
        gagal.get_attribute("#week-body", "aria-busy") == "false",
        gagal.get_attribute("#week-body", "aria-busy"),
    )
    gagal.close()

    check("tidak ada error JavaScript", not errs, errs[:2])
    browser.close()

failed = [r for r in results if not r[1]]
print("\nRINGKASAN: " + str(len(results) - len(failed)) + "/" + str(len(results)) + " PASS")
raise SystemExit(1 if failed else 0)
