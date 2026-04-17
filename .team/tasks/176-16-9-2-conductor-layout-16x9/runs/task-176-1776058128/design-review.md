# Design Review: 16x9 Layout Mode

## 判定: Approved

## レビューサマリー

既存の 4 層アーキテクチャ・pull 型監視・決定論的コード + AI 判断の原則に沿っており、実装ポイント(1)〜(4)、後方互換性、優先順位、pane 分割手順、検証手順、エッジケースを網羅的にカバーしている。`createConductorPanes` の 16x9 分岐（`down` → `right`）は現行 `wide` 分岐（`right` → `down` → `down`）と対称で cmux コマンド上実現可能。小規模な明確化ポイントがいくつかあるが、設計としては承認可能。

## 指摘事項（Recommended 以下）

### Recommended（推奨修正）

- **`CMUX_TEAM_MAX_CONDUCTORS` と `layout=16x9` の併用時の count 処理**
  Step 3 で `maxConductors = env ?? LAYOUT_MAX_CONDUCTORS[layout]` と定義すると、`CMUX_TEAM_MAX_CONDUCTORS=3` + `--layout=16x9` の場合 count=3 が `createConductorPanes` に渡る。plan §2-3 は「count>=3 のブランチは呼ばれない想定（呼ばれたら例外）」と書いているが、現行擬似コードには防御がない。以下のいずれかを明記することを推奨:
  - 16x9 分岐の先頭で `if (count > 2) throw new Error(...)` または `log("error")` + clamp to 2
  - `resolveLayout` / `createDaemon` で env と layout 派生値の不整合時に警告ログ (`max_conductors_layout_mismatch`) を出す
  `conductor.test.ts` にもこのガードケースを入れるべき。

- **resume 時の layout 不整合検知の挙動明文化**
  §5-3 で `layout_mismatch_on_resume` 警告を出すと述べているが、復元パスでは「team.json の `layout` フィールドが存在しない旧バージョン → state.layout=`wide` と同一視」とするかを明記したほうが運用事故が減る。Step 7 に「旧 team.json（layout フィールド無し）は wide として扱う」旨を追記することを推奨。

### Nice-to-have（任意）

- **`cmdStatus` / `dashboard.tsx` での layout 表示**
  Step 8 でスコープ外としているが、team.json に書いて終わりだと `cmux-team status` のログからは layout が見えず検証手順 4〜6 で手動 `cat team.json` が必要。将来タスクでよいが、軽量な1行追加（status 出力に `layout=...`）は本タスクで一緒に入れるとデバッグ効率が上がる。

- **`help_start` 以外のヘルプパス確認**
  `main.ts` には `--help` 以外にサブコマンド固有 help がある場合があるため、`getArg("layout")` の使い方を Step 4 の記述と同じ箇所で grep し、`help_` 系 i18n キーが他にないか確認してから追記すると安全。

- **`conductor.test.ts` の mock 方針**
  §5-6 の mock 方針は妥当だが、既存テストの import 形態によっては `mock.module` での差し替えに副作用が出ることがあるので、最初に `beforeEach`/`afterEach` での restore と `test.concurrent` を使わないことをテスト側に明記しておくと後のトラブルを防げる。

## 所感（Approved の理由補足）

- `daemon.ts` L163 / L168 / L174 の実装を確認し、plan §2-3 の 16x9 擬似コード（daemon→down→c1、c1→right→c2）が cmux の `newSplit` API（`right`/`down`）で素直に表現できることを確認した。
- `schema.ts` に `LayoutMode` を集約し、`DaemonState` / `TeamConfig` / `team.json` まで一貫して伝播させる設計は副作用が少なく良い。
- 「env > layout 派生値」という優先順位を既存挙動を壊さない形で保っている点、resume overflow が既存ロジックで自然に吸収される点は破壊的変更を最小化できている。
- 検証手順 1〜6 が plan §4 に 1:1 で落ち込んでおり、記録項目（team.json, manager.log, cmux tree）まで具体的なのでレビュー可能性が高い。
- docs/spec の 3 ファイル + CLAUDE.md の整合更新まで含めているため、「固定 2x2」前提の仕様ロックインが解消される。
