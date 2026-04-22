# T295 close-task の納品物明示を強制化 — 実装計画

**Role**: planner
**Run**: task-295-1776828703
**Worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-295-1776828703`
**Output**: `.team/tasks/295-close-task/runs/task-295-1776828703/plan.md`
**Base**: main（T294 auto-update task モード廃止 完了済み / commit 4d484d2）

---

## 1. 課題分析

### 1.1 現状の問題点

`cmdCloseTask`（`skills/cmux-team/manager/main.ts` L3025〜3108）は受理する情報が `--task-id` + `--journal`（任意）+ `--force`（任意）だけで、task-state.json の closed 行には `status` / `closedAt` / `journal?` しか残らない。

```ts
// 現状の task-state.json 書き込み（main.ts:3055-3059）
taskState[taskId] = {
  status: "closed",
  closedAt: new Date().toISOString(),
  ...(journal ? { journal } : {}),
};
```

しかし Conductor は Step 9（`conductor-role.md` L639〜652）で「ローカル ff-only マージ / PR / 調査系 files 納品」の **3 種類の納品方式** を判断的に選ぶ。加えて `--success false` 系 escalation では納品ゼロのケースもある。これらが機械可読に残らないため:

- `task-state.json` から「このタスクの成果物はどこか」を辿れない
- `dashboard.tsx` `buildTaskRow`（L667〜763）は closed タスクを `○ T042 closed <title> <time>` でしか出せない
- `trace-task`（main.ts L3867）は Base 行までは出すが Deliverable 行を出せない
- 人間は journal 文字列を目視で解釈して「マージされたのか PR なのか」を推定する必要がある

### 1.2 根本原因

`close-task` CLI に「納品方式」を構造として受け取るスロットが無い。自由文 `--journal` はセマンティクスを意図的に崩してあるため、ここを後付けで解析しても機械可読にはならない。納品方式は **本質的に 4 値の enum + 付随属性（ブランチ / SHA / URL / パスリスト）** という tagged union 構造を持つので、型レベルで分離するのが構造的に正しい。

### 1.3 影響範囲

| レイヤー | 影響 |
|---------|------|
| CLI 入力 | `close-task` に必須フラグ追加（破壊的変更、task.md 合意済み） |
| 永続化 | `task-state.json` の closed 行に optional `deliverable` 追加（後方互換 = 旧 closed 行は `deliverable=undefined` のまま読める） |
| 型 | `schema.ts` に `Deliverable` discriminated union + zod schema 追加。`task.ts:TaskState` に `deliverable?: Deliverable` 追加 |
| daemon 側 auto-close | `handleConductorDone` が `close-task` 未呼で auto-close する経路（`daemon.ts` L3157 `auto_closed_by_daemon`）でも `deliverable` を記録する必要あり（判断 DL-02） |
| TUI | `dashboard.tsx`: `TaskSummary` に `deliverable?` 伝播、`buildTaskRow` で closed 表示に kind icon/suffix を追加 |
| CLI 出力 | `trace-task` に Deliverable 行を追加（Base 行の直後） |
| i18n | `help_close_task` 日英両方の刷新 |
| テンプレ | `templates/{ja,en}/conductor-role.md` Step 9 / Step 11、`conductor.md` Step 7、`conductor-task.md` Step 11 記述 の 6 ファイル |
| ドキュメント | `CLAUDE.md` 通信プロトコル節、`docs/spec/05-install-and-infrastructure.md` `close-task` 行、`docs/spec/01-skill-cmux-team.md` 表、`docs/spec/04-templates.md` / `07-state-machine.md` の言及箇所 |
| テスト | `main.test.ts` の close-task 系テスト（L586, L643, L654, L667, L702 近辺）を新インターフェース仕様に更新。`task.test.ts` は deliverable 格納・ロード往復を追加 |

---

## 2. 技術アプローチ

### 2.1 選択したアプローチ

**Deliverable を `schema.ts` の zod discriminated union として定義し、`task.ts:TaskState` に optional フィールドとして追加する。** CLI 側は kind ごとに必須フラグを検証する pure 関数 (`parseCloseTaskArgs`) に分離し、`main.ts` からはその関数を呼ぶだけにする。

```ts
// schema.ts に追加
export const Deliverable = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("files"), files: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("merged"), branch: z.string(), sha: z.string() }),
  z.object({ kind: z.literal("pr"), prUrl: z.string() }),
  z.object({ kind: z.literal("none") }),
]);
export type Deliverable = z.infer<typeof Deliverable>;
```

```ts
// task.ts:TaskState に追加（optional、後方互換）
export interface TaskState {
  status: string;
  // ...
  journal?: string;
  /**
   * 納品方式（closed 時のみ set）。T295 で追加。
   * 既存 closed 行には存在しない（undefined で読める）。
   */
  deliverable?: Deliverable;
  // ...
}
```

### 2.2 選択理由

- **discriminated union** は kind ごとに必須フィールドが異なる 4 分岐を型レベルで正しく分離する。`{ kind: "files"; files: string[] }` に対しては `files` が必須、他 kind では参照不能になり、`switch (d.kind)` で網羅性チェックが効く（`never` assertion）
- zod ベースなので `task-state.json` load 時（`loadTaskState`）に `safeParse` でスキーマ検証できる。壊れた JSON は warn ログ + `deliverable: undefined` で継続可（fail-fast にしない理由は DL-03）
- `schema.ts` は T298 以前からキューメッセージの zod discriminated union を使っており、同じパターンを踏襲する（`QueueMessage` 参照、L148）

### 2.3 代替案と却下理由

| 代替案 | 却下理由 |
|--------|---------|
| **plain TypeScript discriminated union のみ（zod なし）** | 却下。`task-state.json` は永続化ファイルなので壊れた入力で落ちないよう runtime validation が要る |
| **Deliverable を `task.ts` に置く** | 却下。CLI message の zod 型は `schema.ts` に集約する既存慣習があり、CLI コマンドに渡される構造物は schema.ts 側に置くのが一貫性がある |
| **`closedAt` 行の `journal` を JSON 文字列化して kind 情報を埋め込む** | 却下。journal は人間向け自由文として意図的に未構造なので、型情報を混ぜると両者が腐る |
| **CLI に `--deliverable` 1 本で JSON を渡す** | 却下。shell escape が煩雑で、conductor テンプレから heredoc で書くと極めて壊れやすい。flag 分解のほうが壊れにくい |

### 2.4 既存パターンとの整合性

- `schema.ts` の `QueueMessage` と同じく zod discriminated union（L148）
- `getArg`/`requireArg`/`hasFlag`（main.ts L147〜163）を活用し、`--deliverable <path>`（複数可）のみ新規 helper `getMultiArg(name)` を追加
- 既存 `close-task` の `--journal` / `--force` は保持。`--force` は assigned ガード bypass 用、sync-check の bypass ではない（sync-check は ready 昇格時のみ）

### 2.5 構造的解決

- `validateDeliverableArgs(args) → Deliverable | CliError` を pure 関数として分離し、`cmdCloseTask` からは結果を受け取るだけにする。これにより main.ts のテストが argv 配列だけで成立する
- `schema.ts` で `Deliverable` を export し、`dashboard.tsx` / `task.ts` / `main.ts` が同一の型を参照する（単一 source of truth）
- kind → 表示文字列の mapping を 1 箇所に集約する（`formatDeliverable(d: Deliverable, mode: "short" | "long"): string`、配置は `task.ts` か新規 `deliverable.ts`。DL-05）

---

## 3. 変更対象

### 3.1 変更するファイル

| # | パス | 変更概要 |
|---|------|---------|
| 1 | `skills/cmux-team/manager/schema.ts` | `Deliverable` zod schema + 型 export |
| 2 | `skills/cmux-team/manager/task.ts` | `TaskState.deliverable?: Deliverable` 追加。`formatDeliverable(d, mode)` ユーティリティ追加。`loadTaskState` の zod 検証強化 |
| 3 | `skills/cmux-team/manager/main.ts` | `cmdCloseTask`: `--deliverable-kind` 必須化、kind ごとの付随フラグ検証、`taskState[taskId].deliverable = ...` 書き込み。`parseCloseTaskArgs(args)` pure 関数に分離。`getMultiArg(name)` helper 追加。`cmdTraceTask`: Base 行の後に `Deliverable:` 行を追加 |
| 4 | `skills/cmux-team/manager/daemon.ts` | `handleConductorDone` の auto-close 経路（L3155〜3164）で `deliverable: { kind: "none" }` を付けて書き込み（DL-02） |
| 5 | `skills/cmux-team/manager/i18n.ts` | `help_close_task` の日英刷新（Usage / Options / Examples / Notes を新フラグ前提に書き直し） |
| 6 | `skills/cmux-team/manager/dashboard.tsx` | `TaskSummary` 経由で `deliverable` を受け、closed 行の末尾に kind suffix（例: `merged/ff-only`、`pr/#42`、`files(3)`、`none`）を表示 |
| 7 | `skills/cmux-team/manager/daemon.ts` `TaskSummary` 生成部（L2536〜2547） | `deliverable: taskState[t.id]?.deliverable` を伝播 |
| 8 | `skills/cmux-team/templates/ja/conductor-role.md` | Step 11 L699〜703 を 4 分岐化。Step 9 L639〜652 末尾に「納品方式と kind の対応」表を追加 |
| 9 | `skills/cmux-team/templates/ja/conductor.md` | L270〜273 Step 7 の close-task 例を merged kind に差し替え |
| 10 | `skills/cmux-team/templates/ja/conductor-task.md` | L40 の close-task 例を merged kind に差し替え、kind 必須である旨を明記 |
| 11〜13 | `skills/cmux-team/templates/en/{conductor-role,conductor,conductor-task}.md` | 同上の英訳 |
| 14 | `skills/cmux-team/manager/main.test.ts` | 既存テスト（close-task: L586 / L643 / L654 / L667 / L702）を新 CLI 仕様に更新 + 新規テスト（kind 別の deliverable 書き込み検証 / kind 省略時 exit 1 / kind に対する付随フラグ欠落時 exit 1） |
| 15 | `skills/cmux-team/manager/task.test.ts` | `Deliverable` の zod 往復、`loadTaskState` が旧 closed 行を `deliverable=undefined` で読めることを確認 |
| 16 | `CLAUDE.md` | 「通信プロトコル」節直下の CLI 表と、必要なら新規「Deliverable 型」節を追加 |
| 17 | `docs/spec/05-install-and-infrastructure.md` | L126 の `close-task` 行を新 CLI 仕様に書き直し |
| 18 | `docs/spec/01-skill-cmux-team.md` | L77 の表を新仕様に書き直し |
| 19 | `docs/spec/04-templates.md` | Conductor Step 11 言及箇所を更新（L111, L117 近辺） |
| 20 | `docs/spec/07-state-machine.md` | L120 の closed 説明に deliverable の必須性を追記 |
| 21 | `CHANGELOG.md` | 次リリース向け entry（Breaking change として明記） |

