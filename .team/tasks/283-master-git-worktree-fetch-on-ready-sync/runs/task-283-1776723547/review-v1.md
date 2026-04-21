# T283 Design Review v1

レビュー対象: `.team/tasks/283-master-git-worktree-fetch-on-ready-sync/runs/task-283-1776723547/plan.md`
レビュー担当: design-reviewer
レビュー日時: 2026-04-21

## Verdict: Changes Requested

## Summary

構造的解決として `SyncState` enum + pure function 分離（`git-sync.ts`）を採用する方針は妥当で、既存パターン（`resolveAutoUpdateMode` / `resolveWorktreeBase` / `MainBranchResolutionError`）との整合性も取れている。ただし **ST8 の「Conductor spawn env 注入で Agent もカバーする」という設計前提が cmux の実装と一致しておらず、Agent（implementer 等）が `--status ready` で cleanup task を起票する経路で false reject が発生しうる**。また、完了条件 (2) の literal ログ形式（`fetch_before_worktree=on source=default`）と ST5 の実装形式（`fetch_before_worktree enabled=on source=default`）に乖離がある。上記 2 件は実装前に plan.md で合意すべき事項のため Changes Requested とする。

## Findings

### 1. [CRITICAL] ST8 の env 継承前提が実装と一致していない — Agent の `--status ready` 経路が未保護

**問題:**

plan.md ST8 の Risk 表（§ 5）で以下の主張がある:

> Conductor 配下の Agent から create-task する経路 … ST8 で Conductor spawn 時に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を env 注入。**Agent は Conductor の子で env 継承するため同時に skip される**。

しかし cmux の実装上、Agent は Conductor の子プロセスではない。`cmdSpawnAgent`（`skills/cmux-team/manager/main.ts:2198`）は以下の手順で Agent を起動する:

1. `cmux.newSurface(targetPane)` で **新しい cmux surface（独立 shell）** を作成（main.ts:2286）
2. その新規 surface に `cmux.send(surface, \`export ROLE=... PROJECT_ROOT=... CMUX_SURFACE=... CMUX_NO_RENAME_TAB=1 CMUX_CLAUDE_HOOKS_DISABLED=1\`\n)` で **明示的に列挙した env のみ** を焼き付ける（main.ts:2323-2336）
3. 続いて `claude --dangerously-skip-permissions ...` を `cmux.send` で起動

ここで **Agent の shell env は cmdSpawnAgent が列挙した 5〜7 個の変数だけ** で構成され、親の Conductor shell の env（ST8 で追加する `CMUX_TEAM_SKIP_SYNC_CHECK=1` を含む）は継承されない。`cmdSpawnAgent` 自身は Conductor shell の子プロセスなので `process.env.CMUX_TEAM_SKIP_SYNC_CHECK` は持っているが、それを Agent shell に forward する経路が存在しない。

**実害シナリオ:**

`skills/cmux-team/templates/ja/implementer.md:77-81` は implementer Agent に対して次を明示している:

```bash
cmux-team create-task \
  --title "cleanup: <元タスク名> で発見した既存型エラー修正" \
  --depends-on <current-task-id> \
  --status ready \
  --body "..."
```

implementer が cleanup task を起票する瞬間に sync check が走り、main project で別タスクの Master/Conductor が編集中で `uncommitted` state だった場合、**false reject（exit 1）で cleanup task 起票が失敗する**。`CMUX_TEAM_SKIP_SYNC_CHECK` が Agent shell に伝わらないため、ST8 の「Conductor 経路はデフォルトで skip」の設計意図が Agent 経路には反映されない。

なお Agent が `PROJECT_ROOT` 経由で main project のパスを解決するため、check の対象は worktree ではなく main project の HEAD になる（plan.md の「worktree 内の HEAD 状態で動作」という説明も不正確）。ただし main project が dirty 状態になる scenario は Master 稼働中には十分あり得るので、false reject の実害自体は発生する。

**要求修正（ST8 改訂案）:**

plan.md ST8 を以下のいずれかに書き換える:

