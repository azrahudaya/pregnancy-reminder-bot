# Cara pasang di server Linux

Perintah di bawah dijalankan sebagai user yang akan menjalankan bot (contoh: `ubuntu`).

```bash
sudo mkdir -p /opt/remindcare
sudo chown "$USER":"$USER" /opt/remindcare
# salin isi repo ke /opt/remindcare (rsync, git clone, atau tar)
cd /opt/remindcare
npm install
cp .env.example .env
# isi .env minimal: ADMIN_WA_IDS, ALLOWLIST_WA_IDS, ENFORCE_ALLOWLIST, ADMIN_WEB_PASSWORD (opsional)
node index.js          # pairing pertama, pindai QR, lalu Ctrl+C
```

Setelah QR berhasil dipindai, cadangkan folder sesi sebelum menyalakan service:

```bash
tar czf ~/remindcare-session-$(date +%F).tar.gz .wwebjs_auth
```

Pasang service bot dan timer backup:

```bash
sudo cp deploy/remindcare-bot.service /etc/systemd/system/
sudo cp deploy/remindcare-backup.service deploy/remindcare-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now remindcare-bot.service
sudo systemctl enable --now remindcare-backup.timer
systemctl status remindcare-bot --no-pager
journalctl -u remindcare-bot -n 50 --no-pager
```

Penting: `enable --now` untuk timer, bukan `enable` saja. Perintah `enable` tanpa `--now`
hanya mendaftarkan timer supaya hidup saat boot, tetapi timer-nya tidak jalan di sesi ini,
sehingga backup tidak pernah dijalankan sampai server di-reboot.

Verifikasi bahwa timer benar-benar terjadwal:

```bash
systemctl is-active remindcare-backup.timer          # harus active
systemctl list-timers remindcare-backup.timer        # baris NEXT harus terisi
systemctl start remindcare-backup.service            # jalankan sekali untuk uji
journalctl -u remindcare-backup -n 5 --no-pager      # harus muncul "Backup ok"
```

## Menautkan sesi tanpa QR (server tanpa layar)

QR di journal sulit dipindai dari jarak jauh. Isi `WA_PAIRING_NUMBER` di `.env` dengan
nomor bot, format `628xxxxxxxxxx`, lalu jalankan bot. WhatsApp tidak lagi meminta QR: bot
meminta kode 8 digit dan menuliskannya ke journal sekaligus ke `data/pairing-code.txt`.

```bash
grep WA_PAIRING_NUMBER .env
sudo systemctl restart remindcare-bot
sleep 20
cat data/pairing-code.txt
```

Masukkan kode itu di WhatsApp nomor bot: Perangkat tertaut > Tautkan perangkat >
Tautkan dengan nomor telepon. Kode berlaku beberapa menit saja; kalau kedaluwarsa, bot
otomatis meminta kode baru setiap `WA_PAIRING_CODE_REFRESH_MS` (default 3 menit).
`data/pairing-code.txt` dihapus sendiri begitu sesi tersambung. Setelah tersambung,
kosongkan `WA_PAIRING_NUMBER` kalau mau kembali ke jalur QR.

Verifikasi sesi benar-benar tersambung, jangan hanya melihat kode muncul:

```bash
journalctl -u remindcare-bot -n 5 --no-pager | grep -i "siap digunakan"
PW=$(cat data/admin_web_password.txt)
curl -s -c /tmp/j -o /dev/null -X POST --data-urlencode "username=admin" \
  --data-urlencode "password=$PW" http://127.0.0.1:3030/admin/login
curl -s -b /tmp/j http://127.0.0.1:3030/admin/api/health | grep -o '"ready":[a-z]*'
```

`"ready":true` berarti sesi hidup. Kalau masih `false`, taut ulang.

## Memulihkan sesi WhatsApp

Sesi ter-logout (biasanya karena WhatsApp Web diperbarui, atau ada dua proses yang
memakai folder `.wwebjs_auth` yang sama):

```bash
sudo systemctl stop remindcare-bot
rm -rf .wwebjs_auth
tar xzf ~/remindcare-session-TANGGAL.tar.gz
sudo systemctl start remindcare-bot
```

Kalau backup sesi tidak ada, jalankan `node index.js` untuk memindai QR baru.

## Memulihkan database

```bash
sudo systemctl stop remindcare-bot
cp data/backups/remindcare-TANGGAL-JAM.db data/remindcare.db
sqlite3 data/remindcare.db "PRAGMA integrity_check;"
sudo systemctl start remindcare-bot
```

## Yang tidak boleh masuk git

Folder `data/` (database, audio, backup, file password admin) dan `.wwebjs_auth/`.
`.gitignore` sudah menutupinya dengan pola `data*/`. Periksa dengan `git ls-files`
sebelum setiap commit.