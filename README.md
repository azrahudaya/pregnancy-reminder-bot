# pregnancy-reminder-bot

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.22-000000?logo=express&logoColor=white)
![whatsapp-web.js](https://img.shields.io/badge/whatsapp--web.js-1.34.6-25D366?logo=whatsapp&logoColor=white)
![SQLite3](https://img.shields.io/badge/SQLite3-5.1-003B57?logo=sqlite&logoColor=white)
![Luxon](https://img.shields.io/badge/Luxon-3.7-FF8033)
![License](https://img.shields.io/badge/license-MIT-green)

A WhatsApp bot that reminds pregnant women to take their daily FE (iron) tablet, tracks adherence, validates delivery, and manages postpartum visit reminders. Includes an admin web dashboard.

## Tech stack

- Node.js 18+
- whatsapp-web.js 1.34
- Express 4.22
- sqlite3 5.1
- Luxon 3.7
- qrcode-terminal 0.12

## Run

```bash
npm install
cp .env.example .env
npm start
```

Connect WhatsApp by scanning the QR code in the terminal, or use an 8-digit pairing code by setting `WA_PAIRING_NUMBER` in `.env` (see `deploy/INSTALL.md`).

## Test

```bash
npm test
```

## Docs

Technical documentation with user flows and scenarios: [docs/technical-guide.pdf](docs/technical-guide.pdf).

## License

MIT, see `LICENSE`.