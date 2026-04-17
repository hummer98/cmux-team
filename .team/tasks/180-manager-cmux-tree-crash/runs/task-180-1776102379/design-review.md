# Design Review: Manager の cmux tree タイムアウトを crash 判定から除外

## 判定: **Approved with Recommendations**

設計の方向性は妥当で、変更範囲も合理的に最小化されている。下記 Recommendations を実装時に反映すれば Approved として進めて良い。
（plan.md 自体の修正必須項目は無いが、実装段階で R1〜R3 を必ず取り込むこと。R4〜R6 は任意の改善余地。）

---

## 良い点

1. **問題の根本原因分析が的確**
   - §1.3 で「タイムアウトと真クラッシュを判別していない」ことを核心と特定。`validateSurface` の bool 戻り値の表現力不足を正しく問題視している。
   - 事象ログ（01:56:56→01:57:28 の 32 秒で 3 連続）から 60s/120s 閾値を逆算しており、実証データに基づく設計になっている。

2. **タイムアウト判別手法の信頼性**
   - Node `child_process.execFile` の `killed === true && signal === 'SIGTERM'` パターンは Node 標準仕様で安定。cmux daemon 側の正規エラー（非 0 exit code + stderr 出力）と明確に区別可能。実装は標準的で副作用なし。

3. **後方互換性の配慮**
   - `ConductorState` の新フィールドを optional にすることで既存セッション (`conductors/*.json`) を読み込んでも動作する。
   - `validateSurface` を `validateSurfaceDetailed === "alive"` のラッパとして残すことで、他呼び出し元（`assignTask` 等）に影響を与えない。

4. **CLAUDE.md ロギングポリシー準拠**
   - §4.1 で `monitor_tree_failed` / `validate_surface_failed` / `getPaneForSurface failed` / `setStatus failed` を全て `formatExecError` 統一する方針が明示されている。
   - 「error オブジェクトに stderr/stdout が付いている場合は必ず detail に含める」要件をカバー。

5. **環境変数による閾値調整**
   - `CMUX_TEAM_UNRESPONSIVE_MAX_TICKS` / `CMUX_TEAM_UNRESPONSIVE_MAX_SEC` で運用調整可能。既存の `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC` と同じパターンで一貫している。

6. **既存 crash 検出パスの保全**
   - §3.3 で `result === "missing"` 時は従来通り即 `kind=crashed` 判定を維持。surface が tree 出力に存在しない場合（=本物のクラッシュ）の検出は劣化しない。

7. **手動検証手順の具体性**
   - `kill -STOP $(pgrep -f 'cmux daemon')` / SIGCONT による誤判定再現は決定論的で再現性が高い。task-state.json で aborted にならないことの確認も明確。

---

## 懸念点・問題点

### C1. 期待ログ例（§6.3-4）が実際の挙動と食い違う可能性

plan §6.3-4 の期待出力例:
```
[...] monitor_tree_failed Command failed: cmux tree --workspace workspace:4 | stderr=Error: Command timed out
```

実際には `execFile` の `timeout` 超過は SIGTERM kill によって起きるため、cmux 側は stderr に「timed out」を書き出す機会がない。`stderr` は通常 **空** になり、`formatExecError` の出力は `Command failed: cmux tree --workspace ...` のみ（`stderr=` の `key=value` 自体が付かない、`sanitizeForLog` 空文字列なら省略仕様）になる可能性が高い。

これにより「stderr が含まれていること」を検証基準にすると、タイムアウトケースでは満たせない（=テストが誤って失敗する）。

### C2. cmux_unresponsive で disconnected 昇格した後の復帰パスがない

§3.5 で「DISCONNECT_TIMEOUT_SEC は据え置き」「disconnected 昇格以降はクラッシュとみなして良い」と整理されているが、`kind=cmux_unresponsive` で disconnected になったケースは厳密にはクラッシュではなく cmux 側の障害である。cmux daemon が 3 分後に復旧したとしても、Conductor は disconnected のまま 5 分経過で task abort されることになる。