- **案 A（推奨）:** `cmdSpawnAgent` の `exportVars`（main.ts:2323-2329）にも `CMUX_TEAM_SKIP_SYNC_CHECK=1` を無条件で追加する。Agent は worktree 配下で作業する立場であり、ready 昇格ガードの責任を負うべきではないため「常に skip」が意味的に正しい。
- **案 B:** `cmdSpawnAgent` で `if (process.env.CMUX_TEAM_SKIP_SYNC_CHECK) exportVars.push("CMUX_TEAM_SKIP_SYNC_CHECK=1");` のように親 shell からの明示 forward を追加。ただし「Conductor が常に注入 + Agent が継承」という 2 段構えになり、どちらかが壊れると検出しづらくなる。案 A のほうが SSOT 的に堅い。

合わせて Risk 表の「Agent は Conductor の子で env 継承する」という文言は削除し、Agent は独立 shell であるため明示注入が必要である旨に書き換える。

**検証コマンド:**

修正後は `grep "CMUX_TEAM_SKIP_SYNC_CHECK" skills/cmux-team/manager/main.ts` が cmdSpawnAgent 内にも存在することを確認する。

---

### 2. [MAJOR] ログ形式が完了条件 (2) の literal と乖離

**問題:**

タスク本文の完了条件 (2):

> `cmux-team start` 実行時のログに `fetch_before_worktree=on source=default`

一方 plan.md ST5 の実装:

```typescript
await log(
  "fetch_before_worktree",
  `enabled=${fetchPolicy.enabled ? "on" : "off"} source=${fetchPolicy.source}`,
);
```

ログ format（CLAUDE.md ロギングポリシー §）は `[timestamp] event_name key1=value1 key2=value2` なので、上記の実装が吐く行は:

```
[2026-04-21T...] fetch_before_worktree enabled=on source=default
```

となり、完了条件の literal `fetch_before_worktree=on source=default` を **含まない**（`fetch_before_worktree` と `on` の間が `=` ではなく space）。完了条件の literal 検証を `grep "fetch_before_worktree=on source=default" .team/logs/manager.log` で行うと通らない。

**要求修正:**

いずれかで整合を取る（plan.md § 9 の完了条件チェックリストと整合させる）:

- **案 A:** 完了条件の literal に合わせ `log("cmdstart_config", \`fetch_before_worktree=${enabled ? "on" : "off"} source=${source}\`)` のように key を `fetch_before_worktree` 自体にする（event 名は `cmdstart_config` 等の包括的なもの。または `auto_update_config` と並べる形で `fetch_before_worktree_config`）
- **案 B:** plan.md § 9 チェックリスト行を「ログに `event=fetch_before_worktree enabled=on source=default` が出る」と書き換え、タスク本文の spec 解釈をドキュメントで補足する。ただし task 本文は動かせないため最小限 plan.md § 9 に「spec の `fetch_before_worktree=on` は `fetch_before_worktree enabled=on` として emit する（既存 `auto_update_config mode=... source=...` パターンと揃えるため）」と明記する

既存 `auto_update_config` との一貫性を取るなら案 B が自然だが、完了条件 (2) の literal 検証が plan.md 上で明示されていないので、明示が必要。

---

### 3. [MINOR] ST7 の行番号指摘ミス

plan.md ST7 は以下:

> **処理順**: **L2833** の `if (newStatus === "ready")` 直前に sync check を追加。

実コード（`skills/cmux-team/manager/main.ts`）:

- L2833: `if (newStatus !== undefined) {`  ← ここは `newStatus` 有無の分岐
- L2838: `if (newStatus === "ready") {`  ← こちらが plan の意図する行

**要求修正:** 行番号を L2838 に訂正するか、「`if (newStatus === "ready")` 直前（現 L2838）」と明示する。実装時の迷いを防ぐため。

---

### 4. [MINOR] docs/spec/01-skill-cmux-team.md に Master の「git 操作」に関する個別記述がない

plan.md ST13 は以下を挙げる:

> `docs/spec/01-skill-cmux-team.md` Master ロール記述を同期

