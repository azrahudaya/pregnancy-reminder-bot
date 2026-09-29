#!/usr/bin/env node
"use strict";

// Backup harian database tanpa menghentikan bot.
// Alasan: satu-satunya salinan data user ada di data/remindcare.db, dan backup lama
// (data backup/) sudah dikarantina. Tanpa ini, satu file rusak berarti data 73 user hilang.
// Cara kerja: VACUUM INTO membuat salinan konsisten walau bot sedang menulis, lalu hasilnya
// diperiksa dengan PRAGMA integrity_check sebelum diakui sah.

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "remindcare.db");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, "backups");
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 14);

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

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

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

function rotate(keepDays) {
  if (!fs.existsSync(BACKUP_DIR)) {
    return [];
  }
  const cutoff = Date.now() - keepDays * 86400000;
  const removed = [];
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!name.startsWith("remindcare-") || !name.endsWith(".db")) {
      continue;
    }
    const full = path.join(BACKUP_DIR, name);
    const stat = fs.statSync(full);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(full);
      removed.push(name);
    }
  }
  return removed;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database tidak ditemukan: ${DB_PATH}`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });

  const target = path.join(BACKUP_DIR, `remindcare-${stamp()}.db`);
  if (fs.existsSync(target)) {
    console.log(`Backup hari ini sudah ada: ${target}`);
    return;
  }

  const db = new sqlite3.Database(DB_PATH);
  db.configure("busyTimeout", 5000);
  try {
    await run(db, `VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    await close(db);
  }

  const check = new sqlite3.Database(target);
  let integrity = "unknown";
  let users = 0;
  try {
    const row = await get(check, "PRAGMA integrity_check");
    integrity = row ? Object.values(row)[0] : "unknown";
    const counted = await get(check, "SELECT COUNT(*) AS c FROM users");
    users = counted ? counted.c : 0;
  } finally {
    await close(check);
  }

  if (integrity !== "ok") {
    fs.unlinkSync(target);
    console.error(`Backup gagal, integrity_check = ${integrity}. File dihapus.`);
    process.exit(1);
  }

  fs.chmodSync(target, 0o600);
  const size = fs.statSync(target).size;
  const removed = rotate(KEEP_DAYS);
  console.log(
    `Backup ok: ${target} (${Math.round(size / 1024)} KB, ${users} user, integrity ${integrity})`,
  );
  if (removed.length) {
    console.log(`Backup lama dihapus: ${removed.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("Backup gagal:", err.message);
  process.exit(1);
});