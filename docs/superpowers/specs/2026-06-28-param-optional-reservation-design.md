# URLパラメータ無しページでの予約フロー対応 — 設計

- 日付: 2026-06-28
- 対象: TicketEscape Chrome拡張（content script / popup / options / shared）
- 採用方針: **A案（判定の分離 + 案内警告）**

## 1. 背景・課題

`escape.id` の公演ページは、日付未選択の状態ではURLパラメータが付かない（例: `https://escape.id/uzu-org/e-MIRAGE/`）。ユーザーがページ内で**日付ボタンを押すとURLにパラメータが付き**（例: `https://escape.id/uzu-org/e-MIRAGE/?date=...`）、その状態で券種購入フォームが現れる。

現在の実装は `isReservableTicketUrl()`（[lib/shared.js:156](../../../lib/shared.js)）が「escape.id かつ パス2階層以上 かつ パラメータ1個以上」を要求し、これを**表示判定**にも**保存判定**にも使っている。結果として、日付未選択の入口ページでは TicketEscape のUIが**そもそも出ない**ため、「日付を押す→URLが変わる→ようやくUIが出る」という導線になり使いづらい。

## 2. ゴール / 非ゴール

### ゴール
- パラメータが無い `escape.id/{org}/{event}/` 形式のページでも、3つの入口（ページ内パネル・ポップアップ・オプション）の予約UIに**入れる**ようにする。
- パラメータが無い状態で予約しようとした際に、冷たい拒否ではなく**「日付と時間を指定して購入画面を開いてください」という案内警告**を表示する。
- 3入口で一貫した挙動にする。

### 非ゴール
- パラメータ無しURLでの予約**保存**を許可すること（日付未選択ページにはフォームが無く、自動化が必ず失敗するため保存はさせない）。
- 日付ボタンのクリック自動化（自動でパラメータを付ける処理）。
- SPA遷移のURL変化を監視してパネルを自動更新すること（後述のとおりボタン再クリックで成立するため今回は対象外）。

## 3. 採用方針（A案）

`isReservableTicketUrl()` が兼ねていた2役割を分離する。

- **表示判定**（UIを出すか） → 新述語 `isEscapeTicketPageUrl()`（パラメータ**任意**）に差し替える。
- **保存判定**（予約として成立するか） → `isReservableTicketUrl()`（パラメータ**必須**）をそのまま使い、安全網として残す。
- パラメータ無しで予約に進もうとした箇所のメッセージを、拒否文から**案内文**に変更する。

却下案: B案（パラメータ無し保存も許可）は動かない予約を保存できてしまうため不採用。C案（表示判定据え置き）はパネルが出ず警告を出す機会が無いため要件未達。

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

**表示判定 → `isEscapeTicketPageUrl` に差し替え**

| ファイル:行 | 箇所 | 変更後の効果 |
|---|---|---|
| [content_script.js:97](../../../content/content_script.js) | `initReservationPanel` パネル表示ゲート | パラメータ無しページでもパネルが表示される |
| [popup.js:208](../../../popup/popup.js) | `render` の `renderOnTarget` 判定 | パラメータ無しページでも予約導線を表示 |
| [popup.js:593](../../../popup/popup.js) | `openOptionsWithCurrentTab` | パラメータ無しページからもオプションを開ける |
| [options.js:268](../../../options/options.js) | `loadPageDraft` 取込ガード | パラメータ無しURLもオプションに取り込める |

**保存判定 → `isReservableTicketUrl` のまま（メッセージのみ案内化）**

| ファイル:行 | 箇所 | 備考 |
|---|---|---|
| [content_script.js:457](../../../content/content_script.js) | `saveReservation` ゲート | 安全網として維持（パネルは読み取り前にボタン挙動で警告） |
| [popup.js:423](../../../popup/popup.js) | `saveJob` ゲート | メッセージを案内文へ |
| [popup.js:540,545](../../../popup/popup.js) | `syncSaveState` ボタン活性・ノート文言 | パラメータ無しなら保存ボタンを無効のまま、ノートを案内文へ |
| [options.js:351](../../../options/options.js) | `confirmAndRead`（情報読み取り） | メッセージを案内文へ |
| [options.js:401](../../../options/options.js) | `saveJob` ゲート | メッセージを案内文へ |
| [options.js:961](../../../options/options.js) | `updateStepStates` ステップ完了マーク | URLステップは「パラメータ有り」で完了扱いのまま |
| [service_worker.js:188,274,354,423](../../../background/service_worker.js) | バックエンド検証 | **ロジック無変更**。メッセージは `E_URL_PARAMS_REQUIRED` 経由で更新が波及 |

