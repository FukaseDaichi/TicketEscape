(function optionsPageMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const {
    MESSAGE_TYPES,
    DEFAULT_JOB,
    createId,
    parseRetryIntervals,
    ensureEscapeUrl,
    clampInt,
    formatLocalDatetimeInput,
    toJstIsoStringFromDatetimeLocal
  } = shared;

  const state = {
    elements: {}
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
      warmupSec: document.getElementById("warmupSec"),
      retryMax: document.getElementById("retryMax"),
      retryIntervalsMs: document.getElementById("retryIntervalsMs"),
      clickIntervalMs: document.getElementById("clickIntervalMs"),
      requireAgreement: document.getElementById("requireAgreement"),
      parseFormButton: document.getElementById("parseFormButton"),
      saveButton: document.getElementById("saveButton"),
      addPlanButton: document.getElementById("addPlanButton"),
      planRows: document.getElementById("planRows"),
      statusText: document.getElementById("statusText")
    };
  }

  function bindEvents() {
    state.elements.parseFormButton.addEventListener("click", () => {
      void parseForm();
    });

    state.elements.saveButton.addEventListener("click", () => {
      void saveJob();
    });

    state.elements.addPlanButton.addEventListener("click", () => {
      addPlanRow("", 0);
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
        }
      }
    });
  }

  function setDefaultValues() {
    state.elements.warmupSec.value = String(DEFAULT_JOB.warmupSec);
    state.elements.retryMax.value = String(DEFAULT_JOB.retryMax);
    state.elements.retryIntervalsMs.value = DEFAULT_JOB.retryIntervalsMs.join(",");
    state.elements.clickIntervalMs.value = String(DEFAULT_JOB.clickIntervalMs);
    state.elements.requireAgreement.checked = true;
    state.elements.triggerAt.value = formatLocalDatetimeInput(Date.now() + 10 * 60 * 1000);
    if (!state.elements.planRows.children.length) {
      addPlanRow("グループチケット", 1);
    }
  }

  async function loadSavedJob() {
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.GET_JOB
      });
      if (!response.ok || !response.job) {
        setStatus("保存済みジョブはありません。");
        return;
      }
      populateForm(response.job);
      setStatus("保存済みジョブを読み込みました。");
    } catch (error) {
      setStatus(`ジョブ読み込み失敗: ${error.message}`);
    }
  }

  function populateForm(job) {
    state.elements.jobId.value = String(job.jobId || "");
    state.elements.targetUrl.value = String(job.targetUrl || "");
    const triggerEpoch = Date.parse(String(job.triggerAtJst || ""));
    if (Number.isFinite(triggerEpoch)) {
      state.elements.triggerAt.value = formatLocalDatetimeInput(triggerEpoch);
    }
    state.elements.warmupSec.value = String(job.warmupSec ?? DEFAULT_JOB.warmupSec);
    state.elements.retryMax.value = String(job.retryMax ?? DEFAULT_JOB.retryMax);
    state.elements.retryIntervalsMs.value = parseRetryIntervals(job.retryIntervalsMs).join(",");
    state.elements.clickIntervalMs.value = String(job.clickIntervalMs ?? DEFAULT_JOB.clickIntervalMs);
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
  }

  async function parseForm() {
    const targetUrl = ensureEscapeUrl(state.elements.targetUrl.value);
    if (!targetUrl) {
      setStatus("URLが不正です。https://escape.id/* を指定してください。");
      return;
    }

    setStatus("フォーム解析中...");
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.PARSE_FORM_REQUEST,
        url: targetUrl
      });

      if (!response.ok) {
        setStatus(`フォーム解析失敗: ${response.error || "unknown error"}`);
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
      setStatus(`券種を ${tickets.length} 件取得しました。`);
    } catch (error) {
      setStatus(`フォーム解析失敗: ${error.message}`);
    }
  }

  async function saveJob() {
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
      warmupSec: clampInt(state.elements.warmupSec.value, DEFAULT_JOB.warmupSec, 0, 3600),
      retryMax: clampInt(state.elements.retryMax.value, DEFAULT_JOB.retryMax, 0, 10),
      retryIntervalsMs: parseRetryIntervals(state.elements.retryIntervalsMs.value),
      clickIntervalMs: clampInt(state.elements.clickIntervalMs.value, DEFAULT_JOB.clickIntervalMs, 5, 500),
      requireAgreement: state.elements.requireAgreement.checked,
      ticketPlans
    };

    setStatus("設定を保存中...");
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.SAVE_JOB,
        job
      });
      if (!response.ok) {
        setStatus(`保存失敗: ${response.error || "unknown error"}`);
        return;
      }
      state.elements.jobId.value = response.job.jobId;
      setStatus("保存しました。アラームを登録済みです。");
    } catch (error) {
      setStatus(`保存失敗: ${error.message}`);
    }
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
