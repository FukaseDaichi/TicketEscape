# URLパラメータ無しページでの予約フロー対応 — 設計

- 日付: 2026-06-28
- 対象: TicketEscape Chrome拡張（content script / popup / options / shared）
- 採用方針: **A案（判定の分離 + 案内警告）**。ただし実装結果は、保存判定もパラメータ任意側へ寄っている。

> **実装後レビュー**: 設計時は「表示判定だけパラメータ任意、保存判定はパラメータ必須」を想定していた。現行実装ではさらに進み、SW の `SAVE_JOB` / `PARSE_FORM_REQUEST` / dispatch 検証も `isEscapeTicketPageUrl()`（パス2階層以上・URLパラメータ任意）を使う。つまり、保存の絶対条件として URLパラメータは要求されていない。詳細な懸念は [../../current-implementation-review.md](../../current-implementation-review.md) を参照。

## 1. 背景・課題

`escape.id` の公演ページは、日付未選択の状態ではURLパラメータが付かない（例: `https://escape.id/uzu-org/e-MIRAGE/`）。ユーザーがページ内で**日付ボタンを押すとURLにパラメータが付き**（例: `https://escape.id/uzu-org/e-MIRAGE/?date=...`）、その状態で券種購入フォームが現れる。

設計時の課題は、`isReservableTicketUrl()` が「escape.id かつ パス2階層以上 かつ パラメータ1個以上」を要求し、これを**表示判定**にも**保存判定**にも使っていたこと。結果として、日付未選択の入口ページでは TicketEscape のUIが**そもそも出ない**ため、「日付を押す→URLが変わる→ようやくUIが出る」という導線になり使いづらかった。

現行実装では、表示判定はさらに広がり、content panel は `ensureEscapeUrl(location.href)` で escape.id 配下なら生成される。予約フローへ進めるかは `isReservableTicketUrl(location.href) || hasPurchaseForm()` で判定する。一方、SW と options の保存・読み取り検証は `isEscapeTicketPageUrl()` に寄っており、URLパラメータ必須ではない。

## 2. ゴール / 非ゴール

### ゴール
- パラメータが無い `escape.id/{org}/{event}/` 形式のページでも、3つの入口（ページ内パネル・ポップアップ・オプション）の予約UIに**入れる**ようにする。
- パラメータが無く購入フォームも検出できない状態で予約に進もうとした際に、冷たい拒否ではなく**「日付と時間を指定して購入画面を開いてください」という案内警告**を表示する。
- 3入口で一貫した挙動にする。

### 非ゴール
- パラメータ無しURLでの予約**保存**を一律に禁止すること。現行実装はパス2階層以上なら保存できる可能性があるため、ここは当初の非ゴールから変わっている。
- 日付ボタンのクリック自動化（自動でパラメータを付ける処理）。
- SPA遷移のURL変化を監視してパネルを自動更新すること。当初は対象外だったが、現行実装では `popstate` / `hashchange` / 250ms polling による簡易監視が入っている。

## 3. 採用方針（A案）

`isReservableTicketUrl()` が兼ねていた2役割を分離する。当初案と実装後の差分は次の通り。

- **表示判定（content）** → `ensureEscapeUrl()` に広げ、escape.id 配下なら小バッジ/パネルを生成する。
- **対象チケットページ判定（popup/options/SW）** → `isEscapeTicketPageUrl()`（パス2階層以上・パラメータ任意）を使う。
- **ページ内の読み取り可否** → `isReservableTicketUrl()`（パラメータ有り）または `hasPurchaseForm()`（DOMフォーム検出）で判断する。
- **保存判定** → 当初案では `isReservableTicketUrl()` のままにする予定だったが、現行実装は SW/options とも `isEscapeTicketPageUrl()` を使っている。
- パラメータ無しで購入フォームも見つからない箇所のメッセージを、拒否文から**案内文**に変更する。