しかし実ファイルを `grep "git 操作"` で探しても L33 の Master 概説（「真のソース直接参照で進捗報告」等）しか無く、「やらないこと」レベルの具体的なポリシーは `docs/spec/04-templates.md:91` に集約されている。ST13 の対象として 01-skill-cmux-team.md を列挙する必要があるかは要判断。

**要求修正:** ST13 を次のいずれかに明確化する:

- **案 A:** 01-skill-cmux-team.md は対象外。Master ポリシーの仕様源は `templates/ja/master.md`（ST11）と `docs/spec/04-templates.md:91`（ST13）に集約し、01-skill-cmux-team.md は touch しない
- **案 B:** 01-skill-cmux-team.md L33 に「git 読み取り・fetch/pull は自由、破壊的操作は禁止」という 1 行サマリを追加する旨を明記

実装者がどちらに倒すか迷わないよう plan.md で判断を確定しておくこと。

---

### 5. [MINOR] `decideSyncState` の headStatus="on-other-branch" のときの挙動が未明記

plan.md § 2 の `SyncFacts` interface は `headStatus: "on-main" | "on-other-branch" | "detached"` を持つが、§ 8 (ポリシーテーブル) の 7 state には `on-other-branch` が登場しない。

想定挙動（レビュー側の推測）:

- `headStatus === "detached"` → `detached` state を即返す
- `hasUncommittedOnMain === true`（= on-main AND dirty）→ `uncommitted`
- それ以外（on-main でクリーン、または on-other-branch）は SHA 比較で `clean` / `ahead` / `behind-ff` / `diverged` / `no-remote` を決定

この順序の妥当性と、`on-other-branch` で `hasUncommittedOnMain` が常に false（on-main ではないから）である条件が plan.md に明記されていない。`decideSyncState` の exhaustive switch で `on-other-branch` 入力も受け付ける旨を型とテストケースで担保する必要がある。

**要求修正:** ST1 の完了条件に以下を追加:

- 「`headStatus === "on-other-branch"` のとき `hasUncommittedOnMain` は false として扱う（on-main でなければ dirty 判定しない）」
- ST2 のテストケースに「`on-other-branch` + clean SHA 一致 → clean を返す」「`on-other-branch` + local ahead → ahead を返す」を追加

---

### 6. [MINOR] `classifyVerdict` の signature 重複シグネチャ

plan.md § 2 は以下を示す:

```typescript
export function classifyVerdict(state: SyncState, facts: SyncFacts): Verdict { ... }
```

しかし下の `Verdict` 型定義では `state: SyncState` が Verdict に含まれる:

```typescript
export type Verdict =
  | { kind: "allow"; state: SyncState }
  | { kind: "warn";  state: SyncState; message: string }
  | ...
```

`classifyVerdict(state, facts)` から state を取り出して Verdict に詰め直す形になるが、`facts` 引数が実際に必要かは message 生成に `mainBranch` 等を含めるかで決まる。message に推奨コマンド（`git pull --rebase origin <mainBranch>` 等）を含めるためには facts.mainBranch が必要なので引数は合理的。ただし plan.md で「`classifyVerdict` は facts から mainBranch を読み message に埋め込む」と明記されていないため、実装者が signature を読み違えるリスクがある。

**要求修正（任意）:** plan.md § 2 のコードブロックにコメントで `// facts.mainBranch をメッセージに使う` と追記。

---

## CRITICAL チェック項目（レビュー観点 § 6）

| 項目 | 判定 | 備考 |
|------|------|------|
| サブタスクカバレッジ | **部分合格** | ST1〜ST15 が plan.md の新規/変更/docs を網羅。ただし Finding 1 に示すとおり Agent spawn 経路の env 注入がカバーから漏れている（ST8 の範囲外）。実装時に cmdSpawnAgent 修正が明示タスクに入っていないため再分割が必要 |
| 統合テスト/検証 | 合格 | ST15 の手動検証シナリオ 1-10 がカバー。ただし Finding 1 の指摘どおり Agent 経路の検証（Conductor 配下の implementer が worktree から `--status ready` で create-task した場合に skip される）がシナリオ 10 でカバーされているか明示されていない |
| 削除タスクの完全性 | 合格 | 削除なし。Master テンプレートの `git 操作` 行削除は ST11 に含まれる |
| 既存テストへの影響 | 合格 | `worktree-base.test.ts` は今回 touch しないと plan.md § 5 で明示 |

