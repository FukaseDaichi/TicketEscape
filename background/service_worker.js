importScripts("../lib/shared.js");

(function serviceWorkerMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const {
    STORAGE_KEYS,
    MESSAGE_TYPES,
    STATUS,
    DEFAULT_JOB,
    DEFAULT_PREFERENCES,
    ensureEscapeUrl,
    ensureHttpsUrl,
    isEscapeTicketPageUrl,
    getErrorMessage,
    toEpoch,
    createId,
    clampInt
  } = shared;

  const LOG_LIMIT = 300;
  const ALARM_WARMUP_PREFIX = "te_warmup_";
  const ALARM_TRIGGER_PREFIX = "te_trigger_";
  const TAB_LOAD_TIMEOUT_MS = 45000;
  const TAB_MESSAGE_RETRIES = 160;
  const TAB_MESSAGE_INTERVAL_MS = 250;
  const RUN_HISTORY_LIMIT = 50;

  chrome.runtime.onInstalled.addListener(() => {
    void setStatus({
      state: STATUS.IDLE,
      updatedAt: Date.now()
    });
    void ensurePreferences();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    void handleAlarm(alarm).catch(async (error) => {
      await appendLog("ALARM_ERROR", error.message || "Alarm handling failed.");
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    void handleMessage(message, sender)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Unhandled service worker error.",
          code: error.code || ""
        });
      });
    return true;
  });

  async function handleMessage(message, sender) {
    switch (message.type) {
      case MESSAGE_TYPES.GET_JOB:
        return handleGetJob();
      case MESSAGE_TYPES.SAVE_JOB:
        return handleSaveJob(message.job, message);
      case MESSAGE_TYPES.CANCEL_JOB:
        return handleCancelJob(message);
      case MESSAGE_TYPES.GET_STATUS:
        return handleGetStatus();
      case MESSAGE_TYPES.PARSE_FORM_REQUEST:
        return handleParseForm(message.url, message.selectorOverrides || {});
      case MESSAGE_TYPES.EXECUTE_NOW:
        return handleExecuteNow();
      case MESSAGE_TYPES.STATUS_UPDATE:
        return handleStatusUpdate(message);
      case MESSAGE_TYPES.EXECUTE_RESULT:
        return handleExecuteResult(message.result);
      case MESSAGE_TYPES.OPEN_OPTIONS_WITH_PAGE:
        return handleOpenOptionsWithPage(message, sender);
      case MESSAGE_TYPES.GET_PAGE_DRAFT:
        return handleGetPageDraft();
      case MESSAGE_TYPES.CLEAR_PAGE_DRAFT:
        return handleClearPageDraft();
      case MESSAGE_TYPES.GET_RUNS:
        return handleGetRuns();
      case MESSAGE_TYPES.CLEAR_RUNS:
        return handleClearRuns();
      case MESSAGE_TYPES.GET_PREFERENCES:
        return handleGetPreferences();
      case MESSAGE_TYPES.SAVE_PREFERENCES:
        return handleSavePreferences(message.preferences);
      case MESSAGE_TYPES.PING:
        return { pong: true, at: Date.now() };
      default:
        throw new Error(`Unsupported message type: ${message.type}`);
    }
  }

  async function handleGetJob() {
    const job = await getStorageValue(STORAGE_KEYS.JOB, null);
    return { job };
  }

  async function handleSaveJob(inputJob, saveOptions) {
    const options = saveOptions || {};
    const existingJob = await getStorageValue(STORAGE_KEYS.JOB, null);
    const sanitized = sanitizeJob(inputJob || {});
    enforceTriggerConfirmation(inputJob || {}, existingJob, sanitized);
    enforceReplaceConfirmation(existingJob, sanitized, options);

    await scheduleJobAlarms(sanitized);
    await setStorageValue(STORAGE_KEYS.JOB, sanitized);
    await mergeAndSavePreferencesFromJob(sanitized);
    await setStorageValue(STORAGE_KEYS.PAGE_DRAFT, null);
    await appendLog("SAVE_JOB", "Job saved and alarms scheduled.", {
      jobId: sanitized.jobId,
      triggerAtJst: sanitized.triggerAtJst
    });
    await setStatus({
      state: STATUS.WAIT_TRIGGER,
      jobId: sanitized.jobId,
      triggerAtJst: sanitized.triggerAtJst,
      updatedAt: Date.now()
    });
    return { job: sanitized };
  }

  async function handleCancelJob(message) {
    const existingJob = await getStorageValue(STORAGE_KEYS.JOB, null);
    if (!existingJob) {
      await clearTicketEscapeAlarms();
      await setStatus({ state: STATUS.IDLE, updatedAt: Date.now() });
      return { canceled: false, reason: "no-job" };
    }

    if (
      message &&
      message.expectedJobId &&
      String(message.expectedJobId) !== String(existingJob.jobId || "")
    ) {
      throw makeCodedError("E_REPLACE_CONFIRM_REQUIRED", "Job changed before cancel.");
    }

    await clearTicketEscapeAlarms();
    await setStorageValue(STORAGE_KEYS.JOB, null);
    await setStorageValue(STORAGE_KEYS.DISPATCH_GUARD, null);
    await setStatus({
      state: STATUS.IDLE,
      jobId: null,
      detail: "canceled",
      updatedAt: Date.now()
    });
    await appendLog("CANCEL_JOB", "Reservation canceled.", {
      jobId: existingJob.jobId,
      targetUrl: existingJob.targetUrl
    });

    return { canceled: true, jobId: existingJob.jobId };
  }

  async function handleGetStatus() {
    const [job, lastRun, status, alarms, preferences] = await Promise.all([
      getStorageValue(STORAGE_KEYS.JOB, null),
      getStorageValue(STORAGE_KEYS.LAST_RUN, null),
      getStorageValue(STORAGE_KEYS.STATUS, { state: STATUS.IDLE, updatedAt: Date.now() }),
      getTicketEscapeAlarms(),
      getPreferences()
    ]);

    return {
      job,
      lastRun,
      status,
      alarms,
      preferences
    };
  }

  async function handleParseForm(url, selectorOverrides) {
    const targetUrl = ensureEscapeUrl(url);
    if (!targetUrl) {
      throw new Error("URL must be https://escape.id/*");
    }
    if (!isEscapeTicketPageUrl(targetUrl)) {
      throw makeCodedError("E_URL_PARAMS_REQUIRED", "URL parameters are required.");
    }

    const tab = await createTargetTab(targetUrl, true);
    await waitForTabCompleteBestEffort(tab.id, TAB_LOAD_TIMEOUT_MS);
    const parseResult = await sendMessageToTabWithRetry(
      tab.id,
      {
        type: MESSAGE_TYPES.PARSE_FORM_REQUEST,
        timeoutMs: TAB_LOAD_TIMEOUT_MS,
        selectorOverrides
      },
      TAB_MESSAGE_RETRIES,
      TAB_MESSAGE_INTERVAL_MS
    );

    await appendLog("PARSE_FORM", "Form parsed successfully.", {
      tabId: tab.id,
      ticketCount: (parseResult && parseResult.tickets && parseResult.tickets.length) || 0
    });
    return {
      tabId: tab.id,
      parseResult
    };
  }

  async function handleExecuteNow() {
    const job = await getStorageValue(STORAGE_KEYS.JOB, null);
    if (!job) {
      throw new Error("No saved job found.");
    }
    const dispatched = await dispatchExecution(job, {
      forceImmediate: true,
      reason: "manual"
    });
    return { dispatched };
  }

  async function handleStatusUpdate(message) {
    const statusPayload = {
      state: message.status || STATUS.IDLE,
      jobId: message.jobId || null,
      runId: message.runId || null,
      detail: message.detail || "",
      updatedAt: Date.now()
    };
    await setStatus(statusPayload);
    await appendLog("STATUS", "Status update", {
      state: statusPayload.state,
      detail: statusPayload.detail,
      runId: statusPayload.runId
    });
    return { accepted: true };
  }

  async function handleExecuteResult(result) {
    if (!result) {
      throw new Error("Missing execute result payload.");
    }

    await setStorageValue(STORAGE_KEYS.LAST_RUN, result);
    const snapshot = await consumeActiveRun(result.runId);
    await appendRunRecord(result, snapshot);
    await setStatus({
      state: result.status || STATUS.FAILED,
      jobId: result.jobId || null,
      runId: result.runId || null,
      detail: result.errorCode || "",
      updatedAt: Date.now()
    });
    await appendLog("RUN_RESULT", `Execution finished: ${result.status}`, {
      runId: result.runId,
      errorCode: result.errorCode || ""
    });

    return { stored: true };
  }

  async function handleOpenOptionsWithPage(message, sender) {
    const page = message.page || {};
    const senderTab = (sender && sender.tab) || {};
    const pageUrl = ensureEscapeUrl(page.url || message.url || senderTab.url);
    // From a non-reservable page (e.g. the launcher badge on the escape.id top
    // page) just open the console without a draft so "詳細コンソールで開く"
    // works everywhere (§6 LAUNCHER, §9).
    if (!pageUrl || !isEscapeTicketPageUrl(pageUrl)) {
      const plainTab = await openOptionsPage();
      return { draft: null, tabId: plainTab && plainTab.id };
    }

    const draft = {
      url: pageUrl,
      normalizedUrl: normalizeUrlForCompare(pageUrl),
      tabId: Number.isFinite(page.tabId)
        ? page.tabId
        : (Number.isFinite(message.tabId)
            ? message.tabId
            : (Number.isFinite(senderTab.id) ? senderTab.id : null)),
      title: String(page.title || message.title || "").slice(0, 200),
      eventTitle: String(page.eventTitle || "").slice(0, 200),
      detectedAt: Date.now(),
      source: String(page.source || "content-launcher")
    };

    await setStorageValue(STORAGE_KEYS.PAGE_DRAFT, draft);
    const tab = await openOptionsPage();
    return { draft, tabId: tab && tab.id };
  }

  async function handleGetPageDraft() {
    const draft = await getStorageValue(STORAGE_KEYS.PAGE_DRAFT, null);
    return { draft };
  }

  async function handleClearPageDraft() {
    await setStorageValue(STORAGE_KEYS.PAGE_DRAFT, null);
    return { cleared: true };
  }

  async function handleGetRuns() {
    const runs = await getStorageValue(STORAGE_KEYS.RUNS, []);
    return { runs: Array.isArray(runs) ? runs : [] };
  }

  async function handleClearRuns() {
    await setStorageValue(STORAGE_KEYS.RUNS, []);
    return { cleared: true };
  }

  async function handleGetPreferences() {
    const preferences = await getPreferences();
    return { preferences };
  }

  async function handleSavePreferences(input) {
    const preferences = sanitizePreferences(input);
    await setStorageValue(STORAGE_KEYS.PREFERENCES, preferences);
    await appendLog("SAVE_PREFERENCES", "Preferences saved.", preferences);
    return { preferences };
  }

  async function handleAlarm(alarm) {
    if (!alarm || !alarm.name) {
      return;
    }

    const job = await getStorageValue(STORAGE_KEYS.JOB, null);
    if (!job) {
      return;
    }

    if (alarm.name === `${ALARM_WARMUP_PREFIX}${job.jobId}`) {
      // Compatibility path for old alarms created by previous versions.
      return;
    }

    if (alarm.name === `${ALARM_TRIGGER_PREFIX}${job.jobId}`) {
      await dispatchExecution(job, { forceImmediate: true, reason: "trigger" });
    }
  }

  function sanitizeJob(input) {
    const targetUrl = ensureEscapeUrl(input.targetUrl);
    if (!targetUrl) {
      throw makeCodedError("E_INVALID_URL", "Invalid targetUrl. Use https://escape.id/*");
    }
    if (!isEscapeTicketPageUrl(targetUrl)) {
      throw makeCodedError("E_URL_PARAMS_REQUIRED", "URL parameters are required.");
    }

    const triggerEpoch = toEpoch(input.triggerAtJst);
    if (!Number.isFinite(triggerEpoch)) {
      throw makeCodedError("E_TRIGGER_CONFIRM_REQUIRED", "Invalid trigger time.");
    }

    const ticketPlans = Array.isArray(input.ticketPlans)
      ? input.ticketPlans
          .map((plan) => ({
            ticketLabel: String(plan.ticketLabel || "").trim(),
            targetQty: clampInt(plan.targetQty, 0, 0, 99)
          }))
          .filter((plan) => plan.ticketLabel)
      : [];

    if (!ticketPlans.some((plan) => plan.targetQty > 0)) {
      throw makeCodedError("E_TICKET_QTY_REQUIRED", "At least one ticket quantity is required.");
    }

    const selectorOverrides = sanitizeSelectorOverrides(input.selectorOverrides);
    const heroImageUrl = ensureHttpsUrl(input.heroImageUrl);

    return {
      jobId: String(input.jobId || createId("job")),
      targetUrl,
      triggerAtJst: input.triggerAtJst,
      eventTitle: String(input.eventTitle || "").trim().slice(0, 200),
      clickIntervalMs: clampInt(input.clickIntervalMs, DEFAULT_JOB.clickIntervalMs, 5, 500),
      parallelTabCount: clampInt(input.parallelTabCount, DEFAULT_JOB.parallelTabCount, 1, 5),
      requireAgreement: input.requireAgreement !== false,
      ticketPlans,
      ...(heroImageUrl ? { heroImageUrl } : {}),
      ...(selectorOverrides ? { selectorOverrides } : {})
    };
  }

  function sanitizeSelectorOverrides(input) {
    if (!input || typeof input !== "object") {
      return null;
    }

    const next = {};
    if (input.formRoot) {
      next.formRoot = String(input.formRoot).trim();
    }
    if (input.submitButton) {
      next.submitButton = String(input.submitButton).trim();
    }
    return Object.keys(next).length ? next : null;
  }

  async function scheduleJobAlarms(job) {
    const triggerEpoch = toEpoch(job.triggerAtJst);
    if (!Number.isFinite(triggerEpoch)) {
      throw makeCodedError("E_TRIGGER_CONFIRM_REQUIRED", "Cannot schedule: invalid trigger time.");
    }

    const now = Date.now();
    if (triggerEpoch <= now) {
      throw makeCodedError("E_TRIGGER_PAST", "Cannot schedule: trigger time is in the past.");
    }

    await clearTicketEscapeAlarms();
    chrome.alarms.create(`${ALARM_TRIGGER_PREFIX}${job.jobId}`, { when: triggerEpoch });
  }

  async function dispatchExecution(job, options) {
    const opts = options || {};
    if (!isEscapeTicketPageUrl(job && job.targetUrl)) {
      throw makeCodedError("E_URL_PARAMS_REQUIRED", "URL parameters are required.");
    }
    const guardOk = await canDispatch(job, opts.reason || "scheduled");
    if (!guardOk) {
      return { skipped: true, reason: "duplicate-guard" };
    }

    const triggerEpochFromJob = toEpoch(job.triggerAtJst);
    const triggerEpoch = opts.forceImmediate ? Date.now() + 80 : triggerEpochFromJob;
    if (!Number.isFinite(triggerEpoch)) {
      throw new Error("Invalid trigger timestamp.");
    }
    const parallelTabCount = clampInt(job.parallelTabCount, DEFAULT_JOB.parallelTabCount, 1, 5);

    await setStatus({
      state: STATUS.WARMUP_START,
      jobId: job.jobId,
      detail: opts.reason || "dispatch",
      updatedAt: Date.now()
    });

    const tabs = await resolveExecutionTabs(job.targetUrl, parallelTabCount);
    await Promise.all(tabs.map((tab) => waitForTabCompleteBestEffort(tab.id, TAB_LOAD_TIMEOUT_MS)));

    const dispatchTargets = tabs.map((tab) => ({
      tab,
      runId: createId("run")
    }));
    await storeActiveRuns(dispatchTargets, job, triggerEpoch);

    const dispatchResults = await Promise.all(
      dispatchTargets.map(async ({ tab, runId }) => {
        try {
          const dispatchResponse = await sendMessageToTabWithRetry(
            tab.id,
            {
              type: MESSAGE_TYPES.EXECUTE_REQUEST,
              runId,
              triggerEpoch,
              job
            },
            TAB_MESSAGE_RETRIES,
            TAB_MESSAGE_INTERVAL_MS
          );

          if (!dispatchResponse || !dispatchResponse.ok) {
            return {
              ok: false,
              runId,
              tabId: tab.id,
              error: (dispatchResponse && dispatchResponse.error) || "Execution dispatch rejected."
            };
          }

          return {
            ok: true,
            tabId: tab.id,
            runId
          };
        } catch (error) {
          return {
            ok: false,
            runId,
            tabId: tab.id,
            error: error && error.message ? error.message : "Execution dispatch failed."
          };
        }
      })
    );

    const successDispatches = dispatchResults.filter((result) => result.ok);
    const failedDispatches = dispatchResults.filter((result) => !result.ok);
    if (failedDispatches.length) {
      await removeActiveRuns(failedDispatches.map((result) => result.runId));
    }
    if (!successDispatches.length) {
      const firstFailure = failedDispatches[0];
      throw new Error(
        (firstFailure && firstFailure.error) || "Execution dispatch rejected on all tabs."
      );
    }

    if (failedDispatches.length > 0) {
      await appendLog("DISPATCH_PARTIAL_FAIL", "Some tabs rejected execution dispatch.", {
        jobId: job.jobId,
        reason: opts.reason || "scheduled",
        failedTabIds: failedDispatches.map((item) => item.tabId),
        failedCount: failedDispatches.length
      });
    }

    await setStatus({
      state: STATUS.WAIT_TRIGGER,
      jobId: job.jobId,
      runId: successDispatches[0].runId,
      detail: `${opts.reason || "scheduled"} tabs=${successDispatches.length}/${tabs.length}`,
      updatedAt: Date.now()
    });
    await appendLog("DISPATCH", "Execution dispatched to content script.", {
      jobId: job.jobId,
      runIds: successDispatches.map((item) => item.runId),
      triggerEpoch,
      tabIds: successDispatches.map((item) => item.tabId),
      requestedTabCount: parallelTabCount,
      dispatchedCount: successDispatches.length,
      reason: opts.reason || "scheduled"
    });

    return {
      runId: successDispatches[0].runId,
      tabId: successDispatches[0].tabId,
      runIds: successDispatches.map((item) => item.runId),
      tabIds: successDispatches.map((item) => item.tabId),
      requestedTabCount: parallelTabCount,
      dispatchedCount: successDispatches.length,
      triggerEpoch
    };
  }

  async function canDispatch(job, reason) {
    const guard = await getStorageValue(STORAGE_KEYS.DISPATCH_GUARD, null);
    const now = Date.now();

    if (reason === "manual") {
      if (guard && guard.jobId === job.jobId && now - guard.at < 2000) {
        return false;
      }
    } else if (guard && guard.jobId === job.jobId && guard.triggerAtJst === job.triggerAtJst) {
      return false;
    }

    await setStorageValue(STORAGE_KEYS.DISPATCH_GUARD, {
      jobId: job.jobId,
      triggerAtJst: job.triggerAtJst,
      at: now,
      reason
    });
    return true;
  }

  function makeCodedError(code, fallbackMessage) {
    const error = new Error(getErrorMessage(code, fallbackMessage));
    error.code = code;
    return error;
  }

  function enforceTriggerConfirmation(inputJob, existingJob, sanitizedJob) {
    const sameJob = existingJob && existingJob.jobId === sanitizedJob.jobId;
    const sameUrl =
      existingJob &&
      normalizeUrlForCompare(existingJob.targetUrl) === normalizeUrlForCompare(sanitizedJob.targetUrl);

    if ((sameJob || sameUrl) && inputJob.triggerAtConfirmed !== false) {
      return;
    }

    if (inputJob.triggerAtConfirmed === true) {
      return;
    }

    throw makeCodedError("E_TRIGGER_CONFIRM_REQUIRED", "Trigger time must be confirmed.");
  }

  function enforceReplaceConfirmation(existingJob, sanitizedJob, options) {
    if (!existingJob) {
      return;
    }

    const existingUrl = normalizeUrlForCompare(existingJob.targetUrl);
    const nextUrl = normalizeUrlForCompare(sanitizedJob.targetUrl);
    const sameJob = existingJob.jobId === sanitizedJob.jobId;
    const sameUrl = existingUrl && nextUrl && existingUrl === nextUrl;
    if (sameJob || sameUrl) {
      return;
    }

    const confirmed =
      options.replaceConfirmed === true &&
      String(options.expectedPreviousJobId || "") === String(existingJob.jobId || "");
    if (confirmed) {
      return;
    }

    throw makeCodedError("E_REPLACE_CONFIRM_REQUIRED", "Replacing the existing job requires confirmation.");
  }

  async function ensurePreferences() {
    const stored = await getStorageValue(STORAGE_KEYS.PREFERENCES, null);
    if (!stored) {
      await setStorageValue(STORAGE_KEYS.PREFERENCES, { ...DEFAULT_PREFERENCES });
    }
  }

  async function getPreferences() {
    const stored = await getStorageValue(STORAGE_KEYS.PREFERENCES, null);
    return sanitizePreferences(stored || DEFAULT_PREFERENCES);
  }

  function sanitizePreferences(input) {
    const source = input && typeof input === "object" ? input : {};
    const selectorOverrides = sanitizeSelectorOverrides(source.selectorOverrides);
    return {
      clickIntervalMs: clampInt(
        source.clickIntervalMs,
        DEFAULT_PREFERENCES.clickIntervalMs,
        5,
        500
      ),
      parallelTabCount: clampInt(
        source.parallelTabCount,
        DEFAULT_PREFERENCES.parallelTabCount,
        1,
        5
      ),
      requireAgreement: source.requireAgreement !== false,
      selectorOverrides
    };
  }

  async function mergeAndSavePreferencesFromJob(job) {
    const current = await getPreferences();
    const next = sanitizePreferences({
      ...current,
      clickIntervalMs: job.clickIntervalMs,
      parallelTabCount: job.parallelTabCount,
      requireAgreement: job.requireAgreement,
      selectorOverrides: job.selectorOverrides || current.selectorOverrides || null
    });
    await setStorageValue(STORAGE_KEYS.PREFERENCES, next);
    return next;
  }

  async function storeActiveRuns(targets, job, triggerEpoch) {
    const activeRuns = await getStorageValue(STORAGE_KEYS.ACTIVE_RUNS, {});
    const next = activeRuns && typeof activeRuns === "object" ? { ...activeRuns } : {};
    for (const target of targets) {
      next[target.runId] = {
        jobSnapshot: cloneJson(job),
        triggerEpoch,
        dispatchedAt: Date.now(),
        tabId: target.tab && target.tab.id
      };
    }
    await setStorageValue(STORAGE_KEYS.ACTIVE_RUNS, next);
  }

  async function consumeActiveRun(runId) {
    if (!runId) {
      return null;
    }
    const activeRuns = await getStorageValue(STORAGE_KEYS.ACTIVE_RUNS, {});
    if (!activeRuns || typeof activeRuns !== "object" || !activeRuns[runId]) {
      return null;
    }
    const snapshot = activeRuns[runId];
    const next = { ...activeRuns };
    delete next[runId];
    await setStorageValue(STORAGE_KEYS.ACTIVE_RUNS, next);
    return snapshot;
  }

  async function removeActiveRun(runId) {
    if (!runId) {
      return;
    }
    const activeRuns = await getStorageValue(STORAGE_KEYS.ACTIVE_RUNS, {});
    if (!activeRuns || typeof activeRuns !== "object" || !activeRuns[runId]) {
      return;
    }
    const next = { ...activeRuns };
    delete next[runId];
    await setStorageValue(STORAGE_KEYS.ACTIVE_RUNS, next);
  }

  async function removeActiveRuns(runIds) {
    const ids = Array.isArray(runIds) ? runIds.filter(Boolean) : [];
    if (!ids.length) {
      return;
    }
    const activeRuns = await getStorageValue(STORAGE_KEYS.ACTIVE_RUNS, {});
    if (!activeRuns || typeof activeRuns !== "object") {
      return;
    }
    const next = { ...activeRuns };
    for (const runId of ids) {
      delete next[runId];
    }
    await setStorageValue(STORAGE_KEYS.ACTIVE_RUNS, next);
  }

  async function appendRunRecord(result, activeSnapshot) {
    const runs = await getStorageValue(STORAGE_KEYS.RUNS, []);
    const next = Array.isArray(runs) ? runs.slice() : [];
    const jobSnapshot = activeSnapshot && activeSnapshot.jobSnapshot ? activeSnapshot.jobSnapshot : null;
    const record = toRunRecord(result, jobSnapshot, activeSnapshot);
    next.unshift(record);
    while (next.length > RUN_HISTORY_LIMIT) {
      next.pop();
    }
    await setStorageValue(STORAGE_KEYS.RUNS, next);
  }

  function toRunRecord(result, jobSnapshot, activeSnapshot) {
    const job = jobSnapshot || {};
    return {
      runId: String(result.runId || ""),
      jobId: String(result.jobId || job.jobId || ""),
      eventTitle: String(job.eventTitle || ""),
      targetUrl: String(job.targetUrl || result.pageUrl || ""),
      heroImageUrl: ensureHttpsUrl(job.heroImageUrl),
      ticketPlans: Array.isArray(job.ticketPlans) ? cloneJson(job.ticketPlans) : [],
      triggerAtJst: String(job.triggerAtJst || ""),
      status: result.status || STATUS.FAILED,
      errorCode: result.errorCode || null,
      errorDetail: result.errorDetail || null,
      steps: Array.isArray(result.steps) ? cloneJson(result.steps) : [],
      startedAt: result.startedAt || (activeSnapshot && activeSnapshot.dispatchedAt) || null,
      finishedAt: result.finishedAt || Date.now(),
      pageUrl: String(result.pageUrl || ""),
      tabId: activeSnapshot && Number.isFinite(activeSnapshot.tabId) ? activeSnapshot.tabId : null
    };
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value || null));
  }

  async function openOptionsPage() {
    const optionsUrl = chrome.runtime.getURL("options/options.html");
    const existing = await tabQuery({ url: optionsUrl });
    if (existing && existing.length) {
      const tab = existing[0];
      const updated = await tabUpdate(tab.id, { active: true });
      if (typeof tab.windowId === "number") {
        await windowUpdate(tab.windowId, { focused: true });
      }
      return updated || tab;
    }
    return tabCreate({ url: optionsUrl, active: true });
  }

  async function appendLog(phase, message, meta) {
    const logs = await getStorageValue(STORAGE_KEYS.LOGS, []);
    const next = Array.isArray(logs) ? logs.slice() : [];
    next.push({
      at: Date.now(),
      phase,
      message,
      meta: meta || {}
    });
    while (next.length > LOG_LIMIT) {
      next.shift();
    }
    await setStorageValue(STORAGE_KEYS.LOGS, next);
  }

  async function setStatus(statusPayload) {
    await setStorageValue(STORAGE_KEYS.STATUS, statusPayload);
  }

  async function getTicketEscapeAlarms() {
    const alarms = await alarmsGetAll();
    return alarms.filter(
      (alarm) =>
        alarm.name.startsWith(ALARM_WARMUP_PREFIX) || alarm.name.startsWith(ALARM_TRIGGER_PREFIX)
    );
  }

  async function clearTicketEscapeAlarms() {
    const alarms = await getTicketEscapeAlarms();
    await Promise.all(alarms.map((alarm) => alarmClear(alarm.name)));
  }

  async function resolveExecutionTabs(targetUrl, tabCount) {
    const requestedCount = clampInt(tabCount, DEFAULT_JOB.parallelTabCount, 1, 5);
    const deadline = Date.now() + 500;
    let reusableTabs = [];

    while (Date.now() <= deadline) {
      reusableTabs = await findReusableTargetTabs(targetUrl, requestedCount);
      if (reusableTabs.length >= requestedCount) {
        break;
      }
      await wait(40);
    }

    const selectedTabs = reusableTabs.slice(0, requestedCount);
    const missingCount = Math.max(0, requestedCount - selectedTabs.length);
    for (let i = 0; i < missingCount; i += 1) {
      const shouldActivate = selectedTabs.length === 0 && i === 0;
      const createdTab = await createTargetTab(targetUrl, shouldActivate);
      selectedTabs.push(createdTab);
    }
    return selectedTabs;
  }

  async function findReusableTargetTabs(targetUrl, limit) {
    const normalizedTargetUrl = normalizeUrlForCompare(targetUrl);
    if (!normalizedTargetUrl) {
      return [];
    }

    const tabs = await tabQuery({
      url: ["https://escape.id/*"]
    });
    const candidates = tabs.filter((tab) => {
      if (!tab || typeof tab.id !== "number") {
        return false;
      }
      return normalizeUrlForCompare(tab.url) === normalizedTargetUrl;
    });
    if (!candidates.length) {
      return [];
    }

    candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const maxCount = Number.isFinite(limit) ? Math.max(1, Number.parseInt(limit, 10)) : candidates.length;
    return candidates.slice(0, maxCount);
  }

  function normalizeUrlForCompare(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""));
      return `${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch (_) {
      return "";
    }
  }

  async function createTargetTab(url, active) {
    const tab = await tabCreate({
      url,
      active: active !== false
    });
    if (!tab || typeof tab.id !== "number") {
      throw new Error("Failed to create target tab.");
    }
    return tab;
  }

  function waitForTabComplete(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timeout = setTimeout(() => {
        finish(new Error("Tab load timeout."));
      }, timeoutMs);

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId) {
          return;
        }
        if (changeInfo.status === "complete") {
          finish(null);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
      void tabGet(tabId)
        .then((tab) => {
          if (tab && tab.status === "complete") {
            finish(null);
          }
        })
        .catch(() => {
          // Keep waiting on listener.
        });

      function finish(error) {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    });
  }

  async function waitForTabCompleteBestEffort(tabId, timeoutMs) {
    try {
      await waitForTabComplete(tabId, timeoutMs);
    } catch (error) {
      await appendLog("TAB_WAIT_TIMEOUT", "Continuing even though tab did not report complete.", {
        tabId,
        timeoutMs,
        error: error && error.message ? error.message : "unknown error"
      });
    }
  }

  async function sendMessageToTabWithRetry(tabId, payload, retries, intervalMs) {
    let lastError = null;
    for (let i = 0; i < retries; i += 1) {
      try {
        const response = await tabSendMessage(tabId, payload);
        return response;
      } catch (error) {
        lastError = error;
        await wait(intervalMs);
      }
    }
    throw lastError || new Error("Failed to send message to tab.");
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getStorageValue(key, fallbackValue) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get([key], (items) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (!items || typeof items[key] === "undefined") {
          resolve(fallbackValue);
          return;
        }
        resolve(items[key]);
      });
    });
  }

  function setStorageValue(key, value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function alarmsGetAll() {
    return new Promise((resolve, reject) => {
      chrome.alarms.getAll((alarms) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(alarms || []);
      });
    });
  }

  function alarmClear(name) {
    return new Promise((resolve) => {
      chrome.alarms.clear(name, () => {
        resolve();
      });
    });
  }

  function tabCreate(createProperties) {
    return new Promise((resolve, reject) => {
      chrome.tabs.create(createProperties, (tab) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tab);
      });
    });
  }

  function tabUpdate(tabId, updateProperties) {
    return new Promise((resolve, reject) => {
      chrome.tabs.update(tabId, updateProperties, (tab) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tab);
      });
    });
  }

  function windowUpdate(windowId, updateInfo) {
    return new Promise((resolve, reject) => {
      chrome.windows.update(windowId, updateInfo, (win) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(win);
      });
    });
  }

  function tabQuery(queryInfo) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query(queryInfo, (tabs) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tabs || []);
      });
    });
  }

  function tabGet(tabId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.get(tabId, (tab) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tab);
      });
    });
  }

  function tabSendMessage(tabId, payload) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, payload, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response || null);
      });
    });
  }
})(globalThis);
