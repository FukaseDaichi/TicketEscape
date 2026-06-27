(function popupMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const { MESSAGE_TYPES, STATUS } = shared;

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
  let jobState = null;

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
      void openOptionsPage();
    });
  }

  /* Open the options page as a tab in the CURRENT window.
     Reuse an already-open options tab if one exists (avoids duplicate
     countdowns racing to the target URL), otherwise create a new tab
     beside the current one. Falls back to the built-in opener on error. */
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
      const res = await sendMessage({ type: MESSAGE_TYPES.GET_STATUS });
      if (!res.ok) {
        render(null, null);
        renderEmpty("ステータス取得に失敗しました");
        return;
      }
      render(res.job || null, res.status || null);
    } catch (err) {
      render(null, null);
      renderEmpty(err.message);
    }
  }

  /* ── Phase model — maps STATUS to the CONSOLE state machine (DESIGN.md §3) ── */

  const FIRING_STATES = new Set([
    STATUS.WARMUP_START,
    STATUS.WAIT_FORM,
    STATUS.PREPARE_TICKETS,
    STATUS.CLICK_SUBMIT,
    STATUS.VERIFY_RESULT
  ]);

  const PHASE_META = {
    idle:    { code: "IDLE",    eyebrow: "カウントダウン", sub: "実行待機していません" },
    armed:   { code: "STANDBY", eyebrow: "発売まで",       sub: "0 秒で購入ページへ遷移します" },
    tminus:  { code: "T-MINUS", eyebrow: "まもなく発射",   sub: "このまま画面を閉じないでください" },
    firing:  { code: "FIRING",  eyebrow: "実行中",         sub: "カート投入を実行しています" },
    success: { code: "SECURED", title: "確保成功",         sub: "カート投入が完了しました" },
    failed:  { code: "FAILED",  title: "実行失敗",         sub: "設定画面でログを確認してください" }
  };

  function phaseOf(state, remainingMs) {
    if (state === STATUS.SUCCESS) return "success";
    if (state === STATUS.FAILED) return "failed";
    if (FIRING_STATES.has(state)) return "firing";
    const hasRemaining = Number.isFinite(remainingMs);
    if (hasRemaining && remainingMs <= 0) return "firing";
    if (state === STATUS.WAIT_TRIGGER || (hasRemaining && remainingMs > 0)) {
      return remainingMs <= 60000 ? "tminus" : "armed";
    }
    return "idle";
  }

  /* ── Main render ── */

  function render(job, statusObj) {
    jobState = (statusObj && statusObj.state) ? statusObj.state : STATUS.IDLE;

    if (!job) {
      const phase = jobState === STATUS.SUCCESS
        ? "success"
        : (jobState === STATUS.FAILED ? "failed" : "idle");
      applyPhase(phase, NaN);
      if (phase === "idle") {
        renderEmpty(null);
      }
      stopCountdown();
      return;
    }

    const triggerEpoch = Date.parse(String(job.triggerAtJst || ""));
    const remaining = Number.isFinite(triggerEpoch) ? triggerEpoch - Date.now() : NaN;
    const phase = phaseOf(jobState, remaining);

    renderJobCard(job);

    if (phase === "armed" || phase === "tminus") {
      startCountdown(triggerEpoch);
    } else {
      stopCountdown();
      applyPhase(phase, remaining);
    }
  }

  /* ── Phase UI (chip + hero stay in sync) ── */

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
      const phase = phaseOf(jobState, remaining);
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

  /* ── Job card ── */

  function renderJobCard(job) {
    const eventTitle = String(job.eventTitle || "").trim();
    const url        = String(job.targetUrl || "");
    const triggerJst = formatJst(job.triggerAtJst);
    const plans      = Array.isArray(job.ticketPlans) ? job.ticketPlans : [];
    const active     = plans.filter((p) => Number(p.targetQty) > 0);

    const titleHtml = eventTitle
      ? `<div class="ev-title">${esc(eventTitle)}</div>`
      : `<div class="ev-title empty">イベント名は未取得です（確認で取得）</div>`;

    const ticketHtml = active.length
      ? `<div class="chips">${active.map((p) =>
          `<span class="tchip">${ICON.ticketSm}${esc(p.ticketLabel)}<span class="qty">×${Number(p.targetQty)}</span></span>`
        ).join("")}</div>`
      : `<div class="meta-value">未設定</div>`;

    el.mainCard.innerHTML = `
      <div class="eyebrow">イベント</div>
      ${titleHtml}
      <div class="ev-url" title="${esc(url)}">${ICON.link}<span>${esc(shortenUrl(url))}</span></div>
      <div class="panel-div"></div>
      <div class="meta">
        <div class="meta-row">
          <div class="meta-ico">${ICON.calendar}</div>
          <div class="meta-info">
            <div class="meta-label">実行時刻 (JST)</div>
            <div class="meta-value mono">${esc(triggerJst)}</div>
          </div>
        </div>
        <div class="meta-row">
          <div class="meta-ico">${ICON.ticket}</div>
          <div class="meta-info">
            <div class="meta-label">券種</div>
            ${ticketHtml}
          </div>
        </div>
      </div>`;
  }

  /* ── Empty state ── */

  function renderEmpty(message) {
    const extra = message
      ? `<br><span class="err">${esc(message)}</span>`
      : "";
    el.mainCard.innerHTML = `
      <div class="empty">
        ${ICON.reticle}
        <div class="empty-title">設定がありません</div>
        <div class="empty-body">設定画面で URL と実行時刻を保存してください。${extra}</div>
      </div>`;
  }

  /* ── Helpers ── */

  function fmtCountdown(ms) {
    const tot = Math.ceil(ms / 1000);
    const h = Math.floor(tot / 3600);
    const m = Math.floor((tot % 3600) / 60);
    const s = tot % 60;
    const p = (n) => String(n).padStart(2, "0");
    return `${p(h)}:${p(m)}:${p(s)}`;
  }

  function formatJst(value) {
    const epoch = Date.parse(String(value || ""));
    if (!Number.isFinite(epoch)) {
      return "未設定";
    }
    const fmt = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    });
    const parts = fmt.formatToParts(new Date(epoch));
    const map = Object.create(null);
    for (const p of parts) {
      if (p.type !== "literal") {
        map[p.type] = p.value;
      }
    }
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
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
