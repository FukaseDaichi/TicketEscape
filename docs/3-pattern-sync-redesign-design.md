# 予約入口3パターンの同期と再設計（設計書）

> 共通基盤は [reservation-entry-points-overview.md](reservation-entry-points-overview.md)、各入口は [pattern-1](pattern-1-in-page-reservation-design.md) / [pattern-2](pattern-2-popup-reservation-design.md) / [pattern-3](pattern-3-detail-console-design.md) を参照。本書はそれら3入口の **同期不整合の解消** と、**パターン2（ポップアップ）のビジュアル化** を中心とした再設計を定義する。本書と各 pattern doc に差分がある場合は本書を優先する。

## 1. 目的・背景

3入口（[content_script.js](../content/content_script.js) / [popup](../popup/popup.js) / [options](../options/options.js)）は単一 `te_job_v1` ＋ `chrome.storage.onChanged` を土台に同期する想定だが、各画面が job/status を**別々のロジック**で解釈するため表示がドリフトし、次の不具合が出ている。

- **詳細コンソールで予約を取り消せないことがある**: `cancelJob()` が古くなりうる `state.loadedJob.jobId` を使い、SW [handleCancelJob](../background/service_worker.js) は `expectedJobId` 不一致で `E_REPLACE_CONFIRM_REQUIRED` を返す。さらに `loadPageDraft()` がドラフト取込時に `jobId` 入力欄を空にするため、取り消し導線が壊れる。
- **パターン1パネルが限定的**: 表示ゲートが `isEscapeTicketPageUrl`（パス2セグメント以上）で、`https://escape.id/` 直下などでは出ない。予約中でも別ページでは見えない。
- **ポップアップが編集フォーム中心**: 予約状況の「ビジュアル確認」になっていない。公演のメインビジュアル画像も出ない。
- **表記の揺れ**: 「設定を開く」と「詳細コンソール」が混在。

## 2. 方針（採用アプローチ A）

`lib/shared.js` に **予約サマリを正規化する単一関数** を設け、3画面とも同じデータから描画する。単一ジョブ＋`storage.onChanged` の現行構造は維持し、変更を最小化する。「同じ予約は、どの入口でも同じに見える」を保証することが同期問題の核の解決になる。

不採用: (B) SWに全UI状態を集約＝大改修・過剰、(C) 個別パッチのみ＝同期ドリフトの原因が残る。

## 3. 共通化（同期の核）

### 3.1 `buildReservationView(job, status)` — `lib/shared.js` に追加

job と status から、全画面共通の描画用ビューモデルを返す純粋関数。

```js
// 返り値
{
  hasReservation: boolean,     // job があり targetUrl/triggerAtJst が妥当
  targetUrl: string,
  eventTitle: string,
  triggerEpoch: number | null,
  triggerJstText: string,      // 例 "2026-06-27 22:00:00"（JST固定）
  remainingMs: number | null,  // triggerEpoch - now（無ければ null）
  phase: "idle" | "armed" | "tminus" | "firing" | "success" | "failed",
  ticketSummary: [{ ticketLabel, targetQty }], // targetQty > 0 のみ
  heroImageUrl: string         // https のみ、無ければ ""
}
```

- `phase` 導出は現行 popup の `phaseOf()` ロジックを共通化する（`status.state` と `remainingMs`：SUCCESS/FAILED は状態優先、実行中状態または `remainingMs <= 0` は `firing`、`remainingMs <= 60s` は `tminus`、それ以外で予約中は `armed`、無予約は `idle`）。
- `triggerJstText` は `Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", ... })`（現行 popup の `formatJst` を共通化）。
- popup / content / options は **この関数の返り値だけ** を見て予約サマリを描画する。各画面固有の編集状態（フォーム入力中の値など）はこの限りでない。

### 3.2 取り消しの堅牢化

