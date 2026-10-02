#!/usr/bin/env node
"use strict";

// Backup harian database tanpa menghentikan bot.
// Cara kerja: VACUUM INTO membuat salinan konsisten walau bot sedang menulis, lalu
// hasilnya diuji ulang sebagai database yang benar-benar bisa dibaca (uji restore),
// bukan hanya lolos integrity_check.
// Backup yang tidak pernah diuji restore tidak membuktikan apa pun, jadi uji itu
// dijalankan setiap kali skrip ini jalan.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sqlite3 = require("sqlite3").verbose();

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "remindcare.db");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, "backups");
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 14);
// Salinan di luar VPS: isi salah satu. Direktori (mis. mount S3/rclone) lebih aman
// karena tidak menjalankan perintah shell apa pun.
const OFFSITE_DIR = String(process.env.BACKUP_OFFSITE_DIR || "").trim();
const REMOTE_CMD = String(process.env.BACKUP_REMOTE_CMD || "").trim();
const TABLES_TO_VERIFY = ["users", "settings", "reminder_logs", "allowed_numbers"];

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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
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

// Uji restore: buka salinan sebagai database, pastikan tabel inti ada dan datanya
// terbaca. Gagal di sini berarti berkas backup tidak layak dipakai memulihkan.
async function verifyRestore(target) {
  const db = new sqlite3.Database(target);
  const result = { integrity: "unknown", tables: {}, users: 0, latestUser: null };
  try {
    const row = await get(db, "PRAGMA integrity_check");
    result.integrity = row ? Object.values(row)[0] : "unknown";
    const found = await all(db, "SELECT name FROM sqlite_master WHERE type = 'table'");
    const names = found.map((item) => item.name);
    for (const table of TABLES_TO_VERIFY) {
      if (!names.includes(table)) {
        throw new Error(`tabel ${table} tidak ada di salinan backup`);
      }
      const counted = await get(db, `SELECT COUNT(*) AS c FROM ${table}`);
      result.tables[table] = counted ? counted.c : 0;
    }
    const users = await get(db, "SELECT COUNT(*) AS c FROM users");
    result.users = users ? users.c : 0;
    const latest = await get(db, "SELECT wa_id FROM users ORDER BY created_at DESC LIMIT 1");
    result.latestUser = latest ? latest.wa_id : null;
  } finally {
    await close(db);
  }
  return result;
}

function copyOffsite(target) {
  if (!OFFSITE_DIR) {
    return "tidak ada tujuan luar VPS";
  }
  fs.mkdirSync(OFFSITE_DIR, { recursive: true });
  const dest = path.join(OFFSITE_DIR, path.basename(target));
  fs.copyFileSync(target, dest);
  const srcSize = fs.statSync(target).size;
  const destSize = fs.statSync(dest).size;
  if (srcSize !== destSize) {
    throw new Error(`ukuran salinan luar VPS berbeda (${srcSize} vs ${destSize})`);
  }
  return `salinan luar VPS: ${dest}`;
}

function runRemoteCommand(target) {
  if (!REMOTE_CMD) {
    return null;
  }
  // Perintah operator sendiri, dengan %f diganti path berkas backup.
  execFileSync("sh", ["-c", REMOTE_CMD.replace(/%f/g, target)], { stdio: "inherit" });
  return "perintah luar VPS dijalankan";
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

  let verified;
  try {
    verified = await verifyRestore(target);
  } catch (err) {
    fs.unlinkSync(target);
    console.error(`Backup gagal diuji restore: ${err.message}. File dihapus.`);
    process.exit(1);
  }

  if (verified.integrity !== "ok") {
    fs.unlinkSync(target);
    console.error(`Backup gagal, integrity_check = ${verified.integrity}. File dihapus.`);
    process.exit(1);
  }

  fs.chmodSync(target, 0o600);
  const size = fs.statSync(target).size;
  const removed = rotate(KEEP_DAYS);
  console.log(
    `Backup ok: ${target} (${Math.round(size / 1024)} KB, ${verified.users} user, integrity ${verified.integrity})`,
  );
  console.log(
    `Uji restore ok: ${Object.entries(verified.tables)
      .map(([table, count]) => `${table} ${count}`)
      .join(", ")}${verified.latestUser ? `, user terbaru ${verified.latestUser}` : ""}`,
  );
  if (removed.length) {
    console.log(`Backup lama dihapus: ${removed.join(", ")}`);
  }

  const copyNote = copyOffsite(target);
  const remoteNote = runRemoteCommand(target);
  if (copyNote) {
    console.log(copyNote);
  }
  if (remoteNote) {
    console.log(remoteNote);
  }
  if (!OFFSITE_DIR && !REMOTE_CMD) {
    console.warn(
      "PERINGATAN: backup hanya tersimpan di VPS ini. Isi BACKUP_OFFSITE_DIR atau BACKUP_REMOTE_CMD supaya kehilangan VPS tidak berarti kehilangan semua backup.",
    );
  }
}

main().catch((err) => {
  console.error("Backup gagal:", err.message);
  process.exit(1);
});
