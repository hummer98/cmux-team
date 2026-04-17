# タスク割り当て

## タスク内容

---
id: 170
title: Dashboard の Journal/Artifacts/Log タブ QoL 改善: activeTab と focusedArea の同期 + フッターヒント
priority: medium
created_at: 2026-04-12T04:32:05.083Z
---

## タスク
# 背景

`skills/cmux-team/manager/dashboard.tsx` の Journal / Artifacts / Log タブ周辺で、ユーザー体験上 2 つの問題がある。

## 問題 1: タブのハイライトと実際にスクロール・操作される対象が食い違う

`dashboard.tsx` には 2 つの別々の state がある:

- `activeTab: "journal" | "artifacts" | "log"` — **表示するタブ** と **ボタンの bold ハイライト**を決める（dashboard.tsx:987-1005, 964-984）
- `focusedArea: \"tasks\" | \"journal\" | \"artifacts\" | \"log\" | \"global\"` — **フッターの操作説明** と **Up/Down/g/G/s/f/Enter の挙動**を決める（dashboard.tsx:1008-1051, 1060-1154）

現状の key handler:
- タブボタン `onPress`（964-984）: `activeTab` と `focusedArea` を**両方**更新（正しい）
- `J` / `A` / `L` キー（1112-1114）: `activeTab` と `focusedArea` を**両方**更新（正しい）
- **`1` / `2` / `3` キー（1103-1105）: `activeTab` のみ更新、`focusedArea` を置き去り（バグ）**
- **`Tab` キー（1106-1110）: `activeTab` のみ更新、`focusedArea` を置き去り（バグ）**
- `Escape`（1210-1213）: `focusedArea` のみ \"global\" にリセット、`activeTab` を置き去り

結果、「ボタンは [Journal] が bold だけど、Up/Down を押すと Artifacts のカーソルが動く」「フッターの操作説明が表示タブと噛み合わない」といった状況が起きる。

## 問題 2: J/A/L ショートカットが「効いていないように見える」

`J`/`A`/`L` のキー登録自体（1112-1114）は `app.keys()` に登録されており、どの focusedArea でも発火する。

しかしフッターのヒント表示（1017-1051）は `focusedArea === \"global\"` のときしか J/A/L の案内を出さないため、他のタブにフォーカスしているときはショートカットの存在がユーザーに見えない。

また、`focusedArea` が artifacts / journal / log のときでも J/A/L を押せば別のタブに飛べるべきだが、発火と同時に `focusedArea` を切り替えるので**フォーカス奪取の挙動が唐突**（例えば Artifacts をスクロール中にうっかり `j` を押すと Journal にフォーカスごと飛ぶ、など）になりうる。これは仕様として許容してもよいが、ヒントが出ていないので学習できない。

# 求める修正

## 1. activeTab / focusedArea のモデルを整理し、タブ切り替え系キーはすべて両方を同時に更新する

具体的には:

- `1` / `2` / `3` / `Tab` キー も `J` / `A` / `L` / ボタン `onPress` と同じく、`activeTab` と `focusedArea` を同時更新する
- `Escape` で `focusedArea = \"global\"` に戻ったあとに Up/Down を押したときの扱い（global のときはスクロール無効、現状維持）

**原則: 「表示されているタブ = 操作対象」を不変条件にする。activeTab と focusedArea がタブ軸で食い違う状態を作らない。**

ただし `focusedArea` には `\"tasks\"` と `\"global\"` もあるため、完全に統合するのではなく「activeTab が指しているタブと focusedArea のタブ軸部分は必ず一致する（focusedArea が tasks/global のときは activeTab と独立）」というルールにする。

実装案（好みで調整してよい）:
- a. `activeTab` を state から削除し、表示判定にも `focusedArea` を使う（focusedArea が tasks/global のときは「直前に見ていた activeTab」を覚えるフィールド `lastTab` を新設）
- b. 逆に activeTab から focusedArea を導出する（focusedArea のうち tasks/global は別 state にする）
- c. 現状のまま 2 変数を維持するが、タブ軸を変更するすべての操作で**両方を更新する**ヘルパー関数 `switchTab(tab: \"journal\"|\"artifacts\"|\"log\")` を作り、分岐全部をそれに統一する

**c が最小差分で安全**。a/b はリファクタ範囲が広くなる。

## 2. J/A/L ヒントをフッターの tasks/journal/artifacts/log フォーカス時にも表示する

現状（1023-1042）のように focusedArea ごとにヒントを出し分けているセクションそれぞれに、タブ切り替えショートカット（`J` journal / `A` artifacts / `L` log）をコンパクトに追加する。長くなりすぎるなら `T/J/A/L` をまとめて 1 行にする等の工夫をしてよい。

## 3. ボタンのハイライト表現を見直す（任意）

- 現状、`bold` / `dim` の 2 段階しかない
- activeTab と focusedArea の両方の状態を視覚化したい場合、たとえば:
  - `activeTab` のときは bold
  - さらに `focusedArea` もそのタブなら下線や色付け（CYAN の背景など）
- ただしこれは nice-to-have。問題 1 が解決すればそもそも「ボタンと操作対象が食い違う」状態は起きないので、見た目は現状維持でも可。

# テスト観点

動作確認は dashboard を実際に起動して手で確認するしかない（自動テストなし）。以下のケースで意図通りに動くことを確認:

1. `1` / `2` / `3` を押すと、表示タブ・ボタンハイライト・フッターヒント・Up/Down/g/G/s/f/Enter の挙動すべてが切り替わる
2. `Tab` キーを繰り返し押すと journal → artifacts → log を一巡し、上記と同じく全てが同期する
3. `J` / `A` / `L` をどのフォーカス状態（global / tasks / journal / artifacts / log）からでも発火でき、飛んだ先のフッターヒントにも J/A/L が表示されている
4. タブボタンをクリックしたときも上記と同じ結果
5. `Escape` で global に戻ったあと、activeTab は直前のタブを保持している（表示が勝手に切り替わらない）

# 参考

- テンプレート側の変更は不要（これはランタイムの dashboard の挙動の話）
- `.team/prompts/` や `templates/` は触らない
- dashboard.tsx 単独で完結する修正のはず
- 関連: dashboard.tsx:336-358（AppState 型定義）, 842（初期 state）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-170-1775968325` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-170-1775968325
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-170-1775968325/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/170-dashboard-journal-artifacts-log-qol-activetab-focusedarea/runs/task-170-1775968325
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/170-dashboard-journal-artifacts-log-qol-activetab-focusedarea/runs/task-170-1775968325/summary.md` に書き出す。

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