### 3.2 新規作成するファイル

なし（`formatDeliverable` は `task.ts` に同居させるため、新規ファイルは作らない。DL-05）。

### 3.3 削除するファイル

なし。

---

## 4. サブタスク分割

**並列実装禁止**。旧 `cmdCloseTask` と新実装の二重化は行わない。Step 1〜3 は順序を守って行う（schema → 書き込み側 → 読み出し側）。

### S1. `schema.ts` に `Deliverable` 追加

- 対象: `skills/cmux-team/manager/schema.ts`
- 作業:
  - `z.discriminatedUnion("kind", [...])` で 4 variant を定義
  - `export const Deliverable` と `export type Deliverable` を追加
  - 既存の `// --- Agent 状態 ---` セクションの直前（L179 付近）に「--- Deliverable (T295) ---」コメント節を追加
- 完了条件:
  - `bunx tsc --noEmit` で schema.ts 由来エラーが 0 件
  - `import { Deliverable } from "./schema"` が task.ts / main.ts / dashboard.tsx から参照できる
- 検証: `grep -n "export const Deliverable\|export type Deliverable" skills/cmux-team/manager/schema.ts` が 2 行返る

### S2. `task.ts` に `TaskState.deliverable?` + `formatDeliverable` 追加

- 対象: `skills/cmux-team/manager/task.ts`
- 作業:
  - `TaskState` に `deliverable?: Deliverable` を追加（journal 行の次）
  - `loadTaskState` でパース後に `Deliverable.safeParse` で検証、失敗は warn ログ + 当該 entry の `deliverable` を undefined に倒す（DL-03）
  - `formatDeliverable(d: Deliverable, mode: "short" | "long"): string` を export。short はリスト一覧用（`merged/abc1234`, `pr/#42`, `files(3)`, `none`）、long は詳細表示用（`merged into task-042/task @ abc1234ef`, `PR: https://...`, `files:\n  - path1\n  - path2`, `none: (journal を参照)`）
