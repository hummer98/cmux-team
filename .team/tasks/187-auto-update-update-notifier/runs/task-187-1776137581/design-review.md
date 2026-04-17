# Design Review: T187

## Verdict: Changes Requested

概ね設計方針（検出委譲 + update タスク起票）は妥当だが、T186 との後方互換破壊が 1 件、update-notifier API の使い方に実装リスクが 1 件、および仕様・テスト・ログ面の抜けがいくつかあるため、Planner に差し戻す。

## 良い点

- **daemon が install を実行しない**という基本方針が正しい（T186 で顕在化したパス不一致・無限ループ問題の根本解消に直結）。
- `autoUpdate: boolean` → `off | notify | task` への段階的拡張は、通知だけ欲しい層／自動起票まで欲しい層を分離できて筋が良い。
- 重複起票防止（既存 open タスクの走査）と `run_after_all` 競合時に **daemon を落とさず log でスキップ** する方針は、現行の CLI（`cmdCreateTask` は exit 1）と比べて daemon プロセスに正しく適合している。
- テストマトリックス（env × config × 後方互換の 7〜8 パターン）は `main.test.ts` 既存構造に沿っており、置換後もカバレッジが維持される。
- Step 1（Bun 互換性確認）を最初に置き、NG なら `simple-update-notifier` に即切替という撤退ルートが用意されている。

## 指摘事項

### [Severity: High] env `"0"` / `"false"` の扱いが T186 と矛盾

- **問題**: Step 4-3 に `"0" | "false" | ""`（未設定扱い）と書かれている。`""` のみ未設定扱いにすべきで、`"0"` / `"false"` は **T186 で `source: "env"` として扱う仕様**（`main.test.ts` L280-288）。この通りに実装すると以下のテストが破壊される:
  - `env=0 + config=true` → 現行: `{ enabled: false, source: "env" }` / 新実装: `{ mode: "task", source: "config" }`(config=true→task にフォールバック)
  - `env=false` → 現行: `{ enabled: false, source: "env" }` / 新実装: config or default にフォールバック
- **推奨**: 空文字のみを未設定扱いにする。`"0" | "false"` は `"off"` (source=env) にマップする。具体的に:
  ```
  if (raw === undefined || raw === "") fallthrough to config
  if (raw === "0" || raw === "false" || raw === "off") return { mode: "off", source: "env" }
  if (raw === "1" || raw === "true" || raw === "task") return { mode: "task", source: "env" }
  if (raw === "notify") return { mode: "notify", source: "env" }
  else throw `unknown CMUX_TEAM_AUTO_UPDATE=${raw}`
  ```
  テストマトリックスも「env=0 → mode=off, source=env」「env=false → mode=off, source=env」を追加。

### [Severity: High] update-notifier の API 使い方に実装リスク

- **問題**: Step 1 / Step 5 / Step 8 で `notifier.fetchInfo()` → `notifier.update` を同期読み出しする前提だが、update-notifier v7 の実 API は:
  - `new UpdateNotifier({ pkg, updateCheckInterval: 0 })` はフォアグラウンドでは fetch しない（デフォルトはバックグラウンド spawn）。
  - 同期取得には `fetchInfo()` を呼んで **戻り値** を受ける必要があり、`notifier.update` プロパティは設定されない場合がある。
  - さらに ESM-only で CJS interop 非対応。Bun で `import updateNotifier from "update-notifier"` がそのまま通る保証はない（v6 以降 default export 構造が変わっている）。
- **推奨**:
  - Step 1 の Bun 互換検証に「`.fetchInfo()` の戻り値をそのまま使う」形の疎通コードを含める（`await notifier.fetchInfo(); if (notifier.update) ...` だけでなく `const info = await notifier.fetchInfo()` も試す）。
  - plan の fallback 案（`simple-update-notifier`）の API 形状（`simpleUpdateNotifier({ pkg, alwaysRun: true })` 等）を Step 1 時点で plan に書き込み、切替時の実装差分を最小化する。
  - update-notifier が `configstore` を使う点（`~/.config/configstore/update-notifier-<pkg>.json` に書く）を plan に明記。読み書き権限が無い環境（sandbox 等）での挙動にも触れる。

### [Severity: Medium] 重複検出のキーがタイトル完全一致なので脆弱

