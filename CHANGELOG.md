# Changelog

## [Unreleased]

## [4.23.0] - 2026-05-01

### Added

- **`cmux-team metrics` サブコマンドを新設し、CodeDNA 評価のためのデータ収集基盤を整備（T379 / T381）**。`cmux-team metrics --task-id / --since / --format json|text|csv / --group-by task|day|week` で完了時間・abort 率・tool call 数（Read/Grep/Edit/Bash）・token 消費・time-to-first-Edit・tool call 失敗率・hook block 率（Bash deny）・tool call stddev を集計できる。さらに `cmux-team metrics snapshot` で日次スナップショットを `.team/metrics/snapshots/YYYY-MM-DD.json` に保存し、`compare --baseline <period> --comparison <period>` で Welch's t-test / Mann-Whitney U / 2-prop z-test による cohort 比較、`health --days <N>` で snapshot ギャップ検出を行える。launchd plist テンプレートも `skills/cmux-team/templates/launchd/` に同梱（JST 09:05 daily）
- **`/cmux-team:watch` slash command を新設（T360）**。`.team/logs/events.jsonl` を Monitor で tail し、`task_completed` の自動 PR merge / conflict resolve / `git pull --ff-only` と escalation 系イベントのユーザー提示を行う opt-in コマンド。`--types` でイベントを絞り込み、persistent Monitor で stream tail する。pre-flight として daemon.pid / `cmux-team status` / events.jsonl / events サブコマンド存在を確認
- **`cmux-team events` サブコマンドを実装（T359）**。`.team/logs/events.jsonl` を tail / filter / format 変換する CLI。`--follow` で rotate 検知付き tail -F 相当、`--types` で comma-separated exact match filter、`--since` で duration（5m / 1h / 2d）or ISO 8601、`--format json|text` で出力形式を切り替え。spec §8 forward-compat に従い不正 JSON / 未知 event / schema_version 範囲外は warn + skip
- **dashboard の Journal に daemon lifecycle / resume イベントを追加（T353）**。`boot_completed`（▲）/ `daemon_stopped`（▼）/ `conductor_resume_launch_failed`（✕）/ `resume_worktree_missing_late`（✕）の 4 イベントを Journal に表示。`boot_completed` には version / restored_conductors / open_tasks、`daemon_stopped` には uptime_sec を含める。daemon 系イベントには T### 列を出さず、`daemon_reload` は通常時 3 行制限を維持するため非表示
- **dashboard: Pool key モード時に Metrics 枯渇予測セクションを非表示**。`poolTokens !== null` のとき Rate Limit Projection（5h/7d）は proxy 全体集計に基づくため pool rotation の実態を反映しない。per-token util を出す Pool Tokens セクションが情報源になるので枯渇予測自体を skip する

### Changed

- **docs/spec/11-metrics.md（376 行）を新設し metrics taxonomy と CodeDNA 評価判定基準を SSOT 化（T380）**。6 軸 taxonomy / Data sources / 撤退判定（BH FDR / Bonferroni）/ CLI 例 / Caveats を文書化。glossary §11「Metrics 関連」に 6 用語（metrics SSOT / cohort comparison / baseline period / evaluation period / header rot / agent message GC）を追加。CLAUDE.md のリポジトリ構造表と進捗情報の取得方法表に metrics 行を追記

### Fixed

- **`loadPoolSummary` 失敗時に CLI へ warning を再表示（T356）**。T351 で cmdStatus の旧 in-line ロジックを `loadPoolSummary` に集約した際、旧 `console.log("(token pool read failed: ...)")` が消失し tokens.db 破損時も silent に null を返していたリグレッションを修正。`loadPoolSummary` に optional `onError` callback を追加し、build catch のみで発火、gate 失敗（`isTokenPoolEnabled`）は silent OFF を維持。daemon 経路（`refreshPoolSnapshot`）は buildPoolSummary 直呼びのため挙動不変
- **dashboard Metrics pool token を CLI と一致させる（T401）**。`buildPoolTokenRows` が生 `snap.util_5h/7d` を直読みしていたため stale + reset 通過軸の 0 上書きが抜け、CLI（`cmux-team token list`）と Metrics ページで同一 snapshot の表示が乖離していた問題を修正。`computeEffUtil` 経由に揃え、Metrics は admit / throttle / CLI 表示と並ぶ 4 箇所目の consumer に整列。reset 通過行に `*` マーカー + フッタ凡例を追加（i18n key `metrics_pool_marker_legend`）

## [4.22.0] - 2026-04-30

### Added

- **`cmux-team update-task --no-exclusive` フラグを追加**。frontmatter から `exclusive: true` / `run_after_all: true` を一括で除去できる。`exclusive` は `run_after_all` を暗黙的に包含する設計に合わせて両行を同時に削除する。既に exclusive でないタスクへの適用は no-op

### Fixed

- **run_after_all が draft 経由で間接デッドロックする問題を解消（T397）**。`filterRunAfterAllTasks` の `normalActive` 判定を「assigned OR (ready AND depends_on 全 closed)」の executable ベースに変更。これにより、ready だが depends_on の依存先が draft 状態（Master 保留中など）の通常タスクによって `run_after_all` タスクが永遠に発火しない問題を回避する
- **run_after_all assigned 中に normal タスクが並走する race を guard で塞ぐ（T398）**。T397 の修正で残っていた、draft が後で ready 化された際に新 ready chain と既存 run_after_all が並走しうる問題を構造的に排除。`scanTasks` に `run_after_all lock guard` を追加し、`runAfterAll && !exclusive` なタスクが assigned のとき normal 新規 assignment を抑止する（他の RAA との並走は維持）。これにより `--run-after-all` と `--exclusive` の差が「他の RAA と並走するか / 単独か」に明確化された

### Changed

- **タスク・アーティファクト蓄積物のスナップショットコミット**。T297-T398 のタスクファイル群と A018-A025 のアーティファクトをリポジトリに登録し、run/conductor-prompt/summary 等の派生物を含む完全スナップショットを取り込んだ

## [4.21.0] - 2026-04-30

### Added

- **Agent の API エラーを TUI に可視化（T392）**。Agent 側 hook（`stopfailure-hook`）がレート制限・overloaded・ネットワーク断などで Agent が停止した場合、その停止理由を構造化イベントとして daemon に送り、dashboard 上で該当 Agent の状態として視認できるようにした。Conductor が「なぜ Agent が止まったか」を画面読みではなくイベントから把握できるようになる

### Changed

- **dashboard のキーバインド `Shift+R` / `Shift+G` / `Shift+Q` を `Ctrl+R` / `Ctrl+G` / `Ctrl+Q` に変更（T394）**。kitty keyboard protocol / CSI-u 非対応の標準ターミナル（macOS Terminal.app, 既定設定の iTerm2 など）では `shift+letter` が text event の codepoint としてしか届かず shift modifier が trie マッチしないためハンドラが発火しなかった回帰を、全端末で確実に制御バイト（0x12 / 0x07 / 0x11）として届く `ctrl+letter` ベースに切り替えて構造的に修正。ヘルプ表記も `g/G` → `g/Ctrl+G`, `R sync` → `Ctrl+R sync`, `Q full quit` → `Ctrl+Q full quit` に更新

### Fixed

- **token-store: T391 schema migration の FK 違反を SQLite 12-step procedure 準拠で解消（T393）**。tokens テーブルの再作成（`organization_id` / `auth_hash` を NULL 許容化）時に `usage_snapshots` の外部キー制約に違反していた問題を修正。SQLite 公式の 12-step table redefinition procedure（PRAGMA foreign_keys=OFF / 一時テーブル経由の COPY / FK 再有効化）に従って migration を書き直し、既存ユーザーの起動時 migration が安全に完了するようにした。fixture も新 schema に合わせて更新

## [4.20.0] - 2026-04-30

### Breaking

- **token pool: `claude-credentials` credential_source を廃止し `subscription` source に置換（T391）**。Claude Max 等の subscription token を `cmux-team token add --from-claude-credentials` で keychain に snapshot していた旧設計は、Claude Code 本体が `~/.claude/.credentials.json` で行う OAuth refresh と整合せず、stale token が `CMUX_CLAUDE_TOKEN` として export → spawn-agent で 401 authentication_error → idle stuck → crash する障害（Dear T340, 2026-04-30）の根本原因だった。新 source `subscription` は **keychain に保存せず spawn-agent でも inject しない** 設計とし、Claude Code 本体の認証経路に refresh を委ねる。proxy が `ANTHROPIC_BASE_URL` 経由でリクエストを観測し `auth_hash` / `organization_id` を初回観測時に UPDATE する経路を追加（`updateTokensDB` Phase 2 / Phase 2.5）。T384 auto-rotate も subscription の auth_hash 乖離を継続吸収する
- **`cmux-team token add --from-claude-credentials` を削除**。実行すると `--from-claude-credentials は v4.20.0 で削除されました。Use --subscription <handle> instead.` で exit 1。後方互換は取らない（CLAUDE.md feedback 「後方互換コードは不要」）
- **tokens.db schema: `organization_id` / `auth_hash` を NULL 許容に変更**。subscription 登録時点では両カラム未確定なため `NOT NULL` 制約を解除（SQLite では table re-create で実現）。起動時 migration が旧 schema を自動的に新 schema に書き換える

### Added

- **`cmux-team token add --subscription <handle> [--plan ...] [--tags ...] [--organization-id ...]`**: keychain に書き込まず subscription source で登録。`--plan` 省略時は `unknown`、`--tags` 省略時は `["any"]`、`--organization-id` 省略時は proxy 初観測で UPDATE される
- **`cmux-team token migrate-subscription`**: subscription source の row 全件について cmux-team が過去に snapshot した keychain entry（service `cmux-team-token`）を `security delete-generic-password` で削除する冪等コマンド。v4.20.0 へ migration した既存ユーザー向け
- **`cmux-team token list` の CRED 列**: credential_source を `manual` / `oauth-native`（subscription）/ `auto` で表示
- **`shouldInjectCredential(source)` / `assertCanRetrieveFromKeychain(source)` を `token-store.ts` から export**。spawn-agent の inject 判定を pure function に抽出し、subscription source で keychain を誤参照した場合の guard を提供
- **proxy `updateTokensDB` の Phase 構成を再整理**: Phase 1 (auth_hash 検索) / Phase 2 (auto-rotate or subscription auth_hash 初観測) / **Phase 2.5 (subscription organization_id 初観測 — 新規)** / Phase 3 (usage_snapshots UPSERT) / Phase 4 (auto-discover INSERT)。Phase 1〜2.5 は `rl=null` でも動作する（401 等で rate-limit ヘッダ不在でも auth_hash / organization_id の同期だけは進める）

### Changed

- **token pool: `cmux-team pool status` / `token list` の per-handle 行を effUtil（stale 救済反映後）に揃える（T390）**。`reset_5h_at` / `reset_7d_at` を経過した stale token の表示が snap 生値（例: @tayo の 7d=91%）のままで、内部 admit ロジック（`selectToken` / `peekNextToken` / `admitCandidates`）の effUtil = 0 扱いと乖離していた問題を解消。reset 通過済み軸を 0% で表示することで TUI の見た目と pickup 判定が一致する。`computeEffUtil` を pure function として抽出して表示層と admit 経路で共有

### Migration

- 既存 `claude-credentials` source の row は initTokenDB 起動時の data migration で自動的に `subscription` + `auth_hash=NULL` に変換される（冪等、変換時に 1 行 console.warn）
- 旧 NOT NULL 制約を持つ tokens table は schema migration で table re-create される（変換時に 1 行 console.warn）
- keychain entry の cleanup を行いたい場合は `cmux-team token migrate-subscription` を実行

### Related

- 起因 incident: Dear T340 (2026-04-30) — `credential_source=claude-credentials` で snapshot した OAuth token が stale 化し A[467] が 401 で crash。trace は `Dear/.team/traces/traces.db` 2026-04-30T06:37:29Z〜32Z UTC
- 関連実装: T384 (`feat(proxy): auth_hash mismatch 時の auto rotate を追加`、commit `da1dd0d`) — subscription の OAuth refresh による auth_hash 乖離を proxy が吸収する経路と相補

## [4.19.0] - 2026-04-29

### Added

- **proxy: OAuth refresh で auth_hash が乖離した token を自動 rotate（T384）**。同一 organization_id にヒットすれば既存レコードの auth_hash を UPDATE して通常 UPSERT 経路に合流させ、usage_snapshots 更新の停止を防ぐ。`tokenPoolEnabled` に依存せず手動 add token も rotate 対象。`token_auto_rotated` ログでマスキング済み auth/org を可視化。Dear T318 の auth_hash 乖離による snapshot 凍結シナリオへの根本対応
- **token-store: `admitCandidates` に 7d ブロッカー軸を追加（T382）**。`selectToken` の admit ループで `effUtil7d > BLOCKER_7D` の OR 条件を加え、5h と 7d を対称な blocker 軸として扱う。`BLOCKER_5H` / `BLOCKER_7D` を export 定数として定義し `pool-throttle.ts` の `countPoolTokens` / `hasPoolHeadroomFromSummary` も 7d 軸を反映するよう同期。pool 逼迫時に唯一の admit 候補が落札して monthly limit hit する構造的バグに対する一次対応
- **manager: `.team/logs/events.jsonl` への構造化イベントストリーム writer を実装（T358 / docs/spec/10-events-stream.md）**。spec §6 で確定した v2 schema に従い、task lifecycle / Conductor lifecycle / sync guard など 16 event 種を 17+ 経路で append。`emitEvent` / `EventStreamRecord` discriminated union / `mapAbortReason`（8 値 → 6 値正規化）を提供。`manager.log` は v1 として並行運用、retention は無制限 append、書き込み失敗時は best-effort で `manager.log` に `events_writer_error` を残す

### Changed

- **デフォルトレイアウトを `wide` → `16x9` に変更**。`createDaemon` / `resolveLayout` / `createConductorPanes` の default 引数および `team.json` restore 時の fallback を 16x9 に統一。help text / dashboard / README / docs/spec のデフォルト記述も更新
- **token-pool の default handle を `@tayo` に変更し `@kddi` を exclude**。OSS / 個人プロジェクト用デフォルト構成として `@kddi` を業務系 token から外し `@tayo` を default に設定

### Fixed

- **dashboard のキーバインド `R` / `G` / `Q` を shift+letter 構文に修正してハンドラ発火不能を解消**。`@rezi-ui/core` のパーサーが大文字小文字を区別せず lowercase 化するため `"R"` が `"r"` と同じシーケンスとして登録され後勝ちで上書きされていた。`g` (top) / `r` (reload) / `q` (quit) の小文字側ハンドラが発火せず、ヘルプ表記の `g/G` / `R` / `Q` が意図通り動作していなかった問題を shift+letter 明示で修正

## [4.18.0] - 2026-04-29

### Added

- **dashboard の Pool Tokens セクションで reset 残り時間を列内で padStart 整列（T377）**。各 token 行の reset 表示を固定幅で右寄せし、`5h:` / `7d:` の数値列が縦に揃って視認性が向上した

## [4.17.0] - 2026-04-28

### Added

- **agent ペインの statusline に tokenHandle (`@xxx`) を表示（T375）**。token pool 有効時に各 agent が使用中の token アカウントを統計欄末尾の `@<handle>` セグメントで確認できる。tokenHandle 未指定時は no-op で既存出力と bit 一致を保つ後方互換設計

### Changed

- **pool capacity 表示を「7d 日次 forecast ゲージ + next 候補 5h」に再設計（T374 / A024）**。従来の `pool capacity: 5h NN% / 7d NN%` 二値表示を廃止し、ヘッダーを 1 行に集約: `pool 7d ██▇▅▅▆█  next: @kddi 5h:65%`。7d は今後 7 日（Day 0..6）の日次割当 forecast を 8 段スパークラインで可視化（100% = sustainable pace）、next は spawn-agent が次に割り当てる候補アカウントの util_5h を peek（lease は取らない）。per-surface decoration `<5h:X%/7d:Y%> cap:Z%` は削除（詳細は `cmux-team pool status` / `token list` で確認）

### Removed

- `pool-surface-row.ts` および per-surface pool decoration（A024 §per-handle 行は出さない / T374）
- `dashboard.tsx::buildPoolHeader` legacy 経路（T363 で描画経路から外していた dead code を撤去）

## [4.16.0] - 2026-04-28

### Changed

- **token pool を cmux-team リポジトリ自身の運用にも有効化**。`default @kddi` / `project_tags=["any"]` で OSS 系プロジェクトも token pool 配分対象にする標準設定を反映
- **Conductor のフェーズ判定を量的基準に精緻化、推奨フロー hint を最優先 signal に追加**。「ヘルパー追加 + 数行置換 + テスト追加」レベル（<30 lines, ≤2 files, 設計判断不要）の修正が「単一機能のバグ修正」ラベルだけで中規模判定され Plan→Impl→Inspect の 3 phase を回されていた問題に対処。タスク本文で実装方針が明示されている小規模 fix を軽微に倒し、criteria を上から評価方式（先にマッチした条件で確定）に変更。タスク本文の `推奨フロー: <レベル>` hint を最優先 signal として追加し、Master 起票時の意思を Conductor に直接伝えられるようにした
- **README の「Why cmux-team?」を AI 観察箱コンセプトで書き直し**。サブエージェントが「見えない」ことの本質的な問題（異常検知の遅れ・改善サイクルが回らない）を明示し、ターミナルペインを飾りではなくプロダクトそのものとして位置付けるメッセージに寄せた

### Fixed

- **token pool の stale snapshot で利用可能な token が候補から外れデッドロックするバグを修正（T373）**。`admitCandidates` が「stale + 全軸 reset 未到達」を完全除外していたため、`util_5h=0.07` / `util_7d=0.18` / 1h+ 前 recorded / reset 未来 の余裕がある token が spawn 候補から永久に外れていた。reset 済み軸は `effUtil=0`、未到達軸は `snap.util_*` を下限として残す方針に拡張。ブロッカー判定（`util_5h > 0.95`）は `effUtil5h` で行い、stale でも snap 値が高ければ継続ブロックを維持。`pool-throttle.ts: countPoolTokens` も同形に揃えた
- **`admitCandidates` が epoch sec 文字列の reset 値を解釈できないバグを修正（T372）**。Anthropic ratelimit ヘッダー由来の `reset_5h_at` / `reset_7d_at` は epoch sec 文字列（例 `"1777366200"`）として DB に保存されており、`new Date(v).getTime()` が NaN を返すため T369 の stale snapshot 救済が常に除外側に倒れていた。`parseResetEpochMs` を新設し epoch sec / ISO 8601 / 不正値を一元解釈する経路に統合（不正値は `<=` 比較で false になり「reset 済み判定しない」安全側を維持）
- **`spawn-agent` の OAuth token が direnv の `.envrc.local` で上書きされるバグを修正（T371）**。`export CLAUDE_CODE_OAUTH_TOKEN=...` が後勝ちで上書きされ、`selectToken` が選んだ handle と実際のアカウントが乖離していた。token を `CMUX_CLAUDE_TOKEN` として export し、claude 起動コマンドに `CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN" claude ...` の inline env prefix を付与することで execve env を親 shell の env より優先させる。token 未選択経路（selected なし / Keychain 不在）は inline prefix なしで起動して Master 認証継承の挙動を維持

## [4.15.0] - 2026-04-28

### Changed

- **pool 有効時の THROTTLE 判定を pool-aware に変更（T367）**。token pool 機能が有効な場合、単一 token の rate limit に達しても pool 全体としてはまだ available capacity が残っているため、従来の「特定 token が throttled なら即 THROTTLE 扱い」という判定では spawn が不必要に止まっていた。pool 有効時は pool capacity を見て判定する経路に切り替え、複数 token を活用したスケジューリングを可能にした
- **token pool capacity を 5h / 7d 別表示に変更（T366）**。Anthropic API は 5 時間ウィンドウと 7 日間ウィンドウの 2 種類のレート制限を持つため、TUI ヘッダーで pool capacity を 1 つの数値として表示するのではなく 5h / 7d をそれぞれ表示するようにした。短期・長期どちらの軸で枯渇に近づいているかが一目でわかる
- **Metrics タブを Rate Limit Projection に作り直し + 更新間隔を config 化（T354)**。従来の Metrics タブを廃し、各 surface ごとに 5h / 7d レート制限の到達予測を表示する Rate Limit Projection ビューに置換。更新間隔は `.team/config.json` で調整可能になった
- **README に token pool・close-agent・trace-hooks のドキュメントを追加 + デモ動画を埋め込み**。インストール直後のユーザーが token pool 運用や Conductor 運用の主要 CLI を辿れるよう README を拡充した

### Fixed

- **`selectToken` が stale snapshot のリセット済み軸を候補化できないバグを修正（T369）**。token pool snapshot が古い状態で reset 時刻を過ぎていた場合、本来は util=0 として再利用可能な token が「util 値が古いまま」候補から除外されていた。reset 済み軸は util=0 として扱う補正ロジックを追加し、reset 直後に新規 spawn が pool 利用できないハングを解消
- **`pool-header-display.test.ts` の TypeScript strict 化対応（T368）**。`Object is possibly 'undefined'` エラー 18 件を optional chain と nullish coalescing で解消し、CI / ローカルの型検査を pass する状態に戻した