- 完了条件:
  - `Deliverable` 変換テスト（task.test.ts）で全 4 variant がシリアライズ・デシリアライズ可能
  - 旧 closed 行（`{ status: "closed", closedAt: "...", journal: "..." }`）を読み込んでもエラーにならず `deliverable === undefined`
- メソッド制約: 既存 `loadTaskState` の `JSON.parse` フローを保ちつつ、entry 単位の `Deliverable.safeParse` を挟む。json 全体を zod で parse する破壊的変更は避ける（旧データ互換）
- 検証: `bun test task.test.ts` pass

### S3. `main.ts` cmdCloseTask を新仕様に書き換え

- 対象: `skills/cmux-team/manager/main.ts`
- 作業:
  - `getMultiArg(name: string): string[]` を L149 近辺に追加（argv を前から走査して `--name <v>` の全出現を集める。`--name=v` 形式は T291 以前のヘルパーと同じく非対応で問題なし）
  - `parseCloseTaskArgs(argv: string[]): { deliverable: Deliverable; journal?: string; force: boolean } | { error: string }` を export として分離
    - kind 未指定 → `error`
    - `files` で `--deliverable` ゼロ件 → `error`
    - `merged` で `--merged-into` / `--merge-sha` 欠落 → `error`
    - `pr` で `--pr-url` 欠落 → `error`
    - `none` で他 kind 用フラグが指定されていたら `error`（exclusive 検証）
  - `cmdCloseTask` から `parseCloseTaskArgs` を呼び、error なら `console.error` + exit 1
  - `taskState[taskId] = { status: "closed", closedAt: ..., ...(journal ? {journal} : {}), deliverable }` に変更
  - 既存の assigned ガード（L3049）は保持。`--force` の意味は従来通り
