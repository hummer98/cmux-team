# Seed: Slash Commands

コマンドは `commands/` に配置。プラグインインストール時は自動で参照され、
install.sh 使用時は `~/.claude/commands/` にコピーされる。

全13コマンド。

---

## /start

**File:** `start.md`

**Purpose:** チーム体制を構築する（daemon + 固定2x2レイアウト + Master 起動）。

**Behavior:**
1. Manager daemon の実行ファイル（`manager/main.ts`）を検索（プラグインキャッシュ or ローカル）
2. 依存関係インストール（`bun install`）
3. `bun run main.ts start` で daemon 起動
4. daemon が自動で以下を実行:
   - `.team/` インフラ作成（ディレクトリ、team.json、.gitignore）
   - 固定2x2レイアウト構築（4ペイン、5 surface）
   - Conductor 3台を常駐 Claude セッションとして起動
   - Master surface で Claude 起動
   - TUI ダッシュボード表示
   - プロキシサーバー起動

**Arguments:** なし

**allowed-tools:** `Bash, Read`

---

## /master

**File:** `master.md`

**Purpose:** Master ロールを再読み込みする（`/clear` 後の復帰用）。

**Behavior:**
1. `.team/prompts/master.md` を読む
2. ファイルの指示に従い Master として動作開始
3. `.team/` が存在しない場合は `/start` の実行を案内

**Arguments:** なし

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-status

**File:** `team-status.md`

**Purpose:** チームの現在の状態を表示する。

**Behavior:**
1. `.team/team.json` を読む
2. 真のソースから直接情報を取得:
   - Manager 画面: `cmux read-screen`
   - Conductor 一覧: `cmux tree`
   - タスク状態: `ls .team/tasks/` + `cat .team/task-state.json`
   - 完了履歴: `grep task_completed .team/logs/manager.log`
3. アーキテクチャサマリー表示（4層構造）
4. Manager 健全性チェック

**Arguments:** なし

**allowed-tools:** `Bash, Read, Glob, Grep`

---

## /team-disband

**File:** `team-disband.md`

**Purpose:** 全層を終了しチームを解散する（bottom-up: Agent → Conductor → Manager → cleanup）。

**Behavior:**
1. `.team/team.json` の存在確認
2. **Layer 1**: Agent 終了（`/exit\n` + surface close）
3. **Layer 2**: Conductor 終了（`/exit\n` + surface close）
4. **Layer 3**: git worktree クリーンアップ
   - 未マージの worktree は警告（`force` 引数で強制削除）
5. **Layer 4**: Manager daemon 終了（SHUTDOWN メッセージ → 最大15秒待機 → SIGTERM）
6. Manager ペインの close
7. サイドバー状態クリア
8. サマリー表示

**Arguments:** `$ARGUMENTS = "force"` → グレースフル停止をスキップ

**allowed-tools:** `Bash, Read, Write, Edit`

---

## /team-research

**File:** `team-research.md`

**Purpose:** リサーチエージェントを起動しトピックを並列調査する（最大3体）。

**Behavior:**
1. 前提チェック（team.json, CMUX_SOCKET_PATH, cmux）
2. トピック分析:
   - カンマ区切り → そのまま使用
   - 単一トピック → 3つのサブ質問に分解
   - 空 → ユーザーに質問
3. プロンプト生成（`common-header.md` + `researcher.md` テンプレート）
4. Agent を **1体ずつ** spawn（Trust 確認 → プロンプト送信 → 起動確認）
5. 完了待ち（`cmux wait-for` タイムアウト300秒）
6. 結果統合（サマリー・共通発見・相違点・推奨事項）
7. `.team/specs/research.md` に保存

**Arguments:** `$ARGUMENTS` = リサーチトピック or カンマ区切りサブトピック

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-spec

**File:** `team-spec.md`

**Purpose:** 要件を対話的にブレストし仕様を策定する。

**Behavior:**
1. 既存 specs を読み込み（requirements.md, research.md, team.json）
2. コードベース構造をスキャン
3. 対話的ブレスト（2-3問ずつ）:
   - プロジェクト概要（What/Why/Who）
   - 機能要件（Must/Nice/Out of scope）
   - 非機能要件（性能・セキュリティ・互換性）
   - 技術的制約・前提条件
4. `.team/specs/requirements.md` を生成（REQ-001 形式）
5. ユーザー承認 → ステータス + タイムスタンプ追記
6. 次ステップ案内（`/team-design` or `/team-research`）

**Arguments:** `$ARGUMENTS` = 初期プロジェクト概要（任意）

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-design

**File:** `team-design.md`

**Purpose:** アーキテクト + レビュアーエージェントで設計フェーズを実行する。