- **UI側**: 取り消し直前に `GET_JOB` で**現在の jobId を取り直して** `CANCEL_JOB { expectedJobId: liveJobId }` を送る。live job が無ければ「予約なし」表示にして終了する（古い `state.loadedJob` を信頼しない）。
- **SW `handleCancelJob`**: `expectedJobId` が未指定（falsy）の場合は **現在保存中の job をそのまま取り消す**（明示的なユーザー操作のため）。`expectedJobId` 指定があり不一致なら従来どおり拒否する（UIが live id を渡すので実質的に不一致は起きない）。
- **options `loadPageDraft()`**: 現在予約の管理は後述「現在の予約カード」（live job 直結）が担うため、ドラフト取込でウィザード側 `jobId` 入力を空にしても取り消しは壊れない。ドラフトは自由に表示してよい。

## 4. データモデル変更

ジョブに `heroImageUrl` を1フィールド追加する（新規ストレージキー・新規メッセージは不要）。

| 対象 | 変更 |
| --- | --- |
| `te_job_v1`（job） | `heroImageUrl: string`（https のみ）を追加 |
| `sanitizeJob()` | `heroImageUrl` を `ensureHttpsUrl()` で検証（https のみ・最大1000字）。不正は空文字 |
| RunRecord / `te_runs_v1` | `heroImageUrl` をスナップショットに含める（任意・表示用） |
| `te_active_runs_v1` | 変更なし（job snapshot に内包される） |

`lib/shared.js` に `ensureHttpsUrl(raw)` を追加（`new URL` で `protocol === "https:"` のみ許可、それ以外は `""`）。

## 5. ヒーロー画像の抽出（content_script）

`handleParseFormRequest()` の返り値に `heroImageUrl` を追加する。抽出は次の優先順位（最初に取れたものを絶対URL化して返す）。

1. **`div[class^="first"] img`** の `currentSrc`/`src`（escape.id チケットページの公演メインビジュアル。ユーザー指定セレクタ）
2. `meta[property="og:image"]` の `content`
3. ページ内 `<img>` のうちレンダリング面積が最大のもの（フォールバック）

- 取得できなければ `""`。
- ポップアップは読み取りを行わない設計のため、`heroImageUrl` は **予約作成時（パターン1の読み取り or パターン3の `PARSE_FORM_REQUEST`）に job へ保存** され、ポップアップはそれを表示する。
- 将来の DOM 変更に備え、`selectorOverrides.heroImage`（CSSセレクタ）で 1 の指定を上書き可能にする（任意・段階実装）。

## 6. パターン1（ページ内パネル）

### 6.1 表示ゲート
`initReservationPanel()` の門前判定を `isEscapeTicketPageUrl(location.href)` → **`ensureEscapeUrl(location.href)`** に変更。escape.id 配下なら常時パネルを生成する。

### 6.2 状態（上から優先）
`buildReservationView` ＋ 現在URL／フォーム検出から決定する。

| 状態 | 条件 | 表示・主ボタン |
| --- | --- | --- |
| `ARMED`（同ページ） | 予約あり & job.url ≈ location | STANDBY＋カウントダウン＋公演名＋**予約取り消し**＋詳細コンソールで開く |
| `OTHER_RESERVED`（別ページ・予約可） | 予約あり & job.url ≠ location & 現在ページが購入フォーム有 | 「別の公演を予約中」サマリ＋**このページを予約する**（読み取りフロー、保存時に切替確認）＋予約取り消し＋詳細コンソールで開く |
| `OTHER_RESERVED_VIEW`（別ページ・予約不可） | 予約あり & job.url ≠ location & フォーム無し | 「別の公演を予約中」サマリ＋カウントダウン＋予約取り消し＋詳細コンソールで開く |
| `READY`→`READING`→`FORM` | 無予約 & 購入フォーム検出可（URLパラメータ有） | 既存の 読み取り→数量→時刻→予約 フロー |
| `LAUNCHER` | 無予約 & フォーム無し（トップ/一覧等） | 小さな「TicketEscape」ランチャーバッジのみ（クリックで詳細コンソール） |

