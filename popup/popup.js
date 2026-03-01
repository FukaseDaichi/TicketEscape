(function popupMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const { MESSAGE_TYPES } = shared;
  const elements = {};

  document.addEventListener("DOMContentLoaded", () => {
    bindElements();
    bindEvents();
    void refreshStatus();
  });

  function bindElements() {
    elements.statusState = document.getElementById("statusState");
    elements.statusDetail = document.getElementById("statusDetail");
    elements.jobUrl = document.getElementById("jobUrl");
    elements.jobTrigger = document.getElementById("jobTrigger");
    elements.jobTicketCount = document.getElementById("jobTicketCount");
    elements.lastRunStatus = document.getElementById("lastRunStatus");
    elements.lastRunDetail = document.getElementById("lastRunDetail");
    elements.executeNowButton = document.getElementById("executeNowButton");
    elements.refreshButton = document.getElementById("refreshButton");
    elements.openOptionsButton = document.getElementById("openOptionsButton");
  }

  function bindEvents() {
    elements.refreshButton.addEventListener("click", () => {
      void refreshStatus();
    });

    elements.executeNowButton.addEventListener("click", () => {
      void executeNow();
    });

    elements.openOptionsButton.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  }

  async function refreshStatus() {
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.GET_STATUS
      });
      if (!response.ok) {
        renderError(response.error || "ステータス取得失敗");
        return;
      }
      renderStatus(response);
    } catch (error) {
      renderError(error.message);
    }
  }

  async function executeNow() {
    elements.executeNowButton.disabled = true;
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.EXECUTE_NOW
      });
      if (!response.ok) {
        renderError(response.error || "実行失敗");
        return;
      }
      elements.statusDetail.textContent = "手動実行を開始しました。";
      await refreshStatus();
    } catch (error) {
      renderError(error.message);
    } finally {
      elements.executeNowButton.disabled = false;
    }
  }

  function renderStatus(payload) {
    const status = payload.status || {};
    const job = payload.job || null;
    const lastRun = payload.lastRun || null;

    elements.statusState.textContent = status.state || "-";
    elements.statusDetail.textContent = status.detail || "-";

    if (job) {
      elements.jobUrl.textContent = job.targetUrl || "-";
      elements.jobTrigger.textContent = job.triggerAtJst || "-";
      elements.jobTicketCount.textContent = String(
        Array.isArray(job.ticketPlans) ? job.ticketPlans.length : 0
      );
      elements.executeNowButton.disabled = false;
    } else {
      elements.jobUrl.textContent = "未設定";
      elements.jobTrigger.textContent = "未設定";
      elements.jobTicketCount.textContent = "0";
      elements.executeNowButton.disabled = true;
    }

    if (lastRun) {
      elements.lastRunStatus.textContent = lastRun.status || "-";
      if (lastRun.errorCode) {
        elements.lastRunDetail.textContent = `${lastRun.errorCode}: ${lastRun.errorDetail || ""}`;
      } else {
        elements.lastRunDetail.textContent = `runId=${lastRun.runId || "-"}`;
      }
    } else {
      elements.lastRunStatus.textContent = "-";
      elements.lastRunDetail.textContent = "実行履歴なし";
    }
  }

  function renderError(message) {
    elements.statusState.textContent = "ERROR";
    elements.statusDetail.textContent = String(message || "unknown error");
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