## [4.14.1] - 2026-04-27

### Fixed

- **`hoursUntil` が Unix epoch 秒文字列形式の reset 時刻を parse できず、token pool capacity の表示が膨大化していたバグを修正**。Anthropic API のレート制限ヘッダーは ISO 文字列と Unix epoch 秒文字列の両形式で reset を返すが、`hoursUntil` が ISO のみ前提だったため epoch 秒（例 `"1777233000"`）が `Invalid Date` になり常に null を返していた。結果として全トークンの reset が null 扱いとなり fallback `(1.0 * plan_ratio) / FULL_WEEK_HOURS` が適用され、plan_ratio=20 のトークンが 3 本あると pool capacity が 300% と表示されていた。`proxy.ts` の `toEpochSec` / `formatResetRemaining` と同じ両形式対応に修正
- **`ANTHROPIC_CUSTOM_HEADERS` の区切り文字を改行に修正して role/surface ヘッダー汚染を停止（T355）**。公式仕様（[code.claude.com/docs/en/llm-gateway](https://code.claude.com/docs/en/llm-gateway)）では `ANTHROPIC_CUSTOM_HEADERS` は改行 (`\n`) 区切りの `Key: Value` ペアだが、Master / Conductor 起動時にカンマ + 半角スペースで連結していたため SDK が全体を 1 ヘッダー値として送信し、proxy 側で `x-cmux-role` が `"master, x-cmux-surface: surface:N"` のような汚染値を拾い、`api_usage.role` 列に汚染データが蓄積されていた。Master / Conductor 起動時の `ANTHROPIC_CUSTOM_HEADERS` 指定を改行区切りに直し、main.test.ts / proxy.test.ts に regression テストを追加した（既存の DB 汚染データの物理 migration は別タスクの正規化 SQL 側で吸収）

### Changed

- **events stream の schema を `docs/spec/10-events-stream.md` として確定（T357）**。Task lifecycle 8 種・Conductor lifecycle 8 種の計 16 イベントを schema v2 として整理し、共通フィールド（`ts` / `event` / `schema_version`）・schema versioning rule・無制限 append + 別タスク GC の retention policy・reader の forward-compatible ガイドラインを定義。`docs/spec/glossary.md` §10 と `docs/spec/00-project-overview.md` 索引表にも追記

## [4.14.0] - 2026-04-27

### Changed

- **TUI ヘッダー右上の 5h/7d 利用率インジケータを token pool capacity に置換（T363）**。dashboard ヘッダー右側に表示していた直近 5 時間 / 7 日の API 使用率を廃し、現在の token pool 利用可能数 / 全体 / 次回 reset 時刻の表示に差し替えた。pool capacity が運用上の一次メトリクスになったため、ヘッダーの一等地を pool 表示に統一する

## [4.13.0] - 2026-04-27

### Added

- **dashboard に token pool の capacity ヘッダーと per-surface 表示を追加（T351 / T352）**。`cmux-team status` のヘッダーに pool capacity / next reset を表示し、Master / Conductor / Agent 行に @handle と利用率を出すよう拡張。Agent 行はスピナー直後に @handle を配置して視認性を改善した。daemon state に tokenDb / pool snapshot を保持し、新設した pool-summary 共有モジュール経由で TUI と CLI の両方に同じデータを供給する
- **未知の `rateLimitTier` に対する plan 入力プロンプト（T349）**。`cmux-team token add` / `promote` / `rotate` で probe したレスポンスの plan tier がカタログ未知（`pro` / `max5` / `max20` 以外）だった場合に CLI 上で plan を選ばせるインタラクティブプロンプトを追加し、誤って unlimited 扱いになるのを防ぐ

### Changed

- **`docs/spec/glossary.md` を新設して用語集を一元化（T350）**。これまで個別 spec ファイルや CLAUDE.md に散在していた cmux-team の用語定義を 1 ファイルに集約し、CLAUDE.md の docs/spec 参照テーブルから辿れるようにした

## [4.12.1] - 2026-04-26

### Fixed

- **`cmux-team token add/promote/rotate` の credential 読み取りを macOS Keychain 優先に変更（T345）**。Claude Code は OAuth refresh 後の token を `~/.claude/.credentials.json` ではなく macOS Keychain（`Claude Code-credentials` / account=$USER）に書き戻すため、source=1（auto-detect from Claude Code credentials）が file 側だけを読んでいると stale token を probe して 401 で失敗していた。`readClaudeCredentials` を「Keychain → file → 両方失敗ならエラー」の順に組み替え、エラー文言と CLI ラベルも Keychain 含む表現に更新。`KEYCHAIN_TEST_MODE=1` の in-memory 経路と T1〜T5/T7/T8 の 7 ケースを `token-cli.test.ts` に追加
- **`cmux-team resume` 後に Conductor が 0 個のまま throttled が永続するバグを修正（T346）**。R7（復帰時は pane を新規作成しない方針）を廃止し、`initializeLayout` の事後条件として `state.conductors.size === maxConductors`（実質的に pane 数 = maxConductors）を保証する形に書き換え。`layout_restore_empty_fallback` の判定から `resumeNewSurface.length === 0` 条件を外して D 経路を fallback に倒し、`applyRestorePlan` 後に deficit > 0 なら `initializeConductorSlots(deficit, undefined)` で補充する（新ログキー `layout_conductors_topup`）。M18a/M18b/M18c の事後条件回帰テストを追加し、partial restore 系 6 件に `mainBranch` 設定を補完

### Changed

- **`Full Quit` 後の起動挙動コメントを T346 後の実態に整合（T347）**。`main.ts` L866 周辺の「R7 方針で pane を新規作成しないため Conductor ゼロ台で着地する」というコメントが古くなっていたため、T346 で fallback → topup 経路に倒した結果として `maxConductors` 個の pane が作成されるようになった現状に合わせて書き換え（実装ロジックは無変更）

## [4.12.0] - 2026-04-26

### Added

- **`{{PROJECT_INSTRUCTIONS}}` overlay を Master / Conductor にも適用（T342）**。これまで Agent 8 ロール専用だった agent-instructions overlay 機構を 10 ロール（Agent 8 + Master + Conductor）対応に拡張。`OverlayRole` enum と `normalizeOverlayRole` を新設して `AgentRole` と分離し、`generateMasterPrompt` / `generateConductorRolePrompt` で project 固有の overlay を展開できるようにした。`cmux-team set-agent-instructions --role master` / `--role conductor` で project 固有指示を上書きできる
- **Token pool に auto-discover gate と `cmux-team token promote` を追加（T341）**。token pool が OFF の状態では auto-discover で未知 token を `tokens.db` に INSERT しないゲートを proxy に導入し、opt-in 原則を回復。auto-discover で登録された匿名 token を正規 handle に migration するための `cmux-team token promote` を新規追加した（`token add` と同形の UI で source 選択 → organization_id 検証 → Keychain 先 / DB 後の順序で atomic migration）

### Fixed

- **`findProjectRoot` が削除済み tmpdir を無視するよう修正**。`process.env.PROJECT_ROOT` が存在しないディレクトリを指している場合、`process.chdir()` が ENOENT でクラッシュしていた問題を修正。`existsSync` チェックを追加して消滅した tmpdir は無視し cwd フォールバックへ、`process.chdir()` 失敗時は明示メッセージで `exit(1)` するようにした
- **`ClaudeCodeBackend.send` / `reset` に `cmux send-key return` の呼び出しを再導入（T343）**。リファクタ commit `09492cf` で抜けていた enter 確定処理を復活させ、Claude Code TUI で長文プロンプトが確定されない不具合を修正。`send()` は `cmux.send(raw) → cmux.sendKey("return")` の 2 段呼び出し、`reset()` は `/clear → return → 500ms wait → prompt → return` の 4 ステップに変更

### Changed

- **token pool 仕様を `docs/spec/09-token-pool.md` に新設**。`cmux-team token` CLI（`add` / `list` / `remove` / `rotate` / `set-plan`）・DB スキーマ・`selectToken` アルゴリズム・`pool_capacity` 計算・設定モデルの仕様をひとまとめにし、CLAUDE.md の docs/spec 参照テーブルから辿れるようにした

## [4.11.0] - 2026-04-26

### Added

- **`cmux-team create-task --status ready` / `update-task --status ready` に auto-pull を導入（T339）**。sync state が `behind-ff`（local が `origin/<mainBranch>` の strict ancestor で fast-forward 可能）でかつ `PROJECT_ROOT` が `mainBranch` を checkout 中のとき、Ready 昇格前に `git pull --ff-only origin <mainBranch>` を自動実行する。失敗時は `ready_auto_pull_failed` で exit 1。`--no-auto-pull` で抑止すれば従来どおり警告のみで昇格続行。`mainBranch` 以外の checkout / detached HEAD / `no-remote` のときは auto-pull せず警告に留める

### Changed

- **per-file `bun test` を回す独立 GitHub Actions workflow を追加（T336, A021/A022）**。`prepublishOnly` から `bun test` 全体実行を外したことで失われていた CI テスト網羅を、`.github/workflows/test.yml` で穴埋め。A021 で記録した「`bun test` 全体実行が O(N²) 級に劣化して 13 分以上 hang する」問題を避けるため、shell ループで per-file に `timeout 90 bun test --timeout 30000 --reporter=dots "$f"` を回す方式を採用。job 15min / step 10min / per-file 90s の 3 重 timeout で暴走を防ぎ、fail は `::error file=...::` で annotation する。根本対策（B5/B6/B7）完了後にループを撤去予定

## [4.10.0] - 2026-04-26

### Added

- **Token pool に project default / include / exclude 設定モデルを導入（T335, A019 改訂）**。token tag 体系を ACL から hint に緩め、project 側で `tokenPool.default` / `include` / `exclude` を指定できるようにした。token・project 追加時の設定変更が最小化され、OSS リポジトリでは exclude のみ尊重して全 `selectable=1` トークンを admit する挙動になる
  - config schema 拡張: project の `tokenPool.default/include/exclude`、global の `oss_default` / `primary_orgs` を追加（`oss_pool_tags` は廃止）
  - `selectToken` アルゴリズム改訂: `SelectTokenPolicy` ベースで exclude 最優先 → effectiveDefault（runtime 昇格・DB 不変）→ include バイパス → OSS admit → 通常 tag matching の優先順に整理
  - `project-tags.ts` に OSS 判定（`primary_orgs` ベース）を追加。未設定時は旧動作を維持
  - `cmdSpawnAgent` を新 API に接続。Keychain 不在時は env 注入を skip しつつ `AGENT_TOKEN_BOUND` を post（dashboard 観測性優先）し、`token_pool_fallback` の warn を残す
  - DB schema / Keychain / proxy / `cmux-team token` CLI には変更なし。受け入れ条件は Project A/B/C シナリオの unit test 20 ケースで担保

### Changed

- **`bun test` の O(N²) 劣化を最小再現する `manager/perf-probe/` 群を追加（T337, A022）**。A021 §仮説7 を 6 軸 × N=10/50/200 + 連結 + ファイル数スケーリングで refute し、`spawn` 軸だけ約 50 倍（3 ms/spawn）で突出することを確認。`.probe.ts` 拡張子で本番テスト群と完全分離して `bun test` の auto-discovery 対象外にした。詳細レポートは `.team/artifacts/A022-research.md`

## [4.9.1] - 2026-04-26

### Fixed (release pipeline)

- **`prepublishOnly` から `bun test` 全体実行を削除**。これまでリリースタグを push すると GitHub Actions の `Publish to npm (OIDC Trusted Publishing)` が暗黙に `bun test`（manager 配下全 50 ファイル）を起動していたが、A021（T327）で記録した「`bun test` 全体実行が同一プロセス内で O(N²) 級に劣化して 13 分以上 hang する」問題に常時引っかかる構造になっていた。v4.9.0 のリリースもこの hang により publish に到達できず欠番になった（タグ含めて取り消し済み）。リリース時のテスト実行は CI 側の独立 workflow に切り出して別タスクで整備する

> **Note:** v4.9.0 は npm publish 段階で hang したため欠番。v4.9.1 が v4.8.0 の次の正式リリースになる。下記 Added/Changed/Fixed/Tests/Docs はすべて v4.8.0 → v4.9.1 の差分。

### Added

- **Global token pool 機能（T318/T319/T320/T321/T322/T323/T325, A019）**。複数の Claude OAuth token を `~/.cmux-team/tokens.db` で管理し、5h / 7d 利用率に応じてエージェントに割り当てる仕組み。
  - `cmux-team token add|list|remove|rotate|set-plan` CLI（T319）。credential ファイルまたは手動入力からトークンを登録し、`/v1/models` probe で organization_id と plan を取得、macOS Keychain に保存する
  - `proxy` が Anthropic API レスポンスを受けるたびに tokens.db の利用率と reset 時刻を throttled UPSERT し、未知トークンは `selectable=0 / tags=[auto]` で auto-discover 登録（T320）
  - `spawn-agent` 時に tags フィルタ + 5h/7d 利用率 + lease blocker でトークンを選択し、`CLAUDE_CODE_OAUTH_TOKEN` を子プロセスに inject。SESSION_ENDED / PID 死亡 / opencode session_idle で 120s atomic lease を release（T321/T325）
  - `project_tags` resolver: `.team/config.json` 優先 → git remote origin の host から `["org:<name>"]` を導出 → `["any"]` fallback（T321 拡張）
  - 機能 ON/OFF は `CMUX_TEAM_TOKEN_POOL` env > `.team/config.json:tokenPool.enabled` > `~/.cmux-team/config.yaml:token_pool.enabled` > default false の 3-tier resolver（T322）
  - `cmux-team status` ヘッダーに pool capacity・next reset、Master/Conductor/Agent 行に handle / 利用率 / cap 表示。`cmux-team pool status` サブコマンドで全アカウント一覧（T323）
- **opencode Agent 統合（Issue #37, M1〜M6）**。Claude Code 以外のランタイムバックエンドとして opencode を選択可能に。`agentEnabled` / `agentModel` 設定、opencode-server lifecycle 管理、REST 経由の spawn / kill、UUID 形式（`ses_<英数字>`）の surface ID 対応。`@opencode-ai/sdk` を依存追加
- **`cmux-team delete-task --force`（T333）**。これまで `assigned` 以外でも `closed` / `aborted` 状態のタスクは CLI 削除できなかったが、`--force` フラグで `closed` / `aborted` を `deleted` に強制遷移できるようにした。`assigned` は force でも禁止（abort-task 経由を強制）、`deleted` への二重削除も拒否。FSM ログには `force=true prev=...` が残る
- **`/cmux-team:help` と `/cmux-team:retro` スラッシュコマンド**。`help` はプラグインの全コマンド・スキル一覧と起動条件を動的に表示、`retro` は直近 N 件のタスクを分析して繰り返しパターン・設計問題・CLAUDE.md 逸脱を報告する

### Changed

- **CLAUDE.md に「state tracking への構造的対応」サブセクションを追加（PR #40）**。設計 5 原則の上位原理として「transformer が state を内部で維持しなくて済む環境を設計する」を明示し、新規スキル・コマンド・ツール追加時のチェックリスト（state 外部化 / silent state mutation / pull 観測 / statefulness 排除）を提供。重複していた「判断に迷ったとき」の 2 項目を削除
- **エージェントからの進捗コマンド案内を禁止**。ユーザーは Manager surface（TUI）をリアルタイムに見ているため、タスク作成後に `cmux-team status` 等の案内は不要。CLAUDE.md / templates 双方を同期
- **Conductor Step 6.5 を厳格化**。Inspector minor+ findings と tsc エラーは「自分が touch したファイル」に関連する限り**同一タスク内で修正必須**。`will file a follow-up` での先送りは禁止し、本当にスコープ外なら実際に `create-task` を呼んでタスク ID を summary.md に記録してから完了する
- **`bun.lock` を追跡開始 / `node_modules/` を `.gitignore` 追加**。`bun add @opencode-ai/sdk` により bun.lock が生成されたため lockfile を commit 対象に変更

### Fixed

- **SESSION_ENDED race で assignTask 中にプロンプトが届かない問題を修正（T302）**。`/clear` 送信後の sleep 中に `SESSION_ENDED` race で `conductor.status` が `disconnected` になった場合、`AssignTaskError("conductor")` を投げて送信をブロック。タスクは `ready` のまま残り次の idle Conductor に再割り当てされる。`disconnected → idle` 復帰時に `requestWakeup` を呼び出し、`ready` で待機中のタスクを即座に再割り当てできるようにする
- **dashboard のタブボタンに `focusable: false` を追加**。マウスクリック後にフォーカス枠 `[ ]` が残る問題を修正。R/B/O キーの判定を `focusedArea` → `activeTab` に変更し、Issues タブが表示中なら T でタスクにフォーカスしていてもアクションキーが動作するようにした
- **dashboard Tasks セパレータのハイライト条件を修正**。`focusedArea === tasks` のときだけセパレータがハイライトされるよう改修

### Tests

- **SESSION_ASK 経路の回帰防止テスト（T326）**。Conductor `SESSION_ASK` 統合テスト（status=asking / askQuestion / disconnectedAt クリア / lastHookAt 更新 / `conductor_asking` ログ / cmux.notify が呼ばれない）と Agent `SESSION_ASK` で `cmux.notify` が `title="Agent asking"` で 1 回呼ばれることを検証。dashboard 側は `buildConductorRow` を export し `formatConductorsSectionLabel` を純関数化、Conductor / Agent asking 描画と truncate のテストを追加

### Docs (artifacts)

- **A020 — `CLAUDE_CODE_OAUTH_TOKEN` probe findings（T317）**。Subscription token は `Authorization: Bearer sk-ant-oat01-...` + `anthropic-beta: oauth-2025-04-20` で配信され、レスポンスには `anthropic-ratelimit-unified-5h|7d-utilization` と `anthropic-organization-id` のみ含まれる（TPM 系ヘッダーは無し）。token pool の burnout スコアが unified utilisation 軸を使う根拠を実機検証で確定
- **A021 — `bun test` 全体実行ハングの原因調査と回避策（T327）**

## [4.8.0] - 2026-04-25

### Added

- **`.team/.gitignore` テンプレートに `daemon.pid` と `gh-cache.db*` を追加（T315）**。新規生成されるテンプレートに加え、既存プロジェクトの `.team/.gitignore` に対しても冪等な migration を実行する。`daemon.pid` は daemon 多重起動防止の pidfile、`gh-cache.db` / `gh-cache.db-shm` / `gh-cache.db-wal` は `gh-cache-sync` の SQLite + WAL。これまで新しい `.team/` を作るたびに手動で追記が必要だった 4 項目を自動化。migration は T227/T229 と同じ `lines.some + !startsWith("#")` の冪等追記パターンで、追加項目は `team_gitignore_migrated` ログに集約出力される

### Changed

- **README に `--base-branch` オプションと `.team/config.json` の説明を追加**。`--base-branch` は実装済み（i18n help / `docs/spec/*` には記載あり）だが README.md / README.ja.md 両方に未記載だった。`create-task` 行にフラグを追加し、デフォルト挙動と start-point 解決順序を blockquote で解説。合わせて Configuration セクションを新設し、`mainBranch` / `layout` / `sleepPrevention` / `autoUpdate` / `models.{master,conductor,agent}` / `envrcHookPromptSkipped` のデフォルト値・上書き方法・使用例を記載。これまで `autoUpdate` しか README に書かれていなかった設定項目全体のギャップを解消
- **README に npm version / monthly downloads / total downloads バッジを追加（T313）**。License バッジの上に 3 バッジを配置し、公開バージョンとダウンロード数を README 冒頭で一目で確認できるようにした。日本語版・英語版で順序と URL を完全一致させる

### Fixed

- **`cmux-team status` の open count から aborted / deleted を除外（T314）**。これまで `open = total - closed` の引き算集計だったため、aborted / deleted 状態のタスクが open に混入して実態より膨らんで見える問題があった。明示的な allowlist（`draft` / `ready` / `assigned`）ベースの集計に変更し、aborted は独立セグメントとして表示、deleted は常に非表示。aborted=0 のときは aborted セグメント自体を省略して既存の簡潔表示を維持する。純粋関数 `buildTasksSectionLines` として抽出し、6 ケースの unit test で境界ケースを網羅

## [4.7.0] - 2026-04-24

### Added

- **`cmux-team status` に Rate Limit セクションを追加（T311）**。Tasks と Log tail の間に 5h / 7d utilization・reset 時刻・unifiedStatus・updatedAt を表示する。これまで dashboard では見えていたが CLI status では見えなかった情報を CLI から確認できる。`rate-limit-status.ts` に純粋関数 `buildRateLimitStatusLines` を新設し、既存 `isStale5h`/`isStale7d` を再利用して dashboard と軸独立 stale semantics を共有。`.team/rate-limit.json` 不在/破損時は `(no rate limit data — proxy not running?)` にフォールバックし、他セクションは通常通り表示される
- **dashboard Metrics タブにスクロール操作を追加（T310）**。↑/↓ でスクロール、`g` で先頭、`G` で末尾にジャンプできる。Metrics タブが画面下部で見切れる問題を解消。journal / log の実装を参考にした固定レイアウト向けの offset slice（順方向）で、描画時の Math.min clamp により overshoot と行数減少の両方に耐性を持つ。1s polling の loadMetricsData は offset を触らず位置を維持する
- **RuntimeBackend インターフェースと ClaudeCodeBackend skeleton を追加（Issue #30 M1/M2/M3）**。将来の OpenCode backend 等への拡張に向けた基盤整備。`runtime-backend.ts` に `SessionRef` / `PermissionRef` の opaque 型、`RuntimeEvent` の discriminated union（session_started / idle / reset / ended / permission_asked）、`spawn` / `send` / `reset` / `kill` / `reply` / `onEvent` / `dispose` の 7 メソッドを定義。`/clear` / `SESSION_*` / `ANTHROPIC_BASE_URL` / PID 等のランタイム固有情報は interface に漏らさない設計。`claude-code-backend.ts` で Claude Code CLI アダプタの骨格を実装（`send` / `reset` / `kill` / `reply` / `onEvent` / `dispose` は実装済み、`spawn` は M3-a #31 で実装予定）。`docs/spec/08-runtime-boundary.md` に 43 ファイルを runtime-specific / agnostic / boundary に分類した棚卸し表を追加

### Changed

- **Metrics タブから重複していた「統合（5h/7d）」セクションを削除**。ヘッダー右端の `buildRateLimitDisplay` が出すバー付き `5h:` / `7d:` 表示と情報が重複しており、しかもパーセントのみの劣化版だったため削除。`MetricsData` から `unifiedFive` / `unifiedSeven` フィールド、`buildMetricsRows` から unified 描画ブロック、i18n の `metrics_section_unified` キー（en/ja）を削除。`daemon.rateLimit.unified5hUtilization` / `unified7dUtilization` 本体はヘッダー描画と throttle 判定で引き続き使用。Closes T309
- **CLAUDE.md を 1036 行 → 230 行に削減、詳細ルールを `agent-instructions/implementer.md` に分離**。ロギング・EventBus・task-state・cmux API の実装ルールを `.team/agent-instructions/implementer.md` に移し、CLAUDE.md は設計思想とガードレールのみに集約。廃止済みコマンドや旧挙動の説明も合わせて削除

### Fixed

- **dashboard Metrics タブラベルを ja locale でも英語表記に統一**。他のタブ（Journal / Artifacts / Log / Settings / Issues）が locale 問わず英語で描画されるのに対し、`metrics_tab_title` のみ「メトリクス」に翻訳されていたためタブバーが視覚的に不整合だった。ラベルは "Metrics" で固定し、タブ内部のセクション見出しはローカライズを継続

## [4.6.0] - 2026-04-24

### Added

- **Metrics タブを dashboard に追加（T307）**。`6` / `M` キーで切り替え可能な新タブ。直近 60 秒の burn rate（input / output / cache read tokens per second）、ロール別（master/conductor/agent）・タスク別の累積使用量、最新リクエストの model / stop_reason / rate limit 残量を表示する。`trace-store.ts` に `aggregateApiUsageByRole` / `aggregateApiUsageByTask` / `getLatestApiUsageRow` / `getBurnRateWindow` の 4 つの集約関数を追加し、`dashboard-metrics.ts` で UI 用の pure build 関数を提供。既存の `daemon.traceDb` ハンドルを再利用するため DB open/close のオーバーヘッドは無い。i18n ラベル 25 キーを en/ja で追加
- **`cmux-team trace-task` に Token Usage メトリクス表示を追加（T306）**。Sessions セクションの後に requests / input / output / cache creation / cache read tokens、cache hit rate、総所要時間、ロール別・モデル別の内訳を表示する。過去のスクリプト互換のため `--no-metrics` フラグでプレ T306 の出力に戻せる。T305 より前に実行されたタスクは "no usage data" 行が表示される。`trace-store.ts` に `getTaskUsageTotal` / `getTaskUsageByRole` / `getTaskUsageByModel` を追加
- **proxy が Anthropic `/v1/messages` の usage / rate limit を SQLite に記録（T305）**。新テーブル `api_usage` に 1 リクエスト 1 レコードで `model` / `stop_reason` / input・output・cache トークン数 / rate limit 残量を INSERT する。non-streaming は body parse、streaming は SSE 行単位 parse（`message_start` / `message_delta` / `message_stop` / `error`）で終端 1 回 INSERT。`content_block_delta` は parse せず CPU コストを最小化。エラー応答（`http_<status>` / `rate_limit_error` / `stream_aborted` / `parse_failed`）も INSERT する。既存の `api-trace.jsonl` / `state.rateLimit` 更新は完全温存。T306 / T307 の集計基盤
- **Master / Conductor / Agent の settings.json に `x-cmux-role` ヘッダー注入（T304）**。`ANTHROPIC_CUSTOM_HEADERS` env に `x-cmux-role: <role>` を設定することで Claude Code の子プロセスから Anthropic API に自動付与される。proxy の既存ヘッダー優先ロジックがそのまま role を拾うため proxy 側の変更は不要。T305 / T306 / T307 のロール別集計を支える基盤修正。調査時点で 3 ロール全員が `role=unknown` だったため 3 ロール同時に修正

### Changed

- **task-state.json の全 mutation を pure reducer 経由に集約（T303）**。新規 `state-machine/task-state-store.ts` に `applyTaskEvent` / `updateTaskSessionId` / `createTaskEntry` を追加し、`withTaskStateLock`（in-process mutex）で `load → reduce → patch → cascade → save → shadow → notifyStateChanged` を直列化。daemon.ts / main.ts の直接 `taskState[...]=`、`saveTaskState(...)` 呼び出しを全廃（grep invariant: 0 件）。P1（T279）で用意された shadow observer を store 内部から呼ぶことで "shadow wiring = 0 callers" ギャップを解消。新 `REVERT_TO_READY` イベント + reason variants で 5 箇所の ad-hoc "assigned → ready" revert を統一。T302 の緊急ガード（`assign_skipped_terminal`）は reducer noop 経路に吸収され削除。CLI ↔ daemon の cross-process race は reducer guard で観測的に吸収する方針で、file-lock 導入は 24h shadow 観測後に別タスクで判断
- **daemon の auto-restart 機構を削除（T301）**。source watcher / exit 42 restart ループを撤去。Conductor の merge Step 9 が daemon 自身の完了通知チャンネルを kill する self-referential race（T298 / T300 の根本原因）を構造的に解消。`daemon.ts` から `sourceMtimes` / `restartRequested` / `initSourceWatcher` / `checkSourceChanged` / tick 内の `source_changed` ブロックを削除。`main.ts` / `bin/cmux-team.js` の exit 42 while-loop を単一 `execFileSync` + `process.exit(0)` に単純化

### Fixed

- **run_after_all 競合判定が aborted / deleted を terminal 扱いしない問題を修正（T300）**。`createTaskProgrammatic` の run_after_all 競合判定が `status !== "closed"` のみを terminal として扱っていたため、aborted / deleted な run_after_all タスクが残っていると新規 run_after_all 作成が `RUN_AFTER_ALL_CONFLICT` で拒否されていた。`scanTasks` 側は closed | aborted | deleted の 3 状態を terminal 扱いしており、terminal 定義が 3 箇所でズレていた。`task.ts` に `isTerminalStatus` ヘルパを export 追加し、作成経路・実行経路で共有。将来の terminal 状態追加時も 1 箇所修正で同期される
- **assignTask 進行中に delete-task が割り込む T220 race を塞ぐ暫定ガード（T302）**。`scanTasks` 内の assign 完了書き込みブロックを `__testApplyAssignCommit` helper に切り出し、`saveTaskState` 直前に `ts[taskId]?.status` が `isTerminalStatus`（closed/aborted/deleted）を満たせば書き込みを skip し、`resetConductor` で worktree cleanup + Conductor idle 化する。ログ: `assign_skipped_terminal`。T303 の reducer 置換で helper ごと削除済み

## [4.5.1] - 2026-04-23

### Fixed

- **ready 昇格時の sync check が `.team/` の変更を dirty と誤判定する問題を修正（T298）**。cmux-team 自身が `.team/` 配下にタスク・アーティファクト・ログを書き込むため、`collectSyncFacts` が `.team/` の untracked エントリを uncommitted としてカウントすると、ほぼ常に `ready_rejected` で昇格が拒否されていた。`git status --porcelain` の呼び出しに pathspec `:(exclude).team` を追加して `.team/` 配下の変更を除外。3 件の新規テストケース（`.team/` のみ dirty → clean / 他ファイル dirty → uncommitted / 混在 → uncommitted）を追加

## [4.5.0] - 2026-04-22

### Fixed

- **`--depends-on` をゼロパディング 3 桁 ID に正規化（T267, #25）**。`cmux-team create-task` / `update-task` で `--depends-on 28` のように非ゼロパディング ID を渡した場合、frontmatter に生値で書かれて task-state.json のキー（`"028"`）と一致せず、依存が永遠に解決されないサイレント失敗になっていた。`task.ts` に `normalizeTaskId` / `normalizeTaskIdList` を追加し CLI 入口で正の整数のみを受理、`padStart(3, "0")` で正規化。不正入力（英字・負数・小数・ゼロ等）は stderr + exit 1、空文字は `[]` として依存クリア経路を維持

### Changed (Docs, T296)

- **README / manager.md の close-task 旧署名を sweep**。T295 の `--deliverable-kind <files|merged|pr|none>` 必須化に伴い、README.md / README.ja.md に必須フラグを明記。`skills/cmux-team/templates/{ja,en}/manager.md` の Manager/daemon 動作説明文脈では `cmux-team close-task ...` と抽象化

### Changed (Docs)

- **Master テンプレから `cmux-team status` の案内を削除**。Manager TUI で状況確認できるため、Master プロンプトから status への誘導（補足指示・Conductor surface 確認・進捗報告）を削除。ja/en の `master.md` と `docs/spec/04-templates.md` を同期

### Changed (Breaking, T295)

- **`cmux-team close-task` に `--deliverable-kind <kind>` を必須化**。Conductor Step 9 で選ぶ納品方式（`merged` / `pr` / `files` / `none`）を構造化した `deliverable` フィールドとして `task-state.json` に記録する。kind ごとに付随フラグが異なる（排他検証あり）:
  - `merged`: `--merged-into <branch>` + `--merge-sha <sha>`
  - `pr`: `--pr-url <url>`
  - `files`: `--deliverable <path>` 1 件以上（複数指定可）
  - `none`: 付随フラグ無し（`--journal` は強く推奨）
- **`schema.ts` に `Deliverable` zod discriminated union を追加**。`TaskState.deliverable?: Deliverable` として task-state.json に optional フィールドで永続化する。旧 closed 行は `deliverable=undefined` で読める（**読み取り側は後方互換、書き込み側のみ破壊的変更**）
- **dashboard の closed 行末尾に kind suffix を表示**（`merged/abc1234` / `pr/#42` / `files(3)` / `none`）。旧 closed 行は suffix 無しで従来通り
- **`cmux-team trace-task <id>` に `Deliverable:` 行を追加**。Base 行の直後に kind 別の詳細（`merged into <branch> @ <sha>` / `PR: <url>` / `files: ...` / `none (see journal)`）を表示。旧 closed 行は `Deliverable: -`
- **daemon auto-close 経路（T274 セーフティネット）は `{ kind: "none" }` を自動付与**。`handleConductorDone` が close-task 未呼で auto-close する場合でも deliverable の契約を維持する。`auto_closed_by_daemon` journal で手動 `none` との区別は journal 本文から可能
- **移行**: リリース後、各 Conductor ペインで `/clear` を実行して新プロンプトを再読み込みすること。旧プロンプトを抱えたセッションは `--journal` だけで close-task を呼んで exit 1 で止まる（T274 と同じ流儀）
- **対象ファイル**: `skills/cmux-team/manager/{schema,task,main,daemon,i18n,dashboard}.ts(x)`、`skills/cmux-team/templates/{ja,en}/{conductor-role,conductor,conductor-task}.md` の 6 ファイル、`docs/spec/{01,04,05,07}-*.md`、`CLAUDE.md`

### Changed (Breaking, T294)

- **auto-update の `task` モードを廃止（v4.5.0）**。`autoUpdate` は `"off" | "notify"` の 2 値のみに縮約。以下は起動時に exit 1 で reject される:
  - 環境変数 `CMUX_TEAM_AUTO_UPDATE=task` / `=1` / `=true`
  - `.team/config.json` の `autoUpdate: "task"` / `autoUpdate: true` / `autoUpdate: false`（boolean 後方互換を含む全削除）
  - 移行: `autoUpdate` を `"notify"` または `"off"` に書き換える
- **`cmux-team self-update` CLI サブコマンドを削除（v4.5.0）**。
  - 移行: `npm install -g @hummer98/cmux-team@latest` を直接実行する
  - TUI バナー文言を `(upgrade: npm i -g @hummer98/cmux-team@X.Y.Z)` に変更し、手動更新導線を一本化
- **daemon 側で update タスクの自動起票を停止（v4.5.0）**。`createUpdateTask` / `buildUpdateTaskBody` / `DaemonState.updateAvailable.createdTaskId` / `checkUpdateAndNotify` の `task` 分岐を削除
- **旧アーカイブ互換**: タスク frontmatter の `kind: cmux-team-update` は読み取りのみ維持（実行経路なし）

### Removed (T294)

- `skills/cmux-team/manager/daemon.ts`: `createUpdateTask` / `buildUpdateTaskBody` / `updateAvailable.createdTaskId` フィールド
- `skills/cmux-team/manager/main.ts`: `cmdSelfUpdate` 関数、switch `"self-update"` case
- `skills/cmux-team/manager/i18n.ts`: `cmux-team self-update` ヘルプ行（en/ja）
- `skills/cmux-team/manager/dashboard.tsx`: Team Config `autoUpdate` legacy boolean 分岐、banner の `task created` / `task skipped` / `cmux-team self-update` 分岐
- `skills/cmux-team/templates/{ja,en}/master.md`: 排他タスク推奨パターン例の `cmux-team-update` 行

## [4.4.0] - 2026-04-22

### Added

- **`CMUX_TEAM_LOGGER_STRICT=1` による fail-fast strict モード（T292）**。`skills/cmux-team/manager/logger.ts` に環境変数ガードを追加し、テスト実行時に `logger.ts` が `.team/logs/manager.log` へ書き込む前に `process.cwd()` が期待通りのテストプロジェクト配下であることを検証する。不一致なら即座に throw し、テストが repo 直下の `.team/` を汚染する回帰を構造的に防ぐ。`package.json` の `bun run test` でデフォルト有効化
- **`markTaskAborted` / `parseAbortJournal` ヘルパーと abort reason の構造化表示（T290）**。`skills/cmux-team/manager/task.ts` に abort 状態遷移を 1 箇所に統合する `markTaskAborted` を追加し、daemon.ts の 4 経路（`judgment_pending` / `user_clear` / `disconnect_timeout` / `assign_failed`）と main.ts の 2 経路（abort-task CLI）、`applyResumeTransitions` の resume ループを全て置換。journal template が単一定義になり abort 因果の事後追跡が確実になった。併せて `formatAbortedTaskLine` を追加し、`await-task` / `printSummaries` で abort reason を機械可読形式で表示

### Changed

- **test 基盤を `createDummyProject` ヘルパーに全面移行（T292）**。`skills/cmux-team/manager/` 配下の 22 個のテストファイル（`main.test.ts` / `worktree-base.test.ts` / `gh-cache-*.test.ts` / `direnv-check.test.ts` / `cmux.test.ts` / `agent-instructions.test.ts` / `preflight.test.ts` / `pidfile.test.ts` / `trace-store.test.ts` / `task.test.ts` / `rate-limit-persistence.test.ts` / `queue.test.ts` / `proxy.test.ts` / `master.test.ts` / `main-branch.test.ts` / `logger.test.ts` / `eventBus.trace.test.ts` / `envrc-prompt.test.ts` / `daemon.test.ts` / `conductor.test.ts`）を `test-project.ts` の `createDummyProject` helper + 自己テストに統合。テスト毎に一時ディレクトリで `.team/` を構築し、repo 直下の `.team/` を触らない隔離を強制する。`.team/` 汚染検出スクリプト (`test:clean`) を追加し CI で regression を検知
- **main.ts の module-level `process.chdir` を CLI 起動時のみに限定（T292）**。従来 `main.ts` の module load 直後に条件付き `chdir` が走っていたため、単体テストで main.ts を import するだけで process CWD が変わる副作用があった。`cmdStart` 等の CLI 起動経路にのみ移動し、test import では CWD を汚染しないよう修正

### Fixed

- **`cmux-team close-task` 系 CLI で `--task-id` を frontmatter id に正規化（T291）**。`close-task` / `abort-task` / `restart-task` / `delete-task` の各 CLI で、slug 付き task-id（例: `T042-feature-name`）を渡したときに frontmatter の正規 id（`042`）に正規化されず not-found になる問題を修正。`.team/tasks/<slug>/task.md` の frontmatter を読んで正規化する resolver を追加
- **Issues タブのスクロールをカーソル追従に修正（T289）**。Tasks / Artifacts タブと同様の `startIdx` 計算ロジックを `buildIssueRows` に適用し、`issueCursor` が visible 範囲を超えた際にビューが追従するようにした

### Refactored (internal)

- **abort 系 daemon ハンドラを `markTaskAborted` に一本化（T290）**。`daemon.ts` の `judgment_pending`（handleConductorDone 経路）/ `user_clear`（SESSION_CLEAR 経路）/ `disconnect_timeout`（spawnPidWatcher 経路）/ `assign_failed`（assignTask 経路）の 4 分岐と、`main.ts` の `abort-task` CLI 2 分岐、および `applyResumeTransitions` の resume ループ内 inline abort を、`markTaskAborted(taskId, reason, journal)` ヘルパーの呼び出しに置換。journal 整形 / trace DB INSERT / state 遷移 / cascade トリガーを 1 関数に集約し、abort 経路追加時の実装ドリフトを構造的に排除

## [4.3.0] - 2026-04-22

### Changed (Breaking)

- **`cmux-team stop` サブコマンドを廃止（T286、破壊的変更）**。`skills/cmux-team/manager/main.ts` から `cmdStop` 関数（L2160-2182）と switch ルーティングの `case "stop"` を削除し、`./main.ts stop ...` の JSDoc 行も除去した。`skills/cmux-team/manager/i18n.ts` から `help_stop`（en/ja）と `help_main` の `cmux-team stop` 行も削除。cmux セッション終了で daemon が pidfile を自動 release する設計（T259）が既に整っており、明示停止コマンドは不要と判断。`cmux-team stop` を実行すると `Unknown command: stop` で exit 1 する。手動停止は `kill <pid>`（PID は `.team/daemon.pid`）、または cmux セッション自体を終了させる。あわせて `skills/cmux-team/manager/pidfile.ts` の `PidFileLockedError` メッセージから `Run 'cmux-team stop' or` の案内を除去し、`kill <pid> first, or close the cmux session (daemon auto-stops on cmux exit).` に差し替えた。README / README.ja / CLAUDE.md / docs/spec / SKILL.md / cmux-team-guide のドキュメントも同方針に更新

### Fixed

- **`cmux-team start` が team.json に Conductor entry が残っているが実 surface が全て消失した状態から回復できない問題を修正（T286）**。`initializeLayout` / `applyRestorePlan` の discard-only 分岐で、従来は `planLayoutRestore` が「全 discarded」を返したケースで Conductor スロットを再構築せずに戻っており、KDG-SSO 事例のような「cmux セッションを再起動したが team.json の古い entry が残る」状況で Conductor ペインが一切作られないまま daemon だけが立ち上がる現象が起きていた。具体的には: (1) C/E の副作用処理を `applyDiscardOnly` ヘルパーに抽出し `Promise.all` 禁止・sequential 実行を JSDoc で契約化、(2) `planLayoutRestore` 結果が `plan.alive=0 + plan.resumeExisting=0 + plan.resumeNewSurface=0` の場合は `layout_restore_empty_fallback kept=0 discarded=<N> layout=<mode>` をログした上で `applyDiscardOnly` → `initializeConductorSlots` で Conductor を新規構築するフォールバックを追加、(3) `layout_mismatch_on_resume` ログから「`cmux-team stop` then `start --layout=...`」案内を削除し純観測ログ化。M17a（全 E）/ M17b（全 C idle）/ M17c（C+E 混在）/ M17d（resumePlan unmatched）の 4 バリアントと `cmdStop 廃止` テスト（Unknown command + 冪等性）を追加し、`bun test` 0 失敗・`bunx tsc --noEmit` 新規エラー 0 を確認

## [4.2.0] - 2026-04-21

### Changed (Breaking)

- **Conductor Step 8 が rebase conflict を semantic に自動解決するようになった（T284、破壊的変更）**。`skills/cmux-team/templates/{ja,en}/conductor-role.md` Step 8 を「conflict → 即 abort」から「conflict → conflict 情報収集 → 衝突元タスク仕様読み込み → LLM resolution → `bun test` + `bunx tsc --noEmit` 検証 → conflict-resolution.md 書き出し → Step 9 へ進む」のフローに置き換える。編集スコープは conflict marker 出現ファイルに限定（Conductor が直接 Edit / Write を使える唯一の例外）、iteration 上限 5 回、検証には scope_violation の構造的検知（`PRE_REBASE..HEAD` の CHANGED が `ALL_CONFLICT_FILES ∪ PRE_REBASE..ORIG_HEAD` の ALLOWED を超えないか）も含む。LLM が解けない齟齬（`spec_divergence` / `test_failed` / `tsc_failed` / `missing_context` / `scope_violation` / `iteration_limit`）時は従来通り `CONDUCTOR_DONE --success false --reason "Step 8 semantic resolution unresolvable: <failure_mode>"` で escalation し、`rebase-merge` / `rebase-apply` ディレクトリの有無で分岐した rollback（進行中 → `git rebase --abort`、完了済 → `git reset --hard "$PRE_REBASE"`）を行って worktree / branch を温存する。あわせて `skills/cmux-team/manager/conductor.ts` で worktree 作成直後に `git config rerere.enabled true`（`--worktree` 優先・失敗時 `--local` にフォールバック、いずれも best-effort、`rerere_enabled` / `rerere_enable_failed` ログ）を実行し、過去の resolution の再利用を可能にする。監査証跡 `conflict-resolution.md` は `runs/<taskRunId>/` 配下に生成される（フォーマットは `docs/spec/04-templates.md` 参照）。**Rollout 時の注意:** 旧プロンプトを抱えた Conductor が Claude Code のセッション resume で復帰すると古い指示を実行し得るため、リリース後は `cmux-team restart` または各 Conductor ペインで `/clear` を実行して新プロンプトを読み込ませること
- **`CMUX_TEAM_FETCH_BEFORE_WORKTREE` のデフォルトを OFF → ON に反転（T283、破壊的変更）**。worktree 作成前の `git fetch --quiet origin <mainBranch>`（タイムアウト 30 秒、失敗はログのみで継続）がデフォルトで実行されるようになった。stale origin を起点に worktree が切られる事故を防ぐのが目的。offline 環境・rate limit 対策で従来挙動に戻したい場合は `CMUX_TEAM_FETCH_BEFORE_WORKTREE=0` を設定する。起動時ログに `fetch_before_worktree enabled=<on|off> source=<env|default>` を 1 回 emit。解決ロジックは `skills/cmux-team/manager/config.ts:resolveFetchBeforeWorktree` で env > default の優先順位
- **Ready 昇格時に sync state ガードを追加（T283、破壊的変更）**。`cmux-team create-task --status ready` / `cmux-team update-task --task-id N --status ready` の両経路で、昇格前に local リポジトリと `origin/<mainBranch>` の sync state を判定し、`diverged` / `uncommitted` / `detached` では **exit 1** で昇格を拒否する（`ready_rejected` ログ）。`behind-ff` / `no-remote` は警告のみで継続（`ready_warning`）、`clean` / `ahead` は allow。bypass 手段: `--force` CLI フラグ（`ready_force_bypass` ログ）、`CMUX_TEAM_SKIP_SYNC_CHECK=1` env（`ready_sync_skipped` ログ）、`--skip-fetch` CLI フラグ（fetch のみ抑止で判定は実施）。Conductor / Agent shell には `CMUX_TEAM_SKIP_SYNC_CHECK=1` を export し、下位層からの `create-task --status ready` では自分の worktree の sync チェックが回避される。ロジック本体は `skills/cmux-team/manager/git-sync.ts`（7 状態 × 3 分類の pure function + async collector）に切り出し、34 テスト pass

### Added

- **Master に git 読み取り / ローカル同期を許可（T283）**。`templates/{ja,en}/master.md` の「やらないこと（基本方針）」から git 読み取り・`fetch origin` / `pull --ff-only origin <mainBranch>` を除外し、「やること（追加）」に明示した。特に PR が server で `gh pr merge` された後は Master が `git fetch origin && git pull --ff-only origin <mainBranch>` で local を origin に追従させておくフローを推奨。git の **書き込み系操作**（`commit` / `branch <new>` / `merge` / `rebase` / `cherry-pick` 等）は引き続き禁止。`docs/spec/04-templates.md` の Master ワンライナーも同方針に更新
- **Master が意思的に `await-task` を使うパターンを許可**。旧プロンプトの「await-task は不要」という一律禁止を撤回し、Master が自分の判断でターンを次の判断点まで持ち越したい場合（summary を読んで後続タスクを設計する / 複数タスクの収束点で再評価する等）は `Bash(run_in_background=true)` で await-task を起動してよいと `templates/{ja,en}/master.md` に明記した。depends-on の自動チェーンは引き続き Manager の責務

### Fixed

- **rate-limit の `isStale` を 5h/7d 軸別に分離し throttle 凍結を解消（T281）**。従来の `isStale()` は 5h と 7d を OR 判定していたため、5h reset が過去に達しても 7d reset が未来であれば `isStale=false` となり、`daemon.ts` の `throttled5h` ガードが凍結して API コールが一切発生しないまま `state.rateLimit` が古い値で固定される無限ループに陥っていた。`rate-limit-persistence.ts` の `isStale()` を `isStale5h()` / `isStale7d()` に分離し、呼び出し元 6 箇所（`daemon.ts` x2, `proxy.ts`, `dashboard.tsx`, `rate-limit-display.ts`, `main.ts`）を軸別に置換。5h スロットル判定は `isStale5h` のみを参照する。バーごとの表示も軸別 stale 判定に切り替え、`rate_limit_restored` ログに `stale5h=<bool> stale7d=<bool>` を併記。isStale5h 8 ケース / isStale7d 6 ケース / display 4 ケースの計 18 件の regression テストを追加
- **TUI ダッシュボードの Update 通知バナーが null のとき空行を残さない（T282）**。ヘッダー直下に常時 1 行の空白行が残る問題を修正。Update 通知バナーを組み立てる IIFE が null 経路でも `ui.text("", { dim: true })` を返していたため `ui.column({ gap: 0 }, [...])` 内で 1 行分のスペースが占有されていた。配列 spread（`...(cond ? [IIFE] : [])`）に書き換え、non-null 時のみ要素を挿入する形にした

## [4.1.0] - 2026-04-21

### Changed (Breaking)

- **Conductor の完了通知を `close-task` に一本化（T274、破壊的変更）**。`skills/cmux-team/templates/{ja,en}/conductor-task.md` の「完了通知」セクションから `cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true` 指示を削除し、`conductor-role.md` Step 11 の `close-task` に集約した。close-task が内部で CONDUCTOR_DONE を daemon に送信するため、Conductor 側から重ねて送る必要は無い（~/git/Dear T204 で TUI `[assigned]` + manager.log `task_completed` の不整合を引き起こしていた）。`skills/cmux-team/templates/{ja,en}/manager.md` の「主要な完了検出」文も close-task 経由に修正。**Rollout 時の注意:** 旧プロンプトを抱えた Conductor が Claude Code のセッション resume で復帰すると古い指示を実行し得るため、リリース後は `cmux-team restart` または各 Conductor ペインで `/clear` を実行して新プロンプトを読み込ませること

### Added

- **Master の直接作業制約を緩和し、明示指示があるときに限り例外許可（T273）**。`templates/{ja,en}/master.md` の「やらないこと」を 4 小節構造（基本方針 / 例外: 明示指示 / 明示指示があっても禁止 / 判断基準）に再編し、「直接やって」「Master で commit して」等の明示フレーズを使った場合に限り Master が直接作業してよいことを明文化した。`.team/tasks/` 配下の直接編集、assigned タスク編集、Conductor/Agent 直接起動、破壊的 git 操作（push/force-push/reset --hard 等）は明示指示があっても引き続き禁止。`docs/spec/04-templates.md` の Master ワンライナー要約と `docs/spec/01-skill-cmux-team.md` の Master 行要約も同方針に更新
- **worktree start-point に `config-local-ahead` を追加（T275）**。`resolveWorktreeBase` で local `<mainBranch>` が `origin/<mainBranch>` より strict ahead（同一 SHA でない・origin が local の ancestor）のときは local を優先する。`git fetch` せず push しない運用や origin が stale なケースで、stale な base から worktree が切られる問題（ai-web-builder T006 で発生）を解消する。優先順位は `explicit` → `config-local-ahead` → `config-origin` → `config-local` → `head-fallback`
- **conductor-role.md の Step 8/9 を ahead-side rebase と ff-only 失敗レポートに対応（T276）**。Step 8 の rebase 対象を `config-local-ahead` が選ばれたときは local main を優先するロジックに置き換え、Step 9 に ff-only merge 失敗時の判断必要レポート節を追加した。Step 8/9 両方で `CONDUCTOR_DONE --success false` 送信時の `--reason` を必須化し、空 reason で `manager.log` の `conductor_done_unresolved` が `reason=-` になり追跡不能になる事故（ai-web-builder T006）を予防する
- **状態機械 P1 shadow reducer + state machine spec を追加（T279）**。Conductor / Task の reducer を pure function として `skills/cmux-team/manager/state-machine/` に新設し、daemon.ts の各 handler 末尾に shadow observer を try/catch 付きで挿入。副作用は一切実行せず、期待 state と実 state の diff を `fsm_shadow_diff` ログで観測する（`events.ts` / `conductor-fsm.ts` / `task-fsm.ts` / `invariants.ts` / `shadow.ts` / `fsm.test.ts` 136 pass）。`docs/spec/07-state-machine.md` に Conductor / Task FSM リファレンス（Mermaid 図 2 本）を追加し、`CLAUDE.md` / `docs/spec/00-project-overview.md` からリンク。`.team/artifacts/A017-state-machine.md` §5 に shadow 配線の既知差分メモを追加。24h 実稼働観測と daemon 置換は後続タスク送り
- **`handleConductorDone` に success=true 経路の整合性ガード（T274）**。Conductor が `--success true` を送ったのに task-state が `assigned` のまま残っていた場合、`task_completed_state_mismatch` を warn ログに出した上で daemon が自動で `closed` に倒す（journal: `auto_closed_by_daemon: CONDUCTOR_DONE without close-task (taskRunId=<id>)`、trace DB に `event="closed"` 行も insert）。`task-state` entry 自体が無い場合は `task_completed_state_missing` warn ログのみ残し state 書き込みは skip。T263/T269 の `success=false + assigned → aborted` パスと対称な保険として機能し、旧プロンプトを抱えた Conductor が resume した際の再発リスクを吸収する

### Fixed

- **assigning 中の SESSION_IDLE R1 保険を撤去（T277）**。T276 run #1 で、daemon 自身の `/clear` 後の SESSION_IDLE が SESSION_CLEAR より先着することで R1 分岐（daemon.ts:1937-1955）が `assigning → running` に誤って倒し、直後の SESSION_CLEAR が running の user_clear handler に落ちて task が `reason=user_clear` で誤 abort される事故が発生した。R1 分岐を完全削除し、assigning window close を 3 経路（SESSION_STARTED source=clear 正規経路 / SESSION_CLEAR daemon_assign_clear 早期 break / timeout ASSIGNING_TIMEOUT_SEC=60s）に一本化する。併せて R1 でのみ書き込まれていた `sessionIdleAtInAssigning` フィールドと `formatUserClearDecision` の `session_idle_at=` 列を撤去（schema/conductor/daemon）。regression test 2 本を追加、A014-conductor-state-machine.md の row 7 と Mermaid 図 L266 から SESSION_IDLE 経路を除外
- **Artifacts タブのスクロールをカーソル追従にする（T278）**。Tasks タブ（L1112-1117）と同形の `startIdx` 計算を `buildArtifactRows` に導入し、`artifactCursor` の移動に応じて `filtered` を slice する（`ARTIFACT_VISIBLE_LINES = 12`）。`filtered.length > ARTIFACT_VISIBLE_LINES` のとき startIdx を算出して slice、for ループを `visibleArtifacts.length` で回し、`isSelected` 判定を `globalIdx (= startIdx + i) === state.artifactCursor` に変更。プレビュー描画・Up/Down キーハンドラは未変更

## [4.0.0] - 2026-04-19

### Added
- **daemon 多重起動を pidfile ロックで防止（T259）**。`cmdStart` 冒頭（preflight 成功後・direnv / resolveMainBranch / `createDaemon` の前）で `.team/daemon.pid` を `writeFile(..., { flag: "wx" })` により atomic に取得する。既に生きている cmux-team daemon があれば `PidFileLockedError` → `console.error` + exit 1。stale 判定は `isAlive(pid)` false を優先、alive でも `ps -p <pid> -o command=` 出力に `main.ts` / `cmux-team` が含まれなければ PID 再利用とみなして上書き。ps 取得失敗時は保守的に locked 扱い。pidfile は shutdown / onFullQuit / restartRequested / onReload(execFileSync 直前) / cmdStop(保険) の全経路で release され、正常系では必ず削除される。auto-restart ループ（exit 42）では親が release → 子が acquire の順で所有権が移り、親が execFileSync でブロックしていても子が "alive cmux-team" を誤検知せず連続再起動できる。pidfile は daemon main.ts プロセスのみを指し proxy は別ライフサイクル
- **Notification hook を daemon に集約し trace DB に記録（T266）**。Claude Code native の通知（permission 要求 / idle 通知等）を Master / Conductor / Agent の全 settings.json に hook 登録し、daemon が `hook_signals` テーブルに enrichment 付き（surface_uuid / workspace_uuid / role / task_id / conductor_surface / agent_role / message / notification_type）で記録する。観測のみで state 遷移しないため誤検知で pane を close することはなく、`cmux-team trace-hooks --type NOTIFICATION` で事後追跡できる
- **user_clear 判定の decision スナップショットと assigning window ログを追加（T261）**。手動 /clear を受けた際の decision を `assigningSetAt` / `assignedAt` 等を含む構造化スナップショットとしてログ出力し、T232 の assigning 期間中のレース調査を事後解析可能にした
- **Conductor disconnect / broken ログを強化（T260）**。`task_aborted` ログに reason を機械可読キーで出力、`conductor_broken` に pid/alive を併記して `broken_conductor_still_alive` ログを追加、`formatConductorSnapshot` を新設し disconnect snapshot をログ化、`ConductorState.lastHookAt` と `AgentSpawnedMessage` に caller 情報 / `abort_signal_sent` を追加。disconnect 判定の根拠を事後追跡できるようにした
- **Task の二重起動を防ぐ unique 制約を不変条件として検査（T254）**。`taskRunId` と `(status=assigned, conductorSurface)` の 2 つの unique 制約を state 更新時に都度検査し、違反時は assertion で即座に落とす。assign / restart / resume 経路での race による重複起動を構造的に排除
- **initializeLayout の復帰ロジックをマトリクス方式に刷新（T255）**。既存 surface の role 検出と復帰判定を「状態マトリクス × アクション表」で宣言的に記述し直し、従来の if-ladder で隠れていた復帰漏れケースを解消
- **起動時 resume 不可検出で ready に戻さず aborted に倒す（T264）**。`cmdStart` 起動時、`status=assigned` のタスクが `sessionId` / `taskRunId` / `worktreePath` を満たさない場合に旧 `resume_fallback_to_ready` で ready に戻していた挙動を撤廃し、`resume_marked_aborted` で aborted に倒すよう変更。成果物を人間が確認する前に自動再実行される事故を防ぐ。journal に runs ディレクトリの相対パスを埋め、`cmux-team restart-task` で明示的に再走できる

### Changed (Breaking)

- **`mainBranch` 解決失敗時を fail-stop に変更（T253、破壊的変更）**。従来 `resolveMainBranch` は `git symbolic-ref refs/remotes/origin/HEAD` と `git symbolic-ref --short HEAD` の両方が失敗した場合にサイレントで `{ branch: "main", source: "fallback" }` を返していたため、存在しない `main` ブランチに対して commit/merge を行い破綻するリスクがあった。本変更で検出失敗時は `MainBranchResolutionError` を throw し、`cmux-team start` は `console.error` に 3 つの解決手段（`--main-branch <name>` / env `CMUX_TEAM_MAIN_BRANCH=<name>` / `.team/config.json` の `mainBranch`）を案内して `process.exit(1)` する。派生する下流フォールバック（`cmdConductor` / `cmdSpawnConductor` の `|| "main"`、`DaemonState.mainBranch` 初期値、`launchConductor` / `initializeConductorSlots` / `assignTask` / `generateConductorTaskPrompt` / `generateConductorRolePrompt` の `"main"` リテラル）も全て撤去し、空文字受領で throw する防御ガードに統一。`MainBranchSource` enum から `"fallback"` を削除。**影響:** 既に `.team/config.json` に `mainBranch` が永続化済みのプロジェクトは影響なし（T213 以降で起動した大多数）。新規 repo（push 前）・shallow clone・detached HEAD・`origin/HEAD` 未設定のプロジェクトでは env か config での明示指定が必要

### Fixed
- **`persistMainBranch` で `.team/` 未作成時の ENOENT を修正（T270）**。`.team/config.json` への書き込み時に親ディレクトリが無い環境で ENOENT になる経路を塞ぎ、初回起動の `resolveMainBranch` 永続化を確実に成功させる
- **`CONDUCTOR_DONE --success=false` で assigned タスクを aborted に倒す（T269）**。Conductor が `--success=false` で終了した際、task-state が `assigned` のままでは daemon 再起動時の `applyResumeTransitions` が resume 可能と誤分類する事故を起こしていた。state を `aborted reason=judgment_pending` に倒しつつ worktree / branch は preserve する経路に変更し、`cmux-team restart-task` で明示的に再投入できるようにする。journal に `conductor_done_unresolved: <reason> (worktree=<path>) taskRunId=<id>` を記録
- **`CONDUCTOR_DONE --success=false` で worktree / branch を preserve（T263）**。従来は worktree を削除してしまい人間判断に委ねる経路が消えていた。Conductor が自力完遂できず人間判断待ちになるケースでは worktree と branch を温存する挙動に修正（T269 と併せて完全化）
- **`formatUserClearDecision` の `assigning_set_at` フィールドを `assigningSetAt` 由来に修正（T265、T261 follow-up）**。旧実装が `assignedAt` を誤参照していたため assigning window の表示が歪んでいた
- **Master タブ名を SESSION_STARTED 受信で `[N] Master` に再 rename**。F1 fallback 経路で仮登録された Master タブ名が `[N] Fallback` のまま残る問題を修正
- **Full Quit 時に `state.conductors` / `state.masters` を clear してから `team.json` を永続化**。残留エントリが次回起動時に幽霊 Conductor / Master として誤検出される経路を解消
- **`resetConductor` で surface 実在確認を追加し幽霊 Conductor を防ぐ**。close 済み surface に対する reset で state のみが残る経路を塞いだ

## [3.54.1] - 2026-04-18

### Added
- **daemon メインループに Mac スリープ復帰検出ログを追加**。`sleepUntilWakeup` の前後経過時間を計測し、`pollInterval * 3` を超えた gap を検知したら `wake_detected gap=<秒>s` を `manager.log` に出力する。caffeinate `-dis`（T256）でもなお発生するスリープ復帰の事後診断に利用する

## [3.54.0] - 2026-04-18

### Added
- **Conductor に `broken` ステータスを追加し、エラー発生時の自動再利用を停止（T250）**。従来は disconnect timeout の forced close 後に idle へ戻して即座に次のタスクを割り当てていたため、接続エラーの根本原因を調査しないまま同じ Conductor が再利用されてしまっていた。`ConductorStatus` に `broken` を追加し、forced close 時は idle ではなく broken へ遷移してユーザーが明示的にクリアするまで再利用しない。`cmux-team clear-conductor --surface <id>` で broken → idle に復帰可能。broken 中は SESSION_STARTED/ACTIVE/IDLE/CLEAR の 4 ハンドラで early-return し `session_event_ignored_broken` ログを残す。dashboard に broken 行（⨯ RED + `use clear-conductor` ガイド + brokenCount ヘッダー）を追加
- **マージ前に `origin/<mainBranch>` へ rebase する手順を Conductor に追加（T249）**。worktree 内で commit 後に `git fetch --quiet origin <mainBranch>` → `git rebase origin/<mainBranch>` を実行し、納品時の merge は `--ff-only` で fast-forward 限定とする。main 側で conflict が surface するのを防ぎ main を常にクリーンに保つ。rebase conflict 時は即 `git rebase --abort` して人間の再判断に委ね、close-task は呼ばずタスクは assigned のまま残す
- **Agent ロール別の project-local instructions overlay 機構（T247）**。プロジェクト固有の Agent 運用ルール（例: `.team/agent-instructions/implementer.md` にコーディング規約を記述）を role 単位で注入できる仕組み。全 Agent ロールテンプレートと Conductor の heredoc 内に `{{PROJECT_INSTRUCTIONS}}` プレースホルダを追加し、`cmux-team spawn-agent` 時に `.team/agent-instructions/<role>.md` の内容で置換する（不在時は空文字）。`cmux-team {get,set,delete,list}-agent-instructions` CLI を追加
- **タスク排他実行属性 `--exclusive` を追加（T246）**。リリース作業・コンフリクト解消・破壊的依存変更など、他タスクを全て止めて単独で走らせたい作業のために、3 フェーズモデル（drain → exclusive run → resume）の排他実行属性を追加。`--exclusive` 同士は ID 昇順に順次排他実行、`--exclusive` と非排他 `--run-after-all` は共存不可。assigned 中は他の全 assignment を停止し、closed になると次 tick から通常 assignment を再開
- **trace DB `task_sessions` に `base_branch` / `base_sha` / `base_source` 列を追加（T243）**。`assignTask` で worktree 作成直後に `git rev-parse HEAD`（cwd=worktreePath）を呼んで親 commit の SHA を取得し、`event=assigned` 行に worktree の出発点情報を記録する。`base_branch` は `WorktreeBaseResolution.baseLabel`（`origin/main` / `main` / `HEAD` 等）、`base_source` は `WorktreeBaseSource` enum（`explicit` / `config-origin` / `config-local` / `head-fallback`）、`base_sha` は 40 桁 hex。既存 DB は `initDB()` 内の `PRAGMA table_info` ベースのマイグレーションで `ALTER TABLE ADD COLUMN` 経由に列追加され、過去行は NULL のまま温存される（冪等）。`cmux-team trace-task` の出力ヘッダに `Base: <label> @<short-sha> (source=<source>)` を 1 行追加し、worktree が削除された後でも事後診断ができるようにした
- **depends_on 親 abort/deleted 時の ready 子 cascade（T241）**。親タスクが `aborted` / `deleted` に遷移したとき、`depends_on` に親を含む **ready** 状態の子タスクを自動的に `draft` に戻す。`draft` / `assigned` / `closed` / `aborted` / `deleted` 子は変更なし。cascade は 5 経路（abort-task CLI / delete-task CLI / forced close / user_clear / assign_failed）で同期的に走る。ログに `child_reverted_to_draft parent=<X> child=<Y> reason=parent_aborted` を出力

### Changed
- **Conductor worktree の base を `origin/<mainBranch>` 優先で解決（T242）**。`skills/cmux-team/manager/worktree-base.ts:resolveWorktreeBase` を新規追加し、`assignTask` の worktree 作成時に task.md `base_branch:` 明示 → `origin/<mainBranch>` → local `<mainBranch>` → HEAD fallback の優先順位で start-point を決定する。従来は `base_branch:` 未指定時にローカル HEAD へ暗黙依存していたため、ローカル main が origin から乖離していると worktree に無関係 commits が紛れ込み PR を汚染していた（Dear T165 / PR #1891 の 14 タスク分混入）。ログに `worktree_created branch=<new> base=<ref> source=<explicit|config-origin|config-local|head-fallback> path=<...>` を常時出力。環境変数 `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` で事前 `git fetch --quiet origin <mainBranch>` を opt-in 可能（デフォルト OFF、失敗はベストエフォート継続）
- **macOS スリープ抑止 `caffeinate` のフラグを `-i` から `-dis` に変更（T256）**。`caffeinate -i` は `PreventUserIdleSystemSleep` のみを立てるため display sleep 経由の system sleep 連鎖を防げず、daemon 稼働中でも Mac が sleep する事象が観測されていた（`pmset -g log` で確認）。`-dis` に変更して `PreventUserIdleDisplaySleep`（display sleep 抑止）と `PreventSystemSleep`（AC 電源時の system sleep 抑止）を併用することで、アイドル由来・display sleep 連鎖由来のスリープを共に防ぐ。副作用として稼働中はディスプレイが常時点灯する（バッテリー消費増）。Apple Silicon + 蓋閉じの Clamshell Sleep はハードウェア強制でフラグでは防げないためスコープ外

### Fixed
- **`AGENT_SPAWNED` を Claude 起動前に POST して master fallback 誤作成を防止（T244）**。spawn-agent が Claude を起動した後に daemon へ `AGENT_SPAWNED` を POST していたため、起動直後の `SESSION_STARTED` が先着して daemon が未知 surface と誤認し master の fallback 登録を行うレースがあった。Claude exec の直前に POST する順序に変更し、daemon が必ず Agent として認識できるようにした

## [3.53.0] - 2026-04-17

### Added
- **Agent の AskUserQuestion 発生を Conductor に通知し TUI で可視化（T238）**。`AgentState.status` に `"asking"` を追加し、`SESSION_ASK` hook 発火時に daemon が status を `asking` に遷移させ `notifyStateChanged()` で TUI を即時更新、加えて `cmux notify` で OS 通知を発火する。dashboard の Agent 行は YELLOW + `?` アイコン + `asking` ラベルで表示され、Conductor が Agent の応答待ちであることが一目で分かる。解除は既存の `SESSION_STARTED` / `SESSION_IDLE` の status 上書きで自然に行われるため追加コードなし

### Fixed
- **`cmux-team resume` 実行時の Conductor resume 失敗を修正（T239）**。`cmdConductor` が `cwd: PROJECT_ROOT` で Claude を exec するのに対し `cmdResume` は `cwd: ts.worktreePath` だったため、Claude が別 project dir のセッション保存先を探しに行き `"No conversation found with session ID: ..."` で resume に失敗していた。`cmdResume` の cwd を `PROJECT_ROOT` に揃え、保存済みセッションと整合させる

## [3.52.0] - 2026-04-17

### Added
- **TUI サブエージェント行に Spinner を実装（T236）**。`AgentState` に `status ("starting" | "running" | "idle")` を必須フィールドとして追加し、`AGENT_SPAWNED` / `SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR` hook で status を遷移させる。dashboard は Agent 行で running/starting 時に CYAN スピナーを表示し、idle 時に role アイコンを dim 表示。Conductor idle + Agent 単独 running 時もアニメーションが前進するよう `needsAnimation` に OR 条件を追加。既存の `spinnerFrame` を再利用し、Conductor と同じ status 3 値で対称性を保つ
- **Conductor status に `assigning` を追加し daemon `/clear` の user_clear 誤認を修正（T232）**。`assignTask` が送信した `/clear` に起因する SESSION_CLEAR hook を daemon が「ユーザー手動 /clear」と誤認して task-state.json を aborted に書き換える race condition を解消。`assigning` 状態中の SESSION_CLEAR は早期 break で destructive 処理を完全スキップし、SESSION_STARTED / SESSION_IDLE / SESSION_ACTIVE には `assigning → running` 分岐を追加。60s assigning timeout で固着時は `disconnected` に倒し、`scanTasks` catch にも assigning fallback を組み込み構造的にレースを排除
- **Master を self-register 方式に変更（T230）**。任意の pane から `cmux-team spawn-master` で Master を追加できるようにするため、daemon の `spawnAndRegisterMaster` 直書き方式から Master 実行プロセス自身 (`cmdLaunchMaster`) が `MASTER_REGISTERED` を daemon に POST する self-register 方式に変更。`daemon.ts` に `MASTER_REGISTERED` ハンドラを追加し、SESSION_STARTED の master 経路に F1 fallback を組み込み（MASTER_REGISTERED 先着前の SESSION_STARTED 仮登録 + PID watcher 起動）。複数 Master の並行運用が可能に
- **Master を複数受け入れる基盤整備（T229）**。singleton の `state.masterSurface / masterPid / masterStatus / masterPromptPreview / masterPromptAt / masterPidWatcherInterval` を `state.masters: Map<surface, MasterState>` に置換し、Master を N 個受け入れられるよう daemon 内部を全面改修。`.team/masters/<surface>.json` への per-master 永続化、旧 `.team/master.surface` + `team.json.master.pid` からの冪等マイグレーション、`proxy.ts` POST `/master-state` の surface 必須化（2 Master 以上で未指定なら HTTP 400）、GET `/state` body の `masters` を配列化
- **`close-agent` コマンド追加（T231）**。Agent の正常完了と強制終了でシグナルを分離した。`close-agent` は `reason=close-agent` → `agent_done status=completed`、既存の `kill-agent` は `reason=kill-agent` → `agent_done status=crashed` とする後方互換を維持。Conductor テンプレート（ja/en × `conductor.md` / `conductor-role.md`）を更新し、正常完了時は `close-agent` を使うよう指示
- **Conductor を self-register 方式に変更（T228）**。Conductor の daemon への登録を Manager の `launchConductor` からの HTTP POST 方式から、Conductor 実行プロセス自身 (`cmdConductor` / `cmdResume`) が自分を register する方式に変更。任意の surface から手動で `cmux-team conductor` を実行しても daemon に登録されるようになった。`CONDUCTOR_REGISTERED` ハンドラを idempotent merge 化（既存 state ありは skip + ログ）、`state.conductors.size` が `maxConductors` を超える新規登録は soft cap 警告を出してから登録続行
- **daemon 再起動時に最後の 5h/7d rate limit を復元（T227）**。`state.rateLimit` を `.team/rate-limit.json` に atomic write で永続化し、daemon boot 時に注入する。stale ガードを throttle 判定 5 箇所（dashboard / proxy / daemon 2 箇所 / 新 rate-limit-display）に追加し、復元した古いデータで新規タスク割当や spawn-agent が誤ってブロックされないようにする。`rate-limit-display.ts` を Ink 非依存の純粋関数モジュールに切り出し、stale 時は GRAY + `(stale)` ラベルを表示

### Changed
- **master / daemon 周辺を整理（T234）**。T230 Master self-register の follow-up 5 件を一括処理。`stopDaemon` で PID watcher interval を全解放（タイマー残留によるプロセス非終了を解消）、`normalizeSurfaceForPath` を `paths.ts` に集約（重複定義解消）、`master.test.ts` を新規追加（persistMasterFile / deleteMasterFile / listMasterFiles の境界 13 ケース）、F1 fallback で master 仮登録された conductor の整合処理（`CONDUCTOR_REGISTERED` で fallback 仮登録削除、`MASTER_REGISTERED` で fallback flag を落として canonical 化）、`registerSelfAsMaster` / `registerSelfAsConductor` を `registerSelf(role, surface)` に DRY 共通化

### Fixed
- **TUI ヘッダーで bar と remaining time の間に 1 スペース（T235）**。rate-limit バーの 5h/7d 表示で bar 本体の直後に残り時間が密着していた（例: `████░░░░░░5h`）。非 throttled パスの描画ロジックに 1 スペースを挿入し `████░░░░░░ 5h  7d: ...` の表示に修正。group 間の 2 スペースは従来通り

## [3.51.0] - 2026-04-17

### Added
- **direnv allow 未実行時の fail-fast 判定を導入（T225）**。`.envrc` が direnv allow されていない状態で `cmux-team start` や `spawn-agent` を実行すると、`CLAUDE_CODE_OAUTH_TOKEN` 等の環境変数が block され Conductor/Agent が意図しない認証経路で起動する事故が起きていた。新規 `direnv-check.ts` で `direnv status` の `Found RC allowed` 値をチェック（0=allow のみ ok とする fail-closed 判定）し、未 allow 時は原因と修復コマンドを表示して exit 1 する。`no_direnv`（direnv 未インストール）は警告のみで続行、`no_envrc`（`.envrc` 不在）は従来通り素通り
- **Master の稼働中ステータスを TUI スピナーに反映（T175）**。Master Claude セッションの SessionStart / SessionEnd hook を `master-settings.json` に追加し、Master が busy / idle / prompt 状態に遷移した際に TUI ダッシュボードのスピナーが即座に更新されるようにした。`/master-state` ハンドラに `notifyStateChanged()` 呼び出しを追加し、ログに `master_state status=... prompt=...` を 1 行出力（40 字トリム）

### Changed
- **docs/spec と cmux-team-guide を実装の現状に同期（T224）**。`03-commands.md` に `trace` / `trace-hooks` の関連 CLI 参照を追記、`05-install-and-infrastructure.md` の CLI 表に `trace-hooks` 行を追加し `restart-task` 行を実装準拠（assigned/aborted 両対応）に修正、`.team/config.json` スキーマに `mainBranch` を追加。`cmux-team-guide` SKILL.md からも `restart-task` の誤記「assigned → ready に戻す」を修正

### Fixed
- **envrc-prompt の env 変数ベース判定に修正（T223）**。`.envrc.local` / `~/.zshenv` / `source_up` / 外部注入など `.envrc` 本体以外からの `CMUX_CLAUDE_HOOKS_DISABLED` 設定が検知されず過剰プロンプトが出る問題を解消。`ensureEnvrcHookPrompt` の gating に env 変数チェックを追加（`CMUX_TEAM_NO_PROMPT` 直後、log reason=`already_in_env`）し、既存の `.envrc` ファイル内容チェックも残して log reason を `already_in_envrc` に改名（direnv allow 未実行ケースの重複 append 防止）

## [3.50.0] - 2026-04-16

### Added
- **`cmux-team trace-hooks` サブコマンド追加（T217）**。Manager daemon が受け取った hook シグナル（SessionStart / Stop / SessionEnd 等）を trace DB (`.team/traces/traces.db`) の `hook_signals` テーブルから一覧・検索できる CLI を追加。タスク実行中に「hook が発火したのか届かなかったのか」を事後追跡でき、Conductor / Agent の state 遷移のデバッグが容易になる

### Changed
- **hook 全送信ポリシーに一本化（T216）**。これまで hook 側の shell スクリプトで matcher 条件や reason による分岐を持たせていたが、hook は全イベントを Manager に転送し、フィルタリング・ルーティング・state 遷移判定は Manager 側（`daemon.ts handleMessage`）でのみ行う設計に統合。`handleMessage` 入口で必ず `insertHookSignal` を呼び、後からデバッグする際に「hook は発火したか」を追跡可能にした。SessionEnd の `reason=other` は記録のみで state 遷移しない（`/clear` 等の曖昧な終了を disconnected と誤判定しないため）
- **`cmux-team-investigate` スキルに hook シグナル追跡手段を追記（T218）**。別プロジェクトの `.team/` 調査時に `trace-hooks` を使って hook 発火履歴を確認する手順を追加

### Fixed
- **`.claude-plugin/plugin.json` から不要な SessionStart hook 定義を削除（T221）**。plugin install 時に重複した hook が登録される副作用を解消

## [3.49.0] - 2026-04-16

### Added
- **`.team/config.json` に `mainBranch` フィールドを追加（T213）**。Conductor が worktree 作成時のベース・マージ先として使うブランチ名をプロジェクト毎に切り替え可能にした。`cmdStart` 実行時に `config` → `git symbolic-ref refs/remotes/origin/HEAD` → `"main"` の順で解決し、`.team/config.json` に書き戻す。Conductor には `CMUX_TEAM_MAIN_BRANCH` 環境変数経由で注入される。`main` 以外の主開発ブランチ（`master`, `trunk`, `develop` 等）を持つプロジェクトでも `cmux-team` がそのまま動作するようになった
- **`CONDUCTOR_DONE` / `SESSION_CLEAR` / `SESSION_STARTED` に taskRunId 一致検証を導入（T219）**。hook 経由で届くメッセージの `taskRunId` と Manager が保持する assigned タスクの `taskRunId` を比較し、不一致の場合はメッセージを無視する。古い Conductor セッション（restart-task 前の残骸 hook）が新しいタスク実行に干渉するレースを構造的に排除

### Changed (Breaking — soft)
- **statusline を proxy HTTP API 化（T211）**。`statusline.sh` は daemon の `POST /statusline` に stdin JSON をそのまま転送するだけの curl ラッパー（~15 行）に縮退し、描画ロジックは TypeScript (`skills/cmux-team/manager/statusline.ts`) に移植。DaemonState から master / conductor / agent / agent の親 conductor を直接逆引きし、surface ヘッダー単独で role 判定できるようになった。旧 bash 版と 1 バイト単位で一致する出力を維持しつつ、子プロセス fork（bash + jq × 5）を proxy 内部の純関数呼び出しに置き換えた
- **Master UserPromptSubmit / Stop hook を `.claude/settings.json` から `master-settings.json` に移設（T211）**。旧実装では同ファイルが Agent / Conductor / Master すべての Claude セッションに適用されてしまい、Agent / Conductor の hook 発火時に Master 状態を `busy` に上書きする汚染バグがあった。Master 専用 settings に移して `cmdLaunchMaster` から `--settings` 経由で明示的に注入するように変更。Python スクリプト本体は `.team/prompts/master-hook-busy.py` / `master-hook-stop.py` として独立ファイル化し、embed エスケープ地獄を解消
- **`ConductorState.conductorId` フィールドを schema から撤去（T210）**。surface ref で一意に識別できるため `conductorId` は冗長だった。`conductor-task.md` テンプレートの `{{CONDUCTOR_ID}}` 参照と Conductor hook 内の `CONDUCTOR_ID` 参照を全削除。`task-state.json` / `team.json` の schema 定義からも撤去。外部から `conductorId` を参照するカスタム hook / スクリプトがある場合は破壊的変更になる

### Changed
- **worktree 生成時の `.envrc` 書き出しと `direnv allow` 自動実行を削除（T212）**。`launchConductor` 起動時の env 注入に一本化されたため、worktree 固有の環境変数設定は不要になった。副作用として Conductor worktree が clean になり、`.gitignore` に `.envrc` を追加する必要もなくなった

### Fixed
- **Conductor 完了時の `CONDUCTOR_DONE` 二重送信を解消（T214）**。`conductor-role.md` の完了処理ステップ 12 が残っており、Stop hook 経由の CONDUCTOR_DONE と手動送信の CONDUCTOR_DONE が重複して届く状況だった。ステップ 12 を削除し、hook 経由の push に一本化

### Removed
- **`CMUX_ROLE` 環境変数を完全削除（T211）**。旧 statusline.sh が bash 内で master / conductor / agent 分岐するために使っていたが、ロール判定は proxy 内部の DaemonState 逆引きに移行したため env ベースの伝搬は不要になった。`cmdConductor` / `cmdResume` / `cmdLaunchMaster` / `cmdSpawnAgent` の 4 箇所から除去。`.claude/settings.json` から `UserPromptSubmit` / `Stop` hook 定義（`CONDUCTOR_ID` guard 込み）も撤去し、`.team/tasks/` 保護 PreToolUse hook のみ残存
- **`CONDUCTOR_ID` 環境変数参照を廃止（T210）**。Conductor hook / `conductor-task.md` テンプレートから `CONDUCTOR_ID` 参照を除去し、surface ref で識別する経路に統一

## [3.48.0] - 2026-04-15

### Added
- **`cmux-team restart-task` が `aborted` 状態のタスクからも実行できるようになった（T204）**。これまで `assigned` のみ許容していたが、内部で worktree / branch を冪等削除し `task-state.json` の resume フィールド（`worktreePath` / `taskRunId` / `conductorSlot` / `sessionId` / `abortedAt` / `assignedAt`）を剥がして `ready` に戻す `restartFromAborted()` 経路を追加。aborted で滞留したタスクの再投入が CLI 一発で行える

### Changed (Breaking — soft)
- **`conductor-settings.json` を共通ファイル 1 個に集約（T206）**。これまで Conductor surface ごとに `.team/prompts/surface:NNN-settings.json` を生成していたが、ファイル内容は surface 独立であることが判明したため `.team/prompts/conductor-settings.json` 1 個に統合した。**既存の起動中 Conductor は古いファイルパスを `--settings` 引数として参照しているため、本バージョンに上げる場合は `cmux-team start` を full quit → restart する必要がある**。`/clear` だけでは復旧しない

### Changed
- **`cmux-team conductor` / `cmux-team resume` から `CMUX_SURFACE` 環境変数必須を撤廃（T206）**。env が未設定の場合は `cmux identify` の `caller.surface_ref` から自動解決する。手動デバッグ目的で `cmux-team conductor` を直接叩く運用が可能になった
- **`--surface` CLI オプションが UUID 形式も受け付けるようになった（T206）**。`cmux send` / `cmux send-key` と同様、`surface:NNN` ref と UUID の両形式を受け付ける。内部で `cmux --id-format both --json tree` 経由で正規化される。対象: `send` / `send-agent` / `spawn-agent` / `await-agent` / `kill-agent`。`send --from-stdin`（hook 経由）は ref 契約のため正規化対象外
- **`paneId` の永続化を廃止し surface→pane を on-demand 解決に統一（T207）**。`ConductorState.paneId` / `ConductorRegisteredMessage.paneId` を schema から完全削除し、spawn-agent / resetConductor / onFullQuit すべてで `cmux tree` 経由のリアルタイム解決に切り替えた。dummy paneId 混入経路（手動 `CONDUCTOR_REGISTERED` で別 pane に Agent が生成される実害）を構造的に根絶。`cmux.ts` に `listSiblingSurfaces(surface, workspace?)` を新設し、`cmux tree` 1 回呼びで対象 surface の所属 pane → 同 pane 全 surface を 1-pass 集約。`cmux-team send --pane-id` 引数も廃止
- **`SessionStart` hook の matcher を全ソース対応に変更（T203）**。Conductor / Agent 双方の hook を `matcher: ""` に変更し startup / resume / clear / compact すべてで発火するようにした。daemon の `SESSION_STARTED` ハンドラに sessionId 追従と `task-state.json` 同期更新を追加。`crypto.randomUUID()` による Conductor sessionId 自己生成と `CONDUCTOR_SESSION` メッセージ経路を撤廃

### Fixed
- **`startMaster` で v3.46→v3.47 マイグレーション環境の重複 spawn を修正（T201）**。team.json に `master.pid` が無い既存環境で daemon を再起動すると、`startMaster` が短絡評価で `alive=false` となり既存 Master を dead 判定して重複 spawn する不具合があった。pid 未登録時は `cmux.getPaneForSurface` による surface 生存確認にフォールバックする経路を追加。フォールバック経路では `state.masterPid` と `spawnMasterPidWatcher` を skip
- **`/clear` 後の `cmux-team resume` 失敗を修正（T203）**。Claude Code の `/clear` が新 session-id を発行するが、`SESSION_STARTED` ハンドラが pid のみ更新し sessionId を触らないため、`task-state.json` には初回 UUID が凍結記録されて "No conversation found with session ID" で resume が失敗していた。`SessionStart` hook 経由で sessionId を daemon に push し assigned タスクの sessionId を上書きするよう修正
- **`spawn-agent → await-agent` の team.json stale read レースを修正（T205）**。`handleMessage` は state を mutate するが `updateTeamJson` は tick ループでのみ呼ばれるため、`onMessage` 完了 → 200 OK → CLI が即 team.json を読む経路で "agent surface not registered in team.json" exit 1 が起きていた。`onMessage` ラッパ内で `handleMessage` 直後に `updateTeamJson` を同期実行し、「`cmux-team send X` が 200 OK を返した時点で team.json は最新」という不変条件を確立
- **`classify-stop` を `stop_reason` ベースに置換し agent_monologue SKIP を削除（T208）**。Stop hook は `stop_reason === "end_turn"` 時のみ発火するため、「最後の assistant 行に tool_use が無い ＝ まだモノローグ中」という推測ロジックの前提自体が成立していなかった。A[191] 事例（Write 連打 → 最終ターン text-only 完了報告 → SKIP 判定で `await-agent` が永久ブロック）を踏まえ `classifyStopPayload()` を ASK / IDLE の 2 択に縮退

### Removed
- 旧 `.team/prompts/surface:NNN-settings.json` ファイルは `cmux-team start` が再生成しなくなる（既存ファイルは手動削除推奨だが、放置しても害はない）
- `cmux-team send --pane-id` 引数を削除（T207、上記 paneId 永続化廃止に伴う）

## [3.47.1] - 2026-04-15

### Fixed
- **Manager daemon 再起動時に死亡 Conductor で `disconnected` 状態が固着する問題を修正**。restart 時に存在しない Conductor surface をそのまま復元していたため、生存確認が通らず `disconnected` でタスク割当不能のままスタックしていた。起動時にスキップして idle に戻すよう修正

## [3.47.0] - 2026-04-15

### Added
- **Artifact 登録コマンドを move ベースに変更、Researcher ロールを新設（T198）**。`cmux-team artifacts add` がファイルを `.team/artifacts/` 配下に物理移動する挙動に統一され、外部パス（Conductor/Agent の出力ディレクトリ配下など）から直接 artifact 化できるようになった。併せて調査系タスク向けの Researcher サブエージェントロールを templates に追加し、ja/en テンプレートを同期
- **touched-files zero-errors ルールを inspector / implementer / planner に追加（T197）**。タスクで触れた全ファイルがタスク完了時点で型エラー / lint エラー / テスト失敗をゼロにする要件を 3 ロールのテンプレートに明文化

### Changed (Breaking)
- **Manager の Conductor/Agent/Master 生存監視を PID ベースに全面移行（T195）**。`cmux tree` / `cmux list-status` を使った周期ポーリングを廃止し、SessionStart hook が送る `SESSION_STARTED`（`--pid` 付き）で Manager が PID を受け取り、`spawnPidWatcher` / `spawnAgentPidWatcher` / `spawnMasterPidWatcher` が 1 秒間隔で `process.kill(pid, 0)`（`cmux.isAlive(pid)`）を呼んで生死判定する。cmux 側の SwiftUI メインスレッドデッドロック（A011）で Manager daemon がハングする問題を根治する
- **Agent 起動時に `SessionStart` hook を追加**。`.claude/settings.json` の `SessionStart` に `cmux-team send SESSION_STARTED --pid "$PPID" --surface "$CMUX_SURFACE" --conductor-surface "$CMUX_CONDUCTOR_SURFACE" --role "$CMUX_ROLE"` を登録し、Agent 側も PID が Manager に伝わるようにした。Conductor/Agent の `team.json` に `pid` フィールドが永続化され、`cmux-team resume` 時に復元される
- **`isMasterAlive(state)` のシグネチャ変更**。以前は `workspace` を受けて `cmux tree` を叩いていたが、今は `state.masterPid` を `process.kill` するだけ。`validateSurface` も cmux.ts から削除（呼び出し箇所なし）
- **PID 再利用に関する注意**。PID は OS が再利用する可能性があるため、SessionEnd hook による明示的な `SESSION_ENDED` 通知を優先する。pidWatcher はあくまで hook が来なかった場合のフォールバック扱い
- **削除ログイベント**: `tree_failed` / `list_status_failed` / `surface_validation_failed`（新イベント: `pid_watcher_started` / `session_ended`（`reason=pid_watcher`））

### Changed
- **Conductor テンプレート書き換え**。`skills/cmux-team/templates/ja/conductor.md` / `en/conductor.md` の Agent 監視ループから `cmux list-status` 参照を削除し、`cmux-team await-agent` の exit code（0=completed/ask, 10=crashed, 2=timeout）を case 分岐で扱う手順に差し替えた
- **ドキュメント同期**。`CLAUDE.md` / `skills/cmux-team/SKILL.md` / `docs/spec/01-skill-cmux-team.md` / `docs/spec/04-templates.md` / `.team/specs/requirements.md` から `cmux list-status` 参照を削除し、`cmux tree` の用途を「init 時の pane 逆引きのみ」と明記

### Fixed
- **`findTemplateDir` の探索順を project-local 優先に反転（T200）**。npm でグローバルインストールされた templates が project-local のテンプレート編集を上書きしてしまう問題を修正。これにより `skills/cmux-team/templates/` 配下の編集を再インストールなしで即反映できる
- **dashboard Journal panel の surface 表記を修正（T196）**。`surface:NNN` の `surface:` prefix を strip して `[NNN]` の統一フォーマットで表示するよう修正

## [3.46.0] - 2026-04-15

### Added
- **Agent の完了検出を await-agent 方式に刷新（T181）**。Conductor の 30 秒ポーリング（`cmux read-screen`）を廃止し、Agent の Stop/SessionEnd hook が done マーカーを書き出し、Conductor 側は `cmux-team await-agent` が `fs.watch` で即時検知する pull 型構造に移行。TOCTOU 対策として watcher を先に起動し、`startedAt` 比較で古い done マーカーを無視する
- **AskUserQuestion の構造的検出（T181）**。Agent のトランスクリプト JSONL から AskUserQuestion を検出し、Agent タスクでは Conductor が自律回答、Conductor タスクでは TUI に `status=asking` バッジを表示してユーザー介入を待つ。`schema.ts` に `SessionAskMessage` / `ConductorState.askQuestion` を追加
- **Stop hook の分類ロジックを Manager 側に移行（T189）**。shell 側の detect-ask スクリプトを 70 行→23 行の forwarder に縮退し、ASK/IDLE/SKIP の判定は daemon の純粋関数 `classifyStopPayload()` が担当する（unit test 15 件）。preflight に `jq` 必須化を追加（python3 fallback を撤去）
- **logger の surface 表記を簡略化（T192）**。`formatSurface()` / `formatPair()` ヘルパーを追加し、`surface:NNN` 生表記を `C[665]` / `A[719]` / `C[665]>A[719]` のようなロール別プレフィックス形式に統一。`daemon_started` ログ先頭に `package.json` から読んだバージョンを付加
- **タブ名をロールのみに固定（T193）**。従来のタスク進捗を混ぜた動的タブ名を廃止し、`[N] Master` / `[N] Manager` / `[N] Conductor` / `[N] Agent` の 4 種類だけに正規化。タスク状態は dashboard / team.json / statusline / log で可視化する

### Changed
- **Conductor の初期プロンプトを廃止（T193）**。Conductor ペインは ❯ idle 状態で起動し、タスク割当時にだけプロンプトを push するようになった。起動直後に 1 通のチャットメッセージが消費されなくなり、`/clear` なしで 1 ターン分のコンテキストを節約できる。`i18n.ts` から未使用の `conductor_wait_prompt` を削除
- **ドキュメント同期（T191）**。CLI 一覧を `cmux-team --help` と同期（`await-agent` / `await-task` / `self-update` / `trace-task` を追加、旧 trace 系を削除）し、T181 の await-agent 方式、T187 の autoUpdate 3 モード、レイアウト戦略 wide / 16x9、コマンド一覧（/master, /team-spec, /team-task, /team-archive, /artifact, /docs-sync, /trace-task）を `docs/spec/` と README 両版に反映。`docs/spec/06-implementation-tasks.md` に Phase 10（T180-T190）を追加

### Fixed
- **既知の tsc エラー 6 件を解消（T190）**。T181 で顕在化した型エラーを実行時挙動を変えずに解消: `cmux.ts` の execFile 戻り値を destructure + `.toString()` で string に正規化、`@types/update-notifier` を devDependencies に追加（T187 で入れ忘れ）、`dashboard.tsx` の無効な `dsVariant: "unstyled"` を削除（2 箇所）、`main.test.ts` の RegExp capture を non-null 断言、`main.ts` の `state.workspace` を `?? undefined` で変換

## [3.45.0] - 2026-04-14

### Changed (Breaking)
- **auto-update を `update-notifier` ベースの 3 モード（`off | notify | task`）に再設計（T187）**。daemon 自身は install しなくなり、`task` モードでは `--run-after-all` の update タスク（frontmatter `kind: cmux-team-update`）を自動起票して Conductor に install を委ねる。検出間隔は 12h 固定。`NO_UPDATE_NOTIFIER=1` で無効化可能。`cmux-team self-update` サブコマンドを追加（手動起票）
- **config `autoUpdate: true` の意味が「install 実行」から「update タスク起票」に変わる**（T186 から T187 への移行時に注意）。`true` → `task`、`false` → `off` と内部で正規化
- **起動時ログのフォーマット変更**: `auto_update_config enabled=<bool> source=<src>` → `auto_update_config mode=<mode> source=<src>`
- **削除ログイベント**: `npm_auto_update` / `npm_update_check_failed` / `npm_self_update_completed`（新イベント: `update_check_started` / `update_available` / `update_task_created` / `update_task_skipped_*` / `update_check_failed`）

### Added
- `update-notifier@^7.0.0` 依存追加（Bun 動作確認済み）
- `dashboard.tsx` に update 通知バナー（黄色、ヘッダ直下）を追加。`notify` モードでは `cmux-team self-update` 誘導文言、`task` モードでは起票済み task ID を表示
- `schema.ts` に `AutoUpdateMode` enum + `normalizeAutoUpdate()` ヘルパー
- `task.ts` に `createTaskProgrammatic()` を新設（cmdCreateTask と daemon 内部起票の共通化）
- `cmux-team --version` / `-v` フラグを追加。`package.json` のバージョンを出力して即終了する（T185）
- `eventBus.ts` に `notifyStateChanged` / `onStateChanged` の名前付きラッパーを集約し、Conductor の status 変更・daemon の tick/monitor/scan 結果・dashboard の再描画購読を接続。tick 待ちなしで TUI が即時反映される。`CMUX_TEAM_TRACE_EVENTS=1` で `event_emit` ログが `manager.log` に出力される（T184）
- `update-task` 等の全更新経路から `TASK_UPDATED` を emit し TUI が即時反映されるよう統一（T183）

## [3.44.1] - 2026-04-14

### Changed
- `/release` コマンドを Master 自身が実行する方式から `--run-after-all` タスクとして起票する方式に変更。全オープンタスクの完了を待って Conductor がリリース作業を実行する運用に統一
- 仕様書 (`docs/spec/`) を v3.39〜v3.43 の実装状況に同期。Phase 9 運用強化セクション（CLI 拡張、i18n テンプレート、レート制限スロットル、conductor 制御 hook 等）を追加
- `.claude/scheduled_tasks.lock` を `.gitignore` に追加（ローカル固有のランタイム状態のため追跡対象外）

### Fixed
- cmux daemon 高負荷で `cmux tree` が一時的にタイムアウトした際、Manager が Conductor を crash と誤判定し稼働中タスクが abort される問題を修正。タイムアウトは `unknown` 状態として扱い、連続失敗が閾値を超えた場合のみ `cmux_unresponsive` で disconnected 化する。環境変数 `CMUX_TEAM_UNRESPONSIVE_MAX_TICKS` (default 6) / `CMUX_TEAM_UNRESPONSIVE_MAX_SEC` (default 120) で調整可能

## [3.44.0] - 2026-04-14

### Added
- `--layout=16x9` レイアウトモードを追加。上段フル幅（Manager|Master タブ）+ 下段 2 分割（Conductor x2）で 16:9 ディスプレイに最適化。`.team/config.json` の `layout` フィールドでも指定可能。`CMUX_TEAM_MAX_CONDUCTORS` が 2 超の場合は警告ログ出力で 2 にクランプ

### Changed
- macOS スリープ抑止（`caffeinate`）を daemon ライフタイム常時ではなくアクティブなタスク実行中のみ有効化。アイドル時はスリープを許可しバッテリー消費を抑制

### Fixed
- `logger.ts` の `PROJECT_ROOT` がモジュール読み込み時に一度だけ評価されていたため、テストが本番のログディレクトリにログを書き込んでしまう問題を修正。呼び出しごとに遅延評価するよう変更し、回帰テストを追加

## [3.43.0] - 2026-04-12

### Added
- `cmux-team send-agent --surface <agent-surface> <message>` を追加。Conductor が自分で spawn した Agent にだけメッセージを送れる正規ルート。`.team/team.json` で呼び出し元との関係を検証し、自己送信・他 Conductor・他 Conductor の Agent は reject する。`spawn-agent` 直後の反映ラグに備えて `agent_not_found` の場合のみ 200ms × 最大 5 回リトライ (#21, #22)
- Conductor に PreToolUse hook を追加。Bash tool 経由の `cmux send` / `cmux send-key` を実行時にブロックし、stderr に代替コマンド (`cmux-team send-agent`) を案内する（既存 Conductor は `cmux-team stop` → `start` で再起動すると反映される）(#21)
- スロットル中のサブ Agent 起動を抑制する仕組みを追加。proxy に `/rate-limit` API を設け、throttle 検出時は `cmux-team spawn-agent` が exit 75 で終了し Conductor 側でリトライする流れに統一

### Changed
- `conductor-role.md`（ja/en）の他 surface 直接操作禁止の記述を強化し、API エラー等で停止した Agent の回復手順として `cmux-team send-agent` の使用例を追記
- 調査系タスクの完了時に summary.md を artifact として自動保存するステップを `conductor-role.md` に追記

### Fixed
- daemon 再起動時に assigned タスクの `cmux-team resume` コマンドが Conductor ペインのシェルではなく既に起動済みの Claude Code のチャット入力として送信され、セッション再開が行われない問題を修正

## [3.42.0] - 2026-04-12

### Added
- プロジェクト内専用の開発者スキル `cmux-team-investigate` を追加。別プロジェクト (mado, Dear 等) の `.team/` 調査フローを定義（配布対象外）
- 初回起動時に `.envrc` へ `CMUX_CLAUDE_HOOKS_DISABLED=1` の追記を対話提案。追記後は `direnv allow` + 再起動を案内するメッセージを表示
- `initInfra` 時に `.gitignore` / `config.json` / `team.json` の自動生成をログへ記録し追跡可能に
- `execFile` エラー時に `stderr` / `stdout` をログへ含めるユーティリティ (`exec-error.ts`) を追加し、cmux 呼び出し経路の障害原因を追跡可能に

### Changed
- ロギングポリシーに「外部コマンド失敗時は stderr/stdout 同梱必須」ルールを追記
- `conductor-role.md` に他 Conductor surface の直接操作禁止ルールを追記
- `/release` 手順 4 に `marketplace.json` のバージョン更新ステップを追加
- `cmux-team-investigate` スキルの trace DB 参照手順を現行実装に同期

### Fixed
- Bun.serve の idleTimeout が未設定 (デフォルト 10s) のため Claude API の長時間 SSE ストリーム (拡張思考等) が途中で切れ "socket connection was closed unexpectedly" が発生する問題を修正。最大値 255s まで延長
- ダッシュボードの `THROTTLED` 表示が重複していた問題を修正し、点滅表示に変更
- ダッシュボードでタブ軸キー操作時に `activeTab` と `focusedArea` が同期されず表示が崩れる問題を修正
- `marketplace.json` のバージョンが実装と乖離していた問題を修正し同期

## [3.41.0] - 2026-04-12

### Added
- `cmux-team await-task --task-id <id>` コマンドを追加。タスク完了をノンブロッキングで待機し、完了時に summary を stdout に出力
- エージェントプロンプトテンプレートの i18n 対応。`templates/ja/` と `templates/en/` にディレクトリ分離し、ロケールに応じて自動選択
- `cmux-team start` 時に `.team/.gitignore` を自動生成。セッション固有ファイルを除外し追跡対象を明確化

### Changed
- Master statusline のコスト表示を open タスク数表示に置換（サブスクでは従量コスト不要）
- mo ビューアで同一ワークスペース内の既存ブラウザを再利用。新規 split を作らず `goto` でナビゲート

### Fixed
- mo ビューアでファイル固有 URL（`?file=<id>`）を使い、対象ファイルに直接フォーカスするよう修正

## [3.40.0] - 2026-04-11

### Added
- ロール別カスタムステータスバーの実装。Conductor・Agent がそれぞれの役割に応じたステータス表示を行う
- Conductor 完了時にセッション上へ要約レポートを自動表示
- TUI を停止せず `mo` + `cmux browser open` で Markdown を表示する方式に変更

### Changed
- Conductor 起動関数を統合し session-id を自己生成方式に変更
- Conductor の slot-id 引数を廃止し `CMUX_SURFACE` 環境変数に統一

### Fixed
- `cmux-team stop` 時に assigned タスクの worktree まで削除してしまい、再起動時の resume が失敗する問題を修正。worktree クリーンアップを full_quit から撤廃
- resume 失敗時のログに worktreePath・sessionId 等の詳細情報を追加
- worktree 作成時に baseBranch を start-point として使用するよう修正

## [3.39.1] - 2026-04-11

### Changed
- Conductor の hooks から cmux 自動通知（`cmux claude-hook notification/stop/session-start` 等）を全削除。通知制御は Manager 側で行う方針に統一

## [3.39.0] - 2026-04-11

### Added
- `cmux-team trace-task <task-id>` CLI コマンドを追加。タスクに関連する全セッション情報（Conductor・Agent）を一覧表示
- `cmux-team-guide` スキルを追加。配布先でも cmux-team の機能・使い方・仕様に関する質問に回答可能に
- TUI Tasks パネルで Enter キーを押すと task.md を Markdown ビューアで閲覧可能に

### Changed
- trace DB を HTTP リクエストログから タスク-セッション索引に再設計。タスクごとの全セッション（Conductor・Agent）を追跡可能に
- `docs/spec/` を v3.35〜v3.38 の実装変更に同期

## [3.38.0] - 2026-04-11

### Added
- `artifacts open` サブコマンドを追加。アーティファクトを Markdown ビューア（`mo`）で表示可能に。環境変数 `CMUX_TEAM_MD_VIEWER` でビューアをカスタマイズ可能

### Fixed
- Master spawn 時に `CMUX_CLAUDE_HOOKS_DISABLED=1` が未設定のため cmux 通知が大量発生する問題を修正
- running 状態の Conductor に手動 `/clear` を送信してもステータスがリセットされない問題を修正。abort + idle リセットが正しく動作するように
- `resume` で実行中タスクの多重起動を防止

## [3.37.0] - 2026-04-11

### Added
- Manager daemon がサイドバーステータス（idle / running / error 等6状態）をリアルタイム更新

### Fixed
- タスク割り当て時に Conductor セッションが `/exit` で毎回破棄される問題を修正。`/clear` 方式に戻し、常駐セッションを維持するように変更
- session-id を初回起動時に発行し、Conductor のライフタイム中維持するように修正

## [3.36.0] - 2026-04-11

### Added
- Conductor 起動時に `--session-id` を指定してセッションを resume 可能に
- `update-task` に `--depends-on` オプションを追加し、タスク間の依存関係を設定可能に
- `artifacts add` コマンドを追加。既存ファイルをファイル名指定でアーティファクトとして登録可能に
- `cmux-team start` 時にワークスペース名を起動フォルダ名に自動設定
- `cmux-team resume` で restart 時に Conductor セッションを resume で再開

### Changed
- 5h レート制限のスロットリング閾値を 95% から 90% に変更し、より早い段階で新規タスク割り当てを一時停止
- Conductor/Agent spawn 時に `CMUX_CLAUDE_HOOKS_DISABLED=1` を設定し、hooks による干渉を防止

## [3.35.0] - 2026-04-10

### Added
- `restart-task` サブコマンドを追加。実行中タスクの中止＋再キューを1コマンドで実行可能に (T124)
- worktree 作成時に `source_up` の `.envrc` を自動生成し、親ディレクトリの OAuth トークンを継承 (T127)

### Changed
- `spawn-conductor` から split を除去。現在の surface で直接 Conductor を起動するように変更。`--surface`/`--direction` 引数を削除 (T125, T126)

## [3.34.1] - 2026-04-10

### Fixed
- spawn-agent で worktree に cd した後に `direnv allow` が実行されず、Agent が OAuth トークンを引き継げない問題を修正 (T123)

## [3.34.0] - 2026-04-10

### Changed
- Agent/Conductor 起動時の環境変数をワンライナー export からシェルへの焼き付け方式に変更。プロセス死亡時も環境変数が維持される (T122)
- worktree 作成後に `direnv allow` を自動実行し、`.envrc` の OAuth トークンが worktree 内でも自動的に利用可能に (T122)

## [3.33.0] - 2026-04-10

### Added
- タスク作成後の即時反応: `create-task --status ready` 実行時に daemon が次の tick を待たず即座にタスクを検出・割り当て開始 (T120)
- ダッシュボードのレート制限表示にリセットまでの残り時間を追加（`5h: 42% ████░░░░░░ 1h23m` 形式）

### Changed
- ダッシュボードヘッダーから PID 表示を削除し、表示をシンプル化

### Fixed
- Conductor がサブエージェント完了待ちの間に TUI 上 idle と誤表示されるバグを修正。`validateSurface` に 3 回リトライを追加し、一時的な `cmux tree` 失敗による crashed 誤検出を防止 (T121)
- crashed 判定時の遷移を即 idle → disconnected に変更し、5 分の猶予期間で自動復帰を可能に (T121)
- crashed 処理の cleanup 漏れ修正: `taskRunId` / `taskTitle` / `agents` が残る問題を解消 (T121)

## [3.32.0] - 2026-04-10

### Added
- i18n 対応: `CMUX_TEAM_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG` の優先順でロケールを検出し、CLI メッセージ・help テキストを EN/JA で自動切り替え
- `cmux-team start` に preflight チェックを追加。git リポジトリ確認、claude/bun コマンド存在確認、書込権限検証を一括実施し、失敗項目をまとめて表示

### Changed
- `assignTask` のエラー影響範囲を分離。worktree 作成失敗などの task 起因エラーでは Conductor を idle のまま維持し、cmux 送信失敗などの conductor 起因エラーのみ disconnected 扱いに変更 (T117)
- `docs/spec/` を T082〜T116 の実装変更に同期（delete-task/abort-task Journal、4 フェーズフロー、proxy/trace 現状化ほか） (T118)

## [3.31.0] - 2026-04-09

### Added
- worktree 作成時に `.claude/settings.local.json` をコピーし、サブエージェントが同じローカル設定で動作するように (T116)

## [3.30.0] - 2026-04-09

### Added
- plan.md の出力先を worktree から OUTPUT_DIR（タスクフォルダ `runs/` 配下）に変更 (T107)
- ダッシュボード Tasks の並び順を open 上位 + createdAt 降順に変更 (T108)
- `delete-task` コマンド追加 (T109)
- `abort-task` の Journal 記録対応 (T109)
- タスク時間管理: `assignedAt` 記録 + ダッシュボードに経過時間表示 (T110)
- workspace 分離: `cmux identify` から workspace_ref を取得し、他ワークスペースの surface との混同を防止 (T116)

### Fixed
- メモリリーク修正: daemon.ts の interval 重複・fs.watch 未クローズ・proxy.ts の `drainAndLog` 未 catch (T113)
- Conductor `starting` 状態のステート遷移バグ修正 (T114)
- `daemon_auto_restart` 後に Master が proxy を見失う問題を修正 (T115)

## [3.29.0] - 2026-04-07

### Added
- タスク中心フォルダ集約: プロンプト・出力をタスクディレクトリ（`.team/tasks/TNNN-slug/runs/`）に統合。タスク単位で関連ファイルが一箇所にまとまる (T102)
- Tasks タブで Enter 押下時にタスクドキュメントを glow フルスクリーンビューワーで表示 (T103)
- PreToolUse hook で `.team/tasks/*/runs/` 配下への書き込みを許可。指示書の生成がブロックされなくなる (T104)
- ダッシュボードの 5h/7d レート制限表示を個別色化し、ダークトーンに変更 (T105)

### Fixed
- `close-task` 実行後に CONDUCTOR_DONE メッセージが送信されず Conductor が stuck するバグを修正 (T106)

## [3.28.0] - 2026-04-07

### Added
- Journal・Log の表示順を逆転し、最新エントリが一番上に表示されるように変更。エントリ追加時は先頭表示中なら自動追従、スクロール中は位置を保持、フォーカス中は自動スクロール無効 (T100)
- ダッシュボードの TPM 表示を 5h/7d の unified 使用率表示に置換

### Fixed
- Tasks スクロール領域が広くなりすぎていたのを5行に戻した (T099)

## [3.27.0] - 2026-04-07

### Added
- `dockeeper` スキル (`skills/dockeeper/SKILL.md`) を新規追加。`git log` と closed タスク履歴を参照して `docs/spec/` を実装と同期する
- `/docs-sync` スラッシュコマンドを追加。`--dry-run`（差分確認のみ）・`--auto`（確認なし自動更新）オプション対応
- ダッシュボードの GitHub issue リンクに OSC 8 ハイパーリンクを有効化。対応ターミナルでクリック可能に (T093)
- ダッシュボード Tasks 行全体をクリック可能に (T094)

### Changed
- ダッシュボードヘッダーから RUNNING 表示を削除し、バージョン番号の表示位置を移動 (T095)
- Master プロンプト: assigned タスクへの補足指示フローを改善。`abort-task` 推奨を廃止し、状態確認 → `--depends-on` 後続タスク作成 or `cmux send` 直接送信の判断フローを追加

### Fixed
- `create-task --help` に `--run-after-all` オプションの説明を追加 (T098)
- ダッシュボード Tasks セクションのスクロールが5件で止まるバグを修正 (T096)
- Master がアイドル時にスピナーが回り続けるバグを修正 (T097)

## [3.26.1] - 2026-04-06

### Fixed
- Conductor の hook 注入を `CMUX_CLAUDE_HOOKS_DISABLED` 方式に修正。cmux ラッパーが `--settings` を先に注入するため cmux-team の hooks が無視される問題を解消。cmux hooks と cmux-team hooks をマージした単一の settings で両方が正常に動作するように (T092)

## [3.26.0] - 2026-04-06

### Added
- Conductor 起動時に `--settings` フラグで hook 設定を自動注入 (T089)。worktree 内でも SessionStart フックが正しく動作するように

### Fixed
- daemon 起動時の `console.log` 出力を `log()` に置換。ログがファイルに統一され TUI 表示が崩れなくなった

## [3.25.0] - 2026-04-06

### Added
- ダッシュボードヘッダーに proxy ポート番号を表示（例: `:60372`）。proxy が生きているかひと目でわかるように
- ダッシュボード Tasks セクションのヘッダーをクリックでタスクフォーカスに切り替え可能に
- タブボタン（Journal / Artifacts / Log）クリック時に対応エリアにフォーカス移動

### Fixed
- `daemon_reload`（R キー）後に proxy が道連れ停止するバグを修正。`exit 42`（auto_restart）を受け取った子 daemon が終了すると proxy 所有者の親 daemon も `process.exit(0)` して proxy が停止する問題を解消。cmux-team.js と同様の再起動ループを組み込み、proxy を安定させる
- `tick()` で proxy の死活を毎ポーリング確認し、停止時にログ（`proxy_dead`）を記録。問題発生時の原因追跡が可能に
- ダッシュボードのカーソルスタイルを `{ underline: true }` → `{ style: { underline: true } }` に修正（rezi-ui スタイル仕様に合わせる）
- ダッシュボード QoL 改善: フォーカスシステム・スクロール・カーソル (T088)

## [3.24.2] - 2026-04-06

### Fixed
- `task_completed` イベントの二重記録を防止。CONDUCTOR_DONE ハンドラにステータスガードを追加し、同一タスクの完了が複数回記録される問題を解消 (T085)
- Journal の `Tundefined` 表示を防御。不正なログ行を削除し、タスクID が未定義のまま記録される問題を修正 (T087)

## [3.24.1] - 2026-04-05

### Fixed
- `create-task` CLI で `dependsOn` 変数が二重宣言されていたバグを修正。`cmux-team start` が即クラッシュする問題を解消

## [3.24.0] - 2026-04-05

### Added
- タスクに `base_branch` フィールド追加。`create-task --base-branch` でマージ先ブランチを明示的に指定可能。TUI に Nerd Font ブランチアイコン（）で表示
- `create-task` CLI に `--depends-on` オプション追加。タスク間の依存���係を指定可能に
- `SESSION_CLEAR` メッセージ追加。`/clear` 実行時に disconnected Conductor を自動回復（TUI チラつきなし）
- TUI ダッシ��ボード QoL 改善: Tasks/Journal のステータスを Nerd Font アイコン化、カーソル表示をアンダーバーに変更、Journal 内の surface 表示を dim 化

### Fixed
- `create-task --depends-on` が無視されるバグを修正。frontmatter に `depends_on` が書き出されず依存チェックが機能しなかった問題を解消

## [3.23.0] - 2026-04-05

### Added
- TUI ダッシュボードを起動シーケンスの早期に表示。プロキシ起動直後に TUI を立ち上げ、Conductor/Master の起動進捗はジャーナルで確認可能に。console.log を廃止し manager.log に統一
- TUI 右上にトークン残量 % をリアルタイム表示。proxy.ts で API レスポンスのレート制限ヘッダーを記録し、ダッシュボードに反映
- Conductor の実装フローテンプレートを強化。4フェーズ（Plan → Design Review → TDD → Inspection）の各テンプレートに詳細な指示・チェックリストを追加

## [3.22.1] - 2026-04-04

### Fixed
- Conductor 初期化時のレースコンディションを修正。pane 分割と Claude 起動を2フェーズに分離し、最初に spawn された Conductor が "starting" に戻されて disconnected になる問題を解消

## [3.22.0] - 2026-04-04

### Added
- Conductor の実装フローを4フェーズ（Plan → Design Review → TDD → Inspection）に刷新。各フェーズに専用テンプレート（planner, design-reviewer, implementer, inspector）を追加
- 起動コマンド名を `spawn-*` に統一（`launch-master` → `spawn-master`）、未使用の `restart-conductor` / `reset-conductor` を削除

### Fixed
- IPC 移行で残存していた `sendMessage` 参照を HTTP API (`postMessage`) に移行

### Changed
- assigned（実行中）タスクの編集禁止ルールを Master テンプレートと CLAUDE.md に明記

## [3.21.0] - 2026-04-04

### Added
- TUI の Master 列に状態表示（running/idle/入力プロンプトの先頭部分）を追加。Claude Code hooks + daemon HTTP API で連携
- ファイルベース IPC を HTTP API に移行（キュー・done マーカーを廃止し、proxy エンドポイント経由の通信に統一）
- Conductor の自己登録方式を導入（`spawn-conductor` コマンド新設）。daemon が Conductor を直接管理する代わりに、Conductor 起動時に自身を登録する形に変更
- Conductor に "starting" ステータスを追加。起動途中の Conductor にタスクが割り当てられる問題を防止

## [3.20.1] - 2026-04-04

### Changed
- TUI の tasks 表示が 2 秒ポーリングではなく daemon の状態変化直後に更新されるように改善

## [3.20.0] - 2026-04-04

### Added
- `--model` オプションで Master・Conductor・Agent ごとに使用モデルを指定可能に（`cmux-team spawn-master --model claude-opus-4-6` 等）

### Fixed
- `spawn-master` 経由で起動した Master が指示に無応答になる問題を修正（初期プロンプト引数を渡していたため Claude が print モードで起動・終了していた）
- プロキシのエラーが `manager.log` に記録されなかった問題を修正（`fetchHandler` に try-catch を追加）
- streaming レスポンスのログ処理中に例外が発生した場合、`reader.releaseLock()` が呼ばれず応答がブロックされる可能性を修正

## [3.19.1] - 2026-04-04

### Fixed
- `cmux-team start` 起動時に dashboard.tsx の `SPINNER_FRAMES` 重複宣言で Bun ランタイムエラーが発生する問題を修正

## [3.19.0] - 2026-04-04

### Added
- `abort-task` コマンドを追加。実行中タスクの中止・Conductor/Agent の強制停止・worktree クリーンアップを一括実行
- TUI の running Conductor にスピナーアニメーション（boxBounce: ▖▘▝▗）を追加
- TUI の Tasks セクションにカーソル移動とスクロール機能を追加（上下矢印キー対応）
- TUI のタスク一覧で `depends_on` の未解決依存を `[blocked Txxx]` として表示
- TUI の Journal に Conductor の surface 番号 `[xxx]` を表示
- Master の Claude Code セッション状態を Manager が監視し TUI に反映（connected/disconnected/idle/running）
- GitHub Actions によるリリース自動化ワークフロー（タグ push で npm publish + GitHub Release）
- ロギングポリシーを策定し全般的にログを改善。外部コマンド失敗・判断分岐・例外の握りつぶしを解消

### Changed
- npm auto-update を全 Conductor が idle のときのみ実行するよう制限
- `docs/seeds/` を `docs/spec/` にリネーム。設計シードから統合仕様書に位置づけを変更
- 統合仕様書を現在の実装に同期

### Fixed
- dashboard.tsx の型エラーと task.test.ts のモック不足を修正

## [3.18.0] - 2026-04-04

### Added
- ブランチ名・worktree パスをタスクIDベースの命名に変更（`task-<NNN>-<timestamp>` 形式）。git branch や git log からどのタスクの作業か一目で判別可能に

### Fixed
- タスク未割り当ての Conductor が disconnected になった際に `T000` と表示される問題を修正

## [3.17.0] - 2026-04-04

### Added
- 全サブコマンドに `--help` オプションを追加。AI がコマンド仕様を自己参照可能に
- タスクに `run_after_all` フラグを追加。全通常タスク完了後に実行するタスク（リリース等）をキュー可能に
- ステートファイルを統一し PreToolUse hook で保護。AI からの直接編集をブロック
- task-state.json のアトミック書き込み（tmp → rename）を実装

### Fixed
- `/clear` 時に Conductor が一時的に disconnected 表示になる問題を修正。SessionEnd hook の matcher から `clear` を除外

### Changed
- ConductorState を team.json に永続化。daemon 再起動時にタスク割り当て情報を復元可能に
- Conductor マーカーファイル方式を廃止。team.json + cmux tree ベースの管理に統一

## [3.16.0] - 2026-04-03

### Added
- Master/Conductor/Agent 起動時に `CMUX_NO_RENAME_TAB=1` を設定。using-cmux の SessionStart フックによるタブ名上書きを抑止
- using-cmux プラグインとの共存が可能に。排他的な競合警告を削除

## [3.15.0] - 2026-04-03

### Added
- using-cmux スキルの機能を cmux-team に統合。cmux 環境内でのペイン操作・サブエージェント管理が単一プラグインで完結
- TUI ログタブにローカルタイムゾーン表示とスクロール機能を追加
- Master surface のマーカーファイル方式を実装。daemon が Master を確実に識別可能に

### Fixed
- Agent 完了時に Conductor ツリーから削除されない問題を修正（SESSION_ENDED が Agent surface でも正しく処理されるように）
- spawn-agent が Conductor のペインではなくフォーカス中のペインにタブを作成するバグを修正。paneId を明示的に指定するように変更
- TUI で closed タスクが running 表示のままになるバグを修正。task-state.json の status を優先するように変更

## [3.14.0] - 2026-04-03

### Added
- Artifacts タブで Enter キーによる Markdown ビューア起動。環境変数 `CMUX_MD_VIEWER` でビューア指定可能（デフォルト: glow → cat フォールバック）

### Changed
- サブエージェントの TUI ツリー削除トリガーを明示的キューメッセージ (AGENT_DONE) から SESSION_ENDED（Claude フック自動発火）に変更。Conductor クラッシュ時のゴーストエントリを防止

### Fixed
- SESSION_ACTIVE/SESSION_IDLE イベント受信時に disconnected 状態の Conductor が復帰しない問題を修正。セッションが生存しているのにタスク割り当てされない状態を解消

## [3.13.1] - 2026-04-03

### Fixed
- auto-restart 時の Conductor 発見をマーカーファイル方式に変更。タブ名ベースの検出は using-cmux の hook によるタブ名上書きで機能しなかった問題を修正

## [3.13.0] - 2026-04-03

### Changed
- Conductor の識別子を固定名 (conductor-slot-N) から surface ID に変更。auto-restart 時に旧セッションのイベントが新 Conductor に誤適用される問題を根本解決
- auto-restart 時の Conductor 発見を team.json ベースから cmux tree ベースに変更。同一 workspace 内の既存 Conductor を自動再利用し、surface の無限増殖を防止
- team.json のアトミック書き込み (tmp → rename) で、restart 時のファイル破損を防止
- CLI の `--conductor-id` オプションを `--conductor-surface` に変更

### Fixed
- Journal タブのエントリを新しい順（逆順）で表示するように修正

## [3.12.1] - 2026-04-03

### Fixed
- SESSION_ENDED 受信時に Conductor を即座に disconnected 状態にし、再接続の無限リトライを防止

## [3.12.0] - 2026-04-02

### Added
- Artifacts 機能: 調査結果・設計判断・セッション要約を `.team/artifacts/` に記録・管理する仕組みを追加
- `/artifact` コマンドで会話コンテキストからアーティファクトを生成・一覧・表示
- `cmux-team artifacts` CLI サブコマンド（list / show / create）
- Manager TUI に Artifacts タブを追加。一覧表示・詳細プレビュー・キーボードナビゲーション対応

### Fixed
- `spawn-agent` が `CMUX_SURFACE` 環境変数から pane を自動解決するように修正

## [3.11.0] - 2026-04-02

### Added
- TUI のタスクタイトル内の GitHub issue 番号（`#xxx`）を OSC 8 ハイパーリンクとして表示。クリックでブラウザが開く
- Agent の `session_id` を `AgentState` に記録し、`team.json` や `agents` サブコマンドで参照可能に (#16)

### Changed
- タスク番号の表記を `#xxx` から `Txxx` に変更。`#xxx` は GitHub issue 専用に

## [3.10.0] - 2026-04-02

### Changed
- Conductor 起動を並列化し、チーム立ち上げ時間を短縮
- Trust 確認の待機処理（waitForTrust）を廃止。Conductor hooks による自動承認に統一

## [3.9.2] - 2026-03-31

### Fixed
- Stop hook が毎ターンの応答完了で `SESSION_ENDED` を送信し、Conductor が応答するたびに disconnected 扱いになるバグを修正。`SESSION_IDLE`（応答完了）と `SESSION_ENDED`（セッション終了）を分離
- タスク完了検出の `doneCandidate` 二重確認ロジックを廃止。最大20秒の完了検出遅延を解消

## [3.9.1] - 2026-04-01

### Added
- TUI で `Q`（Shift+Q）によるフルシャットダウン機能。全 Agent → Conductor → Master の surface を close し、worktree をクリーンアップしてから daemon を終了。Y/N 確認ダイアログ付き

## [3.9.0] - 2026-04-01

### Added
- Conductor ライフサイクル監視: Claude Code の SessionStart/Stop hooks と PID ウォッチャーにより、Conductor の起動・停止・切断を約1秒以内に検知
- `disconnected` 状態: Claude Code が終了した Conductor をダッシュボードで可視化（⚠ アイコン）
- `restart-conductor` / `reset-conductor` コマンド: 切断した Conductor の手動復旧が可能に
- `update-task --body` / `--title`: draft/ready 状態のタスク内容を CLI から更新可能に

### Changed
- 配布版 SKILL.md を 593行から 147行に最小化。Manager/Conductor/Agent の内部プロトコルを CLAUDE.md に移動し、Master が不要な情報を持たない設計に
- Conductor テンプレートにブートストラップ手順と Agent 起動ルールを追加
- cmux-agent-role SKILL.md からタスクファイルフォーマット例を削除し CLI 使用のみに

### Fixed
- `update-task` にステータス遷移ガードを追加。assigned/closed 状態のタスク変更を拒否し、実行中タスクの意図しない上書きを防止
- `close-task` に assigned ガードを追加（`--force` で強制可能）
- Master テンプレートで `.team/tasks/` への直接書き込みを明示的に禁止

## [3.8.1] - 2026-03-31

### Fixed
- Conductor 起動時に `CONDUCTOR_ID` 環境変数が未設定だった問題を修正。Agent spawn 時に team.json から paneId を取得できず、タブではなく split で作成されていた

## [3.8.0] - 2026-03-31

### Added
- daemon 稼働中の npm auto-update 機能。5分間隔で npm registry から最新バージョンを確認し、新バージョンがあれば自動インストール + 再起動する

## [3.7.1] - 2026-03-30

### Fixed
- Conductor のタスク完了検出を run ベースの done マーカーから task ベースの status.json に変更し、完了判定の信頼性を改善
- ロギングプロキシの `Bun.serve()` を `development: false` に設定し、stdout へのログ出力が TUI ダッシュボードに重なる問題を修正

## [3.7.0] - 2026-03-30

### Added
- ファイルシステム監視（fs.watch）による即時タスク検出。`.team/tasks/` や `.team/queue/` への変更をポーリング間隔を待たずに即座に処理
- ロギングプロキシの再利用機能。既存プロキシが生存していれば新規起動をスキップし、daemon 再起動時のポート競合を回避

### Changed
- ダッシュボードのレイアウトを簡素化（ヘッダー統合、セクションタイトルのスリム化）
- ダッシュボード更新処理に lifecycle error ハンドリングを追加し、高速更新時のクラッシュを防止
- Manager タブタイトルに surface 番号を付与（`[N] Manager` 形式）
- `spawn-agent` の `--task-title` 省略時に Conductor のタスクタイトルをフォールバック

## [3.6.1] - 2026-03-30

### Changed
- Master/Conductor の起動を `cmux-team conductor <id>` / `cmux-team spawn-master` CLI ラッパー経由に変更。起動時に `.team/proxy-port` から proxy ポートを動的に解決するため、Manager 再起動時に既存セッションの API 接続が切れる問題を解消
- Ink 版ダッシュボードを廃止し Rezi 版に一本化

## [3.6.0] - 2026-03-30

### Added
- Rezi TUI ダッシュボードにカラー表示を追加。Conductor ステータス・タスク状態・ジャーナルアイコンを色分け表示（Ink 版と同等）

### Fixed
- Rezi TUI の `executionMode: "inline"` 未指定による TTY エラーを修正
- Rezi TUI Journal/Log タブのコンテンツが表示されない問題を修正

## [3.5.0] - 2026-03-30

### Added
- Rezi TUI ダッシュボード: マウス対応の新 TUI フレームワーク (Rezi) によるダッシュボードを追加。タブのクリック切替、タスク一覧・ジャーナル・ログのマウスホイールスクロールに対応
- Manager daemon 起動時にタブタイトルを自動設定

### Changed
- TUI のデフォルトレンダラーを Ink から Rezi に切り替え（既存の Ink 版はフォールバック用に保持）

## [3.4.2] - 2026-03-29

### Fixed
- TUI ダッシュボード全セクション（Tasks, Conductors, Journal, Log）の幅計算を `stringWidth` ベースに統一。日本語タイトルや ●/○ マーカーの表示幅ずれによる行折り返しを解消
- TUI 行幅ユニットテストを追加（日本語タイトル・長いタイトル・全角マーカーの幅検証）

## [3.4.1] - 2026-03-29

### Changed
- トレーサビリティ基盤（trace CLI, SQLite FTS5, メタデータ伝播）のドキュメントを SKILL.md, CLAUDE.md, README に追加

## [3.4.0] - 2026-03-29

### Added
- トレーサビリティ基盤: Proxy が API リクエスト/レスポンス本文を SQLite に記録。`cmux-team trace` CLI でセッション横断検索（FTS5 全文検索対応）
- Conductor/Master からのリクエストにメタデータ（conductor-id, task-id, role 等）を自動伝播

## [3.3.0] - 2026-03-29

### Added
- daemon の auto-restart 機能: ソースコードが更新されると Conductor を維持したまま daemon プロセスだけ自動再起動する。tick ループ内で mtime を監視し、変更検出時に exit code 42 で再起動

### Changed
- release コマンドの npm publish を別 surface で実行するよう変更（OTP ブラウザ認証対応）

## [3.2.0] - 2026-03-29

### Added
- 起動時の進捗を標準出力に表示（daemon 起動・Conductor 作成・Master spawn の各ステップ）

### Changed
- CLI 移行に伴い旧スラッシュコマンド 9 個を削除（start, team-research, team-design, team-impl, team-review, team-test, team-status, team-disband, team-sync-docs）。残存コマンドは master, team-spec, team-task, team-archive の 4 個
- README, CLAUDE.md, CONTRIBUTING.md, SKILL.md の参照を CLI ベースに統一

### Fixed
- `cmux-team status` の Tasks カウントがアーカイブ済みタスクにより負値になるバグを修正
- TUI ダッシュボードで日本語タイトルが折り返されて表示が崩れる問題を修正（string-width による表示幅ベースの切り詰めに変更）

## [3.1.0] - 2026-03-29

### Added
- Agent の状態判定を `cmux read-screen` パターンマッチから `cmux list-status` API に移行し、信頼性を大幅に向上

### Fixed
- TUI ダッシュボードで running 状態の Conductor/Task 行の●マーカー後にスペースが欠落する表示バグを修正

## [3.0.3] - 2026-03-29

### Fixed
- daemon 再起動時に Conductor スロットが作成されない問題を修正（daemon 自身の surface を生きた Conductor と誤認していた）
- 全テンプレート・コマンドの CLI パスを `cmux-team` に統一（`bun run .team/manager/main.ts` や `bun run main.ts` の残存参照を除去）
- `validate-surface.sh` 参照をインラインの `cmux tree` チェックに置換

### Changed
- 旧スクリプト `spawn-conductor.sh`, `validate-surface.sh` を削除（TypeScript daemon に移行済み）
- daemon が不要な `.team/scripts/` ディレクトリを作成しなくなった

## [3.0.2] - 2026-03-29

### Fixed
- `cmux-team` コマンド実行時に `Cannot find module './dashboard'` エラーが発生する問題を修正（`.tsx` ファイルがパッケージに含まれていなかった）

### Changed
- 不要な `spawn-team.sh` を削除（CLI に統合済み）

## [3.0.1] - 2026-03-29

### Fixed
- postinstall で Claude Code plugin を自動インストール（手動実行の案内を廃止）
- `npm pkg fix` による bin パスと repository URL の正規化

## [3.0.0] - 2026-03-29

### Added
- npm パッケージとして配布開始 — `npm install -g @hummer98/cmux-team` でインストール可能に
- `cmux-team` CLI コマンド — シェルから直接 `cmux-team start` で daemon を起動
- `spawn-agent` に `--pane` オプション追加 — Conductor が自分の pane を直接指定し、Agent をタブとして確実に起動
- TUI ダッシュボードの Agent 欄に taskTitle を表示 — role のみだった表示にタスク名を追加

### Changed
- パッケージ名を `@hummer98/cmux-team` にスコープ変更
- `install.sh` と plugin cache フォールバックを削除（npm 配布に一本化）
- `prepublishOnly` スクリプト追加（publish 前にテスト実行）
- テストファイル (`*.test.ts`) を npm パッケージから除外

### Fixed
- 仕様書（docs/seeds/ + .team/specs/）を現状の実装に同期

## [2.19.0] - 2026-03-29

### Added
- タスク定義と状態の分離 — `tasks/` をフラット構造に変更し、`task-state.json` で状態を管理

### Fixed
- TUI ダッシュボード: `Sep` を `Box` でラップし全セクションの1行目空白バグを修正
- TUI ダッシュボード: Journal/Log のスペーストリム問題を修正
- `main.ts` / `proxy.test.ts` / `proxy.ts` の TypeScript コンパイルエラー修正
- `initInfra` の `.gitignore` テンプレートに `task-state.json` を追加
- テンプレート・コマンド・スクリプト・テストの `tasks/open`, `tasks/closed` 参照をフラット構造に更新
- `.claude/worktrees/` を git 管理外に変更

## [2.18.1] - 2026-03-29

### Fixed
- spawn-agent でプロキシの生存確認を行い、プロキシが死んでいる場合は `ANTHROPIC_BASE_URL` を設定せず直接 API 接続にフォールバック
- `.team/tasks/` を git 管理外にし、worktree マージ時にタスク状態が巻き戻る問題を防止

## [2.18.0] - 2026-03-29

### Added
- Conductor 起動時に `--append-system-prompt-file` でロール定義をシステムプロンプトに永続化。`/clear` 後もロール定義が維持される

### Fixed
- Conductor スロット初期化時のプロンプトを明確化。曖昧な待機指示により Conductor が自主的にタスクを検索・実行してしまう問題を防止

## [2.17.0] - 2026-03-29

### Added
- TODO メッセージを廃止し `create-task --status ready` に一本化。軽微な作業もタスクとして追跡可能に

### Fixed
- Agent 起動時の `--bare` フラグを除去。`--bare` が OAuth 認証をスキップし Claude Max 環境で API Usage Billing にフォールバックする問題を修正
- TUI ダッシュボードの Tasks セクションで open タスクが表示されない問題を修正。open タスクを優先表示し、残り枠で直近の closed タスクを表示するよう変更
- TUI ダッシュボードで長文タイトルが改行を引き起こしレイアウトが崩れる問題を修正

## [2.16.0] - 2026-03-29

### Added
- Conductor テンプレートに TaskCreate/TaskUpdate によるサブタスク管理を追加。Agent の起動・完了をタスクとして追跡可能に
- Master 起動時に `--append-system-prompt-file` でロール定義をシステムプロンプトに永続化

### Fixed
- Conductor 完了判定を done マーカーファイルのみに変更。interrupt 後に誤って done と判定される問題を修正

## [2.15.1] - 2026-03-29

### Fixed
- SKILL.md の Agent 起動手順を spawn-agent CLI に統一。旧手順（cmux new-surface で直接起動）が残っており、Conductor がプロキシ設定なしで Agent を起動してしまう問題を修正

## [2.15.0] - 2026-03-29

### Changed
- Conductor の Map キーを固定スロット ID（conductor-slot-1/2/3）に変更。タスク割り当てごとに ID が変わり Map エントリが重複蓄積する問題を解消
- 起動時の surface 分割順序を修正。全 split で daemon surface を明示指定し、フォーカス状態に依存しないレイアウト構築に変更
- 手動コマンド（/team-impl 等）から team.json 直接操作を削除し、daemon 管理に統一
- SKILL.md を TypeScript daemon ベースのアーキテクチャに合わせて全面更新

### Fixed
- daemon リロード時にプロキシポートを再利用。既存 Conductor の ANTHROPIC_BASE_URL が旧ポートのままハングする問題を修正

## [2.14.0] - 2026-03-29

### Added
- spawn-agent に `--prompt-file` オプションと `--bare` モードを追加。Agent 起動時のコンテキスト溢れを防止

### Fixed
- Conductor/Agent 起動時の環境変数が子プロセスに継承されず、Agent が API 認証エラー（Not logged in）になる問題を修正

## [2.13.0] - 2026-03-29

### Added
- デバッグ用 HTTP API: プロキシサーバーに `/state`, `/tasks`, `/conductors` エンドポイントを追加。Manager 内部状態を外部から JSON で取得可能に
- Surface 管理を固定 2x2 レイアウト + タブベースサブエージェントに再設計

### Fixed
- spawn-agent で Agent が worktree ではなくメインリポジトリで作業してしまう問題を修正
- TUI の Conductors/Tasks セクションで1行目が表示されないバグを修正
- YAML frontmatter パースで title のダブルクォートが除去されない問題を修正
- Conductor テンプレート変更に合わせて template.ts の正規表現を更新

## [2.12.0] - 2026-03-28

### Added
- CLI `create-task` コマンド: ID 自動採番・タスクファイル生成・Manager 通知を一括実行
- 完了 Conductor を TUI に表示継続: surface 消失時に自動削除
- Conductor タブ名にタスク番号を追加

### Changed
- worktree 削除を daemon から Conductor の責務に移譲

### Fixed
- closed タスク ID のゼロパディング不一致を修正
- ジャーナルから daemon_reload イベントを除外（ログタブのみに表示）
- TUI Tasks の表示改善: ソート順、色分け、完了時刻表示、ゼロパディング統一
- Conductor 完了判定を2回連続 done で確定に変更（誤検知防止）

## [2.11.0] - 2026-03-28

### Added
- CLI ベースの Agent spawn: `main.ts spawn-agent` コマンドで Conductor からエージェントを起動。logging proxy 統合により全出力を `.team/logs/` に記録
- `--task-title` オプション: spawn-agent に記述的タブ名を指定可能に
- TUI journal タブ: Conductor 完了レポートをジャーナル形式で表示。タスク履歴の振り返りが容易に
- TUI ダッシュボードに Tasks セクション追加: タスク一覧と journal タブのレイアウトを統合

### Changed
- TUI・status のタイムスタンプをローカルタイムゾーンで表示するよう変更

## [2.10.0] - 2026-03-27

### Added
- Stop hook によるイベント通知統一: Conductor 終了時に `main.ts send CONDUCTOR_DONE` で成功/失敗を Manager に通知。`hook-agent-spawned.sh` を廃止し全イベントを CLI 経由に一本化
- `CONDUCTOR_DONE` メッセージに `success` / `reason` / `exitCode` フィールドを追加。エラー終了の検知とリカバリが可能に
- TUI フッターにバージョン番号を表示

### Changed
- Conductor 完了時のペイン自動クローズを廃止。作業履歴の確認やデバッグが容易に

### Fixed
- TUI リロード時のクラッシュを修正（ink unmount してからプロセス再起動）
- リロード時に `exec` でプロセスを置き換え、Master surface を保持するよう修正

## [2.9.0] - 2026-03-27

### Added
- Agent surface のツリー表示: Conductor が spawn した Agent を TUI・status API・team.json にツリー構造で表示
- PostToolUse hook による Agent 自動検出: Conductor の `cmux new-split` を hook で検出し daemon に通知。LLM の協力不要、完全に決定論的
- Conductor 起動時に `--settings` で hook 付きカスタム設定を注入
- daemon status API のドキュメントを共通スキル（cmux-agent-role）に追加。全ロールが `main.ts status` で daemon 状態を参照可能に

### Changed
- Master テンプレートの進捗報告を `main.ts status` に一本化（pid check + cmux read-screen の手動手順を廃止）

## [2.8.0] - 2026-03-27

### Added
- TUI キーボードショートカット: `r` でリロード、`q` で終了。htop 風のキーヒントを最下段に表示
- `r` キーで最新 plugin バージョンに自動切り替え: plugin キャッシュから最新の `main.ts` を再検索して再起動

## [2.7.0] - 2026-03-27

### Added
- `main.ts status` API: daemon に依存せずダッシュボード情報を取得可能。`--log N` でログ末尾行数を指定
- Conductor のタスクタイトル表示: TUI・status API・タブ名・team.json に反映
- フルスクリーン TUI ダッシュボード: ターミナルサイズにレスポンシブ、ログ末尾を色分け表示

### Changed
- **マージ責務を daemon から Conductor に移動**: daemon は決定論的な worktree 削除のみ。マージ/PR は Conductor が判断・実行する。コンフリクト解決も Conductor の責務に
- Conductor テンプレート: 完了時にローカルマージまたは PR 作成を選択可能に

## [2.6.0] - 2026-03-27

### Added
- TypeScript daemon による決定論的 Manager（Claude Code セッションを廃止し、bun プロセスに完全移行）
- TUI ダッシュボード（ink ベース）: タスク・Conductor 状態をリアルタイム表示
- タスク依存解決: `depends_on` フィールドで依存チェーンを宣言可能
- 優先度ソート: high > medium > low の順でタスクを実行
- CLI インターフェース: `main.ts start/send/status/stop` で daemon を操作
- ファイルキュー通信: `.team/queue/` 経由のメッセージパッシング（`cmux send-key` 不要に）
- ユニットテスト 39 件: タスクパース、依存解決、キュー送受信、ユースケースシナリオ
- E2E テストランナー: 独立 cmux workspace で実際の Claude Code を起動して検証（3 シナリオ）
- CONTRIBUTING.md: テスト方法・リポジトリ構造・コーディング規約をコントリビューター向けに分離

### Changed
- README.md / README.ja.md を daemon アーキテクチャに合わせて全面書き直し
- bun を前提条件に追加
- インストール方法: plugin 推奨、skills add をフォールバックに整理

### Fixed
- テンプレート検索: `import.meta.path` からの相対パスを最優先にし、任意のプロジェクトで確実に検出
- テンプレート未検出時: フォールバック動作を廃止し、エラー停止 + リカバリー手段を表示
- ゼロパディング ID のタスクファイルマッチング（`startsWith("1")` が `001-*.md` にマッチしない問題）
- Conductor spawn 後 30 秒のガード期間を追加（初期化中の誤完了判定を防止）

## [2.5.0] - 2026-03-25

### Added
- `/master` コマンド: `/clear` 後に Master ロールを再読み込みする

## [2.4.0] - 2026-03-25

### Added
- `/team-archive` コマンド: 完了タスクを日付ディレクトリにアーカイブ。範囲指定対応（例: `/team-archive 1-33`）

## [2.3.1] - 2026-03-25

### Changed
- Master テンプレートに TODO ワークフローと cmux#2042 バリデーションを追加（ランタイムとの乖離を解消）
- CLAUDE.md にプロンプト編集ルールを追加（テンプレートがソースオブトゥルース、ランタイム直接編集禁止）

### Fixed
- テンプレート検索で plugin キャッシュの最古バージョン (v2.0.0) が優先される問題を修正（`sort -V | tail -1` で最新を選択）
- spawn-team.sh が Master プロンプトに common-header.md を付与していた問題を修正（Master のペイン操作が抑制されていた）
- `/release` で旧バージョンの plugin キャッシュを削除するステップを追加

## [2.3.0] - 2026-03-25

### Added
- `spawn-team.sh`: `/start` の全フェーズを一括実行するスクリプト（インフラ準備・プロンプト生成・ペイン作成・Trust 承認・team.json 更新）

### Changed
- `/start` コマンドを `spawn-team.sh` の1回呼び出しに簡素化（約20回の tool call → 1回に高速化）

## [2.2.3] - 2026-03-25

### Fixed
- `/team-disband` で未マージの worktree を警告なしに強制削除していた問題を修正（未マージの変更がある場合は警告を表示し、`force` 引数がない限り削除しない）

## [2.2.2] - 2026-03-25

### Changed
- `/start` 実行時に毎回 plugin キャッシュからテンプレートを再生成するよう変更（plugin 更新後にプロンプトが古いまま残る問題を解消）
- Conductor 最大同時実行数を環境変数 `CMUX_TEAM_MAX_CONDUCTORS` で設定可能に（デフォルト: 3）
- Conductor 終了時に session_id を manager.log に記録（`claude --resume` で事後確認可能）

### Fixed
- タスク完了時に worktree のマージを検証せずクローズしていた問題を修正（コード変更の消失を防止）

## [2.2.1] - 2026-03-25

### Changed
- Conductor テンプレートを強化: 冒頭に「自分でコードを書かない」ルールを配置、`[CMUX-TEAM-AGENT]` ヘッダーを除去
- Conductor に Agent 監視ループを追加: 30秒間隔のポーリングで Agent 完了を検出（Agent spawn 後に完了を待てない問題を解消）
- `/release` コマンドをプロジェクトローカル (`.claude/commands/`) に移動（plugin 配布対象から除外）
- `/release` に marketplace キャッシュ pull + plugin reinstall ステップを追加

### Fixed
- タブタイトルに surface 番号が表示されない問題を修正（`[M]` → `[58] Master` 等）

## [2.2.0] - 2026-03-25

### Added
- `/release` コマンド: バージョン自動判定・CHANGELOG 更新・push・GitHub Release を一括実行
- Conductor にレビュー判断ステップ: コード変更を伴うタスクのみ Reviewer Agent を自動起動
- Manager に TODO ワークフロー: タスクファイル不要の軽量ジョブを `[TODO]` メッセージで即時実行
- spawn-conductor.sh がテンプレートベースのプロンプト生成に対応（レビューフロー等がConductor に渡るように）
- ランタイムスクリプト (`spawn-conductor.sh`, `validate-surface.sh`) を plugin 配布物に同梱
- `/start` の Phase 0 でスクリプトを `.team/scripts/` に自動コピー
- surface 存在検証スクリプト (`validate-surface.sh`) で cmux#2042 のフォールバック問題を回避

### Changed
- Manager テンプレートから `[CMUX-TEAM-AGENT]` ヘッダーを除去（ペイン操作が Manager の主要責務であることを明記）
- Manager テンプレートの `[PLAN_UPDATE]` 機構を廃止し、Claude Code ネイティブの TaskCreate/TaskUpdate による TODO 管理に置換
- `cmux rename-tab` を Claude Code 起動後に実行するよう変更（起動前だとタイトルが上書きされる問題を修正）
- Manager のループプロトコルを改善: 毎サイクルでタスク走査を実行（Conductor 監視中の新規タスク検出漏れを防止）

### Fixed
- Manager が Conductor を起動せずサブエージェント (Agent ツール) で作業してしまう問題を修正
- Manager モデルを Haiku から Sonnet に変更（テンプレート指示への追従性向上）

## [2.0.0] - 2026-03-23

### Added
- 4層アーキテクチャ (Master → Manager → Conductor → Agent) の初期実装
- 11 のスラッシュコマンド (`/start`, `/team-status`, `/team-impl` 等)
- 10 のエージェントテンプレート (manager, conductor, researcher, architect 等)
- git worktree による Agent の作業隔離
- Manager のイベント駆動型アイドル停止
- Claude Code Plugin としての配布対応