## 仕様整合性（レビュー観点 § 7）

| 項目 | 判定 | 備考 |
|------|------|------|
| 完了条件 1-6 のサブタスク紐付け | 合格 | plan.md § 9 のチェックリストで紐付け済み |
| 7 state の判定が仕様通り | 合格（軽微補足あり） | Finding 5 の通り on-other-branch 入力の扱いを明記すべき |
| Conductor 内部からの create-task 救済経路 | **不合格（Finding 1）** | Conductor 自身は ST8 で救済されるが Agent は救済されない |

## 既存コード実在性チェック（レビュー観点 § 8）

| plan.md の参照 | 実在性 | 確認結果 |
|----------------|--------|----------|
| `worktree-base.ts:35` `resolveWorktreeBase` | ✅ 実在 | L35 に `export async function resolveWorktreeBase(` あり |
| `conductor.ts:350` `CMUX_TEAM_FETCH_BEFORE_WORKTREE` | ✅ 実在 | L350 `doFetch: process.env.CMUX_TEAM_FETCH_BEFORE_WORKTREE === "1",` あり |
| `main.ts` `cmdCreateTask` L2703 | ✅ 実在 | `async function cmdCreateTask(): Promise<void> {` が L2703 |
| `main.ts` `cmdUpdateTask` L2766 | ✅ 実在 | `async function cmdUpdateTask(): Promise<void> {` が L2766 |
| `main.ts` `cmdStart` L338 | ✅ 実在 | `async function cmdStart(): Promise<void> {` が L338 |
| `main.ts` `auto_update_config` 直後 L502-505 | ✅ 実在 | `await log("auto_update_config", ...)` が L502 |
| `config.ts` `resolveAutoUpdateMode` | ✅ 実在 | L80 に `export function resolveAutoUpdateMode(` あり |
| `i18n.ts` `help_create_task` ja L294 / en L962 | ✅ 実在 | `grep "^  help_create_task"` で L294 / L962 |
| `i18n.ts` `help_update_task` ja L332 / en L1001 | ✅ 実在 | `grep "^  help_update_task"` で L332 / L1001 |
| `templates/ja/master.md` 「やらないこと（基本方針）」L19-61 | ✅ 実在 | L19 が該当ブロック。L26 に `- git 操作（commit, branch, merge 等）` 一行あり |
| `main.ts` `createTaskProgrammatic` L4049 | ✅ 実在 | `cmdSelfUpdate` 内の L4049 に直接呼び出しあり |
| `main.ts` `hasFlag` L132 | ✅ 実在 | `function hasFlag(name: string)` が L132 |
| `main.ts` close-task `--force` L2872 | ✅ 実在 | `const force = args.includes("--force");` が L2872 |
| CLAUDE.md L725 `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` | ✅ 実在 | L725 に「**環境変数 `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1`** を設定すると…デフォルトは OFF」 |
| CLAUDE.md 「通信プロトコル」L588 | ✅ 実在 | L588 が `## 通信プロトコル`、次セクションは L628 `## チーム状態管理` |
| docs/spec/05-install-and-infrastructure.md L424 | ✅ 実在 | L424 の `mainBranch` 項目の末尾に `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1 で事前 fetch を opt-in できる` |
| docs/spec/04-templates.md L91 | ✅ 実在 | L91 に `やらないこと（デフォルト）: 実装・… git 操作（commit, branch, merge 等）` |
| docs/spec/01-skill-cmux-team.md Master ロール記述 | △ 該当部あり | L33 に Master 概説あり。ただし「git 操作」の具体的記述は無く、Finding 4 のとおり ST13 で何を変えるか明確化が必要 |

主要な参照先は全て実在し、plan.md の「変更対象」の行番号・関数名・ファイルパスとコードベースが一致している（ST7 の L2833 と実際の L2838 の軽微な齟齬は Finding 3 で指摘済み）。

## 設計原則チェック（レビュー観点 § 1〜5）

