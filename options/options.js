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

  const state = {
    elements: {},
    countdownIntervalId: null,
    countdownRunId: 0,
    confirmedTargetUrl: ""
  };

  document.addEventListener("DOMContentLoaded", () => {
    bindElements();
    bindEvents();
    setDefaultValues();
    void loadSavedJob();
  });

  function bindElements() {
    state.elements = {
      jobId: document.getElementById("jobId"),
      targetUrl: document.getElementById("targetUrl"),
      triggerAt: document.getElementById("triggerAt"),
      clickIntervalMs: document.getElementById("clickIntervalMs"),
      parallelTabCount: document.getElementById("parallelTabCount"),
      requireAgreement: document.getElementById("requireAgreement"),
      parseFormButton: document.getElementById("parseFormButton"),
      saveButton: document.getElementById("saveButton"),
      addPlanButton: document.getElementById("addPlanButton"),
      planRows: document.getElementById("planRows"),
      statusText: document.getElementById("statusText"),
      countdownText: document.getElementById("countdownText")
    };
  }

  function bindEvents() {
    state.elements.targetUrl.addEventListener("input", () => {
      updateConfirmAttention();
    });

    state.elements.parseFormButton.addEventListener("click", () => {
      void parseForm();
    });

    state.elements.saveButton.addEventListener("click", () => {
      void saveJob();
    });

    state.elements.addPlanButton.addEventListener("click", () => {
      addPlanRow("", 0);
      updateStandbyAttention();
    });

    state.elements.planRows.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.dataset.action === "remove-plan") {
        const row = target.closest("tr");
        if (row) {
          row.remove();
          updateStandbyAttention();
        }
      }
    });

    state.elements.planRows.addEventListener("input", () => {
      updateStandbyAttention();
    });
  }

  function setDefaultValues() {
    state.elements.clickIntervalMs.value = String(DEFAULT_JOB.clickIntervalMs);
    state.elements.parallelTabCount.value = String(DEFAULT_JOB.parallelTabCount);
    state.elements.requireAgreement.checked = true;
    state.elements.triggerAt.value = formatLocalDatetimeInput(Date.now() + 10 * 60 * 1000);
    if (!state.elements.planRows.children.length) {
      addPlanRow("グループチケット", 1);
    }
    updateConfirmAttention();
    updateStandbyAttention();
  }

  async function loadSavedJob() {
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.GET_JOB
      });
      if (!response.ok || !response.job) {
        state.confirmedTargetUrl = "";
        updateConfirmAttention();
        updateStandbyAttention();
        setStatus("保存済みジョブはありません。");
        setCountdown("カウントダウン未開始");
        return;
      }
      populateForm(response.job);
      setStatus("保存済みジョブを読み込みました。");
      startCountdown(response.job, { updateStatus: false });
    } catch (error) {
      setStatus(`ジョブ読み込み失敗: ${error.message}`);
      setCountdown("カウントダウン未開始");
    }
  }

  function populateForm(job) {
    state.elements.jobId.value = String(job.jobId || "");
    state.elements.targetUrl.value = String(job.targetUrl || "");
    state.confirmedTargetUrl = normalizeTargetUrlForCompare(state.elements.targetUrl.value);
    updateConfirmAttention();
    const triggerEpoch = Date.parse(String(job.triggerAtJst || ""));
    if (Number.isFinite(triggerEpoch)) {
      state.elements.triggerAt.value = formatLocalDatetimeInput(triggerEpoch);
    }
    state.elements.clickIntervalMs.value = String(job.clickIntervalMs ?? DEFAULT_JOB.clickIntervalMs);
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
        url: targetUrl
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

      state.elements.planRows.innerHTML = "";
      for (const ticket of tickets) {
        addPlanRow(ticket.ticketLabel, ticket.currentQty || 0);
      }
      state.confirmedTargetUrl = normalizeTargetUrlForCompare(targetUrl);
      updateConfirmAttention();
      updateStandbyAttention();
      setStatus(`券種を ${tickets.length} 件取得しました。`);
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
      jobId: state.elements.jobId.value || createId("job"),
      targetUrl,
      triggerAtJst,
      clickIntervalMs: clampInt(state.elements.clickIntervalMs.value, DEFAULT_JOB.clickIntervalMs, 5, 500),
      parallelTabCount: clampInt(
        state.elements.parallelTabCount.value,
        DEFAULT_JOB.parallelTabCount,
        1,
        5
      ),
      requireAgreement: state.elements.requireAgreement.checked,
      ticketPlans
    };

    setStatus("実行待機を登録中...");
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.SAVE_JOB,
        job
      });
      if (!response.ok) {
        setStatus(`実行待機登録失敗: ${response.error || "unknown error"}`);
        setCountdown("カウントダウン開始失敗");
        return;
      }
      state.elements.jobId.value = response.job.jobId;
      startCountdown(response.job, { updateStatus: true });
    } catch (error) {
      setStatus(`実行待機登録失敗: ${error.message}`);
      setCountdown("カウントダウン開始失敗");
    }
  }

  function startCountdown(job, options) {
    clearCountdownInterval();
    state.countdownRunId += 1;
    const runId = state.countdownRunId;
    const opts = options || {};

    const targetUrl = ensureEscapeUrl(job && job.targetUrl);
    const triggerEpoch = Date.parse(String((job && job.triggerAtJst) || ""));
    if (!targetUrl || !Number.isFinite(triggerEpoch)) {
      setCountdown("カウントダウン未開始");
      return;
    }

    const remainingMs = triggerEpoch - Date.now();
    if (remainingMs <= 0) {
      setCountdown("実行時刻を過ぎています。時刻を再設定して保存してください。");
      return;
    }

    if (opts.updateStatus !== false) {
      setStatus("実行待機を開始しました。0秒で購入URLへ遷移します。");
    }

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
        setCountdown("00:00:00 遷移中...");
        globalScope.location.assign(targetUrl);
      })
      .catch((error) => {
        if (runId !== state.countdownRunId) {
          return;
        }
        clearCountdownInterval();
        setCountdown(`カウントダウン異常: ${error.message || "unknown error"}`);
      });
  }

  function renderCountdown(triggerEpoch) {
    const remainingMs = Math.max(0, triggerEpoch - Date.now());
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    setCountdown(`${hh}:${mm}:${ss} で遷移`);
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
    const rows = Array.from(state.elements.planRows.querySelectorAll("tr"));
    return rows
      .map((row) => {
        const labelInput = row.querySelector("input[data-field='label']");
        const qtyInput = row.querySelector("input[data-field='qty']");
        const ticketLabel = labelInput ? String(labelInput.value || "").trim() : "";
        const targetQty = qtyInput ? clampInt(qtyInput.value, 0, 0, 99) : 0;
        return {
          ticketLabel,
          targetQty
        };
      })
      .filter((plan) => plan.ticketLabel);
  }

  function addPlanRow(label, qty) {
    const row = document.createElement("tr");
    row.innerHTML = [
      "<td><input data-field='label' type='text' /></td>",
      "<td><input data-field='qty' type='number' min='0' max='99' /></td>",
      "<td><button data-action='remove-plan' type='button'>削除</button></td>"
    ].join("");
    const labelInput = row.querySelector("input[data-field='label']");
    const qtyInput = row.querySelector("input[data-field='qty']");
    labelInput.value = String(label || "");
    qtyInput.value = String(Number.isFinite(Number(qty)) ? Number(qty) : 0);
    state.elements.planRows.appendChild(row);
  }

  function setStatus(text) {
    state.elements.statusText.textContent = String(text || "");
  }

  function setCountdown(text) {
    state.elements.countdownText.textContent = String(text || "");
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
    const qtyInputs = Array.from(state.elements.planRows.querySelectorAll("input[data-field='qty']"));
    const allZero =
      qtyInputs.length > 0 &&
      qtyInputs.every((input) => {
        const qty = Number.parseInt(String(input.value || "0"), 10);
        return !Number.isFinite(qty) || qty <= 0;
      });

    state.elements.saveButton.classList.toggle("attention-ticket", allZero);
    state.elements.saveButton.title = allZero ? "数量がすべて0です。数量を見直してください。" : "";
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