- 完了条件:
  - `cmux-team close-task --task-id X --deliverable-kind merged --merged-into b --merge-sha abc` で task-state.json に deliverable が書かれる
  - `cmux-team close-task --task-id X` のみ（kind 無し）で exit 1、stderr に新フラグの案内
  - `cmux-team close-task --task-id X --deliverable-kind files` で exit 1（`--deliverable` 欠落）
- メソッド制約: 新規 CLI parser は既存 `getArg` / `requireArg` / `hasFlag` を使う。新設 helper は `getMultiArg` のみ
- 検証: `grep -n "parseCloseTaskArgs\|getMultiArg" skills/cmux-team/manager/main.ts` が 2 箇所以上返る

### S4. `daemon.ts` auto-close 経路を deliverable 対応に

- 対象: `skills/cmux-team/manager/daemon.ts`
- 作業:
  - L3155〜3164 の `auto_closed_by_daemon` 経路で `deliverable: { kind: "none" }` を付ける
  - journal 文言（`auto_closed_by_daemon: CONDUCTOR_DONE without close-task`）は保持
  - `trace DB` insert の `event="closed"` 行にも deliverable の反映が必要かを確認し、不要なら見送る（DL-04）
- 完了条件:
  - `daemon.test.ts` の T274 test（L4534〜）が `deliverable.kind === "none"` を追加 assertion しても pass
