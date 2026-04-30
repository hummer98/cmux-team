# T352 実装計画: Agent 行のスピナー直後に @handle を配置

タスク本文: `.team/tasks/352-agent-handle-t351/task.md`

## 1. 背景・現状

### T351 で実装済みの状態

- `pool-surface-row.ts` に `buildSurfaceRowSuffix` が新設され、`@handle / <util> / cap:N% / ⚠` を **末尾サフィックス** として UiNode 配列で返す。
- `dashboard.tsx:552-566` の `buildPoolSuffixForSurface` がこのヘルパーの薄い wrapper。pool OFF (`perHandle=null`) のとき `[]` を返す。
- `dashboard.tsx:728-779` の Agent サブツリー描画ループでは、各行 (running / idle / asking) の **行末** に `...agentSuffix` として spread されている。
- Conductor 行（`:613-723`）も同じ helper で末尾に `...poolSuffix` を spread。
- `dashboard-pool.test.tsx` (case 6/7/8/9/10) と `dashboard-conductor.test.tsx` で末尾配置の動作が assertion 化されている。

### 本タスクで変えること

T352 の仕様（task.md）が定める **新レイアウト**:

```
running:  └─ [201] ▘ @kddi <taskTitle>
idle:     └─ [201] ⚙ @kddi <taskTitle>
asking:   └─ [201] ? ⚙ @kddi <taskTitle>
```

要件:

1. Agent 行で `spinner`（running）または `roleIcon`（idle/asking）の **直後** に `@handle` を挿入する。
2. running の handle 色は CYAN、idle の handle 色は plain（taskTitle のみ dim）、asking の handle 色は YELLOW。
3. `tokenHandle === undefined` のとき handle 部分は **完全省略**（`(no token)` も出さない）。
4. Master / Conductor 行のレイアウトは変更しない（T351 の挙動維持）。

### 二重表示問題

T351 で suffix が既に handle を含むため、単純に spinner 直後に handle を挿入すると Agent 行に handle が **2 ヶ所** に出る。Agent 行についてのみ suffix から handle を抜く必要がある。Master/Conductor 行はそのまま。

## 2. 設計判断

### 選択肢の比較

| 案 | 概要 | メリット | デメリット |
|----|------|---------|------------|
| **(A)** `buildPoolSuffixForSurface` に `includeHandle: boolean` 引数を追加。Agent 行は `false` で呼ぶ | dashboard 内で完結、format 層は無変更 | dashboard 側の helper API が広がる |
| **(B)** Agent 行用ヘルパー `buildAgentRowSuffix` を新設（`util/cap/⚠` のみ返す） | 責務分離が明示的 | format 層に新しい関数が増える、内部ロジック重複の懸念 |
| **(C)** `agentSuffix.slice(1)` のような post-process で先頭 handle を捨てる | コード変更最小 | 配列順序前提で fragile、(no token) ケースの扱いが特殊化 |
| **(D)** `buildSurfaceRowSuffix` 自体に option を追加 | 一箇所で吸収可能 | 共有 API（`pool-surface-row.ts`）に dashboard 都合の option が漏れる、CLI 側の `formatSurfaceRow` との非対称が生じる |

### 推奨: **(A)**

採用理由:

- format 層 (`pool-surface-row.ts`) は CLI/dashboard 共通の純粋整形を担う層なので、dashboard の表示都合に対応する option を侵入させたくない（(D) を不採用とする理由）。
- `buildPoolSuffixForSurface` は元々 dashboard private helper で T351 でも「dashboard の API 案 X に対応するための薄い wrapper」として設計済み。ここに `includeHandle` を生やすのは責務として自然。
- (B) はゼロから関数を新設するためコード量が増える割に、内部呼び出しは結局 `buildSurfaceRowSuffix` の一部分を再利用したいだけ。`includeHandle` フラグ 1 つの方が小さい変更で済む。
- (C) は順序前提の fragile な実装で、後で suffix の構造が変わると壊れるため避ける。

### `(no token)` の扱い

