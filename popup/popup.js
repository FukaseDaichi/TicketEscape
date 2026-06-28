(function popupMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const {
    MESSAGE_TYPES,
    STORAGE_KEYS,
    STATUS,
    isEscapeTicketPageUrl,
    getErrorMessage,
    buildReservationView,
    reservationPhase
  } = shared;

  /* ── Inline monoline icons (no emoji) — inherit currentColor ── */
  const ICON = {
    link:
      '<svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 1 0-5-5l-1.2 1.2"/><path d="M14.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 1 0 5 5l1.2-1.2"/></svg>',
    calendar:
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 9.5h16"/></svg>',
    ticket:
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.2a1.6 1.6 0 0 1 1.6-1.6h13.8a1.6 1.6 0 0 1 1.6 1.6v1.1a1.7 1.7 0 0 0 0 3.4v1.1a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6v-1.1a1.7 1.7 0 0 0 0-3.4z"/><path d="M14.6 8v8"/></svg>',
    ticketSm:
      '<svg class="ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.2a1.6 1.6 0 0 1 1.6-1.6h13.8a1.6 1.6 0 0 1 1.6 1.6v1.1a1.7 1.7 0 0 0 0 3.4v1.1a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6v-1.1a1.7 1.7 0 0 0 0-3.4z"/><path d="M14.6 8v8"/></svg>',
    check:
      '<svg class="ico-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" stroke-width="1.4"/><path d="M7.5 12.3l3 3 6-6.6"/></svg>',
    cross:
      '<svg class="ico-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" stroke-width="1.4"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>',
    reticle:
      '<svg class="ico-lg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="16" cy="16" r="12" stroke-dasharray="2 3.6"/><circle cx="16" cy="16" r="4"/><circle cx="16" cy="16" r="0.8" fill="currentColor" stroke="none"/></svg>'
  };

  const el = {};
  let cdIntervalId = null;
  let currentJob = null;
  let currentStatus = null;
  let activeTab = null;

  document.addEventListener("DOMContentLoaded", () => {
    bindElements();
    bindEvents();
    void loadStatus();
  });

  function bindElements() {
    el.statusChip      = document.getElementById("statusChip");
    el.statusChipLabel = document.getElementById("statusChipLabel");
    el.hero            = document.getElementById("hero");
    el.mainCard        = document.getElementById("mainCard");
    el.openOptions     = document.getElementById("openOptionsButton");
  }

  function bindEvents() {
    el.openOptions.addEventListener("click", () => {
      void openConsole();
    });
    el.mainCard.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-action]");
      if (!trigger) {
        return;
      }
      if (trigger.dataset.action === "cancel-popup") {
        void cancelPopupJob();
      } else if (trigger.dataset.action === "open-console") {
        void openConsole();
      }
    });
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") {
          return;
        }
        if (changes[STORAGE_KEYS.JOB] || changes[STORAGE_KEYS.STATUS]) {
          void loadStatus();
        }
      });
    }
  }

  /* Open the detail console. Hand off the current tab as a draft when it is a
     reservable escape.id ticket page; otherwise just open the console. */
  async function openConsole() {
    if (activeTab && isEscapeTicketPageUrl(activeTab.url)) {
      try {
        await sendMessage({
          type: MESSAGE_TYPES.OPEN_OPTIONS_WITH_PAGE,
          page: {
            url: activeTab.url,
            tabId: activeTab.id,
            title: activeTab.title || "",
            source: "popup"
          }
        });
        return;
      } catch (_) {
        // Fall back to the plain console opener.
      }
    }
    await openOptionsPage();
  }

  /* Open the options page as a tab in the CURRENT window, reusing an existing
     options tab if one is open. Falls back to the built-in opener on error. */
  async function openOptionsPage() {
    const optionsUrl = chrome.runtime.getURL("options/options.html");
    try {
      const existing = await chrome.tabs.query({ url: optionsUrl });
      if (existing && existing.length) {
        const tab = existing[0];
        await chrome.tabs.update(tab.id, { active: true });
        if (typeof tab.windowId === "number") {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url: optionsUrl });
      }
    } catch (_) {
      chrome.runtime.openOptionsPage();
    }
  }

  async function loadStatus() {
    try {
      const [res, tab] = await Promise.all([
        sendMessage({ type: MESSAGE_TYPES.GET_STATUS }),
        getActiveTab()
      ]);
      activeTab = tab;
      if (!res.ok) {
        currentJob = null;
        currentStatus = null;
        applyPhase("idle", NaN);
        renderEmpty("ステータス取得に失敗しました");
        return;
      }
      currentJob = res.job || null;
      currentStatus = res.status || null;
      render();
    } catch (err) {
      currentJob = null;
      currentStatus = null;
      applyPhase("idle", NaN);
      renderEmpty(err.message);
    }
  }

  /* ── Main render (single source: the shared reservation view) ── */

  function render() {
    const view = buildReservationView(currentJob, currentStatus);

    if (view.hasReservation) {
      renderReservation(view);
      if (view.phase === "armed" || view.phase === "tminus") {
        startCountdown(view.triggerEpoch);
      } else {
        stopCountdown();
        applyPhase(view.phase, view.remainingMs);
      }
      return;
    }

    stopCountdown();
    applyPhase(view.phase, view.remainingMs);
    if (activeTab && isEscapeTicketPageUrl(activeTab.url)) {
      renderOnTarget();
    } else {
      renderEmpty(null);
    }
  }

  /* ── Phase UI (status chip + hero countdown / result) ── */

  const PHASE_META = {
    idle:    { code: "IDLE",    eyebrow: "カウントダウン", sub: "実行待機していません" },
    armed:   { code: "STANDBY", eyebrow: "発売まで",       sub: "0 秒で購入ページへ遷移します" },
    tminus:  { code: "T-MINUS", eyebrow: "まもなく発射",   sub: "このまま画面を閉じないでください" },
    firing:  { code: "FIRING",  eyebrow: "実行中",         sub: "カート投入を実行しています" },
    success: { code: "SECURED", title: "確保成功",         sub: "カート投入が完了しました" },
    failed:  { code: "FAILED",  title: "実行失敗",         sub: "詳細コンソールでログを確認してください" }
  };

  function applyPhase(phase, remainingMs) {
    const meta = PHASE_META[phase] || PHASE_META.idle;

    el.statusChip.className = `chip ${phase}`;
    el.statusChipLabel.textContent = meta.code;

    if (phase === "success" || phase === "failed") {
      el.hero.innerHTML = `
        <div class="hero-result" style="color:var(${phase === "success" ? "--te-ok" : "--te-err"})">
          ${phase === "success" ? ICON.check : ICON.cross}
          <div>
            <div class="hero-result-title">${meta.title}</div>
            <div class="hero-sub">${meta.sub}</div>
          </div>
        </div>`;
      return;
    }

    const value = phase === "firing" ? "00:00:00"
      : (Number.isFinite(remainingMs) ? fmtCountdown(Math.max(0, remainingMs)) : "--:--:--");

    el.hero.innerHTML = `
      <div class="hero-eyebrow">${meta.eyebrow}</div>
      <div class="hero-value ${phase}">${value}</div>
      <div class="hero-sub">${meta.sub}</div>`;
  }

  /* ── Countdown (ticks while armed / t-minus, recomputes phase each tick) ── */

  function startCountdown(triggerEpoch) {
    stopCountdown();

    function tick() {
      const remaining = triggerEpoch - Date.now();
      const phase = reservationPhase(currentStatus && currentStatus.state, remaining);
      applyPhase(phase, remaining);
      if (phase !== "armed" && phase !== "tminus") {
        stopCountdown();
      }
    }

    tick();
    cdIntervalId = setInterval(tick, 250);
  }

  function stopCountdown() {
    if (cdIntervalId !== null) {
      clearInterval(cdIntervalId);
      cdIntervalId = null;
    }
  }

  /* ── Reservation summary (visual dashboard, view + cancel only) ── */

  function renderReservation(view) {
    const titleHtml = view.eventTitle
      ? `<div class="ev-title">${esc(view.eventTitle)}</div>`
      : `<div class="ev-title empty">イベント名は未取得です（詳細コンソールで読み取ると取得）</div>`;

    const heroImgHtml = view.heroImageUrl
      ? `<img class="hero-img" src="${esc(view.heroImageUrl)}" alt="" referrerpolicy="no-referrer" />`
      : "";

    const ticketHtml = view.ticketSummary.length
      ? `<div class="chips">${view.ticketSummary.map((p) =>
          `<span class="tchip">${ICON.ticketSm}${esc(p.ticketLabel)}<span class="qty">×${Number(p.targetQty)}</span></span>`
        ).join("")}</div>`
      : `<div class="meta-value">未設定</div>`;

    el.mainCard.innerHTML = `
      ${heroImgHtml}
      <div class="eyebrow">予約中のチケット</div>
      ${titleHtml}
      <div class="ev-url" title="${esc(view.targetUrl)}">${ICON.link}<span>${esc(shortenUrl(view.targetUrl))}</span></div>
      <div class="panel-div"></div>
      <div class="meta">
        <div class="meta-row">
          <div class="meta-ico">${ICON.calendar}</div>
          <div class="meta-info">
            <div class="meta-label">実行時刻 (JST)</div>
            <div class="meta-value mono">${esc(view.triggerJstText || "未設定")}</div>
          </div>
        </div>
        <div class="meta-row">
          <div class="meta-ico">${ICON.ticket}</div>
          <div class="meta-info">
            <div class="meta-label">購入チケット</div>
            ${ticketHtml}
          </div>
        </div>
      </div>
      <button class="danger-btn" type="button" data-action="cancel-popup" style="margin-top:13px">予約取り消し</button>
    `;

    // Inline event handlers are blocked by the extension CSP, so attach the
    // hotlink fallback (§10) here instead of an onerror attribute.
    const heroImg = el.mainCard.querySelector(".hero-img");
    if (heroImg) {
      heroImg.addEventListener("error", () => heroImg.remove());
    }
  }

  function renderOnTarget() {
    el.mainCard.innerHTML = `
      <div class="empty">
        ${ICON.reticle}
        <div class="empty-title">このページを予約できます</div>
        <div class="empty-body">下の「詳細コンソールで開く」から券種を読み取って予約してください。</div>
      </div>`;
  }

  function renderEmpty(message) {
    const extra = message
      ? `<br><span class="err">${esc(message)}</span>`
      : "";
    el.mainCard.innerHTML = `
      <div class="empty">
        ${ICON.reticle}
        <div class="empty-title">予約はありません</div>
        <div class="empty-body">「詳細コンソールで開く」から予約を作成してください。${extra}</div>
      </div>`;
  }

  /* ── Cancel (re-reads the live job so it always targets the stored one) ── */

  async function cancelPopupJob() {
    if (!globalScope.confirm("現在の予約を取り消しますか？")) {
      return;
    }
    let liveJob = currentJob;
    try {
      const jobResponse = await sendMessage({ type: MESSAGE_TYPES.GET_JOB });
      if (jobResponse.ok) {
        liveJob = jobResponse.job || null;
      }
    } catch (_) {
      // Fall back to the local snapshot.
    }
    if (!liveJob || !liveJob.jobId) {
      currentJob = null;
      currentStatus = { state: STATUS.IDLE };
      render();
      return;
    }
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.CANCEL_JOB,
        expectedJobId: liveJob.jobId
      });
      if (!response.ok) {
        globalScope.alert(`予約取り消しに失敗しました: ${formatResponseError(response)}`);
        await loadStatus();
        return;
      }
      currentJob = null;
      currentStatus = { state: STATUS.IDLE };
      render();
    } catch (error) {
      globalScope.alert(`予約取り消しに失敗しました: ${error.message}`);
      await loadStatus();
    }
  }

  /* ── Helpers ── */

  async function getActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs.length ? tabs[0] : null;
    } catch (_) {
      return null;
    }
  }

  function formatResponseError(response) {
    if (!response) {
      return "unknown error";
    }
    return getErrorMessage(response.code, response.error || "unknown error");
  }

  function fmtCountdown(ms) {
    const tot = Math.ceil(ms / 1000);
    const h = Math.floor(tot / 3600);
    const m = Math.floor((tot % 3600) / 60);
    const s = tot % 60;
    const p = (n) => String(n).padStart(2, "0");
    return `${p(h)}:${p(m)}:${p(s)}`;
  }

  function shortenUrl(url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.length > 32
        ? parsed.pathname.slice(0, 30) + "…"
        : parsed.pathname;
      return parsed.hostname + path;
    } catch (_) {
      return url;
    }
  }

  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
