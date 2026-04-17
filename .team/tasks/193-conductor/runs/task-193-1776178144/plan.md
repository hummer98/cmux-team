# T193 実装計画: Conductor 初期プロンプト削除 + タブ名を役割固定化

## 1. 作業の全体像

### 目的
1. **Conductor 起動時の初期プロンプト投入を廃止する**
   Conductor スロットは `claude` 起動直後に待機文言（`conductor_wait_prompt`）をチャット入力として受け取っており、ユーザーメッセージとして消費されてしまっている。タスクを持たない待機起動では何もプロンプトを送らず、純粋に `❯` 待ちにする。
2. **cmux タブ名を `[<num>] <役割>` の 4 種に固定化する**
   タブ名は現状 `♦`・タスク ID・タイトル・状態（idle / running / taskTitle）が混在しており、実行中に頻繁に書き換わる。これを `[<num>] Master` / `[<num>] Manager` / `[<num>] Conductor` / `[<num>] Agent` の 4 種に固定する。タスク状態はログ（T192: `C[665]>A[719]`）・ダッシュボード・`team.json` から取得できるため、タブ名にタスク情報を載せる必要はない。

### 変更しないもの
- `master.ts:35`（`[${num}] Master`）はそのまま。
- `main.ts:512`（`[${num}] Manager`）はそのまま。
- `logger.ts` の `formatSurface` による `C[665]` / `A[719]` ロール表記（T192）は維持。タブ名とログ表記は別系統。
- `CMUX_NO_RENAME_TAB=1` 環境変数（既に設定済み）による Claude 側自動 rename 抑止。
- `dashboard.tsx:527` の `roleIcons`（ダッシュボード独自の表示、今回の変更対象外）。
- `statusline.sh` の `♦` アイコン（statusline 表示用、タブ名とは別系統）。
- テンプレート `skills/cmux-team/templates/*.md` には触らない（変更は `main.ts` の `claudeArgs` 組み立てだけ）。
- `taskTitle` を ConductorState に保持する仕組み（ダッシュボード・statusline.sh・team.json が参照するため削除しない）。

## 2. 行番号検証と変更点（現コード確認済み）

行番号はすべて現在の worktree (`.worktrees/task-193-1776178144`) で実コード確認済み。タスク指示と完全一致している。

### 2-1. `skills/cmux-team/manager/main.ts:1244-1248` — Conductor 初期プロンプト削除

**現在のコード**（確認済み、行番号一致）:
```ts
1242	  claudeArgs.push("--session-id", sessionId);
1243
1244	  // 初期プロンプトを決定
1245	  const initialPrompt = taskPromptFile
1246	    ? `${taskPromptFile} を読んで指示に従って作業してください。`
1247	    : t("conductor_wait_prompt");
1248	  claudeArgs.push(initialPrompt);
1249
1250	  // claude を exec（プロセスを置換）
```

**変更後**:
```ts
  claudeArgs.push("--session-id", sessionId);

  // 初期プロンプトを決定
  //   taskPromptFile 指定時のみチャット入力として push する。
  //   未指定（通常の待機起動）は何も push せず、Claude は純粋に ❯ で待機する。
  if (taskPromptFile) {
    claudeArgs.push(`${taskPromptFile} を読んで指示に従って作業してください。`);
  }

  // claude を exec（プロセスを置換）
```

### 2-2. `skills/cmux-team/manager/i18n.ts:67-69 / 590-592` — 未使用 i18n エントリ削除

**依存チェック（実施済み）**: `rg "conductor_wait_prompt"` の結果 —
- `skills/cmux-team/manager/i18n.ts:68`（en 定義）
- `skills/cmux-team/manager/i18n.ts:591`（ja 定義）
- `skills/cmux-team/manager/main.ts:1247`（唯一の使用箇所、2-1 で削除）
- `.team/tasks/132-conductor-session-id-resume/runs/task-132-1775829890/plan.md:116`（過去の plan.md、コードではない）

