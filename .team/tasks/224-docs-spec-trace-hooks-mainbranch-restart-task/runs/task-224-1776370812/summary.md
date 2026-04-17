# T224 完了サマリー

## タスク

docs/spec 同期: T217 (trace-hooks) / T213 (mainBranch) / T204 (restart-task) の実装変更を docs/spec と cmux-team-guide SKILL に反映する。

## 変更ファイル

- `docs/spec/03-commands.md` — 末尾に `cmux-team trace` / `cmux-team trace-hooks` の関連 CLI 参照を追記（03 は slash コマンド中心のため、新セクション追加ではなく CLI へのクロスリファレンスとして記載）
- `docs/spec/05-install-and-infrastructure.md`
  - CLI サブコマンド表に `trace-hooks` 行を追加（T217）
  - `restart-task` 行を実装に合わせて書き直し（`assigned` / `aborted` 両対応、status を `ready` に戻し worktree / taskRunId / sessionId 等をクリア、T204 で aborted 対応）
  - `.team/config.json` スキーマ節に `mainBranch` フィールドを追加（解決順位・`main_branch_resolved` ログ出力・source タグ）
- `skills/cmux-team-guide/SKILL.md`
  - CLI 一覧に `cmux-team trace-hooks` を追加（T217）
  - `restart-task` 行の誤記「assigned → ready に戻す」を実装に合わせて修正（T204 で aborted からの再開にも対応）

## フロー

1. Implementer Agent spawn（surface:361）→ 3 ファイルを編集 → 完了
2. Inspector Agent spawn（surface:364）→ 独立検品 → **Verdict: GO**

## Inspector 所見

- 実装との一致: OK（main.ts の cmdTraceHooks / cmdStart / cmdRestartTask と一致）
- 整合性: OK（各ファイルの他セクションと矛盾なし、文体・見出しレベル維持）
- カバレッジ: OK（3 ファイルすべて修正要件を満たす）
- 参考情報（scope 外）: `docs/spec/01-skill-cmux-team.md:80` の restart-task 記述が旧仕様のまま残存。次回の docs-sync で拾うべき漏れ（本タスクの scope 外のため GO を妨げない）。

## 設計判断（Conductor）

- タスク本文は「restart-task は status を ready に戻さない」と記載していたが、`cmdRestartTask` / `restartFromAborted` の実装確認により **status は最終的に `ready` に戻る**ことを確認。Implementer プロンプトで「実装値をすべて実装ファイルから直接確認・推測しない」と指示していたため、Implementer は実装に合わせた正確な記述に修正した。Inspector も実装を正として GO 判定。
- 03-commands.md はスラッシュコマンド定義ファイルで `cmux-team` CLI サブコマンドを主題にしていないため、新セクションは作らず末尾の関連 CLI 参照として追加。CLI の一次情報は 05-install-and-infrastructure.md に維持。

## 残課題

- `docs/spec/01-skill-cmux-team.md:80` の restart-task 旧仕様記述（本タスク scope 外。次回の docs-sync 対象）
