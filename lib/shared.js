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
    DISPATCH_GUARD: "te_dispatch_guard_v1",
    PAGE_DRAFT: "te_page_draft_v1",
    RUNS: "te_runs_v1",
    ACTIVE_RUNS: "te_active_runs_v1",
    PREFERENCES: "te_preferences_v1"
  });

  const MESSAGE_TYPES = Object.freeze({
    PING: "TE_PING",
    GET_JOB: "TE_GET_JOB",
    SAVE_JOB: "TE_SAVE_JOB",
    CANCEL_JOB: "TE_CANCEL_JOB",
    GET_STATUS: "TE_GET_STATUS",
    PARSE_FORM_REQUEST: "TE_PARSE_FORM_REQUEST",
    EXECUTE_REQUEST: "TE_EXECUTE_REQUEST",
    EXECUTE_RESULT: "TE_EXECUTE_RESULT",
    EXECUTE_NOW: "TE_EXECUTE_NOW",
    STATUS_UPDATE: "TE_STATUS_UPDATE",
    OPEN_OPTIONS_WITH_PAGE: "TE_OPEN_OPTIONS_WITH_PAGE",
    GET_PAGE_DRAFT: "TE_GET_PAGE_DRAFT",
    CLEAR_PAGE_DRAFT: "TE_CLEAR_PAGE_DRAFT",
    GET_RUNS: "TE_GET_RUNS",
    CLEAR_RUNS: "TE_CLEAR_RUNS",
    GET_PREFERENCES: "TE_GET_PREFERENCES",
    SAVE_PREFERENCES: "TE_SAVE_PREFERENCES"
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
    autoSelectRequiredOptions: true,
    ticketPlans: []
  });

  const DEFAULT_PREFERENCES = Object.freeze({
    clickIntervalMs: DEFAULT_JOB.clickIntervalMs,
    parallelTabCount: DEFAULT_JOB.parallelTabCount,
    requireAgreement: DEFAULT_JOB.requireAgreement,
    autoSelectRequiredOptions: DEFAULT_JOB.autoSelectRequiredOptions,
    selectorOverrides: null
  });

  const ERROR_MESSAGES = Object.freeze({
    E_FORM_TIMEOUT: "チケットフォームが見つかりません。購入ページを開いてから再試行してください。",
    E_TICKET_LIST_TIMEOUT: "フォームは見つかりましたが、券種を読み取れませんでした。ページの読み込み後に再試行してください。",
    E_TICKET_NOT_FOUND: "選択した券種がページ上に見つかりませんでした。もう一度読み取ってください。",
    E_SUBMIT_NOT_APPLIED: "カート投入が反映されませんでした。ページ状態を確認してください。",
    E_REPLACE_CONFIRM_REQUIRED: "別の予約が実行待機中です。切り替える場合は確認してください。",
    E_TICKET_QTY_REQUIRED: "予約するには、1枚以上の数量を設定してください。",
    E_TRIGGER_CONFIRM_REQUIRED: "実行時刻を確認してください。",
    E_INVALID_URL: "https://escape.id/… を指定してください。",
    E_URL_PARAMS_REQUIRED: "日付と時間を指定して、チケットの購入画面を開いてください。（日付選択後のページで予約できます）",
    E_REQUIRED_SELECT_NOT_SELECTED: "必須の選択リストを自動選択できませんでした。ページ上で選択肢を確認してください。",
    E_TRIGGER_PAST: "実行時刻が過去です。時刻を設定し直してください。"
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

  function getJstParts(epoch) {
    const d = new Date(epoch + 9 * 60 * 60 * 1000);
    if (!Number.isFinite(d.getTime())) {
      return null;
    }
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes()
    };
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

  function normalizeUrlForCompare(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""));
      return `${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch (_) {
      return "";
    }
  }

  function isEscapeTicketPageUrl(rawUrl) {
    const normalized = ensureEscapeUrl(rawUrl);
    if (!normalized) {
      return false;
    }
    try {
      const parsed = new URL(normalized);
      const parts = parsed.pathname.split("/").filter(Boolean);
      return parts.length >= 2;
    } catch (_) {
      return false;
    }
  }

  function isReservableTicketUrl(rawUrl) {
    if (!isEscapeTicketPageUrl(rawUrl)) {
      return false;
    }
    try {
      const parsed = new URL(ensureEscapeUrl(rawUrl));
      return Array.from(parsed.searchParams.keys()).length > 0;
    } catch (_) {
      return false;
    }
  }

  function getErrorMessage(code, fallback) {
    const key = String(code || "");
    return ERROR_MESSAGES[key] || fallback || ERROR_MESSAGES.E_FORM_TIMEOUT;
  }

  function formatLocalDatetimeInput(epoch) {
    const parts = getJstParts(epoch);
    if (!parts) {
      return "";
    }
    const pad = (n) => String(n).padStart(2, "0");
    return [
      parts.year,
      "-",
      pad(parts.month),
      "-",
      pad(parts.day),
      "T",
      pad(parts.hour),
      ":",
      pad(parts.minute)
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
    const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/);
    if (!match) {
      return "";
    }
    return `${match[1]}T${match[2]}:${match[3]}:00+09:00`;
  }

  function normalizeJstIsoToMinute(value) {
    const rawValue = String(value || "").trim();
    if (!rawValue) {
      return "";
    }

    const localIso = toJstIsoStringFromDatetimeLocal(rawValue);
    if (localIso) {
      return localIso;
    }

    const epoch = toEpoch(rawValue);
    if (!Number.isFinite(epoch)) {
      return "";
    }
    const localValue = formatLocalDatetimeInput(epoch);
    return localValue ? `${localValue}:00+09:00` : "";
  }

  function ensureHttpsUrl(rawUrl) {
    try {
      const value = String(rawUrl || "").trim();
      if (!value || value.length > 1000) {
        return "";
      }
      const parsed = new URL(value);
      return parsed.protocol === "https:" ? parsed.toString() : "";
    } catch (_) {
      return "";
    }
  }

  function formatJstDateTime(value) {
    const epoch = typeof value === "number" ? value : Date.parse(String(value || ""));
    if (!Number.isFinite(epoch)) {
      return "";
    }
    const parts = getJstParts(epoch);
    if (!parts) {
      return "";
    }
    const minute = String(parts.minute).padStart(2, "0");
    return `${parts.month}月${parts.day}日${parts.hour}時${minute}分`;
  }

  // Phases shared by all three surfaces (popup / content panel / console).
  // The content script reports these STATUS states while a run is firing.
  const FIRING_STATES = new Set([
    STATUS.WARMUP_START,
    STATUS.WAIT_FORM,
    STATUS.PREPARE_TICKETS,
    STATUS.CLICK_SUBMIT,
    STATUS.VERIFY_RESULT
  ]);

  function reservationPhase(state, remainingMs) {
    if (state === STATUS.SUCCESS) {
      return "success";
    }
    if (state === STATUS.FAILED) {
      return "failed";
    }
    if (FIRING_STATES.has(state)) {
      return "firing";
    }
    const hasRemaining = Number.isFinite(remainingMs);
    if (hasRemaining && remainingMs <= 0) {
      return "firing";
    }
    if (state === STATUS.WAIT_TRIGGER || (hasRemaining && remainingMs > 0)) {
      return remainingMs <= 60000 ? "tminus" : "armed";
    }
    return "idle";
  }

  // Single normalized view of the active reservation, shared by every surface so
  // the same job renders identically wherever it is shown (sync core, §3.1).
  function buildReservationView(job, status, now) {
    const nowMs = Number.isFinite(now) ? now : Date.now();
    const statusState = (status && status.state) || STATUS.IDLE;
    const source = job || null;
    const targetUrl = source ? String(source.targetUrl || "") : "";
    const triggerEpoch = source ? toEpoch(source.triggerAtJst) : null;
    const hasReservation = Boolean(source && targetUrl && Number.isFinite(triggerEpoch));
    const remainingMs = Number.isFinite(triggerEpoch) ? triggerEpoch - nowMs : null;
    const phase = hasReservation
      ? reservationPhase(statusState, remainingMs)
      : reservationPhase(statusState, null);
    const ticketSummary = source && Array.isArray(source.ticketPlans)
      ? source.ticketPlans
          .map((plan) => ({
            ticketLabel: String(plan.ticketLabel || ""),
            targetQty: Number.parseInt(plan.targetQty, 10) || 0
          }))
          .filter((plan) => plan.targetQty > 0)
      : [];

    return {
      hasReservation,
      targetUrl,
      eventTitle: source ? String(source.eventTitle || "") : "",
      triggerEpoch: Number.isFinite(triggerEpoch) ? triggerEpoch : null,
      triggerJstText: Number.isFinite(triggerEpoch) ? formatJstDateTime(triggerEpoch) : "",
      remainingMs,
      phase,
      ticketSummary,
      heroImageUrl: source ? ensureHttpsUrl(source.heroImageUrl) : ""
    };
  }

  globalScope.TE_SHARED = Object.freeze({
    STORAGE_KEYS,
    MESSAGE_TYPES,
    STATUS,
    DEFAULT_JOB,
    DEFAULT_PREFERENCES,
    ERROR_MESSAGES,
    nowEpoch,
    sleep,
    normalizeLabel,
    parseRetryIntervals,
    clampInt,
    toEpoch,
    createId,
    ensureEscapeUrl,
    ensureHttpsUrl,
    normalizeUrlForCompare,
    isReservableTicketUrl,
    isEscapeTicketPageUrl,
    getErrorMessage,
    formatLocalDatetimeInput,
    formatJstDateTime,
    toJstIsoStringFromDatetimeLocal,
    normalizeJstIsoToMinute,
    reservationPhase,
    buildReservationView
  });
})(globalThis);
