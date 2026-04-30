# T323 plan.md 設計レビュー (1)

## Verdict: Changes Requested

## Summary

純粋関数モジュール分割や Decision Log の整備など、構造化は概ね既存パターンに沿っている。
しかし **Master/Conductor の handle 解決経路の前提（observational path）が現状の実装と矛盾**しており、§2.1 の核心設計がそのままでは動かない。
さらに **AGENT_SPAWNED と selectToken の実行順序** が現状の T244 fix の前提（AGENT_SPAWNED は Claude 起動より前に POST する）と衝突するが、plan はこの構造的影響を扱っていない。
これらは実装フェーズで必ず詰まる箇所のため、計画段階で構造を再整理する必要がある。

## Findings

### 1. [critical] Master/Conductor の surface 識別経路が実装と不整合（§2.1 observational path の前提崩壊）

Plan §2.1「Master / Conductor (observational path)」の中核ステップは:

> proxy.ts は `x-cmux-conductor-id` (= surface) と `x-cmux-role` を request header から取得済み（`proxy.ts:533-535`）

そして:

> proxy.ts の `updateTokensDB` 内に「auth_hash 既知の場合は `opts.getState()` を経由して `state.masters.get(surface).tokenHandle` / `findConductor(state, surface).tokenHandle` を上書きする」副作用を追加

しかし実装を確認すると、`x-cmux-conductor-id` を **送信している箇所が存在しない**:

- `generateMasterSettings` (`main.ts:1850`): `ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: master"` ── role のみ
- `generateConductorSettings` (`main.ts:2003`): `ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: conductor"` ── role のみ
- `generateAgentSettings` (`main.ts:1936`): `ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: agent"` ── role のみ

`proxy.ts:534` の `req.headers.get("x-cmux-conductor-id")` は読んでいるが、誰も書いていない。
`opts?.conductorSurface` フォールバックは proxy 起動時に決まる単一値で、複数 Conductor / 複数 Master を識別できない（daemon 起動時は通常 undefined）。

つまり proxy は「auth_hash → handle」は解決できるが、handle を **どの Master surface / どの Conductor surface に紐付けるか** を決定できない。
1 プロジェクト内で複数 Master / 複数 Conductor が異なるトークンを使う可能性がある以上、「pool ON 時は Master/Conductor も独自トークンを持ちうる」前提を捨てない限り observational path は成立しない。

**plan に欠落しているサブタスク**:
- `ANTHROPIC_CUSTOM_HEADERS` を `"x-cmux-role: master, x-cmux-surface: <surface>"` のように拡張し、`generateMasterSettings` / `generateConductorSettings` で surface 注入する変更
- それを受けて proxy.ts:534 を `x-cmux-surface` 優先に変更（`x-cmux-conductor-id` は legacy fallback）
- 上記が無ければ「Master/Conductor の handle 表示は単一 Master & 単一 Conductor 構成のみ」と縮退する判断と、その明示

代替案として「pool 機能 OFF または Master/Conductor は常に同一トークン」と仮定するなら、§2.1 の D2「Agent の handle 受け渡し」だけで十分であり、§2.1 observational path 自体を削るべき。

### 2. [critical] AGENT_SPAWNED の POST タイミングと selectToken の実行順序が現状と矛盾

サブタスク 5 の完了条件:

> `cmdSpawnAgent` が `selectToken` 成功時に `tokenHandle: selected.token.handle` を `postMessage({ type: "AGENT_SPAWNED", ...})` に含める。

しかし現状の `cmdSpawnAgent` は次の順序になっている (`main.ts:2488-2562`):

1. `await postMessage({ type: "AGENT_SPAWNED", ... })` ── L2494（**Claude 起動より前**にしているのは T244 fix の意図）
2. `selectToken(tokDb, surface)` ── L2550（pool 有効時のみ、AGENT_SPAWNED より **後**）

L2488 のコメントが明示している通り、AGENT_SPAWNED を Claude 起動前に置いているのは「SESSION_STARTED の master fallback 誤判定を防ぐ」ための構造的な対策である。
plan は selectToken の結果を AGENT_SPAWNED に乗せるよう要求しているが、以下のいずれを取るかの判断が無い:

- (a) `selectToken` を AGENT_SPAWNED より前に移す → T244 の制約（surface 作成 → AGENT_SPAWNED → Claude 起動 という時系列）を守れるかの検証が必要。Keychain アクセス + DB lease 取得を増やす分、AGENT_SPAWNED が遅れると T244 race を再発させかねない
- (b) AGENT_SPAWNED は現状位置のまま、tokenHandle 反映用に第 2 メッセージ（`AGENT_TOKEN_BOUND` 等）を後追いで送る
- (c) Agent も observational path（proxy 経由）に乗せて AGENT_SPAWNED 自体は触らない