### 4.4 メッセージ変更

`E_URL_PARAMS_REQUIRED`（[lib/shared.js:77](../../../lib/shared.js)）を1か所更新し、`getErrorMessage` 経由の全箇所に波及させる。

- 変更前: `予約できるのは、URLパラメータ付きのチケットページだけです。`
- 変更後（確定案）: **`日付と時間を指定して、チケットの購入画面を開いてください。（日付選択後のページで予約できます）`**

加えて、`getErrorMessage` を経由せずハードコードしている文言を新文言に揃える（または `getErrorMessage("E_URL_PARAMS_REQUIRED")` 経由に統一）:
- [popup.js:545](../../../popup/popup.js) の `"URLパラメータ付きのチケットページを指定してください。"`
- [popup.js:424](../../../popup/popup.js)・[options.js:352](../../../options/options.js)・[options.js:402](../../../options/options.js) のフォールバック第2引数

### 4.5 パネルの「このチケットを予約する」ボタン挙動（[content/content_script.js](../../../content/content_script.js)）

- `read` アクション（[content_script.js:321](../../../content/content_script.js) → `readTickets`）の冒頭で `location.href` のパラメータ有無を確認する。
- **パラメータ無し**: 券種読み取りを行わず、READYビュー内に案内警告ノート（既存の `.note.warn` スタイルを流用）を表示して終了する。状態 `state.paramWarning = true` を立てて `render()` する。
- **パラメータ有り**: 従来どおり `readTickets()` を実行する。
- READYビュー（[content_script.js:605-612](../../../content/content_script.js)）に、`state.paramWarning` が真のとき `<div class="note warn">…</div>` を差し込む。

補足: 日付選択でURLが変わった後にユーザーがもう一度ボタンを押せば、その時点の `location.href` で再判定され読み取りに進む。これによりSPA遷移でも自動URL監視なしで成立する。

## 5. 変わらないもの

- 予約の**保存**にはURLパラメータが必須（＝実際に動作する予約だけ保存）。
- バックエンド（service worker）の検証ロジック、アラーム/タブ管理、自動クリック処理。
- `isReservableTicketUrl` の真偽判定結果（リファクタ後も同値）。

## 6. エッジケース・留意点

- **誤検知**: 表示判定を緩めることで、チケットページ以外でもパス2階層以上の `escape.id` ページ（例: `/login/foo`）にパネルが出る可能性がある。害は小さい（パネルは閉じられ、予約に進んでも案内警告のみ）。将来的に既知パスの除外や軽いDOM確認で精緻化可能だが今回は許容する。
- **SPA遷移**: 自動URL監視は対象外。ボタン再クリックで `location.href` を再判定するため運用上は成立する。
- **メッセージ波及**: `E_URL_PARAMS_REQUIRED` はバックエンドの拒否時にも使われるため、文言は「日付選択ページへの案内」として自然に読める表現にする（確定案は条件を満たす）。

## 7. テスト方針（手動）

ビルドシステムは無いため、`chrome://extensions/` で拡張を再読込して手動確認する。

1. パラメータ無しページ（`escape.id/{org}/{event}/`）を開く → パネルが表示される。
2. 1の状態で「このチケットを予約する」を押す → 券種読み取りせず案内警告が出る。
3. 日付・時間を選択しURLにパラメータが付いた状態でボタンを押す → 従来どおり券種読み取りに成功する。
4. ポップアップ: パラメータ無しページで予約導線が出る／パラメータ無しのまま保存しようとすると案内警告でブロックされる。
5. オプション: パラメータ無しURLを取り込める／読み取り・保存時に案内警告が出る。

## 8. 影響ファイル一覧

- `lib/shared.js` — `isEscapeTicketPageUrl` 追加、`isReservableTicketUrl` リファクタ、`E_URL_PARAMS_REQUIRED` 文言更新、エクスポート追加
- `content/content_script.js` — 表示ゲート差し替え、`read` ボタンのパラメータ確認＋警告表示
- `popup/popup.js` — 表示ゲート差し替え、保存ノート文言更新
- `options/options.js` — 取込ゲート差し替え、読み取り・保存メッセージ更新
- `background/service_worker.js` — 変更なし（文言は `shared.js` 経由で波及）