仕様は「未バインドのとき handle 省略 → `(no token)` も出さない」。よって `includeHandle: false` の挙動:

- bound: handle node を出力しない (`[util, cap?, ⚠?]` を返す)
- unbound: 空配列 `[]` を返す（`(no token)` も省略）

Master / Conductor 行は `includeHandle: true`（デフォルト）でこれまでどおり `(no token)` を表示する。

### Agent 行のラベル組み立て調整

現在の実装は `label = a.taskTitle ?? a.role ?? ""` を `${roleIcon} ${label}` のように 1 ノードに連結している。handle を間に挟むため **roleIcon / handle / taskTitle を別 ui.text に分割** する必要がある。各 status ごとの色設計:

| status | spinner / icon | handle 色 | taskTitle 色 |
|--------|----------------|-----------|--------------|
| running | spinner CYAN | CYAN | plain |
| idle | roleIcon plain (dim にしない、現状の `${roleIcon} ${label}` 全体 dim を taskTitle のみに変更) | plain | dim |
| asking | roleIcon YELLOW | YELLOW | YELLOW |

> 注: idle 行で現在 `${roleIcon} ${label}` 全体に `{ dim: true }` をかけているが、task.md の仕様では「handle は dim にしない / taskTitle だけ dim 維持」とある。本タスクで idle 行の dim 範囲を taskTitle のみに絞る変更を入れる。roleIcon の dim 有無は仕様に明記されていないが、レイアウト例（idle: `└─ [201] ⚙ @kddi <taskTitle>`）から roleIcon は plain として読める。安全側で **roleIcon は dim 解除、taskTitle のみ dim** とする。

## 3. 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/dashboard.tsx` | `buildPoolSuffixForSurface` に `includeHandle` 引数追加。Agent 行 (running / idle / asking) のラベル組み立てを roleIcon / handle / label の 3 ノード構成に変更し、suffix は `includeHandle: false` で呼ぶ。Master / Conductor 行は無変更（`includeHandle` デフォルト true）。 |
| `skills/cmux-team/manager/dashboard-conductor.test.tsx` | Agent 行 handle 表示 / 非表示の新規テストケース追加（running / idle / asking × bound / unbound）。 |
| `skills/cmux-team/manager/dashboard-pool.test.tsx` | `buildPoolSuffixForSurface` の `includeHandle: false` パスは内部関数のため直接 export しないなら新規テスト不要。Agent 行の挙動は `dashboard-conductor.test.tsx` 側でカバー。既存 case 8（`(no token)` の Agent 行検証）は **Agent 行で `(no token)` を出さない** 仕様変更に伴い更新必要（Conductor 側 `(no token)` 検証に絞るか、テスト本来の意図に合わせ書き換え）。 |

> `pool-surface-row.ts` は **無変更**（T351 の API 契約を維持）。

## 4. 実装ステップ（TDD 順）

### Step 1: テスト追加（red）

`dashboard-conductor.test.tsx` に以下を追加:

1. **running / bound**: `agents=[{status:"running", role:"impl", taskTitle:"foo", tokenHandle:"@kddi"}]`, `perHandle={"@kddi": util/cap}` で
   - `@kddi` を含む
   - `[201] ▘ @kddi foo` の順序（spinner → @handle → taskTitle）を JSON 上で検証
   - 行末 suffix に handle が **重複しない**（出現回数 1 回）
2. **idle / bound**: `status` が running/asking 以外で
   - `[201] ⚙ @kddi foo` の順序
   - taskTitle が dim、handle は dim でないこと（`{ dim: true }` の節点で handle が含まれない）
3. **asking / bound**: `status: "asking"` で
   - `[201] ? ⚙ @kddi foo` の順序
   - handle が YELLOW で出力される
4. **running / unbound** (`tokenHandle: undefined`):
   - `@` 文字を一切含まない
   - `(no token)` も含まない
   - `[201] ▘ foo` の構造維持
5. **idle / unbound**: 同上で `[201] ⚙ foo`
6. **asking / unbound**: 同上で `[201] ? ⚙ foo`
7. **pool OFF (`perHandle=null`)**: いずれの status でも T351 後の既存挙動（handle 一切なし）を維持

