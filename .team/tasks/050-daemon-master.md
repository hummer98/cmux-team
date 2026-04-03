---
id: 050
title: daemon再起動時にMasterセッションを再利用する（マーカーファイル方式）
priority: high
created_at: 2026-04-03T01:20:47.280Z
---

## タスク
## 概要

daemon再起動時（cmux-team stop → start）に既存のMasterセッションを再利用する。
Conductorと同じマーカーファイル方式を採用。

## 現状の問題

- Conductorは `.team/conductors/conductor.surface:N` マーカーファイルで永続化されており、daemon再起動後も検出・再利用される
- Masterは `team.json` の `master.surface` フィールドにのみ記録されているため、stop/start時に消失し新規spawnされてしまう

## 実装方針

### 1. マーカーファイルの書き込み（master.ts）

`spawnMaster()` 成功時に `.team/master.surface` ファイルを作成し、surface ID を書き込む。

### 2. 既存Masterの検出（daemon.ts:startMaster）

daemon起動時の `startMaster()` で:
1. `.team/master.surface` ファイルを読み込み
2. `cmux.validateSurface()` で生存確認
3. 生存 → surface を再利用（spawn スキップ）
4. 死亡 → マーカー削除 → 新規spawn → 新マーカー作成

### 3. stop時の挙動

`cmux-team stop` 時にマーカーファイルは**削除しない**（次回startで再利用するため）。

### 対象ファイル

- `skills/cmux-team/manager/master.ts` — マーカー書き込み追加
- `skills/cmux-team/manager/daemon.ts` — startMaster() の検出ロジック改修
- Conductor の `.team/conductors/` マーカー実装を参考にする

### 参考: Conductorのマーカー実装

`conductor.ts:initializeConductorSlots()` でマーカーファイル作成:
```
.team/conductors/conductor.surface:N
```

`daemon.ts:initializeLayout()` でスキャン:
```typescript
const files = await readdir(conductorsDir);
const surfaces = files.filter(f => f.startsWith('conductor.surface:'));
```

Masterも同パターンで実装する。
