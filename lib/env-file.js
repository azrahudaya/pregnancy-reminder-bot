"use strict";

// Pemuat .env sederhana tanpa dependency tambahan.
// Alasan: konfigurasi bot ini hidup di file .env, tapi repo tidak punya pemuatnya sama sekali,
// sehingga nilai yang lupa di-export membuat bot memakai default tanpa ada yang sadar.
// Aturan: tidak menimpa env yang sudah ada (env dari shell/systemd tetap menang).

const fs = require("fs");

function parseEnvContent(content) {
  const result = {};
  const lines = String(content).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key) {
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function loadEnvFile(filePath, env = process.env, readFile = fs.readFileSync) {
  let content;
  try {
    content = readFile(filePath, "utf8");
  } catch (err) {
    return { loaded: 0, found: false };
  }
  const parsed = parseEnvContent(content);
  let loaded = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
      loaded += 1;
    }
  }
  return { loaded, found: true };
}

module.exports = { loadEnvFile, parseEnvContent };