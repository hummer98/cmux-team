# Seed: Slash Commands

コマンドは `commands/` に配置。プラグインインストール時は自動で参照される。

全7コマンド（`/master`, `/team-spec`, `/team-task`, `/team-archive`, `/artifact`, `/docs-sync`, `/trace-task`）。

> **注意:** 初期設計では13コマンドを想定していたが、ワークフロー系コマンド（research, design, impl, review, test）は廃止され、起動・停止・ステータスは CLI サブコマンド（`cmux-team start`, `cmux-team status`, `cmux-team stop`）に移行した。`docs-sync` はその後 dockeeper スキル経由で再追加されている。

---

## /master

**File:** `master.md`

**Purpose:** Master ロールを再読み込みする（`/clear` 後の復帰用）。

**Behavior:**
1. `.team/prompts/master.md` を読む
2. ファイルの指示に従い Master として動作開始
3. `.team/` が存在しない場合は `cmux-team start` の実行を案内

**Arguments:** なし

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
6. 次ステップ案内（タスクを作成して Conductor に委譲）

**Arguments:** `$ARGUMENTS` = 初期プロジェクト概要（任意）

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /team-task

**File:** `team-task.md`

**Purpose:** タスクの作成・一覧・クローズ・表示を管理する。

**Behavior:**
- `""` → 全タスク一覧（Open / Closed 分離表示）
- `"create <title>"` → 新規タスク作成（`cmux-team create-task` 使用）
- `"close <id>"` → タスク close（`cmux-team close-task` 使用）
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

---

## /artifact

**File:** `artifact.md`

**Purpose:** 会話中の知見をアーティファクトとして構造化・保存する。

**Behavior:**
- `""` → 新規作成（type とタイトルを対話で決定）
- `"list"` → 一覧表示
- `"show Axxx"` → 内容表示
- `"<type> <title>"` → 指定 type で新規作成（type: research, decision, session, spec, report）
- `"<title>"` → 新規作成（type は対話で決定）

**新規作成の詳細:**
1. type 決定（research / decision / session / spec / report）
2. タイトル決定
3. 次の ID 決定（A001 から連番、ゼロ埋め3桁）
4. 会話コンテキストから type に応じた構造で要約生成
5. `.team/artifacts/Axxx-<slug>.md` にフロントマター付きで書き出し

**フロントマター:**
```yaml
---
id: A001
type: research
title: "タイトル"
created: <ISO 8601>
author: <master | conductor-N | agent-xxx>
task: <関連タスクID>    # 任意
tags: [tag1, tag2]      # 任意
---
```

**Arguments:** サブコマンド + 引数

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /docs-sync

**File:** `docs-sync.md`

**Purpose:** `docs/spec/` を実装の現状に合わせて同期する（`skills/dockeeper/` スキル経由）。

**Behavior:**
1. `git log -1 -- docs/spec/` で最終更新コミット（base hash）を取得
2. `git log <base_hash>..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/` で実装変更を収集
3. `.team/task-state.json` の closed タスクを参照してコミット意図を補強
4. 7ファイル（00〜06）を順に読んで差分を抽出し、差分レポートを生成
5. デフォルトはユーザー確認後に Edit ツールで更新／`--dry-run` はレポートのみ／`--auto` は確認なしで更新
6. 完了報告（更新ファイル一覧 + スキップしたファイル一覧）

**Arguments:**
- 空 → 差分提示 → ユーザー確認 → 更新
- `--dry-run` → レポートのみ
- `--auto` → 確認なしで自動更新

**allowed-tools:** `Bash, Read, Write, Edit, Glob, Grep`

---

## /trace-task

**File:** `trace-task.md`

**Purpose:** タスクに関連した全セッション（Conductor + Agent）の履歴を取得・分析する。

**Behavior:**
1. 引数からタスク ID を抽出（`T` プレフィックスがあれば除去）
2. `cmux-team trace-task <task-id>` でセッション一覧を取得
3. 出力された JSONL パスを `Read` で開く（大きい場合は `offset` + `limit` で部分読み込み）
4. タイムライン・エラー・判断・成果物を要約して報告

**Arguments:** `$ARGUMENTS` = タスク ID（例: `T141`, `141`）

**allowed-tools:** `Bash, Read, Glob, Grep`
