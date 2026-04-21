# T287 Inspect Report — pidfile 取得前に `.team/` を mkdir -p

## Verdict

**GO**

plan.md（採用案 B）と実装が完全に一致し、新規テスト 2 ケースを含む全テストが pass、scope 外変更なし、tsc 新規エラー 0 件を確認。

## チェック結果

### 1. コード変更の正確性 — pass

`skills/cmux-team/manager/pidfile.ts`:

- **L16**: `import { writeFile, unlink, readFile, mkdir } from "fs/promises";` — `mkdir` が追加済み ✅
- **L17**: `import { dirname } from "path";` — 追加済み ✅
- **L96**: `acquirePidFile` の opts デストラクチャ直後（L85-90）・`let attempt = 0` の前（L98 より前）に `await mkdir(dirname(path), { recursive: true });` が挿入されている ✅
- **L92-95**: T287 の意図コメントが記載されている（「新規フォルダで daemon.ts:initInfra より前に pidfile 取得が走るため ENOENT になる問題への対処」「recursive:true なので既存時は no-op」） ✅
- **ループ外で 1 回だけ**: mkdir は `while (true)` loop（L101〜）の**外**で 1 回だけ呼ばれる。attempt loop 内では呼ばれない ✅ → 並行呼び出し時も重複実行されない

`skills/cmux-team/manager/pidfile.test.ts`:

- **L98-113**: `describe("acquirePidFile - missing parent directory", ...)` が追加され、以下 2 ケース ✅
  - `.team/ が未作成でも pidfile を作成できる（T287）` — `existsSync(join(testDir, ".team"))` が先に false を assert、acquire 後に `existsSync(nestedPath)` が true、content が `"12345"` ✅
  - `parent dir がすでに存在する場合は no-op` — `pidFilePath` に acquire、content が `"12345"` ✅
- plan.md の Step 3 コード片と完全一致 ✅
- 配置位置: happy path describe (L67-82) の次、`existing alive cmux-team process` describe (L117-) の前。plan.md 指定位置と一致 ✅

### 2. scope 外変更がないか — pass

`git diff --stat HEAD`:

```
 skills/cmux-team/manager/pidfile.test.ts | 19 +++++++++++++++++++
 skills/cmux-team/manager/pidfile.ts      |  9 ++++++++-
 2 files changed, 27 insertions(+), 1 deletion(-)
```

- 変更は 2 ファイルのみ ✅
- `main.ts` / `daemon.ts` / `CLAUDE.md` / `docs/spec/` への変更なし ✅
- impl-summary.md の宣言（+9/-1 pidfile.ts、+19/-0 pidfile.test.ts）と一致 ✅

### 3. 検証コマンドの再実行 — pass

#### `bun test pidfile.test.ts`

```
 25 pass
 0 fail
 34 expect() calls
Ran 25 tests across 1 file. [48.00ms]
```

新規 2 ケース含む 25 ケース全 pass、regression 0 件 ✅

#### `bun test`（全体）

```
 854 pass
 0 fail
 2061 expect() calls
Ran 854 tests across 28 files. [44.11s]
```

全 854 テスト pass、regression 0 件 ✅

#### `bunx tsc --noEmit`

3 件のエラーが検出:

```
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3956,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1597,22): error TS2352: Conversion of type 'string | undefined' to type '...'
```

`git stash` で作業変更を退避した状態でも同じ 3 件が出ることを確認済み（以下 stash 実行ログ）:

```
Saved working directory and index state WIP on task-287-1776755113/task: ea27d6d ...
conductor.ts(201,3): error TS1016: ...
daemon.test.ts(3956,9): error TS2322: ...
daemon.ts(1597,22): error TS2352: ...
---STASH_POP---
Dropped refs/stash@{0} ...
```

**本タスクによる新規 tsc エラー 0 件** ✅（既存 3 件は T287 とは無関係の事前存在）

### 4. 意図との整合性 — pass

