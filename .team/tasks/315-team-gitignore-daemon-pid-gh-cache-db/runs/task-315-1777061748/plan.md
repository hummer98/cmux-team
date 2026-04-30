# T315 plan: 配布用 .team/.gitignore テンプレートに daemon.pid と gh-cache.db* を追加

## 1. 課題分析

### 現状の問題点

`skills/cmux-team/manager/daemon.ts` の `initInfra` が生成する `.team/.gitignore` テンプレート（L498–L526）に以下のランタイム生成ファイルが含まれていないため、配布先プロジェクト（例: mado, Dear 等）で commit されうる:

- `.team/daemon.pid` — daemon 多重起動防止 pidfile（`pidfile.ts` が `writeFile({ flag: "wx" })` で atomic に取得）
- `.team/gh-cache.db` — `cmux-team gh sync` が生成する SQLite 本体（`gh-cache-store.ts:167` で `join(dir, "gh-cache.db")`）
- `.team/gh-cache.db-shm` / `.team/gh-cache.db-wal` — 上記 SQLite の WAL モード副次ファイル

### 根本原因

本リポジトリ root の `.gitignore` には既にこれら 4 項目が記載済みだが、配布対象は `.team/.gitignore` のみで、root `.gitignore` は配布されない。`daemon.ts:initInfra` は最初の `cmux-team start` で `.team/.gitignore` を生成し、以降は L528–L590 の migration ロジックでのみ追記する。このため:

1. **新規インストール**: テンプレート配列に無い項目はそもそも書き込まれない
2. **既存インストール**: migration が拾う項目は `rate-limit.json` / `masters/` だけで、今回の 4 項目はスキップされる

### 影響範囲

- 配布先の全プロジェクト（本リポジトリ含む）で、`.team/daemon.pid` / `.team/gh-cache.db*` が追跡対象になりうる
- 特に WAL (`-wal`) はプロセス実行中のみ存在する一時ファイルで、サイズが大きく変化するため diff ノイズが深刻
- 既に `.team/gh-cache.db` を commit してしまったプロジェクトは手動で `git rm --cached` が必要（本タスクのスコープ外）

## 2. 技術アプローチ

### 採用アプローチ

既存の **T227（`rate-limit.json` 追記） / T229（`master.surface → masters/` 置換）** と同じ migration パターンを踏襲する:

1. **新規生成**: `initInfra` 冒頭の template 配列（L503–L524）の `# セッション固有（追跡不要）` グループに 4 項目を追加
2. **migration**: `team_gitignore_migrated` ブロック（L530–L586）に 4 項目分の追加判定を挿入し、`added[]` 配列に集約してログ出力

### なぜこのパターンか

- T227/T229 で確立された「冪等な行ベース追記 + 集約ログ」方式は既に動作実績があり、壁打ちも済んでいる
- `lines.some((line) => line.trim() === X && !line.trimStart().startsWith("#"))` で「同名のコメントアウト行」と「通常行」を区別できる
- `added[]` 経由で `team_gitignore_migrated` ログに追加項目が記録されるため、配布先でも migration 実行の事後確認が容易

### 代替案と却下理由

| 代替案 | 却下理由 |
|--------|---------|
| 正規表現 / パーサーで構造化処理 | コメントと空行しかない flat な行指向ファイル。現状の `lines.findIndex` / `lines.some` で十分。パーサー導入はやりすぎ |
| `.gitignore` を丸ごとテンプレートから再生成 | ユーザー追記分を破壊する。T227 以来「既存を残して不足分のみ追記」ポリシーを維持 |
| ワイルドカード `gh-cache.db*` 1 行で済ませる | `.gitignore` 構文としては有効だが、既存 T227/T229 は完全一致行だけを扱っており、ワイルドカード行の冪等判定は別経路が必要になる。3 行独立で揃えるほうが既存ロジックの `lines.some(t === X)` と整合する（Decision Log D1） |
| state machine 等の構造化導入 | **構造的解決の検討**: 本領域は「列挙した既知項目を追記する」線形処理で、状態遷移も無く、バグ再発も無い。抽象化を持ち込む動機がない |

