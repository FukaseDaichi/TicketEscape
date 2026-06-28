# 予約の3入口と共通基盤

TicketEscape の「予約（＝指定時刻の自動カート投入を登録すること）」へ至る入口は3つある。3つは別機能ではなく、**同じ単一ジョブ（`te_job_v1`）＋ alarm ＋自動実行**に対する3つの入口で、すべて同じ予約を表示・操作する。

低レベルのモジュール構成・実行フローは [../CLAUDE.md](../CLAUDE.md)、UI デザインシステムは [../DESIGN.md](../DESIGN.md) を参照。本書はその上で「3入口の役割」と「入口間で共有する基盤」を現状の実装に即して定義する。

## 1. 3入口の役割

| | パターン1: ページ内パネル | パターン2: ポップアップ | パターン3: 詳細コンソール |
| --- | --- | --- | --- |
| 起点 | `escape.id` 配下のページ（常時表示） | ツールバーのアイコン | オプション画面 |
| 実装 | `content/content_script.js` | `popup/popup.js` | `options/options.js` |
| 券種の読み取り | ページ内で直接 | 行わない | URL から SW 経由で読み取り |
| 予約の作成・編集 | できる | できない | できる |
| 予約取り消し | できる | できる | できる |
| 実行履歴・詳細設定 | 出さない | 出さない | 出す |

- **パターン1**は `escape.id` 配下に常時パネルを出す。予約もフォームも無いページでは小さなランチャーバッジ、購入フォームのあるページでは読み取り→予約フローを出す。URL/DOM の変化は `popstate` / `hashchange` / 250ms ポーリングで追従する。
- **パターン2**は保存済み予約をビジュアル確認（公演名・画像・日時・券種・カウントダウン）し、取り消しと詳細コンソール遷移に専念する。読み取り・新規予約・編集はしない。
- **パターン3**は現在の予約カード（作成・編集・取り消し）、実行履歴、詳細設定を扱う。

## 2. 共通バックエンド

3入口とも最終的に行うことは同じ。

1. **読み取り（確認）** — `escape.id` のチケットページから公演名・券種・現在数量・メインビジュアル画像を取得する。`content_script.js` の `handleParseFormRequest()` / `waitForTicketRows()` を使い、購入実行ロジック（`applyTicketPlan()` / `submitCart()`）には触れない。
2. **予約** — `SAVE_JOB` で `te_job_v1` を保存し、`chrome.alarms`（`te_trigger_<jobId>`）を作成する。
3. **自動実行** — trigger 時刻に alarm 発火 → `dispatchExecution()` → 対象タブを開く/再利用 → 各タブの content script へ `EXECUTE_REQUEST`。

ユーザー向け用語は「予約」、内部実装の保存処理は従来どおり `SAVE_JOB`。

## 3. URL 判定（パラメータは任意）

`lib/shared.js` の3段階で判定する。**URL パラメータ（日付・時間の選択）は予約の必須条件ではなく、読み取り可能性の強い手がかりとして扱う。**

| 関数 | 条件 | 用途 |
| --- | --- | --- |
| `ensureEscapeUrl(url)` | `https://escape.id/*` | パネル生成のゲート。トップ/一覧でもバッジを出せる。 |
| `isEscapeTicketPageUrl(url)` | `escape.id` かつパス2階層以上（パラメータ任意） | popup/options の対象判定、SW の保存・読み取り・dispatch の検証。 |
| `isReservableTicketUrl(url)` | `isEscapeTicketPageUrl` ＋ パラメータ1個以上 | ページ内パネルが「URL だけで読み取り可能」とみなす補助判定。 |

- SW の `sanitizeJob()` / `handleParseForm()` / `dispatchExecution()` は `isEscapeTicketPageUrl()` で検証し、外れると `E_TICKET_PAGE_REQUIRED` を返す。パラメータ無しの `{org}/{event}/` 形式でも、パス2階層以上なら対象になりうる。
- ページ内パネルの読み取り可否は `isReservableTicketUrl(location.href) || hasPurchaseForm()`。パラメータが無くても購入フォームが DOM 上にあれば読み取り・保存へ進める。

## 4. 共通データモデル（`chrome.storage.local`）

| キー | 用途 |
| --- | --- |
| `te_job_v1` | アクティブな予約（**単一**）。`heroImageUrl`（https のみ）を含む。 |
| `te_status_v1` | 現在の実行ステータス |
| `te_last_run_v1` | 直近の実行結果（単一） |
| `te_logs_v1` | 内部ログ（最大300・リング） |
| `te_dispatch_guard_v1` | 二重実行ガード |
| `te_page_draft_v1` | ページ起点の一時ドラフト（`url` / `normalizedUrl` / `title` / `eventTitle` / `detectedAt` / `source`） |
| `te_preferences_v1` | 今後の予約に使う詳細設定の既定値 |
| `te_runs_v1` | 実行履歴リスト（成否込み、最大50） |
| `te_active_runs_v1` | 実行開始時点の job snapshot（`runId → { jobSnapshot, triggerEpoch, dispatchedAt, tabId }`） |

### 共有ビュー `buildReservationView(job, status)`

`lib/shared.js` の `buildReservationView()` が予約を1つの正規化ビュー（公演名・対象URL・trigger・残り時間・フェーズ・券種サマリ・`heroImageUrl`）にする。popup / content / options はすべてこのビューから描画するため、同じ予約はどこでも同じに見える。