→ `main.ts` の呼び出しを消せば i18n.ts の 2 エントリは完全に未使用になるので削除する。

**i18n.ts:67-69（英語）** を削除:
```ts
  // ── Conductor 待機プロンプト ───────────────────────────────────────────────────
  conductor_wait_prompt:
    "You are a Conductor slot. Wait at the ❯ prompt without doing anything until the Manager assigns a task via /clear + prompt. Do NOT search, read, or execute any tasks.",
```

**i18n.ts:590-592（日本語）** を削除:
```ts
  // ── Conductor 待機プロンプト ───────────────────────────────────────────────────
  conductor_wait_prompt:
    "あなたは Conductor スロットです。Manager が /clear + プロンプト送信でタスクを割り当てるまで、何もせず ❯ プロンプトで待機してください。タスクの検索・読み取り・実行は一切行わないこと。",
```

コメント行（`// ── Conductor 待機プロンプト ──...`）も不要になるので同時に削除。

### 2-3. `skills/cmux-team/manager/conductor.ts:146-149` — launchConductor の idle タブ名

**現在のコード**（行番号一致）:
```ts
142	  // 4. タブ名設定
143	  //    resume 時はタブ名を呼び出し元（initializeLayout / main.ts）が
144	  //    `[N] ♦ T<id> <title>` に rename するため、ここでは idle を付けず何もしない。
145	  //    （二重 rename を避ける — plan/design-review で確認済み）
146	  if (!opts?.resumeTaskId) {
147	    const num = surface.replace("surface:", "");
148	    await cmux.renameTab(surface, `[${num}] ♦ idle`);
149	  }
```

**変更後**:
```ts
  // 4. タブ名設定
  //    resume / 新規問わず `[N] Conductor` を設定する。
  //    T193 でタブ名はロール固定表記にしたため、後続で assign/reset 時に
  //    rename する必要はなく、ここで一度だけ設定すれば十分。
  const num = surface.replace("surface:", "");
  await cmux.renameTab(surface, `[${num}] Conductor`);
```

※ `if (!opts?.resumeTaskId)` ガードは不要になる。`main.ts:615-617`（2-5）の resume 時の二重 rename 行も一緒に削除するため、二重 rename 問題は発生しない。

### 2-4. `skills/cmux-team/manager/conductor.ts:445-454` — assignTask の rename 削除

**現在のコード**（行番号一致）:
```ts
445	    // --- 5. タブ名更新（失敗しても task は継続）---
446	    // renameTab は表示用の冪等な後処理。catch-all に捕まって task abort
447	    // されると実害の無い失敗でタスクが吹き飛ぶため、個別に握りつぶす。
448	    const num = conductor.surface.replace("surface:", "");
449	    const shortTitle = taskTitle.length > 30 ? taskTitle.slice(0, 30) + "…" : taskTitle;
450	    try {
451	      await cmux.renameTab(conductor.surface, `[${num}] ♦ T${taskId} ${shortTitle}`);
452	    } catch (e: any) {
453	      await log("error", `renameTab failed: ${formatSurface(conductor.surface, "C")} ${e.message}`);
454	    }
```

**変更後**: ブロック全体（445-454、コメント含む）を削除。起動時に設定した `[${num}] Conductor` のままとする。

削除に伴い:
- ローカル変数 `num` / `shortTitle` は assignTask 内の他で参照されていない（同 scope）ので削除可。
- `taskTitle` は assignTask 内で他の用途（`conductor.taskTitle = taskTitle`（477）, ログ（488））に使われるので残す。

### 2-5. `skills/cmux-team/manager/conductor.ts:559-561` — resetConductor の idle rename 削除

**現在のコード**（行番号一致）:
```ts
559	    // 3. タブ名をリセット
560	    const num = conductor.surface.replace("surface:", "");
561	    await cmux.renameTab(conductor.surface, `[${num}] ♦ idle`);
```

