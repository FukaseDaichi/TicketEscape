# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TicketEscape is a Chrome extension (Manifest V3) that automates ticket cart operations on `https://escape.id/*` at a scheduled time using DOM `click()` operations. There is no build system — all files are plain vanilla JavaScript loaded directly into Chrome.

## Development Workflow

No build step required. To develop and test:

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this repository directory (where `manifest.json` lives)
4. After making code changes, click the **refresh icon** on the extension card in `chrome://extensions/`
5. For service worker changes, also click **"Service Worker"** link to open DevTools for the background context

To inspect logs:
- **Service worker**: `chrome://extensions/` → TicketEscape → "Service Worker" link
- **Content script**: DevTools on any `escape.id` page → Console
- **Options page**: Right-click options page → Inspect

## Architecture

### Module Structure

```
lib/shared.js          ← Shared constants and utilities (loaded first everywhere)
background/
  service_worker.js    ← MV3 service worker; alarm scheduling, tab management, job orchestration
content/
  content_script.js    ← Injected into escape.id pages; DOM interaction and form automation
options/
  options.html/js      ← Settings UI; the main user-facing configuration page
popup/
  popup.html/js        ← Extension icon popup; read-only job summary + link to options
```

### Shared Global (`TE_SHARED`)

`lib/shared.js` is an IIFE that sets `globalThis.TE_SHARED` with constants and utilities used across all contexts. It guards against double-initialization. It is:
- Loaded via `importScripts("../lib/shared.js")` in the service worker
- Loaded as a `<script>` tag before other scripts in options and popup HTML

Key exports: `STORAGE_KEYS`, `MESSAGE_TYPES`, `STATUS`, `DEFAULT_JOB`, and utility functions (`ensureEscapeUrl`, `toEpoch`, `clampInt`, `normalizeLabel`, etc.).

### Message Passing

All inter-context communication uses `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` with typed messages defined in `MESSAGE_TYPES`. The service worker is the central hub:

- **Options → SW**: `SAVE_JOB`, `GET_JOB`, `GET_STATUS`, `PARSE_FORM_REQUEST`, `EXECUTE_NOW`
- **SW → Content**: `PARSE_FORM_REQUEST` (scrape ticket list), `EXECUTE_REQUEST` (run automation)
- **Content → SW**: `STATUS_UPDATE` (progress reporting), `EXECUTE_RESULT` (completion)

### Execution Flow

1. User sets URL + trigger time in options page → clicks **実行待機** → sends `SAVE_JOB` to SW
2. SW validates job, saves to `chrome.storage.local`, creates a `chrome.alarms` entry (`te_trigger_<jobId>`)
3. At trigger time, alarm fires → SW calls `dispatchExecution()`
4. SW opens/reuses tabs on the target URL (`resolveExecutionTabs`), waits for tab load
5. SW sends `EXECUTE_REQUEST` to each tab's content script with `triggerEpoch` and job config
6. Content script: waits for form (`waitForTicketRows`) → adjusts quantities (`applyTicketPlan`) → checks checkboxes (`ensureAgreementChecks`) → precision-waits for `triggerEpoch` → clicks submit repeatedly (`submitCart`)
7. Content script sends `EXECUTE_RESULT` back to SW; SW updates `STATUS` and `LAST_RUN` in storage

The options page also navigates to the target URL at `triggerEpoch` (so it becomes one of the reusable tabs), using a client-side countdown loop with `requestAnimationFrame` for precision timing.

### Storage Keys (`chrome.storage.local`)

| Key | Purpose |
|-----|---------|
| `te_job_v1` | Current saved job configuration |
| `te_status_v1` | Current execution status |
| `te_last_run_v1` | Result of the last execution |
| `te_logs_v1` | Ring-buffer log (max 300 entries) |
| `te_dispatch_guard_v1` | Deduplication guard for alarm-triggered dispatches |

### DOM Selector Strategy

The content script uses heuristic selectors for `escape.id`'s form structure:
- Form root: `form.flex-1` (primary), or first `<form>` containing a submit button
- Ticket list: scored `<ul>` element inside the form (prefers lists with labels + counter controls)
- Counter controls: pattern `BUTTON > P > BUTTON` where `P` contains a digit

`selectorOverrides` on the job object allows overriding `formRoot` and `submitButton` CSS selectors when the site's DOM changes.
