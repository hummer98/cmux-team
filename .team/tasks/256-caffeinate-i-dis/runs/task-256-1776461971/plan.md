# T256 実装計画: caffeinate を `-i` から `-dis` へ変更

## 1. 変更概要

Manager daemon が稼働中にも関わらず Mac が sleep する事象（`pmset -g log` で観測）への対処として、`updateCaffeinate` が起動する `caffeinate` のフラグを `-i`（`PreventUserIdleSystemSleep` のみ）から `-dis`（`PreventUserIdleDisplaySleep` + `PreventUserIdleSystemSleep` + `PreventSystemSleep`）へ変更する。これにより display sleep → system sleep 連鎖を断ち、AC 電源時は `PreventSystemSleep` によって system sleep を積極的に抑止できる。

スコープは以下に限定する:
- caffeinate フラグの変更（main.ts 1 箇所）
- ヘルプテキストの同期（i18n.ts 4 箇所、ja / en）
- CHANGELOG の Unreleased への追記

`sleepPrevention` の enum 化・設定可能化（`-is` / `-dis` 切替）はスコープ外。推奨の `-dis` 一本で固定する。

## 2. ファイル別変更一覧

### 2.1 `skills/cmux-team/manager/main.ts`

**L423 — `caffeinate` 起動コマンド**

```diff
-      caffeinateProc = Bun.spawn(["caffeinate", "-i"], {
+      caffeinateProc = Bun.spawn(["caffeinate", "-dis"], {
         stdin: "ignore", stdout: "ignore", stderr: "ignore",
       });
```

補足: 前後のコメント（L415-L418）は「スリープを抑止する」までしか言及していないため、そのまま維持できる。ただし起動ログ (`main.ts:359` の `sleep_prevention=${sleepPrevention}` boolean) には影響しないため変更不要。

### 2.2 `skills/cmux-team/manager/i18n.ts`

英語版（`help_start` 周辺）と日本語版（同等セクション）で計 4 箇所のヘルプテキストに `caffeinate -i` / 「caffeinate を使わない」等の記述がある。`-dis` と明示し、挙動の変化（display sleep も抑止する）をユーザーが把握できるようにする。

#### EN L91（`--no-sleep-prevention` の短説明）

```diff
-  --no-sleep-prevention    disable macOS sleep prevention (caffeinate)
+  --no-sleep-prevention    disable macOS sleep prevention (caffeinate -dis)
```

#### EN L101（Notes 内の Sleep prevention 説明）

```diff
-  - Sleep prevention: on macOS, caffeinate -i is used while any agent is active.
+  - Sleep prevention: on macOS, caffeinate -dis is used while any agent is active
+    (prevents display sleep, idle system sleep, and AC-powered system sleep).
```

#### JA L734（`--no-sleep-prevention` の短説明）

```diff
-  --no-sleep-prevention    macOS スリープ抑止を無効化（caffeinate を使わない）
+  --no-sleep-prevention    macOS スリープ抑止を無効化（caffeinate -dis を使わない）
```

#### JA L744（Notes 内のスリープ抑止説明）

```diff
-  - スリープ抑止: macOS では稼働中エージェントがある間 caffeinate -i を実行します
+  - スリープ抑止: macOS では稼働中エージェントがある間 caffeinate -dis を実行します
+    （ディスプレイスリープ・アイドルスリープ・AC 電源時のシステムスリープを抑止）
```

### 2.3 `CLAUDE.md` / `docs/spec/`

grep 結果: いずれも `caffeinate` への言及なし（`rg caffeinate CLAUDE.md docs/spec/` で 0 件）。更新不要。

参考: `docs/research/research-pid-proxy.md:48,52` に caffeinate の言及があるが研究メモであり、フラグ名も出てこないため更新対象外。

### 2.4 `CHANGELOG.md`

`[Unreleased]` セクションの `### Changed` に 1 行追記する（`### Added` の後、既存の `### Changed` 不在の場合は新設）。現状 Unreleased には `### Added` のみ存在（T243 の行）、`### Changed` が無いので新設する。

追記するエントリ案:

