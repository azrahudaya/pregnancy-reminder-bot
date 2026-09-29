# pregnancy-reminder-bot

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.22-000000?logo=express&logoColor=white)
![whatsapp-web.js](https://img.shields.io/badge/whatsapp--web.js-1.34.6-25D366?logo=whatsapp&logoColor=white)
![SQLite3](https://img.shields.io/badge/SQLite3-5.1-003B57?logo=sqlite&logoColor=white)
![Luxon](https://img.shields.io/badge/Luxon-3.7-FF8033)
![License](https://img.shields.io/badge/license-MIT-green)

WhatsApp bot pengingat konsumsi tablet FE harian untuk ibu hamil, lengkap dengan admin web.

## Teknologi

- Node.js 18+
- whatsapp-web.js 1.34
- Express 4.22
- sqlite3 5.1
- Luxon 3.7
- qrcode-terminal 0.12

## Menjalankan

```bash
npm install
cp .env.example .env
npm start
```

Koneksikan WhatsApp lewat QR di terminal, atau pakai kode pairing 8 digit dengan mengisi `WA_PAIRING_NUMBER` di `.env` (lihat `deploy/INSTALL.md`).

## Tes

```bash
npm test
```

## Lisensi

MIT, lihat `LICENSE`.