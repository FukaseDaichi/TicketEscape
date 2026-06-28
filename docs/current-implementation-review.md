# 現行実装レビュー（2026-06-28）

本書は、2026-06-28 時点の実装を正として `/docs` を見直した結果を残すメモ。コードは変更しない前提で、実装済みの挙動と、今後コード側で確認したい懸念を分けて記録する。

関連: [reservation-entry-points-overview.md](reservation-entry-points-overview.md), [3-pattern-sync-redesign-design.md](3-pattern-sync-redesign-design.md), [superpowers/specs/2026-06-28-param-optional-reservation-design.md](superpowers/specs/2026-06-28-param-optional-reservation-design.md)

## 1. 実装済みの正

### 1.1 URL判定は3段階

現行実装では URL 判定が次の3段階に分かれている。

| 関数 | 条件 | 主な用途 |
| --- | --- | --- |
| `ensureEscapeUrl(rawUrl)` | `https://escape.id/*` | content panel の生成ゲート。escape.id 配下ならトップ/一覧でも小バッジを出せる。 |
| `isEscapeTicketPageUrl(rawUrl)` | `https://escape.id/{org}/{event}` 相当（パス2階層以上、URLパラメータ任意） | popup/options の「対象チケットページ」判定、SW の `SAVE_JOB` / `PARSE_FORM_REQUEST` / dispatch 検証。 |
| `isReservableTicketUrl(rawUrl)` | `isEscapeTicketPageUrl` + URLパラメータ1個以上 | content panel の `canReadCurrentPage()` で、URLだけで読み取り可能とみなす補助判定。 |

重要: 現在の SW 検証は `isReservableTicketUrl()` ではなく `isEscapeTicketPageUrl()` を使っている。そのため、バックエンド上は URLパラメータ無しの `{org}/{event}/` 形式でも、パス2階層以上なら保存・読み取り要求・dispatch の対象になりうる。ページ内パネルは `isReservableTicketUrl(location.href) || hasPurchaseForm()` を使うため、URLパラメータ無しでも購入フォームが DOM 上にあれば読み取り・保存へ進める。

### 1.2 3入口の役割

- パターン1（ページ内）: `ensureEscapeUrl(location.href)` で escape.id 配下に常時パネルを生成する。予約が無くフォームも無いページでは小さなランチャーバッジ、購入フォームまたはURLパラメータ付きページでは読み取りフローを出す。URL/DOM 状態は `popstate` / `hashchange` / 250ms polling で追従する。
- パターン2（ポップアップ）: `GET_STATUS` と現在タブ判定で表示する。`SAVE_JOB` は送らず、予約サマリ表示・予約取り消し・詳細コンソール遷移に専念する。
- パターン3（詳細コンソール）: ライブ予約カードは常時表示される（予約なしでも空状態を出す）。ウィザードは作成・編集、サイド側は状態・履歴・詳細設定を扱う。

### 1.3 共通 view / storage / history

- `buildReservationView(job, status)` が popup/content/options の予約サマリ表示の正規化に使われている。
- `te_preferences_v1` は保存済み job の詳細値からも更新される。詳細設定フォームの変更は `SAVE_PREFERENCES` で即保存される。
- `dispatchExecution()` は並列タブごとに `runId` を発行し、`te_active_runs_v1` に job snapshot を保存する。`EXECUTE_RESULT` 受信時に `te_runs_v1` へ append する。
- 実行履歴は「1 job に1行」ではなく、content script から返った `runId` 単位で記録される。`parallelTabCount > 1` の場合、1回の dispatch で複数履歴が追加される可能性がある。

### 1.4 読み取り・ドラフト

- ページ内パネルは content script 内で `handleParseFormRequest()` を直接呼ぶ。
- 詳細コンソールの `情報を読み取る` は `PARSE_FORM_REQUEST` を SW に送り、SW が対象 URL のタブを開いて content script へ読み取り要求を送る。
- `OPEN_OPTIONS_WITH_PAGE` は `PAGE_DRAFT.tabId` を保存するが、現行の詳細コンソール読み取りでは `tabId` を使って元タブへ直接送信していない。
- 詳細コンソール起動時に既存予約がある場合、`loadPageDraft()` はドラフトを破棄する。ライブ予約カードを正とし、別ページのドラフトでフォームを上書きしない挙動になっている。

## 2. 既知の実装懸念（コードは未修正）

### P1. URLパラメータ必須の文言と実装がずれている

`E_URL_PARAMS_REQUIRED` や一部UIコピーは「日付と時間を指定して購入画面を開いてください」という意味を持つが、SW の `sanitizeJob()` / `handleParseForm()` / `dispatchExecution()` は `isEscapeTicketPageUrl()` を見ており、URLパラメータの有無を必須にしていない。

このため、詳細コンソールではパラメータ無し URL と手動券種で予約保存できる可能性がある。実装を正とするなら docs では「パラメータは推奨・購入フォーム検出の強い手がかり。保存の絶対条件ではない」と扱う。将来コードを直すなら、保存を本当にパラメータ必須に戻すか、エラーコード/コピー名を `E_TICKET_PAGE_REQUIRED` 相当に変えるかを決める必要がある。

### P1. 詳細コンソールの取り消しが SW 経由の単一経路ではない

popup/content は live job を取り直して `CANCEL_JOB expectedJobId` を送る。一方、詳細コンソールの `cancelJob()` はまず options 側で `chrome.storage.local` の `te_job_v1` / guard / draft を削除し、alarm も直接 clear したうえで、後から `CANCEL_JOB` を送る。

現状の体験としては取り消せるが、SW の `handleCancelJob()` を正規の単一経路にできていない。操作直前に別入口で予約が変わった場合、options 側の直接削除が最新予約を消す可能性がある。また、SW ログ上は `no-job` になりやすく、取り消しイベントの監査性が弱い。

### P2. `selectorOverrides.heroImage` は抽出側だけの部分対応

content script の `extractHeroImageUrl()` は `selectorOverrides.heroImage` を見ている。しかし SW の `sanitizeSelectorOverrides()` と preferences 保存は `formRoot` / `submitButton` だけを保持するため、`heroImage` override は job/preferences として永続化されない。現状では直接 `PARSE_FORM_REQUEST` に渡された場合だけ効く部分実装。

### P2. 詳細コンソールのドラフト tabId は読み取りに使われていない

`PAGE_DRAFT.tabId` は保存されるが、options の `parseForm()` は URL だけを SW に渡す。元タブを再利用する設計とは異なり、実装では SW が対象 URL のタブを開く。ユーザーが見ているタブの一時状態と、SW が開いたタブの状態がずれる可能性がある。

### P2. エラー辞書は主要コードのみ

`ERROR_MESSAGES` は主要な失敗を共通化しているが、content script で発生しうる `E_COUNTER_TIMEOUT` / `E_QTY_ADJUST_FAILED` / `E_AGREEMENT_NOT_CHECKED` / `E_EXECUTION_FAILED` などは辞書に無い。これらは fallback の原文寄りメッセージで表示される。

## 3. docs への反映方針

- 正式仕様系（overview / pattern-1 / pattern-2 / pattern-3 / 3-pattern-sync）は、上記の現行実装を優先して記述する。
- `ticket-page-entry-ux-design.md` は先行案として残し、現行実装との差分を明記する。
- `superpowers/specs/2026-06-28-param-optional-reservation-design.md` は設計当時の A案ではなく、実装後レビューとして「保存判定もパラメータ任意に寄っている」事実を追記する。
