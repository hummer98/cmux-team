# T276 Summary

## 完了内容

conductor-role.md の完了時処理 Step 8（rebase）と Step 9（ff-only merge）を ai-web-builder T006 の事例に合わせて改修し、reason 空禁止ガードを追加した。

## 変更ファイル

| ファイル | 差分 |
|---------|------|
| `skills/cmux-team/templates/ja/conductor-role.md` | +57 / -6 |
| `skills/cmux-team/templates/en/conductor-role.md` | +57 / -6 |

`docs/spec/04-templates.md` は Step 8/9 の具体実装を記載していないため変更不要。

## 主な改修内容

1. **Step 8 rebase target を ahead-side 優先に**
   - `git merge-base --is-ancestor origin/<main> <main>` かつ SHA 不一致なら `REBASE_TARGET=<main>`（local）、それ以外は `origin/<main>`
   - push しない運用で Step 9 の ff-only を成立させるため
   - 見出しも `Step 8: origin/{{MAIN_BRANCH}} に rebase する` → `Step 8: {{MAIN_BRANCH}} に rebase する` に変更
2. **Step 9 ff-only 失敗時の判断必要レポート追加**
   - `git status` / worktree HEAD / local main HEAD / ブランチ名を出力
   - worktree 温存、Step 10/11 を skip、`CONDUCTOR_DONE --success false --reason "..."`
3. **Step 8 / Step 9 の `--reason "..."` 必須化**
   - **bold** で明記、reason 空だと manager.log の `conductor_done_unresolved` に `reason=-` で残りデバッグ不能になる背景を 1 行添付

## 検証

- Plan の bash 判定ロジックを reviewer / inspector が bash 構文 (`bash -n`) で確認済み
- ja/en で bash 実装完全同一、コメント言語のみ差異
- `^```bash` 数 = ja:15 / en:15、`^### Step` 数一致、`^#### ` サブセクション数 ja:5 / en:5
- プレースホルダ残存は既存 Researcher サンプル内の literal のみで T276 由来の新規なし
- Inspector 判定: **GO**

## エージェント実行履歴

| Phase | Agent surface | 成果物 |
|-------|--------------|-------|
| Plan | surface:371 | plan.md |
| Impl | surface:372 | impl-report.md + 2 ファイル修正 |
| Inspection | surface:374 | inspect-report.md（GO 判定） |

## 納品

- ローカルマージ（main ブランチに fast-forward）
- マージコミット SHA: 後段で埋める
