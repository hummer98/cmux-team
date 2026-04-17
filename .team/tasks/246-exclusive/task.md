---
id: 246
title: タスク排他実行属性（exclusive）の追加
priority: medium
created_by: surface:47
created_at: 2026-04-17T11:12:34.497Z
---

## 背景

重大な調査・コンフリクト解消など、他タスクによるローカルマージが破滅的影響を及ぼしうる局面で使える「排他実行モード」を追加する。`--run-after-all` の亜種として設計する。

## 要求される挙動

exclusive タスクは以下 3 フェーズで動作する:

1. **drain**: 全 open タスクが closed になるまで待機（既存 `run-after-all` と同じ）
2. **exclusive run**: このタスクが assigned の間、Manager は新規タスクを一切 assign しない
3. **resume**: このタスクが closed になった後、通常の assignment を再開

走行中のタスクを abort する必要はない（drain フェーズで待つため、排他は常にクリーンな状態から始まる）。

## 設計方針（Master ↔ ユーザー合意済み）

- **CLI フラグ**: `cmux-team create-task --exclusive`
  - `--exclusive` は `--run-after-all` 意味論を暗黙に含む（単独指定で可）
  - 既存の `--run-after-all`（非排他版）はそのまま残し、後方互換を保つ
- **task frontmatter**: `exclusive: true` を追加
- **schema**: `schema.ts` の task schema に `exclusive` フィールド（boolean, optional）を追加
- **Master の運用方針**: 特定パターンを検出したら Master はユーザーに「排他で起票しますか？」と**確認**したうえで付与する（自動適用はしない）

## 実装範囲

### コード
- `skills/cmux-team/manager/main.ts` — `cmdCreateTask` に `--exclusive` フラグ追加
- `skills/cmux-team/manager/task.ts` — `exclusive` プロパティの永続化・読み込み
- `skills/cmux-team/manager/daemon.ts` の `assignTask` — 以下 2 点の判定を追加:
  1. 対象が exclusive の場合、open タスクが全て closed か確認（drain 判定）
  2. 他に exclusive な assigned タスクがあれば、自分を含め何も assign しない
- `skills/cmux-team/manager/schema.ts` — frontmatter schema 更新

### ドキュメント
- `CLAUDE.md` — タスク属性・排他セマンティクスの説明追加（`--run-after-all` 節付近）
- `docs/spec/06-implementation-tasks.md` — タスク属性定義を更新
- `docs/spec/03-commands.md` — `create-task` のオプション一覧に `--exclusive` を追記
- `README.md` / `README.ja.md` — ユーザー向けの短い説明を追加（必要なら）

### スキル・テンプレート
- `skills/cmux-team/SKILL.md` — タスク属性セクションを更新
- `skills/cmux-team/templates/ja/master.md` — 「タスク間依存」節付近に「排他タスク」を追記 + **下記「Master が排他を提案すべきパターン」節を追加**
- `skills/cmux-team/templates/en/master.md` — 同上（英語版）

### release スキル（プロジェクトローカル）
- `.claude/commands/release.md` — 現在 `--run-after-all` を使っているが、リリース中の並列マージは事故の元なので **`--exclusive` に変更する**
  - 33行目付近: `--run-after-all \` → `--exclusive \`
  - 188行目付近の注意書き「既に `--run-after-all` タスクが存在する状態で…」を `--exclusive` タスクに更新
  - `description` の冒頭文も `--exclusive タスクとして起票` に変更

### Master が排他を提案すべきパターン（master.md に追加する内容）

以下のパターンを検出したら Master はユーザーに「このタスクは排他（`--exclusive`）にしますか？」と確認する。自動適用はしない（確認ステップを必ず挟む）:

- **コンフリクト解消タスク** — 複数 PR のマージ順調整・手動コンフリクト解消
- **リリース作業** — タグ付け・バージョンバンプ・npm publish を含むタスク
- **cmux-team 自身の更新** — `cmux-team-update` kind のタスク
- **破壊的な依存変更** — 共通ライブラリの major version up、lockfile 全体書き換え
- **同一ファイル群を触る複数タスクの調整役** — 例: 大規模リファクタの取りまとめタスク
- **ユーザーが「重大」「慎重に」「他タスクを止めて」等の強い表現を使った場合**

**提案フォーマット例**:
> このタスクは `<該当パターン>` に該当するため、排他実行（`--exclusive`）を推奨します。他タスクが全て closed になってから単独で実行されます。排他で起票しますか？

## 検証観点

- `--exclusive` 指定で作成したタスクが drain 完了後にのみ assigned になること
- exclusive タスクが assigned の間、他の ready タスクが assigned に遷移しないこと
- exclusive タスクが closed になった直後、通常の assignment が再開されること
- `run_after_all` 既存タスクと `exclusive` タスクが併存した場合の挙動が予測可能であること
- frontmatter `exclusive: true` の round-trip（書き込み→読み込み）が正しいこと
- Master 運用方針: master.md 読み込み後、排他対象パターンで確認ステップが挟まれること（手動検証）
- `/release` で起票されるリリースタスクが `exclusive: true` を持つこと

## 未決事項（実装時に判断）

- `exclusive` タスク同士が複数 ready にある場合の順序（ID 順で良いはず）
- `run-after-all` も `exclusive` も両方指定された場合の扱い（実質同じ意味なので冗長警告のみでよい）