- 検証: `grep -n "auto_closed_by_daemon" skills/cmux-team/manager/daemon.ts` の該当行近傍に `deliverable:` が追加されている

### S5. `i18n.ts` `help_close_task` 刷新（日英）

- 対象: `skills/cmux-team/manager/i18n.ts`
- 作業:
  - L355〜373（英）と L1080〜1098（日）の両方を刷新
  - Examples セクションで merged / pr / files / none の 4 パターンを全部載せる
  - Notes に「kind は必須。未指定時 exit 1」と「旧 closed 行は読み取り時に deliverable=undefined として扱われる（破壊的変更は作成側のみ）」を追記
- 完了条件: `cmux-team close-task --help` で新仕様が表示される
- 検証: `grep -n "deliverable-kind" skills/cmux-team/manager/i18n.ts` が 10 行以上返る（例 × 日英 × 複数 kind）

### S6. `dashboard.tsx` / `daemon.ts:TaskSummary` に deliverable 伝播 + 表示

- 対象: `skills/cmux-team/manager/daemon.ts` の `TaskSummary` interface（L36〜47）、`state.taskList` 生成（L2536〜2547）、`dashboard.tsx` の `buildTaskRow`（L667〜763）
- 作業:
  - `TaskSummary` に `deliverable?: Deliverable` を追加
  - `state.taskList.map(...)` で `deliverable: taskState[t.id]?.deliverable` を渡す
  - `buildTaskRow` の closed ブランチで `timeInfo` の後に `formatDeliverable(d, "short")` を dim 色で追加表示（deliverable 不在時は何も出さない）
- 完了条件:
  - dashboard の closed タスク行に `○ T042 closed "title" 12:34 (15m) merged/abc1234` のような表示が出る
  - deliverable が無い旧 closed 行は現行通り `○ T042 closed "title" 12:34 (15m)` で表示される
- 検証: `grep -n "formatDeliverable" skills/cmux-team/manager/dashboard.tsx` が 1 箇所以上返る

### S7. `trace-task` に Deliverable 行を追加

- 対象: `skills/cmux-team/manager/main.ts` `cmdTraceTask`（L3867〜）
- 作業:
  - L3913 `console.log("Base: -")` の直後に Deliverable 行を追加
  - `taskState[taskId]?.deliverable` を取得し、`formatDeliverable(d, "long")` で複数行出力
  - deliverable 不在時は `Deliverable: -`
- 完了条件:
  - `cmux-team trace-task 100` が従来出力 + `Deliverable: -` を出す
  - 新規 close-task の後に `cmux-team trace-task <id>` で kind 別の詳細が出る
- 検証: 手動で各 kind を閉じて `trace-task` 出力を確認

### S8. Conductor テンプレ書き換え（ja/en × 3 ファイル = 6 ファイル）

- 対象: `skills/cmux-team/templates/{ja,en}/{conductor-role,conductor,conductor-task}.md`
- 作業:
  - `conductor-role.md` Step 11 L699〜703（ja）/ L655（en）の close-task コマンドを **Step 9 の分岐と対応付けた 4 パターン** に書き換え。heredoc 的に各 kind の実例を併記:
    - merged: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind merged --merged-into <branch> --merge-sha $(git rev-parse <branch>) --journal "..."`
    - pr: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind pr --pr-url <url> --journal "..."`
    - files: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind files --deliverable <path1> --deliverable <path2> --journal "..."`
    - none: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind none --journal "<理由>"`
  - Step 9（L639〜652 ja / L605〜 en）末尾に「納品方式と kind の対応」節を追加（リスト 4 項目）
  - `conductor.md` Step 7 L270〜273 は「最小フロー」の位置付けなので **merged kind** の 1 例のみに差し替え、詳細は `conductor-role.md` 参照とする
  - `conductor-task.md` L40, L43 は「close-task が CONDUCTOR_DONE を送る」旨を保持しつつ、「--deliverable-kind が必須」を 1 行追加
