# T243 Inspection — trace DB `task_sessions` に base_branch / base_sha / base_source を記録

- taskRunId: `task-243-1776424220`
- 担当 role: inspector
- 検品日: 2026-04-17
- 対象 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-243-1776424220`
- 基準ドキュメント: plan.md / impl-report.md / design-review.md（同 dir）

---

## Verdict: GO

## Summary

plan.md の T243-0〜T243-11 は全て実装され、対象 9 ファイル（コード 4 / テスト 2 / ドキュメント 4、ただし `skills/trace-task/SKILL.md` をドキュメントに含めて計 3 + 1 dot ファイル込み 9 diff）が変更済み。Design Reviewer の 5 recommendations（console.warn 採用・timeout 30s 統一・execFile stub 戦略踏襲・T243-7 必須化・D9 根拠明確化）は実装に反映されている。`bunx tsc --noEmit` exit 0、`bun test` 475 pass / 0 fail、`ensureTaskSessionsColumns` が `initDB` から呼ばれマイグレーション冪等性も担保。セキュリティ（execFile / $-prefix binding）も問題なし。critical / major いずれも 0 件。

## Findings

### 1. (minor) 旧スキーマ DB マイグレーションテストの `finally` で double close が発生しうる

`trace-store.test.ts:340-342` の `finally { try { migratedDb.close(); } catch {} }` は、先行する `migratedDb.close()`（L330）後にも再度 close を試みる構造。`catch {}` で握りつぶすため実害はないが、「close 済み DB への close は noop / throw」のどちらも想定内であることを明示するコメントか、`let migratedDb` を `open/closed` flag で管理する形に整理するとレビュアーに親切。

- severity: minor
- 影響: なし（テストは pass、catch で握りつぶされる）
- 推奨: コメント追記 or 管理フラグ化。ただし今回の GO 判断には不要。

### 2. (minor) T243 以前に assigned された既存タスクの行は永久に NULL のまま

仕様通り（plan D6、impl-report でも明記）だが、既存 DB 上で T243 リリース以前に `assigned` された conductor 行は `base_branch` / `base_sha` / `base_source` が NULL で残る。CLI 側は `Base: -` で表示することで対応済み。将来「過去タスクの base を推定補完するバッチ」等が欲しくなる可能性はあるが、現時点の要件には含まれない。

- severity: minor（仕様通り）
- 影響: なし
- 推奨: 必要になったら別タスクとして検討。

### 3. (minor) `rev-parse HEAD` 失敗時の `worktree_created` ログは `sha=-` になる

`conductor.ts:346-350`。失敗時 `baseSha=null` → `shortSha="-"` となり、`worktree_created ... sha=-` がログに出る。plan D7 / impl 設計通りで異常ではないが、ログ集計時に `sha=-` を除外するフィルタが必要になる可能性あり（grep ベースの集計）。

- severity: minor（仕様通り）
- 影響: なし（ログは事後解析用、機能性に影響なし）
- 推奨: 運用上の注意としてドキュメント化されていれば十分。現状 CLAUDE.md の base 列説明で NULL について触れているため許容範囲。

---

## Verification Commands Run

### (a) 変更ファイル一覧

```
$ git diff main --name-only
CHANGELOG.md
CLAUDE.md
docs/spec/01-skill-cmux-team.md
skills/cmux-team/manager/conductor.test.ts
skills/cmux-team/manager/conductor.ts
skills/cmux-team/manager/main.ts
skills/cmux-team/manager/trace-store.test.ts
skills/cmux-team/manager/trace-store.ts
skills/trace-task/SKILL.md
```

→ plan.md「3. 変更対象」の 9 ファイル全てに差分あり。OK。

### (b) 型エラーゼロ確認

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
$ echo $?
0
```

→ exit 0、型エラー 0 件。touched files（5 .ts）も全てクリーン。

### (c) 全テスト pass 確認

```
$ bun test
475 pass
0 fail
1066 expect() calls
Ran 475 tests across 22 files. [19.39s]
```