| 観点 | 判定 | 備考 |
|------|------|------|
| 根本対策 / 構造的解決 | 合格 | enum + pure function 分離（collect/decide/classify）で exhaustive switch を効かせる設計。局所的な if/else 回避を明示している（§ 2「代替案と却下理由」） |
| AI の手抜き防止 | 合格 | `worktree-base.ts` に if 足す案を却下し責務分離を選択（§ 2 代替案 2）。妥協の痕跡なし |
| DRY / SSOT | 合格 | `runSyncCheckOrExit` で cmdCreateTask / cmdUpdateTask を共通化（ST7 D1）。テンプレートは SoT 原則を明示（ST11 注意書き） |
| セキュリティ | 合格 | `execFile("git", args)` で shell を通さずコマンド注入を避ける（`worktree-base.ts:54-61` と同一パターン）。state message に外部入力を直接埋めない。パス traversal のリスク箇所なし |
| 既存パターンとの整合性 | 合格 | `resolveAutoUpdateMode` / `MainBranchResolutionError` / `close-task --force` と整合（§ 2「既存パターンとの整合性」に明記） |

## Recommendations

### 最優先（Changes Requested 解除に必要）

1. **Finding 1 の解消:** ST8 を以下の形に書き換え、cmdSpawnAgent の exportVars に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を加える修正を明示タスクとして追加する。あわせて § 5 リスク表の「Agent は Conductor の子で env 継承する」という記述を「Agent は独立 cmux surface で動くため cmdSpawnAgent 側でも明示注入が必要」に修正する。
   - 新 ST8a: `launchConductor` の shell 初期化 export 行（conductor.ts:105）に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を追記
   - 新 ST8b: `cmdSpawnAgent` の exportVars 配列（main.ts:2323-2329）に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を追記
   - ST15 (10) を「Agent (implementer) から worktree 配下で `--status ready` の cleanup task 起票 → sync check が skip され main が uncommitted でも成功する」というシナリオに書き換える
2. **Finding 2 の解消:** ST5 のログ形式と完了条件 (2) の literal を一致させる。`event=fetch_before_worktree enabled=on source=default` 形式を維持するなら plan.md § 9 の完了条件チェックリスト行を「ログに `fetch_before_worktree enabled=on source=default` が出る（spec の `fetch_before_worktree=on` は `enabled=on` として emit する既存パターンに準拠）」と明示。ないし ST5 の detail を `fetch_before_worktree=on source=default` に倒す。

### 次点（実装時に迷いを減らす小修正）

3. **Finding 3:** ST7 の行番号を L2833 → L2838 に訂正する（または「`if (newStatus === "ready")` 直前」という記述のみにする）。
4. **Finding 4:** ST13 で 01-skill-cmux-team.md を対象にするかしないかを確定する。
5. **Finding 5:** ST1 の完了条件に「`headStatus === "on-other-branch"` の入力パスも exhaustive に扱う」を追加し、ST2 のテストケースに該当ケースを加える。
6. **Finding 6（任意）:** § 2 の `classifyVerdict` 定義にコメントで `facts.mainBranch` を使う旨を補足。

### 改善提案（Approved 後に考慮してもよい）

- ST8 の env 注入 approach は機能するが、将来「CLI 呼び出し元のロール（Master / Conductor / Agent）を daemon 側から判定して自動的に skip/強制する」方式の検討余地がある。ただし今回のスコープ外。
- `checkSyncState` の git 呼び出しタイムアウト（30s）は `worktree-base.ts` の 30s と揃えているが、`CMUX_TEAM_FETCH_BEFORE_WORKTREE` のタイムアウトと独立した env で上書き可能にするかは将来検討。今回は plan で触れなくてよい。
- plan.md § 6 の「既存型エラーの先読み」コマンド（`bunx tsc --noEmit`）は長時間かかる可能性があるため、implementer 側で `--noEmit --skipLibCheck` や touched files 限定で絞る工夫が後続で入ると望ましい（plan では触れなくてよい）。

---

以上。Finding 1 / 2 を plan.md に反映いただいた上で再レビューすれば Approved に移行する見込み。