- 完了条件:
  - 6 ファイルいずれにも `--deliverable-kind` を含む例が最低 4 箇所現れる（merged/pr/files/none）
  - ja と en の対応する節が 1:1 に訳されている
- 検証: `rg -n "\-\-deliverable\-kind" skills/cmux-team/templates/ | wc -l` が 20 以上

### S9. ドキュメント（CLAUDE.md + docs/spec/）更新

- 対象:
  - `CLAUDE.md` 「通信プロトコル」節および close-task 言及箇所
  - `docs/spec/05-install-and-infrastructure.md` L126
  - `docs/spec/01-skill-cmux-team.md` L77
  - `docs/spec/04-templates.md` L111, L117 付近
  - `docs/spec/07-state-machine.md` L120
- 作業:
  - 各箇所の `close-task` 説明に「`--deliverable-kind` 必須」を明記
  - `CLAUDE.md` には「Deliverable 型と task-state.json スキーマ」を短く追加（schema.ts 参照 + 4 variant の一覧表）
- 完了条件: docs に旧仕様の記述が残っていない（`rg "close-task --task-id <id> \[--journal" docs/` で 0 件）
- 検証: `rg -n "deliverable-kind" docs/ CLAUDE.md | wc -l` が複数

### S10. テスト更新（main.test.ts / task.test.ts / daemon.test.ts）

- 対象:
  - `skills/cmux-team/manager/main.test.ts` L482〜L720 付近
  - `skills/cmux-team/manager/task.test.ts`
  - `skills/cmux-team/manager/daemon.test.ts` L4534 付近
- 作業:
  - 既存 close-task テストで `--deliverable-kind merged --merged-into t --merge-sha x` などを追加して pass させる
  - 新規テスト:
    - kind 省略で exit 1 + stderr メッセージ
    - kind=files で `--deliverable` 0 件 exit 1
    - kind=merged で `--merged-into` 欠落 exit 1
    - kind=pr で `--pr-url` 欠落 exit 1
    - kind=files で `--deliverable` 複数指定時に配列に格納される
    - kind=none で他 kind フラグ併記 exit 1
    - 正常 close 後に task-state.json load で deliverable が zod parse を通る
  - daemon.test.ts T274 test に `deliverable.kind === "none"` assertion を追加
  - `task.test.ts` に `Deliverable` の zod 往復 / 旧 closed 行の後方互換 test を追加
- 完了条件: `bun test` がすべて pass
- 検証: `bun test 2>&1 | tail -5` で fail=0

### S11. 検証とリリース準備

- 対象: リポジトリ全体
- 作業:
  - `bunx tsc --noEmit` で T295 由来の新規エラーが 0 件（既存の 3 件のエラー（`conductor.ts(201,3)` / `daemon.test.ts(3870,9)` / `daemon.ts(1596,22)` は T295 対象外、DL-06）
  - `bun test` で全テスト pass
  - dashboard 手動確認（`cmux-team start` 環境で closed タスク行に kind 表示が出ること）
  - `cmux-team close-task --help` が新仕様を表示すること
  - `CHANGELOG.md` に Breaking change entry を追加
- 完了条件: 上記すべて pass
- 検証: `git diff --stat main` でファイル数が S1〜S10 の想定範囲に収まっている

---

## 5. リスク

### 5.1 既存機能への影響

