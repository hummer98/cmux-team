---
allowed-tools: Bash
description: "リリース作業を --exclusive タスクとして起票する（全オープンタスク完了後に Conductor が単独実行）"
---

# /cmux-team:release

cmux-team のリリース作業を `--exclusive` タスクとして起票する。Master 自身は作業しない。オープンタスクが全て closed になった後、idle Conductor が release タスクを単独実行する（走行中は他の assignment が停止される）。

## 引数

`$ARGUMENTS` でバージョンを指定できる（省略時は Conductor がコミット履歴から自動判定）:

- `/release` — タスク実行時に自動判定
- `/release 2.2.0` — 指定バージョンで固定

## 手順

### タスク作成（Master はこれだけ）

```bash
VERSION_ARG="$ARGUMENTS"
if [ -n "$VERSION_ARG" ]; then
  TITLE="リリース v$VERSION_ARG"
else
  TITLE="リリース（バージョン自動判定）"
fi

cmux-team create-task \
  --title "$TITLE" \
  --status ready \
  --priority high \
  --exclusive \
  --body "$(cat <<'TASK_BODY'
# リリースタスク

cmux-team のリリース作業を Conductor 自身が直接実行する。

## 実行ポリシー（重要）

このタスクは **operational task（運用作業）** である。コード変更や設計判断を伴わないため以下を守る:

- **cmux-team の Researcher / Planner / Implementer / Inspector は spawn しない**（worktree 内での TDD / Plan / Inspection フェーズは不要）
- Conductor 自身が Bash で順次コマンドを実行する
- 失敗時は該当ステップだけやり直す（全体リトライ不要）

### 例外: doc-sync 用 background subagent（許可）

リリースコミットには直近の実装と同期した `docs/spec/` + `README` を含めるため、Step 0 で **Claude の `Agent` ツール（`subagent_type: general-purpose`, `run_in_background: true`）を 1 体だけ起動して dockeeper を実行する**。これは worktree や cmux タブを使わない built-in subagent であり、cmux-team の spawn-agent とは別経路。

理由:
- doc-sync は読み取り重作業（`git log` 解析 + 仕様書 10+ ファイル読み込み）。Conductor 本体に取り込むとコンテキストが膨らむ
- Step 1-2（バージョン判定・CHANGELOG ドラフト）と並行実行することで wall-clock を短縮できる
- subagent は `docs/spec/*.md` / `README.md` / `README.ja.md` のみを編集し、Conductor が編集する `CHANGELOG.md` / `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` とは disjoint なのでワーキングツリー競合は発生しない

## バージョン指定の読み取り方

タスクタイトルに `v<X.Y.Z>` が含まれていればそれを新バージョンとして採用する。`（バージョン自動判定）` と記載されていればコミット履歴から自動判定する。

## 重要な前提（worktree と main の扱い）

- このタスクは worktree 内で起動されているが、**リリースコミット/タグは main ブランチに直接打つ**
- `cd "$PROJECT_ROOT"` で main ブランチ側のプロジェクトルートに移動してから編集・commit・push を行う
- worktree 内にはリリース関連の差分を残さない

## 手順

> **フェーズ構造**:
> - **Phase A（並列）**: Step 0（doc-sync subagent）+ Step 1-2（version 判定 / CHANGELOG ドラフト）
> - **Phase B（同期点）**: Step 3 で subagent 完了待ち → Step 4-6（CHANGELOG / version bump / 1 commit / push / tag）
> - **Phase C（並列）**: Step 7（gh run watch をシェルバックグラウンド `&` で実行）+ Step 8-10（marketplace pull / cache cleanup / plugin reinstall を foreground）
> - **Phase D**: Step 11（gh watch wait → npm install -g）+ Step 12（close-task）

### 0. doc-sync を background subagent で起動（Phase A 並列開始）

`Agent` ツールで dockeeper を `run_in_background: true` で起動する。Conductor は subagent 起動後すぐに Step 1-2 へ進み、subagent の完了通知は runtime から非同期で受け取る（ポーリング不要）。

呼び出しパラメータ:

| field | value |
|---|---|
| `description` | `release doc-sync` |
| `subagent_type` | `general-purpose` |
| `run_in_background` | `true` |
| `prompt` | 下記の指示文（`$PROJECT_ROOT` は呼び出し側で実値に展開してから渡す） |

prompt の中身（実値を埋めて 1 つの文字列として渡す）:

```
あなたは cmux-team リリース直前の docs 同期を担当する subagent です。
cd <PROJECT_ROOT 実値> で main ブランチ側に入り、skills/dockeeper/SKILL.md の手順を
--auto モード相当で実行してください。

対象は docs/spec/*.md と README.md / README.ja.md と
skills/cmux-team-guide/SKILL.md のみ。CHANGELOG.md / package.json /
.claude-plugin/*.json には触れないこと（リリース本体の差分を上書きしない）。

やること:
1. git log -1 --format="%H %ai %s" -- docs/spec/ で base_hash を取得
2. 以降の skills/ commands/ bin/ package.json .claude-plugin/ コミットを収集
3. 各 docs/spec/*.md と README を読み、収集した変更と照合して必要な箇所のみ Edit
4. ステージングはしない（git add は Conductor 側でまとめて行う）
5. 完了したら、更新したファイル一覧と各ファイルの変更要約を返す

変更不要な場合は「変更なし」と報告するだけでよい。
既存の文体・構造を維持し、英日 README は対訳関係を保つこと。
```

### 1. 現在のバージョンとコミット履歴を取得

```
cd "$PROJECT_ROOT"
CURRENT=$(python3 -c "import json; print(json.load(open('.claude-plugin/plugin.json'))['version'])")
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  COMMITS=$(git log ${LAST_TAG}..HEAD --oneline)
else
  COMMITS=$(git log --oneline -20)
fi
```

### 2. バージョンを判定

タスクタイトルに `v<X.Y.Z>` が含まれていればそれを NEW_VERSION とする。未指定なら Conventional Commits で判定:

| キーワード | 変更レベル |
|---|---|
| `BREAKING CHANGE`, `!:` | major |
| `feat:`, `feat(` | minor |
| `fix:` / `chore:` / `docs:` のみ | patch |

コミット群で最も大きい変更レベルを採用。

### 3. doc-sync subagent の完了確認（Phase B 同期点）

Step 0 で起動した subagent の完了通知（runtime から非同期で届く）を受け取ってから Step 4 に進む。完了通知が Step 1-2 の処理中に既に届いていれば即座に Step 4 へ。まだ届いていなければ通知を待つ。

完了確認:
- subagent の最終メッセージから「更新したファイル一覧」または「変更なし」を読み取る
- `git status -s -- docs/spec/ README.md README.ja.md skills/cmux-team-guide/` で実際の編集ファイルを照合
- 想定外のファイル（`CHANGELOG.md` / `package.json` / `.claude-plugin/`）に触れていないことを `git status` で再確認。触れていたら `git checkout -- <file>` で破棄

subagent がエラー終了した場合は warning として記録し、doc-sync なしでリリースを続行（リリースを doc-sync で止めない）。

### 4. CHANGELOG.md を更新（main 側で）

`cd "$PROJECT_ROOT"` 後、CHANGELOG.md の先頭に追記:

```
## [X.Y.Z] - YYYY-MM-DD

### Added
- 新機能の説明

### Changed
- 変更の説明

### Fixed
- 修正の説明
```

**分類:** `feat:` → Added / `fix:` → Fixed / それ以外 → Changed。ユーザーが読んで意味がわかる説明に書き直す（コミットメッセージそのままコピーしない）。

### 5. バージョンを 3 ファイルで更新

- `package.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`（`plugins[0].version`、存在しない場合スキップ）

### 6. コミット・push・タグ（doc-sync 差分も同梱）

```
cd "$PROJECT_ROOT"
git add CHANGELOG.md package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
# doc-sync subagent が編集したファイルがあれば同じコミットに含める
git add docs/spec/ README.md README.ja.md skills/cmux-team-guide/ 2>/dev/null || true
git commit -m "chore: release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin main
git push origin "v${NEW_VERSION}"
```

### 7-10. Phase C（並列実行: gh run watch ＋ plugin キャッシュ更新）

push 完了後、`gh run watch`（npm publish workflow を待つ、約 2-3 分）と plugin キャッシュ更新（数十秒）は互いに独立しているので、シェルの `&` でバックグラウンド化して並列実行する。

```bash
cd "$PROJECT_ROOT"

# 7. GitHub Actions 監視をバックグラウンドで開始
sleep 5
RUN_ID=$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch ${RUN_ID} --exit-status > /tmp/gh-run-watch-${NEW_VERSION}.log 2>&1 &
GH_WATCH_PID=$!

# 8. plugin marketplace キャッシュ更新（foreground）
MARKETPLACE_DIR="${HOME}/.claude/plugins/marketplaces/hummer98-cmux-team"
if [ -d "$MARKETPLACE_DIR/.git" ]; then
  (cd "$MARKETPLACE_DIR" && git pull origin main)
fi

# 9. 旧バージョンの plugin キャッシュを削除（foreground）
CACHE_BASE="${HOME}/.claude/plugins/cache/hummer98-cmux-team/cmux-team"
LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
for dir in "$CACHE_BASE"/*/; do
  [ "$dir" != "$LATEST" ] && rm -rf "$dir"