- **案 B の責務カプセル化**: pidfile モジュールが自分の格納先を自分で作る設計が維持されている。呼び出し側（`main.ts:cmdStart`）の変更は不要 ✅
- **エラー経路**: `mkdir` は attempt loop の**前**に置かれ、失敗時は throw が上位に伝播。`acquireOrExit` の既存 catch は `PidFileLockedError` のみをハンドリングするため、他の throw は素通りして上位に伝播する。既存挙動を壊していない ✅
- **並行起動**: `{recursive:true}` は POSIX で冪等・並列安全。`writeFile({flag:"wx"})` の atomic ロックも不変 ✅
- **release との対称性**: `releasePidFile`（L141-148）が ENOENT を黙殺するのに対し、`acquirePidFile` は parent を自動作成する。非対称の解消（release は不在許容、acquire は parent 作成）が達成 ✅

### 5. 再現シナリオの論理的検証 — pass（実機実行は省略）

コードパスを trace:

1. `main.ts:cmdStart` が `.team/daemon.pid` パスを組み立て `acquireOrExit(pidFilePath, PROJECT_ROOT)` を呼ぶ（L365 付近）
2. `acquireOrExit` → `acquirePidFile`（pidfile.ts:155-170 → L81-139）
3. `acquirePidFile` L96: `await mkdir(dirname(path), { recursive: true })` で `.team/` を作成
4. L101〜: `writeFile(path, String(selfPid), { flag: "wx" })` が成功 → ENOENT 消滅

**論理的整合**: ✅ plan.md の想定通り。`daemon.ts:initInfra`（tasks/output/prompts/logs の mkdir）より前に pidfile 用の `.team/` が確実に作成される。

## テスト結果ログ（抜粋）

```
$ bun test pidfile.test.ts
bun test v1.3.12 (700fc117)
 25 pass / 0 fail / 34 expect() calls
Ran 25 tests across 1 file. [48.00ms]

$ bun test
 854 pass / 0 fail / 2061 expect() calls
Ran 854 tests across 28 files. [44.11s]

$ bunx tsc --noEmit (with changes)
  3 errors: conductor.ts(201,3), daemon.test.ts(3956,9), daemon.ts(1597,22)

$ git stash && bunx tsc --noEmit (without changes)
  3 errors: (same 3 files, same lines) ← 事前存在確認
```

## Notes

- **impl-summary.md のテスト数訂正**: plan.md が「既存 25 + 新規 2 = 27」と記載していたところ、Implementer が「実際の既存 23 + 新規 2 = 25」と報告。実行結果も 25 pass で一致しており、plan 作成時のカウント誤差が impl-summary で訂正されている。変更の正しさには影響なし。
- **既存 tsc エラー 3 件**: T287 以前から存在する warning。本タスクの scope 外（他タスクまたは将来の cleanup で対応）。fresh folder 起動の blocker ではない。
- **対称性の改善**: `release: ENOENT 黙殺` vs `acquire: parent 作成必須` の非対称が、「どちらも parent dir 不在に耐える」方向で統一された点は、構造的正しさの観点でよい改善。`releasePidFile` が ENOENT を黙殺するコメント（pidfile.ts:145）と整合。
- **将来的な懸念**: 特になし。mkdir 失敗（EACCES 等の fatal）時のログは追加していないが、plan.md でも「fatal error は catch しないのが現状のポリシー」と明記されており、既存方針と整合。
- **実機テスト**: 再現シナリオ（fresh folder での `cmux-team start`）は cmux セッション内での手動検証が必要で、Inspector の任意項目に該当。単体テストが論理的に同等のシナリオをカバーしているため、実機実行は省略。

## GO 判定根拠

- [x] 検品項目 1（コード変更の正確性）: plan.md 通りの import / mkdir 挿入位置 / コメント / ループ外配置
- [x] 検品項目 2（scope）: 2 ファイルのみ、`main.ts` 等は無変更
- [x] 検品項目 3（テスト）: pidfile.test.ts 25 pass、全体 854 pass、tsc 新規 0 件
- [x] 検品項目 4（意図整合性）: 案 B の責務カプセル化、エラー経路不変、並行安全、release との対称性
- [x] 検品項目 5（再現シナリオ論理）: `main.ts → acquireOrExit → acquirePidFile → mkdir → writeFile` のパスで ENOENT 消滅

**結論: GO**