### Step 2: 既存テストの仕様整合確認

`dashboard-pool.test.tsx` case 8 (`agent.tokenHandle=undefined → (no token)`) は今回の仕様で **Agent 行で `(no token)` を出さない** に変わる。

対応案:
- case 8 を更新: Agent 行に `(no token)` が **含まれない** ことを assertion とし、Conductor 行側の `(no token)` (該当する別ケースがあれば) を別テストで検証。
- 既存 case 6/7/9/10 はサーフェス重複禁止テストなので Agent 行の handle が増えても satisfy するように見えるが、case 6 の Conductor 行 assertion は維持されるか確認。

### Step 3: 実装（green）

`dashboard.tsx` の変更箇所:

1. `buildPoolSuffixForSurface` のシグネチャ変更:
   ```ts
   function buildPoolSuffixForSurface(
     perHandle: Map<string, PerHandleSummary> | null,
     surface: string,
     tokenHandle: string | undefined,
     includeHandle: boolean = true,    // ← 追加
   ): ReturnType<typeof ui.text>[]
   ```
   - `perHandle == null` → 従来通り `[]`
   - `includeHandle === false`:
     - `tokenHandle == null` → `[]` を返す（`(no token)` を出さない）
     - `tokenHandle != null` → `buildSurfaceRowSuffix(...)` の戻り値から先頭の handle ノードを除いた残りを返す（実装は `buildSurfaceRowSuffix` を呼んで結果配列の `.slice(1)` で OK。先頭が必ず handle node であることは `pool-surface-row.ts:101-102` のコードで保証されている）。
     - 注: 単純な `slice(1)` を採用するのは選択肢 (C) と似て見えるが、ここでは「同一プロセス内で `buildSurfaceRowSuffix` を所有する関数の薄い post-process」であり、テストで順序契約を assertion 化するため fragile ではない。`pool-surface-row.ts` の戻り値順序契約を `dashboard-pool.test.tsx` の case 10 周辺に追加 assertion して固定化する（後述）。
   - `includeHandle === true` → 既存挙動

2. Agent 行 (`:728-779`) を以下に書き換え:
   - `agentSuffix = buildPoolSuffixForSurface(perHandle, a.surface, a.tokenHandle, false)`
   - 各 status の `ui.row` 子要素を再構成:
     - **asking**:
       ```
       prefix(dim) | [surface](YELLOW) | "?"(YELLOW) | roleIcon(YELLOW) | (handle?) | label(YELLOW) | ...agentSuffix
       ```
     - **running**:
       ```
       prefix(dim) | [surface](CYAN) | spinner(CYAN) | (handle?) | label(plain) | ...agentSuffix
       ```
     - **idle (else)**:
       ```
       prefix(dim) | [surface](CYAN) | roleIcon(plain) | (handle?) | label(dim) | ...agentSuffix
       ```
   - `(handle?)` は `a.tokenHandle ? ui.text(a.tokenHandle, { style: { fg: <CYAN|YELLOW> }})` の条件 push。idle は plain なので style 省略。
   - 配列に `null` を含めると `ui.row` が許容するか要確認: Conductor 行 (`:719`) で既に `c.taskTitle ? buildTitleWithLinks(...) : null` の使用例があるため OK。同パターンを踏襲する。

3. Master / Conductor 行は **変更なし**（`buildPoolSuffixForSurface` 呼び出しの第 4 引数省略でデフォルト `true` のまま）。

### Step 4: 検証

- `bunx tsc --noEmit` で 0 errors
- `bun test --timeout 30000 dashboard-conductor.test.tsx` 全 pass
- `bun test --timeout 30000 dashboard-pool.test.tsx` 全 pass
- `bun test --timeout 30000 dashboard-issues.test.tsx dashboard-metrics.test.tsx` regression 0
- `cmux-team start` で実機起動し、Agent 行が仕様どおりに表示されるか目視確認