### 既存パターンとの整合性

- **挿入位置**: T227 は `proxy-port` の直後、T229 は `rate-limit.json` または `proxy-port` の直後に挿入。今回も同じ「近傍 anchor の直後に splice」方式で `proxy-port` の直後に `daemon.pid` を、`gh-cache.db` 系はグループ末尾付近に挿入する
- **コメント除外**: `!line.trimStart().startsWith("#")` を踏襲
- **ログ**: `team_gitignore_migrated` に集約出力（新イベント名を増やさない）

## 3. 変更対象

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/daemon.ts` | `initInfra` の template 配列に 4 項目追加 (L503–L524)、migration ブロックに 4 項目分の判定追加 (L530–L586) |
| `skills/cmux-team/manager/daemon.test.ts` | `initInfra` の gitignore 生成 / migration テストを新設（既存 describe が無いので 1 つ新設） |

### 新規作成

- なし（既存ファイルへの追記のみ）

### 削除

- なし

## 4. サブタスク分割

### S1. 新規生成テンプレートに 4 項目追加

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`（L503–L524）
- **実装内容**: `# セッション固有（追跡不要）` グループ内の `proxy-port` 直後に `daemon.pid` を、グループ末尾付近に `gh-cache.db` / `gh-cache.db-shm` / `gh-cache.db-wal` を追加
- **完了条件**:
  - 新規生成パスで writeFile される文字列内に 4 項目が含まれる
  - 挿入順序: `proxy-port` → `daemon.pid` → `rate-limit.json` →（既存） … → `gh-cache.db` → `gh-cache.db-shm` → `gh-cache.db-wal`
- **検証コマンド**:
  ```bash
  grep -n "daemon.pid\|gh-cache.db" skills/cmux-team/manager/daemon.ts
  ```

### S2. migration ブロックに daemon.pid 追記判定を追加

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`（L530–L586 の migration ブロック内）
- **実装内容**: T227 の `rate-limit.json` 判定と同じ形で `daemon.pid` 判定を追加。anchor は `proxy-port`、直後に `splice(proxyPortIdx + 1, 0, "daemon.pid")`。未見つかりなら `lines.push("daemon.pid")`。`added.push("daemon.pid")`
- **メソッド制約**:
  - `lines.some((line) => { const t = line.trim(); return t === "daemon.pid" && !line.trimStart().startsWith("#"); })` を使用
  - 既存ブロックのフロー（`changed = true` / `added.push`）と統一
- **完了条件**:
  - `daemon.pid` が既存 `.gitignore` に無ければ追記される
  - コメント行 `# daemon.pid` が存在しても「未記載」と判定する
- **検証コマンド**: S6 のテストで検証

### S3. migration ブロックに gh-cache.db 系 3 項目の追記判定を追加

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`（同 migration ブロック内）
- **実装内容**: 3 ファイル独立判定。anchor 探索は以下の優先順で最後に見つかった行の直後に splice する:
  1. `gh-cache.db-wal` があれば末尾候補
  2. `gh-cache.db-shm`
  3. `gh-cache.db`
  4. `rate-limit.json`
  5. `proxy-port`
  6. 最終フォールバックは `lines.push`
  - 実装簡潔化のため、**3 項目を 1 つのループで処理**（`for (const name of ["gh-cache.db", "gh-cache.db-shm", "gh-cache.db-wal"])`）
- **メソッド制約**:
  - 判定は `daemon.pid` と同じ `lines.some(... !startsWith("#"))` パターン
  - 3 項目いずれも個別に `added.push(name)` する（ログで可視化するため）
- **完了条件**:
  - 3 項目のうち欠けているものだけが追記される
  - 3 項目とも既に記載済みなら何もしない（冪等）
- **検証コマンド**: S6 のテストで検証

### S4. team_gitignore_migrated ログ検証

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`（L585 のログ行）
- **実装内容**: 既存の `added.join(",")` で自動的に新項目が混ざるため、**コード変更は不要**。ログ出力が `added=daemon.pid,gh-cache.db,gh-cache.db-shm,gh-cache.db-wal` 等を含むことを確認する
- **完了条件**: S6 のテストで `team_gitignore_migrated` に 4 項目が現れることを assert

