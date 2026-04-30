# T304 Inspection Report

## 判定

**GO**

---

## 検品結果

### 1. plan.md 整合（採用案 2.1）

- [x] `generateMasterSettings` が `env.ANTHROPIC_CUSTOM_HEADERS = "x-cmux-role: master"` を含む（main.ts:1752-1754）
- [x] `generateConductorSettings` が `env.ANTHROPIC_CUSTOM_HEADERS = "x-cmux-role: conductor"` を含む（main.ts:1905-1907）
- [x] `generateAgentSettings` が `env.ANTHROPIC_CUSTOM_HEADERS = "x-cmux-role: agent"` を含む（main.ts:1838-1840）
- [x] `git diff --stat HEAD` は `main.ts (+13)` と `main.test.ts (+29)` の 2 ファイルのみ。proxy.ts / daemon.ts / conductor.ts は未変更。

### 2. T211 regression 遵守

- [x] `grep -c "CMUX_ROLE" skills/cmux-team/manager/main.ts` → **0 件**
- [x] `bun test skills/cmux-team/manager/main.test.ts -t "T211"` → 9 pass / 0 fail
- [x] 追加されたコメント 3 箇所は「ロール識別ヘッダーを注入」の日本語で、`CMUX_ROLE` 文字列は含まれない

### 3. テスト結果

```
bun test skills/cmux-team/manager/main.test.ts
 148 pass
 0 fail
 396 expect() calls
```

- [x] main.test.ts 全 148 件 pass（fail 0 件）
- [x] 新規 T304 test 3 件が pass（`bun test -t "T304"` → 3 pass / 0 fail）
  - `generateMasterSettings (T304: x-cmux-role)`
  - `generateConductorSettings (T304: x-cmux-role)`
  - `generateAgentSettings (T304: x-cmux-role)`

### 4. TypeScript

```
cd skills/cmux-team/manager && bunx tsc --noEmit
```

- [x] **新規エラー 0 件**
- [x] base branch との diff 比較で一致（`diff /tmp/t304-tsc-base.log /tmp/t304-tsc.log` → NO DIFF）
- 残存エラー 3 件はすべて base branch (T303 / HEAD=06a074a) 由来、T304 と無関係:
  - `conductor.ts(201,3)`: TS1016
  - `daemon.test.ts(3870,9)`: TS2322
  - `daemon.ts(1558,22)`: TS2352

### 5. タスクゴール達成性

- [x] Master の settings.json（`.team/prompts/master-settings.json`）に `env.ANTHROPIC_CUSTOM_HEADERS = "x-cmux-role: master"` が書き出される
- [x] Claude Code が子プロセス起動時に settings.json の `env` を process.env に適用 → Anthropic API リクエストに `x-cmux-role: master` ヘッダーが付与される
- [x] proxy.ts:352 の既存ロジック `req.headers.get("x-cmux-role") || opts?.role` がそのまま新ヘッダーを拾い、trace JSONL の `role` 列に `master`（および `conductor` / `agent`）が記録される経路が成立
- コード上の経路は読み通せる。E2E の実測（`jq -r '.role'` に `master` が現れること）は Inspector スコープ外なので Implementer/ユーザー側で再検証する想定

### 6. ロジック一貫性

- [x] `env` と `hooks` は別キーで JSON として valid（`writeFileSync(settingsPath, JSON.stringify(settings, null, 2))`）
- [x] 既存の `hooks` / `statusLine` / 他キーは未変更、構造を壊していない
- [x] Notification hook の `--role <role>` 引数と新ヘッダーの role 値が一致:
  - Master: `--role master`（L1786） ⇔ `x-cmux-role: master`
  - Agent: `--role agent`（L1861） ⇔ `x-cmux-role: agent`
  - Conductor: `--role conductor`（L1937） ⇔ `x-cmux-role: conductor`

### 7. 副作用

- [x] proxy.ts / daemon.ts / conductor.ts は未変更（`git diff --stat HEAD` で確認）
- [x] 古い trace JSONL の role 列は影響なし（fallback `.role // "unknown"` は既存通り）、新規リクエストにのみ `role=master|conductor|agent` が付く想定
- [x] npm / bun 依存の追加なし（package.json 未変更）

---

## Fix Required

なし（GO）

---

## Minor Observations

- plan.md 5.3 で言及されている `CLAUDE.md` 「トレーサビリティ（v3.4.0）」節への 1-2 行追記は optional として見送られている。docs-sync 時に「Master / Conductor / Agent の settings.json が `ANTHROPIC_CUSTOM_HEADERS=x-cmux-role: <role>` を自動注入する」旨を足すと将来的にドキュメントと実装の乖離が防げる。ただし本タスクの scope 外として許容。
- コード変更は `main.ts` の 3 箇所に閉じており、settings 生成関数の既存構造（`Record<string, any>` リテラル直下に `env` / `hooks` を並列配置）と整合している。import 追加も不要で最小差分。
- `bunx tsc --noEmit` はリポジトリルートでは tsconfig が見つからず error が出るため、`skills/cmux-team/manager/` に cd してから実行する必要があった。手順書（plan.md 4.2 / task.md）には明記なし。次タスク以降、検品手順に `cd` を明記すると再現性が上がる。
