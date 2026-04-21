---
id: 286
title: cmux-team start 自己修復 + stop コマンド廃止
priority: high
created_by: surface:488
created_at: 2026-04-21T02:39:45.153Z
---

## タスク
## 背景

KDG-SSO (~/git/KDG-SSO) で `cmux-team start` したが Conductor が起動しなかった。manager.log 解析で以下が判明:

- 前回 wide レイアウトで team.json に C[52]/C[53]/C[54] が記録されていた
- 今回 16x9 で再起動、cmux 側では 3 surface とも消失（`layout_mismatch_on_resume` + `surface_missing_no_task` x3）
- `daemon.ts:initializeLayout` は `conductorsFromJson.length === 0` のときだけ `initializeConductorSlots` に入る実装
- 全 discard された場合のフォールバック経路が無く、Conductor 0 のまま boot 完了
- 当初 `cmux-team stop && start` を案内していたが、stop は実運用で打たれない → stop 依存のガイダンス自体が不健全

## やること

### 1. 自己修復（メイン修正）

対象: `skills/cmux-team/manager/daemon.ts` の `initializeLayout`

- `planLayoutRestore` の結果で以下が全て空なら `initializeConductorSlots` にフォールバック:
  - `plan.alive`
  - `plan.resumeExisting`
  - `plan.resumeNewSurface`
- ログイベント追加: `layout_restore_empty_fallback kept=0 discarded=<N> layout=<wide|16x9>`
- `layout_mismatch_on_resume` と重なるケースも同経路でカバーされる（破壊的変更は起きない想定）
- 既存 conductor が 1 つでも残る場合（partial）は現状通り `layout_kept_partial` のまま維持

### 2. `cmux-team stop` サブコマンド廃止

- `skills/cmux-team/manager/main.ts` から `cmdStop` 実装と CLI 登録を削除
- help / usage 文言から削除
- `pidfile.ts` の release 経路を整理（shutdown / onFullQuit / restartRequested / onReload の release 経路は温存、cmdStop 経由のみ削除）
- 以下ドキュメントで `cmux-team stop` への言及を削除または書き換え:
  - `README.md`
  - `README.ja.md`
  - `CLAUDE.md`
  - `docs/spec/` 配下（grep で網羅）
  - `skills/cmux-team/SKILL.md`
  - `skills/cmux-team/templates/` 配下
- 代替手段を docs に明記: 「cmux セッション終了で daemon も終了」「手動停止は \`kill \$(cat .team/daemon.pid)\`」
- `layout_mismatch_on_resume` ログ中の「run 'cmux-team stop' then 'start'」ガイダンス文言も削除

### 3. 検証

- KDG-SSO 再現条件相当のテストシナリオを plan.md に記述
- 既存 conductor が生きているプロジェクトで `cmux-team start` 冪等実行 → 壊さないことを確認
- `cmux-team stop` が未知コマンド扱いになること
- `bun test` / `bunx tsc --noEmit` 新規エラー 0 件

### 4. CHANGELOG / リリース

- 破壊的変更（`cmux-team stop` 廃止）なので CHANGELOG に明記
- リリース自体は別タスクで `release` スキル経由

## 参考ログ

manager.log 抜粋 (2026-04-21T11:03:26+):
```
layout_mismatch_on_resume restored=wide current=16x9 — existing panes will be kept; run 'cmux-team stop' then 'start --layout=16x9' to rebuild
conductor_discarded C[52] reason=surface_missing_no_task
conductor_discarded C[53] reason=surface_missing_no_task
conductor_discarded C[54] reason=surface_missing_no_task
master_spawning
master_spawned U[487]
boot_completed
```