D2「Agent の handle 受け渡し ─ AGENT_SPAWNED に tokenHandle 追加」は (a) を採用する宣言だが、T244 の前提を破壊しない裏付けが無い。Decision Log に「T244 race への影響評価」を追加するか、(b)/(c) の代替検討を明記すべき。

### 3. [major] 既存テストへの影響対応が plan で扱われていない

CRITICAL チェック項目「既存テストへの影響対応」に対し、plan の §5.3 テスト戦略は新規ファイルの単体テスト方針しか書かれていない。以下の既存テストに影響が出るが言及無し:

- `proxy.test.ts:650` の `x-cmux-role: agent` ヘッダー注入テスト（`updateTokensDB` のシグネチャを変える plan §3.2 とサブタスク 6 により壊れる可能性）
- `main.test.ts:1832-1860` の `generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` の `ANTHROPIC_CUSTOM_HEADERS` 値検証（finding #1 の修正で文字列が変わる）
- `daemon.test.ts` の `restoreConductorState` / `updateTeamJson` 関連テスト（agents シリアライズに `tokenHandle` を追加すると assertion が増える可能性、または team.json snapshot テストがあれば破壊する）

サブタスク 10 の「全体 verify」には `bun test` が含まれているが、各サブタスクの完了条件に「該当する既存テストの更新」が無いため、サブタスク間で見落とされる。

### 4. [major] `formatUtil` / `formatReset` 共有方針がサブタスクで担保されていない

§2.5 で `token-cli.ts:cmdTokenList` のフォーマッタを `pool-cli.ts:cmdPoolStatus` から「再 export して共有」と書いているが、`formatUtil` / `formatReset` / `formatSelectable` は現状 `token-cli.ts` 内の internal function でエクスポートされていない (`token-cli.ts:88-111`)。
サブタスク 8 の完了条件は「token-cli.ts の出力ロジックを再利用」と書くだけで、export 化（または共通モジュール抽出）の作業を明示していない。
このまま実装するとコピペ重複が発生し、「DRY / SSOT」違反となる。サブタスク 8 か新規サブタスクで「token-cli.ts から共通フォーマッタを切り出す」ことを完了条件に含めるべき。

### 5. [minor] §2.2 の表示閾値（5h>80%）と A019 の閾値（5h>95%）の関係を plan で明示していない

D11 に「task 仕様優先」と書いてあるが、A019 の「ブロッカー条件 5h>95%」と「TUI 警告 5h>80%」は意味が違う（前者は selectable 除外、後者は表示警告）。plan の §2.2 と D11 は読者にこの違いがすぐ伝わらない。
「ブロッカー = selectable から外す閾値、警告 = 表示用閾値」を pool-surface-row.ts のコメントに残すよう完了条件に含めるか、§2.2 で 1 行注記しておくべき。

### 6. [minor] 罫線幅 50 と既存セクションヘッダー 60 の整合性

D10 の根拠「ターミナル幅 80 想定、内側 50 でほぼ揃う」は感覚的。実際の status 出力は `─ Master ──...`（60 文字）で囲み線が始まり、その下に `┌─ token pool ─...┐`（50 文字）が来ると左揃えで右端が揃わない。
A019 §TUI 表示 のサンプルも 50 文字で書かれているが、視覚的整合のため `┌─` 開始位置のインデント有無、囲み線の幅統一について明示してほしい。
（実装時の判断で済むので minor 扱い）

### 7. [minor] サブタスク 7 と 8 の責務重複

サブタスク 7 (cmdStatus 統合) の完了条件 (c) に「`case "pool"` 追加」が含まれているが、`case "pool"` は pool サブコマンドの routing であってサブタスク 8 の責務。
サブタスク 8 への移動 or サブタスク 7 から削除して責務を分離すべき。

### 8. [minor] `agents` シリアライズの既存欠落

`updateTeamJson` (`daemon.ts:3576-3582`) の agents シリアライズには `spawnedAt` / `taskTitle` が含まれていない（現状からの不具合）。`restoreConductorState` (`daemon.ts:942-950`) は `a.spawnedAt ?? new Date().toISOString()` でフォールバックしているので顕在化していないだけ。
plan §3.2 で agents シリアライズを触るタイミングで `tokenHandle` だけ足すと、既存の欠落フィールドはそのまま残る。本タスクで一緒に直す方針/別タスク扱いの方針を Decision Log に記載してほしい（影響は軽微なので現タスクスコープ外とするのも妥当）。

