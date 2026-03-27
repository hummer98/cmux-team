# Contributing

## リポジトリ構造

```
cmux-team/
├── .claude-plugin/
│   ├── plugin.json                   # プラグインマニフェスト
│   └── marketplace.json              # Marketplace カタログ
├── skills/
│   ├── cmux-team/
│   │   ├── SKILL.md                  # 4層アーキテクチャ定義スキル
│   │   ├── templates/                # エージェントプロンプトテンプレート
│   │   ├── scripts/                  # ランタイムスクリプト（spawn-conductor.sh 等）
│   │   └── manager/                  # TypeScript daemon
│   │       ├── main.ts               # CLI エントリポイント
│   │       ├── daemon.ts             # メインループ + surface 管理
│   │       ├── dashboard.tsx         # ink TUI ダッシュボード
│   │       ├── conductor.ts          # Conductor spawn/monitor/collect
│   │       ├── master.ts             # Master surface 管理
│   │       ├── queue.ts              # ファイルキュー
│   │       ├── schema.ts             # zod スキーマ
│   │       ├── task.ts               # タスク依存解決
│   │       ├── template.ts           # テンプレート検索・変数展開
│   │       ├── cmux.ts               # cmux コマンドラッパー
│   │       ├── logger.ts             # ロガー
│   │       ├── e2e.ts                # E2E テストランナー
│   │       ├── *.test.ts             # ユニットテスト
│   │       └── package.json          # 依存: zod, ink, react
│   └── cmux-agent-role/
│       └── SKILL.md                  # サブエージェント行動規範
├── commands/                         # スラッシュコマンド定義（plugin で配布）
├── .claude/commands/                 # プロジェクトローカルコマンド（/release 等）
├── CLAUDE.md                         # 開発ガイドライン
├── CHANGELOG.md                      # 変更履歴
└── CONTRIBUTING.md                   # このファイル
```

## 開発環境セットアップ

```bash
git clone https://github.com/hummer98/cmux-team.git
cd cmux-team

# manager の依存インストール
cd skills/cmux-team/manager
bun install
```

## テスト

### ユニットテスト

```bash
cd skills/cmux-team/manager
bun test
```

39 テスト:
- タスクパース、依存解決、優先度ソート
- キュー送受信、バリデーション、処理済み移動
- ユースケースシナリオ（順序実行、並列→統合、割り込み TODO）
- エラーハンドリング（循環依存、不正 YAML、存在しない依存先）

### E2E テスト

cmux 内で実行する必要があります。実際に Claude Code を起動してタスクを実行します。

```bash
cd skills/cmux-team/manager

# 全シナリオ実行
./e2e.ts all

# 個別シナリオ
./e2e.ts sequential    # UC1: 順序付き依存実行
./e2e.ts parallel      # UC2: 並列調査 → 統合
./e2e.ts interrupt     # UC3: 実装中の割り込み TODO
```

**結果アーティファクト** (`.team/e2e-results/<timestamp>/`):
- `results.json` — pass/fail、所要時間
- `snapshots/` — 各シナリオの manager.log、queue メッセージ、closed タスク
- Conductor セッション ID → `claude --resume <id>` で全対話ログ参照

### 型チェック

```bash
cd skills/cmux-team/manager
npx tsc --noEmit
```

## プロンプト編集ルール

**テンプレート (`skills/cmux-team/templates/*.md`) がソースオブトゥルース。**

`.team/prompts/*.md` は派生物であり、直接編集してはなりません。

| やること | やらないこと |
|---------|-------------|
| `skills/cmux-team/templates/master.md` を編集 | `.team/prompts/master.md` を直接編集 |
| `skills/cmux-team/templates/manager.md` を編集 | `.team/prompts/manager.md` を直接編集 |
| 編集後に `/start` で再生成 | ランタイムだけ書き換えて終わり |

## リリース

```bash
# プロジェクトローカルコマンド
/release
# または
/release 3.0.0  # バージョン指定
```

`/release` が以下を一括実行:
1. コミット分析 → バージョン自動判定
2. CHANGELOG.md 更新
3. plugin.json バージョン更新
4. コミット・push
5. GitHub Release 作成
6. plugin marketplace キャッシュ更新
7. 旧キャッシュ削除
8. plugin reinstall

## コーディング規約

- **ドキュメント・コメント**: 日本語
- **コード**: 英語
- TypeScript: strict mode、bun ランタイム
- テンプレート: `{{VARIABLE}}` プレースホルダー
- コマンド: YAML frontmatter + Markdown
