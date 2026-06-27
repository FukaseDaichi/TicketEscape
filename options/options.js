(function optionsPageMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const {
    MESSAGE_TYPES,
    DEFAULT_JOB,
    createId,
    ensureEscapeUrl,
    clampInt,
    formatLocalDatetimeInput,
    toJstIsoStringFromDatetimeLocal
  } = shared;

  const TRASH_ICON =
    '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>';

  const ARM_NOTE_DEFAULT = "設定を確認したら押してください。この画面は開いたままにします。";

  const state = {
    elements: {},
    countdownIntervalId: null,
    countdownRunId: 0,
    confirmedTargetUrl: "",
    eventTitle: "",
    armed: false
  };

  document.addEventListener("DOMContentLoaded", () => {
    bindElements();
    bindEvents();
    setDefaultValues();
    void loadSavedJob();
  });

  function bindElements() {
    state.elements = {
      jobId:            document.getElementById("jobId"),
      targetUrl:        document.getElementById("targetUrl"),
      triggerAt:        document.getElementById("triggerAt"),
      clickIntervalMs:  document.getElementById("clickIntervalMs"),
      parallelTabCount: document.getElementById("parallelTabCount"),
      requireAgreement: document.getElementById("requireAgreement"),
      parseFormButton:  document.getElementById("parseFormButton"),
      saveButton:       document.getElementById("saveButton"),
      addPlanButton:    document.getElementById("addPlanButton"),
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
      stepArm:          document.getElementById("stepArm")
    };
  }

  function bindEvents() {
    state.elements.targetUrl.addEventListener("input", () => {
      updateConfirmAttention();
      updateStepStates();
    });

    state.elements.triggerAt.addEventListener("input", () => {
      updateStepStates();
    });

    state.elements.parseFormButton.addEventListener("click", () => {
      void parseForm();
    });

    state.elements.saveButton.addEventListener("click", () => {
      void saveJob();
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

  function setDefaultValues() {
    state.elements.clickIntervalMs.value  = String(DEFAULT_JOB.clickIntervalMs);
    state.elements.parallelTabCount.value = String(DEFAULT_JOB.parallelTabCount);
    state.elements.requireAgreement.checked = true;
    state.elements.triggerAt.value = formatLocalDatetimeInput(Date.now() + 10 * 60 * 1000);
    if (!state.elements.planRows.children.length) {
      addPlanRow("グループチケット", 1);
    }
    updateConfirmAttention();
    updateStandbyAttention();
    updateStepStates();
    setIdleCountdown();
  }

  async function loadSavedJob() {
    try {
      const response = await sendMessage({ type: MESSAGE_TYPES.GET_JOB });
      if (!response.ok || !response.job) {
        state.confirmedTargetUrl = "";
        state.eventTitle = "";
        updateEventReadout();
        updateConfirmAttention();
        updateStandbyAttention();
        updateStepStates();
        setStatus("保存済みジョブはありません。");
        setIdleCountdown();
        return;
      }
      populateForm(response.job);
      setStatus("保存済みジョブを読み込みました。");
      startCountdown(response.job, { updateStatus: false });
    } catch (error) {
      setStatus(`ジョブ読み込み失敗: ${error.message}`);
      setIdleCountdown();
    }
  }

  function populateForm(job) {
    state.elements.jobId.value     = String(job.jobId || "");
    state.elements.targetUrl.value = String(job.targetUrl || "");
    state.confirmedTargetUrl       = normalizeTargetUrlForCompare(state.elements.targetUrl.value);
    state.eventTitle               = String(job.eventTitle || "");
    updateConfirmAttention();
    updateEventReadout();

    const triggerEpoch = Date.parse(String(job.triggerAtJst || ""));
    if (Number.isFinite(triggerEpoch)) {
      state.elements.triggerAt.value = formatLocalDatetimeInput(triggerEpoch);
    }
    state.elements.clickIntervalMs.value = String(
      job.clickIntervalMs ?? DEFAULT_JOB.clickIntervalMs
    );
    state.elements.parallelTabCount.value = String(
      job.parallelTabCount ?? DEFAULT_JOB.parallelTabCount
    );
    state.elements.requireAgreement.checked = job.requireAgreement !== false;

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

  async function parseForm() {
    const targetUrl = ensureEscapeUrl(state.elements.targetUrl.value);
    if (!targetUrl) {
      setStatus("URLが不正です。https://escape.id/* を指定してください。");
      updateConfirmAttention();
      return;
    }

    setStatus("確認中...");
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.PARSE_FORM_REQUEST,
        url:  targetUrl
      });

      if (!response.ok) {
        setStatus(`確認失敗: ${response.error || "unknown error"}`);
        return;
      }

      const parseResult = response.parseResult || {};
      const tickets = Array.isArray(parseResult.tickets) ? parseResult.tickets : [];
      if (!tickets.length) {
        setStatus("フォームは検出しましたが券種を抽出できませんでした。");
        return;
      }

      state.eventTitle = String(parseResult.eventTitle || "").trim();
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
      setStatus(`確認失敗: ${error.message}`);
    }
  }

  async function saveJob() {
    updateStandbyAttention();

    const targetUrl = ensureEscapeUrl(state.elements.targetUrl.value);
    if (!targetUrl) {
      setStatus("URLが不正です。https://escape.id/* を指定してください。");
      return;
    }

    const triggerAtJst = toJstIsoStringFromDatetimeLocal(state.elements.triggerAt.value);
    if (!triggerAtJst || !Number.isFinite(Date.parse(triggerAtJst))) {
      setStatus("実行時刻を正しく入力してください。");
      return;
    }

    const ticketPlans = collectPlanRows();
    if (!ticketPlans.length) {
      setStatus("券種設定がありません。");
      return;
    }

    const job = {
      jobId:            state.elements.jobId.value || createId("job"),
      targetUrl,
      triggerAtJst,
      eventTitle:       state.eventTitle || "",
      clickIntervalMs:  clampInt(state.elements.clickIntervalMs.value,  DEFAULT_JOB.clickIntervalMs,  5, 500),
      parallelTabCount: clampInt(state.elements.parallelTabCount.value, DEFAULT_JOB.parallelTabCount, 1, 5),
      requireAgreement: state.elements.requireAgreement.checked,
      ticketPlans
    };

    setStatus("実行待機を登録中...");
    try {
      const response = await sendMessage({ type: MESSAGE_TYPES.SAVE_JOB, job });
      if (!response.ok) {
        setStatus(`実行待機登録失敗: ${response.error || "unknown error"}`);
        setIdleCountdown();
        return;
      }
      state.elements.jobId.value = response.job.jobId;
      startCountdown(response.job, { updateStatus: true });
    } catch (error) {
      setStatus(`実行待機登録失敗: ${error.message}`);
      setIdleCountdown();
    }
  }

  function startCountdown(job, options) {
    clearCountdownInterval();
    state.countdownRunId += 1;
    const runId = state.countdownRunId;
    const opts  = options || {};

    const targetUrl    = ensureEscapeUrl(job && job.targetUrl);
    const triggerEpoch = Date.parse(String((job && job.triggerAtJst) || ""));
    if (!targetUrl || !Number.isFinite(triggerEpoch)) {
      setIdleCountdown();
      return;
    }

    const remainingMs = triggerEpoch - Date.now();
    if (remainingMs <= 0) {
      setArmed(false);
      setChip("expired");
      setMiniCd("00:00:00", "idle");
      setArmNote("実行時刻を過ぎています。時刻を再設定して保存してください。", false);
      return;
    }

    if (opts.updateStatus !== false) {
      setStatus("実行待機を開始しました。0秒で購入URLへ遷移します。");
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
  }

  /* ── Step completion indicators ── */

  function updateStepStates() {
    const urlOk = Boolean(ensureEscapeUrl(state.elements.targetUrl.value));
    state.elements.stepUrl.classList.toggle("done", urlOk);

    const triggerIso = toJstIsoStringFromDatetimeLocal(state.elements.triggerAt.value);
    const timeOk = Boolean(triggerIso) && Number.isFinite(Date.parse(triggerIso));
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
    state.elements.saveButton.title = allZero ? "数量がすべて0です。数量を見直してください。" : "";

    if (!state.armed) {
      setArmNote(
        allZero ? "数量がすべて0です。「3」で枚数を設定してください。" : ARM_NOTE_DEFAULT,
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
