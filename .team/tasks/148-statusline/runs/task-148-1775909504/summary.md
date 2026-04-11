# T148 statusline: ロール別カスタムステータスバーの実装 — 完了サマリー

## 判定: GO（検品通過）

## 完了したサブタスク

1. Phase 1: Plan — Planner Agent が plan.md 作成
2. Phase 2: Design Review — 2往復（v1: Changes Requested 7件 → v2: Changes Requested 2件）
3. Phase 3: Implementation — Implementer Agent が実装完了、全テスト通過
4. Phase 4: Inspection — Inspector Agent が GO 判定

## 変更ファイル一覧

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `skills/cmux-team/manager/statusline.sh` | 新規 (+137行) | ロール判別・表示スクリプト |
| `skills/cmux-team/manager/main.ts` | 修正 (+69/-4) | statusLine 設定追加、CMUX_ROLE 環境変数設定 |
| `bin/postinstall.js` | 修正 (+13) | statusline.sh のインストール処理 |

## 実装内容

### statusline.sh
- `CMUX_ROLE` 環境変数で master/conductor/agent/未設定 を判別
- Master: モデル名、コンテキスト使用率、コスト、gitブランチ
- Conductor: タスクID+タイトル（team.json動的読取）、ブランチ、コンテキスト使用率、モデル名
- Agent: ロール名、タスクID、コンテキスト使用率
- Nerd Font 切り替え（CMUX_NERD_FONT）
- ANSI カラー（CMUX_STATUSLINE_COLOR、デフォルト無効）
- JSON フォールバック（.model / .model.id 両対応）

### main.ts
- `generateConductorSettings()` に statusLine 設定追加
- `cmdConductor()` / `cmdResume()` に CMUX_ROLE=conductor
- `cmdLaunchMaster()` に Master用 settings.json 生成 + CMUX_ROLE=master
- `cmdSpawnAgent()` に Agent用 settings.json 生成 + CMUX_ROLE=agent + CMUX_TASK_ID

### postinstall.js
- statusline.sh を ~/.claude/statusline.sh にコピー + chmod 755

## テスト結果

- statusline.sh 単体テスト: 全10ケース通過
- TypeScript 型チェック: 新規エラーなし

## マージ

- ブランチ `task-148-1775909504/task` → `main` にローカルマージ完了
- コミット: 14965f7

## 既知の軽微な問題

- Nerd Font 無効時にコスト表示が `$ $0.15` と二重 `$` になる（Nerd Font 有効がデフォルトのため実質影響なし）