- **問題**: Step 6-2 の重複検出は `cmux-team を v${latest} にアップデート` タイトル完全一致。版が `1.2.3 → 1.2.4 → 1.2.5` と刻むたびに別タイトルのタスクが並列で open のまま残り、**「古い version 向けの open タスクが残ったまま新 version のタスクが起票される」** 現象が起きる。ユーザーが古いタスクを手動 close するまで dup が蓄積する。
- **推奨**: 次のいずれかを採用:
  - (a) frontmatter に `kind: cmux-team-update` または `auto_generated_by: update-notifier` を入れて、kind 一致で既存 open タスクを検出。latest が異なる場合は「既存タスクを close → 新タスクを起票」または「既存タスクの body を新 latest で書き換え」とする（後者は assigned 時は不可、draft/ready のみ）。
  - (b) 本設計のまま進める場合も、「既存の更新タスク (title prefix `cmux-team を v`) が open なら、そのタスクの latest と今回検出した latest を比較し、古ければ **close + 新規起票** にする」ロジックを追加し、振る舞いを plan に明記する。

### [Severity: Medium] `daemon.ts` からのタスク生成で hook / CLI 経由原則との整合性説明がない

- **問題**: CLAUDE.md L416 に「タスクの作成・更新は CLI を使うこと。`.team/tasks/` への直接ファイル書き込みは hook でブロックされる」と明記されている。本 plan は `daemon.ts` から直接ファイル I/O を行う想定（`task.ts` に `createTaskProgrammatically` を新設して共通化）。daemon プロセスは Claude Code の Write/Edit ツール経由ではないため実際には hook は発火しないが、**「CLI と同じ検証ロジックを通すべきか／通すならどこに切り出すか」** の設計判断が plan に書かれていない。
- **推奨**:
  - `task.ts` に `createTaskProgrammatic({ title, priority, status, body, runAfterAll, dependsOn }): Promise<{ id, filePath }>` を切り出し、**cmdCreateTask と daemon の両方から呼ぶ** 形にする（plan Step 6-3 で示唆はあるが「検討」止まり。確定させる）。
  - 既存 cmdCreateTask の以下の責務を `createTaskProgrammatic` 内部に移す:
    - slug 生成
    - max ID スキャン → newId
    - frontmatter / body 生成
    - task-state.json 更新
  - cmdCreateTask は parse + postMessage + console.log のみ行う薄いラッパーに変える。これで整合性の検証（run_after_all 既存チェックなど）が 1 箇所で済む。
  - plan §2 の `task.ts` 行を「参照のみ」から **「追加変更あり（createTaskProgrammatic 新設 + cmdCreateTask リファクタ）」** に修正。

### [Severity: Medium] 仕様書 `docs/spec/` の更新が漏れている

- **問題**: plan §3 Step 11 で `CLAUDE.md` / `README.md` / `CHANGELOG.md` の更新を挙げているが、`docs/spec/` は一切触れられていない。CLAUDE.md のルールで「cmux-team の仕様・挙動について質問された場合は、該当する `docs/spec/` のファイルを Read して回答すること」とあり、**実装と docs/spec の同期がプロジェクトの明示的なゴール**。auto-update は `docs/spec/00-project-overview.md` または `05-install-and-infrastructure.md` に記載がある可能性が高い。
- **推奨**: Step 11 に以下を追加:
  - `docs/spec/00-project-overview.md` / `05-install-and-infrastructure.md` を grep して auto-update / npm 関連記述を洗い出し、新仕様（`off | notify | task` の三値、update タスク自動起票）に書き換える。
  - 必要なら `docs/spec/06-implementation-tasks.md` に T187 のエントリを追加。
  - これを `dockeeper` スキルで同期してもよい（本タスク内で実施する形を明記）。

### [Severity: Medium] ログフォーマットの後方互換と廃止イベントの記述が欠落

- **問題**: `npm_auto_update` / `npm_update_check_failed` / `npm_self_update_completed` / `auto_update_config enabled=<bool>` などの既存ログイベントが plan §6 の表で「削除・改名」扱いとされているが、Step 9 の新ログイベント追加リストに「廃止対象」の明記がない。監視／解析側で旧イベント名をキーに拾っている場合に検出できなくなる。
- **推奨**:
  - Step 9 に **「削除するログイベント」** セクションを追加し、`npm_auto_update`, `npm_update_check_failed`, `npm_self_update_completed` を列挙。
  - `auto_update_config enabled=<bool>` → `auto_update_config mode=<mode>` はフォーマット変更なので、CHANGELOG に **ログフォーマット変更（破壊的）** として明記。
  - 起動時 1 回のログだけは「後方互換のため `enabled=<bool> mode=<mode>` の両キーを出す」のも一案（任意）。

### [Severity: Low] `state.updateAvailable` の永続化と TUI 表示の継続性