当初の却下案: B案（パラメータ無し保存も許可）は、動かない予約を保存できてしまうため不採用としていた。現行実装は結果的に保存判定も `isEscapeTicketPageUrl()` に寄っているため、この点は [current-implementation-review](../../current-implementation-review.md) の既知懸念として扱う。C案（表示判定据え置き）はパネルが出ず警告を出す機会が無いため要件未達。

## 4. 詳細設計

### 4.1 新述語 `isEscapeTicketPageUrl`（[lib/shared.js](../../../lib/shared.js)）

```js
// escape.id の {org}/{event} 形式のページ。URLパラメータは任意。
function isEscapeTicketPageUrl(rawUrl) {
  const normalized = ensureEscapeUrl(rawUrl);
  if (!normalized) {
    return false;
  }
  try {
    const parsed = new URL(normalized);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length >= 2;
  } catch (_) {
    return false;
  }
}
```

- `ensureEscapeUrl` が https + `hostname === "escape.id"` を強制済みなので、ホスト検査はそれに委譲する。
- 末尾のエクスポートオブジェクト（[lib/shared.js:217-235](../../../lib/shared.js)）に `isEscapeTicketPageUrl` を追加する。

### 4.2 `isReservableTicketUrl` のリファクタ（DRY化）

既存の `isReservableTicketUrl` は「`isEscapeTicketPageUrl` の条件 + パラメータ1個以上」に整理する（挙動は不変）。

```js
function isReservableTicketUrl(rawUrl) {
  if (!isEscapeTicketPageUrl(rawUrl)) {
    return false;
  }
  const parsed = new URL(ensureEscapeUrl(rawUrl));
  return Array.from(parsed.searchParams.keys()).length > 0;
}
```

### 4.3 各入口のゲート差し替え

**表示判定 / 対象判定**

| ファイル:行 | 箇所 | 変更後の効果 |
|---|---|---|
| [content_script.js](../../../content/content_script.js) | `initReservationPanel` パネル表示ゲート | `ensureEscapeUrl()` により escape.id 配下ならトップ/一覧でも小バッジを出せる |
| [content_script.js](../../../content/content_script.js) | `canReadCurrentPage` | URLパラメータ付き、または購入フォーム検出で読み取りへ進める |
| [popup.js](../../../popup/popup.js) | `render` / `openConsole` の対象判定 | `isEscapeTicketPageUrl()` によりパラメータ無しの `{org}/{event}/` でも詳細コンソールへ引き継げる |
| [options.js](../../../options/options.js) | `loadPageDraft` 取込ガード | パラメータ無しURLもオプションに取り込める。ただし既存予約がある場合はドラフトを破棄する |

**保存・読み取り判定**

| ファイル:行 | 箇所 | 備考 |
|---|---|---|
| [content_script.js](../../../content/content_script.js) | `saveReservation` ゲート | `ensureEscapeUrl()` + `canReadCurrentPage()`。パラメータ無しでも購入フォームがあれば保存へ進める |
| [options.js](../../../options/options.js) | `parseForm` / `saveJob` ゲート | `isEscapeTicketPageUrl()`。パラメータ無しでもパス2階層以上なら通る |
| [options.js](../../../options/options.js) | `updateStepStates` ステップ完了マーク | URLステップも `isEscapeTicketPageUrl()` で完了扱い |
| [service_worker.js](../../../background/service_worker.js) | `sanitizeJob` / `handleParseForm` / `dispatchExecution` | `isEscapeTicketPageUrl()`。URLパラメータは必須ではない |

### 4.4 メッセージ変更

`E_URL_PARAMS_REQUIRED`（[lib/shared.js:77](../../../lib/shared.js)）を1か所更新し、`getErrorMessage` 経由の全箇所に波及させる。

- 変更前: `予約できるのは、URLパラメータ付きのチケットページだけです。`
- 変更後（確定案）: **`日付と時間を指定して、チケットの購入画面を開いてください。（日付選択後のページで予約できます）`**

