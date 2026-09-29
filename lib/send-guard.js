"use strict";

// Lapisan pengaman pengiriman keluar.
//
// Kenapa file ini ada: seluruh pengiriman bot lewat dua titik (sendText dan sendPoll).
// Tanpa jeda antar-pesan, kuota global, jendela jam kirim, dan kill-switch, pola kirim
// bot terlihat seperti bulk messaging, dan itu pemicu pembatasan nomor WhatsApp.
// Semua angka bisa diatur lewat env, nilai default di bawah sudah konservatif.
//
// Kontrak: setiap fungsi mengembalikan hasil yang sama seperti panggilan mentah
// sendMessage (objek pesan saat berhasil, null saat gagal atau dilewati) supaya
// pemanggil lama tidak perlu diubah.

const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function intEnv(env, name, fallback) {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function isPermanentSendError(message) {
  return /not registered|invalid wid|invalid jid|no such|blocked|banned|restricted|forbidden|unauthorized|account/i.test(
    String(message || ""),
  );
}

function createSendGuard(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const dataDir = options.dataDir || null;
  const clock = options.clock || (() => Date.now());
  const localNow = options.localNow || null;
  const random = options.random || Math.random;

  const config = {
    minGapMs: intEnv(env, "SEND_MIN_GAP_MS", 3500),
    jitterMs: intEnv(env, "SEND_JITTER_MS", 2500),
    replyMinGapMs: intEnv(env, "REPLY_MIN_GAP_MS", 900),
    replyJitterMs: intEnv(env, "REPLY_JITTER_MS", 1200),
    maxPerMinute: intEnv(env, "SEND_MAX_PER_MINUTE", 12),
    maxPerHour: intEnv(env, "SEND_MAX_PER_HOUR", 180),
    maxPerDay: intEnv(env, "SEND_MAX_PER_DAY", 900),
    maxQueueWaitMs: intEnv(env, "SEND_MAX_QUEUE_WAIT_MS", 15 * 60 * 1000),
    failBreaker: intEnv(env, "SEND_FAIL_BREAKER", 5),
    pauseMs: intEnv(env, "SEND_PAUSE_MS", 60 * 60 * 1000),
    windowStartHour: intEnv(env, "SEND_WINDOW_START_HOUR", 6),
    windowEndHour: intEnv(env, "SEND_WINDOW_END_HOUR", 21),
    windowEndMinute: intEnv(env, "SEND_WINDOW_END_MINUTE", 30),
    warmupDay1Max: intEnv(env, "SEND_WARMUP_DAY1_MAX", 50),
    warmupDay8Max: intEnv(env, "SEND_WARMUP_DAY8_MAX", 150),
    warmupEnabled: !/^(0|false)$/i.test(String(env.SEND_WARMUP_ENABLED || "")),
  };

  const state = {
    ready: false,
    dryRun: false,
    pausedUntil: 0,
    consecutiveFailures: 0,
    chain: Promise.resolve(),
    sentTimestamps: [],
    lastErrorByLabel: new Map(),
    stats: {
      sent: 0,
      failures: 0,
      permanentFailures: 0,
      breakerTrips: 0,
      skippedNotReady: 0,
      skippedPaused: 0,
      skippedWindow: 0,
      skippedQuota: 0,
      simulated: 0,
      lastReason: null,
      lastSentAt: null,
    },
  };

  const sessionStampPath = dataDir
    ? path.join(dataDir, "wa_session_first_seen.txt")
    : null;

  // Nilai batas bisa diubah saat bot berjalan (dari halaman pengaturan admin).
  // Hanya kunci yang dikenal dan angkanya sah yang diterapkan, sisanya diabaikan.
  const RUNTIME_CONFIG_KEYS = [
    "minGapMs",
    "jitterMs",
    "replyMinGapMs",
    "replyJitterMs",
    "maxPerMinute",
    "maxPerHour",
    "maxPerDay",
    "maxQueueWaitMs",
    "failBreaker",
    "pauseMs",
    "windowStartHour",
    "windowEndHour",
    "windowEndMinute",
  ];

  function setRuntimeConfig(partial = {}) {
    const applied = {};
    for (const key of RUNTIME_CONFIG_KEYS) {
      const value = Number(partial[key]);
      if (partial[key] === undefined || !Number.isFinite(value) || value < 0) {
        continue;
      }
      config[key] = value;
      applied[key] = value;
    }
    return applied;
  }

  function setDryRun(value) {
    state.dryRun = Boolean(value);
    logger.warn(
      state.dryRun
        ? "Mode simulasi aktif: pengiriman dicatat, tidak dikirim."
        : "Mode simulasi nonaktif: pengiriman normal.",
    );
  }

  function sessionAgeDays(nowMs) {
    if (!config.warmupEnabled || !sessionStampPath) {
      return Number.POSITIVE_INFINITY;
    }
    try {
      if (!fs.existsSync(sessionStampPath)) {
        fs.mkdirSync(path.dirname(sessionStampPath), { recursive: true });
        fs.writeFileSync(sessionStampPath, new Date(nowMs).toISOString(), "utf8");
        return 0;
      }
      const firstSeen = Date.parse(
        String(fs.readFileSync(sessionStampPath, "utf8")).trim(),
      );
      if (!Number.isFinite(firstSeen)) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.floor((nowMs - firstSeen) / 86400000);
    } catch (err) {
      logger.warn("Send guard: gagal membaca penanda umur sesi:", err.message);
      return Number.POSITIVE_INFINITY;
    }
  }

  // Kuota harian naik bertahap pada 30 hari pertama setelah sesi ditautkan.
  // Nomor/sesi baru yang langsung mengirim ratusan pesan adalah skenario blokir paling umum.
  function dailyCap(nowMs = clock()) {
    const ageDays = sessionAgeDays(nowMs);
    if (ageDays < 7) {
      return Math.min(config.warmupDay1Max, config.maxPerDay);
    }
    if (ageDays < 30) {
      return Math.min(config.warmupDay8Max, config.maxPerDay);
    }
    return config.maxPerDay;
  }

  function pruneLedger(nowMs) {
    if (state.sentTimestamps.length > 2000) {
      state.sentTimestamps = state.sentTimestamps.filter(
        (ts) => nowMs - ts < 86400000,
      );
    }
  }

  function countWithin(ms, nowMs = clock()) {
    return state.sentTimestamps.filter((ts) => nowMs - ts < ms).length;
  }

  function quotaReason(nowMs = clock()) {
    if (countWithin(60000, nowMs) >= config.maxPerMinute) {
      return "quota_menit";
    }
    if (countWithin(3600000, nowMs) >= config.maxPerHour) {
      return "quota_jam";
    }
    if (countWithin(86400000, nowMs) >= dailyCap(nowMs)) {
      return "kuota_harian";
    }
    return null;
  }

  function currentLocal() {
    if (typeof localNow === "function") {
      return localNow();
    }
    const now = new Date();
    return { hour: now.getHours(), minute: now.getMinutes() };
  }

  function isWithinSendWindow() {
    const now = currentLocal();
    if (!now || !Number.isFinite(now.hour)) {
      return true;
    }
    const minutes = now.hour * 60 + (now.minute || 0);
    const start = config.windowStartHour * 60;
    const end = config.windowEndHour * 60 + config.windowEndMinute;
    return minutes >= start && minutes <= end;
  }

  function isPaused() {
    return clock() < state.pausedUntil;
  }

  function setReady(value) {
    state.ready = Boolean(value);
    if (!state.ready) {
      logger.warn("Send guard: client belum siap, pengiriman ditahan.");
    }
  }

  function pause(ms, reason) {
    state.pausedUntil = clock() + ms;
    logger.error(
      `Send guard: pengiriman dijeda ${Math.round(ms / 60000)} menit (${reason}).`,
    );
  }

  function resume() {
    state.pausedUntil = 0;
    state.consecutiveFailures = 0;
  }

  function noteSuccess() {
    state.consecutiveFailures = 0;
    state.stats.sent += 1;
    state.stats.lastSentAt = new Date(clock()).toISOString();
  }

  // Klasifikasi error kirim. Error permanen (nomor tidak ada, diblokir, dsb) tidak
  // boleh diperlakukan sebagai "coba lagi selamanya": itu mengubah kegagalan teknis
  // menjadi pengiriman berulang ke nomor tak valid, yang justru sinyal spam.
  function noteFailure(err, chatId) {
    const message = String((err && err.message) || err || "");
    const permanent = isPermanentSendError(message);
    if (chatId) {
      state.lastErrorByLabel.set(String(chatId), { permanent, message });
      if (state.lastErrorByLabel.size > 500) {
        state.lastErrorByLabel.delete(
          state.lastErrorByLabel.keys().next().value,
        );
      }
    }
    state.stats.failures += 1;
    state.stats.lastReason = permanent ? "error_permanen" : "error_sementara";
    if (permanent) {
      state.stats.permanentFailures += 1;
      state.consecutiveFailures += 1;
      logger.error("Kirim gagal (indikasi permanen) ke", chatId, ":", message);
      if (state.consecutiveFailures >= config.failBreaker) {
        state.stats.breakerTrips += 1;
        state.consecutiveFailures = 0;
        pause(
          config.pauseMs,
          `${config.failBreaker} kegagalan permanen berturut-turut`,
        );
      }
      return { permanent: true, message };
    }
    logger.error("Kirim gagal ke", chatId, ":", message);
    return { permanent: false, message };
  }

  async function acquireSlot(kind) {
    const started = clock();
    for (;;) {
      const nowMs = clock();
      if (isPaused()) {
        return { ok: false, reason: "dijeda" };
      }
      if (kind === "broadcast" && !isWithinSendWindow()) {
        return { ok: false, reason: "di_luar_jam_kirim" };
      }
      const quota = quotaReason(nowMs);
      if (!quota) {
        state.sentTimestamps.push(nowMs);
        pruneLedger(nowMs);
        return { ok: true };
      }
      if (nowMs - started >= config.maxQueueWaitMs) {
        return { ok: false, reason: quota };
      }
      logger.warn(
        `Send guard: ${quota} tercapai, menunggu giliran (${kind}).`,
      );
      await sleep(Math.min(2000, Math.max(1, config.maxQueueWaitMs)));
    }
  }

  function registerSkip(reason) {
    state.stats.lastReason = reason;
    if (reason === "dijeda") {
      state.stats.skippedPaused += 1;
    } else if (reason === "di_luar_jam_kirim") {
      state.stats.skippedWindow += 1;
    } else if (reason === "client_belum_siap") {
      state.stats.skippedNotReady += 1;
    } else {
      state.stats.skippedQuota += 1;
    }
  }

  // Satu pengiriman pada satu waktu, dengan jeda acak. Serialisasi bukan hanya soal
  // risiko ban: beberapa pengiriman paralel pada satu page Puppeteer rawan error
  // intermiten yang lalu dianggap gagal kirim, dan itu menghasilkan duplikat poll.
  function send(fn, sendOptions = {}) {
    const kind = sendOptions.kind === "reply" ? "reply" : "broadcast";
    const run = state.chain.then(async () => {
      if (!state.ready) {
        registerSkip("client_belum_siap");
        return null;
      }
      if (state.dryRun) {
        state.stats.simulated += 1;
        state.stats.lastReason = "simulasi";
        logger.warn(
          `[SIMULASI] ${sendOptions.label || "-"}: ${sendOptions.preview || "[tanpa cuplikan]"}`,
        );
        return null;
      }
      const gapBase = kind === "reply" ? config.replyMinGapMs : config.minGapMs;
      const gapJitter = kind === "reply" ? config.replyJitterMs : config.jitterMs;
      const gap = gapBase + Math.floor(random() * Math.max(1, gapJitter));
      await sleep(gap);

      const slot = await acquireSlot(kind);
      if (!slot.ok) {
        registerSkip(slot.reason);
        return null;
      }

      try {
        const result = await fn();
        if (!result) {
          noteFailure(new Error("hasil kirim kosong"), sendOptions.label);
          return null;
        }
        noteSuccess();
        return result;
      } catch (err) {
        noteFailure(err, sendOptions.label);
        return null;
      }
    });
    // Kegagalan satu pesan tidak boleh memutus rantai antrean berikutnya.
    state.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function waitUntilIdle() {
    await state.chain;
  }

  function stats() {
    const nowMs = clock();
    return {
      ...state.stats,
      ready: state.ready,
      dryRun: state.dryRun,
      paused: isPaused(),
      pausedUntil: state.pausedUntil ? new Date(state.pausedUntil).toISOString() : null,
      withinSendWindow: isWithinSendWindow(),
      queueLength: 0,
      lastMinute: countWithin(60000, nowMs),
      lastHour: countWithin(3600000, nowMs),
      lastDay: countWithin(86400000, nowMs),
      dailyCap: dailyCap(nowMs),
      config: {
        minGapMs: config.minGapMs,
        jitterMs: config.jitterMs,
        maxPerMinute: config.maxPerMinute,
        maxPerHour: config.maxPerHour,
        maxPerDay: config.maxPerDay,
      },
    };
  }

  return {
    send,
    setReady,
    isReady: () => state.ready,
    isPaused,
    pause,
    resume,
    noteFailure,
    noteSuccess,
    isWithinSendWindow,
    setRuntimeConfig,
    setDryRun,
    isDryRun: () => state.dryRun,
    lastErrorFor: (label) =>
      state.lastErrorByLabel.get(String(label)) || null,
    waitUntilIdle,
    stats,
    config,
  };
}

module.exports = { createSendGuard, isPermanentSendError };