- 予約中はどの escape.id ページでもカウントダウンと取り消しが見える（＝同期の主要メリット）。
- `ARMED`/`OTHER_RESERVED_VIEW` のカウントダウンは `buildReservationView.remainingMs` を 250ms 間隔で再描画。
- `FORM` で予約成功時に `heroImageUrl` を含めて `SAVE_JOB`。

## 7. パターン2（ポップアップ＝ビジュアル確認に専念）

編集フォーム（URL入力・実行時刻・数量ステッパー・保存ボタン）と `SAVE_JOB` 送信を**撤去**する。読み取りも行わない。

### 7.1 状態

| 状態 | 条件 | 表示 |
| --- | --- | --- |
| 予約あり | `hasReservation` | カウントダウン（hero）＋**ヒーロー画像**＋公演タイトル＋実行日時(JST)＋購入チケットchip（例 `一般×2`）＋**予約取り消し**＋詳細コンソールで開く |
| 対象タブ上・無予約 | 現在タブが escape.id チケットページ | 「このページを予約できます」案内＋詳細コンソールで開く |
| その他・無予約 | 上記以外 | 「予約はありません」案内＋詳細コンソールで開く |

### 7.2 レイアウト（予約あり）
```
[header: brand + STANDBY chip]
[hero: 大きいカウントダウン 00:11:36]      ← 既存 #hero を流用
[card]
  [ヒーロー画像（16:9・角丸・onerror で枠ごと非表示）]
  [公演タイトル]
  [実行日時 (JST)]   [チケットchip: 一般×2 学生×1]
  [予約取り消し]（danger）
[詳細コンソールで開く]（primary・最下部）
```
- 画像は `job.heroImageUrl` を `<img referrerpolicy="no-referrer">` で直接リンク表示。`onerror` で画像枠を隠す（§10）。
- 取り消しは §3.2 の堅牢化フロー（live id 再取得 → `CANCEL_JOB`）。

## 8. パターン3（詳細コンソール＝編集と取り消しの「正」）

### 8.1 「現在の予約」カード（新設）
`intro` の直後・Step1 の前に追加。`te_job_v1`（live job）に直結し `storage.onChanged` で常時同期する。

- 予約があるときのみ表示。内容: 公演タイトル＋実行日時(JST)＋購入チケットサマリ＋ヒーロー画像サムネ＋**予約取り消し**。
- ウィザードのフォーム状態・ページドラフトに**左右されず**取り消せる（取り消しバグの恒久対策）。

### 8.2 ウィザード（Step1〜4）
- 役割は従来どおり「作成・編集」。プリフィル・履歴からの再予約も従来どおり。
- Step4 の重複する「予約取り消し」ボタンは撤去し、§8.1 のカードへ集約。Step4 は「予約（保存）」のみ。
- `loadPageDraft()` の不整合修正（jobId 入力を空にして取り消し不能化していた問題は §3.2＋§8.1 で解消）。

## 9. 表記統一

「設定を開く」「設定画面で…」を **「詳細コンソールで開く」/「詳細コンソール」** に統一する。

| 箇所 | 現在 | 変更後 |
| --- | --- | --- |
| [popup.html](../popup/popup.html) 最下部ボタン | 設定を開く | 詳細コンソールで開く |
| [popup.js](../popup/popup.js) 空状態の文言 | 設定画面で… | 詳細コンソールで… |
| [content_script.js](../content/content_script.js) ARMED | 詳細コンソールを開く | 詳細コンソールで開く |

## 10. 技術的注意（画像ホットリンク）

- 拡張のデフォルト CSP は `img-src` を制限しないため、ポップアップ等の拡張ページで外部画像表示は可能。
- ただし escape.id 側が referer / cookie を要求すると 403 になり得る。対策:
  - `<img referrerpolicy="no-referrer">` を付与。
  - `onerror` で画像枠ごと非表示にするフォールバックを**必須**にする（画像が出なくても予約情報は読める）。

