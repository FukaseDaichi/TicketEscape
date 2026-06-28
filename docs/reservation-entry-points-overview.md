# 予約入口 3パターン — 概要と共通基盤

TicketEscape の「予約（＝実行待機の登録）」へ至る入口を 3 つ用意する。ユーザーの状況に応じて最短で予約でき、かつ **今の設定画面起点の体験も残す**。本書は 3 パターンに共通する基盤・データ・メッセージ・用語を定義し、各パターンの設計書（`pattern-1/2/3-*.md`）はここを参照する。

関連: [DESIGN.md](../DESIGN.md)（CONSOLE デザインシステム）, [ticket-page-entry-ux-design.md](ticket-page-entry-ux-design.md)（パターン1の検知・起動パネルの先行設計）, [reservation-entry-points-improvement-review.md](reservation-entry-points-improvement-review.md)（3パターン設計の改善検討）。

> 実装時の正は本 overview と `pattern-1/2/3-*.md`。`ticket-page-entry-ux-design.md` は先行案・背景資料として扱い、パターン1で矛盾がある場合は `pattern-1-in-page-reservation-design.md` を優先する。

---

## 1. 3パターンの位置づけ

3 つは「別機能」ではなく、**同じバックエンド（単一ジョブ＋alarm＋自動実行）に対する 3 つの入口**。能力は段階的に増える。

| | パターン1: ページ内 | パターン2: ポップアップ | パターン3: 詳細画面 |
| --- | --- | --- | --- |
| 起点 | escape.id 配下のページ（常時表示） | ツールバーのアイコン | オプション（拡張の設定） |
| 主対象 | 「今このページを予約したい」人 | 予約をビジュアル確認・取り消ししたい人 | じっくり設定・運用する人 |
| URL | URLパラメータ付きの現在ページから自動 | 表示のみ（編集しない） | 手入力 / ページ起点で自動 |
| 券種の読み取り | ページから直接 | 行わない | URLからSW経由で読み取り |
| メインビジュアル画像 | 読み取って保存 | 直接リンク表示 | サムネ表示 |
| 数量・日時の変更 | できる | できない（詳細コンソールへ） | できる |
| 予約（実行待機）の作成 | できる | できない（作成は1/3） | できる |
| 予約取り消し | できる | できる | できる |
| 過去の履歴・成否 | 出さない | 直近の結果のみ | **一覧で出す** |
| 詳細設定（間隔・並列など） | 出さない（preferences使用） | 出さない | **変更できる** |
| 実装の土台 | content script（新規UI） | popup（ビジュアル確認） | options（現行＋履歴/詳細） |

**設計指針**: 予約の**作成・編集**はパターン1（ページ内）と3（詳細コンソール）が担い、パターン2（ポップアップ）は**ビジュアル確認＋取り消し**に専念する。3画面は共有 `buildReservationView(job, status)` から描画し、同じ `te_job_v1` を見るため表示・挙動が一致する。最新方針は [3-pattern-sync-redesign-design.md](3-pattern-sync-redesign-design.md) が正。

---

## 2. 共通バックエンド（変えない中核）

3 パターンとも、最終的に行うのは同じ：

1. **読み取り（確認）** — URLパラメータ付きのチケットページを対象に、`content_script.js` の `handleParseFormRequest()` / `waitForTicketRows()` で公演名・券種・現在数量を取得（購入実行ロジック `applyTicketPlan()` / `submitCart()` には触れない）。
2. **予約（実行待機）** — `SAVE_JOB` で `te_job_v1` を保存し、`chrome.alarms`（`te_trigger_<jobId>`）を作成。
3. **自動実行** — trigger 時刻に alarm 発火 → `dispatchExecution()` → 対象タブを開く/再利用 → content の `EXECUTE_REQUEST`。

> 用語統一: 本プロジェクトの「**予約**」＝ 現行の「**実行待機を開始**（`SAVE_JOB`）」。当日 trigger 時刻に自動でカート投入まで行う。ユーザー向けには「予約」、内部実装では従来名を維持する。

---

## 3. 共通データモデル（chrome.storage.local）