**変更後**: 3 行まとめて削除。タブ名は launchConductor 時に設定した `[${num}] Conductor` のままで、reset 時に触る必要はない。後続の `// 4. ConductorState リセット` 以降はそのまま。

### 2-6. `skills/cmux-team/manager/main.ts:614-617` — initializeLayout の resume rename 削除

**現在のコード**（行番号一致）:
```ts
613	    c.agents = [];
614
615	    const num = c.surface.replace("surface:", "");
616	    const shortTitle = (c.taskTitle ?? "").slice(0, 30);
617	    await cmux.renameTab(c.surface, `[${num}] ♦ T${r.taskId} ${shortTitle}`).catch(() => {});
```

**変更後**: 615-617 の 3 行を削除。launchConductor が resume 経路でも `[${num}] Conductor` を設定済み（2-3）になるため、ここでの上書きは不要。

注意: 上の「タスクタイトルを取得（renameTab 用）」のループ（576-585）は **そのまま残す**。`c.taskTitle = r.taskTitle`（610）→ ダッシュボード・statusline.sh・team.json が参照するため、taskTitle の取得自体は引き続き必要。コメントだけ更新する（`renameTab 用` → `ダッシュボード/team.json 用`）。

### 2-7. `skills/cmux-team/manager/main.ts:1546-1562` — cmdSpawnAgent のタブ名

**現在のコード**（行番号一致）:
```ts
1546	  // --- 4. タブ名設定 ---
1547	  const roleIcons: Record<string, string> = {
1548	    researcher: "🔍", research: "🔍",
1549	    architect: "📐", design: "📐",
1550	    implementer: "⚙", impl: "⚙",
1551	    reviewer: "👀", review: "👀",
1552	    tester: "🧪", test: "🧪",
1553	    dockeeper: "📝", docs: "📝",
1554	    "task-manager": "📋",
1555	  };
1556	  const roleIcon = roleIcons[role] ?? "▸";
1557	  const num = surface.replace("surface:", "");
1558	  const shortTitle = taskTitle
1559	    ? (taskTitle.length > 25 ? taskTitle.slice(0, 25) + "…" : taskTitle)
1560	    : "";
1561	  const tabName = shortTitle ? `[${num}] ${roleIcon} ${shortTitle}` : `[${num}] ${roleIcon} ${role}`;
1562	  await cmux.renameTab(surface, tabName);
```

**変更後**:
```ts
  // --- 4. タブ名設定 ---
  const num = surface.replace("surface:", "");
  await cmux.renameTab(surface, `[${num}] Agent`);
```

削除される変数: `roleIcons`, `roleIcon`, `shortTitle`, `tabName`。いずれも cmdSpawnAgent 内でタブ名設定以外では使われていない（`taskTitle` 自体は後続の `AGENT_SPAWNED` postMessage / team.json lookup で参照されるため残る）。

### 2-8. `dashboard.tsx:527` の `roleIcons` は変更しない

`dashboard.tsx:527-535` にも `roleIcons` があるが、これはダッシュボードのエージェント表示で使われており、タブ名とは無関係。**今回の変更対象外**（指示表を読むと該当していない）。

## 3. 作業順序

以下の順で編集する。コード整合性の観点から、`launchConductor` が `[${num}] Conductor` を設定する変更（3）を先に入れると、後続の rename 削除（4, 5, 6）で「一時的に `[${num}] Conductor` になる」だけで済む（順序逆でも最終状態は同じだが、review 時のコミット単位として扱いやすい）。

1. **依存確認** — `rg` で以下を事前チェック（詳細は §4）:
   - `rg "conductor_wait_prompt" skills/ .team/ 2>/dev/null` （main.ts 以外での使用なしを確認 ✓ 実施済み）
   - `rg "roleIcons|roleIcon\b|shortTitle" skills/cmux-team/manager` （削除対象外で使われていないことを確認 ✓ 実施済み）
