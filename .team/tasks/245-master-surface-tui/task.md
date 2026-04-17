---
id: 245
title: Master の surface が失われた際に TUI から安全に削除する仕組みを設計・実装
priority: high
created_by: surface:47
created_at: 2026-04-17T11:08:01.108Z
---

## タスク
## 背景

Master が起動している surface が失われた（pane を手動 close した、cmux 側の異常終了、OS 再起動など）場合、現状は以下の挙動になる:

1. SESSION_ENDED (reason != other) で `master.status = "disconnected"` に遷移
2. `state.masters` からは削除されない
3. TUI に⚠+ `disconnected` として永続表示され続ける
4. disconnected のまま pid も無いので PID watcher も動かず、復帰の見込みがないのに entry が残る

実例: ~/git/Dear で surface:67 が disconnected のまま残存、team.json/`.team/masters/surface_67.json` 両方に記録が残っている。

## 調査・検討事項

1. **どの条件で削除すべきか** — 候補:
   - (a) disconnected + pid なしが N 分（例: 10 分）継続したら自動 GC
   - (b) 定期的に surface の生存を確認（cmux tree）し、surface が消えていたら即削除
   - (c) ユーザーが TUI 上でキー操作で dismiss できる（例: カーソルを合わせて d キー）
   - (d) CLI `cmux-team forget-master --surface <id>` で手動削除
   - 複数併用もあり
2. **削除のリスク** — 削除後に同 surface で Master が復帰するケースはあるか？
   - surface は cmux 側の ID で、close されたら再利用されないはず（要確認）
   - fallback 経路（SESSION_STARTED 先行）で再作成されるので entry が消えていても問題にならない可能性
3. **永続ファイル (.team/masters/<surface>.json) の扱い** — state から削除するなら同時にファイルも削除（既存の `removeMaster` は両方やっている）
4. **team.json への反映** — updateTeamJson が次回トリガーで masters 配列から除外されるか確認

## 期待する対策

- 最低限 (d) `forget-master` CLI は欲しい（手動復旧手段として）
- 自動 GC を入れるなら (a) が安全側。(b) は cmux tree への依存が増えるので慎重に
- TUI 側のエクスペリエンス: disconnected が消えれば TUI は綺麗になるが、ユーザーが「昔ここに Master があった」ことを知る手段がなくなる → ログで十分か要検討

実装の粒度・どの条件を採用するかは Conductor が artifact (Axxx) で方針を立ててから選ぶ。

## 参考ファイル

- `skills/cmux-team/manager/daemon.ts`
  - `removeMaster` (L760-) — state + ファイル削除の既存実装
  - `SESSION_ENDED` ハンドラ (L1299-) — disconnected 化の経路
  - `spawnMasterPidWatcher` (L2032-) — pid 死亡検出
- `skills/cmux-team/manager/dashboard.tsx:338-380` — buildMasterSection（TUI 表示部）
- `skills/cmux-team/manager/main.ts` — CLI サブコマンド追加先（cmdForgetMaster 等）

## 完了条件

- 対策方針の artifact (Axxx) を作成
- 採用した手段（CLI / 自動 GC / TUI キー操作）の実装とテスト
- docs/spec/ の該当箇所（Manager プロトコル / TUI）の更新
