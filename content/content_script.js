(function contentScriptMain(globalScope) {
  const shared = globalScope.TE_SHARED;
  if (!shared) {
    return;
  }

  const { MESSAGE_TYPES, STATUS, normalizeLabel, sleep, nowEpoch } = shared;
  let activeRunId = null;
  const WAIT_INTERVAL_MS = 50;
  const WAIT_MAX_ATTEMPTS = 500;

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

    return {
      formFound: true,
      tickets,
      agreement: {
        requiredCount: requiredCheckboxes,
        totalCount: allCheckboxes
      },
      eventTitle
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
      await sleep(intervalMs);
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
      await sleep(clickIntervalMs);
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
      await sleep(WAIT_INTERVAL_MS);
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

      await sleep(WAIT_INTERVAL_MS);
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