- **問題**: `state.updateAvailable` は in-memory。daemon restart で消え、次の 12h 周期まで TUI バナーが復帰しない。restart 後すぐに再取得されない点がユーザー体験として劣化する。
- **推奨**: Step 7-2 の「起動時 1 回呼ぶ」で十分カバーされる（`bootPhase === "ready"` 直後）。ただし plan §6 にその旨を明記（「restart 後も起動直後に再取得されるため、バナー表示のブランクは最大で起動〜fetch 完了までの数秒」）。

### [Severity: Low] ダッシュボード差分の仕様詳細が薄い

- **問題**: Step 10 は「上部にバナー Box 追加」だけで、以下が未定義:
  - バナーの色（既存 `rateLimit` バナーと視覚的に競合しないか）
  - mode=off のとき（task 起票せず、ただし update-notifier が裏で走る？本 plan では off なら呼ばないはずなので不要）
  - task 起票済みのときの task ID 表示（Step 10 例示には `(mode=task / task created: T188)` とあるが、`state.updateAvailable` に task_id を持つ必要がある）
- **推奨**: `state.updateAvailable` の型を `{ current, latest, detectedAt, createdTaskId?: string | null }` に拡張し、plan §2 と Step 2-3 で明記。`dashboard.tsx` の rateLimit バナーと並列表示になるレイアウト方針（縦に並べる / 同行に収める）を plan に書く。

### [Severity: Low] テスト計画の抜け

- 以下のテストケースが抜けている:
  - `checkUpdateAndNotify` で **mode=notify のときタスク起票が呼ばれない** ことのテスト（spy/mock で `createUpdateTask` の呼び出し有無を検証）
  - `createUpdateTask` で **run_after_all 競合時にスキップ（throw しない / log のみ）** することのテスト
  - update-notifier の `fetchInfo()` 失敗時に daemon が落ちずログだけ残すテスト
  - `normalizeAutoUpdate` の不正文字列（"task-now" 等）で throw されるテスト（config 読み込み時に即時 fail する設計のため）
- **推奨**: §4 自動テスト節に上記 4 ケースを追加。

### [Severity: Low] `self-update` サブコマンドの異常系

- **問題**: Step 8 で `current == latest` は「already up to date」だが、以下の扱いが未定義:
  - `fetchInfo()` 失敗（ネットワーク断、registry 404）→ exit 1? exit 0 with warn?
  - 既に `run_after_all` タスクが open の場合 → CLI からの手動起票なら `cmdCreateTask` 同様 exit 1 で良いか、`createUpdateTask` 共有ロジックに倣って「skip + stdout メッセージ + exit 0」にするか。
- **推奨**: Step 8 に異常系を 2〜3 行追加:
  - 失敗 → stderr にエラー + exit 1
  - run_after_all 競合 → stdout に既存タスク ID + exit 0（「もう更新タスクが予約されています」的 UX）

## Recommendations

Planner に戻して、以下を plan.md に反映してから Design Reviewer に再レビュー依頼してください:

1. **High-1**: Step 4-3 の env 解釈を修正。`"0" | "false" | "off"` → off (source=env), `"1" | "true" | "task"` → task (source=env), `"notify"` → notify (source=env), `""` or undefined → config fallback, それ以外は throw。テストマトリックスに `env=0 → off/source=env` `env=false → off/source=env` を明示追加。
2. **High-2**: Step 1 の Bun 疎通コードを実際の API（`await fetchInfo()` の戻り値を使う形）に置き換え、update-notifier v7 の ESM-only + `configstore` ディスクキャッシュに触れる。fallback の `simple-update-notifier` の最小コード例も Step 1 に書く。
3. **Medium-1**: 重複検出のキーをタイトル完全一致から `kind` ベース or 「古い open 更新タスクは close して再起票」に変更。Step 6 を具体化。
4. **Medium-2**: `task.ts` に `createTaskProgrammatic` を新設して cmdCreateTask と daemon で共通化する方針を確定。plan §2 の `task.ts` を「変更あり」に修正し、Step 6-3 から「検討」を削除。
5. **Medium-3**: Step 11 に `docs/spec/00-project-overview.md` / `05-install-and-infrastructure.md` / `06-implementation-tasks.md` の更新を追加。
6. **Medium-4**: Step 9 に「削除するログイベント」セクションを追加し、CHANGELOG にログフォーマット変更を破壊的変更として明記。
7. **Low-1〜4**: `state.updateAvailable.createdTaskId` フィールド追加、ダッシュボード表示方針、テスト追加 4 ケース、self-update 異常系の挙動を plan に追記。

以上を反映したら Approved 可。
