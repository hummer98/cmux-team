# T403 Inspection Report

## 判定

**GO**

research.md §4.1〜§4.3 のハイブリッド方針に対し、Implementer の実装は完全に準拠している。テスト・型チェックも全て pass し、実装ルール（空 catch 禁止・改行区切りヘッダ・関連ファイルのみテスト実行）に違反はない。Critical Findings なし。

## 検品結果

### A. 設計方針への準拠

- [x] §4.1 agent 注入: `main.ts:2207-2225` `generateAgentSettings(projectRoot, surface, taskId?)`
  - `headerLines` 配列を `\n` で join。`x-cmux-role: agent` / `x-cmux-surface: ${surface}` / `x-cmux-task-id: ${taskId}` の 3 種を改行区切りで注入
  - `taskId` 未指定時は spread `...(taskId ? [...] : [])` で `x-cmux-task-id` 行を生成しない（壊れた値で `api_usage` を汚染しない、research.md §5.1 の要求通り）
  - T355 regression（カンマ区切り）は混入なし。コメント `T304/T355/T403` も併記
- [x] §4.2 conductor 逆引き: `proxy.ts:738-755`
  - `let taskId = ...` に変更し、`!taskId && role === "conductor" && conductorSurface && opts?.getState` の 4 条件 AND ガード
  - `opts?.getState` チェックで「テスト経路で getState 未注入」のケースは安全に skip → 既存テスト互換維持
  - `s?.conductors?.get?.(conductorSurface)` の optional chain で state 構造変化に robust
  - `try/catch` で state アクセス失敗時 fallback、`taskId` は更新されないので NULL のまま（既存挙動維持）
- [x] §4.3 master 不修正: `generateMasterSettings` (`main.ts:2087-2105`) に変更なし
  - master は role 条件で逆引き branch から除外されるため、master 行の task_id は仕様通り NULL のまま
- [x] cmdSpawnAgent 呼び出し更新: `main.ts:2885-2888`
  - `generateAgentSettings(PROJECT_ROOT, surface)` → `generateAgentSettings(PROJECT_ROOT, surface, taskId)`
  - `taskId` は同関数内で既に `team.json` 経由で解決済み（line 2740 付近）。新規 lookup 追加なし
  - 呼び出し変更箇所は `cmdSpawnAgent` の 1 箇所のみで漏れなし（grep 結果で確認済み）

### B. テストの妥当性

- 追加テストは research.md §5.1 の方針に完全準拠（3 + 3 ケース）
- TDD red → green 性: 実装と独立した形で構造を検証
  - `main.test.ts:2334-2358`:
    - `taskId` 未指定で `x-cmux-role: agent\nx-cmux-surface: surface:100` の完全一致 + `not.toContain("x-cmux-task-id")` で行非含有を assert
    - `taskId` 指定で `x-cmux-role: agent\nx-cmux-surface: surface:100\nx-cmux-task-id: T403` の完全一致
    - T355 regression guard: `\n` 含有 + `, x-cmux-surface` / `, x-cmux-task-id` 非含有
  - `proxy.test.ts:1167-` 追加 3 ケース:
    - `T403: state.conductors から逆引き` — fakeState を仕込み、ヘッダから x-cmux-task-id を意図的に省き、`api_usage` 行で `task_id === "T403"` を検証
    - `T403: ヘッダ優先` — state には `T999_FROM_STATE`、ヘッダに `T403_FROM_HEADER`。ヘッダ値が勝つこと + state 値が漏れないこと（`getApiUsage(db, { taskId: "T999_FROM_STATE" }).length === 0`）の双方を assert
    - `T403: role=master 誤マッチ防止` — fakeState にマッチする surface を仕込んでいるため、role guard が正しく働かないと失敗するように設計されている。実際にロジックの分岐 (`role === "conductor"`) を踏む形になっている
- 既存テスト互換性: `generateAgentSettings` の optional 引数化により全 9 件の既存 2 引数呼び出し（main.test.ts のみ）はそのまま pass。`startProxy` テストでは `getState` 未注入経路でも安全
- tautology なし: テストは fakeState という外部入力を経由して実装ロジックを通り、最終的に DB 行で検証する形式（実装関数を直接 spy しない）