2. **`main.ts:1244-1248`** — Conductor 初期プロンプト削除（2-1）
3. **`i18n.ts:67-69 / 590-592`** — `conductor_wait_prompt` 削除（2-2）
4. **`conductor.ts:142-149`** — launchConductor の idle 削除、`[${num}] Conductor` 固定（2-3）
5. **`conductor.ts:445-454`** — assignTask の rename ブロック削除（2-4）
6. **`conductor.ts:559-561`** — resetConductor の rename 削除（2-5）
7. **`main.ts:614-617`** — initializeLayout の resume rename 削除（2-6、コメント 576 の文言も軽く更新）
8. **`main.ts:1546-1562`** — cmdSpawnAgent のタブ名 `[${num}] Agent` 化 + 関連変数削除（2-7）
9. **型チェック** — `cd skills/cmux-team/manager && bunx tsc --noEmit`
10. **目視動作確認** — §5 に記載

## 4. 依存関係の事前確認

実装時に以下の `rg` を（念のため）再実行し、削除対象が他で参照されていないことを確認する。計画立案時点ではすべて実施済み。

```bash
# (a) conductor_wait_prompt が i18n.ts と main.ts:1247 以外で使われていないか
rg "conductor_wait_prompt" skills/cmux-team/manager

# (b) roleIcons / roleIcon / shortTitle が削除対象行以外で使われていないか
rg "roleIcons|roleIcon\b|shortTitle" skills/cmux-team/manager

# (c) renameTab の呼び出し箇所を俯瞰（Master/Manager はそのまま、C/A の 5 箇所を編集対象）
rg "renameTab" skills/cmux-team/manager
```

### 実測結果（実施済み）

- **conductor_wait_prompt**:
  - `i18n.ts:68` / `i18n.ts:591` / `main.ts:1247`（削除対象）
  - `.team/tasks/132-.../plan.md:116`（過去の plan.md、コードではない）
  - ⇒ 削除して問題なし
- **roleIcons / roleIcon / shortTitle**:
  - `main.ts:616-617`（2-6 で削除予定）
  - `main.ts:1547-1561`（2-7 で削除予定）
  - `conductor.ts:449-451`（2-4 で削除予定）
  - `dashboard.tsx:527-535`（独立した roleIcons、**今回触らない**）
  - ⇒ 削除対象外での漏れ参照はなし
- **renameTab** 呼び出し:
  - `cmux.ts:110`（定義）— 変更不要
  - `master.ts:35`（`[${num}] Master`）— 変更不要
  - `main.ts:512`（`[${num}] Manager`）— 変更不要
  - `conductor.ts:148` — §2-3 で編集
  - `conductor.ts:451` — §2-4 で削除
  - `conductor.ts:561` — §2-5 で削除
  - `main.ts:617` — §2-6 で削除
  - `main.ts:1562` — §2-7 で編集

### taskTitle 参照
`taskTitle` は ConductorState・dashboard・statusline・team.json で使われている（§2-6 参照）。タブ名から外すだけであり、ConductorState への保持は維持する。dashboard.tsx / statusline.sh には一切触らない。

## 5. 検証方法

### 5-1. 静的チェック

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-193-1776178144/skills/cmux-team/manager
bunx tsc --noEmit
```

未定義参照（削除した `shortTitle` / `roleIcon` / `roleIcons` / `t("conductor_wait_prompt")` の残存）や型エラーがないこと。

### 5-2. テスト

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-193-1776178144/skills/cmux-team/manager
bun test
```

`daemon.test.ts` が `taskTitle` を使っているが（テストフィクスチャとして）、タブ名固定化の変更はテストに影響しない見込み。万一失敗した場合はログで原因確認。

### 5-3. 目視動作確認（E2E、実装後にユーザーが実施する想定）

`cmux-team start` を実行し、以下を確認する（実装者は plan.md の段階では実施しない）:

1. **Conductor 起動直後**: ペインに「You are a Conductor slot...」のような文言が**表示されず**、純粋な `❯` プロンプト待ちになっていること
2. **タブ名**: 起動直後のタブ名が
   - `[xxx] Master`
   - `[xxx] Manager`
   - `[xxx] Conductor` × N
   のみで表示されること