**Behavior:**
1. 前提チェック（requirements.md の承認ステータス確認）
2. コンテキスト収集（要件・リサーチ・タスク・コードベース構造）
3. Architect spawn（タイムアウト600秒）
4. `.team/specs/design.md` に設計をコピー
5. ユーザー確認 → Reviewer 2体 spawn（タイムアウト300秒）
6. レビュー統合（Approved / Changes Requested）
7. 変更要求時: Architect に再フィードバック → 再設計ループ
8. 承認時: タスク生成オプション（`tasks.md` に書き出し）

**Arguments:** なし

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-impl

**File:** `team-impl.md`

**Purpose:** 実装エージェントを起動しコーディングタスクを並列実行する。

**Behavior:**
1. 前提チェック（design.md 存在確認）
2. タスク準備:
   - `tasks.md` 存在 → パース＋ステータス確認
   - なし → design.md から自動生成（コンポーネント分割、依存関係分析、`(P)` フラグ）
3. タスク選択（引数ベース: `all` / `1,2,3` / 空=全 `(P)` 未着手）
4. Implementer spawn（1体ずつ）
5. 進捗モニタ（30秒間隔チェック）
6. 完了待ち（タイムアウト600秒）
7. バッチ処理（タスク > Agent 数の場合、ペイン再利用）
8. 結果統合（完了タスク・変更ファイル・テスト結果）

**Arguments:** `$ARGUMENTS` = タスク ID（"1,2,3" or "all"）、任意

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-review

**File:** `team-review.md`

**Purpose:** レビューエージェントを起動し実装をレビューする。

**Behavior:**
1. レビュー対象収集: `git diff HEAD~10 --stat -- . ':!.team'`
2. diff サイズに応じてレビュアー数決定:
   - ≤200行 → 1体
   - 200-500行 → 2体（ファイル分割）
   - \>500行 → 3体（モジュール分割）
3. Reviewer spawn + 完了待ち（タイムアウト300秒）
4. 結果統合（Approved / Changes Requested）
5. Critical/Major findings からタスクを自動作成
6. アクション提案（手動修正 / `/team-impl` 再実行 / `/team-review` 再実行）

**Arguments:** なし

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-test

**File:** `team-test.md`

**Purpose:** テストエージェントを起動しテストを作成・実行する。

**Behavior:**
1. テストスコープ決定（引数ベース: `unit` / `integration` / `e2e` / `all` / 空=自動検出）
2. コンテキスト収集（requirements, design, implementer outputs, 既存テスト, git diff）
3. Tester spawn（スコープごとに1体、最大3体）
4. 完了待ち（タイムアウト300秒）
5. テスト結果収集（Agent 出力 + 直接テスト実行）
6. テスト失敗からタスクを自動作成

**Arguments:** `$ARGUMENTS` = テストスコープ（"unit", "integration", "e2e", "all"）、任意

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-sync-docs

**File:** `team-sync-docs.md`

**Purpose:** ドキュメントをスペックと同期する。

**Behavior:**
1. `.team/specs/` の全ファイルを読み込み
2. `.team/docs-snapshot/` との差分検出
3. 変更なし → "already current" で終了
4. 変更あり → `docs/` 配下を生成・更新
5. スナップショット更新
6. git commit オプション
7. DocKeeper Agent のオプション起動

**Arguments:** なし

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-task

**File:** `team-task.md`

**Purpose:** タスクの作成・一覧・クローズ・表示を管理する。

**Behavior:**
- `""` → 全タスク一覧（Open / Closed 分離表示）
- `"create <title>"` → 新規タスク作成（`bun run main.ts create-task` 使用）
- `"close <id>"` → タスク close（`bun run main.ts close-task` 使用）
- `"show <id>"` → 詳細表示
- `"<title>"` → create の短縮形

**タスク状態管理:**
- ステータスは Markdown ファイルではなく `task-state.json` で管理
- 新規タスクは `draft` から開始（Manager は `ready` になるまで無視）
- `ready` になると Manager が Conductor に割り当て

**Arguments:** サブコマンド + 引数

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-archive

**File:** `team-archive.md`

**Purpose:** 完了タスクをアーカイブする（closed → archived）。

**Behavior:**
1. アーカイブディレクトリ作成: `.team/tasks/archived/$(date +%Y-%m-%d)/`
2. `task-state.json` から closed タスクを特定
3. 引数に応じて対象選定:
   - 空 → 全 closed タスク
   - `"N-M"` → ID 範囲
   - `"N"` → 単一 ID
4. タスクファイルを `archived/` に移動
5. `task-state.json` のステータスを `archived` に更新

**Arguments:** `$ARGUMENTS` = アーカイブ範囲（"", "1-33", "15"）

**allowed-tools:** `Bash, Read`