→ baseline 471（T242 取り込み直後）に対し +4 追加で 475、全 pass。既存テスト破壊なし。

### (d) 統合確認: `ensureTaskSessionsColumns` が `initDB` から呼ばれているか

```
$ grep -n "ensureTaskSessionsColumns\|PRAGMA table_info\|ADD COLUMN" skills/cmux-team/manager/trace-store.ts
96:  ensureTaskSessionsColumns(db);
101: * T243: 既存 DB の `task_sessions` テーブルに ...
107:function ensureTaskSessionsColumns(db: Database): void {
109:    .prepare("PRAGMA table_info(task_sessions)")
115:      db.exec(`ALTER TABLE task_sessions ADD COLUMN ${col} TEXT`);
```

→ `initDB()` L96 で `db.exec(SCHEMA)` 直後に呼ばれている。欠損列のみ ALTER、冪等性あり。

### (e) `insertTaskSession` のバインド確認

```
$ grep -n "base_branch\|base_sha\|base_source" skills/cmux-team/manager/trace-store.ts
...
123:    INSERT INTO task_sessions (..., base_branch, base_sha, base_source)
124:    VALUES (..., $base_branch, $base_sha, $base_source)
135:    $base_branch: record.base_branch ?? null,
136:    $base_sha: record.base_sha ?? null,
137:    $base_source: record.base_source ?? null,
```

→ INSERT 列とバインド 3 組が揃っている。`$`-prefix パラメータ化バインディング維持、bind 漏れなし。

### (f) conductor.ts 統合確認

```
$ grep -n "rev-parse\|baseSha\|base_branch:\|base_sha:\|base_source:\|worktree_created" skills/cmux-team/manager/conductor.ts
326:    // T243: worktree 作成直後に rev-parse HEAD で base SHA を取得する
332:      const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
336:      const sha = stdout.trim();
337:      if (/^[0-9a-f]{40}$/.test(sha)) {
338:        baseSha = sha;
343:      await log("error", `rev-parse HEAD failed in worktree: ...`);
349:      `branch=${branch} base=${baseResolution.baseLabel} source=${baseResolution.source} sha=${shortSha} path=${worktreePath}`,
436:        base_branch: baseResolution.baseLabel,
437:        base_sha: baseSha,
438:        base_source: baseResolution.source,
```

→ rev-parse HEAD が timeout=30s で `execFile`（shell 非経由、固定引数）、40 hex 形式チェック、失敗時 null + error ログ、`insertTaskSession` に 3 フィールド渡し、`worktree_created` に `sha=<short>` 追加。全て plan + Design Review 通り。

### (g) CLI 出力拡張（T243-7）

```
$ grep -n "Base:" skills/cmux-team/manager/main.ts
3348:    console.log(`Base: ${baseLabel} @${shortSha} (source=${source})`);
3350:    console.log("Base: -");
```

→ `cmdTraceTask` 出力ヘッダに `Base: <label> @<short-sha> (source=<src>)` 行追加、旧データは `Base: -`。Design Reviewer Recommendation 4（必須化）反映済み。

### (h) ドキュメント更新確認

```
$ grep -n "base_branch\|base_sha\|base_source" CLAUDE.md docs/spec/01-skill-cmux-team.md CHANGELOG.md skills/trace-task/SKILL.md
CLAUDE.md:694: - **base 列（T243）**: `task_sessions` ... `base_branch` / `base_sha` / `base_source` を記録
docs/spec/01-skill-cmux-team.md:135-137: | `base_branch` / `base_sha` / `base_source` | ... 表形式で明記
CHANGELOG.md:6: - T243 エントリで 3 列と ALTER マイグレーション戦略を記述
skills/trace-task/SKILL.md:26,34,39,58: Base 行と分析観点「worktree base」を追加
```

→ plan 指示の 4 ドキュメント全てに反映済み。

### (i) 設計原則（DRY/SSOT）確認