加えて、`getErrorMessage` を経由せずハードコードしている文言がある場合は新文言に揃える（または `getErrorMessage("E_URL_PARAMS_REQUIRED")` 経由に統一）。現行 popup は保存フォームを持たないため、popup 側の保存ノート更新は不要。

### 4.5 パネルの「このチケットを予約する」ボタン挙動（[content/content_script.js](../../../content/content_script.js)）

- `read` アクション（`readTickets`）の冒頭で `canReadCurrentPage()` を確認する。
- **パラメータ無し + 購入フォーム無し**: 券種読み取りを行わず、READYビュー内に案内警告ノート（既存の `.note.warn` スタイルを流用）を表示して終了する。状態 `state.paramWarning = true` を立てて `render()` する。
- **パラメータ有り、または購入フォーム有り**: 従来どおり `readTickets()` を実行する。
- READYビューに、`state.paramWarning` が真のとき `<div class="note warn">…</div>` を差し込む。

補足: 現行実装は `popstate` / `hashchange` / 250ms polling で URL と購入フォーム有無を監視する。日付選択でURLやDOMが変わると、ボタン再クリックだけでなくパネル状態も自動で再評価される。

## 5. 変わらないもの

- `isReservableTicketUrl` の真偽判定結果（パス2階層以上 + URLパラメータ有り）は不変。
- アラーム/タブ管理、自動クリック処理の中核。
- パラメータ無しかつ購入フォーム無しのページでは、ページ内パネルの読み取りは案内警告で止める。

## 6. エッジケース・留意点

- **誤検知**: 表示判定を `ensureEscapeUrl()` まで広げたため、チケットページ以外の `escape.id` ページにもバッジ/パネルが出る可能性がある。害は小さい（パネルは閉じられ、予約に進んでも購入フォームがなければ案内警告のみ）。将来的に既知パスの除外や軽いDOM確認で精緻化可能だが今回は許容する。
- **SPA遷移**: 現行実装では自動URL/フォーム監視を行う。ただし polling なので、瞬間的なDOM状態と表示が一時的にずれる可能性はある。
- **メッセージ波及**: `E_URL_PARAMS_REQUIRED` はバックエンドの拒否時にも使われるため、文言は「日付選択ページへの案内」として自然に読める表現にする（確定案は条件を満たす）。

## 7. テスト方針（手動）

ビルドシステムは無いため、`chrome://extensions/` で拡張を再読込して手動確認する。

1. パラメータ無しページ（`escape.id/{org}/{event}/`）を開く → パネルが表示される。
2. 1の状態で「このチケットを予約する」を押す → 券種読み取りせず案内警告が出る。
3. 日付・時間を選択しURLにパラメータが付いた状態、または購入フォームがDOM上に出た状態でボタンを押す → 従来どおり券種読み取りに成功する。
4. ポップアップ: パラメータ無しの `{org}/{event}/` ページで詳細コンソール導線が出る。
5. オプション: パラメータ無しURLを取り込める。既存予約がある場合はドラフトを破棄し、ライブ予約を優先する。
6. オプション: パラメータ無しURLと手動券種で保存できる可能性がある。これを許容するか、将来コード側で再制限するかは別途判断する。

## 8. 影響ファイル一覧

- `lib/shared.js` — `isEscapeTicketPageUrl` 追加、`isReservableTicketUrl` リファクタ、`E_URL_PARAMS_REQUIRED` 文言更新、エクスポート追加
- `content/content_script.js` — escape.id 全体への表示ゲート拡大、`canReadCurrentPage()`、URL/DOM状態 watcher、案内警告表示
- `popup/popup.js` — 対象タブ判定を `isEscapeTicketPageUrl()` へ、詳細コンソール導線
- `options/options.js` — 取込ゲート、読み取り・保存ゲート、ドラフト破棄条件、ステップ完了判定
- `background/service_worker.js` — `SAVE_JOB` / `PARSE_FORM_REQUEST` / dispatch 検証が `isEscapeTicketPageUrl()` に寄っている
