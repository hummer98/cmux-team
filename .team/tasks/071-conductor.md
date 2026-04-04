---
id: 071
title: Conductor の自己登録方式への移行（疎結合化）
priority: medium
created_at: 2026-04-04T08:03:46.911Z
---

## タスク
## 背景

現在 daemon は起動時に固定スロット（maxConductors=3）を作成し state.conductors を管理している。
Conductor の追加・削除は daemon 内部でしか行えず、ユーザーが任意に Conductor を増やせない。

## ゴール

cmux-team spawn-conductor コマンドを新設し、Conductor が自己登録する疎結合な構造に移行する。
デフォルトの起動（split×3 + Conductor3体）は見た目・動作ともに変わらない。

## 変更内容

### 1. キューメッセージに CONDUCTOR_REGISTERED を追加（schema.ts）

\`\`\`typescript
{ type: "CONDUCTOR_REGISTERED"; surface: string; paneId: string; timestamp: string }
\`\`\`

### 2. daemon の processQueue に CONDUCTOR_REGISTERED ハンドラ追加（daemon.ts）

\`\`\`typescript
case "CONDUCTOR_REGISTERED": {
  state.conductors.set(message.surface, {
    surface: message.surface,
    paneId: message.paneId,
    status: "idle",
    startedAt: message.timestamp,
    agents: [],
  });
  await log("conductor_registered", \`surface=\${message.surface} pane=\${message.paneId}\`);
  break;
}
\`\`\`

### 3. cmux-team spawn-conductor コマンドを新設（main.ts）

1. cmux new-split / new-surface でペイン作成
2. cmux identify で surface + paneId 取得
3. cmux send で cmux-team conductor <slot-id> を実行
4. CONDUCTOR_REGISTERED をキューに送信

### 4. cmux-team start の Conductor 初期化を spawn-conductor に移管（main.ts / daemon.ts）

- initializeConductorSlots を spawn-conductor の n 回呼び出しに置き換え
- maxConductors の概念を廃止（または spawn 数を制御する引数に変える）

### 5. team.json への永続化は既存の updateTeamJson が担う（変更なし）

## 確認ポイント

- cmux-team start で従来通り3ペイン起動・3 Conductor 登録されること
- cmux-team spawn-conductor を追加実行すると第4の Conductor として登録されること
- daemon 再起動後に team.json から Conductor が復元されること
