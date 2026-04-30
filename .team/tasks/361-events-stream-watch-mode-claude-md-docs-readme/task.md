---
id: 361
title: events stream + watch mode を CLAUDE.md / docs / README に反映
priority: medium
depends_on: [360]
created_by: surface:123
created_at: 2026-04-26T22:34:23.820Z
---

## タスク
T357-T360 の成果物を踏まえ、関連ドキュメントを更新する。

参照:
- issue: https://github.com/hummer98/cmux-team/issues/42
- T357: \`docs/spec/10-events-stream.md\` 新設
- T358: writer 実装
- T359: \`cmux-team events\` CLI
- T360: \`/cmux-team:watch\` command

## 実装範囲

### 1. \`docs/spec/glossary.md\` 更新

用語追加:
- \`events stream\` — Manager が emit する外向け event channel
- \`watch mode\` — \`/cmux-team:watch\` で起動する opt-in 自動処理 mode
- \`event channel\` — 用語の正式呼称

それぞれ T357 の spec へリンク。

### 2. \`docs/spec/00-project-overview.md\` 更新

アーキテクチャ図 / 通信プロトコル section に events channel を追記。**Phase 1 では opt-in であることを明記**。

### 3. \`CLAUDE.md\` 更新

\`§ 通信プロトコル\` または新規 section として「events stream（opt-in watch mode 用）」を追加:
- 存在の言及
- default 無効・user 能動 invoke の強調
- \`cmux-team events\` CLI の存在
- 詳細仕様は \`docs/spec/10-events-stream.md\` 参照

**Master template（\`skills/cmux-team/templates/master.md\`）には介入しない。** これは Phase 2 で議論。

### 4. README 更新（optional）

\`README.md\` / \`README.ja.md\` に watch mode の short reference を追加。

## 確認事項

- T360 の watch command が実際に動作することを確認した上で記載すること
- 「将来 default 化を検討」というトーンで書く（強い推奨を避ける）

## scope outside

- Master template / CLAUDE.md の Master セクション本体への組み込み（Phase 2、別 issue）
- Phase 2 に向けた default 化の判断基準確定（別 issue で議論）
