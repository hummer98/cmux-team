# Plan: T286 — cmux-team start 自己修復 + stop コマンド廃止 (v2)

> v2 改訂: Design Review 指摘 (Critical #1/#2, Major #3-#6, Minor #7-#12) を反映。`applyDiscardOnly` のログ出力契約 / sequential 実行保証 / resumePlan 透過 を仕様に明記し、M17 を 3 バリアント化、S2 のログ文言を純観測形に確定、CHANGELOG は release skill 前提に変更。

## 1. 課題分析

### 1.1 現状の問題点（KDG-SSO 再現条件）

`~/git/KDG-SSO` で `cmux-team start --layout=16x9` を実行したところ、Conductor が 1 台も起動しないまま `boot_completed` まで到達した。manager.log を解析した結果、以下が確認できた:

```
layout_mismatch_on_resume restored=wide current=16x9 — existing panes will be kept; run 'cmux-team stop' then 'start --layout=16x9' to rebuild
conductor_discarded C[52] reason=surface_missing_no_task
conductor_discarded C[53] reason=surface_missing_no_task
conductor_discarded C[54] reason=surface_missing_no_task
master_spawning
master_spawned U[487]
boot_completed
```

つまり:

1. 前回起動は wide レイアウトで C[52]/C[53]/C[54] の 3 surface が `team.json` に記録されていた
2. 今回 16x9 で再起動したが cmux 側では当該 3 surface が全消失していた（cmux process 自体の終了 → 復元不可）
3. 全 entry が E 経路（`surface_missing_no_task`）で discard された
4. しかし「全 discard 後に新 slot を作る」フォールバック経路が無いため、`state.conductors` が空のまま `boot_completed` に到達した

### 1.2 根本原因（コードレベル）

`skills/cmux-team/manager/daemon.ts:1117-1193` の `initializeLayout` は以下の二分岐構造を取る:

```
team.json が空 (conductorsFromJson.length === 0)
  → 新規 slot 作成パス: initializeConductorSlots を呼ぶ ✓

team.json に entry あり (conductorsFromJson.length > 0)
  → 復帰パス: planLayoutRestore + applyRestorePlan
     → A/B/C/D/E に分類して副作用適用
     → ★ 全件が C/E に倒れた場合に新 slot を作るフォールバックが無い
```

`planLayoutRestore`（`layout-restore.ts`）の出力は 5 つに分類される:

| 経路 | 意味 | state.conductors への登録 |
|---|---|---|
| A `alive` | pid 生存 surface | ✓ |
| B `resumeExisting` | pid 死亡 + surface 実在 + running task | ✓ (resume) |
| C `cleanup` | pid 死亡 + surface 実在 + idle | ✗ (close のみ) |
| D `resumeNewSurface` | surface 消失 + running task | ✗ (R7 で新規分割しない方針 → ready 戻し) |
| E `discarded` | surface 消失 + idle | ✗ (log のみ) |

**KDG-SSO ケースは全 entry が E に倒れたため `state.conductors` ゼロのまま帰ってきた。**

### 1.3 影響範囲

- 「cmux セッションを完全終了 → 後日同 workspace で `cmux-team start` 再投入」のような一般的な復帰シナリオが全滅する
- 「running task が無い idle 状態で、別マシン / 別 workspace 経由で re-attach に失敗」も同症状
- 影響対象: `team.json` に conductor entry が記録済みかつ全 surface が消失している全プロジェクト

### 1.4 stop コマンドに関する別問題

`layout_mismatch_on_resume` のログ文言（`daemon.ts:1135`）が「`cmux-team stop` then `start`」を案内しているが、

- `cmux-team stop` は実運用ではほぼ打たれない（cmux セッションを閉じる方が自然な終了経路）
- そもそも今回の自己修復後は「stop してから start」の手順自体が不要になる
- stop に依存したガイダンスを残し続けることは「stop が正規ルート」という誤解を生む

→ **stop サブコマンド自体を廃止する**ことで、ガイダンス文言・ドキュメントから一斉に消し、「daemon を止めたければ cmux セッションを閉じる / 直接 SIGTERM」を正規ルートに統一する。

## 2. 技術アプローチ

### 2.1 自己修復（メイン修正）

`initializeLayout` で `planLayoutRestore` の結果を観測し、以下 3 つが全て空ならば「team.json は空相当」とみなして `initializeConductorSlots` にフォールバックする:

- `plan.alive`
- `plan.resumeExisting`
- `plan.resumeNewSurface`

`plan.cleanup` / `plan.discarded` のみが非空なケース（= 全 surface が消失 / idle で残骸）はフォールバック対象とする。`plan.cleanup` は side-effect として close-surface を試行するが、これは applyRestorePlan 内で完結するため fallback 経路の前に「discard ログ + cleanup」の副作用だけは流しておく必要がある。

#### 採用する制御フロー（resumePlan 透過を含む）

`plan.unmatchedResumes.length > 0` のケース（team.json 非空 + 全 E + resumePlan に 2 件 unmatched が混在するシナリオ等）は fallback 発動条件から排除していない。fallback 経路でも `resumePlan` をそのまま透過して `initializeConductorSlots` に渡す（team.json 空経路と同一シグネチャ）。`initializeConductorSlots` が panes と 1:1 で分配する仕組みに乗るため、新 slot に resume が正しく割り当てられる（= Major #4 対応）。

```
team.json 空 → initializeConductorSlots(projectRoot, conductors, maxConductors,
                                        daemonSurface, resumePlan, layout, mainBranch)
                (現行通り)

team.json 非空:
  plan = planLayoutRestore(...)
  if (plan.alive.length === 0
      && plan.resumeExisting.length === 0
      && plan.resumeNewSurface.length === 0) {
    // 全 entry が C/E に倒れた → "team.json 空相当" 自己修復
    await log("layout_restore_empty_fallback",
              `kept=0 discarded=${plan.discarded.length} layout=${state.layout}`)
    // C 経路の close-surface + E 経路の discard log を sequential に流す
    await applyDiscardOnly(state, plan)
    // resumePlan はそのまま透過 (plan.unmatchedResumes は initializeConductorSlots が
    // panes と 1:1 で分配する — team.json 空経路と完全に同じシグネチャで呼ぶ)
    return await initializeConductorSlots(
      state.projectRoot,
      state.conductors,
      state.maxConductors,
      daemonSurface,
      resumePlan,   // <-- team.json 空経路と同じシグネチャ
      state.layout,
      state.mainBranch,
    )
  }
  // 既存 conductor が 1 つでも残れば従来経路 (A/B/C/D/E 全部 + partial 警告)
  return await applyRestorePlan(state, plan)
```

#### `applyDiscardOnly` 仕様（ログ出力契約 / sequential 実行保証）

`applyRestorePlan` の C/E ブロックを抽出した小さなヘルパ関数 `applyDiscardOnly(state, plan)` を新設する。ここでの "discard" は「conductor entry を `state.conductors` に登録せずに流す」という広義の意味で使っており、C 経路の close-surface 副作用も含む（= Minor #7 対応で命名意図を明示。改名はしない）。

**ログ出力契約（applyRestorePlan 現行と bit-identical を保つ）:**

- `plan.cleanup` の各 surface に対して `await cmux.closeSurface(s)` → `await log("conductor_stale_surface_closed", ...)` を **sequential で実行**
- `plan.discarded` のうち reason が `surface_missing_no_task` の行だけ `await log("conductor_discarded", ...)` を出力する。reason が `pid_dead_idle_cleanup` の行（C 経路由来）は既に `conductor_stale_surface_closed` で記録済みのためスキップ（= Critical #1 対応）

**sequential 実行の保証（= Major #5 対応）:**

```
for (const s of plan.cleanup) {
  await cmux.closeSurface(s)
  await log("conductor_stale_surface_closed", ...)
}
for (const d of plan.discarded) {
  if (d.reason === "surface_missing_no_task") {
    await log("conductor_discarded", ...)
  }
}
```

- `Promise.all(plan.cleanup.map(closeSurface))` のような並列化は**禁止**（cmux 側で close 中に new pane 作成リクエストが入るレースを避けるため）
- close-surface → new pane 作成の順序を保証するため、`applyDiscardOnly` 完了後に `initializeConductorSlots` を呼ぶ（pane 数が一時的に 6 になる瞬間を避ける）
- `applyRestorePlan` の C/E ブロックからも同ヘルパを呼び出し、bit-identical 性を維持する（Decision D2）

#### なぜ `applyRestorePlan` の中ではなく外側で分岐するか

`applyRestorePlan` は「復帰副作用の適用」専用関数。フォールバックを内側で起こすと:

- `applyRestorePlan` が `initializeConductorSlots` を呼び出す副作用を持つことになり責務が肥大化
- 戻り値（resume assignments）の意味が分岐する
- テストの mock 構造が複雑化（cmux + initializeConductorSlots の両方を stub する必要）

`initializeLayout` 側で `plan` を見て分岐する方が責務が明確で、既存テスト（M6/M7/M10/M11/M12/M14/M15/M16）も影響を受けない。

#### cleanup/discard の扱い（D1 で詳述）

「全 discard ケース」の plan には以下の組み合わせが起こりうる（test ケース M17a/b/c 参照、§5.2 エッジケース表に同期）:

- **(α) E のみ**: surface_missing_no_task の log のみ（close-surface 副作用なし — KDG-SSO 現物）
- **(β) C のみ**: pid 全死亡 + surface 全実在 + 全 idle → close-surface 3 回 + `conductor_stale_surface_closed` ログ 3 回
- **(γ) C + E 混在**: 部分的に close-surface しつつ (α)(β) の両ログ

これらを fallback 前に必ず処理する必要がある（C 経路の close-surface を skip すると残骸 pane が残る）。`applyDiscardOnly(state, plan)` は 3 バリアント全てを正しく処理する。

### 2.2 `cmux-team stop` 廃止

#### CLI 経路の削除

- `main.ts:2160-2182` の `cmdStop` 関数を完全削除
- `main.ts:4368-4370` の `case "stop": await cmdStop()` 分岐を削除
- 結果: `cmux-team stop` を実行すると `default` 分岐に落ち、`Unknown command: stop` で exit 1 になる

#### help 文言の削除

- `i18n.ts:183-194` の `help_stop` (en) を削除
- `i18n.ts:861-872` の `help_stop` (ja) を削除
- `i18n.ts:675` (en help_main) `cmux-team stop` 行を削除
- `i18n.ts:1355` (ja help_main) `cmux-team stop` 行を削除

#### pidfile.ts のメッセージ更新

`pidfile.ts:33` の `PidFileLockedError` メッセージから `'cmux-team stop'` 案内を削除し、代替を明示:

```
旧: "Run 'cmux-team stop' or kill <pid> first."
新: "kill <pid> first (or close the cmux session)."
```

> workspace 前置文脈（`at workspace=${workspace}`）はそのまま残るので、新メッセージは自然に繋がる。`pidfile.test.ts:127-128` は `toContain("54321")` と `toContain(testDir)` のみを検証しているため assertion 修正は不要（= Minor #10 対応）。

#### pidfile release 経路の温存

T259 の `releasePidFile` 呼び出し位置のうち、`cmdStop` 経由（`main.ts:2168-2181`）のみが削除対象。以下 4 経路は全て温存する:

| 経路 | 場所 | 役割 |
|---|---|---|
| `shutdown()` | `main.ts:587-610` | SIGINT/SIGTERM/onQuit 経由 |
| `onReload` | `main.ts:617-660` | auto-restart の execFileSync 直前 |
| `onFullQuit` | `main.ts:663-708` | Full Quit |
| `restartRequested` | `main.ts:968-977` | exit 42 直前（source change auto-restart） |

これらは pidfile の正規 release 経路なので、`cmdStop` 削除では touch しない。

#### daemon.ts のログ文言修正（§2.1 Critical #2 対応 — 純観測ログに統一）

`daemon.ts:1133-1136` の `layout_mismatch_on_resume` ログは `planLayoutRestore` 実行より前の段階で emit される（= kept か rebuild かがまだ未確定）。T286 の fallback が発動するケース（KDG-SSO 再現条件）では既存 panes は全消失 → fallback で新 slot 作成（= requested layout で自動 rebuild）なので、「existing panes will be kept」は事実に反する。

従って行動案内を完全削除し、純観測ログに統一する:

```
新ログ文字列: `restored=${restoredLayout} current=${state.layout}`
```

- `layout_mismatch_on_resume` は T255 当時はアクション案内を兼ねていたが、T286 で fallback が入ると「kept か rebuild か」を事前に判定できないため、事実ベースの観測ログに戻すのが一貫する
- fallback 発動時は `layout_restore_empty_fallback` が別途出るので追加案内は不要
- 既存 M14 assertion は `restored=` `current=` の判定だけ見ているので変更不要

#### ドキュメント書き換え（grep で網羅）

| ファイル | 該当箇所 | 修正方針 |
|---|---|---|
| `README.md:100` | コマンド表に `cmux-team stop` 行 | 削除 |
| `README.md:238` | "Use `cmux-team stop` and set..." | 「kill the daemon (`kill $(cat .team/daemon.pid)`) and set...」に書き換え |
| `README.ja.md:100` | コマンド表に `cmux-team stop` 行 | 削除 |
| `README.ja.md:182` | コード例の `cmux-team stop` 行 | 削除（同ブロック内 4 行 → 3 行になる。他コマンドのコメント粒度と整合するか目視確認 — Minor #9） |
| `README.ja.md:311` | "`cmux-team stop` で..." | 「daemon を停止する (`kill $(cat .team/daemon.pid)`) ...」に書き換え |
| `CLAUDE.md:283` | E2E テスト手順 `# 5. クリーンアップ` ブロック | `cmux-team stop` を「cmux セッション終了 / `kill $(cat .team/daemon.pid)`」に置換し、横の説明文も更新 |
| `CLAUDE.md:434` | 「cmdStop（保険）」言及 | 「cmdStop」を削除、release 経路の列挙からも除く |
| `docs/spec/01-skill-cmux-team.md:68` | コマンド表 | 行削除 |
| `docs/spec/03-commands.md:7` | 旧仕様注記 | **削除ではなく注記追加に変更**（= Minor #8）: 「起動・ステータスは CLI サブコマンド（`cmux-team start`, `cmux-team status`）に移行した（停止は当初 `cmux-team stop` として実装されたが T286 で廃止）」のような履歴注記にする。そのまま `stop` 単語を削るだけだと日本語として「停止」が抜けて文意が崩れるため |
| `docs/spec/05-install-and-infrastructure.md:119` | サブコマンド表 | 行削除 |
| `docs/spec/06-implementation-tasks.md:56-58` | "Task 2.4: stop 機能 — 完了" | "Task 2.4: stop 機能 — 廃止 (T286)" にステータス変更（履歴を残す） |
| `skills/cmux-team/SKILL.md:83` | コマンド表 | 行削除 |
| `skills/cmux-team-guide/SKILL.md:54` | 停止コード例 | `cmux セッションを閉じる`（または `kill $(cat .team/daemon.pid)`） に置換 |
| `skills/cmux-team-guide/SKILL.md:108` | コマンド表 | 行削除 |

> **注:** `docs/research/research-cmux-cli.md` の `stop` は cmux 自身の hook 用語なので touch しない。`.team/tasks/*/runs/`、`.team/artifacts/`、過去 `CHANGELOG.md` エントリは履歴なので touch しない。

#### 「停止手段」の代替記述（README / docs に追加）

以下を `README.md` / `README.ja.md` の Commands セクション直下に短く追加:

```
> daemon を明示的に停止したい場合は cmux セッションを終了するか、
> `kill $(cat .team/daemon.pid)` で SIGTERM を送ってください。
> （SIGINT/SIGTERM ハンドラが正規 shutdown を実行し pidfile も release します）
```

### 2.3 構造的解決の検討

「全 discard で空着地」は今回が初発見だが、`initializeLayout` の if-ladder で死角が発生したケース（T255 の M6 部分復元バグなど）は過去にも複数あった。**根本的には `initializeLayout` の分岐を全て pure function（= `planLayoutRestore` 系）に寄せて、副作用層 (`applyRestorePlan` / `initializeConductorSlots`) は plan を受け取って実行するだけにするのが望ましい。**

ただし今回のスコープでは:

- 「全 discard 時の new-slot fallback」を `planLayoutRestore` 側に持たせると、pure function が「現状の slot 数が足りない場合に新 surface を作る」という副作用前提の判断を持つことになり責務違反
- 既存の `M6/M14/M15/M16` テストは `applyRestorePlan` 経由のみを検証している

→ 今回は「`initializeLayout` の入口での 1 段分岐追加」に留める。state-machine 化（`docs/spec/07-state-machine.md` 参照）の文脈で将来 `LayoutRestoreReducer` + `LayoutRestoreEffects` として再構成する余地は残す（後続タスク候補として Decision Log D5 に記録、§4 S9 の完了後に artifact 起票を推奨 — Minor #12 対応）。

### 2.4 代替案と却下理由

| 案 | 却下理由 |
|---|---|
| `initializeConductorSlots` 内に「team.json 空 OR 全 discard」の判定を入れる | `initializeConductorSlots` は「新規 slot 作成」専用なのに分岐が肥大化する。`initializeLayout` 入口で分岐する方が層分離が明確 |
| `planLayoutRestore` の戻り値に `needsBootstrap: boolean` を追加 | pure function に bootstrap 判断（= state の有無 + slot 不足の判断）を持たせるのは責務違反。閲覧側で `length === 0` チェックすれば事足りる |
| `surface_missing_no_task` を C 経路のように cleanup する | E は元々 surface 消失なので close 対象 surface が無い。cleanup は不要 |
| `cmux-team stop` を deprecated 警告のみで残す（段階的廃止） | 利用者がほぼ居ない上、stop が「正規ルート」と誤解され続けるため一気に削除する方がよい。CHANGELOG に破壊的変更として明記 |

## 3. 変更対象

### 3.1 変更ファイル

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | `initializeLayout` に「全 discard fallback」分岐追加 + `layout_mismatch_on_resume` ログ文言を純観測形 `restored=... current=...` に変更 + `applyDiscardOnly` ヘルパ抽出 |
| `skills/cmux-team/manager/main.ts` | `cmdStop` 関数削除 + `case "stop"` 分岐削除 + 冒頭 JSDoc コメントから `* ./main.ts stop ...` 行削除（空行整形確認） |
| `skills/cmux-team/manager/i18n.ts` | `help_stop` (en/ja) 削除 + `help_main` (en/ja) の `cmux-team stop` 行削除 |
| `skills/cmux-team/manager/pidfile.ts` | `PidFileLockedError` メッセージから `'cmux-team stop'` 案内削除（workspace 前置文脈は維持） |
| `skills/cmux-team/manager/daemon.test.ts` | M17a/M17b/M17c（+ 任意 M17d）の fallback テストケース追加 |
| `README.md` | コマンド表 + 障害対処の `cmux-team stop` 言及を削除/書き換え + 代替記述追加 |
| `README.ja.md` | 同上（L178-183 コードブロックの整合を目視確認） |
| `CLAUDE.md` | E2E テスト手順 + pidfile 説明から `cmux-team stop` / `cmdStop` 言及削除 |
| `docs/spec/01-skill-cmux-team.md` | コマンド表から行削除 |
| `docs/spec/03-commands.md` | **注記追加** (Minor #8): 「停止は当初 `cmux-team stop` として実装されたが T286 で廃止」履歴注記に変更 |
| `docs/spec/05-install-and-infrastructure.md` | サブコマンド表から行削除 |
| `docs/spec/06-implementation-tasks.md` | "Task 2.4: stop 機能" を「廃止 (T286)」へ |
| `skills/cmux-team/SKILL.md` | コマンド表から行削除 |
| `skills/cmux-team-guide/SKILL.md` | 停止コード例 + コマンド表を書き換え |
| `CHANGELOG.md` | `[Unreleased]` セクションに破壊的変更 + 修正を追記。次回 release スキル実行時に `[Unreleased]` → `[4.3.0]` に昇格する前提で、本タスクではバージョン見出しを新設しない（= Major #6） |

### 3.2 新規作成ファイル

なし（テストケースは既存 `daemon.test.ts` の `describe("initializeLayout: ...")` 内に追加）。

### 3.3 削除ファイル

なし（`cmdStop` は main.ts 内の関数削除のみ）。

## 4. サブタスク分割

### S1: 自己修復ロジック追加（実装）

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **作業**:
  1. `initializeLayout` の `planLayoutRestore` 呼び出し直後に `plan.alive.length === 0 && plan.resumeExisting.length === 0 && plan.resumeNewSurface.length === 0` の判定を追加
  2. 一致時は `applyDiscardOnly(state, plan)` を呼んでから `initializeConductorSlots(state.projectRoot, state.conductors, state.maxConductors, daemonSurface, resumePlan, state.layout, state.mainBranch)` へフォールバック（team.json 空パスと完全に同じシグネチャで呼ぶ — `resumePlan` 透過を含む）
  3. ヘルパ `applyDiscardOnly(state, plan)` を `applyRestorePlan` の C/E ブロックから抽出。cleanup ループは **sequential 実行**。`plan.discarded` のうち `reason === "surface_missing_no_task"` の行だけ `conductor_discarded` を出力し、`pid_dead_idle_cleanup` reason の行はスキップ（`conductor_stale_surface_closed` で記録済みのため二重出力を防ぐ）
  4. `applyRestorePlan` の C/E ブロックも同ヘルパを呼ぶよう置換し、bit-identical 性を維持（Decision D2）
  5. ログ追加: `await log("layout_restore_empty_fallback", \`kept=0 discarded=${plan.discarded.length} layout=${state.layout}\`)` をフォールバック判定直後に出す
  6. `applyDiscardOnly` に JSDoc / 行内コメントで「ここでの "discard" は『conductor entry を state に登録しないで流す』という広義の意味で、C 経路の close-surface 副作用も含む」と明示（Minor #7）
- **完了条件**:
  - `bunx tsc --noEmit` で daemon.ts 由来の新規エラーが 0 件
  - `applyDiscardOnly` は `cmux.closeSurface` と `log` のみ呼び、`state.conductors` への mutation は行わない
  - `applyDiscardOnly` のループが `for (const s of plan.cleanup) { await ... }` 形式 (sequential)
- **メソッド制約**:
  - `initializeConductorSlots` の引数（projectRoot / conductors / maxConductors / daemonSurface / resumePlan / layout / mainBranch）は team.json 空パスと完全に同じシグネチャで呼ぶ
  - `applyDiscardOnly` 内では `cmux.closeSurface` と `log` のみを呼ぶ
  - **`Promise.all` での並列化は禁止**（cmux 側で close 中に new pane 作成リクエストが入るレースを避けるため）
- **検証コマンド**:
  - `grep -n "layout_restore_empty_fallback" skills/cmux-team/manager/daemon.ts` で 1 件
  - `grep -n "applyDiscardOnly" skills/cmux-team/manager/daemon.ts` で 3 件以上（定義 + `initializeLayout` からの呼び出し + `applyRestorePlan` からの呼び出し）
  - `grep -A 3 'reason === "surface_missing_no_task"' skills/cmux-team/manager/daemon.ts | grep conductor_discarded` で該当あり（reason フィルタ条件が bit-identical）
  - `! grep -A 5 'function applyDiscardOnly' skills/cmux-team/manager/daemon.ts | grep 'Promise.all'`（並列化禁止の確認）

### S2: `layout_mismatch_on_resume` ログ文言を純観測形に確定（配線）

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts:1133-1136`
- **作業**: ログ文字列を以下に確定:

  ```
  新: `restored=${restoredLayout} current=${state.layout}`
  ```

  - `run 'cmux-team stop' then 'start --layout=...' to rebuild` ガイダンス文字列を完全削除
  - `existing panes will be kept` 文言も削除（fallback 発動ケースでは事実に反するため）
  - fallback 発動時は `layout_restore_empty_fallback` が別途出るので追加案内は不要
- **完了条件**:
  - `grep -n "cmux-team stop" skills/cmux-team/manager/daemon.ts` で 0 件
  - ログ文言から行動案内（`run 'cmux-team stop'` / `restart cmux session` 等）が完全削除されている
  - 既存 M14 assertion は `restored=` / `current=` の判定だけ見ているので変更不要（= Critical #2 対応）
- **理由**: `layout_mismatch_on_resume` は `planLayoutRestore` 実行より前の段階で emit される（kept か rebuild かが未確定）。T286 の fallback が入ると「kept か rebuild か」を事前に判定できないため、事実ベースの観測ログに戻す

### S3: テストケース追加（実装） — M17 を 3 バリアント化（+ 任意 M17d）

- **対象ファイル**: `skills/cmux-team/manager/daemon.test.ts`
- **作業**: `describe("initializeLayout: マトリクス復帰 (T255 §8.3 M6〜M16)", ...)` の末尾に以下を追加 (= Major #3 対応):

  ```
  test("M17a: 全 entry が surface 消失 (E のみ) → fallback で initializeConductorSlots", ...)
  test("M17b: 全 entry が pid 死亡 + surface 実在 + 全 idle (C のみ) → fallback、close-surface 3 回 + initializeConductorSlots", ...)
  test("M17c: C + E 混在 → fallback、部分 close-surface + 部分 discard log + initializeConductorSlots", ...)
  ```

  M17c は共通セットアップで低コストなので追加する。M17a + M17b は最低限必須。

  **任意 M17d（余力があれば）**: team.json 3 entry 全 E + resumePlan 非空 の fallback で resume が新 slot に正しく分配される (= Major #4 対応)。

  - 各テストは以下を verify:
    - `manager.log` に `layout_restore_empty_fallback kept=0 discarded=<N> layout=<wide|16x9>` が記録される
    - `initializeConductorSlots` が呼ばれて slot 作成される（state.conductors.size === maxConductors）
    - M17b/M17c では `cmux.closeSurface` が cleanup 対象 surface に対して sequential に呼ばれる（呼び出し順序を spy で検証）
    - M17a/M17c では `conductor_discarded` log が E 経路 surface のみに出る（C 経路 surface には出ない = reason フィルタの bit-identical 性）
- **完了条件**:
  - M17a/M17b/M17c 3 件が pass（+ 任意で M17d）
  - 既存 M6/M7/M10/M11/M12/M14/M15/M16 が引き続き pass
- **検証コマンド**:
  - `bun test daemon.test.ts -t "M17a"` `bun test daemon.test.ts -t "M17b"` `bun test daemon.test.ts -t "M17c"` が緑

### S4: `cmdStop` 削除（削除）

- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **作業**:
  1. `cmdStop` 関数定義（L2160-2182）を削除
  2. switch ルーティングの `case "stop": await cmdStop(); break;`（L4368-4370）を削除
  3. ファイル冒頭 JSDoc コメントブロック L11 の `* ./main.ts stop ...` 行を削除
- **完了条件**:
  - `grep -n "cmdStop\|case \"stop\"" skills/cmux-team/manager/main.ts` で 0 件
  - `bunx tsc --noEmit` で main.ts 由来の新規エラー 0 件
  - `releasePidFile` の import は他経路で使用中なので残す
  - **冒頭 JSDoc コメントブロックの空行整形確認**（= Minor #11 対応）: stop 行だけ抜けて `* ./main.ts send ...` / `* ./main.ts send SHUTDOWN` 等の周辺行と不自然な空行が生じないか目視確認
- **検証コマンド**:
  - `cmux-team stop` を実行すると `Unknown command: stop` で exit 1 になる（コマンドラインで動作確認）

### S5: `i18n.ts` から `help_stop` / help_main の stop 行を削除（削除 + 配線）

- **対象ファイル**: `skills/cmux-team/manager/i18n.ts`
- **作業**:
  1. `help_stop` (en, L183-194) を削除
  2. `help_stop` (ja, L861-872) を削除
  3. `help_main` (en, L675) の `  cmux-team stop ...` 行を削除
  4. `help_main` (ja, L1355) の `  cmux-team stop ...` 行を削除
  5. `t()` 関数の戻り型は `keyof typeof en` で型推論されるため、`help_stop` を削除すると `t("help_stop")` の呼び出し（L2161 にあったもの）が **既に S4 で消えている** → 整合性 OK
- **完了条件**:
  - `grep -n "help_stop\|cmux-team stop" skills/cmux-team/manager/i18n.ts` で 0 件
  - `bunx tsc --noEmit` で i18n.ts 由来の新規エラー 0 件
- **検証コマンド**:
  - `cmux-team --help` の出力に `stop` 行が無い
  - `grep -rn "help_stop" skills/cmux-team/manager/` で 0 件

### S6: `pidfile.ts` のエラーメッセージ更新（配線）

- **対象ファイル**: `skills/cmux-team/manager/pidfile.ts:31-35`
- **作業**: `PidFileLockedError` の `super(...)` メッセージから `Run 'cmux-team stop' or` を削除し、`kill ${existingPid} first (or close the cmux session).` に置換。workspace 前置文脈（`at workspace=${workspace}`）はそのまま残すので意味は通る
- **完了条件**:
  - `grep -n "cmux-team stop" skills/cmux-team/manager/pidfile.ts` で 0 件
  - **`pidfile.test.ts` の assertion 修正は不要**（= Minor #10 対応）: `pidfile.test.ts:127-128` は `toContain("54321")` と `toContain(testDir)` のみを検証しており、workspace 前置部分は残存するため message 全文 assert していない
- **検証コマンド**:
  - `bun test pidfile.test.ts` が緑

### S7: ドキュメント書き換え（配線）

- **対象ファイル**:
  - `README.md`、`README.ja.md`
  - `CLAUDE.md`
  - `docs/spec/01-skill-cmux-team.md`、`docs/spec/03-commands.md`、`docs/spec/05-install-and-infrastructure.md`、`docs/spec/06-implementation-tasks.md`
  - `skills/cmux-team/SKILL.md`
  - `skills/cmux-team-guide/SKILL.md`
- **作業**: 上記 §3.1 の表に従って `cmux-team stop` 言及を削除または「`kill $(cat .team/daemon.pid)`」へ書き換え。特に `docs/spec/03-commands.md:7` は**注記追加方式**で「停止は当初 `cmux-team stop` として実装されたが T286 で廃止」履歴注記に変更（= Minor #8）
- **完了条件**:
  - `grep -rn "cmux-team stop" README.md README.ja.md CLAUDE.md docs/spec/ skills/cmux-team/SKILL.md skills/cmux-team-guide/SKILL.md` で 0 件
  - `grep -n "cmdStop" CLAUDE.md` で 0 件
  - **`README.ja.md` L178-183 のコードブロック目視確認**（= Minor #9 対応）: `cmux-team stop` 行削除後に 3 行コード例として自然に見えるか、他コマンド（start / send / status 等）のコメント粒度と整合するか
  - `docs/spec/03-commands.md` L7 は単なる単語削除ではなく日本語として意味が通る注記になっている
- **検証コマンド**:
  - `grep -rn "cmux-team stop" --include="*.md" -l | grep -v ".team/tasks/" | grep -v ".team/artifacts/" | grep -v "CHANGELOG.md"` で 0 件（履歴系除外）

### S8: CHANGELOG 追記（配線）

> `[Unreleased]` セクション以下に追記する。次回 release スキル実行時（別タスク）に release スキルが `[Unreleased]` を `[4.3.0] - <ISO date>` にリネームする前提で、本タスクではバージョン見出しを新設しない（= Major #6 対応）。現行 `[4.2.0] - 2026-04-21` エントリは触らない。

- **対象ファイル**: `CHANGELOG.md`
- **作業**: `[Unreleased]` セクションに以下の 2 エントリを追加:

  ```
  ### Changed (Breaking)

  - **`cmux-team stop` サブコマンド廃止（T286、破壊的変更）**。CLI 登録 / cmdStop 関数 / `help_stop` ヘルプ / 各種ドキュメント言及を全削除。daemon を明示停止したい場合は cmux セッションを終了するか `kill $(cat .team/daemon.pid)` で SIGTERM を送る（SIGINT/SIGTERM ハンドラが正規 shutdown を実行し pidfile も release する）。`cmux-team send SHUTDOWN` 経路は残るので queue 経由の停止は引き続き可能

  ### Fixed

  - **`cmux-team start` が「team.json 全 entry が cmux 側に存在しない」状態から復帰できない問題を修正（T286）**。`initializeLayout` で `planLayoutRestore` の結果が `alive` / `resumeExisting` / `resumeNewSurface` 全て空（= 全 entry が C/E 経路に倒れた）場合、新規 slot 作成パスにフォールバックするようにした。発症条件: cmux セッションを完全終了 → 同 workspace で `cmux-team start` 再投入したとき、`team.json` の conductor entry の surface が cmux に存在しないため全件 `surface_missing_no_task` で discard されていた。フォールバック発動時は `layout_restore_empty_fallback kept=0 discarded=<N> layout=<wide|16x9>` をログ出力。`layout_mismatch_on_resume` のガイダンス文言も純観測ログ `restored=<old> current=<new>` に変更（T286 stop 廃止と同期）
  ```
- **完了条件**: `[Unreleased]` ヘッダ直下にエントリが追加されており、`[4.2.0]` エントリは触られていない

### S9: 検証

- **対象**: 全変更
- **作業**:
  1. `cd skills/cmux-team/manager && bun test daemon.test.ts pidfile.test.ts main.test.ts` でターゲット 3 ファイル pass
  2. `cd skills/cmux-team/manager && bun test` で全テスト pass
  3. `cd skills/cmux-team/manager && bunx tsc --noEmit` で新規エラー 0 件（既存 2 件は §6.2 参照）
  4. `cmux-team stop` を実行 → `Unknown command: stop` で exit 1
  5. `cmux-team --help` の出力に `stop` 行が無い
  6. `grep -rn "cmux-team stop" --include="*.md" -l | grep -v ".team/tasks/" | grep -v ".team/artifacts/" | grep -v "CHANGELOG.md"` で 0 件
- **完了条件**: 全 step が緑
- **S9 完了後の任意推奨作業** (= Minor #12 対応): Decision D5「`initializeLayout` の state-machine 化（`LayoutRestoreReducer` + `LayoutRestoreEffects` への再分割）」の内容を artifact (type=decision) として起票し、後続運用で追跡可能にしておく。`/artifact decision "T286 後続: initializeLayout state-machine 化"` 相当。強制ではない

## 5. リスク

### 5.1 既存機能への影響

| リスク | 対応 |
|---|---|
| `cmux-team stop` を script やドキュメントで使っているユーザー | CHANGELOG に破壊的変更として明記。代替手段（`kill $(cat .team/daemon.pid)` / `cmux-team send SHUTDOWN`）を README に追記 |
| `cmux-team send SHUTDOWN` 経路が壊れていないか | SHUTDOWN message type 自体は schema / handleMessage / send サブコマンドに残るので影響なし。`grep -n "SHUTDOWN" daemon.ts main.ts schema.ts` で確認済み |
| `applyDiscardOnly` 抽出による既存 `applyRestorePlan` の挙動変化 | `applyRestorePlan` の C/E ブロックを `applyDiscardOnly(plan)` 呼び出しに置換し、bit-identical 性を保つ（reason フィルタ / sequential / ログ順序すべて既存と同じ）。Decision D2 |
| `pidfile.test.ts` がエラーメッセージ全文比較していた場合 | 既確認: `toContain("54321")` / `toContain(testDir)` のみなので assertion 修正不要（= Minor #10） |

### 5.2 エッジケース

| ケース | 期待挙動 |
|---|---|
| `team.json` 空 + resumePlan 非空 | 既存 M12 経路（`initializeConductorSlots(resumePlan)`）。今回の変更は非空パスのみに作用するので影響なし |
| `team.json` に 3 entry + 1 件のみ alive | 既存通り A 1 + 残骸処理。`plan.alive.length === 1` なので fallback 発動せず |
| `team.json` 3 entry + 全 E（KDG-SSO 現物） | (α) fallback 発動、`applyDiscardOnly` が `conductor_discarded` 3 件ログ（close-surface 副作用なし）+ initializeConductorSlots で新 slot 作成 → **M17a** |
| `team.json` 3 entry + 全 pid 死亡 + 全 surface 実在 + 全 idle | (β) C 経路 3 件のみ → fallback 発動、`applyDiscardOnly` が close-surface 3 回 + `conductor_stale_surface_closed` 3 件ログ + initializeConductorSlots → **M17b** |
| `team.json` 3 entry + C + E 混在 + 全 idle | (γ) fallback 発動、部分 close-surface + 部分 discard log + initializeConductorSlots → **M17c** |
| `team.json` 3 entry 全 E + resumePlan 2 件（unmatched） | fallback 発動 + 新 slot 2 件に resume 分配（残 1 slot は通常 spawn）。`resumePlan` は team.json 空パスと同一シグネチャで `initializeConductorSlots` に透過する（= Major #4） → **M17d（任意）** |
| `team.json` に 3 entry + 全 surface 消失 + 1 件 running task | D 経路 1 件 + E 経路 2 件 → `resumeNewSurface.length === 1` なので fallback 発動せず（既存通り task ready 戻し） |
| `team.json` に 3 entry + 全 pid 死亡 + 全 surface 実在 + 1 件 running task | B 経路 1 件 + C 経路 2 件 → `resumeExisting.length === 1` なので fallback 発動せず |
| `tree() 失敗 (treeDegraded)` で全 entry が pid 死亡 | 既存通り A 相当に倒れる（layout-restore.ts:96-101） → `plan.alive.length === N` で fallback 発動せず |
| `cmux-team start` 直後に直ちに `kill $(cat .team/daemon.pid)` | shutdown handler が SIGTERM 受けて pidfile release → 次回 start で acquire 可能 |

### 5.3 テスト戦略

#### 自動テスト

- `daemon.test.ts` に M17a/M17b/M17c（+ 任意 M17d）を追加（§4 の S3 参照）
- 既存 `pidfile.test.ts` の assertion は修正不要（Minor #10）
- `bun test` 全件で regression なし

#### 手動 E2E（ユーザー側で実施）

1. 任意のプロジェクトで `cmux-team start` → 正常起動確認 → cmux session を終了
2. 同じプロジェクトで `cmux-team start --layout=16x9` 再投入 → fallback 発動を期待
   - `manager.log` に `layout_restore_empty_fallback kept=0 discarded=<N> layout=16x9` が出ること
   - `layout_mismatch_on_resume restored=wide current=16x9` が純観測形で出ること（行動案内文字列なし）
   - Conductor が 2 台（16x9 のスロット数）起動すること
3. 既存 conductor が 1 つでも生きているプロジェクトで `cmux-team start` 冪等実行 → fallback 発動せず（既存挙動維持）
4. `cmux-team stop` を実行 → `Unknown command: stop` で exit 1
5. `cmux-team send SHUTDOWN` → 既存通り daemon が graceful shutdown
6. `kill $(cat .team/daemon.pid)` → SIGTERM ハンドラが正規 shutdown を実行 + pidfile release

## 6. 既存型エラーの先読み

`bunx tsc --noEmit 2>&1 | grep -E "^(daemon|main|pidfile|layout-restore|i18n)\.(ts|test\.ts)"` 実行結果:

```
daemon.test.ts(3720,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1538,22): error TS2352: Conversion of type 'string | undefined' to type '{ type: "SESSION_STARTED"; ... } & { type: "SESSION_STARTED"; }' may be a mistake ...
```

### 6.1 本タスクのスコープで解消するエラー

| ファイル | エラー | 方針 |
|---|---|---|
| 該当なし | — | 既存 2 件はいずれも SESSION_STARTED の `source` 型 (`"startup" | "resume" | "clear" | "compact" | undefined`) に関する問題で、`initializeLayout` / `cmdStop` とは独立した箇所 |

### 6.2 後続タスク（cleanup）に分離するエラー

| ファイル | エラー | 分離理由 | 予定 cleanup タスク名 |
|---|---|---|---|
| `daemon.ts:1538` | `SESSION_STARTED` の `source` フィールドの型不整合（`string | undefined` → union literal への変換警告） | scope=`hookSchema` 周辺の刷新が必要で、本タスクの「fallback 1 分岐追加 + stop 廃止」とは独立。修正には schema.ts の SessionStartedMessage 改修が伴う | `T-XXX: SESSION_STARTED の source 型を schema 駆動で統一` |
| `daemon.test.ts:3720` | テストの `source: "new_session"` がリテラル union に含まれない | 上記と同根。schema 修正の一部としてテスト側も追従 | 同上 |

→ 本タスクでは **触らない**。S9 の検証では「新規エラー 0 件」を判定基準とする（既存 2 件は除外）。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | 全 discard fallback の前に C 経路の cleanup を実行するか | する | C 経路は「pid 死亡 + surface 実在 + idle」の残骸 pane で、close-surface しないと cmux 側に残骸が残る。fallback 発動時の new slot 作成と同居しても新 surface ID が衝突する可能性は無いが、ユーザー視点では「古い idle 残骸が見えたまま新 Conductor が起動する」のは混乱の元 |
| D2 | C/E 副作用の重複コードを `applyDiscardOnly` ヘルパに抽出するか、`initializeLayout` 内に inline で書くか | ヘルパに抽出し、`applyRestorePlan` の C/E ブロックも同ヘルパを呼ぶ | DRY。inline コピペは将来の C/E 分類追加（例: F 経路）で 2 箇所修正漏れを起こす。bit-identical 性を保つためには single source of truth にする必要がある |
| D3 | `cmux-team stop` を deprecated 警告付きで残すか、即削除するか | 即削除 | 利用者がほぼ居ない（実運用で打たれない）。残しても「stop が正規ルート」という誤解を持続させるだけ。CHANGELOG 破壊的変更として明記すれば移行コストは小さい |
| D4 | `pidfile.ts` の `PidFileLockedError` メッセージで案内する代替手段 | `kill <pid> first (or close the cmux session)` | `cmux-team send SHUTDOWN` も使えるが、エラーメッセージで daemon 起動失敗中なので queue 送信は意味を成さない。SIGTERM か cmux session 終了の 2 択を案内 |
| D5 | `initializeLayout` の if-ladder を state-machine ベースに刷新するか | 今回は touch しない（後続タスク候補） | T255 で planLayoutRestore を pure 化済み。次の段階として `LayoutRestoreReducer`（pure）+ `LayoutRestoreEffects`（副作用）に再分割する余地はあるが、本タスクの「fallback 1 分岐追加」スコープを超える。`docs/spec/07-state-machine.md` の P2 として後続化。S9 完了後に artifact (type=decision) として起票することを推奨 |
| D6 | `docs/spec/06-implementation-tasks.md` の「Task 2.4: stop 機能 — 完了」エントリは削除するか「廃止」にするか | 「廃止 (T286)」にステータス変更し説明文も書き換え | 06-implementation-tasks.md は「実装履歴」の性格を持つため、過去に実装したことは事実として残し、廃止理由を追記する方が後追いしやすい |
| D7 | `cmux-team send SHUTDOWN` 経路は残すか廃止するか | 残す | `send` サブコマンドの汎用キューメッセージ送信機構の一部。SHUTDOWN だけ削除する理由がない。スクリプトから daemon を停止したいユースケースで使える |
| D8 | `layout_restore_empty_fallback` のログ key 名 | この名称で確定 | プレフィックス `layout_restore_*` で「`planLayoutRestore` の結果に対する処理」であることを明示。タスク内 `layout_restore_empty_fallback kept=0 discarded=<N> layout=<wide|16x9>` フォーマットに従う |
| D9 | M17 テストでの cmux stub 範囲 | `newSplit` を含む全 cmux IO を stub | M12 と同じパターン。`initializeConductorSlots` が内部で `newSplit` / `send` / `sendKey` を呼ぶため、これらを stub しないと test がハングする。M17b/M17c では `closeSurface` の呼び出し順序を spy で検証 |
| D10 | README の障害対処項 (`README.md:236`) の書き換え方針 | "kill the daemon ... and set CMUX_TEAM_MAX_CONDUCTORS=1" に置換 | 該当節は「ペイン狭問題」の対処で、stop の代わりに「daemon を停止して env で再起動」を案内する文脈。具体コマンド (`kill $(cat .team/daemon.pid)`) を提示 |
| D11 | `layout_mismatch_on_resume` ログの文言方針（Critical #2） | 純観測ログ `restored=<old> current=<new>` に統一（行動案内完全削除） | このログは `planLayoutRestore` 実行より前に emit され、kept か rebuild かが未確定。T286 で fallback が入ると事前判定不能になるため、事実ベースの観測ログに戻す。fallback 発動時は `layout_restore_empty_fallback` が別途出るので追加案内は不要。既存 M14 assertion は `restored=` `current=` のみ検証しているため変更不要 |
| D12 | `applyDiscardOnly` の `plan.discarded` ループでの reason フィルタ条件（Critical #1） | `reason === "surface_missing_no_task"` の行だけ `conductor_discarded` を出力、`pid_dead_idle_cleanup` の行はスキップ | C 経路由来の discarded 行（reason=`pid_dead_idle_cleanup`）は既に `conductor_stale_surface_closed` で記録済みのため、二重出力を避ける。現行 `applyRestorePlan` L1019-L1027 の挙動と bit-identical を保つ |
| D13 | `applyDiscardOnly` の cleanup ループの並列化可否（Major #5） | sequential 実行のみ（`Promise.all` 禁止） | cmux 側で close-surface 中に new pane 作成リクエストが入るレースを避けるため。close-surface 完了後に `initializeConductorSlots` を呼ぶことで pane 数が一時的に過剰になる瞬間を避ける。現行 `applyRestorePlan` の C 経路も sequential なので挙動を保つ |
| D14 | fallback 経路で `resumePlan` / `plan.unmatchedResumes` をどう扱うか（Major #4） | team.json 空経路と完全同一シグネチャで `resumePlan` を `initializeConductorSlots` に透過する | fallback 発動条件（3 カテゴリ len===0）は `plan.unmatchedResumes.length > 0` を排除していないため、team.json 非空 + 全 E + resumePlan 2 件 のシナリオが発生しうる。`initializeConductorSlots` が panes と 1:1 で分配する仕組みに乗るため、新 slot に resume が正しく割り当てられる。特別扱い不要 |
| D15 | CHANGELOG の `[Unreleased]` → `[4.3.0]` 昇格タイミング（Major #6） | 次回 release スキル実行時（別タスク）に release スキルが昇格する前提。本タスクではバージョン見出しを新設しない | 現行 CHANGELOG は `[4.2.0] - 2026-04-21` が本日付で既に入り `[Unreleased]` は空。T286 のリリースは release スキル経由で別タスクとして実行されるため、ここでバージョン見出しを作ると release タイミングと乖離する可能性がある。`[Unreleased]` に追記するだけに留める |
| D16 | `applyDiscardOnly` の名称 (Minor #7) | 現名称維持（改名しない） | 「discard のみ」の字面からは C 経路の close-surface 副作用が見えにくいが、改名すると影響範囲が大きい。JSDoc / 行内コメントで「ここでの "discard" は『conductor entry を state に登録しないで流す』という広義の意味」と明示することで代替する |
| D17 | `docs/spec/03-commands.md:7` の修正方針 (Minor #8) | 単語削除ではなく注記追加方式 | 現行 L7 は「起動・停止・ステータスは CLI サブコマンド（...）に移行した」という歴史記述。stop だけ削ると「停止」が抜けて日本語として文意が崩れるため、「停止は当初 `cmux-team stop` として実装されたが T286 で廃止」の履歴注記に書き換える |
