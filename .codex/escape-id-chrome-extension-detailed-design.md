# escape.id 高速チケット購入 Chrome拡張 詳細設計書（v1.0）

- 作成日: 2026-03-01
- 参照:
  - `.codex/escape-id-chrome-extension-spec.md`（基本仕様）
  - `.codex/動き.md`（実運用フロー要件）
  - `form.html`（対象フォームDOMサンプル）

## 1. 目的と到達点

本設計書は、`https://escape.id/...` のチケットフォームに対して以下を実現する実装詳細を定義する。

1. 指定時刻に `click()` ベースで最速購入操作を実行する
2. フォーム表示遅延がある場合でも待機して処理を継続する
3. 事前定義したチケット（例: グループチケット）数量を正確に合わせる
4. 同意チェック（0件/1件/複数件）に対応して `カートに入れる` 押下まで完了する

## 2. スコープ定義（この設計で実装する範囲）

1. URLと実行時刻の事前登録
2. URL解析に基づく券種入力UI（動的）
3. 指定時刻トリガーと高精度クリック
4. DOM監視、数量調整、同意チェック、送信
5. 実行ログ記録と失敗時リトライ

非スコープ:
1. CAPTCHA回避
2. サイト規約に反する回避行為
3. API直叩き（本設計はDOM `click()` のみ）

## 3. 全体アーキテクチャ

### 3.1 構成要素

1. `manifest.json`（MV3）
2. `background/service_worker.js`
3. `content/content_script.js`
4. `options/options.html` + `options/options.js`
5. `popup/popup.html` + `popup/popup.js`
6. `lib/shared.js`（型相当の定数、メッセージ種別、ユーティリティ）

### 3.2 責務分離

1. Service Worker
  - ジョブ保存、時刻同期、トリガー管理、タブ起動
  - 実行コマンドをContent Scriptに送信
2. Content Script
  - DOM検出、フォーム解析、数量調整、同意チェック、送信
  - 実行結果をSWへ返却
3. Options UI
  - URL/時刻/券種数量/リトライ設定の編集
  - URL解析トリガーと結果表示
4. Popup UI
  - 現在ステータス、次回実行、直近ログ表示、手動実行

## 4. データ設計

## 4.1 保存キー（`chrome.storage.local`）

1. `te_job_v1`: 実行ジョブ
2. `te_time_offset_v1`: 時刻補正値（ms）
3. `te_last_run_v1`: 直近実行結果
4. `te_logs_v1`: ローテーションログ（最大300件）

## 4.2 データモデル

```ts
type TicketPlan = {
  ticketLabel: string;        // 例: "グループチケット"
  targetQty: number;          // 目標枚数
};

type JobConfig = {
  jobId: string;
  targetUrl: string;          // https://escape.id/.../e-pd/?...
  triggerAtJst: string;       // ISO8601 with +09:00
  warmupSec: number;          // 例: 120
  retryMax: number;           // 例: 3
  retryIntervalsMs: number[]; // 例: [200, 400, 800]
  ticketPlans: TicketPlan[];
  requireAgreement: boolean;  // trueならチェック処理を有効化
  selectorOverrides?: Partial<SelectorMap>;
};

type SelectorMap = {
  formRoot: string;
  ticketItem: string;
  submitButton: string;
  agreementCheckboxes: string;
};

type RunResult = {
  jobId: string;
  startedAt: number;
  finishedAt: number;
  status: "SUCCESS" | "FAILED";
  errorCode?: string;
  errorDetail?: string;
  steps: Array<{ at: number; step: string; detail?: string }>;
};
```

## 5. URL解析と券種入力UI

## 5.1 解析開始フロー

1. OptionsでURLを入力し「フォーム解析」ボタン押下
2. SWが対象URLタブを開く（既存タブがあれば再利用）
3. Content Scriptがフォーム出現を待機
4. 出現後、券種名一覧を抽出してOptionsへ返却
5. Optionsが券種ごとの数量入力フィールドを動的生成

## 5.2 解析結果の抽出ロジック（`form.html`準拠）

1. `form` ルートを取得
2. チケット行の各 `li` から次を抽出
  - 券種名: 行内先頭 `p` テキスト
  - 価格: 次の `p` テキスト（任意）
  - 現在数量: `p` の数量表示テキスト
3. 同意チェック候補: `input[type="checkbox"]`
4. 送信ボタン候補: `button[type="submit"]` かつテキストに `カートに入れる`

## 6. DOMセレクタ戦略（優先順位付き）

クラス名は変更されやすいため、テキスト基準 + 近接構造で特定する。

1. `formRoot`
  - 優先1: `form.flex-1`
  - 優先2: `form:has(button[type="submit"])` 相当の探索
2. `ticketItem`
  - 優先1: `formRoot.querySelectorAll("ul > li")`
  - 優先2: `「チケット」見出し直後の list 領域を探索`
3. `submitButton`
  - 優先1: `button[type="submit"]`
  - 優先2: `button` のうち innerText に `カートに入れる` を含む要素
4. `agreementCheckboxes`
  - 優先1: `input[type="checkbox"][required]`
  - 優先2: `input[type="checkbox"]`（同意文近傍のみ）

`selectorOverrides` が設定されている場合は上記より先に適用する。

## 7. 実行フロー詳細

## 7.1 状態機械

1. `IDLE`
2. `WARMUP_START`
3. `WAIT_FORM`
4. `PREPARE_TICKETS`
5. `WAIT_TRIGGER`
6. `CLICK_SUBMIT`
7. `VERIFY_RESULT`
8. `SUCCESS` / `RETRY_WAIT` / `FAILED`

