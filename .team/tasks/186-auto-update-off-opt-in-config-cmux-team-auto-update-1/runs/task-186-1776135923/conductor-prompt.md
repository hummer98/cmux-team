# タスク割り当て

## タスク内容

---
id: 186
title: auto-update をデフォルト OFF + opt-in 化（config / CMUX_TEAM_AUTO_UPDATE=1）
priority: high
created_at: 2026-04-14T03:05:23.849Z
---

## タスク
# auto-update をデフォルト OFF + opt-in 化

## 背景

`checkNpmUpdate()`（`skills/cmux-team/manager/daemon.ts:1303-1347`）が 5 分おきに npm registry をチェックし、新バージョンがあれば自動で `npm install -g @hummer98/cmux-team@latest` + daemon 再起動を行う。

しかしユーザーから「auto-update が止まらない」報告がある。主因は **複数 Node 環境（nvm/brew/system 等）で `npm install -g` の投入先と稼働中 daemon の bin 解決先が不一致** で、永続的にバージョンが揃わず `latestVersion > currentVersion` が毎回 true になり続けることと推測される。加えて `lastNpmCheckAt`（`daemon.ts:132`）が揮発なので restart 直後に即再チェックが走る。

恒久対処（無限ループ検出、同一バージョンチェック、lastNpmCheckAt 永続化など）は別タスクとする。**本タスクではまず「デフォルト OFF + 明示的 opt-in」に切り替えてユーザーのブロッカーを解消する**。

## 実装スコープ

### 1. 環境変数による opt-in

`CMUX_TEAM_AUTO_UPDATE=1`（または `true`）のときのみ auto-update を有効化する。未設定 or その他の値ならスキップ。

### 2. config ファイルによる opt-in

`.team/config.json` に以下のフィールドを追加（存在しなければ undefined 扱い）:

```json
{
  "layout": "wide",
  "autoUpdate": true
}
```

`autoUpdate: true` が設定されていれば有効化。未設定 or `false` なら無効。

### 3. 優先順位

1. 環境変数 `CMUX_TEAM_AUTO_UPDATE` が設定されていればそれを採用
2. それ以外は `.team/config.json` の `autoUpdate` を参照
3. いずれも未設定ならデフォルト **OFF**

### 4. 実装箇所

`skills/cmux-team/manager/main.ts:588-595` のメインループ内 npm チェック分岐の手前で、有効/無効を判定する。

```ts
// 疑似コード
const autoUpdateEnabled = resolveAutoUpdateEnabled(state);
if (autoUpdateEnabled && Date.now() - state.lastNpmCheckAt >= NPM_CHECK_INTERVAL) {
  const allIdle = [...state.conductors.values()].every(c => c.status === "idle");
  if (allIdle) {
    state.lastNpmCheckAt = Date.now();
    await checkNpmUpdate(state);
  }
}
```

`resolveAutoUpdateEnabled()` は `daemon.ts` または専用ユーティリティで定義する（既存の config 読み込み箇所が `main.ts` にあればそちらに寄せる）。

### 5. ログ出力

起動時（`daemon_started` 近辺）に auto-update の有効/無効を出力:

```
log("auto_update_config", `enabled=${enabled} source=${source}`);
// source: "env" | "config" | "default"
```

### 6. 既存 config 読み込みとの整合

`.team/config.json` の読み込みは既に layout 解決で行われているはず（`main.ts` 周辺）。そこに `autoUpdate` フィールドの読み込みを相乗りさせる。スキーマ定義（`schema.ts`）がある場合は Zod 定義にも追加する。

### 7. テスト（手動確認）

```
# デフォルト（環境変数・config どちらもなし）
cmux-team start
→ manager.log に "auto_update_config enabled=false source=default"
→ 5 分経過しても npm チェックが走らない

# 環境変数で有効化
CMUX_TEAM_AUTO_UPDATE=1 cmux-team start
→ manager.log に "auto_update_config enabled=true source=env"
→ 5 分後に npm_update_check 系ログが出る

# config で有効化
echo '{"autoUpdate": true}' > .team/config.json
cmux-team start
→ "auto_update_config enabled=true source=config"
```

## ドキュメント更新

- `CLAUDE.md` の適切な箇所（インフラ系セクション）に「auto-update はデフォルト OFF、有効化方法」を追記
- `README.md` / `README.ja.md` に同様の記述を追加（該当セクションがあれば）

## 注意

- デフォルト OFF にするのが本タスクの目的。既存ユーザーで auto-update が動作していたケースは手動 opt-in が必要になるが、そもそも問題報告が出ている機能なので意図的な挙動変更として許容する
- 既存の `checkNpmUpdate()` 関数自体は変更不要（呼び出し側で有効/無効を判定する）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-186-1776135923` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-186-1776135923
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-186-1776135923/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/186-auto-update-off-opt-in-config-cmux-team-auto-update-1/runs/task-186-1776135923
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/186-auto-update-off-opt-in-config-cmux-team-auto-update-1/runs/task-186-1776135923/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
