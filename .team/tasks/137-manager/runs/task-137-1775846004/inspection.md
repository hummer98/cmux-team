# Inspection: T137 サイドバーステータス更新

## Verdict: GO

## Checklist

### 機能面
- [x] 6つの状態（error, throttled, running+pending, running, done, idle）が全て正しく判定される
- [x] 差分抑制（lastSidebarStatus）が正しく動作する — `statusKey` 比較でスキップ、変更時のみ `cmux.setStatus()` を呼ぶ
- [x] "done" → "idle" の1 tick 遷移が正しく実装されている — `prevCategory` が `"done"` のとき条件5をスキップし `"idle"` に落ちる
- [x] shutdown 時に clearStatus が呼ばれる — `main.ts:260-262` で `cmux.clearStatus("claude_code", state.workspace)` を実行
- [x] workspace が null の場合にスキップされる — `updateSidebarStatus()` 冒頭で `if (!state.workspace) return;`

### コード品質
- [x] TypeScript の型が正しい — `bunx tsc --noEmit` の結果、エラーは全て既存のもの（dashboard.tsx の "unstyled" 型、main.ts の `string | null` vs `string | undefined`）。新規導入エラーなし
- [x] plan.md の設計と実装が一致している — 6つの状態判定ロジック、差分抑制、shutdown 処理が計画通り
- [x] コーディング規約準拠 — 変数名は英語（`runningCount`, `hasDisconnected`, `statusKey`）、コメントは日本語
- [x] ロギングポリシー準拠 — `setStatus` 失敗時は `log("error", ...)` で記録。`clearStatus` は冪等な後処理のため空 catch（ポリシーの許容例外に該当）

### 安全性
- [x] 既存の tick() フローに悪影響を与えない — `updateSidebarStatus()` は `tick()` → `updateTeamJson()` の後に直列実行（`main.ts:486`）。独立した副作用のみ
- [x] エラーハンドリングが適切 — `setStatus` / `clearStatus` 共に try-catch で保護されている
- [x] cmux コマンド失敗時にクラッシュしない — 両関数とも例外を catch して処理を継続

## Findings

### [Minor] shutdown で SIDEBAR_STATUS_KEY 定数ではなくリテラル文字列を使用
- 問題: `main.ts:261` で `cmux.clearStatus("claude_code", ...)` とリテラル文字列を使用しているが、`daemon.ts:1144` で `const SIDEBAR_STATUS_KEY = "claude_code"` が定義されている。値は同一だが、将来キー名を変更した場合に不整合のリスクがある
- 修正案: `SIDEBAR_STATUS_KEY` を daemon.ts から export し、main.ts で import して使用する。または現状維持でも実害はない（変更頻度が極めて低いため）

### [Minor] formatResetRemaining のコピーでコメントが省略されている
- 問題: `dashboard.tsx:191` にある `// unified ヘッダーは unix timestamp（秒）の数値文字列で返る` というコメントが、`daemon.ts:1156` のコピーでは省略されている。ロジックは完全に一致
- 修正案: 挙動に影響なし。コメントがあった方がメンテナンス時に意図が伝わりやすいが、plan.md でコピー元が明記されているため問題なし
