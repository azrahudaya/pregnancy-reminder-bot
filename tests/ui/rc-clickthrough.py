#!/usr/bin/env python3
"""Uji klik panel akses nomor di browser sungguhan (Chrome headless via Playwright).

Halaman yang diuji adalah HTML asli dari index.js. Jaringan diganti mock karena panel
produksi butuh sesi admin yang tidak boleh diisi dari sini.
"""
from playwright.sync_api import sync_playwright

URL = "file:///tmp/rc-dashboard-preview.html"
results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + label + (" | " + str(detail) if detail else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # Aset font tidak bisa dimuat dari file://, jadi hanya error lain yang dihitung.
    page.on(
        "console",
        lambda m: errors.append("console:" + m.text)
        if m.type == "error" and "ERR_FILE_NOT_FOUND" not in m.text
        else None,
    )
    page.goto(URL)
    page.wait_for_selector("#access-body tr td")

    def rows():
        return page.eval_on_selector_all(
            "#access-body tr",
            "els => els.map(tr => [...tr.children].map(td => td.textContent.trim()))",
        )

    # 1. daftar terisi setelah muat
    page.wait_for_function("document.querySelectorAll('#access-body tr').length === 3")
    data = rows()
    check("daftar akses menampilkan 3 baris (1 panel + 2 dari berkas .env)", len(data) == 3, data)
    check("baris panel punya tombol Cabut", data[0][4] == "Cabut", data[0])
    check("baris berkas .env tanpa tombol", data[1][4] == "di berkas .env", data[1])
    caption = page.inner_text("#access-count")
    check("caption menghitung nomor yang dilayani", "3 nomor dilayani" in caption, caption)
    mode = page.inner_text("#access-mode")
    check("badge mode allowlist aktif", mode == "Allowlist aktif", mode)

    # 2. tambah nomor baru
    page.fill("#access-number", "0812-3456-7890")
    page.fill("#access-note", "kader posyandu")
    page.click("#access-submit")
    page.wait_for_function("document.querySelectorAll('#access-body tr').length === 4")
    data = rows()
    check("nomor 08xx diseragamkan dan masuk daftar", any(r[0] == "6281234567890@c.us" for r in data), [r for r in data if r[0] == "6281234567890@c.us"])
    check("catatan tersimpan di baris", any(r[2] == "kader posyandu" for r in data))
    status = page.inner_text("#access-status")
    check("status sukses memberi langkah lanjutan", "Minta dia kirim pesan start ke bot" in status, status)
    check("form dikosongkan setelah sukses", page.input_value("#access-number") == "")
    check("fokus kembali ke input nomor", page.evaluate("document.activeElement.id") == "access-number")

    # 3. nomor ganda
    rows_before = len(rows())
    page.fill("#access-number", "6281234567890")
    page.click("#access-submit")
    page.wait_for_function("document.getElementById('access-status').textContent.indexOf('sudah ada di daftar') >= 0")
    status = page.inner_text("#access-status")
    check("nomor ganda dilaporkan tanpa duplikasi", "sudah ada di daftar" in status and len(rows()) == rows_before, [status, rows_before, len(rows())])

    # 4. nomor tidak sah (state error)
    page.fill("#access-number", "nomor bidan")
    page.click("#access-submit")
    page.wait_for_function("document.getElementById('access-status').textContent.indexOf('Gagal menambah') === 0")
    status = page.inner_text("#access-status")
    check("nomor tidak sah ditolak dengan pesan contoh", "Format nomor tidak sah" in status and "6281234567890" in status, status)

    # 5. keyboard: label dan fokus terlihat
    page.keyboard.press("Tab")
    focus = page.evaluate("(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { id: el.id, tag: el.tagName, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor }; })()")
    check("fokus terlihat pada elemen aktif", focus["tag"] in ("INPUT", "BUTTON") and focus["outline"].startswith("solid") and "none" not in focus["outline"], focus)

    # 6. cabut akses butuh dua klik
    target = page.query_selector("#access-body tr button")
    target.click()
    check("klik pertama hanya mengubah label", target.inner_text().strip() == "Yakin cabut?", target.inner_text())
    target.click()
    page.wait_for_function("document.getElementById('access-status').textContent.indexOf('dihapus dari daftar panel') >= 0")
    page.wait_for_function("document.querySelectorAll('#access-body tr').length === 3")
    data = rows()
    mock_panel = page.evaluate("window.__mockState.panel.map(e => e.wa_id)")
    check("permintaan cabut benar-benar sampai ke server", "628111222333@c.us" not in mock_panel, mock_panel)
    check("baris panel hilang setelah klik kedua", len(data) == 3 and all(r[0] != "628111222333@c.us" for r in data), data)
    status = page.inner_text("#access-status")
    check("status pencabutan jelas", "dihapus dari daftar panel" in status, status)

    # 7. keyboard saja: tambah lewat Enter
    page.click("#access-number")
    page.fill("#access-number", "628999888777")
    page.keyboard.press("Enter")
    page.wait_for_function("document.querySelectorAll('#access-body tr').length === 4")
    check("tambah nomor bisa dengan keyboard (Enter)", any(r[0] == "628999888777@c.us" for r in rows()))

    # 8. ponsel: tidak ada overflow halaman
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(200)
    m = page.evaluate("({ doc: document.documentElement.scrollWidth, win: window.innerWidth, wrap: document.querySelector('.table-wrap').scrollWidth, wrapClient: document.querySelector('.table-wrap').clientWidth, btn: document.querySelector('#access-submit').getBoundingClientRect().height })")
    check("tidak ada overflow horizontal halaman di 390px", m["doc"] <= m["win"] + 1, m)
    check("tabel menggeser di dalam wadahnya", m["wrap"] >= m["wrapClient"], m)
    check("tombol memenuhi target sentuh 44px", m["btn"] >= 44, m["btn"])

    # 9. state gagal muat
    page.set_viewport_size({"width": 1280, "height": 900})
    page.goto(URL + "?fail=1")
    page.wait_for_selector("#access-status:not([hidden])")
    note = page.inner_text("#access-status")
    check("state gagal muat dijelaskan", "Bagian ini gagal dimuat" in note and "kode 500" in note, note)

    check("tidak ada error JavaScript", not errors, errors[:3])
    browser.close()

failed = [r for r in results if not r[1]]
print("\nRINGKASAN:", len(results) - len(failed), "/", len(results), "PASS")
raise SystemExit(1 if failed else 0)