| リスク | 対策 |
|-------|------|
| 旧 Conductor プロンプトを抱えたセッションが resume し、`--journal` だけで close-task を呼んで exit 1 で止まる | リリース後に各 Conductor ペインで `/clear` を実行させる運用指示を CHANGELOG に明記。T274 リリースと同じ流儀（CHANGELOG L78 参照） |
| docs/spec/ のサンプルや CLAUDE.md の `close-task --task-id 035 --journal` 系記述が古いまま残る | S9 で一括洗い出し。`rg "close-task --task-id.*--journal" docs/ CLAUDE.md README.md README.ja.md` が 0 件になるまで修正 |
| 他プロジェクト（Dear / mado 等）の Conductor プロンプトも旧仕様 | 本リポジトリのスコープ外。リリースノートで通知し、各プロジェクトで `cmux-team restart` を要求する |
| `daemon.ts` auto-close（T274 セーフティネット）経路で deliverable が `none` 固定になる | 意図通り。Conductor が close-task を呼ばなかった時点で納品物不明であり、`none` + auto_closed_by_daemon journal で監査証跡は残る（DL-02） |

### 5.2 エッジケース

| ケース | 挙動 |
|-------|------|
| `--deliverable-kind none` + `--journal` 未指定 | 許可する（journal は全 kind で optional）。ただしレビュー目線では `none` は journal 必須にしたくなるが、task.md 指示では journal は全 kind optional なのでそれに従う |
| `--journal ""`（空文字） | `getArg` が空文字を返すので `journal: ""` が記録される。空文字は `undefined` と等価に落とす（journal 行の既存挙動と一致、`if (journal)` で undefined 扱い） |
| `--deliverable` に複数 path、うち 1 つが重複 | schema.ts では重複を拒まない（`z.array(z.string()).min(1)`）。意味的には重複 = ユーザーのタイポの可能性だが、破棄すべきか並べて残すかは判断が分かれる。**並べて残す**（最も素直な動作、CLI 側で dedup しない） |
| `--deliverable-kind` の値が 4 値以外（例: `--deliverable-kind merge`） | zod の discriminated union が `safeParse` で reject → exit 1 + stderr に「expected one of files/merged/pr/none」 |
| `--pr-url` に URL でない値 | `z.string()` のみなので受け付けてしまうが、この段階で URL 厳密検証はしない（DL-07）。人間が見て気付く想定 |
| 既存 closed 行の再 close（冪等） | 現状と同じく上書き。deliverable も上書きされる。journal も書き直される |
| `--force` + assigned タスクの close | 現状と同じく force close。deliverable は指定された kind で記録される |

### 5.3 テスト戦略

- **unit テスト** (`main.test.ts`): `parseCloseTaskArgs` の純粋関数テストを中心に。kind × 付随フラグの組み合わせ境界を網羅（7 ケース以上）
- **integration テスト** (`main.test.ts` runCli): 実 CLI を通して task-state.json 書き込みを検証（既存 5 テスト更新 + 新規 3 〜 4 テスト）
- **schema テスト** (`task.test.ts`): zod シリアライズ往復、旧 closed 行の後方互換
- **daemon テスト** (`daemon.test.ts`): auto-close 経路で `deliverable.kind === "none"` になることを確認
- **手動テスト**: `cmux-team start` 環境で 4 kind それぞれを close し、dashboard / trace-task 出力を目視

---

## 6. 既存型エラーの先読み

着手前（main ブランチ時点 / worktree: task-295-1776828703）の `bunx tsc --noEmit` 結果:

```
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1596,22): error TS2352: Conversion of type 'string | undefined' to ...
```

**対象ファイル（main.ts / schema.ts / i18n.ts / dashboard.tsx）の既存エラー: 0 件。**

### 2 区分