- `WorktreeBaseSource` enum は `schema.ts` が SSOT、`trace-store.ts` は type-only import で再利用（重複定義なし）。
- `baseLabel` / `source` は `resolveWorktreeBase` の戻り値を流用、conductor 側で再計算なし。
- 出力フォーマット（`Base: <label> @<sha7> (source=<src>)`）は main.ts で 1 箇所定義、trace-task SKILL.md の例示と一致。

→ DRY / SSOT 違反なし。

### (j) セキュリティ確認

```
$ grep -n 'execFile("git"' skills/cmux-team/manager/conductor.ts | grep rev-parse
332:      const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
```

→ `execFile("git", ["rev-parse", "HEAD"], { cwd, timeout })` で shell を介さず、引数は固定文字列のみ。ユーザー入力の連結なし。

```
$ grep -n "\$base_branch\|\$base_sha\|\$base_source" skills/cmux-team/manager/trace-store.ts
124:    VALUES ($timestamp, ..., $event, $base_branch, $base_sha, $base_source)
135-137:    $base_branch / $base_sha / $base_source: record.XXX ?? null,
```

→ SQLite は `$`-prefix パラメータ化バインディングを使用、文字列結合による SQL 構築なし。injection 耐性 OK。

### (k) マイグレーション冪等性のテスト確認

```
$ grep -n "冪等\|PRAGMA\|ALTER" skills/cmux-team/manager/trace-store.test.ts
264: test("旧スキーマ DB → initDB 再呼び出しで ALTER TABLE による列追加が走る"
329:        // 2 回目の initDB 呼び出しでも ALTER は冪等（throw しない）
```

→ テスト 3 で (a) 旧スキーマ → ALTER 3 列追加、(b) 旧行の NULL 維持、(c) 2 回目 `initDB` 呼び出しで throw しない（`PRAGMA table_info` で列存在判定済み）を検証。冪等性担保済み。

### (l) Design Review Recommendations 反映確認

| # | Recommendation | 実装箇所 | 状態 |
|---|---------------|---------|------|
| 1 | `console.warn("[trace-store] task_sessions_migrated col=<name>")` | `trace-store.ts:116` | ✅ 反映 |
| 2 | rev-parse timeout 30s | `conductor.ts:334` | ✅ 反映 |
| 3 | execFile stub パターン踏襲 | `conductor.test.ts:209-250` は実 git init + assignTask の結合テスト（既存 T242 パターンと整合） | ✅ 反映（実 git 経路で結合カバー） |
| 4 | T243-7 必須化 | `main.ts:3340-3351` で実装 | ✅ 反映 |
| 5 | D9 根拠明確化 | plan 側の議論、impl には直接影響なし | N/A（plan レベル） |

---

## 検品観点まとめ

| # | 観点 | 結果 |
|---|------|------|
| 1 | 計画充足（全 subtask + 9 ファイル + 5 recommendations） | ✅ 全て充足 |
| 2 | Dead / Zombie Code | ✅ 不要コード残存なし（テスト側の `try { migratedDb.close(); } catch {}` は minor 指摘あり） |
| 3 | テスト pass（bun test all pass） | ✅ 475 pass / 0 fail |
| 4 | 設計原則（DRY / SSOT） | ✅ enum / 出力フォーマット / resolve 結果の再利用に重複なし |
| 5 | 統合（ensureTaskSessionsColumns from initDB、insertTaskSession bind） | ✅ 接続済み |
| 6 | 型エラーゼロ（touched files） | ✅ tsc exit 0 |
| 7 | マイグレーション冪等性（PRAGMA + 欠損列のみ ALTER + 2 回目スキップのテスト） | ✅ 検証済み |
| 8 | セキュリティ（execFile / $-prefix binding） | ✅ 問題なし |

Critical: **0 件**
Major: **0 件**
Minor: **3 件**（上記 Findings 1〜3）

GO/NOGO 判定基準（Critical 0 AND Major ≤ 2）を満たすため **GO** と判定する。

---

## Fix Required

該当なし（GO）。
