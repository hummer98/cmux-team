# T192 Impl Report — surface 表記簡略化 + package version ロギング

## サマリー

plan.md に従い、logger 表記を簡略化し、Manager 起動時に package version をログする改修を TDD で実装。全 246 テスト pass、tsc エラーなし。

## 変更ファイル

### 新規追加/ヘルパー

- `skills/cmux-team/manager/logger.ts`
  - `SurfaceRole` 型 (`"C" | "A" | "M" | "U" | "S"`) 追加
  - `formatSurface(surface, role)` 追加 — `surface:665` → `C[665]` 等に整形。冪等。空入力は `""`。`null | undefined` 受容
  - `formatPair(parent, child, pRole, cRole)` 追加 — 親子 `C[665]>A[719]` を生成

- `skills/cmux-team/manager/logger.test.ts`
  - `describe("formatSurface")` / `describe("formatPair")` 追加 (15 ケース)
  - 正常系・空入力・部分空・idempotency・role variants を網羅

### daemon 起動時 version ロギング

- `skills/cmux-team/manager/daemon.ts`
  - `DaemonState` に `version: string` 追加
  - `loadVersion()` を export（`package.json` を読んで `vX.Y.Z` を返す。失敗時 `v?.?.?`）
  - `createDaemon()` で初期値 `v?.?.?` を設定

- `skills/cmux-team/manager/main.ts`
  - daemon 起動直前で `state.version = await loadVersion()`
  - `daemon_started` ログ先頭に `${state.version}` を付加

- `skills/cmux-team/manager/daemon.test.ts`
  - `loadVersion` テスト 2 ケース追加（ルート `package.json` 読み込み / 初期値）

### call-site 置換

以下のファイルの `surface=${...}` / `conductor_surface=${...} surface=${...}` を `formatSurface` / `formatPair` に置換:

- `skills/cmux-team/manager/daemon.ts` — 30+ 箇所（master_*, conductor_*, agent_*, session_*, pid_watcher, monitorConductors 他）
- `skills/cmux-team/manager/conductor.ts` — 6 箇所（全て C role）
- `skills/cmux-team/manager/master.ts` — 2 箇所（U role）
- `skills/cmux-team/manager/main.ts` — 4 箇所（daemon_surface → M, resume → C）
- `skills/cmux-team/manager/cmux.ts` — 2 箇所（低レベル → S role）

### dashboard 解析

- `skills/cmux-team/manager/dashboard.tsx`
  - `extractSurface(detail)` ヘルパー新設 — 旧 `surface=surface:NNN` と新 `C[NNN]`/`A[NNN]` 等の両方から抽出
  - `parseJournalEntries` の `conductor_started` / `task_completed` で使用

### ドキュメント

- `CLAUDE.md`「ロギングポリシー > ログフォーマット」に「surface 表記（T192）」節を追加
  - ロールプレフィックス表、親子表記 `>`、実例 3 本

## 設計判断

- **journal (task-state.json) にも新表記を流す**: dashboard 側で旧/新両対応する `extractSurface` を用意したため、新しく書かれる journal は `C[NNN]` 形式で出力する。既存の task-state.json に残る古いエントリも問題なく解析可能。
- **`S` role は cmux.ts 低レベルにのみ**: `validate_surface_failed`, `getPaneForSurface failed` 等、呼び出し元を特定できない場所でのみ `S` を使用。それ以外は呼び出し元のロールを明示。
- **`task_id=` 等の key=value は維持**: `task_id=`, `conductor_id=`, `artifact_id=`, `pid=`, `taskRunId=` 等は情報量・grep 容易性の観点から変更せず。
- **冪等性**: `formatSurface("C[665]", "C")` → `"C[665]"` を返す。二重ラップを防ぐ。
- **null 受容**: `state.masterSurface` は `string | null` のため、`formatSurface` は `string | null | undefined` を受ける。

## 検証

- `bun test`: 246 pass / 0 fail / 472 expect
- `bun run tsc --noEmit`: 0 errors
- `rg "surface=\\\$\{|conductor_surface=\\\$\{|agent_surface=\\\$\{" skills/cmux-team/manager/` (test 除く): 0 件

## コミット

未実施（プロンプト指示により Conductor が最終コミットを担当）。

## 未実施事項

なし。plan.md の全項目を実装完了。
