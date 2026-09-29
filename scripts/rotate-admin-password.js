#!/usr/bin/env node
"use strict";

// Putar ulang password admin tanpa membuka kode.
// Password baru ditulis ke data/admin_web_password.txt dengan mode 600 dan hash-nya
// diperbarui di tabel settings. Password tidak dicetak ke stdout: stdout masuk ke
// journald atau log PM2, dan itu berarti password ikut tersimpan di berkas log.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "remindcare.db");
const PASSWORD_FILE = path.join(DATA_DIR, "admin_web_password.txt");
const MODE = 0o600;

const scryptHash = (password, salt) =>
  crypto.scryptSync(String(password), String(salt), 32).toString("hex");

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onDone(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const password = `Rc-${crypto
    .randomBytes(18)
    .toString("base64")
    .replace(/[+/=]/g, "")}`;
  const salt = crypto.randomBytes(16).toString("hex");

  fs.writeFileSync(PASSWORD_FILE, password, { encoding: "utf8", mode: MODE });
  fs.chmodSync(PASSWORD_FILE, MODE);

  if (fs.existsSync(DB_PATH)) {
    const db = new sqlite3.Database(DB_PATH);
    db.configure("busyTimeout", 5000);
    try {
      await run(
        db,
        `CREATE TABLE IF NOT EXISTS settings (
           key TEXT PRIMARY KEY,
           value TEXT,
           updated_at TEXT NOT NULL
         )`,
      );
      const now = new Date().toISOString();
      for (const [key, value] of [
        ["admin_password_hash_salt", salt],
        ["admin_password_hash", scryptHash(password, salt)],
      ]) {
        await run(
          db,
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [key, value, now],
        );
      }
    } finally {
      await close(db);
    }
  } else {
    console.warn(
      "Database belum ada, hash password tidak disimpan. Bot akan menyimpannya saat start pertama.",
    );
  }

  console.log(`Password admin baru disimpan di: ${PASSWORD_FILE} (mode 600)`);
  console.log("Buka file itu untuk membaca password, lalu simpan di pengelola password Anda.");
  console.log("Kalau ADMIN_WEB_PASSWORD di .env diisi, nilai env yang dipakai, bukan file ini.");
}

main().catch((err) => {
  console.error("Gagal memutar password admin:", err.message);
  process.exit(1);
});