「異常検知時のリカバリーは人間に委ねる」原則（CLAUDE.md `feedback_error_recovery`）に従うなら、自動 reopen はしない方針自体は正しい。ただし `kind=cmux_unresponsive` の場合は「人間が判断する時間」を稼ぐ意味で、disconnect_timeout を crash 系より長く取るオプションは検討余地がある。

### C3. `validateSurfaceDetailed` の混在エラー時の判定（§6.2）

「timeout + timeout + 真エラー → "missing"（混在時は missing 寄せ）」は、3 試行のうち 1 回でも真エラーが返れば cmux daemon は応答していると見なせるため妥当。ただし真エラー = ENOENT のような cmux 起動失敗系のケースは想定外（コマンド存在チェック相当で別経路）。現実的な真エラー（workspace not found 等）は cmux が起動して応答しているケースなので「missing」判定は正しい。判断自体に問題ないが、コメントで意図を残すことを推奨。

### C4. Agent 生存チェックを `unknown` 時にスキップする副作用

§3.3 の `continue` で Agent ループも飛ばす設計は妥当（同じ tree 出力に依存するため判定不能）。ただし長時間 unresponsive が続くと Agent の `surface_lost` 検出が遅延する。Agent 側は `cmux-team agent-done` 等の独立通知経路もあるため致命的ではないが、ログでは「Agent チェックを skip した」ことを明示しておくと運用時の混乱を防げる（既に `conductor_unresponsive` で代替できているので必須ではない）。

### C5. `runCmux` での `timedOut` 転写の必要性

§2.2 で `wrapped.timedOut = isExecTimeout(e)` を転写する案が示されているが、実は `validateSurfaceDetailed` 内で `e.cause` を辿るか、`isExecTimeout(e)`（wrapped 自体への適用は false になるが、`e.killed` / `e.signal` が wrapped に転写されていれば true）でも判定可能。
転写を**実装する場合**は、`stderr` / `stdout` と同様に `wrapped.killed = e?.killed` / `wrapped.signal = e?.signal` も併せて転写しないと `isExecTimeout(wrapped)` が機能しない点に注意。

### C6. `conductor_unresponsive` ログの粒度

§4.2 で「第一実装では毎 tick 出力で OK」とあるが、`UNRESPONSIVE_MAX_TICKS=6` × 10s = 60s 内で最大 6 行、その後 disconnected 昇格までの追加 60s で更に 6 行と、最大 12 行程度に収まる。`tick` 毎ログ禁止（CLAUDE.md「高頻度ループ内の過剰ログ」）に抵触するほどではないが、状態変化の節目（最初の失敗時 / 連続 N 回到達時 / 復帰時）のみに絞る方が「状態変化があった場合のみ記録」原則と整合する。

---

## Recommendations（plan.md にどう反映してほしいか）

### R1（必須）: 期待ログ例の修正

§6.3-4 の手動検証「ログ内容確認」で、execFile timeout は stderr が空であることを明示する:

```diff
- [...] monitor_tree_failed Command failed: cmux tree --workspace workspace:4 | stderr=Error: Command timed out
+ [...] monitor_tree_failed Command failed: cmux tree --workspace workspace:4
+   ※ execFile の timeout は SIGTERM kill のため stderr は通常空。
+     stderr が含まれることの検証は cmux 側の正規エラー（workspace not found 等）で行う。
```

受け入れ基準（§7）の「`monitor_tree_failed` 等の cmux エラーログに stderr が含まれる」は、**「stderr が存在する場合は必ず含まれる」** に文言修正。

### R2（必須）: cmux_unresponsive 時の disconnect_timeout 扱いを明記

§3.5 に以下の方針追加を推奨:

- `kind=cmux_unresponsive` で disconnected 化した Conductor については、現状 `DISCONNECT_TIMEOUT_SEC=300` で abort されるが、これは「人間が SIGSTOP 状況に気付いて手動介入するまでの猶予」と位置付ける。
- 将来的拡張として「unresponsive 起因の disconnected はタイムアウト中も tree 復旧チェックを継続し、復旧時に disconnected → running 復帰」を追加することを **本タスクスコープ外** として明記しておく（タスク追記 / TODO 化）。

### R3（必須）: `runCmux` での `killed`/`signal` 転写

§2.2 で `timedOut` フラグ転写を採用するなら、`stderr` / `stdout` と同様に `wrapped.killed` / `wrapped.signal` も転写すること。これがないと `isExecTimeout(wrapped)` が動かない。
**または** `validateSurfaceDetailed` 内で `e.cause` を辿って判定する実装に統一する。どちらかを §5 の変更ファイル一覧に明示。

### R4（任意）: `validateSurfaceDetailed` テスト戦略の具体化

§6.2 の「`runCmux` を vi.mock するか、`tree` を直接モック注入できるよう薄い refactor が必要」を、どちらの方針で行くか決めて plan に明記してほしい。最小コストは:

- `cmux.ts` 内に `treeImpl` 変数（テスト時に差し替え可能）を持ち、`tree()` は `treeImpl()` を呼ぶだけにする
- テストでは `treeImpl` を spy/mock 化して timeout 系・真エラー系・成功系を注入

### R5（任意）: `conductor_unresponsive` ログの間引き

毎 tick ログではなく以下に絞ることを推奨:

- 初回失敗時: `conductor_unresponsive_started surface=...`
- 閾値到達時: `conductor_unresponsive_threshold surface=... consecutive=N elapsed=Xs`
- 復帰時: `conductor_responsive_recovered surface=... after_failures=N elapsed=Xs`

これにより grep / dashboard 解析が容易になる。

### R6（任意）: §3.3 のコード断片に Agent skip ログを追加

`unknown` 時の `continue` 直前に `log("monitor_skip_agents", "reason=cmux_unresponsive surface=...")` を 1 回だけ出すと、運用時の解析がしやすい（必須ではない）。

---

## リスク評価

| リスク | 影響 | 確率 | 緩和策 |
|--------|------|------|--------|
| 真クラッシュの検出遅延（最大 60-120 秒） | 稼働中 Agent が孤立する時間が増える | 中 | UNRESPONSIVE_MAX_TICKS / SEC を環境変数で短縮可能。本物クラッシュ時は forceCloseDisconnectedConductor の 5 分後 abort で最終的に回収される |
| `treeFailureCount` のリセット漏れ | unresponsive → recovered が正しく検出されない | 低 | §3.3 の alive 復帰時リセットロジックで対応。テストで網羅 |
| 既存セッション読み込み時の互換性破壊 | daemon 起動失敗 | 低 | `treeFailureCount` / `treeFailureFirstAt` を optional にしているため後方互換は確保される |
| `isExecTimeout` の誤判定（cmux daemon が SIGTERM で終了するケース） | クラッシュを timeout と誤認 → unresponsive 経路に流れて 60-120 秒判定遅延 | 低 | cmux daemon の通常終了は SIGTERM ではなく SIGINT または SIGKILL。surface 自体は missing になるため `result === "missing"` で正しく crash 判定される |
| ログ量増加（`conductor_unresponsive` 連続出力） | manager.log の肥大化 | 低 | R5 で間引けば解消。現状でも最大 12 行程度なので実害なし |
| `disconnected (kind=cmux_unresponsive)` のまま 5 分後 abort | cmux 復旧後も task が失われる | 中 | R2 で対応方針を明記。本タスクスコープ外として TODO 化を推奨 |

---

## 結論

設計は「タイムアウトと真クラッシュの判別」という核心問題を正しく解いており、変更範囲・後方互換性・ログポリシー準拠の観点で十分に検討されている。R1〜R3 を実装段階で反映し、R4〜R6 を任意改善として進めれば、安全にマージできる品質に到達する。

**Approved（Recommendations 反映を前提）**