> 注: CLAUDE.md 記載のとおり `bun test` 全体実行は禁忌。`for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done` を Conductor / Implementer は使用すること。

## 5. テスト計画

### 新規追加 (`dashboard-conductor.test.tsx`)

| ID | ケース | 期待 |
|----|--------|------|
| T352-1 | running × bound | spinner 直後に handle、CYAN、suffix から handle 除去 |
| T352-2 | idle × bound | roleIcon 直後に handle、plain、taskTitle のみ dim |
| T352-3 | asking × bound | `?` + roleIcon 直後に handle、YELLOW |
| T352-4 | running × unbound | handle node なし、`(no token)` なし |
| T352-5 | idle × unbound | 同上 |
| T352-6 | asking × unbound | 同上 |
| T352-7 | pool OFF (perHandle=null) | handle / suffix 一切なし（T351 の既存挙動） |
| T352-8 | order assertion | JSON 文字列上で `[201]` → spinner/icon → `@kddi` → taskTitle の出現順序 |

### 更新 (`dashboard-pool.test.tsx`)

- **case 8**: 「Agent 行 unbound で `(no token)` が出る」→「Agent 行 unbound で `(no token)` が **出ない**」に反転。仕様変更を test に反映。
- **case 6 / 7 / 9 / 10**: 影響なしの想定だが pass 確認。case 6 の Conductor 行 surface ラベル 1 度だけ assertion は Agent 行新表示でも壊れない（Conductor 行のみ対象）。

### `pool-surface-row.ts` 戻り値順序契約の補強（任意）

`dashboard-pool.test.tsx` の `buildSurfaceRowSuffix API 契約` describe に「bound 入力で **戻り値配列の先頭が必ず `@handle` の text node**」という assertion を追加し、`buildPoolSuffixForSurface` の `slice(1)` が将来壊れにくいようにする。

## 6. リスク・注意点

| リスク | 対策 |
|-------|------|
| Master / Conductor 行に handle 二重出力 / dim 崩れ | `includeHandle` のデフォルト `true` を保つ。Master / Conductor の呼び出し箇所を grep して引数省略であることを確認。dashboard-pool.test.tsx case 6 (Conductor 行) を CI で監視。 |
| suffix 順序契約破壊 (`slice(1)` 前提) | テストで先頭が handle node であることを assert。`pool-surface-row.ts` のコメント (`:86-89`) と整合。 |
| idle 行の dim 範囲変更でレイアウト崩れ（roleIcon の dim 解除） | 仕様 (task.md) を根拠に明示。レビュアー視点で挙動差分が議論になりうる箇所のため、PR 説明に「idle の roleIcon は plain、taskTitle のみ dim」と記載。 |
| `ui.row` の `null` 子要素サポート | 既存 Conductor 行 (`:719`) で利用実績あり。同パターンを踏襲。 |
| tsc エラー | `includeHandle?: boolean` を optional にし default true を関数本体で適用。呼び出し側の互換維持。 |

## 7. 完了条件（task.md 再掲 + 補足）

- [ ] running / idle / asking の各 Agent 行で spinner / roleIcon の **直後** に `@handle` が出る
- [ ] handle 色: running CYAN / idle plain / asking YELLOW
- [ ] handle 未バインド時 (`tokenHandle === undefined`) は handle 部分省略、`(no token)` も出ない
- [ ] Master / Conductor 行のレイアウトは T351 と同一
- [ ] 既存 `dashboard-conductor.test.tsx` / `dashboard-pool.test.tsx` / `dashboard-metrics.test.tsx` / `dashboard-issues.test.tsx` 全 pass
- [ ] 新規 Agent 行テスト T352-1〜T352-8 が pass
- [ ] `bunx tsc --noEmit` 0 errors
- [ ] `cmux-team start` で実機目視確認（任意だが推奨）

## 8. 作業境界

- 本 plan.md は計画のみ。コード変更は Implementer Agent が別タスクで実施。
- `pool-surface-row.ts` は無変更（API 契約維持）。
- Master / Conductor 行レイアウトには触らない。
