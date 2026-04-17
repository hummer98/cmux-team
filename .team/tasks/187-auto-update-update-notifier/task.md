---
id: 187
title: auto-update を update-notifier に置換 + 更新実行タスクの自動起票
priority: medium
depends_on: [186]
created_at: 2026-04-14T03:11:40.991Z
---

## タスク
# auto-update を update-notifier に置換 + 更新実行タスクの自動起票

## 依存関係

T186（auto-update デフォルト OFF + opt-in 化）の後に実施する。T186 で導入した設定スイッチを拡張する形で本機能を追加する。

## 背景

現行の `checkNpmUpdate()`（`skills/cmux-team/manager/daemon.ts:1303-1347`）には以下の問題がある:

1. **パス不一致で無限ループ**: `npm install -g` の投入先と稼働中 daemon の bin 解決先が異なると、`currentVersion` が永久に変わらず毎回 install が走る
2. **稼働中断リスク**: 任意のタイミングで `npm install -g` → 自動再起動するため、Conductor 稼働中でも強制中断される
3. **フルスクラッチ実装**: 業界標準は「通知のみ、install はユーザーに委ねる」。`update-notifier` がデファクト（週間 2000 万 DL）

本タスクでは:
- 検出は `update-notifier` に委譲
- 実行は **タスク自動起票** で行う（Conductor の `--run-after-all` タスクとして全 idle になったタイミングで実行）

これによりパス不一致の無限ループ・稼働中断の両方が解消される。

## 実装スコープ

### 1. 依存追加

`skills/cmux-team/manager/package.json` に追加:

```
update-notifier: ^7.0.0  (ESM化の最新メジャー)
```

Bun 環境での動作を確認すること（update-notifier は Node 前提だが Bun でも動くはず。動かなければ `simple-update-notifier` に変更）。

### 2. 既存の `checkNpmUpdate()` を削除

- `daemon.ts:1292-1347` の `isNewerVersion` + `checkNpmUpdate` を削除
- `main.ts:30` のインポートから除去
- `main.ts:588-595` のメインループ呼び出しを削除
- `state.lastNpmCheckAt` フィールドを `DaemonState` から削除

### 3. update-notifier による検出関数を新設

`daemon.ts` に `checkUpdateAndNotify(state)` を新設:

```ts
// 疑似コード
import updateNotifier from "update-notifier";
const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
const notifier = updateNotifier({ pkg, updateCheckInterval: 1000 * 60 * 60 * 24 }); // 1日1回
await notifier.fetchInfo(); // 明示的にチェック（バックグラウンド任せにしない）
if (notifier.update && isNewerVersion(notifier.update.latest, notifier.update.current)) {
  // 1. ログに記録
  await log("update_available", `current=${current} latest=${latest}`);
  // 2. ダッシュボードに更新状態を反映（state.updateAvailable = { current, latest } を保持）
  // 3. タスク自動起票（後述）
}
```

呼び出しタイミングは daemon 起動時 1 回 + 12 時間ごとのタイマーでよい（update-notifier の内蔵キャッシュに任せる）。

### 4. タスク自動起票ロジック

新バージョン検出時、以下の条件で update タスクを起票:

**起票条件:**
- `autoUpdate` モードが `task`（下記 config 拡張）
- 同じバージョン向けの update タスクが未起票（既存 task.md のタイトルか metadata で判定）

**タスク内容:**

```
title: cmux-team を vX.Y.Z にアップデート
priority: low
status: ready
run-after-all: true
body:
  # cmux-team セルフアップデート

  ## 実行ポリシー

  operational task。サブエージェント spawn せず Conductor が直接 Bash 実行する。

  ## 手順

  1. npm install -g @hummer98/cmux-team@latest
  2. npm list -g @hummer98/cmux-team でバージョン確認
  3. インストールされたバージョンが期待値 (X.Y.Z) と一致することを検証
  4. 一致しなければ journal にパス不一致警告を記録（npm root -g / which cmux-team の出力を含める）
  5. close-task で完了記録

  ## 一致しなかった場合

  journal に以下を含めて close（成功扱い）:
  - 「install は成功したが稼働中 daemon への反映には別 prefix への手動インストールが必要」
  - npm root -g, which cmux-team, readlink -f $(which cmux-team) の出力
  - 対処: CMUX_TEAM_AUTO_UPDATE=0 で機能無効化するか、shell の PATH が参照する prefix に手動で npm install -g する
```

