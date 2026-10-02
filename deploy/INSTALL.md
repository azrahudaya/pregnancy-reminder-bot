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
ss -ltn | grep 3030                                   # panel admin mendengarkan
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3030/admin/login   # harus 200
```

Endpoint kesehatan butuh sesi admin, jadi masuk dulu lewat panel (password ada di
`ADMIN_WEB_PASSWORD` pada `.env`, atau hasil `scripts/rotate-admin-password.js`).
Kalau log tidak memuat "siap digunakan", taut ulang sesinya.

## Password admin

Password disimpan sebagai hash scrypt di tabel `settings` (`admin_password_hash` dan
`admin_password_hash_salt`) dan itu satu-satunya sumber verifikasi. Tidak ada lagi berkas
password plaintext di `data/`.

```bash
# ganti password tanpa menyentuh .env
node scripts/rotate-admin-password.js            # mengikuti petunjuk di skrip
```

Setelah hash berubah, semua sesi panel yang sedang aktif dicabut otomatis (diperiksa tiap
5 menit), jadi tidak ada sesi lama yang tertinggal setelah password diputar.

## Sandbox Chromium di Ubuntu 24

Chrome hanya mau menyalakan sandbox-nya kalau user namespace tidak diblokir AppArmor.
Ubuntu 23.10 ke atas memblokirnya secara default, dan tanpa perbaikan ini bot hanya jalan
dengan `PUPPETEER_NO_SANDBOX=1` (sandbox mati).

```bash
printf 'kernel.apparmor_restrict_unprivileged_userns=0\n' | sudo tee /etc/sysctl.d/99-remindcare-userns.conf
sudo sysctl -p /etc/sysctl.d/99-remindcare-userns.conf
# di .env: PUPPETEER_NO_SANDBOX=0
sudo systemctl restart remindcare-bot
pgrep -a -f chrome-linux64/chrome | grep -c -- "--no-sandbox"   # harus 0
```

## Backup di luar VPS

`scripts/backup-db.js` menguji setiap backup (integritas, tabel inti, data terbaca) sebelum
diakui sah. Backup yang hanya ada di VPS yang sama belum aman, jadi isi salah satu:

```bash
BACKUP_OFFSITE_DIR=/mnt/backup-remindcare     # direktori mount (rclone, S3, NFS)
BACKUP_REMOTE_CMD=rclone copy %f remote:remindcare-backups/   # perintah sendiri, %f = berkas backup
```

Tanpa keduanya, skrip tetap jalan tetapi mencetak peringatan bahwa salinan luar VPS belum ada.

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

Pakai berkas hasil backup (`VACUUM INTO`), bukan salinan manual `data/remindcare.db`:
salinan manual tidak memuat isi WAL terakhir, jadi transaksi paling baru bisa hilang.

```bash
cd /opt/remindcare
sudo systemctl stop remindcare-bot
ls -la data/backups/                       # pilih berkas terbaru
sudo -u remindcare node -e "
const s=require('sqlite3').verbose();const d=new s.Database('data/backups/remindcare-TANGGAL-JAM.db');
d.get('PRAGMA integrity_check',(e,r)=>{console.log(e?e.message:r);d.close();});
"
cp data/backups/remindcare-TANGGAL-JAM.db data/remindcare.db
rm -f data/remindcare.db-wal data/remindcare.db-shm
sudo chown remindcare:remindcare data/remindcare.db
sudo systemctl start remindcare-bot
journalctl -u remindcare-bot -n 20 --no-pager | grep -iE "siap digunakan|integrity"
```

Kalau `integrity_check` gagal saat start, bot menahan semua pengiriman dan mengirim alarm.
Pulihkan dulu dari backup sebelum mengaktifkan lagi.

## Yang tidak boleh masuk git

Folder `data/` (database, audio, backup, file password admin) dan `.wwebjs_auth/`.
`.gitignore` sudah menutupinya dengan pola `data*/`. Periksa dengan `git ls-files`
sebelum setiap commit.