done

# 10. plugin を再インストール（foreground）
claude plugin uninstall cmux-team@hummer98-cmux-team
claude plugin install cmux-team@hummer98-cmux-team

# Phase C 同期点: gh run watch の完了を待つ
wait ${GH_WATCH_PID}
GH_EXIT=$?
if [ ${GH_EXIT} -ne 0 ]; then
  echo "GitHub Actions release workflow failed (exit ${GH_EXIT})"
  cat /tmp/gh-run-watch-${NEW_VERSION}.log
  exit ${GH_EXIT}
fi
```

### 11. npm レジストリからローカルインストール

```
npm install -g @hummer98/cmux-team
```

`npm install -g .` は使わない（シンボリックリンクによる連鎖再起動を避けるため）。

### 12. close-task で完了記録

journal に以下を含めて `cmux-team close-task --task-id <id> --journal "..."` を実行:

```
リリース完了: v${CURRENT} → v${NEW_VERSION}
- タグ: v${NEW_VERSION}
- plugin: 更新済み
- npm: @hummer98/cmux-team@${NEW_VERSION}
- doc-sync: <更新ファイル数 or "変更なし">
```
TASK_BODY
)"
```

### 完了報告

```
リリースタスクを作成しました (T<id>)。
オープンタスクが全て closed になると Conductor が自動実行します。
進捗: cmux-team status
トレース: cmux-team trace-task <id>
```

## 注意事項

- 既に `--exclusive` タスクが存在しても `/release` は許可され、先行タスクが closed になってから自タスクが drain → 排他実行される（`--exclusive` 同士は共存可能）
- ただし非排他 `--run-after-all` タスクが既に存在する場合は `RUN_AFTER_ALL_CONFLICT` でエラーになる
- バージョン引数はタスクタイトルに埋め込まれ、Conductor がそれを読み取る
- Master はタスク作成以降リリース作業に関与しない