3. **タスク割当中**: `cmux-team create-task` でタスクを流し、Conductor にアサインされている最中もタブ名が `[xxx] Conductor` のまま変化しないこと
4. **完了後**: タスク完了後にタブ名が `[xxx] Conductor` のまま（reset で余計な rename が走らない）
5. **Agent spawn**: Conductor がサブエージェントを起動したときにタブ名が `[xxx] Agent` になること（`[xxx] 🔍 research` 等の旧表記が消えていること）
6. **dashboard / statusline**:
   - `cmux-team status` でタスク情報（taskTitle 含む）が引き続き表示されること
   - ダッシュボード（`bun run dashboard` もしくは `cmux-team` TUI）で `c.taskTitle` が引き続き見えること
7. **resume シナリオ**: assigned 状態のタスクが残った状態で `cmux-team start` を再実行し、resume された Conductor タブが `[xxx] Conductor` として表示され、タスクも正常に復帰すること

## 6. リスク

| リスク | 影響 | 対策 |
|---|---|---|
| `taskTitle` 取得ループ（main.ts:576-585）を誤って削除してしまう | dashboard / team.json の taskTitle が消える | 2-6 では **renameTab 行だけ** 削除し、taskTitle fetch ループ（576-585）と `c.taskTitle = r.taskTitle`（610）は**残す**。コメント文言だけ軽く更新 |
| `conductor_wait_prompt` を削除したあとに `t()` 呼び出しが残っていて型エラーが出る | `bunx tsc --noEmit` で失敗 | §4 の事前 `rg` + 型チェック §5-1 で検出 |
| launchConductor で `opts?.resumeTaskId` ガードを外すと、resume 時に「何か別の rename」と競合する | タブ名が一時的に変な文字列になる | 2-3 と 2-6 を **必ず同一コミットで** 反映。2-6 で resume 時の二重 rename を消すため、2-3 のガード削除は安全。順序注意 |
| cmdSpawnAgent の `roleIcons` を削除すると、ダッシュボード側の roleIcons も壊れそうに見える | - | 両者は**完全に独立**（dashboard.tsx:527 にローカル定義あり）。main.ts 側だけ削除して影響なし。レビュー時に再確認 |
| `CMUX_NO_RENAME_TAB=1` が効かない環境で Claude が勝手にタブ名を書き換える | 固定化の意味が薄れる | タスク指示で「設定済み」とあるため追加作業は不要。実装後の動作確認で見つかったら別タスク化 |
| 旧テンプレ・ランタイム prompt (`.team/prompts/*.md`) に `conductor_wait_prompt` 由来の文字列が残っている | 実害はないが紛らわしい | タスク指示で「テンプレに手を入れる必要はない」と明記されている通り、本タスクのスコープ外 |
| i18n の比較対象（他言語 / 両辞書）で片側だけ消して整合性が崩れる | 型エラー or 実行時エラー | i18n.ts には `TextKey` 型が en/ja を揃えている前提があるため、**必ず両方同時に削除**（§2-2） |
| 過去の assigned タスクが残ったまま start され、タブ名変更の副作用で resume が壊れる | resume 失敗 | resume シナリオ（§5-3 項7）で要動作確認 |

## 7. 補足

- **テンプレート編集なし**: 今回の変更は `main.ts` / `conductor.ts` / `i18n.ts` の 3 ファイルのみ。`skills/cmux-team/templates/*.md` は触らない。
- **ランタイム prompt**: `.team/prompts/*.md` は派生物なので編集しない。
- **ログ表記**: `logger.ts` / `formatSurface` の `C[665]` 表記（T192）はタブ名と独立したまま維持される。
- **CHANGELOG / README**: ユーザー向け仕様変更（タブ名表記）だが、別タスク（ドキュメント同期）で扱う想定。本タスクでは実装と tests のみをスコープに含める。
