# Inspection: T326 AskUserQuestion 挙動テスト追加

## 判定: GO

Implementer の成果は要件 3 項目を満たし、既存テストを壊さず、本実装の挙動も不変。tsc 型エラー無し、export も最小限（2 関数）。

---

## 検品結果

### 必須チェック

- [x] **1. 要件 3 項目の実装** — OK
- [x] **2. 既存テスト非破壊 (daemon + dashboard 系で 210 pass / 0 fail)** — OK
- [x] **3. 本実装挙動の不変性** — OK
- [x] **4. tsc 型エラー無し** — OK
- [x] **5. export の最小限性** — OK

#### 1. 要件 3 項目の実装 — OK

| 要件 | 実装場所 | 確認内容 |
|---|---|---|
| Conductor SESSION_ASK 統合テスト | `daemon.test.ts` 末尾 (T326 #1) | `status="asking"` / `askQuestion="どちらにしますか?"` / `disconnectedAt=undef` / `lastHookAt=fixed timestamp` / `pid=999` / manager.log に `conductor_asking` + `question=どちらにしますか?` / `notifySpy.toHaveBeenCalledTimes(0)` — すべて assert |
| Agent SESSION_ASK の cmux.notify | `daemon.test.ts` 末尾 (T326 #2) | `notifySpy.toHaveBeenCalledTimes(1)` / `call[0]==="surface:a1"` / `call[1]==="Agent asking"` / `call[2].toContain("どうしますか?")` / `call[3].subtitle==="demo agent task"` |
| dashboard 描画 | `dashboard-conductor.test.tsx` (新規) | Conductor asking 行: ⚠ / asking / T326 / 質問本文 / `[c1]` / YELLOW 2 箇所以上 — truncate (117 char + `...`) — Agent asking 行: ? / ⚙ / fix bug / `[a1]` / YELLOW 3 箇所以上 — `formatConductorsSectionLabel` フルストリング `"Conductors 1 starting 1 assigning 2 asking 1 running 1 broken"` を `toBe` で検証 |

#### 2. 既存テスト非破壊 — OK

```
$ bun test daemon.test.ts dashboard
 210 pass
 0 fail
 668 expect() calls
Ran 210 tests across 4 files. [19.19s]
```

- 対象 4 ファイル: `daemon.test.ts` / `dashboard-issues.test.tsx` / `dashboard-metrics.test.tsx` / `dashboard-conductor.test.tsx`
- `bun test` 全体は実行時間制約により省略（ユーザー指示）。挙動変更は dashboard.tsx の純関数化のみで、影響範囲は dashboard 系テストに完全に閉じている
- `daemon.test.ts` は既存 test に変更なし（describe 末尾に test 2 個を純粋追加）

#### 3. 本実装挙動の不変性 — OK

**`formatConductorsSectionLabel` の連結順序検証**

旧 (dashboard.tsx 1314 行目、削除前):
```ts
sectionTitle(`Conductors${startingCount > 0 ? ` ${startingCount} starting` : ""}${assigningCount > 0 ? ` ${assigningCount} assigning` : ""}${askingCount > 0 ? ` ${askingCount} asking` : ""}${runningCount > 0 ? ` ${runningCount} running` : ""}${brokenCount > 0 ? ` ${brokenCount} broken` : ""}`)
```

新 (dashboard.tsx 696 行目、追加):
```ts
return `Conductors${startingCount > 0 ? ` ${startingCount} starting` : ""}${assigningCount > 0 ? ` ${assigningCount} assigning` : ""}${askingCount > 0 ? ` ${askingCount} asking` : ""}${runningCount > 0 ? ` ${runningCount} running` : ""}${brokenCount > 0 ? ` ${brokenCount} broken` : ""}`;
```

- 連結順序 (starting → assigning → asking → running → broken) と書式 (` ${count} ${label}`、count=0 のときスキップ) が **完全一致**
- 集計ロジックは「同じ配列を 5 回 filter」→「1-pass switch」に変わったが、`status` 値が `"starting"|"assigning"|"asking"|"running"|"broken"` のいずれかである件数を数える点で同等。`idle` 等の他 status は両方ともラベルから除外される
- test ケース `formatConductorsSectionLabel: 各 status のカウントが正確に連結される` (test ファイル 119 行目) が `toBe("Conductors 1 starting 1 assigning 2 asking 1 running 1 broken")` でフルストリング一致を assert している

**`buildConductorRow` の export 追加** — 関数本体は無改変（`export` キーワード追加のみ）

#### 4. tsc 型エラー無し — OK

```
$ bunx tsc --noEmit
(出力なし — 型エラー無し)
```

#### 5. export の最小限性 — OK

```
$ git diff dashboard.tsx | grep -E '^\+export'
+export function buildConductorRow(c: ConductorState & { agents: AgentState[]; status: string }, repoUrl: string | null, spinnerFrame: number = 0) {
+export function formatConductorsSectionLabel(conductors: readonly { status: string }[]): string {
```

- 新規 export は plan で必要と明記された 2 関数のみ。`buildConductorsSection` は export しない方針も守られている

---

### 推奨チェック

- [x] **6. fixture 妥当性** — おおむね OK（軽微な懸念 1 件あり）
- [x] **7. テスト独立性** — OK

#### 6. fixture 妥当性

- Agent fixture: `role: "implementer"`, `taskTitle: "demo agent task"` を両方持ち、subtitle が空にならないことを検証可能 ✓
- YELLOW 検証: `import { rgb } from "@rezi-ui/core"` で `rgb(200, 160, 0)` を呼び出して定数化 → 24bit 整数のハードコード回避 ✓
- 質問 truncate の境界値: 200 char ケースのみ検証。120 char ピッタリ / 121 char の境界値は未検証 — 軽微な懸念事項として記録

#### 7. テスト独立性

- 新規 `daemon.test.ts` test 2 個は `try { spy } finally { mockRestore() }` で spy を必ず解除 → 後続 test に影響しない
- `dashboard-conductor.test.tsx` は純関数テスト（state を持たない）→ 順序非依存
- 個別 test 実行で 210 pass / 0 fail を確認

---

## Critical findings

なし。

## Fix Required

なし。

## 軽微な懸念事項 (GO だが記録)

1. **truncate 境界値の未検証**
   質問本文 truncate のテストは 200 char ケースのみで、120 char ピッタリ / 121 char の境界値は未検証。回帰防止の最小要件は満たすが、`>= 120` か `> 120` かを取り違えた場合の検出力は低い。今後 truncate 実装に手を入れる際は境界値テストを追加することを推奨（ただし本タスクで Fix を要求するほどではない）。

2. **Agent subtitle 優先順位の片側のみ検証**
   subtitle は `taskTitle ?? role ?? "Agent"` の優先順位だが、test fixture が両方 (`taskTitle="demo agent task"`, `role="implementer"`) を持つため `taskTitle` 経路のみ検証。`role` fallback / `"Agent"` fallback の挙動は未検証。要件 (`subtitle に taskTitle/role が入る`) は満たすが、優先順位の回帰検出は taskTitle 経路に限られる。

3. **bun test 全体未実行**
   ユーザー指示で全体実行は省略。daemon + dashboard 系 4 ファイル 210 test での回帰確認に絞った。本実装の変更範囲（`dashboard.tsx` の純関数化）は dashboard 系に閉じているため、影響範囲はカバー済みと判断。

---

## 補足: 確認した変更ファイル一覧

```
M skills/cmux-team/manager/daemon.test.ts          (+127 / -0、test 2 個追加)
M skills/cmux-team/manager/dashboard.tsx           (+27 / -5、export 2 個追加 + リファクタ)
?? skills/cmux-team/manager/dashboard-conductor.test.tsx  (新規 139 行 / 6 test)
M package-lock.json                                 (npm install 副産物)
```

すべて plan.md の意図と一致。Implementer の自己判断（5 個の `*Count` ローカル変数 → 1-pass switch 集計、`countYellow` ヘルパー、`rgb()` 定数化、`await new Promise(r => setImmediate(r))` で fire-and-forget 待機）も適切。