### 詳細設定 `te_preferences_v1`

```js
{ clickIntervalMs, parallelTabCount, requireAgreement, autoSelectRequiredOptions, selectorOverrides }
```

パターン1・2では詳細設定を表示しないが、固定既定値に戻すと運用意図を壊すため、job とは別に preferences として保存して共通利用する。優先順位は「既存 job 編集時は job の値 → 新規予約は preferences → どちらも無ければ `DEFAULT_JOB`」。

`selectorOverrides` はサイトの DOM 変更時の上書き手段で、`formRoot` / `submitButton` / `heroImage` の3つを同じ仕組みで保持・適用する（`sanitizeSelectorOverrides()`）。読み取り時に content の `findFormRoot()` / `findSubmitButton()` / `extractHeroImageUrl()` が参照する。専用 UI は無く、必要時に storage 経由で設定する開発者向けのエスケープハッチ。

### 実行履歴 `te_runs_v1`

`dispatchExecution()` が `EXECUTE_REQUEST` の直前に `runId → jobSnapshot` を `te_active_runs_v1` に保存し、`EXECUTE_RESULT` 受信時に snapshot と結果を結合して `te_runs_v1` へ先頭追加（上限50）する。履歴は「1 job に1行」ではなく **`runId` 単位**で記録するため、`parallelTabCount > 1` のときは1回の dispatch で複数行が追加されうる。

## 5. メッセージ

`MESSAGE_TYPES`（`lib/shared.js`）。SW が中心ハブで、各入口は SW にだけ送る。

| メッセージ | 経路 | 用途 |
| --- | --- | --- |
| `GET_JOB` / `GET_STATUS` | 入口 → SW | 予約・ステータス・preferences の取得 |
| `SAVE_JOB` | 1/3 → SW | 予約の保存（上書き確認込み） |
| `CANCEL_JOB` | 1/2/3 → SW | 予約取り消し（§6） |
| `PARSE_FORM_REQUEST` | 3 → SW → content | URL から券種・画像を読み取り |
| `EXECUTE_REQUEST` / `EXECUTE_RESULT` / `STATUS_UPDATE` | SW ↔ content | 自動実行と進捗・結果 |
| `EXECUTE_NOW` | 3 → SW | 即時実行 |
| `OPEN_OPTIONS_WITH_PAGE` / `GET_PAGE_DRAFT` / `CLEAR_PAGE_DRAFT` | 1/2/3 ↔ SW | ページ起点ドラフトの受け渡し |
| `GET_RUNS` / `CLEAR_RUNS` | 3 → SW | 実行履歴 |
| `GET_PREFERENCES` / `SAVE_PREFERENCES` | 3 → SW | 詳細設定の既定値 |

`SAVE_JOB` のバリデーション（UI と `sanitizeJob()` / `handleSaveJob()` の両方で拒否）:

- `ticketPlans` に `targetQty > 0` が1件以上必要（`E_TICKET_QTY_REQUIRED`）。
- `targetUrl` はチケットページ（パス2階層以上）である必要がある（`E_TICKET_PAGE_REQUIRED`）。
- 新規予約は実行時刻のユーザー確認が必要（`E_TRIGGER_CONFIRM_REQUIRED`）。
- 別 URL・別 jobId の予約を置き換える場合は `replaceConfirmed: true` ＋ `expectedPreviousJobId` が必要（`E_REPLACE_CONFIRM_REQUIRED`）。
- trigger 時刻が過去なら拒否（`E_TRIGGER_PAST`）。

## 6. 予約取り消し（SW 単一経路）

取り消しは **SW の `handleCancelJob()` だけがストレージ・alarm を変更する**。3入口とも同じ手順を踏む。

1. `GET_JOB` で live job を取り直す（古いローカルコピーを消さない）。
2. live job が無ければ UI を空状態にして終了。
3. `CANCEL_JOB { expectedJobId }` を送る。SW は `expectedJobId` が現在の予約と一致するときだけ取り消す（不一致なら `E_REPLACE_CONFIRM_REQUIRED`）。

これにより、どの入口から取り消しても経路が1つに揃い、操作直前に別入口で予約が変わった場合の取り違えを防ぐ。詳細コンソールは context 失効時のみページを再読み込みして復帰する。

## 7. エラー辞書

同じ失敗は入口に関係なく同じ文言で出す。`lib/shared.js` の `ERROR_MESSAGES`（`errorCode → ユーザー文言`）に集約し、`getErrorMessage(code, fallback)` で引く。読み取り・実行中に content script が出すコード（`E_COUNTER_TIMEOUT` / `E_QTY_ADJUST_FAILED` / `E_AGREEMENT_NOT_CHECKED` / `E_EXECUTION_FAILED` / `E_WAIT_TIMEOUT` など）も辞書に含め、履歴表示や失敗表示が原文でなく辞書文言になるようにする。

## 8. 非ゴール

- ページ訪問だけで自動購入はしない。予約は必ずユーザーの明示操作。
- ユーザー確認なしに既存の予約を上書きしない。
- ログイン・決済の自動化は追加しない。
- 対象外ドメインにはパネルを出さない。
- アクティブ予約は常に1件。複数予約の並行保持はしない。
