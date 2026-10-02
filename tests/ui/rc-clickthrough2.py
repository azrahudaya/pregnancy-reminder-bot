#!/usr/bin/env python3
"""Uji klik lanjutan untuk perbaikan audit: panel tindakan di detail user, aria-busy,
dropdown ekspor, label metrik, dan tampilan ponsel."""
from playwright.sync_api import sync_playwright

results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print(("PASS " if ok else "FAIL ") + label + (" | " + str(detail) if detail != "" else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)

    # ---------- dashboard ----------
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on(
        "console",
        lambda m: errors.append("console:" + m.text)
        if m.type == "error" and "ERR_FILE_NOT_FOUND" not in m.text
        else None,
    )
    page.goto("file:///tmp/rc-preview-dashboard.html")
    page.wait_for_function("document.querySelectorAll('#access-body tr').length >= 1")

    check(
        "aria-busy tabel user dimatikan setelah render",
        page.get_attribute("#users-body", "aria-busy") == "false",
        page.get_attribute("#users-body", "aria-busy"),
    )
    check(
        "aria-busy catatan pengingat dimatikan setelah render",
        page.get_attribute("#logs-body", "aria-busy") == "false",
        page.get_attribute("#logs-body", "aria-busy"),
    )
    check(
        "label metrik tidak lagi menyesatkan",
        "User tidak berjalan" in page.inner_text("#today-title").replace("Hari ini", "") + page.inner_html(".metrics"),
        "User tidak berjalan" in page.inner_html(".metrics"),
    )
    check(
        "singkatan FE dijelaskan",
        "FE tablet tambah darah" in page.inner_text(".wrap"),
        True,
    )

    summary = page.query_selector("details.pop > summary")
    summary.click()
    check("dropdown ekspor terbuka saat diklik", page.eval_on_selector("details.pop", "el => el.open"), True)
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    state_esc = page.eval_on_selector("details.pop", "el => el.open")
    check("dropdown menutup dengan Escape", state_esc is False, state_esc)
    summary.click()
    page.wait_for_timeout(100)
    page.mouse.click(600, 700)
    page.wait_for_timeout(200)
    state_out = page.eval_on_selector("details.pop", "el => el.open")
    check("dropdown menutup saat klik di luar", state_out is False, state_out)

    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(200)
    m = page.evaluate("({doc: document.documentElement.scrollWidth, win: window.innerWidth})")
    check("dashboard tidak overflow di 390 px", m["doc"] <= m["win"] + 1, m)
    page.close()

    # ---------- detail user ----------
    detail = browser.new_page(viewport={"width": 1280, "height": 900})
    derr = []
    detail.on("pageerror", lambda e: derr.append(str(e)))
    detail.goto("file:///tmp/rc-preview-detail.html")
    detail.wait_for_selector("#aksi-pause")
    for selector in ["#aksi-resume", "#aksi-pause", "#aksi-complete", "#aksi-jam", "#aksi-simpan-jam"]:
        check("kontrol " + selector + " ada di halaman detail", detail.query_selector(selector) is not None)

    detail.fill("#aksi-jam", "19:00")
    detail.click("#aksi-simpan-jam")
    detail.wait_for_function("document.getElementById('aksi-status').textContent.indexOf('Selesai') === 0")
    check(
        "simpan jam mengirim aksi set_reminder_time dengan nilai",
        "set_reminder_time" in detail.evaluate("window.__mockState.calls.join(' | ')") and "19:00" in detail.evaluate("window.__mockState.calls.join(' | ')"),
        detail.evaluate("window.__mockState.calls.slice(-1)[0]"),
    )
    check("status sukses tampil", "Selesai" in detail.inner_text("#aksi-status"), detail.inner_text("#aksi-status"))

    check("input jam dikosongkan setelah simpan", detail.input_value("#aksi-jam") == "", detail.input_value("#aksi-jam"))
    detail.click("#aksi-pause")
    detail.wait_for_function("window.__mockState.calls.some(c => c.indexOf('\"action\":\"pause\"') >= 0)")
    calls = detail.evaluate("window.__mockState.calls")
    check("jeda pengingat terkirim ke server", any('"action":"pause"' in c for c in calls), [c for c in calls if "pause" in c][:1])

    detail.fill("#aksi-jam", "")
    detail.click("#aksi-simpan-jam")
    detail.wait_for_timeout(300)
    check("jam kosong ditolak dengan pesan", "Isi jam dulu" in detail.inner_text("#aksi-status"), detail.inner_text("#aksi-status"))

    detail.set_viewport_size({"width": 390, "height": 844})
    detail.wait_for_timeout(200)
    md = detail.evaluate("({doc: document.documentElement.scrollWidth, win: window.innerWidth, btn: document.querySelector('#aksi-simpan-jam').getBoundingClientRect().height})")
    check("detail user tidak overflow di 390 px", md["doc"] <= md["win"] + 1, md)
    check("tombol aksi memenuhi target sentuh", md["btn"] >= 44, md["btn"])
    check("tidak ada error JavaScript di halaman detail", not derr, derr[:2])
    detail.close()

    check("tidak ada error JavaScript di dashboard", not errors, errors[:2])
    browser.close()

failed = [r for r in results if not r[1]]
print("\nRINGKASAN: " + str(len(results) - len(failed)) + "/" + str(len(results)) + " PASS")
raise SystemExit(1 if failed else 0)