- **本タスクで解消**: なし（対象ファイルに既存エラー無し）
- **後続 cleanup 分離**: 上記 3 件はすべて T295 のスコープ外（`conductor.ts` / `daemon.ts` / `daemon.test.ts`）。touched-files zero-errors チェック上は本タスクの実装完了を妨げない。該当は既存別問題として cleanup タスクを別途起票するか、既に起票済みかを Implementer に確認させる

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| DL-01 | `Deliverable` を `schema.ts` に置くか `task.ts` に置くか | **`schema.ts`** | task.md 指示通り。CLI 越しに渡される構造物は zod で定義する既存慣習（`QueueMessage`）と一致する |
| DL-02 | `handleConductorDone` の auto-close 経路（daemon.ts L3155）で deliverable をどう扱うか | **`{ kind: "none" }` を書く** | close-task が呼ばれなかった時点で納品物不明。`none` + `auto_closed_by_daemon` journal で監査証跡は残る。ここを空にすると `deliverable: closed 時は必須` の契約が daemon 経由で破れる |
| DL-03 | `loadTaskState` で壊れた deliverable を見つけた時の挙動 | **warn ログ + `deliverable: undefined`** で継続（fail-fast しない） | 永続化ファイルの壊れで起動不能になる事故を避ける。既存 `loadTaskState` の `catch` も同方針（L315） |
| DL-04 | trace DB `event="closed"` 行に deliverable を列追加するか | **しない（見送り）** | 既存 DB スキーマの破壊的変更を伴う。`task-state.json` が source of truth で、trace DB は補助的な session トレース。必要になったら別タスクで対応 |
| DL-05 | `formatDeliverable` の配置 | **`task.ts` に同居** | `TaskState` と同じファイルに置くほうが参照が自然。新規ファイル作成は task.md の「新規作成なし」方針と整合 |
| DL-06 | 既存の対象外型エラー 3 件（conductor.ts / daemon.ts / daemon.test.ts）をこのタスクで修正するか | **しない** | T295 のスコープ外。Inspector 向けに `impl-report` で touched-files zero-errors 例外として明記する運用で処理 |
| DL-07 | `--pr-url` の URL 形式検証 | **しない（zod は `z.string()` のみ）** | URL regex は overfit。GitHub Enterprise や将来の別 forge 対応で誤拒否する risk のほうが高い。schema level は `z.string()` で緩く、CLI level で入力があれば受ける |
| DL-08 | `show-task` サブコマンドを新設するか | **しない（`trace-task` に統合）** | task.md に「cmdShowTask」と書かれているが、現在 `show-task` は未実装（CLI から呼べない）。新設は別タスクで。本タスクは `trace-task` に Deliverable 行を追加し、機械可読性の目的は達成する |
| DL-09 | kind 省略時の error メッセージ形式 | **`Error: --deliverable-kind is required (one of: files, merged, pr, none)` + 新仕様 help の自動表示** | `requireArg` の既存 error 形式と統一しつつ、enum 値を併記することで補足不要化 |
| DL-10 | deliverable の `files` 配列に対する path 存在検証 | **しない** | worktree 削除後に close-task が呼ばれるケースがあり、`fs.statSync` で検証すると余分な fail になる。path 文字列として残すだけ |

---

## 8. 実装順序まとめ

```
S1 (schema.ts) → S2 (task.ts 型 + format) → S3 (main.ts CLI) →
  ├→ S4 (daemon.ts auto-close)
  ├→ S5 (i18n.ts help)
  ├→ S6 (dashboard 伝播+表示)
  └→ S7 (trace-task Deliverable 行)
→ S8 (Conductor テンプレ ja/en) → S9 (docs/spec + CLAUDE.md)
→ S10 (tests) → S11 (検証 + CHANGELOG)
```

S4〜S7 は互いに独立なので同時並行でも良いが、Implementer の作業順としては **S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11** の直列を推奨。S8（6 ファイルのテンプレ書き換え）は最も目視確認が多いため、テンプレ作業中に CLI 仕様を再度動かすのは避けたい。

---

## 9. 納品形態

task.md 指示通り、**ローカル feature ブランチを main に ff-only マージ**（merged kind）。

ただし:
- Conductor 自身のテンプレを書き換えるため、Step 8 の rebase 検証と Step 9 の ff-only マージ検証を丁寧に行うこと
- リリース後に各 Conductor ペインで `/clear` を実行してもらう旨を CHANGELOG に明記（CHANGELOG L78 T274 の前例と同じ流儀）
