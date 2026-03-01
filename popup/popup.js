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
    void loadJobSummary();
  });

  function bindElements() {
    elements.jobUrl = document.getElementById("jobUrl");
    elements.jobTrigger = document.getElementById("jobTrigger");
    elements.messageText = document.getElementById("messageText");
    elements.openOptionsButton = document.getElementById("openOptionsButton");
  }

  function bindEvents() {
    elements.openOptionsButton.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  }

  async function loadJobSummary() {
    try {
      const response = await sendMessage({
        type: MESSAGE_TYPES.GET_STATUS
      });
      if (!response.ok) {
        renderError(response.error || "ジョブ情報の取得に失敗しました。");
        return;
      }
      renderJob(response.job || null);
    } catch (error) {
      renderError(error.message);
    }
  }

  function renderJob(job) {
    if (!job) {
      elements.jobUrl.textContent = "未設定";
      elements.jobTrigger.textContent = "未設定";
      elements.messageText.textContent = "設定がない場合は先に設定画面で保存してください。";
      return;
    }

    elements.jobUrl.textContent = job.targetUrl || "未設定";
    elements.jobTrigger.textContent = formatJstDatetime(job.triggerAtJst);
    elements.messageText.textContent = "現在の設定内容です。変更は設定画面で行ってください。";
  }

  function renderError(message) {
    elements.jobUrl.textContent = "取得失敗";
    elements.jobTrigger.textContent = "取得失敗";
    elements.messageText.textContent = String(message || "unknown error");
  }

  function formatJstDatetime(value) {
    const epoch = Date.parse(String(value || ""));
    if (!Number.isFinite(epoch)) {
      return "未設定";
    }

    const formatter = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const parts = formatter.formatToParts(new Date(epoch));
    const map = Object.create(null);
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
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