### C. CLAUDE.md 準拠

- **空 `catch {}` 禁止**: `proxy.ts:752-754` の catch ブロックは `// state アクセス失敗時は taskId NULL のまま（既存挙動維持）` のコメント付きで、意図が明示されている。空ではない（CLAUDE.md ルール準拠）
  - state 失敗は実用上発生しないため logger 出力なしで OK（research.md でも明示記録は要求していない）
- **EventBus / task-state**: 該当箇所への変更なし。違反なし
- **bun test 全体実行禁忌**: Implementer は `bun test main.test.ts proxy.test.ts` の関連ファイル指定で実行。Inspector も同じ呼び出しで再現確認済み
- **コーディング規約**: コメント日本語（T304/T355/T403 の経緯を含む）、コード英語、TypeScript 型エラー 0 件
- **コメント節度**: T403 関連コメントは `proxy.ts:743-750` で 8 行と長めだが、`role==="conductor"` ガードの理由・master 不引きの根拠を述べた WHY コメントであり、CLAUDE.md の「removing the comment wouldn't confuse a future reader」基準に照らして残す価値あり

### D. 検証実行結果（Inspector 実行）

- `bun test --timeout 30000 main.test.ts proxy.test.ts`: **275 pass / 0 fail** (831 expect calls, 20.71s)
- `bunx tsc --noEmit -p tsconfig.json`: **新規エラー 0 件** (exit 0, 0 行出力)
- Implementer 自己申告（main 215 / proxy 60 / 合計 275）と完全一致

### E. リスク・副作用

- **proxy.ts hot path への影響**: pure read (Map.get) で副作用なし、既存 `setRateLimit` 反映 (`proxy.ts:212-220`) と同パターン。性能影響は微小（O(1) の Map 検索 1 回 / リクエスト）
- **`role === "conductor"` 文字列比較と legacy fallback**: `role` は `x-cmux-role` ヘッダのみで決まり、`x-cmux-conductor-id` legacy fallback は `conductorSurface` の方にしか作用しない。よって legacy 経路（`x-cmux-conductor-id` だけが存在し `x-cmux-role` が無い）では task_id 逆引きが効かない可能性がある。ただし T323 以降の現行 daemon は `generateConductorSettings` で必ず `x-cmux-role: conductor` を出力するため、実用上は問題なし。Minor Suggestion 参照
- **ANTHROPIC_CUSTOM_HEADERS env 値長**: agent では `x-cmux-role: agent` (15B) → `x-cmux-role: agent\nx-cmux-surface: surface:NN\nx-cmux-task-id: TNNN` (~70B 程度) と数十バイト増加。OS の env 上限（macOS / Linux で ~128KB-2MB）に対して無視できる規模。実用上影響なし
- **`generateAgentSettings` シグネチャ変更による外部呼び出し破壊**: grep の結果、呼び出し元は `main.ts` 内 1 箇所 + `main.test.ts` 内 9 箇所のみ。`taskId?` は optional のため既存 2 引数呼び出しは全て継続動作。型チェック (`tsc --noEmit`) も pass

## Critical Findings (NOGO の場合のみ)

なし

## Minor Suggestions (GO 後の改善余地、本タスクで対応不要)

- **legacy `x-cmux-conductor-id` のみ送る経路では task_id 逆引きが効かない**: `role` ヘッダ未注入の旧 daemon 由来 conductor は逆引きできず task_id NULL のまま。実用上は T323 以降この経路は使われていないので無視可能だが、proxy.ts に「legacy 経路では task_id 解決を諦める」旨のコメントがあると次回の調査者にやさしい。本タスクのスコープ外
- **master の task_id 紐付け**: research.md §4.3 に既述の通り、UserPromptSubmit hook 等で「master が今操作している task」を team.json に保存し proxy で role===master のときに引く拡張は将来の課題
- **既存 13,885 行の task_id NULL 補正**: 再構築不可、新規行から正常化（research.md §4.4 の方針通り）。Minor として既知
- **package-lock.json の `4.22.0 → 4.23.0` 差分**: 本タスクと無関係（直近 release 814b350 の lockfile 取りこぼし）。本タスクのスコープ外で、別途取り扱いを推奨
