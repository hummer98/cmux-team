---
id: 013
title: initializeLayout が daemon 自身の surface を生きた Conductor と誤認するバグ修正
priority: high
created_at: 2026-03-29T07:16:30.029Z
---

## タスク
## 問題

daemon 再起動時に team.json から復元された conductor の surface が daemon 自身の surface と一致する場合、initializeLayout() が「既存 Conductor が生きている」と判断してレイアウト初期化をスキップしてしまう。結果として Conductor スロットが作成されず Master だけが表示される。

## 再現手順

1. cmux-team start で起動（3 Conductor + Master 正常作成）
2. daemon を停止（team.json に conductor 情報が残る）
3. 同じ surface 上で cmux-team start を再実行
4. → Conductor が作成されず Master だけ表示される

## 原因箇所

skills/cmux-team/manager/daemon.ts の initializeLayout():

```typescript
if (state.conductors.size > 0) {
  const checks = await Promise.all(
    [...state.conductors.values()].map(c => cmux.validateSurface(c.surface))
  );
  if (checks.some(alive => alive)) return; // daemon 自身の surface を誤認
}
```

## 修正方針

validateSurface チェック時に daemonSurface と一致する surface を除外する。例:

```typescript
const checks = await Promise.all(
  [...state.conductors.values()]
    .filter(c => c.surface !== daemonSurface)
    .map(c => cmux.validateSurface(c.surface))
);
```

加えて、復元された conductor の surface が daemonSurface と一致する場合は conductors Map から削除する（stale エントリの除去）。