## Recommendations

### R1. §2.1 observational path の再設計（finding #1 対応）

以下のいずれかに plan を改修する:

**Option A（推奨）**: ANTHROPIC_CUSTOM_HEADERS に surface を含めて proxy 経由で識別する経路を確立する。

- 新規サブタスク（schema 拡張の直後・proxy.ts 改修の前）として追加:
  - `generateMasterSettings(projectRoot)` / `generateConductorSettings(projectRoot)` のシグネチャを `(projectRoot, surface)` に変更し、`ANTHROPIC_CUSTOM_HEADERS` を `"x-cmux-role: master, x-cmux-surface: ${surface}"` 形式に変更
  - 呼び出し側（`cmdStart` 等）で surface を渡せるよう main.ts を改修。Master / Conductor の起動経路で settings.json を per-surface に分けるか、env 注入経路に変更
  - proxy.ts:534 を `req.headers.get("x-cmux-surface") ?? req.headers.get("x-cmux-conductor-id")` に拡張（後者は legacy fallback）
  - サブタスク 6（proxy.ts handle 反映）はこの上に積む
  - 既存テスト（`main.test.ts:1832-1860` / `proxy.test.ts:650`）の更新を完了条件に明記

**Option B（縮退）**: Master / Conductor の handle 表示を「単一 Master & 単一 Conductor 構成のみ」に絞り、複数構成では `(handle 不明)` にフォールバックする旨を §2.1 と §5.2 リスクに明記。proxy.ts の改修は `state.masters.size === 1` のときだけ実施する単純化を選ぶ。

### R2. AGENT_SPAWNED 順序問題の決着（finding #2 対応）

サブタスク 5 を以下のいずれかに改める:

- **R2.A**: `selectToken` の呼び出しを AGENT_SPAWNED の **前** に移し、Decision Log に「T244 race（surface 作成 → AGENT_SPAWNED → Claude 起動）への影響評価」と「Keychain / DB アクセス追加で AGENT_SPAWNED 遅延が許容されるか」を 1 セクション追加。実装時は `selectToken` 失敗（候補なし）でも AGENT_SPAWNED は飛ばさない（fallback 経路は現状維持）ことを完了条件に明記
- **R2.B**: AGENT_SPAWNED は現状位置のまま、`AGENT_TOKEN_BOUND { surface, tokenHandle }` のような追加メッセージを `selectToken` 成功直後に POST する。schema.ts に新メッセージ型を追加し、daemon は `findAgentBySurface` 経由で `agent.tokenHandle` を更新する

D2 を上記いずれかで具体化し、リスク表に「T244 race 再発」を追加。

### R3. 既存テスト影響対応をサブタスクごとに明記（finding #3 対応）

各サブタスクの完了条件に「該当既存テストの更新」を追加する:

- サブタスク 1（schema 拡張）: `daemon.test.ts` の team.json snapshot テストに `tokenHandle` 追加が反映されていること
- サブタスク 5（AGENT_SPAWNED 経路）: `daemon.test.ts:AGENT_SPAWNED` ハンドラテストで `tokenHandle` フィールドの保存を検証
- サブタスク 6（proxy.ts handle 反映）: `proxy.test.ts` に「auth_hash 既知時に state.masters の tokenHandle が更新される」ケースを追加
- finding #1 の改修を行う場合: `main.test.ts:1832-1860` の期待値を更新

### R4. `formatUtil` / `formatReset` の共通化（finding #4 対応）

サブタスク 8 の完了条件に以下を追加:

- token-cli.ts から `formatUtil` / `formatReset` / `formatSelectable` を export する（または `token-format.ts` 等の共通モジュールに切り出す）
- pool-cli.ts は import して再利用、コピペ禁止
- `bun test token-cli.test.ts` が export 後も pass することを確認

### R5. その他の minor 修正

- finding #5: §2.2 か pool-surface-row.ts のコメントに「ブロッカー閾値（A019 §95%）と表示警告閾値（task 仕様 §80%）は別もの」と 1 行注記
- finding #6: `┌─` の開始インデントを既存セクションヘッダーと揃えるか、外側 60 文字に拡張するかを Decision Log で明示
- finding #7: サブタスク 7 から `case "pool"` 追加を削除（サブタスク 8 に集約）
- finding #8: agents シリアライズの `spawnedAt` / `taskTitle` 欠落について「本タスクスコープ外（別タスクで対応）」とする旨を Decision Log に追加

---

以上の修正後、再レビューで critical findings が解消されていれば Approved 可能。