**重複防止:**

`.team/task-state.json` を走査し、`title` が `cmux-team を v<same-version> に` を含む open task があればスキップ。

### 5. 設定値の拡張（T186 の拡張）

T186 で導入した `autoUpdate: boolean` を **多値に拡張**:

| 値 | 動作 |
|----|------|
| `off`（デフォルト） | update-notifier も走らせない |
| `notify` | update-notifier で検出・ログ表示・ダッシュボード反映のみ、タスク起票なし |
| `task` | 検出 + update タスクの自動起票（全 Conductor idle で Conductor が実行） |

環境変数 `CMUX_TEAM_AUTO_UPDATE` の値:
- `0` / `off` / 未設定 → `off`
- `1` / `notify` → `notify`
- `task` → `task`

config `.team/config.json`:

```json
{
  "autoUpdate": "off" | "notify" | "task"
}
```

T186 で boolean として実装していた場合は後方互換で `true` → `task` 相当、`false` → `off` 相当として扱う。

### 6. ダッシュボード表示

state に `updateAvailable: { current: string, latest: string } | null` を追加し、TUI ダッシュボード上部に以下のバナーを表示:

```
✨ cmux-team v3.45.0 available (current: v3.44.0)
   run: cmux-team self-update  or enable CMUX_TEAM_AUTO_UPDATE=task
```

EventBus（T184 で導入予定）経由で即時反映する。

### 7. `cmux-team self-update` 手動コマンドの追加

ユーザーが明示的に実行したいケース向けに:

```
cmux-team self-update
```

このコマンドは上記 update タスクを 1 本起票する（ready + 現在の他タスクが idle なら即実行される）。`create-task` を内部で呼ぶだけでよい。

### 8. ログイベント

| イベント | 記録タイミング |
|---------|--------------|
| `update_check_started` | 起動時 / 定期チェック開始時 |
| `update_available` | 新バージョン検出時 |
| `update_task_created` | update タスク自動起票時 (`task_id=NNN version=X.Y.Z`) |
| `update_task_skipped_duplicate` | 既存 update タスクがあってスキップしたとき |
| `update_check_failed` | fetch 失敗時（network error 等） |

### 9. テスト（手動）

```
# off モード
cmux-team start
→ update-notifier 走らない

# notify モード
CMUX_TEAM_AUTO_UPDATE=notify cmux-team start
→ 新バージョンがあれば update_available ログ + ダッシュボードバナー
→ タスク起票なし

# task モード（新バージョンがある想定）
CMUX_TEAM_AUTO_UPDATE=task cmux-team start
→ update_available ログ
→ update_task_created ログ
→ .team/tasks/ に update タスクが ready で出現
→ 全 Conductor idle になると Conductor が実行
→ npm install -g 実行 → 成功後に daemon 自動再起動（source_changed 経由）

# 重複防止
同じバージョン向けタスクが既に open なら起票スキップ（update_task_skipped_duplicate ログ）
```

## ドキュメント更新

- `CLAUDE.md` の auto-update セクション（T186 で追加される箇所）を 3 値に拡張
- `README.md` / `README.ja.md` に `CMUX_TEAM_AUTO_UPDATE` の使い方を追加
- 既存の「auto-update が無限ループする」ケースは本タスクの実装で解消することを CHANGELOG に明記

## 注意

- update-notifier は ESM 化されているため、import 形式に注意（Bun は ESM ネイティブなので問題ないはず）
- update-notifier は `~/.config/configstore/update-notifier-*.json` にキャッシュを保持する。ユーザーのホームディレクトリ書き込み権限に依存するため、CI 環境等では `NO_UPDATE_NOTIFIER=1` で無効化できることを確認
- 自動起票タスクは `--run-after-all` 付きとし、他タスクとの競合を避ける
- パス不一致の検出は update タスク実行時に行う（install 後の version 照合）。本タスクでは「警告を journal に記録する」までをスコープとし、機能自動無効化は別タスクとする
