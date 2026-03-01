(function contentScriptMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const { MESSAGE_TYPES, STATUS, normalizeLabel, sleep, nowEpoch } = shared;
  let activeRunId = null;

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
      void runExecution(message).finally(() => {
        activeRunId = null;
      });
      return false;
    }

    return false;
  });

  async function handleParseFormRequest(message) {
    const timeoutMs = Number.isFinite(message.timeoutMs) ? message.timeoutMs : 20000;
    const selectorOverrides = message.selectorOverrides || {};
    const form = await waitForForm(timeoutMs, selectorOverrides);
    const tickets = extractTicketRows(form).map((row) => ({
      ticketLabel: row.label,
      currentQty: row.currentQty,
      priceText: row.priceText
    }));

    const requiredCheckboxes = form.querySelectorAll("input[type='checkbox'][required]").length;
    const allCheckboxes = form.querySelectorAll("input[type='checkbox']").length;

    return {
      formFound: true,
      tickets,
      agreement: {
        requiredCount: requiredCheckboxes,
        totalCount: allCheckboxes
      }
    };
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
      const form = await waitForForm(25000, job.selectorOverrides || {});

      addStep(STATUS.PREPARE_TICKETS, "Adjusting ticket quantities");
      const ticketRows = extractTicketRows(form);
      await applyTicketPlan(ticketRows, job.ticketPlans || [], job.clickIntervalMs || 30);

      addStep(STATUS.PREPARE_TICKETS, "Ensuring agreement checkboxes");
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

  async function waitForForm(timeoutMs, selectorOverrides) {
    const existing = findFormRoot(selectorOverrides);
    if (existing) {
      return existing;
    }

    return new Promise((resolve, reject) => {
      let finished = false;
      const onResolved = (form) => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        resolve(form);
      };
      const onRejected = () => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        reject(makeError("E_FORM_TIMEOUT", "Ticket form did not appear before timeout."));
      };

      const observer = new MutationObserver(() => {
        const form = findFormRoot(selectorOverrides);
        if (form) {
          onResolved(form);
        }
      });
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });

      const pollTimer = setInterval(() => {
        const form = findFormRoot(selectorOverrides);
        if (form) {
          onResolved(form);
        }
      }, 50);

      const timeoutTimer = setTimeout(onRejected, timeoutMs);

      function cleanup() {
        observer.disconnect();
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
      }
    });
  }

  function extractTicketRows(form) {
    let candidates = Array.from(form.querySelectorAll("ul > li"));
    if (!candidates.length) {
      candidates = Array.from(form.querySelectorAll("li"));
    }

    return candidates
      .map((row) => buildTicketRow(row))
      .filter((row) => row && row.label);
  }

  function buildTicketRow(row) {
    const textNodes = Array.from(row.querySelectorAll("p"))
      .map((node) => String(node.textContent || "").trim())
      .filter(Boolean);

    const label = findTicketLabel(textNodes);
    if (!label) {
      return null;
    }

    const priceText = textNodes.find((text) => /円/.test(text)) || "";
    const qtyNode = findQuantityNode(row);
    const currentQty = qtyNode ? parseQuantity(qtyNode.textContent) : 0;

    const buttons = Array.from(row.querySelectorAll("button")).filter(
      (button) => button.type !== "submit"
    );
    const minusButton = buttons[0] || null;
    const plusButton = buttons[1] || null;

    return {
      row,
      label,
      priceText,
      qtyNode,
      currentQty,
      minusButton,
      plusButton
    };
  }

  function findTicketLabel(textNodes) {
    for (const text of textNodes) {
      if (/円/.test(text)) {
        continue;
      }
      if (/^\d+$/.test(text)) {
        continue;
      }
      return text;
    }
    return "";
  }

  function findQuantityNode(row) {
    const nodes = Array.from(row.querySelectorAll("p"));
    return nodes.find((node) => /^\d+$/.test(String(node.textContent || "").trim())) || null;
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
      const normalizedPlan = normalizeLabel(plan.ticketLabel);
      const rowInfo = ticketRows.find((row) => normalizeLabel(row.label) === normalizedPlan);
      if (!rowInfo) {
        throw makeError("E_TICKET_NOT_FOUND", `Ticket not found: ${plan.ticketLabel}`);
      }

      const targetQty = Math.max(0, Number.parseInt(plan.targetQty, 10) || 0);
      await adjustQty(rowInfo, targetQty, clickIntervalMs);
    }
  }

  async function adjustQty(rowInfo, targetQty, clickIntervalMs) {
    const maxClickCount = 60;
    let guard = 0;
    while (guard < maxClickCount) {
      const current = getCurrentQty(rowInfo);
      if (current === targetQty) {
        return;
      }

      const shouldIncrease = current < targetQty;
      const button = shouldIncrease ? rowInfo.plusButton : rowInfo.minusButton;
      if (!button) {
        throw makeError("E_QTY_ADJUST_FAILED", `Ticket controls are missing for ${rowInfo.label}`);
      }
      if (button.disabled) {
        throw makeError("E_QTY_ADJUST_FAILED", `Ticket button is disabled for ${rowInfo.label}`);
      }

      const before = current;
      button.click();
      await sleep(clickIntervalMs);
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
      await sleep(20);
    }
  }

  async function ensureAgreementChecks(form, requireAgreement) {
    if (!requireAgreement) {
      return;
    }

    let checkboxes = Array.from(form.querySelectorAll("input[type='checkbox'][required]"));
    if (!checkboxes.length) {
      checkboxes = Array.from(form.querySelectorAll("input[type='checkbox']"));
    }

    for (const checkbox of checkboxes) {
      if (checkbox.checked) {
        continue;
      }

      checkbox.click();
      await sleep(15);
      if (checkbox.checked) {
        continue;
      }

      const label = checkbox.id
        ? form.querySelector(`label[for="${cssEscape(checkbox.id)}"]`)
        : null;
      if (label) {
        label.click();
        await sleep(15);
      }

      if (!checkbox.checked) {
        throw makeError("E_AGREEMENT_NOT_CHECKED", "Failed to check required agreement checkbox.");
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

    let remaining = triggerEpoch - Date.now();
    if (remaining <= 0) {
      return;
    }

    if (remaining > 2000) {
      await sleep(remaining - 1500);
    }

    while (Date.now() < triggerEpoch - 16) {
      await sleep(1);
    }

    while (Date.now() < triggerEpoch) {
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 0);
        }
      });
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
    const button = findSubmitButton(form, selectorOverrides);
    if (!button) {
      return { ok: false, error: "Submit button not found." };
    }

    const waitEnabledStart = nowEpoch();
    while (button.disabled && nowEpoch() - waitEnabledStart < 200) {
      await sleep(20);
    }
    if (button.disabled) {
      return { ok: false, error: "Submit button is disabled." };
    }

    const beforeHref = location.href;
    button.click();

    const observeStart = nowEpoch();
    while (nowEpoch() - observeStart < 700) {
      if (location.href !== beforeHref) {
        return { ok: true };
      }
      if (!document.contains(form)) {
        return { ok: true };
      }
      await sleep(30);
    }

    return { ok: true };
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
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response || null);
      });
    });
  }
})(globalThis);
