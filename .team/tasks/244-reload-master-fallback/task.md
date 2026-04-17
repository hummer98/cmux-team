---
id: 244
title: reload/再起動時に既存 Master セッションが検出できず fallback 経路に落ちる原因調査と対策
priority: high
created_by: surface:47
created_at: 2026-04-17T11:07:29.019Z
---

## タスク
## 背景

~/git/Dear プロジェクトで reload 時に surface:67 に Master が誤作成された事例。

manager.log 抜粋:
```
[2026-04-17T18:37:29+09:00] master_session_started_fallback U[67] pid=97409 reason=master_registered_not_received_yet
[2026-04-17T18:40:20+09:00] master_session_started U[67] pid=97409
[2026-04-17T18:45:17+09:00] master_session_idle U[67]
[2026-04-17T19:07:58+09:00] master_session_ended U[67] reason=close-agent
```

その後 pane を手動 close したが、state.masters からは削除されず disconnected で永続化（現在も team.json に残存）。

`.team/masters/surface_67.json`:
```json
{
  "surface": "surface:67",
  "status": "disconnected",
  "startedAt": "2026-04-17T09:37:29.258Z",
  "disconnectedAt": "2026-04-17T10:07:58.981Z"
}
```

## 調査事項

1. **既存 Master が `restoreMasters` で検出されなかった理由** — reload 時に `.team/masters/` に pid 記録がある surface_67.json が存在していたか、それとも pid なしで discard されていたか、あるいはそもそもファイル自体が無かったか
2. **`registerSelfAsMaster` (MASTER_REGISTERED POST) と SessionStart hook (SESSION_STARTED POST) の順序** — reload 後の Master 再起動経路で、どちらが先に daemon に届く設計か。現状の fallback 経路（daemon.ts:1157-1187）は「MASTER_REGISTERED が届く前に SESSION_STARTED が来る」ことを前提としているが、そのレースが恒常的に発生しているなら設計の問題
3. **Master spawn 時の pid 記録タイミング** — `spawnMaster` → pane 起動 → `cmdLaunchMaster` → `registerSelfAsMaster` のパスで pid がどこで確定するか、persistMasterFile のタイミング
4. **`reason=close-agent` の意味** — SESSION_ENDED の reason が close-agent なのは Master 用 pane なのに違和感がある。close-master のような Master 固有 reason がない or hook shell が共通か

## 期待する対策（方向性）

- reload 時の既存 Master 検出を確実にする（pid だけでなく surface 生存 + session_id で多重確認）
- fallback 経路をなるべく使わずに済む設計（MASTER_REGISTERED を先行させる）
- もし fallback に入った場合でも、後続の MASTER_REGISTERED で既存エントリを正常化する経路の検証

具体的な実装判断（どの確認をどこに挿すか、既存 PID watcher との統合など）は Conductor に委ねる。

## 参考ファイル

- `skills/cmux-team/manager/daemon.ts`
  - `restoreMasters` (L663-705)
  - `startMaster` (L707-754)
  - `SESSION_STARTED` ハンドラの fallback 経路 (L1156-1187)
  - `MASTER_REGISTERED` ハンドラ (L1240-1297)
- `skills/cmux-team/manager/master.ts` — persistMasterFile/listMasterFiles/deleteMasterFile
- `skills/cmux-team/manager/main.ts` — `cmdLaunchMaster` (registerSelfAsMaster の呼び出し箇所)
- `skills/cmux-team/manager/main.ts:530-569` — reload 経路
- ログ: `~/git/Dear/.team/logs/manager.log`（surface:67 の履歴）

## 完了条件

- 誤作成の再現手順 or 再現しない理由の特定
- 対策方針の artifact（Axxx）を書く
- 必要な実装変更（リスクが小さいもの）は本タスク内で実施。設計変更が必要な場合は follow-up タスクに分割
