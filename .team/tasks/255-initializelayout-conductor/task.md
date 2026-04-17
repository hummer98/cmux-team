---
id: 255
title: initializeLayout の Conductor 復帰ロジックを単純化する
priority: high
created_by: surface:106
created_at: 2026-04-17T19:23:44.034Z
---

## タスク
## 背景

再起動時に Conductor の検出・復帰に失敗する事例が繰り返し発生している（例: 2026-04-18 03:58 の daemon 再起動）。

ログ:
```
[03:58:32] conductor_restore_skipped C[112] reason=pid_dead pid=null
[03:58:32] conductor_restore_skipped C[113] reason=pid_dead pid=null
[03:58:32] conductors_restored count=1 surfaces=C[46]
```

`maxConductors=2` に対して復元数 1 のまま新規スロット作成されず boot_completed。

過去ログにも同パターンが複数（04-16 07:17, 04-17 06:18, 04-17 11:15, 04-17 11:46, 04-17 16:37）。

## 根本原因

`skills/cmux-team/manager/daemon.ts:782-898` の `initializeLayout` ロジック:

1. team.json の conductors を 1 件ずつ **PID alive チェックのみ**で復元判定
2. pid=null または死亡なら `conductor_restore_skipped` でスキップ
3. **生きているものが 1 件でも復元できれば `return []` で終了** → 新規スロット作成フェーズ（`layout_creating_new_slots`）に進まない

→ 部分復元後の補充が無い。さらに cmux 側の pane 実在確認をしていないので、pid=null でも pane が残っているケース（今回の事例）を拾えない。

## やってほしいこと

シンプルなアルゴリズムに置き換える:

1. **team.json の各 Conductor エントリを見て、以下のマトリクスで復帰動作を決める**
   - surface 存在（`cmux tree --workspace <id>` で実在確認） × PID 生存 × taskRunId/sessionId の有無
   - surface あり + Claude 生存: そのまま登録（何もしない）
   - surface あり + Claude 死亡 + running task: session-id で Claude を resume 起動
   - surface 無し + running task: 新規 surface 作成 → worktree 移動 → session-id で resume
   - surface 無し + task 無し（idle）: このエントリは捨てる（新規作成分として扱う）

2. **上記を経て `maxConductors` に足りない分だけ新規 surface を作成**（現行の `initializeConductorSlots` 相当）

3. **worktree 消失時のフォールバック**: resume しようとしても worktree が既に削除されていたら、task を ready に戻す or journal 付きで abort（どちらが妥当か実装時に判断）

## 考慮点（要調査）

### 衝突しないこと
- `CONDUCTOR_REGISTERED` ハンドラ（daemon.ts:1212-1259）は既存 state があれば skip する idempotent 設計。復帰側で `state.conductors.set()` で pre-set しておけば、後続の self-register POST は skip される（衝突しない）。
- pre-set 時点で `status: "idle"` / `"running"` を適切に設定すること。

### 既存の割り切り踏襲
- **Agent は復元しない**（Conductor 配下の Agent 状態は破棄）
- **layout mismatch は警告のみ**（既存 pane を優先、余剰は放置、不足のみ補充）

### cmux API 使用上の注意（CLAUDE.md 参照）
- `cmux tree` は必ず `--workspace <id>` 付きで呼ぶこと（`state.workspace` を使用）
- `validateSurface(surface, workspace)` で workspace 限定確認

### 現行の動作保持
- resume 済み Conductor に対して resume 命令を二重送信しないこと（現行の `conductor_resume_noop` 相当の振る舞い）
- layout 超過（`state.conductors.size >= state.maxConductors`）時は warning のみで続行（hard cap にしない）

## 対象ファイル

- `skills/cmux-team/manager/daemon.ts`（`initializeLayout`）
- `skills/cmux-team/manager/conductor.ts`（`initializeConductorSlots` などの補充呼び出し）
- `skills/cmux-team/manager/cmux.ts`（`tree(workspace)` / `validateSurface(surface, workspace)` 利用）

## 完了条件

- 部分復元時（pid=null + pid alive 混在）でも不足分が新規作成されること
- surface が workspace に実在する Conductor は PID が死んでいても session-id で resume 復帰すること
- resume できない（worktree 消失等）場合は task を ready に戻す等の妥当なフォールバックがあること
- 既存の self-register フロー（CONDUCTOR_REGISTERED）と衝突しないこと
- `daemon.test.ts` の既存ケースが通ること + 新アルゴリズムに対応するテスト追加