## 7.2 時系列フロー

1. `T - warmupSec`
  - 対象URLタブを前面またはバックグラウンドで起動
  - Content Script注入確認
2. `WAIT_FORM`
  - `MutationObserver + 50msポーリング` で最大待機
  - フォーム未出現時はタイムアウトログ
3. `PREPARE_TICKETS`
  - 券種ごとに目標数量へ合わせ込み
  - 同意チェック対象を全て `checked=true` へ
4. `WAIT_TRIGGER`
  - 指定時刻まで高精度待機
5. `CLICK_SUBMIT`
  - `submitButton.click()` 実行
6. `VERIFY_RESULT`
  - URL遷移/DOM変化で成功判定
  - 失敗なら再試行条件判定

## 8. 数量調整アルゴリズム（click限定）

## 8.1 券種行特定

1. `ticketLabel` と行内テキストを正規化比較（全角半角空白除去）
2. 一致行の操作領域から `-` と `+` ボタンを特定
3. 現在数量表示を整数化

## 8.2 調整手順

1. `diff = targetQty - currentQty`
2. `diff > 0`: `+` ボタンを `diff` 回 `click()`
3. `diff < 0`: `-` ボタンを `abs(diff)` 回 `click()`
4. 各クリック後に数量表示の更新を待つ（最大150ms）
5. 目標未達なら最大2周まで再補正

## 8.3 クリック規約

1. すべて `HTMLElement.click()` を使用
2. API呼び出し、`fetch` 直接実行は禁止
3. 連打間隔は `clickIntervalMs`（既定30ms）

## 9. 同意チェック処理

1. チェックボックス抽出（required優先）
2. 各要素で `if (!checkbox.checked) checkbox.click()`
3. チェック後に `checked` を再検証
4. 1つでも失敗時は `E_AGREEMENT_NOT_CHECKED`

## 10. 送信処理とリトライ

## 10.1 送信処理

1. 送信ボタンが `disabled` の場合、200ms以内に再確認
2. 有効化後に `click()`
3. 500ms以内にDOM/URL変化がない場合は「送信未反映」候補

## 10.2 リトライ条件

再試行する:
1. 一時的な非活性
2. フォーム再描画で要素参照切れ
3. ネットワーク遷移遅延（判定不能）

再試行しない:
1. ログイン切れ
2. 券種未検出
3. チェックボックス確定不能

## 10.3 エラーコード

1. `E_FORM_TIMEOUT`
2. `E_TICKET_NOT_FOUND`
3. `E_QTY_ADJUST_FAILED`
4. `E_AGREEMENT_NOT_CHECKED`
5. `E_SUBMIT_NOT_FOUND`
6. `E_SUBMIT_NOT_APPLIED`
7. `E_AUTH_REQUIRED`

## 11. 時刻同期設計

1. 基本時刻: `Date.now()`
2. 補助同期: `HEAD` の `Date` ヘッダから offset 算出（任意）
3. 実効トリガー時刻: `triggerEpoch + offsetMs`
4. 最終2秒は `setTimeout` から `requestAnimationFrame` ベースへ切替
5. クリック時刻を `performance.now()` でログ化

## 12. メッセージ設計（SW <-> Content <-> Options）

1. `PARSE_FORM_REQUEST` / `PARSE_FORM_RESULT`
2. `PREPARE_REQUEST` / `PREPARE_RESULT`
3. `EXECUTE_REQUEST` / `EXECUTE_RESULT`
4. `STATUS_UPDATE`
5. `ABORT_REQUEST`

各メッセージは `requestId` と `jobId` を必須にする。

## 13. Manifest設計（最小）

```json
{
  "manifest_version": 3,
  "name": "TicketEscape",
  "version": "0.1.0",
  "permissions": ["storage", "tabs", "alarms", "scripting", "activeTab", "notifications"],
  "host_permissions": ["https://escape.id/*"],
  "background": { "service_worker": "background/service_worker.js" },
  "options_page": "options/options.html",
  "action": { "default_popup": "popup/popup.html" },
  "content_scripts": [
    {
      "matches": ["https://escape.id/*"],
      "js": ["content/content_script.js"],
      "run_at": "document_idle"
    }
  ]
}
```

## 14. ログ設計

1. 1ログ項目:
  - `at` (epoch ms)
  - `jobId`
  - `phase`
  - `message`
  - `meta`（JSON）
2. 300件を超えたら古い順に削除
3. 実行単位で `RunResult` を別保存

## 15. テスト設計

## 15.1 単体テスト

1. 券種名正規化比較
2. 数量差分計算とクリック回数
3. エラーコード分岐

## 15.2 DOM結合テスト（`form.html`使用）

1. フォーム出現遅延（0.5秒、2秒、5秒）
2. チェックボックス0件/1件/複数件
3. グループチケット指定数量への調整
4. 送信ボタン有効/無効遷移

## 15.3 手動E2Eチェック

1. ログイン済み状態でウォームアップ開始
2. 目標時刻ちょうどで `カートに入れる` 押下
3. 成功/失敗ログがPopupで確認できる

## 16. 実装順序（推奨）

1. `content_script`: 解析 + 数量調整 + 同意 + 送信（手動トリガー）
2. `options`: URL解析UI + 数量入力UI
3. `service_worker`: スケジュール + 実行管理
4. `popup`: 状態確認 + ログ表示
5. テスト追加（単体/DOM結合）

## 17. 未確定事項

1. escape.id本番DOMにおけるテキスト揺れ（券種表記）
2. 成功判定の最終条件（URL遷移先 or 特定文言）
3. 販売開始瞬間における送信ボタン活性化タイミングの実測値
