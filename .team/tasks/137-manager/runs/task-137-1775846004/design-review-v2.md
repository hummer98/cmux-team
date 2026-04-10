# Design Review v2: T137 サイドバーステータス更新

## Verdict: Approved

## Review of Previous Findings

### 1. [Major] computeSidebarStatus を純粋関数化（prevCategory を明示的引数に）

**修正済み。** `computeSidebarStatus()` は以下のシグネチャに変更された:

```typescript
function computeSidebarStatus(
  state: Pick<DaemonState, "conductors" | "rateLimit" | "pendingTasks" | "openTasks">,
  prevCategory: string | null,
): SidebarStatus
```

- `DaemonState` 全体ではなく `Pick<>` で必要フィールドのみ受け取る
- `prevCategory` は明示的引数として外部から渡される（`state.lastSidebarCategory` を直接参照しない）
- 副作用なし、同一入力に対して同一出力を返す純粋関数

呼び出し側（`updateSidebarStatus`）で `state.lastSidebarCategory` を渡し、結果を書き戻す責務分離も適切。

### 2. [Major] "done" 遷移条件の明確化（throttled → 完了パスの対応）

**修正済み。** "done" の条件が以下に変更された:

```typescript
if (state.openTasks === 0
  && prevCategory !== null
  && prevCategory !== "idle"
  && prevCategory !== "done") {
```

これにより:
- `prevCategory === "throttled"` → `"done"` を表示（修正前は見落としていたパス）
- `prevCategory === "error"` → `"done"` を表示
- `prevCategory === "running"` / `"running_pending"` → `"done"` を表示（従来通り）
- `prevCategory === "idle"` / `"done"` / `null` → `"idle"` に遷移（意図通り）

セクション6「エッジケース」で明示的に `throttled → 完了` パスのドキュメントが追加されており、意図が明確。

### 3. [Minor] status key の定数化

**修正済み。** セクション4.1で定数定義:

```typescript
const SIDEBAR_STATUS_KEY = "claude_code";
```

`updateSidebarStatus()` と shutdown 時の `clearStatus()` の両方でこの定数を使用。マジックストリングの散在を防止。

### 4. [Minor] tick()/updateTeamJson() 並列記述の矛盾解消

**修正済み。** セクション4.5で実行順序を明示:

> `tick()` → `updateTeamJson()` → `updateSidebarStatus()` の順に直列実行する。

セクション4.4でも「main.ts のメインループから `tick()` → `updateTeamJson()` の後に直列で呼ばれる」と記述。実際の main.ts メインループ（`main.ts:479-496`）は全て `await` で直列実行しており、計画と整合する。

## New Findings

### [Info] メインループ擬似コードと実装の差異

セクション4.5の擬似コードは:
```typescript
while (state.running) {
  await tick(state);
  await updateTeamJson(state);
  await updateSidebarStatus(state);
  await sleep(pollInterval);
}
```

実際の main.ts メインループは `try/catch` ラップ、`scheduleRefresh()` 呼び出し、npm 更新チェック、`sleepUntilWakeup(state)` を含む。「（抜粋）」と明記されており意図は明確だが、実装時には以下の配置が適切:

```typescript
try {
  await tick(state);
  await updateTeamJson(state);
  await updateSidebarStatus(state);  // ← ここに追加
  scheduleRefresh();
} catch (e: any) {
  await log("error", `tick: ${e.message}`);
}
```

`updateSidebarStatus()` を try ブロック内に配置することで、例外時にもログが記録される。Severity は低い（擬似コードレベルの話）。

### [Info] openTasks のセマンティクス確認

`openTasks` は closed/aborted/deleted 以外の全タスク（draft, ready, assigned 含む）をカウント（`daemon.ts:700-701`）。draft タスクが残っている場合、全 Conductor がタスク完了しても `openTasks > 0` のため "done" は表示されず "idle" に遷移する。これは draft = まだ作業指示が出ていないタスク、という意味では妥当な挙動だが、実装者が意図を理解しておくべき点。

### 全体評価

4件の指摘事項が全て適切に修正されている。エッジケースのドキュメント（セクション6）が充実しており、特に以下の点が良い:

- 起動直後の `lastSidebarCategory === null` による "idle" 初期表示
- auto-restart 時の `clearStatus` 不要判断
- `rateLimit === null` 時のフォールバック
- "done" が 1 tick のみ表示される仕組みの説明

実装に進んで問題ない。
