(function contentScriptMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const {
    MESSAGE_TYPES,
    STATUS,
    DEFAULT_JOB,
    DEFAULT_PREFERENCES,
    normalizeLabel,
    sleep,
    nowEpoch,
    ensureEscapeUrl,
    ensureHttpsUrl,
    isReservableTicketUrl,
    createId,
    clampInt,
    getErrorMessage,
    buildReservationView,
    formatLocalDatetimeInput,
    toJstIsoStringFromDatetimeLocal
  } = shared;
  let activeRunId = null;
  let reservationPanel = null;
  const WAIT_INTERVAL_MS = 50;
  const WAIT_MAX_ATTEMPTS = 500;
  const LOCATION_POLL_MS = 250;
  const CONTEXT_INVALIDATED_ERROR_CODE = "E_EXTENSION_CONTEXT_INVALIDATED";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === MESSAGE_TYPES.PING) {
      sendResponse({ ok: true, page: location.href });
      return false;
    }

    if (message.type === MESSAGE_TYPES.PARSE_FORM_REQUEST) {
      void handleParseFormRequest(message)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error.message || "Parse failed"
          });
        });
      return true;
    }

    if (message.type === MESSAGE_TYPES.EXECUTE_REQUEST) {
      if (activeRunId) {
        sendResponse({ ok: false, error: "Execution is already running on this tab." });
        return false;
      }

      activeRunId = message.runId || `run_${Date.now()}`;
      sendResponse({ ok: true, accepted: true, runId: activeRunId });
      void runExecution(message)
        .catch((error) => {
          if (!isContextInvalidatedError(error)) {
            console.error("[TicketEscape] Execution failed outside result handling.", error);
          }
        })
        .finally(() => {
          activeRunId = null;
        });
      return false;
    }

    return false;
  });

  initReservationPanel();

  async function handleParseFormRequest(message) {
    const timeoutMs = Number.isFinite(message.timeoutMs) ? message.timeoutMs : 25000;
    const selectorOverrides = message.selectorOverrides || {};
    const { form, ticketRows } = await waitForTicketRows(timeoutMs, selectorOverrides);
    const tickets = ticketRows.map((row) => ({
      ticketLabel: row.label,
      currentQty: row.currentQty,
      priceText: row.priceText
    }));

    const requiredCheckboxes = form.querySelectorAll("input[type='checkbox'][required]").length;
    const allCheckboxes = form.querySelectorAll("input[type='checkbox']").length;

    const h1El = document.querySelector("h1");
    const eventTitle = h1El ? String(h1El.textContent || "").trim() : "";
    const heroImageUrl = extractHeroImageUrl(selectorOverrides);

    return {
      formFound: true,
      tickets,
      agreement: {
        requiredCount: requiredCheckboxes,
        totalCount: allCheckboxes
      },
      eventTitle,
      heroImageUrl
    };
  }

  // Main visual of the ticket page (§5). Primary selector is the user-specified
  // `div[class^="first"] img`; falls back to og:image, then the largest image.
  function extractHeroImageUrl(selectorOverrides) {
    const overrideSelector = selectorOverrides && selectorOverrides.heroImage;
    const candidates = [];
    if (overrideSelector) {
      candidates.push(() => {
        const el = document.querySelector(overrideSelector);
        return el ? el.currentSrc || el.src || el.getAttribute("src") : "";
      });
    }
    candidates.push(() => {
      const el = document.querySelector('div[class^="first"] img');
      return el ? el.currentSrc || el.src : "";
    });
    candidates.push(() => {
      const meta = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
      return meta ? meta.getAttribute("content") : "";
    });
    candidates.push(() => {
      let best = null;
      let bestArea = 0;
      for (const img of Array.from(document.images || [])) {
        const area = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
        if (area > bestArea) {
          bestArea = area;
          best = img;
        }
      }
      return best ? best.currentSrc || best.src : "";
    });

    for (const getCandidate of candidates) {
      try {
        const url = ensureHttpsUrl(toAbsoluteUrl(getCandidate()));
        if (url) {
          return url;
        }
      } catch (_) {
        // Move on to the next candidate.
      }
    }
    return "";
  }

  function toAbsoluteUrl(src) {
    try {
      return new URL(String(src || ""), location.href).toString();
    } catch (_) {
      return "";
    }
  }

  function initReservationPanel() {
    // Show the panel anywhere under escape.id; the resting state adapts to
    // whether there is an active reservation / a reservable form (§6).
    if (!ensureEscapeUrl(location.href)) {
      return;
    }

    const start = () => {
      if (reservationPanel) {
        return;
      }
      reservationPanel = createReservationPanel();
      document.documentElement.appendChild(reservationPanel.host);
      void reservationPanel.init();
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  function createReservationPanel() {
    const host = document.createElement("div");
    host.id = "ticketescape-reservation-panel";
    const shadow = host.attachShadow({ mode: "open" });
    const state = {
      mode: "scanning",
      job: null,
      status: null,
      preferences: { ...DEFAULT_PREFERENCES },
      tickets: [],
      eventTitle: "",
      heroImageUrl: "",
      triggerAtLocal: formatLocalDatetimeInput(Date.now() + 10 * 60 * 1000),
      triggerConfirmed: false,
      error: "",
      dismissed: false,
      paramWarning: false,
      launcherExpanded: false,
      pageStateKey: ""
    };
    let cdInterval = null;
    let locationPollInterval = null;

    shadow.innerHTML = `
      <style>
        :host {
          --te-bg: #0B0E13;
          --te-surface: #11161E;
          --te-surface-2: #171D27;
          --te-line: rgba(255,255,255,0.09);
          --te-line-strong: rgba(255,255,255,0.16);
          --te-text: #E7ECF2;
          --te-text-2: #AEB8C7;
          --te-text-mut: #8C97A8;
          --te-text-dim: #5C6675;
          --te-signal: #FFB224;
          --te-signal-fill: #FFB224;
          --te-signal-up: #FFC247;
          --te-signal-tint: rgba(255,178,36,0.12);
          --te-signal-line: rgba(255,178,36,0.38);
          --te-on-signal: #1A1206;
          --te-ok: #3FB950;
          --te-err: #F8513D;
          --te-r-sm: 6px;
          --te-r-md: 10px;
          --te-r-lg: 14px;
          --te-r-pill: 999px;
          --te-font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif;
          --te-mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          color: var(--te-text);
          font-family: var(--te-font);
          font-size: 13px;
        }
        * { box-sizing: border-box; }
        .panel {
          width: min(360px, calc(100vw - 24px));
          background: var(--te-surface);
          border: 1px solid var(--te-line);
          border-radius: var(--te-r-lg);
          box-shadow: 0 8px 24px rgba(0,0,0,.5);
          overflow: hidden;
        }
        .head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 11px 13px;
          border-bottom: 1px solid var(--te-line);
        }
        .brand { font-weight: 800; letter-spacing: -.01em; }
        .close, .badge {
          border: 1px solid var(--te-line-strong);
          background: var(--te-surface-2);
          color: var(--te-text-2);
          border-radius: var(--te-r-pill);
          cursor: pointer;
        }
        .close { width: 28px; height: 28px; }
        .body { display: grid; gap: 11px; padding: 13px; }
        .status {
          display: inline-flex;
          width: max-content;
          gap: 6px;
          align-items: center;
          padding: 4px 9px;
          border-radius: var(--te-r-pill);
          border: 1px solid var(--te-signal-line);
          background: var(--te-signal-tint);
          color: var(--te-signal);
          font-family: var(--te-mono);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: .12em;
        }
        .title { font-size: 14px; font-weight: 800; line-height: 1.45; }
        .muted { color: var(--te-text-mut); font-size: 12px; line-height: 1.55; }
        .btn {
          display: inline-flex;
          justify-content: center;
          align-items: center;
          width: 100%;
          min-height: 38px;
          border-radius: var(--te-r-md);
          border: 1px solid var(--te-signal-fill);
          background: var(--te-signal-fill);
          color: var(--te-on-signal);
          font-weight: 800;
          cursor: pointer;
        }
        .btn.secondary {
          background: transparent;
          color: var(--te-text-2);
          border-color: var(--te-line-strong);
        }
        .btn:disabled { cursor: not-allowed; opacity: .5; }
        .field { display: grid; gap: 5px; }
        .label {
          color: var(--te-text-mut);
          font-family: var(--te-mono);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: .12em;
          text-transform: uppercase;
        }
        .input {
          width: 100%;
          padding: 9px 10px;
          background: var(--te-surface-2);
          border: 1px solid var(--te-line);
          border-radius: var(--te-r-md);
          color: var(--te-text);
          font-family: var(--te-mono);
          font-size: 12px;
        }
        input[type="datetime-local"].input { color-scheme: dark; }
        .tickets { display: grid; gap: 6px; }
        .ticket {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 8px;
          align-items: center;
          padding: 7px 8px;
          border: 1px solid var(--te-line);
          border-radius: var(--te-r-md);
          background: var(--te-surface-2);
        }
        .ticket-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-weight: 700;
        }
        .stepper {
          display: inline-flex;
          align-items: center;
          border: 1px solid var(--te-line-strong);
          border-radius: var(--te-r-sm);
          overflow: hidden;
          background: var(--te-bg);
        }
        .stepper button {
          width: 28px;
          height: 28px;
          border: 0;
          background: transparent;
          color: var(--te-text-2);
          cursor: pointer;
        }
        .qty {
          width: 34px;
          height: 28px;
          border: 0;
          border-left: 1px solid var(--te-line);
          border-right: 1px solid var(--te-line);
          background: transparent;
          color: var(--te-text);
          text-align: center;
          font-family: var(--te-mono);
          font-weight: 800;
        }
        .note { color: var(--te-text-mut); font-size: 11.5px; line-height: 1.5; }
        .note.warn { color: var(--te-signal); }
        .hero-cd {
          font-family: var(--te-mono);
          font-size: 30px;
          font-weight: 600;
          letter-spacing: .02em;
          line-height: 1.1;
          color: var(--te-signal);
          font-variant-numeric: tabular-nums;
        }
        .chips { display: flex; flex-wrap: wrap; gap: 5px; }
        .tchip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 8px;
          border-radius: var(--te-r-pill);
          background: var(--te-surface-2);
          border: 1px solid var(--te-line);
          color: var(--te-text-2);
          font-size: 11px;
        }
        .tchip .q { font-family: var(--te-mono); font-weight: 700; color: var(--te-text); }
        .badge { padding: 9px 12px; font-weight: 800; color: var(--te-signal); }
        @media (max-width: 520px) {
          :host { left: 12px; right: 12px; bottom: 12px; }
          .panel { width: 100%; }
        }
      </style>
      <div id="root"></div>
    `;

    const root = shadow.getElementById("root");

    root.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-action]");
      if (!trigger) {
        return;
      }
      const action = trigger.dataset.action;
      if (action === "close") {
        state.dismissed = true;
        state.launcherExpanded = false;
        render();
      } else if (action === "show") {
        state.dismissed = false;
        state.launcherExpanded = true;
        render();
      } else if (action === "read") {
        void readTickets();
      } else if (action === "inc" || action === "dec") {
        adjustQty(Number.parseInt(trigger.dataset.index || "-1", 10), action);
      } else if (action === "save") {
        void saveReservation();
      } else if (action === "cancel") {
        void cancelReservation();
      } else if (action === "details") {
        void runtimeSendMessage({
          type: MESSAGE_TYPES.OPEN_OPTIONS_WITH_PAGE,
          page: {
            url: location.href,
            title: document.title,
            eventTitle: state.eventTitle,
            source: "content-panel"
          }
        }).catch(ignoreExpectedContextError);
      }
    });

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") {
          return;
        }
        if (changes[shared.STORAGE_KEYS.JOB] || changes[shared.STORAGE_KEYS.STATUS]) {
          void loadStatus().then(() => {
            reconcileMode();
            render();
          });
        }
      });
    }

    root.addEventListener("input", (event) => {
      const target = event.target;
      if (!target || !target.dataset) {
        return;
      }
      if (target.dataset.field === "trigger") {
        state.triggerAtLocal = target.value;
        state.triggerConfirmed = true;
      } else if (target.dataset.field === "qty") {
        const index = Number.parseInt(target.dataset.index || "-1", 10);
        if (state.tickets[index]) {
          state.tickets[index].targetQty = clampInt(target.value, 0, 0, 99);
        }
      }
      syncSaveState();
    });

    root.addEventListener("focusin", (event) => {
      const target = event.target;
      if (target && target.dataset && target.dataset.field === "trigger") {
        state.triggerConfirmed = true;
        syncSaveState();
      }
    });

    async function init() {
      await loadStatus();
      state.pageStateKey = currentPageStateKey();
      reconcileMode();
      render();
      startPageStateWatcher();
    }

    async function loadStatus() {
      try {
        const response = await runtimeSendMessage({ type: MESSAGE_TYPES.GET_STATUS });
        if (response && response.ok) {
          state.job = response.job || null;
          state.status = response.status || null;
          state.preferences = response.preferences || state.preferences;
        }
      } catch (_) {
        // Keep panel usable even if status read fails.
      }
    }

    // Transient editing modes are driven by user actions and must survive a
    // background storage change so in-progress input is never discarded.
    const TRANSIENT_MODES = new Set(["reading", "saving", "form", "read_failed"]);

    function reconcileMode() {
      if (TRANSIENT_MODES.has(state.mode)) {
        return;
      }
      state.mode = restingMode();
    }

    function restingMode() {
      const view = buildReservationView(state.job, state.status);
      const onReservedPage =
        state.job &&
        normalizeUrlForCompareLocal(state.job.targetUrl) === normalizeUrlForCompareLocal(location.href);
      if (view.hasReservation && onReservedPage) {
        return "armed";
      }
      if (view.hasReservation) {
        return canReadCurrentPage() ? "other_reserved" : "other_reserved_view";
      }
      if (canReadCurrentPage()) {
        return "ready";
      }
      return "launcher";
    }

    function startPageStateWatcher() {
      if (locationPollInterval !== null) {
        return;
      }
      // escape.id updates both URL and purchase form through client-side
      // routing, so poll the reflected browser state from the isolated world.
      const refresh = () => syncToCurrentPageState();
      globalScope.addEventListener("popstate", refresh);
      globalScope.addEventListener("hashchange", refresh);
      locationPollInterval = globalScope.setInterval(refresh, LOCATION_POLL_MS);
    }

    function syncToCurrentPageState() {
      const nextPageStateKey = currentPageStateKey();
      if (!nextPageStateKey || nextPageStateKey === state.pageStateKey) {
        return;
      }

      const previousMode = state.mode;
      state.pageStateKey = nextPageStateKey;
      state.paramWarning = false;
      if (previousMode !== "launcher") {
        state.launcherExpanded = false;
      }

      if (previousMode === "form" || previousMode === "read_failed") {
        clearPageDraftState();
      }

      if (previousMode !== "reading" && previousMode !== "saving") {
        state.mode = restingMode();
      }
      render();
    }

    function clearPageDraftState() {
      state.tickets = [];
      state.eventTitle = "";
      state.heroImageUrl = "";
      state.triggerAtLocal = formatLocalDatetimeInput(Date.now() + 10 * 60 * 1000);
      state.triggerConfirmed = false;
      state.error = "";
    }

    function currentPageStateKey() {
      const urlKey = normalizeUrlForCompareLocal(location.href);
      if (!urlKey) {
        return "";
      }
      return `${urlKey}|readable:${canReadCurrentPage() ? "1" : "0"}`;
    }

    function canReadCurrentPage() {
      if (isReservableTicketUrl(location.href)) {
        return true;
      }
      return hasPurchaseForm();
    }

    function hasPurchaseForm() {
      try {
        return Boolean(findFormRoot(state.preferences.selectorOverrides || {}));
      } catch (_) {
        return false;
      }
    }

    async function readTickets() {
      if (!canReadCurrentPage()) {
        state.paramWarning = true;
        render();
        return;
      }
      state.paramWarning = false;
      state.pageStateKey = currentPageStateKey();
      state.mode = "reading";
      state.error = "";
      render();
      try {
        const result = await handleParseFormRequest({
          timeoutMs: 25000,
          selectorOverrides: state.preferences.selectorOverrides || {}
        });
        const tickets = Array.isArray(result.tickets) ? result.tickets : [];
        if (!tickets.length) {
          throw makeError("E_TICKET_LIST_TIMEOUT", getErrorMessage("E_TICKET_LIST_TIMEOUT"));
        }
        state.eventTitle = String(result.eventTitle || "");
        state.heroImageUrl = ensureHttpsUrl(result.heroImageUrl);
        state.tickets = tickets.map((ticket) => ({
          ticketLabel: ticket.ticketLabel,
          targetQty: Number.parseInt(ticket.currentQty, 10) || 0
        }));
        state.triggerAtLocal = formatLocalDatetimeInput(Date.now() + 10 * 60 * 1000);
        state.triggerConfirmed = false;
        state.mode = "form";
      } catch (error) {
        if (isContextInvalidatedError(error)) {
          return;
        }
        state.mode = "read_failed";
        state.error = getErrorMessage(error.code, error.message || "読み取りに失敗しました。");
      }
      render();
    }

    function adjustQty(index, action) {
      if (!state.tickets[index]) {
        return;
      }
      const current = Number.parseInt(state.tickets[index].targetQty, 10) || 0;
      state.tickets[index].targetQty = action === "inc"
        ? Math.min(99, current + 1)
        : Math.max(0, current - 1);
      render();
    }

    async function saveReservation() {
      const targetUrl = ensureEscapeUrl(location.href);
      const triggerAtJst = toJstIsoStringFromDatetimeLocal(state.triggerAtLocal);
      if (!targetUrl || !canReadCurrentPage() || !triggerAtJst || !state.triggerConfirmed) {
        if (targetUrl && !canReadCurrentPage()) {
          state.error = getErrorMessage("E_URL_PARAMS_REQUIRED");
          render();
        }
        return;
      }
      if (!state.tickets.some((ticket) => Number(ticket.targetQty) > 0)) {
        return;
      }

      const existingOtherJob =
        state.job &&
        normalizeUrlForCompareLocal(state.job.targetUrl) !== normalizeUrlForCompareLocal(targetUrl);
      let replaceOptions = { replaceMode: state.job ? "update" : "create" };
      if (existingOtherJob) {
        const ok = globalScope.confirm("別の予約が実行待機中です。現在の予約をこのページに切り替えますか？");
        if (!ok) {
          return;
        }
        replaceOptions = {
          replaceMode: "replace",
          replaceConfirmed: true,
          expectedPreviousJobId: state.job.jobId
        };
      }

      const job = {
        jobId: existingOtherJob || !state.job ? createId("job") : state.job.jobId,
        targetUrl,
        triggerAtJst,
        triggerAtConfirmed: true,
        eventTitle: state.eventTitle,
        heroImageUrl: state.heroImageUrl,
        clickIntervalMs: state.preferences.clickIntervalMs || DEFAULT_JOB.clickIntervalMs,
        parallelTabCount: state.preferences.parallelTabCount || DEFAULT_JOB.parallelTabCount,
        requireAgreement: state.preferences.requireAgreement !== false,
        ticketPlans: state.tickets.map((ticket) => ({
          ticketLabel: ticket.ticketLabel,
          targetQty: Number.parseInt(ticket.targetQty, 10) || 0
        }))
      };

      state.mode = "saving";
      render();
      try {
        const response = await runtimeSendMessage({
          type: MESSAGE_TYPES.SAVE_JOB,
          job,
          ...replaceOptions
        });
        if (!response || !response.ok) {
          throw makeError(response && response.code, response && response.error);
        }
        state.job = response.job;
        state.mode = restingMode();
      } catch (error) {
        state.mode = "form";
        state.error = getErrorMessage(error.code, error.message || "予約登録に失敗しました。");
      }
      render();
    }

    async function cancelReservation() {
      const ok = globalScope.confirm("現在の予約を取り消しますか？");
      if (!ok) {
        return;
      }
      // Re-read the live job so cancel always targets the currently-stored
      // reservation, never a stale local copy (§3.2).
      let liveJob = state.job;
      try {
        const jobResponse = await runtimeSendMessage({ type: MESSAGE_TYPES.GET_JOB });
        if (jobResponse && jobResponse.ok) {
          liveJob = jobResponse.job || null;
        }
      } catch (_) {
        // Fall back to the local snapshot.
      }
      if (!liveJob || !liveJob.jobId) {
        state.job = null;
        state.mode = restingMode();
        render();
        return;
      }

      const previousMode = state.mode;
      state.mode = "saving";
      render();
      try {
        const response = await runtimeSendMessage({
          type: MESSAGE_TYPES.CANCEL_JOB,
          expectedJobId: liveJob.jobId
        });
        if (!response || !response.ok) {
          throw makeError(response && response.code, response && response.error);
        }
        state.job = null;
        state.error = "";
        state.mode = restingMode();
      } catch (error) {
        state.mode = previousMode;
        state.error = getErrorMessage(error.code, error.message || "予約取り消しに失敗しました。");
      }
      render();
    }

    function render() {
      stopCountdown();

      if (state.dismissed) {
        root.innerHTML = '<button class="badge" type="button" data-action="show">TicketEscape</button>';
        return;
      }

      if (state.mode === "launcher") {
        if (!state.launcherExpanded) {
          root.innerHTML =
            '<button class="badge" type="button" data-action="show" title="TicketEscapeを開く">TicketEscape</button>';
          return;
        }
        root.innerHTML = panel(`
          <span class="status">IDLE</span>
          <div class="title">TicketEscape</div>
          <div class="muted">購入ページを開くと、このパネルから予約できます。</div>
          <button class="btn secondary" type="button" data-action="details">詳細コンソールで開く</button>
        `);
        return;
      }

      if (state.mode === "armed") {
        const view = buildReservationView(state.job, state.status);
        const title = view.eventTitle || (state.job && state.job.eventTitle) || "このページ";
        root.innerHTML = panel(`
          <span class="status">STANDBY</span>
          <div class="hero-cd" id="tePanelCd">${escapeHtml(fmtRemaining(view.remainingMs))}</div>
          <div class="title">${escapeHtml(title)}</div>
          <div class="muted">このページは予約されています。0秒で自動実行します。</div>
          ${ticketChipsHtml(view.ticketSummary)}
          <button class="btn secondary" type="button" data-action="cancel">予約取り消し</button>
          <button class="btn secondary" type="button" data-action="details">詳細コンソールで開く</button>
        `);
        startCountdown();
        return;
      }

      if (state.mode === "other_reserved" || state.mode === "other_reserved_view") {
        const view = buildReservationView(state.job, state.status);
        const title = view.eventTitle || "別の公演";
        const canReserveHere = state.mode === "other_reserved";
        root.innerHTML = panel(`
          <span class="status">STANDBY</span>
          <div class="hero-cd" id="tePanelCd">${escapeHtml(fmtRemaining(view.remainingMs))}</div>
          <div class="title">${escapeHtml(title)}</div>
          <div class="muted">別の公演を予約中です${view.triggerJstText ? `（${escapeHtml(view.triggerJstText)}）` : ""}。</div>
          ${ticketChipsHtml(view.ticketSummary)}
          ${canReserveHere ? '<button class="btn" type="button" data-action="read">このページを予約する</button>' : ""}
          <button class="btn secondary" type="button" data-action="cancel">予約取り消し</button>
          <button class="btn secondary" type="button" data-action="details">詳細コンソールで開く</button>
        `);
        startCountdown();
        return;
      }

      if (state.mode === "reading" || state.mode === "saving") {
        root.innerHTML = panel(`
          <span class="status">${state.mode === "reading" ? "READING" : "SAVING"}</span>
          <div class="title">${state.mode === "reading" ? "情報を読み取り中" : "処理中"}</div>
          <div class="muted">少し待ってください。</div>
        `);
        return;
      }

      if (state.mode === "form") {
        root.innerHTML = panel(`
          <span class="status">READY</span>
          <div class="title">${escapeHtml(state.eventTitle || "公演情報")}</div>
          <div class="field">
            <div class="label">券種</div>
            <div class="tickets">
              ${state.tickets.map((ticket, index) => renderTicket(ticket, index)).join("")}
            </div>
          </div>
          <div class="field">
            <div class="label">実行時刻 (JST)</div>
            <input class="input" data-field="trigger" type="datetime-local" step="1" value="${escapeHtml(state.triggerAtLocal)}" />
          </div>
          ${state.error ? `<div class="note warn">${escapeHtml(state.error)}</div>` : ""}
          <div id="tePanelNote" class="note"></div>
          <button id="tePanelSave" class="btn" type="button" data-action="save">予約</button>
          <button class="btn secondary" type="button" data-action="cancel" ${state.job ? "" : "disabled"}>予約取り消し</button>
          <button class="btn secondary" type="button" data-action="details">詳細コンソールで開く</button>
        `);
        syncSaveState();
        return;
      }

      if (state.mode === "read_failed") {
        root.innerHTML = panel(`
          <span class="status">FAILED</span>
          <div class="title">読み取れませんでした</div>
          <div class="note warn">${escapeHtml(state.error)}</div>
          <button class="btn" type="button" data-action="read">再読み取り</button>
          <button class="btn secondary" type="button" data-action="details">詳細コンソールで開く</button>
        `);
        return;
      }

      root.innerHTML = panel(`
        <span class="status">READY</span>
        <div class="title">このページを予約できます</div>
        <div class="muted">指定時刻にこのページを開き、選んだ数量でカート投入します。</div>
        ${state.paramWarning ? `<div class="note warn">${escapeHtml(getErrorMessage("E_URL_PARAMS_REQUIRED"))}</div>` : ""}
        <button class="btn" type="button" data-action="read">このチケットを予約する</button>
        <button class="btn secondary" type="button" data-action="cancel" ${state.job ? "" : "disabled"}>予約取り消し</button>
        <button class="btn secondary" type="button" data-action="details">詳細コンソールで開く</button>
      `);
    }

    function panel(innerHtml) {
      return `
        <section class="panel" role="region" aria-label="TicketEscape">
          <div class="head">
            <div class="brand">TicketEscape</div>
            <button class="close" type="button" data-action="close" aria-label="閉じる">×</button>
          </div>
          <div class="body">${innerHtml}</div>
        </section>
      `;
    }

    function renderTicket(ticket, index) {
      const qty = Number.parseInt(ticket.targetQty, 10) || 0;
      return `
        <div class="ticket">
          <div class="ticket-name" title="${escapeHtml(ticket.ticketLabel)}">${escapeHtml(ticket.ticketLabel)}</div>
          <div class="stepper">
            <button type="button" data-action="dec" data-index="${index}" aria-label="数量を減らす">−</button>
            <input class="qty" data-field="qty" data-index="${index}" type="number" min="0" max="99" value="${qty}" />
            <button type="button" data-action="inc" data-index="${index}" aria-label="数量を増やす">＋</button>
          </div>
        </div>
      `;
    }

    function syncSaveState() {
      const button = shadow.getElementById("tePanelSave");
      const note = shadow.getElementById("tePanelNote");
      if (!button || !note) {
        return;
      }
      const hasQty = state.tickets.some((ticket) => Number(ticket.targetQty) > 0);
      const blocked = !hasQty || !state.triggerConfirmed;
      button.disabled = blocked;
      note.classList.toggle("warn", blocked);
      if (!hasQty) {
        note.textContent = "予約するには、1枚以上の数量を設定してください。";
      } else if (!state.triggerConfirmed) {
        note.textContent = "実行時刻を確認してください。";
      } else {
        note.textContent = "指定時刻にこのページを開き、選んだ数量でカート投入します。";
      }
    }

    function startCountdown() {
      stopCountdown();
      updateCountdownNode();
      cdInterval = globalScope.setInterval(updateCountdownNode, 250);
    }

    function stopCountdown() {
      if (cdInterval !== null) {
        globalScope.clearInterval(cdInterval);
        cdInterval = null;
      }
    }

    function updateCountdownNode() {
      const node = shadow.getElementById("tePanelCd");
      if (!node) {
        stopCountdown();
        return;
      }
      const view = buildReservationView(state.job, state.status);
      if (!view.hasReservation) {
        stopCountdown();
        return;
      }
      node.textContent = fmtRemaining(view.remainingMs);
    }

    return { host, init };
  }

  function normalizeUrlForCompareLocal(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""));
      return `${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch (_) {
      return "";
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtRemaining(ms) {
    if (!Number.isFinite(ms)) {
      return "--:--:--";
    }
    const total = Math.max(0, Math.ceil(ms / 1000));
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  }

  function ticketChipsHtml(summary) {
    if (!Array.isArray(summary) || !summary.length) {
      return "";
    }
    const chips = summary
      .map((ticket) => `<span class="tchip">${escapeHtml(ticket.ticketLabel)}<span class="q">×${Number(ticket.targetQty)}</span></span>`)
      .join("");
    return `<div class="chips">${chips}</div>`;
  }

  async function runExecution(message) {
    const job = message.job || {};
    const runId = message.runId || `run_${Date.now()}`;
    const runResult = {
      jobId: job.jobId || "unknown",
      runId,
      pageUrl: location.href,
      startedAt: nowEpoch(),
      finishedAt: null,
      status: STATUS.FAILED,
      errorCode: null,
      errorDetail: null,
      steps: []
    };

    const addStep = (step, detail) => {
      runResult.steps.push({
        at: nowEpoch(),
        step,
        detail: detail || ""
      });
      void sendStatusUpdate({
        jobId: runResult.jobId,
        runId,
        status: step,
        detail: detail || ""
      });
    };

    try {
      addStep(STATUS.WAIT_FORM, "Waiting for ticket form");
      const { form, ticketRows } = await waitForTicketRows(25000, job.selectorOverrides || {});

      addStep(STATUS.PREPARE_TICKETS, "Adjusting ticket quantities");
      await applyTicketPlan(ticketRows, job.ticketPlans || [], job.clickIntervalMs || 30);

      addStep(STATUS.PREPARE_TICKETS, "Checking all checkboxes in form");
      await ensureAgreementChecks(form, job.requireAgreement !== false);

      addStep(STATUS.WAIT_TRIGGER, "Waiting for trigger timestamp");
      await waitForTrigger(message.triggerEpoch);

      addStep(STATUS.CLICK_SUBMIT, "Clicking submit button");
      const submitResult = await submitCart(form, job.selectorOverrides || {});
      if (!submitResult.ok) {
        throw makeError("E_SUBMIT_NOT_APPLIED", submitResult.error || "Submit action was not reflected.");
      }

      addStep(STATUS.VERIFY_RESULT, "Verifying result");
      runResult.status = STATUS.SUCCESS;
      runResult.finishedAt = nowEpoch();
      await sendExecuteResult(runResult);
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        return;
      }
      runResult.status = STATUS.FAILED;
      runResult.errorCode = error.code || "E_EXECUTION_FAILED";
      runResult.errorDetail = error.message || "Execution failed.";
      runResult.finishedAt = nowEpoch();
      addStep(STATUS.FAILED, `${runResult.errorCode}: ${runResult.errorDetail}`);
      await sendExecuteResult(runResult);
    }
  }

  function makeError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function makeContextInvalidatedError(message) {
    return makeError(CONTEXT_INVALIDATED_ERROR_CODE, message || "Extension context invalidated.");
  }

  function isContextInvalidatedError(error) {
    if (!error) {
      return false;
    }
    return (
      error.code === CONTEXT_INVALIDATED_ERROR_CODE ||
      /Extension context invalidated/i.test(String(error.message || ""))
    );
  }

  function isExtensionContextAvailable() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function pauseForInvalidatedContext() {
    return new Promise(() => {});
  }

  async function sleepWithContextCheck(ms) {
    if (!isExtensionContextAvailable()) {
      await pauseForInvalidatedContext();
      return;
    }
    await sleep(ms);
    if (!isExtensionContextAvailable()) {
      await pauseForInvalidatedContext();
    }
  }

  async function waitForFrameWithContextCheck() {
    if (!isExtensionContextAvailable()) {
      await pauseForInvalidatedContext();
      return;
    }
    await new Promise((resolve) => {
      if (
        typeof requestAnimationFrame === "function" &&
        (typeof document === "undefined" || document.visibilityState === "visible")
      ) {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
    if (!isExtensionContextAvailable()) {
      await pauseForInvalidatedContext();
    }
  }

  function ignoreExpectedContextError(error) {
    if (!isContextInvalidatedError(error)) {
      console.warn("[TicketEscape] Ignored async extension error.", error);
    }
  }

  async function waitForAsync(getter, options) {
    const opts = options || {};
    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : WAIT_INTERVAL_MS;
    const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : WAIT_MAX_ATTEMPTS;
    const isReady = typeof opts.isReady === "function" ? opts.isReady : (value) => Boolean(value);
    let lastGetterError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let value = null;
      try {
        value = getter();
        lastGetterError = null;
      } catch (error) {
        lastGetterError = error;
      }
      if (isReady(value)) {
        return value;
      }
      await sleepWithContextCheck(intervalMs);
    }

    if (lastGetterError) {
      throw makeError(
        opts.errorCode || "E_WAIT_TIMEOUT",
        `${opts.errorMessage || "Async wait timed out."} cause=${lastGetterError.message || "unknown"}`
      );
    }
    throw makeError(opts.errorCode || "E_WAIT_TIMEOUT", opts.errorMessage || "Async wait timed out.");
  }

  function findFormRoot(selectorOverrides) {
    if (selectorOverrides && selectorOverrides.formRoot) {
      const overrideRoot = document.querySelector(selectorOverrides.formRoot);
      if (overrideRoot) {
        return overrideRoot;
      }
    }

    const primary = document.querySelector("form.flex-1");
    if (primary) {
      return primary;
    }

    const forms = Array.from(document.querySelectorAll("form"));
    for (const form of forms) {
      if (findSubmitButton(form, selectorOverrides)) {
        return form;
      }
    }

    return null;
  }

  async function waitForTicketRows(timeoutMs, selectorOverrides) {
    const maxAttempts = timeoutMs
      ? Math.max(1, Math.min(WAIT_MAX_ATTEMPTS, Math.ceil(timeoutMs / WAIT_INTERVAL_MS)))
      : WAIT_MAX_ATTEMPTS;

    const form = await waitForAsync(() => findFormRoot(selectorOverrides), {
      maxAttempts,
      errorCode: "E_FORM_TIMEOUT",
      errorMessage: "Ticket form did not appear before timeout."
    });

    const ticketRows = await waitForAsync(() => extractTicketRows(form), {
      maxAttempts,
      isReady: (rows) => Array.isArray(rows) && rows.length > 0,
      errorCode: "E_TICKET_LIST_TIMEOUT",
      errorMessage: "Form found but ticket rows are not ready yet."
    });

    return { form, ticketRows };
  }

  function extractTicketRows(form) {
    const ticketList = findTicketList(form);
    if (!ticketList) {
      return [];
    }

    const candidates = getDirectLiChildren(ticketList);
    return candidates
      .map((row) => buildTicketRow(row))
      .filter((row) => row && row.label);
  }

  function findTicketList(form) {
    const lists = Array.from(form.querySelectorAll("ul"));
    let bestList = null;
    let bestScore = 0;

    for (const list of lists) {
      const items = getDirectLiChildren(list);
      if (!items.length) {
        continue;
      }

      let score = 0;
      for (const item of items) {
        const label = findTicketLabelFromRow(item);
        if (label) {
          score += 2;
        }
        const counter = findCounterControls(item);
        if (counter) {
          score += 3;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestList = list;
      }
    }

    return bestList;
  }

  function getDirectLiChildren(list) {
    return Array.from(list.children).filter((child) => child && child.tagName === "LI");
  }

  function buildTicketRow(row) {
    const label = findTicketLabelFromRow(row);
    if (!label) {
      return null;
    }

    const priceText = findPriceText(row);
    const counter = findCounterControls(row);
    const qtyNode = (counter && counter.qtyNode) || findQuantityNodeFallback(row);
    const currentQty = qtyNode ? parseQuantity(qtyNode.textContent) : 0;

    return {
      row,
      label,
      priceText,
      qtyNode,
      currentQty,
      minusButton: counter ? counter.minusButton : null,
      plusButton: counter ? counter.plusButton : null
    };
  }

  function findTicketLabelFromRow(row) {
    const paragraphs = Array.from(row.querySelectorAll("p"));
    for (const p of paragraphs) {
      const text = String(p.textContent || "").trim();
      if (!text) {
        continue;
      }
      if (/^\d+$/.test(text)) {
        continue;
      }
      if (/円/.test(text)) {
        continue;
      }
      return text;
    }
    return "";
  }

  function findPriceText(row) {
    const paragraphs = Array.from(row.querySelectorAll("p"));
    for (const p of paragraphs) {
      const text = String(p.textContent || "").trim();
      if (/円/.test(text)) {
        return text;
      }
    }
    return "";
  }

  function findQuantityNodeFallback(row) {
    const paragraphs = Array.from(row.querySelectorAll("p"));
    for (const p of paragraphs) {
      const text = String(p.textContent || "").trim();
      if (/^\d+$/.test(text)) {
        return p;
      }
    }
    return null;
  }

  function findCounterControls(row) {
    const containers = Array.from(row.querySelectorAll("div"));
    for (const container of containers) {
      const children = Array.from(container.children);
      if (children.length < 3) {
        continue;
      }

      for (let i = 0; i <= children.length - 3; i += 1) {
        const first = children[i];
        const second = children[i + 1];
        const third = children[i + 2];
        if (!first || !second || !third) {
          continue;
        }
        if (first.tagName !== "BUTTON" || second.tagName !== "P" || third.tagName !== "BUTTON") {
          continue;
        }

        const qtyText = String(second.textContent || "").trim();
        if (!/^\d+$/.test(qtyText)) {
          continue;
        }

        return {
          minusButton: first,
          qtyNode: second,
          plusButton: third
        };
      }
    }
    return null;
  }

  async function waitForCounterControlsAsync(rowInfo) {
    const counter = await waitForAsync(() => findCounterControls(rowInfo.row), {
      errorCode: "E_COUNTER_TIMEOUT",
      errorMessage: `Counter controls not found for ${rowInfo.label}`
    });

    rowInfo.minusButton = counter.minusButton;
    rowInfo.plusButton = counter.plusButton;
    rowInfo.qtyNode = counter.qtyNode || rowInfo.qtyNode;
    return counter;
  }

  function parseQuantity(value) {
    const normalized = String(value || "").replace(/[^\d]/g, "");
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getCurrentQty(rowInfo) {
    if (!rowInfo.qtyNode) {
      return 0;
    }
    return parseQuantity(rowInfo.qtyNode.textContent);
  }

  async function applyTicketPlan(ticketRows, ticketPlans, clickIntervalMs) {
    if (!ticketPlans.length) {
      return;
    }

    for (const plan of ticketPlans) {
      const rowInfo = findRowByTicketLabel(ticketRows, plan.ticketLabel);
      if (!rowInfo) {
        const available = ticketRows.map((row) => row.label).join(", ");
        throw makeError(
          "E_TICKET_NOT_FOUND",
          `Ticket not found: ${plan.ticketLabel}. available=[${available}]`
        );
      }

      const targetQty = Math.max(0, Number.parseInt(plan.targetQty, 10) || 0);
      await adjustQty(rowInfo, targetQty, clickIntervalMs);
    }
  }

  function findRowByTicketLabel(ticketRows, ticketLabel) {
    const normalizedPlan = normalizeLabel(ticketLabel);
    if (!normalizedPlan) {
      return null;
    }

    const exact = ticketRows.find((row) => normalizeLabel(row.label) === normalizedPlan);
    if (exact) {
      return exact;
    }

    return (
      ticketRows.find((row) => {
        const normalizedRow = normalizeLabel(row.label);
        return normalizedRow.includes(normalizedPlan) || normalizedPlan.includes(normalizedRow);
      }) || null
    );
  }

  async function adjustQty(rowInfo, targetQty, clickIntervalMs) {
    const maxClickCount = 60;
    let guard = 0;

    await waitForCounterControlsAsync(rowInfo);
    const firstQty = getCurrentQty(rowInfo);
    if (targetQty === 1 && firstQty === 0) {
      await waitForAsync(
        () => (rowInfo.plusButton && !rowInfo.plusButton.disabled ? rowInfo.plusButton : null),
        {
          errorCode: "E_QTY_ADJUST_FAILED",
          errorMessage: `Plus button is not clickable for ${rowInfo.label}`
        }
      );
      rowInfo.plusButton.click();
      await sleepWithContextCheck(clickIntervalMs);
      await waitForQtyChange(rowInfo, firstQty, 200);
      if (getCurrentQty(rowInfo) === 1) {
        return;
      }
    }

    while (guard < maxClickCount) {
      await waitForCounterControlsAsync(rowInfo);
      const current = getCurrentQty(rowInfo);
      if (current === targetQty) {
        return;
      }

      const shouldIncrease = current < targetQty;
      const button = await waitForAsync(
        () => {
          const targetButton = shouldIncrease ? rowInfo.plusButton : rowInfo.minusButton;
          return targetButton && !targetButton.disabled ? targetButton : null;
        },
        {
          errorCode: "E_QTY_ADJUST_FAILED",
          errorMessage: `Ticket button is disabled or missing for ${rowInfo.label}`
        }
      );

      const before = current;
      button.click();
      await sleepWithContextCheck(clickIntervalMs);
      await waitForQtyChange(rowInfo, before, 150);
      guard += 1;
    }

    throw makeError("E_QTY_ADJUST_FAILED", `Unable to reach target quantity for ${rowInfo.label}`);
  }

  async function waitForQtyChange(rowInfo, beforeQty, timeoutMs) {
    const start = nowEpoch();
    while (nowEpoch() - start <= timeoutMs) {
      if (getCurrentQty(rowInfo) !== beforeQty) {
        return;
      }
      await sleepWithContextCheck(WAIT_INTERVAL_MS);
    }
  }

  async function ensureAgreementChecks(form, requireAgreement) {
    if (!requireAgreement) {
      return;
    }

    const checkboxes = Array.from(form.querySelectorAll("input[type='checkbox']"));

    for (const checkbox of checkboxes) {
      if (checkbox.disabled) {
        continue;
      }

      if (checkbox.checked) {
        continue;
      }

      checkbox.click();
      await sleepWithContextCheck(15);
      if (checkbox.checked) {
        continue;
      }

      const label = checkbox.id
        ? form.querySelector(`label[for="${cssEscape(checkbox.id)}"]`)
        : null;
      if (label) {
        label.click();
        await sleepWithContextCheck(15);
      }

      if (!checkbox.checked) {
        throw makeError("E_AGREEMENT_NOT_CHECKED", "Failed to check checkbox in form.");
      }
    }
  }

  function cssEscape(value) {
    if (globalScope.CSS && typeof globalScope.CSS.escape === "function") {
      return globalScope.CSS.escape(value);
    }
    return String(value).replace(/"/g, '\\"');
  }

  async function waitForTrigger(triggerEpoch) {
    if (!Number.isFinite(triggerEpoch)) {
      return;
    }
    if (!isExtensionContextAvailable()) {
      await pauseForInvalidatedContext();
      return;
    }

    let remaining = triggerEpoch - Date.now();
    if (remaining <= 0) {
      return;
    }

    if (remaining > 2000) {
      await sleepWithContextCheck(remaining - 1500);
    }

    while (Date.now() < triggerEpoch - 32) {
      remaining = triggerEpoch - Date.now();
      await sleepWithContextCheck(Math.max(1, Math.min(50, remaining - 16)));
    }

    while (Date.now() < triggerEpoch) {
      await waitForFrameWithContextCheck();
    }
  }

  function findSubmitButton(form, selectorOverrides) {
    if (selectorOverrides && selectorOverrides.submitButton) {
      const overrideButton = form.querySelector(selectorOverrides.submitButton);
      if (overrideButton) {
        return overrideButton;
      }
    }

    const byType = form.querySelector("button[type='submit']");
    if (byType) {
      return byType;
    }

    const normalizedTarget = normalizeLabel("カートに入れる");
    const buttons = Array.from(form.querySelectorAll("button"));
    return (
      buttons.find((button) => normalizeLabel(button.textContent || "").includes(normalizedTarget)) ||
      null
    );
  }

  async function submitCart(form, selectorOverrides) {
    const beforeHref = location.href;
    let currentForm = form;

    for (let attempt = 0; attempt < WAIT_MAX_ATTEMPTS; attempt += 1) {
      if (location.href !== beforeHref) {
        return { ok: true };
      }
      if (currentForm && !document.contains(currentForm)) {
        return { ok: true };
      }

      const refreshedForm = findFormRoot(selectorOverrides);
      if (refreshedForm) {
        currentForm = refreshedForm;
      }

      const button = currentForm ? findSubmitButton(currentForm, selectorOverrides) : null;
      if (button && !button.disabled) {
        button.click();
      }

      await sleepWithContextCheck(WAIT_INTERVAL_MS);
    }

    return {
      ok: false,
      error: "Submit action was not reflected after repeated retries."
    };
  }

  async function sendStatusUpdate(payload) {
    try {
      await runtimeSendMessage({
        type: MESSAGE_TYPES.STATUS_UPDATE,
        ...payload
      });
    } catch (_) {
      // Ignore status report errors.
    }
  }

  async function sendExecuteResult(result) {
    try {
      await runtimeSendMessage({
        type: MESSAGE_TYPES.EXECUTE_RESULT,
        result
      });
    } catch (_) {
      // Ignore completion report errors.
    }
  }

  function runtimeSendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        if (!isExtensionContextAvailable()) {
          reject(makeContextInvalidatedError());
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(response || null);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
})(globalThis);