```markdown
### Changed
- **macOS スリープ抑止 `caffeinate` のフラグを `-i` から `-dis` に変更（T256）**。`caffeinate -i` は `PreventUserIdleSystemSleep` のみを立てるため display sleep 経由の system sleep 連鎖を防げず、daemon 稼働中でも Mac が sleep する事象が観測されていた（`pmset -g log` で確認）。`-dis` に変更して `PreventUserIdleDisplaySleep`（display sleep 抑止）と `PreventSystemSleep`（AC 電源時の system sleep 抑止）を併用することで、アイドル由来・display sleep 連鎖由来のスリープを共に防ぐ。副作用として稼働中はディスプレイが常時点灯する（バッテリー消費増）。Apple Silicon + 蓋閉じの `Clamshell Sleep` はハードウェア強制でありフラグでは防げないためスコープ外
```

バージョン行（`## [x.y.z] - YYYY-MM-DD`）は追加しない — Unreleased のままにし、リリース時に既存のリリースフローで確定させる。

## 3. 検証手順

実装後、worktree 内で以下を実行して挙動を確認する。

### 3.1 ビルド・構文確認

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-256-1776461971
cd skills/cmux-team/manager
bun check      # 型チェック
```

### 3.2 実行時の caffeinate 起動確認

1. 稼働中 cmux-team インスタンスを `cmux-team stop` 後、新 daemon を再起動
2. Conductor or Agent をアクティブにする（例: タスク起票）
3. `ps -ef | rg "caffeinate -dis"` で `-dis` フラグで起動していることを確認
4. `pmset -g assertions` を実行し以下の 3 つの assertion が daemon プロセス（pid）由来で 1 になっていることを確認:
   - `PreventUserIdleDisplaySleep`
   - `PreventUserIdleSystemSleep`
   - `PreventSystemSleep`（AC 電源接続時のみ）

### 3.3 idle 復帰確認

1. 全 Conductor / Master を idle（`status != "running"` かつ Agent 0）にする
2. `updateCaffeinate(false)` により caffeinate プロセスが kill されることを確認:
   - `ps -ef | rg caffeinate` で daemon 由来の `caffeinate -dis` が消えている
   - `pmset -g assertions` で上記 3 assertion が 0 に戻る

### 3.4 ヘルプテキスト表示確認

```bash
cmux-team start --help          # en
CMUX_TEAM_LANG=ja cmux-team start --help   # ja（環境変数の実名は i18n.ts を参照。変わっていれば適宜読み替え）
```

`caffeinate -dis` と表示されること、Notes の補足文が差し替わっていることを目視確認。

### 3.5 スリープ回避の継続確認（半手動）

- daemon + Conductor 稼働のまま Mac を放置し、60 分後も sleep に入っていないことを `pmset -g log | rg "Sleep"` で確認
- `caffeinate -dis` 停止時（全 idle 状態を作って数分放置）は通常どおり display sleep → system sleep に遷移することを確認

## 4. リスク・注意点

### 4.1 ディスプレイ常時点灯

`-d` フラグの副作用として daemon + Agent 稼働中はディスプレイが常時点灯する。以下の影響を許容する必要がある:
- バッテリー駆動時の電力消費増
- 画面の焼き付きリスク（近年の M-series Mac では軽微）
- 離席時の画面覗き見リスク（必要なら手動 `Ctrl+Shift+Power` で display off）

ユーザー向けには CHANGELOG およびヘルプテキスト（i18n.ts L101 / L744）で挙動変化を明示するため、周知は十分と判断する。

### 4.2 既存テスト

- `rg "caffeinate" skills/cmux-team/manager --type ts` で main.ts / i18n.ts / config.ts / dashboard.tsx の 4 ファイルのみがヒット（テストなし）
- caffeinate 自体の単体テストは存在しない（外部プロセス起動のため）
- ヘルプテキスト比較を行うスナップショットテストは未実装（`i18n.ts` の変更は型で検知されないため目視確認が必須）

### 4.3 Clamshell Sleep（スコープ外）

タスク本文にも明記のとおり、Apple Silicon Mac で蓋を閉じた場合の Clamshell Sleep はハードウェア強制で caffeinate のいずれのフラグでも防げない。この挙動は本タスクでは変更しない。ユーザーが蓋を閉じる運用を想定する場合は、外部ディスプレイ接続 + 電源接続による clamshell mode を使う必要がある（運用側で解決する案件）。

### 4.4 ロールバック手順

問題が発生した場合は `main.ts:423` の `"-dis"` を `"-i"` に戻し、i18n.ts / CHANGELOG の対応行を revert するのみ。state への永続化や config スキーマ変更はないため、revert 後の整合性問題は発生しない。