### S5. ローカル worktree での動作確認

- **対象ファイル**: なし（本 worktree の `.team/.gitignore`）
- **実装内容**:
  1. 現状の `.team/.gitignore` を確認（`daemon.pid` / `gh-cache.db*` が無いことを確認済み）
  2. 修正版 daemon を適用した状態で `bun run skills/cmux-team/manager/main.ts` 相当で `initInfra` が再実行されることを確認（または unit test で代替）
- **完了条件**: 手動で走らせて migration 済み `.team/.gitignore` に 4 項目が追記される

### S6. テスト新設

- **対象ファイル**: `skills/cmux-team/manager/daemon.test.ts`（新規 describe ブロック）
- **実装内容**: `initInfra` を直接呼び出すテストを 3 ケース追加:
  1. **新規生成**: 空ディレクトリで `initInfra` を実行し、生成された `.team/.gitignore` に 4 項目全てが含まれることを assert
  2. **migration**: `rate-limit.json` と `masters/` だけを含む旧 `.gitignore` を用意して `initInfra` を実行し、4 項目が追記されることを assert。加えて `team_gitignore_migrated` ログに 4 項目が出ていることを assert（logger を stub するか、`.team/logs/manager.log` を読む）
  3. **冪等性**: 2 の結果に対して再度 `initInfra` を実行し、`.team/.gitignore` の行数・内容が変化しないことを assert
- **メソッド制約**:
  - 既存テストが `tmpdir()` + `DaemonState` mock を使っているか調査し、同じ方式で統一する
  - logger 検証は既存テストと同じ手法（`.team/logs/manager.log` tail / logger spy）に揃える
- **完了条件**:
  - `bun test skills/cmux-team/manager/daemon.test.ts` で新規テストが pass
  - 3 ケース全て green
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test daemon.test.ts -t "gitignore"
  ```

### S7. 最終検証

- **対象ファイル**: なし
- **実装内容**:
  ```bash
  cd skills/cmux-team/manager
  bun test
  bunx tsc --noEmit
  ```
- **完了条件**:
  - `bun test` 全 pass（既存テストを壊さない）
  - `bunx tsc --noEmit` のエラー数が着手前と同数またはそれ以下（6.2 で列挙する既存エラーは解消しない）

## 5. リスク

### 既存機能への影響

- **低**: 変更は `initInfra` の gitignore 処理のみ。他のロジックには触れない
- 既存の T227/T229 判定順序に割り込む形で `daemon.pid` 判定を `proxy-port` anchor の直後に挿入するため、「既存の `rate-limit.json` より先に `daemon.pid` が挿入されるか、後に挿入されるか」で最終的な行順が変わりうるが、`.gitignore` は行順非依存なので機能影響なし

### エッジケース

| ケース | 対応 |
|--------|-----|
| 既存 `.gitignore` に `daemon.pid` がコメントアウト（`# daemon.pid`）されている | `!line.trimStart().startsWith("#")` で「未記載」扱い → 本行を追記（コメント行はそのまま残す） |
| 既存 `.gitignore` に `gh-cache.db*` のワイルドカード行がある | 完全一致判定のみ。ワイルドカード行は認識されず 3 行追記されるが、`.gitignore` としてはどちらも有効で害なし（Decision Log D2） |
| 既存 `.gitignore` が `proxy-port` を含まない（もっと古い形式） | `proxyPortIdx < 0` フォールバックで `lines.push` するパスが既に T227 に存在するので、同じ経路を通る |
| 既存 `.gitignore` に末尾改行が無い | L583 の `tail` 計算ロジックが維持される |

