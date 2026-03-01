(function initSharedScope(globalScope) {
  if (globalScope.TE_SHARED) {
    return;
  }

  const STORAGE_KEYS = Object.freeze({
    JOB: "te_job_v1",
    TIME_OFFSET_MS: "te_time_offset_v1",
    LAST_RUN: "te_last_run_v1",
    LOGS: "te_logs_v1",
    STATUS: "te_status_v1",
    DISPATCH_GUARD: "te_dispatch_guard_v1"
  });

  const MESSAGE_TYPES = Object.freeze({
    PING: "TE_PING",
    GET_JOB: "TE_GET_JOB",
    SAVE_JOB: "TE_SAVE_JOB",
    GET_STATUS: "TE_GET_STATUS",
    PARSE_FORM_REQUEST: "TE_PARSE_FORM_REQUEST",
    EXECUTE_REQUEST: "TE_EXECUTE_REQUEST",
    EXECUTE_RESULT: "TE_EXECUTE_RESULT",
    EXECUTE_NOW: "TE_EXECUTE_NOW",
    STATUS_UPDATE: "TE_STATUS_UPDATE"
  });

  const STATUS = Object.freeze({
    IDLE: "IDLE",
    WARMUP_START: "WARMUP_START",
    WAIT_FORM: "WAIT_FORM",
    PREPARE_TICKETS: "PREPARE_TICKETS",
    WAIT_TRIGGER: "WAIT_TRIGGER",
    CLICK_SUBMIT: "CLICK_SUBMIT",
    VERIFY_RESULT: "VERIFY_RESULT",
    SUCCESS: "SUCCESS",
    FAILED: "FAILED"
  });

  const DEFAULT_JOB = Object.freeze({
    warmupSec: 120,
    retryMax: 3,
    retryIntervalsMs: [200, 400, 800],
    clickIntervalMs: 30,
    parallelTabCount: 1,
    requireAgreement: true,
    ticketPlans: []
  });

  function nowEpoch() {
    return Date.now();
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function normalizeLabel(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function parseRetryIntervals(raw) {
    if (Array.isArray(raw)) {
      const arr = raw.map((x) => Number.parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0);
      return arr.length ? arr : DEFAULT_JOB.retryIntervalsMs.slice();
    }

    const parsed = String(raw || "")
      .split(",")
      .map((x) => Number.parseInt(x.trim(), 10))
      .filter((x) => Number.isFinite(x) && x > 0);
    return parsed.length ? parsed : DEFAULT_JOB.retryIntervalsMs.slice();
  }

  function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
  }

  function toEpoch(dateValue) {
    const epoch = Date.parse(String(dateValue || ""));
    return Number.isFinite(epoch) ? epoch : null;
  }

  function createId(prefix) {
    return [
      prefix || "te",
      Date.now(),
      Math.random().toString(36).slice(2, 8)
    ].join("_");
  }

  function ensureEscapeUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""));
      if (parsed.protocol !== "https:") {
        return null;
      }
      if (parsed.hostname !== "escape.id") {
        return null;
      }
      return parsed.toString();
    } catch (_) {
      return null;
    }
  }

  function formatLocalDatetimeInput(epoch) {
    const d = new Date(epoch);
    if (!Number.isFinite(d.getTime())) {
      return "";
    }
    const pad = (n) => String(n).padStart(2, "0");
    return [
      d.getFullYear(),
      "-",
      pad(d.getMonth() + 1),
      "-",
      pad(d.getDate()),
      "T",
      pad(d.getHours()),
      ":",
      pad(d.getMinutes()),
      ":",
      pad(d.getSeconds())
    ].join("");
  }

  function toJstIsoStringFromDatetimeLocal(localValue) {
    if (!localValue) {
      return "";
    }
    const value = String(localValue).trim();
    if (!value) {
      return "";
    }
    const parts = value.split("T");
    if (parts.length !== 2) {
      return "";
    }
    const timePart = parts[1].length === 5 ? `${parts[1]}:00` : parts[1];
    return `${parts[0]}T${timePart}+09:00`;
  }

  globalScope.TE_SHARED = Object.freeze({
    STORAGE_KEYS,
    MESSAGE_TYPES,
    STATUS,
    DEFAULT_JOB,
    nowEpoch,
    sleep,
    normalizeLabel,
    parseRetryIntervals,
    clampInt,
    toEpoch,
    createId,
    ensureEscapeUrl,
    formatLocalDatetimeInput,
    toJstIsoStringFromDatetimeLocal
  });
})(globalThis);
