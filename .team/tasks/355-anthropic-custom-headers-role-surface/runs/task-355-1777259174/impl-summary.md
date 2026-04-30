# T355 実装サマリー

**タスク**: ANTHROPIC_CUSTOM_HEADERS を改行区切りに修正して role/surface 汚染を止める
**ブランチ**: `task-355-1777259174/task`
**worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-355-1777259174`
**手法**: TDD（plan.md の「実装ステップ」に従って実施）

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/main.ts` | L1957 (master) と L2114 (conductor) の `ANTHROPIC_CUSTOM_HEADERS` を `, ` 連結から `\n` 連結に変更。コメントに T355 の経緯を追記。L2043 (agent) は単一値のため変更不要 |
| `skills/cmux-team/manager/main.test.ts` | `generateMasterSettings` / `generateConductorSettings` の expected を改行区切りに更新。新規 `describe("T355: ANTHROPIC_CUSTOM_HEADERS は改行区切り（カンマ混入禁止）")` で regression テストを 1 件追加 |
| `skills/cmux-team/manager/proxy.test.ts` | `api_usage (T305)` describe 内に新規テストを 1 件追加: 分離ヘッダー (`x-cmux-role` + `x-cmux-surface`) で送信したリクエストが DB の `role` / `surface` 列に分離保存されること、role 列にカンマ区切り汚染値が混入しないことを検証 |

`package-lock.json` の変更は本タスク開始前から working tree にあった既存差分で T355 とは無関係。

## 実装詳細

### main.ts:1957 (master) — Before / After

```ts
// Before
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: master, x-cmux-surface: ${surface}`,

// After
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: master\nx-cmux-surface: ${surface}`,
```

コメントは「T304/T323/T355: ANTHROPIC_CUSTOM_HEADERS は改行区切り（公式仕様 https://code.claude.com/docs/en/llm-gateway）。カンマ区切りで連結すると SDK が全体を 1 ヘッダー値として送り、proxy が role 列に "master, x-cmux-surface: surface:N" のような汚染値を保存してしまうため `\n` で分離する。」に更新。

### main.ts:2114 (conductor) — 同様の変更

```ts
// Before
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: conductor, x-cmux-surface: ${surface}`,

// After
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: conductor\nx-cmux-surface: ${surface}`,
```

### main.ts:2043 (agent) — 変更なし

agent は単一値 `"x-cmux-role: agent"` で連結が無いため汚染は発生しない。plan.md の指示通り変更しなかった。

## TDD ステップ実行ログ

1. **失敗テスト追加**: main.test.ts の 2 つの expected 値を改行区切りに更新 + T355 regression テスト追加。proxy.test.ts に分離ヘッダー検証テスト追加。
2. **失敗確認**: `bun test main.test.ts` を実行 → 期待通り **3 fail**（master expected / conductor expected / T355 regression のカンマ混入禁止チェック）。proxy 側の追加テストは新規実装でも実は通る性質のもの（既存 proxy.ts は既に分離ヘッダーを正しくパースする）だが、追加意義は将来の汚染導入リグレッション検出。
3. **実装**: main.ts の master / conductor 行の `, ` を `\n` に置換。コメント更新。
4. **緑化確認**: `bun test main.test.ts proxy.test.ts` → **231 pass, 0 fail**。
5. **全テストパス確認**: CLAUDE.md の規約通り sequential 実行 (`for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done`) → **57 ファイル全て 0 fail**（skip は token-cli 4 件、token-store 1 件。事前から存在する skip）。
6. **TypeScript 検査**: `bunx tsc --noEmit` → 既存の `pool-header-display.test.ts` 由来の 18 エラーが残っているが、これらは本タスク開始前から HEAD に存在していたもので、今回の変更によって増えていない。`main.ts` / `main.test.ts` / `proxy.test.ts` 起因の TS エラーはゼロ。

## テスト結果（T355 関連）

```
$ bun test --timeout 30000 -t "T355" main.test.ts proxy.test.ts
 6 pass
 225 filtered out
 0 fail
 17 expect() calls
Ran 6 tests across 2 files. [397.00ms]
```

T355 を含む 6 件（main.test.ts: master 改行区切り x1、conductor 改行区切り x1、per-surface パス確認 x2、T355 regression x1 / proxy.test.ts: T355 分離保存 x1）が全て pass。

## 全テスト結果（manager 配下 sequential）

57 ファイル全て 0 fail。詳細サマリー:
- 主要ファイル: main.test.ts (187 pass)、proxy.test.ts (44 pass)、daemon.test.ts (173 pass)、conductor.test.ts (46 pass)、task.test.ts (98 pass)、token-store.test.ts (96 pass + 1 skip)、token-cli.test.ts (37 pass + 4 skip)、state-machine/fsm.test.ts (184 pass)、dashboard-* (合計 68 pass)
- 全体合計: 1500 件以上の test が緑

## TypeScript 検査結果

```
$ bunx tsc --noEmit 2>&1 | wc -l
18
$ bunx tsc --noEmit 2>&1 | grep -vE "pool-header-display\.test\.ts"
(empty)
```

18 行は全て `pool-header-display.test.ts` の `Object is possibly 'undefined'` 警告で、今回の変更前から存在する既存のもの。修正対象ファイル由来の新規エラーは無い。

## 注意点・引き継ぎ

1. **plan.md の「検証手順 3-6」は実機検証**: `cmux-team start` で Manager を再起動し、master/conductor/agent から実 API リクエストを発行 → trace DB の `role` 列が `master`/`conductor`/`agent` の 3 値のみになることを確認する手順は **Conductor 側で実施** すべきもの。
2. **既存汚染データの migration はしない**: タスクの「やってほしくないこと」に従い、過去に汚染された `api_usage.role` 値（例: `"master, x-cmux-surface: surface:N"`）はそのまま残す。新規 INSERT のみクリーンになる。
3. **agent surface (`main.ts:2043`) は触らず**: 単一値のため現状で汚染なし。将来 agent にも `x-cmux-surface` を追加する場合は **必ず `\n` 区切り**で連結すること（main.ts:2041 のコメントに次回追加時の指針として T355 を追記する選択肢もあるが、plan.md ではコメント追記不要としていたためそのままとした）。
4. **commit はしていない**: plan.md の指示通り Conductor が後で行う。

## 関連リンク

- 公式仕様: https://code.claude.com/docs/en/llm-gateway （`ANTHROPIC_CUSTOM_HEADERS` は改行区切りの `Key: Value` ペア）
- proxy 受け口: `proxy.ts:619-623`（`x-cmux-surface` 優先 + `x-cmux-role` ヘッダー取得）
- proxy 保存先: `proxy.ts:824-826`（`safeInsertApiUsage` の `role` / `surface` 列）