| キー | 状態 | 用途 | 変更 |
| --- | --- | --- | --- |
| `te_job_v1` | 既存 | アクティブな予約（**単一**） | `heroImageUrl`（https のみ）を追加 |
| `te_status_v1` | 既存 | 現在の実行ステータス | 変更なし |
| `te_last_run_v1` | 既存 | 直近の実行結果（単一） | 変更なし（互換維持） |
| `te_logs_v1` | 既存 | 内部ログ（最大300・リング） | 変更なし |
| `te_dispatch_guard_v1` | 既存 | 二重実行ガード | 変更なし |
| `te_page_draft_v1` | 新規 | ページ起点の一時ドラフト（URL/tabId 等） | パターン1で導入 |
| `te_preferences_v1` | 新規 | 今後の予約に使う詳細設定の既定値 | 全パターンで使用 |
| `te_runs_v1` | 新規 | **実行履歴リスト**（成否込み、最大50） | パターン3で導入 |
| `te_active_runs_v1` | 新規 | 実行開始時点の job snapshot | 履歴の正確性確保 |

### `te_preferences_v1`（詳細設定の既定値）

パターン1・2では詳細設定を表示しないが、常に固定の既定値へ戻すとユーザーの運用意図を壊す。そのため、詳細設定は job とは別に preferences として保存し、簡易入口でも共通利用する。

```js
{
  clickIntervalMs: 30,
  parallelTabCount: 1,
  requireAgreement: true,
  selectorOverrides: null
}
```

優先順位:

1. 既存job編集時は job に保存された詳細値
2. 新規予約時は `te_preferences_v1`
3. preferences がない場合のみ `DEFAULT_JOB`

### `te_runs_v1`（実行履歴）の形

`EXECUTE_RESULT` 受信時に append（先頭が新しい、上限50で末尾を捨てる）。`te_last_run_v1` の上書きと併用する。履歴には、実行完了時点の現在jobではなく、**dispatch時点の job snapshot** を保存する。

```js
// te_runs_v1: RunRecord[]
{
  runId: "run_...",
  jobId: "job_...",
  eventTitle: "公演名（保存時点のスナップショット）",
  targetUrl: "https://escape.id/...",
  heroImageUrl: "https://...（保存時点のスナップショット）",
  ticketPlans: [{ ticketLabel, targetQty }],
  triggerAtJst: "2026-...＋09:00",
  status: "SUCCESS" | "FAILED",
  errorCode: "E_... | null",
  startedAt: 1710000000000,
  finishedAt: 1710000003000
}
```

### `te_active_runs_v1`（実行中snapshot）

`dispatchExecution()` が content script へ `EXECUTE_REQUEST` を送る直前に、`runId -> jobSnapshot` を保存する。`EXECUTE_RESULT` 受信時に snapshot と結果を結合して `te_runs_v1` へ追加し、該当 `runId` は削除する。

```js
{
  [runId]: {
    jobSnapshot,
    triggerEpoch,
    dispatchedAt,
    tabId
  }
}
```

> **前提・未決（要確認）**: 本設計は「**アクティブ予約は常に1件**＋実行履歴を一覧化」という方針を採る。同時に複数の予約を並行保持する要望がある場合は、`te_job_v1` を `te_jobs_v1`（配列）へ拡張する別設計が必要になる。まずは単一ジョブ＋履歴で 3 パターンを統一する。

---

## 4. 共通メッセージ（既存＋新規）

既存（`MESSAGE_TYPES`）: `GET_JOB` / `SAVE_JOB` / `GET_STATUS` / `PARSE_FORM_REQUEST` / `EXECUTE_REQUEST` / `EXECUTE_RESULT` / `EXECUTE_NOW` / `STATUS_UPDATE` / `PING`。

新規（3パターンで追加）:

| メッセージ | 送信元 → 先 | 用途 | 使うパターン |
| --- | --- | --- | --- |
| `OPEN_OPTIONS_WITH_PAGE` | content → SW | 現在ページをドラフト保存して設定画面を開く | 1 |
| `GET_PAGE_DRAFT` | options → SW | 起動時にドラフト取得 | 1, 3 |
| `CLEAR_PAGE_DRAFT` | options/content → SW | 予約成功・URL手動変更でドラフト破棄 | 1, 3 |
| `GET_RUNS` | options → SW | 実行履歴 `te_runs_v1` を取得 | 3 |
| `CLEAR_RUNS` | options → SW | 履歴クリア | 3 |
| `GET_PREFERENCES` | options/popup/content → SW | 詳細設定の既定値取得 | 1,2,3 |
| `SAVE_PREFERENCES` | options → SW | 詳細設定の既定値保存 | 3 |

ポップアップは読み取り・新規予約・編集を行わない（ビジュアル確認＋取り消しのみ）。読み取りはページ内パネルで直接行うか、詳細コンソールの `PARSE_FORM_REQUEST`（URLから読み取り）で行う。`PARSE_FORM_REQUEST` の応答には `heroImageUrl`（メインビジュアル画像）を含める。