### テスト戦略

- **unit test**: S6 の 3 ケース（新規 / migration / 冪等）で十分。T227/T229 に対応する既存テストが無ければ、今回の追加テストが初の gitignore カバレッジになる（Decision Log D3）
- **手動確認**: 本 worktree 上で `cmux-team start` を再実行する形の検証は daemon 多重起動リスクがあるため、unit test を優先し、手動確認は不要（S6 のテストでカバー）

## 6. 既存型エラーの先読み

着手前に `skills/cmux-team/manager/` で `bunx tsc --noEmit` を実行した結果（本 plan 作成時点で確認済み）:

```
daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1558,22): error TS2352: Conversion of type 'string | undefined' to type '...' may be a mistake because neither type sufficiently overlaps ...
```

### 6.1 本タスクのスコープで解消するエラー

| ファイル | エラー | 方針 |
|---------|-------|------|
| （該当なし） | — | 本タスクの変更は gitignore 生成 / migration ロジックのみで、SESSION_STARTED の `source` 型とは無関係 |

### 6.2 後続タスク（cleanup）に分離するエラー

| ファイル | エラー | 分離理由 | 予定 cleanup タスク名 |
|---------|-------|---------|---------------------|
| `daemon.test.ts:3870` | `"new_session"` は `SESSION_STARTED.source` の union（`"startup" \| "resume" \| "clear" \| "compact" \| undefined`）に含まれない | テストデータの型不整合。SESSION_STARTED の source 仕様（型 or テスト）の是正が必要で gitignore タスクと無関係 | T???: `SESSION_STARTED.source` 型と test fixture の整合 |
| `daemon.ts:1558` | `string \| undefined` → `SESSION_STARTED` への `as` 変換警告 | 上記と同根。型側の修正（`source` を optional にしつつ unknown キャスト経由にする等）が必要 | 上と同じ cleanup タスクにまとめる |

本タスク完了後のエラー数は **着手前と同じ 2 件**のままを期待する。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | `gh-cache.db*` をワイルドカード 1 行にするか 3 行独立にするか | **3 行独立** | 既存 T227/T229 の `lines.some(t === X && !startsWith("#"))` 完全一致判定と整合。ワイルドカード判定は別経路が必要になり冪等性の複雑化を招く。3 行に増えるがコスト僅少 |
| D2 | 既存にワイルドカード `gh-cache.db*` があるプロジェクトへの扱い | **そのまま放置**（3 行追記する） | `.gitignore` はワイルドカードと完全一致行の両立を許容する。実害なし。人手で整理したい配布先は PR で消せばよい |
| D3 | T227/T229 に対応する既存テストが無い場合 | **今回の追加で新設**（過去分の遡及テストは書かない） | T315 スコープは「daemon.pid / gh-cache.db* の追加」。既存項目のテスト欠如は別問題。ただし新規テストが「新規生成 + migration + 冪等」の形になるので、副次的に T227/T229 の回帰検出もカバーされる |
| D4 | 挿入位置: `daemon.pid` を `proxy-port` 直後に置くか、末尾か | **`proxy-port` 直後** | ランタイム生成系ファイルのグループに含まれるため、視覚的にも近傍の方が読みやすい。T227 が `proxy-port` 直後の splice を採用している前例にも合致 |
| D5 | `added[]` ログの粒度（3 ファイル個別 or 合算 `gh-cache.db*`） | **個別 3 項目** | `team_gitignore_migrated` ログは事後確認用途が主で、どのファイルが追記されたかの個別可視化が有用。ログ長も許容範囲 |
| D6 | state machine / 型列挙による構造的解決 | **不採用** | 本領域は既知項目の線形追記処理で、状態遷移もバグ再発も無い。抽象化を持ち込む動機なし（plan ルール「構造的解決の検討」に基づく判断） |
