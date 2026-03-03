(function popupMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const { MESSAGE_TYPES, STATUS } = shared;

  const el = {};
  let cdIntervalId = null;

  document.addEventListener("DOMContentLoaded", () => {
    bindElements();
    bindEvents();
    void loadStatus();
  });

  function bindElements() {
    el.statusBadge     = document.getElementById("statusBadge");
    el.mainCard        = document.getElementById("mainCard");
    el.countdownBlock  = document.getElementById("countdownBlock");
    el.cdValue         = document.getElementById("cdValue");
    el.openOptions     = document.getElementById("openOptionsButton");
  }

  function bindEvents() {
    el.openOptions.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  }

  async function loadStatus() {
    try {
      const res = await sendMessage({ type: MESSAGE_TYPES.GET_STATUS });
      if (!res.ok) {
        renderEmpty("ステータス取得に失敗しました。");
        return;
      }
      render(res.job || null, res.status || null);
    } catch (err) {
      renderEmpty(err.message);
    }
  }

  /* ── Main render ── */

  function render(job, statusObj) {
    const state = (statusObj && statusObj.state) ? statusObj.state : STATUS.IDLE;
    applyStatusBadge(state);

    if (!job) {
      renderEmpty(null);
      return;
    }

    const triggerEpoch = Date.parse(String(job.triggerAtJst || ""));

    // Result states — show dedicated UI
    if (state === STATUS.SUCCESS) {
      renderResult("success");
      hideCountdown();
      return;
    }
    if (state === STATUS.FAILED) {
      renderResult("failed");
      hideCountdown();
      return;
    }

    renderJobCard(job);

    if (Number.isFinite(triggerEpoch)) {
      const remaining = triggerEpoch - Date.now();
      if (remaining > 0 || state === STATUS.WAIT_TRIGGER) {
        showCountdown(triggerEpoch, state);
      } else {
        hideCountdown();
      }
    } else {
      hideCountdown();
    }
  }

  function applyStatusBadge(state) {
    const { cls, label } = statusMeta(state);
    el.statusBadge.className = `s-badge ${cls}`;
    el.statusBadge.textContent = label;
  }

  function statusMeta(state) {
    switch (state) {
      case STATUS.WARMUP_START:
      case STATUS.WAIT_FORM:
      case STATUS.PREPARE_TICKETS:
        return { cls: "running", label: "実行中" };
      case STATUS.WAIT_TRIGGER:
        return { cls: "standby", label: "スタンバイ" };
      case STATUS.CLICK_SUBMIT:
      case STATUS.VERIFY_RESULT:
        return { cls: "running", label: "送信中" };
      case STATUS.SUCCESS:
        return { cls: "success", label: "成功" };
      case STATUS.FAILED:
        return { cls: "failed", label: "失敗" };
      default:
        return { cls: "idle", label: "IDLE" };
    }
  }

  /* ── Job card ── */

  function renderJobCard(job) {
    const eventTitle   = String(job.eventTitle || "").trim();
    const url          = String(job.targetUrl  || "");
    const triggerJst   = formatJst(job.triggerAtJst);
    const plans        = Array.isArray(job.ticketPlans) ? job.ticketPlans : [];
    const activePlans  = plans.filter((p) => Number(p.targetQty) > 0);

    const titleHtml = eventTitle
      ? `<div class="ev-title">${esc(eventTitle)}</div>`
      : `<div class="ev-title empty">イベント名未取得（確認ボタンで取得）</div>`;

    const ticketChipsHtml = activePlans.length
      ? `<div class="ticket-chips">${activePlans.map((p) =>
          `<span class="ticket-chip">🎟 ${esc(p.ticketLabel)} × ${Number(p.targetQty)}</span>`
        ).join("")}</div>`
      : `<div class="meta-value" style="color:var(--tx-m);font-weight:500">未設定</div>`;

    el.mainCard.innerHTML = `
      <div class="ev-section">
        <div class="ev-eyebrow">イベント</div>
        ${titleHtml}
        <div class="ev-url" title="${esc(url)}">${esc(shortenUrl(url))}</div>
      </div>
      <div class="meta-section">
        <div class="meta-row">
          <div class="meta-ico">📅</div>
          <div class="meta-info">
            <div class="meta-label">実行時刻 (JST)</div>
            <div class="meta-value">${esc(triggerJst)}</div>
          </div>
        </div>
        <div class="meta-row">
          <div class="meta-ico">🎟</div>
          <div class="meta-info">
            <div class="meta-label">チケット</div>
            ${ticketChipsHtml}
          </div>
        </div>
      </div>
    `;
  }

  /* ── Result states ── */

  function renderResult(type) {
    const isSuccess = type === "success";
    el.mainCard.innerHTML = `
      <div class="result-block">
        <span class="result-icon">${isSuccess ? "✅" : "❌"}</span>
        <div class="result-title" style="color:var(${isSuccess ? "--green" : "--red"})">
          ${isSuccess ? "購入完了！" : "実行失敗"}
        </div>
        <div class="result-sub">${isSuccess ? "カートへの追加が完了しました。" : "設定画面でログを確認してください。"}</div>
      </div>
    `;
  }

  function renderEmpty(message) {
    const extra = message ? `<br><span style="font-size:11px">${esc(message)}</span>` : "";
    el.mainCard.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">⚙️</span>
        <div class="empty-title">設定がありません</div>
        <div class="empty-body">設定画面でURLと実行時刻を<br>保存してください。${extra}</div>
      </div>
    `;
    hideCountdown();
  }

  /* ── Countdown ── */

  function showCountdown(triggerEpoch, state) {
    el.countdownBlock.style.display = "";
    stopCountdown();

    const colClass = state === STATUS.WAIT_TRIGGER ? "cd-value col-standby" : "cd-value";

    function tick() {
      const rem = Math.max(0, triggerEpoch - Date.now());
      el.cdValue.className = colClass;
      el.cdValue.textContent = fmtCountdown(rem);
      if (rem <= 0) {
        stopCountdown();
      }
    }

    tick();
    cdIntervalId = setInterval(tick, 250);
  }

  function hideCountdown() {
    el.countdownBlock.style.display = "none";
    stopCountdown();
  }

  function stopCountdown() {
    if (cdIntervalId !== null) {
      clearInterval(cdIntervalId);
      cdIntervalId = null;
    }
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
