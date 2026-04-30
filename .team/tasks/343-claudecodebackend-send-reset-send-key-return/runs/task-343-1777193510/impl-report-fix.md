# Implementer Fix Report (Round 2) — T343

Inspector NOGO（tsc 新規エラー 16 件）への対応。
対象ファイル: `skills/cmux-team/manager/claude-code-backend.test.ts`

## 修正内容（diff の要約）

### 修正 1: `invocationCallOrder[i]` の non-null assertion 追加（line 40, 45）

```diff
-events.push({ kind: "send", args: sendCalls[i], order: sendOrders[i] });
+events.push({ kind: "send", args: sendCalls[i], order: sendOrders[i]! });
...
-events.push({ kind: "sendKey", args: keyCalls[i], order: keyOrders[i] });
+events.push({ kind: "sendKey", args: keyCalls[i], order: keyOrders[i]! });
```

`for (i = 0; i < calls.length; i++)` の前提で対応する `invocationCallOrder[i]` は必ず存在するため non-null assertion で安全に narrow。

### 修正 2: `events[i]` の non-null assertion 追加（line 58〜63, 89〜92）

```diff
-expect(events[0].kind).toBe("send");
-expect(events[0].args[0]).toBe(SURFACE);
-expect(events[0].args[1]).toBe("hello");
-expect(events[1].kind).toBe("sendKey");
-expect(events[1].args[0]).toBe(SURFACE);
-expect(events[1].args[1]).toBe("return");
+expect(events[0]!.kind).toBe("send");
+expect(events[0]!.args[0]).toBe(SURFACE);
+expect(events[0]!.args[1]).toBe("hello");
+expect(events[1]!.kind).toBe("sendKey");
+expect(events[1]!.args[0]).toBe(SURFACE);
+expect(events[1]!.args[1]).toBe("return");
```

直前の `expect(events.length).toBe(2)` で長さは保証されているが tsc は narrow しないため non-null assertion で対応（最小差分・既存スタイル維持）。
AC1 (long prompt) テストの line 89〜92 も同様に修正。

### 修正 3: `spawn()` 呼び出しに `SpawnOptions` 必須フィールド追加（line 167, 181, 192）

`runtime-backend.ts` の `SpawnOptions` は `role: SessionRole`, `prompt: string`, `workdir: string` を必須要求。`SessionRole = "master" | "conductor" | "agent"`。

```diff
 await backend.spawn({
   surface: SURFACE,
   launchCmd: "cmux-team conductor",
+  role: "conductor",
+  prompt: "",
+  workdir: "/tmp",
 });
```

ロールはコマンド名と整合する値を選択:
- line 167: `launchCmd: "cmux-team conductor"` → `role: "conductor"`
- line 181: `launchCmd: "cmux-team master\n"` → `role: "master"`
- line 192: `launchCmd: "cmux-team conductor"` → `role: "conductor"`

`prompt: ""`, `workdir: "/tmp"` は本テストではシェル経路（`launchCmd` のみ送信）の検証で参照されないため空値でよい。

## 検証結果

### tsc 結果

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | grep claude-code-backend.test.ts | wc -l
0
```

`claude-code-backend.test.ts` 由来のエラーは **0 件**。tsc 全体も `EXIT=0` でクリーン。

### テスト結果

`bun test --timeout 30000 claude-code-backend.test.ts`:

```
14 pass
0 fail
47 expect() calls
Ran 14 tests across 1 file. [2.53s]
```

`bun test --timeout 30000 conductor.test.ts`:

```
38 pass
0 fail
144 expect() calls
Ran 38 tests across 2 files. [19.50s]
```

両方とも 0 fail を維持。

## 作業境界の遵守

- `claude-code-backend.test.ts` のみ修正（本体・他テストは未変更）
- 既存テストの assertion ロジックは変更せず、型ガードのみ追加
- `.team/artifacts/` への書き込みなし
- git commit なし
