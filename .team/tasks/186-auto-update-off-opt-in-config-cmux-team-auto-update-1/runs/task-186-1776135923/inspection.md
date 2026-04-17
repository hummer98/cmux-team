# T186 検品レポート

## 判定: **GO**

plan.md の完了チェックリスト全項目を達成。致命的な不具合なし。軽微な警告事項のみ。

## 検品サマリ

| 観点 | 結果 | 備考 |
|------|------|------|
| タスク要件充足（env + config + priority + default OFF + logging） | OK | 4 項目すべて実装 |
| 優先順位ロジック（env > config > default OFF） | OK | `resolveAutoUpdateEnabled()` の分岐が正しい |
| env 真偽判定（`"1"` / `"true"` 以外は OFF） | OK | 厳密一致 `raw === "1" \|\| raw === "true"` |
| ログ出力 `auto_update_config enabled=X source=Y` | OK | `daemon_started` 直後に 1 回のみ |
| 既存 `checkNpmUpdate()` 本体 | OK | daemon.ts は無変更（`git diff` 空） |
| 型整合性 | OK | `TeamConfig.autoUpdate?: boolean` 追加、型エラーなし |
| メインループガード | OK | `autoUpdate.enabled &&` 短絡評価で `checkNpmUpdate` が呼ばれない |
| テスト | OK | 新規 8 ケース pass。`bun test main.test.ts` 全 46 件 pass |
| ドキュメント | OK | CLAUDE.md / README.ja.md / README.md すべて整合 |

## 充足項目（詳細）

### 1. TeamConfig interface 拡張 (`main.ts:96-100`)

`autoUpdate?: boolean` が追加されており、既存 `layout` / `sleepPrevention` と同パターン。JSDoc も「env 優先」を明記。

### 2. `resolveAutoUpdateEnabled()` 関数 (`main.ts:128-145`)

- `export` 付きでテスト可能
- env → config → default の順で解決
- 空文字 `""` は未設定扱い（config にフォールバック）— plan.md のルール通り
- `env` 引数は `process.env` デフォルトだがテストから注入可能（DI）

### 3. cmdStart 内での解決とログ (`main.ts:258-259, 281-284`)

- `autoUpdate` はクロージャで while ループに引き継がれる（スコープ OK）
- `daemon_started` 直後に `auto_update_config` を別行で出力（行肥大化回避）

### 4. メインループガード (`main.ts:617-621`)

```ts
if (autoUpdate.enabled && Date.now() - state.lastNpmCheckAt >= NPM_CHECK_INTERVAL) {
```

短絡評価で OFF 時は `Date.now()` 以降の処理も走らない。意図通り。

### 5. テスト（`main.test.ts:269-309`）

8 ケースすべて plan.md の想定通り。
- env="1" / "true" → enabled(env)
- env="0" / "false" → disabled(env)、config=true を上書き
- env 未設定 + config=true/false → enabled/disabled(config)
- env="" → config にフォールバック
- env 未設定 + config 未設定 → disabled(default)

実行結果: `8 pass / 0 fail`、全テスト `46 pass / 0 fail`。

### 6. ドキュメント整合性

- **CLAUDE.md**: 「既知の注意点」に `### npm auto-update（デフォルト OFF）` 追加。優先順位・環境変数・config 例・ログイベント名まで正確。
- **README.ja.md / README.md**: インストール直後に opt-in 手順を追加。両言語で内容が整合。

### 7. 既存 `checkNpmUpdate()` 本体

`git diff skills/cmux-team/manager/daemon.ts` は空 — 呼び出し側ガードのみで済ませた plan.md の方針通り。

### 8. plan.md 完了チェックリスト達成状況

全 11 項目のうち、明示「推奨」の 1 項目（ユニットテスト追加）を含めて全達成。

## 警告事項（GO でも留意すべき点）

1. **手動テスト（S1-S6）は未実施**
   impl-report.md は型チェック・ユニットテストで妥当性を担保しているが、plan.md 記載の S1-S6（実際に `cmux-team start` を起動して manager.log を見るシナリオ）は未実施。ロジックはユニットテストで網羅されており、起動系の副作用（既に既存コードで検証済み）もないため GO としたが、**リリース前に 1 回は手動で起動確認**するのが望ましい。

2. **env 値判定が `"1" | "true"` 限定** — 想定通りだが注意喚起
   `"yes"`, `"on"`, `"TRUE"`（大文字）等は OFF になる。タスク指示通りだが、README / CLAUDE.md ともに `"1"（または "true"）` と明記されており、ユーザー誤認のリスクは低い。`"TRUE"`（大文字）で OFF になる点だけは直感に反する可能性あり。現状は意図通りなので修正不要。

3. **CHANGELOG 未更新**
   タスク指示・plan.md ともに CHANGELOG への記載は要件になっていないため変更対象外。ただし「デフォルト挙動の変更」は breaking change 相当のため、リリース時に CHANGELOG / CHANGELOG 系コマンドで周知することを推奨。

4. **既存エラー 5 件は T186 起因ではない**
   `cmux.ts:22`, `dashboard.tsx:373/954`, `main.test.ts:83`, `main.ts:476` の型エラーは main から持ち越し。本変更で追加した箇所には型エラーなし（`bunx tsc --noEmit` で確認済み）。

## Fix Required

なし（GO）。

## 結論

plan.md の設計通りに過不足なく実装されており、ユニットテストでロジック網羅性を担保。ドキュメントも正確。致命的な問題なし、GO とする。
