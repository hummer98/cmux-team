# Implementation Fix Report (Round 2): T286

Inspector Round 1 の NOGO 指摘 3 件（F-1 / F-2 必須、F-3 推奨）に対応した。

## 修正完了項目

- [x] F-1: CLAUDE.md L434 `cmdStop（保険）` 削除
- [x] F-2: docs/spec/01-skill-cmux-team.md blockquote 位置修正（テーブル末尾＋次見出し前に移動）
- [x] F-3: i18n.ts 空行 2 連続整形（en side L181-184 付近 / ja side L846-849 付近）

## 変更詳細

### F-1: CLAUDE.md L434

`restartRequested / onReload / cmdStop（保険）の全経路で release され、正常系では`
→ `restartRequested / onReload の全経路で release され、正常系では`

plan.md §2.2 + §3.1 表（L227）で指示された「cmdStop 削除」「release 経路の列挙からも除く」の追従。

### F-2: docs/spec/01-skill-cmux-team.md

CLI サブコマンド表（L64〜）の途中に差し込まれていた blockquote を、テーブルの最終行（`cmux-team list-agent-instructions`）の後 + 次見出し（`### 1a. プロジェクト固有の追加指示`）の前に移動した。

- Before: L67 と L68（テーブル途中）で blockquote が差し込まれ、空行によりテーブル後半のレンダリングが破損していた
- After: L64〜L94 がテーブルとして空行を挟まずに完結、L96 に blockquote、L98 から次見出し

CommonMark の「空行でテーブル終端」ルールに適合。テーブル行の内容・列数は変更していない。

### F-3: skills/cmux-team/manager/i18n.ts

`help_status` の閉じバッククォート直後の空行 2 連続を、他の help エントリと同じ空行 1 行に揃えた。en side / ja side の両方を `replace_all` で同時修正。

## 変更差分（git diff 抜粋）

```diff
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -431,7 +431,7 @@ TypeScript daemon ...
 stale 判定は ...
 （空文字）時は保守的に locked 扱いとする。pidfile は shutdown / onFullQuit /
-restartRequested / onReload / cmdStop（保険）の全経路で release され、正常系では
+restartRequested / onReload の全経路で release され、正常系では
 必ず削除される。pidfile は daemon main.ts プロセスのみを指し、proxy は別ライフ
 サイクル。
```

```diff
--- a/docs/spec/01-skill-cmux-team.md
+++ b/docs/spec/01-skill-cmux-team.md
@@ -64,8 +64,6 @@
 |---------|------|
 | `cmux-team start` | daemon 起動 + Master spawn + レイアウト構築（レイアウト消失時は自己修復。T286） |
 | `cmux-team status` | ステータス表示（team.json + ログ末尾） |
-
-> `cmux-team stop` は v4.3.0 で廃止（T286）。cmux セッション終了で daemon が自動停止するため不要。手動停止は `kill <pid>`（`.team/daemon.pid`）で行う。
 | `cmux-team send TASK_CREATED` | タスク作成通知（`--task-id`, `--task-file` 必須） |
 ...
 | `cmux-team list-agent-instructions` | 8 Agent ロールの overlay 状況を一覧表示 ... |

+> `cmux-team stop` は v4.3.0 で廃止（T286）。cmux セッション終了で daemon が自動停止するため不要。手動停止は `kill <pid>`（`.team/daemon.pid`）で行う。
+
 ### 1a. プロジェクト固有の追加指示（agent instructions overlay、T247）
```

```diff
--- a/skills/cmux-team/manager/i18n.ts
+++ b/skills/cmux-team/manager/i18n.ts
@@ -180,3 +180,2 @@ Examples:
   cmux-team status --log 20
 `,
-
 
   help_spawn_conductor: `
```
（en side / ja side の 2 箇所）

## 検証結果

| 項目 | 結果 |
|------|------|
| `bun test --timeout 600000` | **852 pass / 0 fail**（Round 1 と同数、変動なし） |
| `bunx tsc --noEmit`（manager/） | **既存 3 件のみ**（conductor.ts:201, daemon.test.ts:3956, daemon.ts:1597）。新規エラー 0 件 |
| `grep -n "cmdStop（保険）" CLAUDE.md` | **0 件** |
| `grep -n "cmdStop" CLAUDE.md` | **0 件**（`cmdStop` の言及自体が CLAUDE.md から完全に消えた） |

## 作業境界の遵守

- Round 1 で実装した正しいコードには一切触れていない
- F セクション以外の変更なし（スコープ外修正禁止の遵守）
- `impl-summary.md` は Round 1 の記録として保持し、本レポートを新規作成
- git add / commit は行っていない（Conductor が完了処理で stage）
