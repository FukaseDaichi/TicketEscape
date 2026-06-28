(function optionsPageMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const {
    MESSAGE_TYPES,
    STORAGE_KEYS,
    STATUS,
    DEFAULT_JOB,
    DEFAULT_PREFERENCES,
    createId,
    ensureEscapeUrl,
    ensureHttpsUrl,
    isEscapeTicketPageUrl,
    clampInt,
    getErrorMessage,
    buildReservationView,
    formatLocalDatetimeInput,
    formatJstDateTime,
    toJstIsoStringFromDatetimeLocal
  } = shared;

  const TRASH_ICON =
    '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>';

  const ARM_NOTE_DEFAULT = "設定を確認したら押してください。この画面は開いたままにします。";
  const PAGE_DRAFT_MAX_AGE_MS = 10 * 60 * 1000;

  const state = {
    elements: {},
    countdownIntervalId: null,
    countdownRunId: 0,
    confirmedTargetUrl: "",
    eventTitle: "",
    heroImageUrl: "",
    armed: false,
    triggerConfirmed: false,
    loadedJob: null,
    liveJob: null,
    liveStatus: null,
    liveSyncedAt: null,
    wizardHydrated: false,
    wizardJobKey: "",
    pageDraft: null,
    cancelInFlight: false,
    preferences: { ...DEFAULT_PREFERENCES },
    runs: [],
    syncIntervalId: null,
    countdownJobKey: ""
  };

  function setCurrentReservation(job) {
    const currentJob = job || null;
    state.loadedJob = currentJob;
    state.liveJob = currentJob;
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindElements();
    bindEvents();
    setDefaultValues();
    void loadInitialData();
  });

  function bindElements() {
    state.elements = {
      jobId:            document.getElementById("jobId"),
      targetUrl:        document.getElementById("targetUrl"),
      triggerAt:        document.getElementById("triggerAt"),
      clickIntervalMs:  document.getElementById("clickIntervalMs"),
      parallelTabCount: document.getElementById("parallelTabCount"),
      requireAgreement: document.getElementById("requireAgreement"),
      autoSelectRequiredOptions: document.getElementById("autoSelectRequiredOptions"),
      parseFormButton:  document.getElementById("parseFormButton"),
      saveButton:       document.getElementById("saveButton"),
      addPlanButton:    document.getElementById("addPlanButton"),
      currentReservation: document.getElementById("currentReservation"),
      crChip:           document.getElementById("crChip"),
      crChipLabel:      document.getElementById("crChipLabel"),
      crHero:           document.getElementById("crHero"),
      crTitle:          document.getElementById("crTitle"),
      crDate:           document.getElementById("crDate"),
      crTickets:        document.getElementById("crTickets"),
      crCountdown:      document.getElementById("crCountdown"),
      crEmpty:          document.getElementById("crEmpty"),
      crUrl:            document.getElementById("crUrl"),
      crSync:           document.getElementById("crSync"),
      crCancelButton:   document.getElementById("crCancelButton"),
      crEditButton:     document.getElementById("crEditButton"),
      crRefreshButton:  document.getElementById("crRefreshButton"),
      planRows:         document.getElementById("planRows"),
      statusText:       document.getElementById("statusText"),
      statusChip:       document.getElementById("statusChip"),
      statusChipLabel:  document.getElementById("statusChipLabel"),
      miniCdEyebrow:    document.getElementById("miniCdEyebrow"),
      miniCdVal:        document.getElementById("miniCdVal"),
      eventReadout:     document.getElementById("eventReadout"),
      eventTitleText:   document.getElementById("eventTitleText"),
      armNote:          document.getElementById("armNote"),
      stepUrl:          document.getElementById("stepUrl"),
      stepTime:         document.getElementById("stepTime"),
      stepTickets:      document.getElementById("stepTickets"),
      stepArm:          document.getElementById("stepArm"),
      runsList:         document.getElementById("runsList"),
      clearRunsButton:  document.getElementById("clearRunsButton")
    };
  }

  function bindEvents() {
    state.elements.targetUrl.addEventListener("input", () => {
      state.pageDraft = null;
      updateConfirmAttention();
      updateStepStates();
    });

    state.elements.triggerAt.addEventListener("input", () => {
      state.triggerConfirmed = true;
      updateStepStates();
      updateStandbyAttention();
    });
    state.elements.triggerAt.addEventListener("focus", () => {
      state.triggerConfirmed = true;
      updateStepStates();
      updateStandbyAttention();
    });

    state.elements.parseFormButton.addEventListener("click", () => {
      void parseForm();
    });

    state.elements.saveButton.addEventListener("click", () => {
      void saveJob();
    });

    state.elements.crCancelButton.addEventListener("click", handleCancelButtonClick);
    document.addEventListener("click", (event) => {
      const cancelButton = event.target && event.target.closest
        ? event.target.closest("#crCancelButton")
        : null;
      if (!cancelButton) {
        return;
      }
      handleCancelButtonClick(event);
    }, true);
    document.addEventListener("pointerdown", (event) => {
      const cancelButton = event.target && event.target.closest
        ? event.target.closest("#crCancelButton")
        : null;
      if (!cancelButton) {
        return;
      }
      handleCancelButtonClick(event);
    }, true);

    state.elements.crEditButton.addEventListener("click", () => {
      loadLiveJobIntoWizard();
    });

    state.elements.crRefreshButton.addEventListener("click", () => {
      void loadSavedJob({ populateWizard: false, silent: false });
    });

    state.elements.crHero.addEventListener("error", () => {
      state.elements.crHero.hidden = true;
    });

    state.elements.addPlanButton.addEventListener("click", () => {
      addPlanRow("", 1);
      afterPlanChange();
      const lastRow = state.elements.planRows.lastElementChild;
      if (lastRow) {
        const label = lastRow.querySelector("input[data-field='label']");
        if (label) {
          label.focus();
        }
      }
    });

    state.elements.clearRunsButton.addEventListener("click", () => {
      void clearRuns();
    });

    state.elements.runsList.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-action]");
      if (!trigger) {
        return;
      }
      if (trigger.dataset.action === "restore-run") {
        const index = Number.parseInt(trigger.dataset.index || "-1", 10);
        restoreRun(index);
      }
    });

    for (const prefInput of [
      state.elements.clickIntervalMs,
      state.elements.parallelTabCount,
      state.elements.requireAgreement,
      state.elements.autoSelectRequiredOptions
    ]) {
      prefInput.addEventListener("change", () => {
        void savePreferencesFromForm();
      });
    }

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") {
          return;
        }
        if (changes[STORAGE_KEYS.JOB]) {
          void loadSavedJob({ populateWizard: true, forcePopulateWizard: true, silent: true });
        } else if (changes[STORAGE_KEYS.STATUS]) {
          void loadSavedJob({ populateWizard: false, silent: true });
        }
        if (changes[STORAGE_KEYS.RUNS]) {
          void loadRuns();
        }
      });
    }

    state.elements.planRows.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-action]");
      if (!trigger) {
        return;
      }
      const row = trigger.closest(".ticket-row");
      if (!row) {
        return;
      }
      const action = trigger.dataset.action;
      if (action === "remove-plan") {
        row.remove();
        afterPlanChange();
        return;
      }
      const qtyInput = row.querySelector("input[data-field='qty']");
      if (!qtyInput) {
        return;
      }
      let value = clampInt(qtyInput.value, 0, 0, 99);
      if (action === "inc") {
        value = Math.min(99, value + 1);
      } else if (action === "dec") {
        value = Math.max(0, value - 1);
      }
      qtyInput.value = String(value);
      syncQtyZero(qtyInput);
      afterPlanChange();
    });

    state.elements.planRows.addEventListener("input", (event) => {
      const target = event.target;
      if (target && target.dataset && target.dataset.field === "qty") {
        syncQtyZero(target);
      }
      afterPlanChange();
    });
  }

  function handleCancelButtonClick(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    void cancelJob();
  }

  function setDefaultValues() {
    state.elements.clickIntervalMs.value  = String(DEFAULT_PREFERENCES.clickIntervalMs);
    state.elements.parallelTabCount.value = String(DEFAULT_PREFERENCES.parallelTabCount);
    state.elements.requireAgreement.checked = DEFAULT_PREFERENCES.requireAgreement !== false;
    state.elements.autoSelectRequiredOptions.checked =
      DEFAULT_PREFERENCES.autoSelectRequiredOptions !== false;
    state.elements.triggerAt.value = formatLocalDatetimeInput(Date.now() + 10 * 60 * 1000);
    state.triggerConfirmed = false;
    if (!state.elements.planRows.children.length) {
      addPlanRow("", 0);
    }
    updateConfirmAttention();
    updateStandbyAttention();
    updateStepStates();
    renderCurrentReservation();
    setIdleCountdown();
  }

  async function loadInitialData() {
    await loadPreferences();
    await loadSavedJob({ populateWizard: true, silent: true });
    await loadPageDraft();
    await loadRuns();
    startLiveSyncLoop();
  }

  async function loadPreferences() {
    try {
      const response = await sendMessage({ type: MESSAGE_TYPES.GET_PREFERENCES });
      if (response.ok && response.preferences) {
        state.preferences = response.preferences;
        applyPreferencesToForm(response.preferences);
      }
    } catch (_) {
      // Keep local defaults.
    }
  }

  async function loadSavedJob(options) {
    const opts = options || {};
    try {
      const response = await sendMessage({ type: MESSAGE_TYPES.GET_STATUS });
      if (!response.ok) {
        throw new Error(formatResponseError(response));
      }

      setCurrentReservation(response.job || null);
      state.liveStatus = response.status || { state: STATUS.IDLE };
      state.liveSyncedAt = Date.now();
      if (response.preferences) {
        state.preferences = response.preferences;
      }

      if (!state.loadedJob) {
        if (!opts.silent) {
          setStatus("現在の予約はありません。");
        }
        state.elements.jobId.value = "";
        state.wizardJobKey = "";
        clearCountdownInterval();
        setIdleCountdown();
        renderCurrentReservation();
        return;
      }

      const liveJobKey = reservationFormKey(state.loadedJob);
      const shouldPopulateWizard =
        opts.forcePopulateWizard ||
        opts.populateWizard === true ||
        !state.wizardHydrated ||
        (liveJobKey && liveJobKey !== state.wizardJobKey);
      const canPopulateWizard =
        opts.populateWizard !== false ||
        (liveJobKey && liveJobKey !== state.wizardJobKey);
      if (canPopulateWizard && shouldPopulateWizard) {
        populateForm(state.loadedJob);
        state.wizardHydrated = true;
      }

      if (!opts.silent) {
        setStatus("現在の予約を同期しました。");
      }
      syncLiveHeaderCountdown();
      renderCurrentReservation();
    } catch (error) {
      if (!opts.silent) {
        setStatus(`予約同期失敗: ${error.message}`);
      }
      renderCurrentReservation();
    }
  }

  function startLiveSyncLoop() {
    if (state.syncIntervalId !== null) {
      return;
    }
    state.syncIntervalId = globalScope.setInterval(() => {
      void loadSavedJob({ populateWizard: false, silent: true });
    }, 2000);
  }

  function loadLiveJobIntoWizard() {
    const currentJob = state.loadedJob || state.liveJob;
    if (!currentJob) {
      setStatus("読み込む予約はありません。");
      return;
    }
    populateForm(currentJob);
    state.wizardHydrated = true;
    setStatus("現在の予約をフォームに読み込みました。編集後に予約で更新できます。");
    state.elements.targetUrl.focus();
  }

  async function loadPageDraft() {
    try {
      const response = await sendMessage({ type: MESSAGE_TYPES.GET_PAGE_DRAFT });
      if (!response.ok || !response.draft || !response.draft.url) {
        return;
      }
      const draftUrl = ensureEscapeUrl(response.draft.url);
      if (!draftUrl || !isEscapeTicketPageUrl(draftUrl)) {
        await clearPageDraft();
        return;
      }
      const draftAgeMs = Date.now() - Number(response.draft.detectedAt || 0);
      if (!Number.isFinite(draftAgeMs) || draftAgeMs < 0 || draftAgeMs > PAGE_DRAFT_MAX_AGE_MS) {
        await clearPageDraft();
        return;
      }
      if (state.loadedJob || state.liveJob) {
        await clearPageDraft();
        return;
      }
      state.pageDraft = response.draft;
      state.elements.jobId.value = "";
      state.elements.targetUrl.value = draftUrl;
      state.confirmedTargetUrl = "";
      state.eventTitle = String(response.draft.eventTitle || "");
      state.triggerConfirmed = false;
      updateEventReadout();
      updateConfirmAttention();
      updateStandbyAttention();
      updateStepStates();
      setStatus("ページから予約対象URLを取り込みました。「情報を読み取る」を押してください。");
      await clearPageDraft();
    } catch (error) {
      setStatus(`ページ情報の取り込み失敗: ${error.message}`);
    }
  }

  async function loadRuns() {
    try {
      const response = await sendMessage({ type: MESSAGE_TYPES.GET_RUNS });
      state.runs = response.ok && Array.isArray(response.runs) ? response.runs : [];
      renderRuns();
    } catch (_) {
      state.runs = [];
      renderRuns();
    }
  }

  function populateForm(job) {
    state.elements.jobId.value     = String(job.jobId || "");
    state.elements.targetUrl.value = String(job.targetUrl || "");
    state.loadedJob                = job || null;
    state.wizardJobKey             = reservationFormKey(job);
    state.confirmedTargetUrl       = normalizeTargetUrlForCompare(state.elements.targetUrl.value);
    state.eventTitle               = String(job.eventTitle || "");
    state.heroImageUrl             = ensureHttpsUrl(job.heroImageUrl);
    updateConfirmAttention();
    updateEventReadout();

    const triggerEpoch = Date.parse(String(job.triggerAtJst || ""));
    if (Number.isFinite(triggerEpoch)) {
      state.elements.triggerAt.value = formatLocalDatetimeInput(triggerEpoch);
      state.triggerConfirmed = true;
    }
    state.elements.clickIntervalMs.value = String(
      job.clickIntervalMs ?? DEFAULT_JOB.clickIntervalMs
    );
    state.elements.parallelTabCount.value = String(
      job.parallelTabCount ?? DEFAULT_JOB.parallelTabCount
    );
    state.elements.requireAgreement.checked = job.requireAgreement !== false;
    state.elements.autoSelectRequiredOptions.checked = job.autoSelectRequiredOptions !== false;

    state.elements.planRows.innerHTML = "";
    const ticketPlans = Array.isArray(job.ticketPlans) ? job.ticketPlans : [];
    if (!ticketPlans.length) {
      addPlanRow("", 0);
    } else {
      for (const plan of ticketPlans) {
        addPlanRow(plan.ticketLabel, plan.targetQty);
      }
    }
    updateStandbyAttention();
    updateStepStates();
  }

  function applyPreferencesToForm(preferences) {
    const prefs = preferences || DEFAULT_PREFERENCES;
    state.elements.clickIntervalMs.value = String(
      prefs.clickIntervalMs ?? DEFAULT_PREFERENCES.clickIntervalMs
    );
    state.elements.parallelTabCount.value = String(
      prefs.parallelTabCount ?? DEFAULT_PREFERENCES.parallelTabCount
    );
    state.elements.requireAgreement.checked = prefs.requireAgreement !== false;
    state.elements.autoSelectRequiredOptions.checked = prefs.autoSelectRequiredOptions !== false;
  }

  async function parseForm() {
    const targetUrl = ensureEscapeUrl(state.elements.targetUrl.value);
    if (!targetUrl) {
      setStatus("URLが不正です。https://escape.id/* を指定してください。");
      updateConfirmAttention();
      return;
    }
    if (!isEscapeTicketPageUrl(targetUrl)) {
      setStatus(getErrorMessage("E_TICKET_PAGE_REQUIRED"));
      updateConfirmAttention();
      return;
    }

    setStatus("情報を読み取り中...");
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.PARSE_FORM_REQUEST,
        url: targetUrl,
        selectorOverrides: state.preferences.selectorOverrides || {}
      });

      if (!response.ok) {
        setStatus(`読み取り失敗: ${formatResponseError(response)}`);
        return;
      }

      const parseResult = response.parseResult || {};
      const tickets = Array.isArray(parseResult.tickets) ? parseResult.tickets : [];
      if (!tickets.length) {
        setStatus("フォームは検出しましたが券種を読み取れませんでした。");
        return;
      }

      state.eventTitle = String(parseResult.eventTitle || "").trim();
      state.heroImageUrl = ensureHttpsUrl(parseResult.heroImageUrl);
      updateEventReadout();

      state.elements.planRows.innerHTML = "";
      for (const ticket of tickets) {
        addPlanRow(ticket.ticketLabel, ticket.currentQty || 0);
      }
      state.confirmedTargetUrl = normalizeTargetUrlForCompare(targetUrl);
      updateConfirmAttention();
      updateStandbyAttention();
      updateStepStates();
      setStatus(`券種を ${tickets.length} 件取得しました。数量を設定してください。`);
    } catch (error) {
      setStatus(`読み取り失敗: ${error.message}`);
    }
  }

  async function saveJob() {
    updateStandbyAttention();

    const targetUrl = ensureEscapeUrl(state.elements.targetUrl.value);
    if (!targetUrl) {
      setStatus("URLが不正です。https://escape.id/* を指定してください。");
      return;
    }
    if (!isEscapeTicketPageUrl(targetUrl)) {
      setStatus(getErrorMessage("E_TICKET_PAGE_REQUIRED"));
      return;
    }

    const triggerAtJst = toJstIsoStringFromDatetimeLocal(state.elements.triggerAt.value);
    if (!triggerAtJst || !Number.isFinite(Date.parse(triggerAtJst))) {
      setStatus("実行時刻を正しく入力してください。");
      return;
    }

    if (!state.triggerConfirmed) {
      setStatus("実行時刻を確認してください。");
      updateStepStates();
      return;
    }

    const ticketPlans = collectPlanRows();
    if (!ticketPlans.length) {
      setStatus("券種設定がありません。");
      return;
    }
    if (!ticketPlans.some((plan) => plan.targetQty > 0)) {
      setStatus("予約するには、1枚以上の数量を設定してください。");
      updateStandbyAttention();
      return;
    }

    const job = {
      jobId:            state.elements.jobId.value || createId("job"),
      targetUrl,
      triggerAtJst,
      eventTitle:       state.eventTitle || "",
      heroImageUrl:     state.heroImageUrl || "",
      triggerAtConfirmed: true,
      clickIntervalMs:  clampInt(state.elements.clickIntervalMs.value,  DEFAULT_JOB.clickIntervalMs,  5, 500),
      parallelTabCount: clampInt(state.elements.parallelTabCount.value, DEFAULT_JOB.parallelTabCount, 1, 5),
      requireAgreement: state.elements.requireAgreement.checked,
      autoSelectRequiredOptions: state.elements.autoSelectRequiredOptions.checked,
      ticketPlans
    };

    const replaceOptions = await getReplaceOptions(job);
    if (replaceOptions.canceled) {
      setStatus("予約の切り替えをキャンセルしました。");
      return;
    }

    setStatus("予約を登録中...");
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.SAVE_JOB,
        job,
        ...replaceOptions
      });
      if (!response.ok) {
        setStatus(`予約失敗: ${formatResponseError(response)}`);
        setIdleCountdown();
        return;
      }
      state.elements.jobId.value = response.job.jobId;
      const savedTriggerEpoch = Date.parse(String(response.job.triggerAtJst || ""));
      if (Number.isFinite(savedTriggerEpoch)) {
        state.elements.triggerAt.value = formatLocalDatetimeInput(savedTriggerEpoch);
      }
      setCurrentReservation(response.job);
      state.liveStatus = {
        state: STATUS.WAIT_TRIGGER,
        jobId: response.job.jobId,
        triggerAtJst: response.job.triggerAtJst,
        updatedAt: Date.now()
      };
      state.liveSyncedAt = Date.now();
      state.heroImageUrl = ensureHttpsUrl(response.job.heroImageUrl);
      state.pageDraft = null;
      state.triggerConfirmed = true;
      state.wizardHydrated = true;
      state.wizardJobKey = reservationFormKey(response.job);
      syncLiveHeaderCountdown({ updateStatus: true });
      renderCurrentReservation();
    } catch (error) {
      setStatus(`予約失敗: ${error.message}`);
      setIdleCountdown();
    }
  }

  async function cancelJob() {
    if (state.cancelInFlight) {
      return;
    }
    if (!(await ensureExtensionContextReady())) {
      return;
    }

    state.cancelInFlight = true;
    state.elements.crCancelButton.disabled = true;
    setStatus("予約を取り消し中...");

    try {
      // Re-read the live job so cancel always targets the currently-stored
      // reservation, then let the service worker be the single writer that
      // clears storage and alarms (same path as popup / content panel).
      let liveJob = state.loadedJob || state.liveJob;
      try {
        const jobResponse = await sendMessage({ type: MESSAGE_TYPES.GET_JOB });
        if (jobResponse.ok) {
          liveJob = jobResponse.job || null;
        }
      } catch (_) {
        // Fall back to the locally loaded snapshot.
      }

      if (!liveJob || !liveJob.jobId) {
        clearReservationUiAfterCancel();
        setStatus("予約はありません。");
        await loadSavedJob({ populateWizard: false, silent: true });
        return;
      }

      const response = await sendMessage({
        type: MESSAGE_TYPES.CANCEL_JOB,
        expectedJobId: liveJob.jobId
      });
      if (!response.ok) {
        throw new Error(formatResponseError(response));
      }

      clearReservationUiAfterCancel();
      setStatus("予約を取り消しました。");
      await loadSavedJob({ populateWizard: false, silent: true });
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        reloadStaleOptionsPage();
        return;
      }
      state.elements.crCancelButton.disabled = false;
      setStatus(`予約取り消し失敗: ${error.message}`);
    } finally {
      state.cancelInFlight = false;
    }
  }

  function clearReservationUiAfterCancel() {
    clearCountdownInterval();
    setCurrentReservation(null);
    state.liveStatus = { state: STATUS.IDLE, jobId: null, detail: "canceled", updatedAt: Date.now() };
    state.liveSyncedAt = Date.now();
    state.armed = false;
    state.elements.jobId.value = "";
    state.wizardJobKey = "";
    resetReservationFormAfterCancel();
    setIdleCountdown();
    renderCurrentReservation();
  }

  function resetReservationFormAfterCancel() {
    state.pageDraft = null;
    state.confirmedTargetUrl = "";
    state.eventTitle = "";
    state.heroImageUrl = "";
    state.triggerConfirmed = false;
    state.wizardHydrated = false;
    state.elements.jobId.value = "";
    state.elements.targetUrl.value = "";
    state.elements.triggerAt.value = formatLocalDatetimeInput(Date.now() + 10 * 60 * 1000);
    state.elements.planRows.innerHTML = "";
    addPlanRow("", 0);
    updateEventReadout();
    updateConfirmAttention();
    updateStandbyAttention();
    updateStepStates();
  }

  async function clearPageDraft() {
    state.pageDraft = null;
    await removeLocalStorageKeys([STORAGE_KEYS.PAGE_DRAFT]);
    void sendMessage({ type: MESSAGE_TYPES.CLEAR_PAGE_DRAFT }).catch(() => {
      // The local draft key has already been removed.
    });
  }

  function removeLocalStorageKeys(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  async function ensureExtensionContextReady() {
    try {
      await sendMessage({ type: MESSAGE_TYPES.PING });
      return true;
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        reloadStaleOptionsPage();
        return false;
      }
      return true;
    }
  }

  function isExtensionContextInvalidatedError(error) {
    return /extension context invalidated/i.test(String(error && error.message ? error.message : error || ""));
  }

  function reloadStaleOptionsPage() {
    setStatus("詳細ページが古い状態です。再読み込みします...");
    globalScope.setTimeout(() => {
      globalScope.location.reload();
    }, 150);
  }

  async function savePreferencesFromForm() {
    const preferences = {
      clickIntervalMs: clampInt(
        state.elements.clickIntervalMs.value,
        DEFAULT_PREFERENCES.clickIntervalMs,
        5,
        500
      ),
      parallelTabCount: clampInt(
        state.elements.parallelTabCount.value,
        DEFAULT_PREFERENCES.parallelTabCount,
        1,
        5
      ),
      requireAgreement: state.elements.requireAgreement.checked,
      autoSelectRequiredOptions: state.elements.autoSelectRequiredOptions.checked,
      selectorOverrides: state.preferences.selectorOverrides || null
    };

    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.SAVE_PREFERENCES,
        preferences
      });
      if (response.ok && response.preferences) {
        state.preferences = response.preferences;
        setStatus("詳細設定を保存しました。");
      }
    } catch (error) {
      setStatus(`詳細設定の保存失敗: ${error.message}`);
    }
  }

  async function getReplaceOptions(nextJob) {
    let existing = state.loadedJob || state.liveJob;
    try {
      const response = await sendMessage({ type: MESSAGE_TYPES.GET_JOB });
      if (response.ok) {
        existing = response.job || null;
      }
    } catch (_) {
      // Use the locally loaded snapshot.
    }

    if (!existing) {
      return { replaceMode: "create" };
    }

    const sameJob = String(existing.jobId || "") === String(nextJob.jobId || "");
    const sameUrl =
      normalizeTargetUrlForCompare(existing.targetUrl) ===
      normalizeTargetUrlForCompare(nextJob.targetUrl);

    if (sameJob || sameUrl) {
      return { replaceMode: "update" };
    }

    const existingName = existing.eventTitle || shortenUrl(existing.targetUrl || "");
    const nextName = nextJob.eventTitle || shortenUrl(nextJob.targetUrl || "");
    const confirmed = globalScope.confirm(
      [
        "別の予約が実行待機中です。",
        "現在の予約をこのページに切り替えますか？",
        "",
        `現在: ${existingName}`,
        `新規: ${nextName}`
      ].join("\n")
    );

    if (!confirmed) {
      return { canceled: true };
    }

    return {
      replaceMode: "replace",
      replaceConfirmed: true,
      expectedPreviousJobId: existing.jobId
    };
  }

  async function clearRuns() {
    if (!state.runs.length) {
      return;
    }
    const ok = globalScope.confirm("実行履歴をすべて削除しますか？");
    if (!ok) {
      return;
    }
    try {
      const response = await sendMessage({ type: MESSAGE_TYPES.CLEAR_RUNS });
      if (!response.ok) {
        setStatus(`履歴クリア失敗: ${formatResponseError(response)}`);
        return;
      }
      state.runs = [];
      renderRuns();
      setStatus("実行履歴をクリアしました。");
    } catch (error) {
      setStatus(`履歴クリア失敗: ${error.message}`);
    }
  }

  function restoreRun(index) {
    const run = state.runs[index];
    if (!run) {
      return;
    }
    const targetUrl = ensureEscapeUrl(run.targetUrl);
    if (!targetUrl) {
      setStatus("履歴のURLが不正です。");
      return;
    }

    clearCountdownInterval();
    setArmed(false);
    setChip("idle");
    setMiniCd("--:--:--", "idle");

    state.elements.jobId.value = "";
    state.elements.targetUrl.value = targetUrl;
    state.confirmedTargetUrl = normalizeTargetUrlForCompare(targetUrl);
    state.eventTitle = String(run.eventTitle || "");
    state.elements.triggerAt.value = formatLocalDatetimeInput(Date.now() + 10 * 60 * 1000);
    state.triggerConfirmed = false;
    state.elements.planRows.innerHTML = "";
    const plans = Array.isArray(run.ticketPlans) ? run.ticketPlans : [];
    if (!plans.length) {
      addPlanRow("", 0);
    } else {
      for (const plan of plans) {
        addPlanRow(plan.ticketLabel, plan.targetQty);
      }
    }

    updateEventReadout();
    updateConfirmAttention();
    updateStandbyAttention();
    updateStepStates();
    setStatus("履歴の内容を復元しました。実行時刻を確認してください。");
    state.elements.triggerAt.focus();
  }

  function renderRuns() {
    const list = state.elements.runsList;
    if (!list) {
      return;
    }

    if (!state.runs.length) {
      list.innerHTML = '<div class="history-empty">まだ実行履歴はありません。</div>';
      state.elements.clearRunsButton.disabled = true;
      return;
    }

    state.elements.clearRunsButton.disabled = false;
    list.innerHTML = state.runs.map((run, index) => renderRun(run, index)).join("");
  }

  function renderRun(run, index) {
    const status = String(run.status || "FAILED");
    const statusClass = status === "SUCCESS" ? "success" : "failed";
    const title = run.eventTitle || shortenUrl(run.targetUrl || "") || "名称未取得";
    const trigger = formatDisplayDate(run.triggerAtJst || run.startedAt);
    const plans = summarizePlans(run.ticketPlans);
    const errorCode = run.errorCode || "";
    const errorMessage = errorCode ? getErrorMessage(errorCode, run.errorDetail || "") : "";
    const steps = Array.isArray(run.steps)
      ? run.steps.map((step) => `${formatDisplayDate(step.at)} ${step.step}: ${step.detail || ""}`).join("\n")
      : "";

    return `
      <details class="run-item">
        <summary>
          <span class="run-state ${statusClass}">${esc(status)}</span>
          <span class="run-main">
            <span class="run-title">${esc(title)}</span>
            <span class="run-meta">${esc(trigger)} · ${esc(plans || "券種なし")}</span>
          </span>
          <span class="run-caret" aria-hidden="true">›</span>
        </summary>
        <div class="run-detail">
          ${errorCode ? `<div class="run-detail-line">error: ${esc(errorCode)}\n${esc(errorMessage)}</div>` : ""}
          <div class="run-detail-line">url: ${esc(run.targetUrl || "")}</div>
          <div class="run-detail-line">tickets: ${esc(plans || "券種なし")}</div>
          ${steps ? `<div class="run-detail-line">steps:\n${esc(steps)}</div>` : ""}
          <div class="run-actions">
            <button class="btn btn-secondary" type="button" data-action="restore-run" data-index="${index}">この内容で再予約</button>
          </div>
        </div>
      </details>
    `;
  }

  function summarizePlans(plans) {
    if (!Array.isArray(plans)) {
      return "";
    }
    return plans
      .filter((plan) => Number(plan.targetQty) > 0)
      .map((plan) => `${plan.ticketLabel}×${Number(plan.targetQty)}`)
      .join(" / ");
  }

  function formatDisplayDate(value) {
    return formatJstDateTime(value) || "--";
  }

  function shortenUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      const path = `${parsed.pathname}${parsed.search}`;
      return `${parsed.hostname}${path.length > 48 ? `${path.slice(0, 45)}...` : path}`;
    } catch (_) {
      return String(url || "");
    }
  }

  function esc(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatResponseError(response) {
    if (!response) {
      return "unknown error";
    }
    return getErrorMessage(response.code, response.error || "unknown error");
  }

  function startCountdown(job, options) {
    const opts  = options || {};

    const targetUrl    = ensureEscapeUrl(job && job.targetUrl);
    const triggerEpoch = Date.parse(String((job && job.triggerAtJst) || ""));
    if (!targetUrl || !Number.isFinite(triggerEpoch)) {
      setIdleCountdown();
      return;
    }

    const nextCountdownKey = [
      String(job.jobId || ""),
      targetUrl,
      String(job.triggerAtJst || "")
    ].join("|");
    if (state.countdownJobKey === nextCountdownKey && state.countdownIntervalId !== null) {
      renderCountdown(triggerEpoch);
      return;
    }

    clearCountdownInterval();
    state.countdownJobKey = nextCountdownKey;
    state.countdownRunId += 1;
    const runId = state.countdownRunId;

    const remainingMs = triggerEpoch - Date.now();
    if (remainingMs <= 0) {
      setArmed(false);
      setChip("expired");
      setMiniCd("00:00:00", "idle");
      setArmNote("実行時刻を過ぎています。時刻を再設定して保存してください。", false);
      return;
    }

    if (opts.updateStatus !== false) {
      setStatus("予約しました。0秒で購入URLへ遷移します。");
    }

    setArmed(true);
    renderCountdown(triggerEpoch);
    state.countdownIntervalId = globalScope.setInterval(() => {
      if (runId !== state.countdownRunId) {
        return;
      }
      renderCountdown(triggerEpoch);
    }, 250);

    void waitForTriggerEpoch(triggerEpoch, () => runId !== state.countdownRunId)
      .then(() => {
        if (runId !== state.countdownRunId) {
          return;
        }
        clearCountdownInterval();
        setMiniCd("00:00:00", "tminus");
        setArmNote("遷移中...", true);
        globalScope.location.assign(targetUrl);
      })
      .catch((error) => {
        if (runId !== state.countdownRunId) {
          return;
        }
        clearCountdownInterval();
        setArmed(false);
        setChip("idle");
        setMiniCd("ERR", "idle");
        setArmNote(`カウントダウン異常: ${error.message || "unknown error"}`, false);
      });
  }

  function syncLiveHeaderCountdown(options) {
    const currentJob = state.loadedJob || state.liveJob;
    const view = buildReservationView(currentJob, state.liveStatus, Date.now());
    if (!view.hasReservation || !currentJob) {
      clearCountdownInterval();
      setIdleCountdown();
      return;
    }

    if (view.phase === "armed" || view.phase === "tminus") {
      startCountdown(currentJob, options || { updateStatus: false });
      return;
    }

    clearCountdownInterval();
    setArmed(false);
    setChip(view.phase);
    setMiniCd(
      view.phase === "success"
        ? "SECURED"
        : (view.phase === "failed" ? "FAILED" : "00:00:00"),
      view.phase
    );
    setArmNote(
      view.phase === "success"
        ? "実行が完了しました。必要に応じて履歴を確認してください。"
        : (view.phase === "failed" ? "実行に失敗しました。履歴で詳細を確認してください。" : "実行中です。"),
      view.phase === "firing"
    );
  }

  function renderCountdown(triggerEpoch) {
    const remainingMs  = Math.max(0, triggerEpoch - Date.now());
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const hours   = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    const numStr = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    const phase  = remainingMs <= 60000 ? "tminus" : "armed";

    setChip(phase);
    setMiniCd(numStr, phase);
    updateCrCountdown(triggerEpoch);
    setArmNote(
      phase === "tminus"
        ? "まもなく遷移します。この画面を閉じないでください。"
        : "実行待機中。0秒で購入ページへ遷移します。",
      true
    );
  }

  async function waitForTriggerEpoch(triggerEpoch, isCanceled) {
    const canceled = typeof isCanceled === "function" ? isCanceled : () => false;
    let remaining = triggerEpoch - Date.now();
    if (remaining <= 0 || canceled()) {
      return;
    }

    if (remaining > 2000) {
      await sleep(remaining - 1500);
    }

    while (!canceled() && Date.now() < triggerEpoch - 16) {
      await sleep(1);
    }

    while (!canceled() && Date.now() < triggerEpoch) {
      await new Promise((resolve) => {
        if (typeof globalScope.requestAnimationFrame === "function") {
          globalScope.requestAnimationFrame(() => resolve());
        } else {
          globalScope.setTimeout(resolve, 0);
        }
      });
    }
  }

  function clearCountdownInterval() {
    if (state.countdownIntervalId !== null) {
      globalScope.clearInterval(state.countdownIntervalId);
      state.countdownIntervalId = null;
    }
    state.countdownJobKey = "";
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      globalScope.setTimeout(resolve, ms);
    });
  }

  function collectPlanRows() {
    const rows = Array.from(state.elements.planRows.querySelectorAll(".ticket-row"));
    return rows
      .map((row) => {
        const labelInput = row.querySelector("input[data-field='label']");
        const qtyInput   = row.querySelector("input[data-field='qty']");
        const ticketLabel = labelInput ? String(labelInput.value || "").trim() : "";
        const targetQty   = qtyInput   ? clampInt(qtyInput.value, 0, 0, 99)   : 0;
        return { ticketLabel, targetQty };
      })
      .filter((plan) => plan.ticketLabel);
  }

  function addPlanRow(label, qty) {
    const row = document.createElement("div");
    row.className = "ticket-row";
    row.innerHTML = [
      "<input data-field='label' class='ticket-label' type='text' placeholder='券種名' />",
      "<div class='stepper'>",
      "<button class='step-btn' data-action='dec' type='button' aria-label='数量を減らす'>−</button>",
      "<input data-field='qty' class='step-val' type='number' min='0' max='99' inputmode='numeric' />",
      "<button class='step-btn' data-action='inc' type='button' aria-label='数量を増やす'>＋</button>",
      "</div>",
      `<button class='row-remove' data-action='remove-plan' type='button' aria-label='この券種を削除'>${TRASH_ICON}</button>`
    ].join("");

    const labelInput = row.querySelector("input[data-field='label']");
    const qtyInput   = row.querySelector("input[data-field='qty']");
    labelInput.value = String(label || "");
    qtyInput.value   = String(Number.isFinite(Number(qty)) ? Number(qty) : 0);
    syncQtyZero(qtyInput);
    state.elements.planRows.appendChild(row);
  }

  function syncQtyZero(qtyInput) {
    const value = clampInt(qtyInput.value, 0, 0, 99);
    qtyInput.classList.toggle("zero", value <= 0);
  }

  function afterPlanChange() {
    updateStandbyAttention();
    updateStepStates();
  }

  /* ── Status chip + mini countdown ── */

  function setChip(phase) {
    const meta = {
      idle:    { cls: "idle",   label: "IDLE" },
      armed:   { cls: "armed",  label: "STANDBY" },
      tminus:  { cls: "tminus", label: "T-MINUS" },
      firing:  { cls: "tminus", label: "FIRING" },
      success: { cls: "armed",  label: "SECURED" },
      failed:  { cls: "failed", label: "FAILED" },
      expired: { cls: "idle",   label: "EXPIRED" }
    }[phase] || { cls: "idle", label: "IDLE" };
    state.elements.statusChip.className = `chip ${meta.cls}`;
    state.elements.statusChipLabel.textContent = meta.label;
  }

  function setMiniCd(numStr, phase) {
    const eyebrow = {
      idle:   "カウントダウン",
      armed:  "発売まで",
      tminus: "まもなく"
    }[phase] || "カウントダウン";
    state.elements.miniCdEyebrow.textContent = eyebrow;
    state.elements.miniCdVal.textContent = String(numStr);
    state.elements.miniCdVal.className =
      "mini-cd-val" + (phase === "armed" || phase === "tminus" ? ` ${phase}` : "");
  }

  function setArmNote(text, armed) {
    state.elements.armNote.textContent = String(text || "");
    state.elements.armNote.classList.toggle("armed", Boolean(armed));
  }

  function setIdleCountdown() {
    setArmed(false);
    setChip("idle");
    setMiniCd("--:--:--", "idle");
    if (!state.armed) {
      updateStandbyAttention();
    }
  }

  function setArmed(value) {
    state.armed = Boolean(value);
    state.elements.stepArm.classList.toggle("done", state.armed);
    renderCurrentReservation();
  }

  // Current reservation card: renders the single saved job shared by popup,
  // content panel, and this detail page.
  function renderCurrentReservation() {
    const els = state.elements;
    if (!els.currentReservation) {
      return;
    }
    const job = state.loadedJob || state.liveJob;
    const view = buildReservationView(job, state.liveStatus, Date.now());
    const phase = view.phase || "idle";
    const hasCurrentJob = Boolean(job);

    els.currentReservation.hidden = false;
    els.currentReservation.classList.toggle("empty", !hasCurrentJob);
    els.currentReservation.classList.toggle("active", hasCurrentJob);
    els.crSync.textContent = state.liveSyncedAt ? `同期 ${formatDisplayDate(state.liveSyncedAt)}` : "未同期";

    if (!hasCurrentJob) {
      els.crTitle.textContent = "現在の予約はありません";
      els.crDate.textContent = "ページ内パネル、ポップアップ、または下のフォームから予約できます。";
      els.crTickets.textContent = "";
      els.crUrl.textContent = "";
      els.crCountdown.textContent = "--:--:--";
      els.crEmpty.hidden = false;
      els.crHero.removeAttribute("src");
      els.crHero.hidden = true;
      els.crCancelButton.disabled = true;
      els.crEditButton.disabled = true;
      els.crChip.className = "chip idle";
      els.crChipLabel.textContent = "NO RESERVATION";
      return;
    }

    els.crEmpty.hidden = true;
    els.crTitle.textContent = view.eventTitle || job.eventTitle || shortenUrl(job.targetUrl || view.targetUrl) || "名称未取得";
    els.crDate.textContent = view.triggerJstText ? `実行 ${view.triggerJstText} (JST)` : "実行時刻を確認してください";
    els.crTickets.textContent = summarizePlans(job.ticketPlans) || "券種未設定";
    els.crUrl.textContent = view.targetUrl || job.targetUrl || "";
    els.crCancelButton.disabled = false;
    els.crEditButton.disabled = false;

    if (view.heroImageUrl) {
      els.crHero.src = view.heroImageUrl;
      els.crHero.hidden = false;
    } else {
      els.crHero.removeAttribute("src");
      els.crHero.hidden = true;
    }

    if (!view.hasReservation) {
      els.crCountdown.textContent = "--:--:--";
      updateCrPhase("idle");
      return;
    }

    if (phase === "success" || phase === "failed") {
      els.crCountdown.textContent = phase === "success" ? "SECURED" : "FAILED";
      updateCrPhase(phase);
      return;
    }

    updateCrCountdown(view.triggerEpoch);
    updateCrPhase(phase);
  }

  function updateCrCountdown(triggerEpoch) {
    const els = state.elements;
    if (!els.crCountdown || els.currentReservation.hidden || !(state.loadedJob || state.liveJob)) {
      return;
    }
    const remaining = Number.isFinite(triggerEpoch) ? triggerEpoch - Date.now() : NaN;
    els.crCountdown.textContent = Number.isFinite(remaining) ? fmtHms(Math.max(0, remaining)) : "--:--:--";
    updateCrPhase(remaining <= 0 ? "firing" : (remaining <= 60000 ? "tminus" : "armed"));
  }

  function updateCrPhase(phase) {
    const meta = {
      idle:    { cls: "idle", label: "NO RESERVATION" },
      armed:   { cls: "armed", label: "STANDBY" },
      tminus:  { cls: "tminus", label: "T-MINUS" },
      firing:  { cls: "tminus", label: "FIRING" },
      success: { cls: "armed", label: "SECURED" },
      failed:  { cls: "failed", label: "FAILED" }
    }[phase] || { cls: "idle", label: "IDLE" };
    state.elements.crChip.className = `chip ${meta.cls}`;
    state.elements.crChipLabel.textContent = meta.label;
  }

  function fmtHms(ms) {
    const tot = Math.ceil(ms / 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(Math.floor(tot / 3600))}:${pad(Math.floor((tot % 3600) / 60))}:${pad(tot % 60)}`;
  }

  /* ── Step completion indicators ── */

  function updateStepStates() {
    const urlOk = Boolean(isEscapeTicketPageUrl(state.elements.targetUrl.value));
    state.elements.stepUrl.classList.toggle("done", urlOk);

    const triggerIso = toJstIsoStringFromDatetimeLocal(state.elements.triggerAt.value);
    const timeOk =
      state.triggerConfirmed && Boolean(triggerIso) && Number.isFinite(Date.parse(triggerIso));
    state.elements.stepTime.classList.toggle("done", timeOk);

    const ticketsOk = collectPlanRows().some((plan) => plan.targetQty > 0);
    state.elements.stepTickets.classList.toggle("done", ticketsOk);
  }

  function updateEventReadout() {
    const readout = state.elements.eventReadout;
    const text    = state.elements.eventTitleText;
    if (!readout || !text) {
      return;
    }
    if (state.eventTitle) {
      text.textContent = state.eventTitle;
      readout.classList.add("visible");
    } else {
      readout.classList.remove("visible");
    }
  }

  function normalizeTargetUrlForCompare(value) {
    const normalized = ensureEscapeUrl(value);
    if (normalized) {
      return normalized;
    }
    return String(value || "").trim();
  }

  function reservationFormKey(job) {
    if (!job) {
      return "";
    }
    const plans = Array.isArray(job.ticketPlans)
      ? job.ticketPlans.map((plan) => [
          String(plan.ticketLabel || ""),
          Number.parseInt(plan.targetQty, 10) || 0
        ])
      : [];
    return JSON.stringify({
      jobId: String(job.jobId || ""),
      targetUrl: normalizeTargetUrlForCompare(job.targetUrl || ""),
      triggerAtJst: String(job.triggerAtJst || ""),
      eventTitle: String(job.eventTitle || ""),
      heroImageUrl: ensureHttpsUrl(job.heroImageUrl),
      clickIntervalMs: Number.parseInt(job.clickIntervalMs, 10) || DEFAULT_JOB.clickIntervalMs,
      parallelTabCount: Number.parseInt(job.parallelTabCount, 10) || DEFAULT_JOB.parallelTabCount,
      requireAgreement: job.requireAgreement !== false,
      autoSelectRequiredOptions: job.autoSelectRequiredOptions !== false,
      plans
    });
  }

  function updateConfirmAttention() {
    const currentTargetUrl = normalizeTargetUrlForCompare(state.elements.targetUrl.value);
    const needsConfirm = Boolean(currentTargetUrl) && currentTargetUrl !== state.confirmedTargetUrl;
    state.elements.parseFormButton.classList.toggle("attention", needsConfirm);
    state.elements.parseFormButton.title = needsConfirm ? "URL変更後は確認してください" : "";
  }

  function updateStandbyAttention() {
    const qtyInputs = Array.from(
      state.elements.planRows.querySelectorAll("input[data-field='qty']")
    );
    const allZero =
      qtyInputs.length > 0 &&
      qtyInputs.every((input) => {
        const qty = Number.parseInt(String(input.value || "0"), 10);
        return !Number.isFinite(qty) || qty <= 0;
      });

    state.elements.saveButton.classList.toggle("attention", allZero);
    const blocked = allZero || !state.triggerConfirmed;
    state.elements.saveButton.disabled = blocked;
    state.elements.saveButton.title = allZero
      ? "数量がすべて0です。数量を見直してください。"
      : (!state.triggerConfirmed ? "実行時刻を確認してください。" : "");

    if (!state.armed) {
      setArmNote(
        allZero
          ? "数量がすべて0です。「3」で枚数を設定してください。"
          : (!state.triggerConfirmed ? "実行時刻を確認してください。" : ARM_NOTE_DEFAULT),
        false
      );
    }
  }

  function setStatus(text) {
    state.elements.statusText.textContent = String(text || "");
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response || { ok: false, error: "Empty response" });
      });
    });
  }
})(globalThis);