## 11. メッセージ（変更なし／微修正）

- 新規メッセージは追加しない。
- `CANCEL_JOB` の `expectedJobId` を**任意化**（未指定なら現在の予約を取り消す）。
- `PARSE_FORM_REQUEST` の応答に `heroImageUrl` を追加。
- `SAVE_JOB` の job に `heroImageUrl` を含める。

## 12. 受け入れ条件

1. パターン1（ページ内）またはパターン3（詳細コンソール）で予約すると、**3画面とも同じ予約サマリ**（公演名・日時・購入チケット・カウントダウン）が見える（ポップアップは作成を行わず表示・取り消しに専念）。
2. **詳細コンソールで、別入口で作った予約を確実に取り消せる**（ドラフトやフォーム状態に依存しない）。取り消しは popup/ページ内パネルにも即時反映される。
3. パターン1パネルが **escape.id 配下のどのページでも** 出る。予約中はカウントダウン＋取り消しが見え、フォーム検出時は予約フロー、どちらも無ければランチャーバッジ。
4. ポップアップは予約があるとき、**ヒーロー画像・公演名・日時・購入チケット・カウントダウン・予約取り消し**を表示する（編集フォームは無い）。画像取得失敗時も他情報は表示される。
5. ヒーロー画像は `div[class^="first"] img` を主とし、og:image →最大画像にフォールバックして job に保存される。
6. 「設定を開く」表記が無くなり「詳細コンソールで開く」に統一される。
7. 単一ジョブ＋alarm＋自動実行（購入実行ロジック）は不変。

## 13. 段階実装

1. **同期の核**: `buildReservationView` ＋ `ensureHttpsUrl`（shared）、取り消し堅牢化（UI＋SW）。
2. **ヒーロー画像**: content の抽出、`sanitizeJob`/job/RunRecord への `heroImageUrl` 反映。
3. **パターン1**: 常時表示ゲート＋状態切替（ARMED/OTHER_RESERVED/READY/LAUNCHER）＋カウントダウン。
4. **パターン2**: ポップアップのビジュアル化（編集撤去・画像・サマリ・取り消し）。
5. **パターン3**: 「現在の予約」カード＋ドラフト不整合修正＋Step4 整理。
6. **表記統一**。
7. **docs 追従**: 本書に合わせて pattern-1 / pattern-2 / overview を更新。

## 14. 非ゴール

- 購入実行ロジック（`applyTicketPlan` / `submitCart`）は変更しない。
- アクティブ予約の複数同時保持はしない（単一 `te_job_v1` ＋履歴を継続）。
- 新規ストレージキー・新規メッセージタイプは追加しない（`heroImageUrl` は既存 job に内包）。
- ポップアップでの新規URL読み取り・編集は復活させない（編集は詳細コンソールに集約）。

## 15. 影響ファイル

- [lib/shared.js](../lib/shared.js): `buildReservationView`, `ensureHttpsUrl`, `formatJst` 共通化。
- [content/content_script.js](../content/content_script.js): 表示ゲート, 状態切替, `heroImageUrl` 抽出, 取り消し堅牢化, 表記。
- [popup/popup.js](../popup/popup.js) / [popup/popup.html](../popup/popup.html): ビジュアル化, 編集撤去, 画像, 取り消し堅牢化, 表記。
- [options/options.js](../options/options.js) / [options/options.html](../options/options.html): 「現在の予約」カード, ドラフト修正, Step4 整理, 取り消し堅牢化, ヒーローサムネ。
- [background/service_worker.js](../background/service_worker.js): `CANCEL_JOB` 任意化, `sanitizeJob` の `heroImageUrl`, RunRecord 反映。
- docs: pattern-1 / pattern-2 / overview の追従更新。