`SAVE_JOB` はパターン1・3 から呼ばれるため、上書き確認を共通化する。別URL・別jobIdの予約を置き換える場合は、UI確認に加えて SW 側でも `replaceConfirmed: true` と `expectedPreviousJobId` がない保存を拒否する。`SAVE_JOB` の job には `heroImageUrl` を含めてよい（SW が https のみにサニタイズ）。

`CANCEL_JOB` は3入口すべてから呼べる。各UIは取り消し直前に `GET_JOB` で **live jobId を取り直して** `expectedJobId` に渡す。`expectedJobId` は任意で、未指定なら現在の予約をそのまま取り消す（[3-pattern-sync-redesign-design.md](3-pattern-sync-redesign-design.md) §3.2）。

```js
{
  type: MESSAGE_TYPES.SAVE_JOB,
  job,
  replaceMode: "create" | "update" | "replace",
  expectedPreviousJobId: "job_...",
  replaceConfirmed: true
}
```

SW共通バリデーション:

- `ticketPlans` に `targetQty > 0` が1件以上必要。
- `targetUrl` は `https://escape.id/{任意}/{任意}/?...` のようにURLパラメータ付きである必要がある。
- `https://escape.id/uzu-org/e-MIRAGE/` のようにURLパラメータがないページは予約不可。
- 新規予約では実行時刻のユーザー確認が必要。
- 既存予約を別URLで置き換える場合は明示確認が必要。
- これらはUIだけでなく `sanitizeJob()` / `handleSaveJob()` 側でも拒否する。

---

## 5. 共通の予約フロー（抽象）

```
[読み取り(確認)] → [券種が反映] → [数量を調整] → [実行時刻を確認] → [予約(実行待機)]
        ↑ 入口ごとに「どこで・どう」読み取るかだけが違う。以降は共通。
```

- パターン1: ページ上で直接読み取り → そのままページ内パネルで予約。
- パターン2: 読み取り・予約はしない。保存済み予約をビジュアル確認（画像・公演名・日時・券種・カウントダウン）し、取り消しのみ。
- パターン3: URLから読み取り → 予約／編集＋履歴・詳細設定。

---

## 6. 共通ビジュアル / アクセシビリティ

- [DESIGN.md](../DESIGN.md) の CONSOLE 準拠（ダーク固定・アンバーは希少な信号・絵文字禁止・単線SVG・トークンは `styles/tokens.css`）。
- 状態は色だけに依存しない（ラベル＋アイコン併用）。`prefers-reduced-motion` 尊重。
- 「予約」ボタンは各入口で最も明るい amber 実体ボタン。数量0のときは amber パルスで「数量を設定」を促す（勝手に1にしない）。
- ただし数量0のまま保存はできない。予約ボタンは disabled にし、SW も拒否する。
- 「予約」はユーザーに短く見せ、初回のみ「指定時刻にこのページを開き、選んだ数量でカート投入します」と補足する。内部用語は従来どおり「実行待機」。

## 7. 共通エラー辞書

同じ失敗は入口に関係なく同じ文言で表示する。実装では `lib/shared.js` に errorCode → ユーザー文言を集約する。

| errorCode | ユーザー文言 |
| --- | --- |
| `E_FORM_TIMEOUT` | チケットフォームが見つかりません。購入ページを開いてから再試行してください。 |
| `E_TICKET_LIST_TIMEOUT` | フォームは見つかりましたが、券種を読み取れませんでした。ページの読み込み後に再試行してください。 |
| `E_TICKET_NOT_FOUND` | 選択した券種がページ上に見つかりませんでした。もう一度読み取ってください。 |
| `E_SUBMIT_NOT_APPLIED` | カート投入が反映されませんでした。ページ状態を確認してください。 |
| `E_REPLACE_CONFIRM_REQUIRED` | 別の予約が実行待機中です。切り替える場合は確認してください。 |
| `E_TICKET_QTY_REQUIRED` | 予約するには、1枚以上の数量を設定してください。 |
| `E_TRIGGER_CONFIRM_REQUIRED` | 実行時刻を確認してください。 |

---

## 8. 非ゴール（3パターン共通）

- ページ訪問だけで自動購入はしない。予約は必ずユーザーの明示操作。
- ユーザー確認なしに既存の予約を上書きしない（別ページ予約時は切替を明示）。
- ログイン・決済の自動化は追加しない。
- 対象外ドメインには出さない。
