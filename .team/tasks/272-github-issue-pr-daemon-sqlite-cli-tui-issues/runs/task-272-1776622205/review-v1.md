# T272 Design Review

## 判定

Changes Requested

## 総評

仕様との整合（#26 の要件網羅）、DB 分離理由、認証優先順位、ETag + `since` の組み合わせ、
外部依存（`@octokit/*`）を入れない判断など、設計の骨格は筋が通っている。特に「REST
`/issues` が PR を同時に返す」仕様を把握した上で issue/PR を同一テーブルに格納する
割り切りと、トークンローテ時の自動 purge は良い。

ただし Phase 3 の TUI 仕様が **現行 `dashboard.tsx` の実装前提と乖離**している（後述 Must-1）
のが致命的で、そのまま実装すると動かない。DB スキーマの PK 設計にも壊れやすい箇所があり、
主要なものを修正した上で再出してもらいたい。

## Recommendations

### 必須修正 (Must Fix)

1. **Phase 3 の TUI 実装前提が誤っている（§3 Phase 3 全般）**
   plan では `ink` / `useInput` / `raw mode` / `{ shift: true, return: true }` を前提に
   しているが、現行 `skills/cmux-team/manager/dashboard.tsx` は **`@rezi-ui/core` +
   `@rezi-ui/node` ベースに移行済み**（dashboard.tsx:10-11 の import、冒頭コメント
   「Ink 版を Rezi TUI フレームワークで書き直し」参照）。キーバインドは Rezi の辞書形式
   （dashboard.tsx:1382-1396 の `"1": () => switchTab(...)`, `Tab`, `Enter`, `J`, `L` など）で
   書かれている。ink API を前提にした箇所（`useInput`, `raw mode`, `shift+return` 表記）を
   Rezi の仕様に全面的に書き直すこと。特に `Shift+Enter` は Rezi のキー名仕様が不明なため、
   現行 plan の「残存リスク」ではなく **実装仕様として最初から `O` キー（open）を併用バインド
   する**と明記する。

2. **pager 起動は既存 `openArtifactInViewer` / `resolveMarkdownViewer` パターンを再利用する（§3 Phase 3 "pager 起動"）**
   plan の独自 `spawn(cmd, args, { stdio: "inherit" })` は不要。`dashboard.tsx:123
   resolveMarkdownViewer()` と `dashboard.tsx:970 openArtifactInViewer()` が既に
   「unmount → ビューア起動 → 復帰 & refresh」の定型を提供している（タスク/Artifacts/Settings
   タブの Enter が同じパスを通っている、dashboard.tsx:1405/1423/1443）。Issues タブの
   Enter も **必ずこのヘルパを再利用**し、`$PAGER` 独自解決を書き加えない。これで
   「ink の fullscreen 解除・復帰」問題（§8 既知リスク）も自動解消する。

3. **`assignees.login` を PRIMARY KEY にしない（§3 Phase 1 DB スキーマ, `CREATE TABLE assignees`）**
   GitHub の `login` は変更可能。stable key は数値 `id`。現行 plan の
   `CREATE TABLE assignees (login TEXT PRIMARY KEY, id INTEGER, ...)` を
   `id INTEGER PRIMARY KEY, login TEXT NOT NULL, UNIQUE(login)` に反転し、
   `issue_assignees` の FK / PK も `(issue_number, user_id)` に差し替える。
   login は表示用途だけに絞る。

4. **`sync_meta` のキー設計（§3 Phase 1 DB スキーマ, `CREATE TABLE sync_meta`）**
   `key='global'` シングルトンのまま `(host, owner, repo)` を値として保持する設計は、
   別 repo に cd して同じ DB パスに衝突したとき（本来ありえないが `.team/gh-cache.db`
   が誤って別プロジェクトから共有された場合など）にデータが混入する。
   - `(host, owner, repo)` 不一致時も `token_hash` 不一致と同様に `purgeAll` を走らせる
     safety を `openGhCacheDB` の初期化チェックに含める
   - ログイベント `gh_cache_purged` の reason に `repo_mismatch` を追加

5. **gh-cache.db を WAL モードで開く（§3 Phase 1 "マイグレーション方式" に追記）**
   TUI（Issues タブの読み取り）と CLI（`gh sync` の書き込み）が並行するので、
   `trace-store.ts:115` と同じく `db.exec("PRAGMA journal_mode=WAL;")` を
   `openGhCacheDB` 初期化時に実行することを plan に明記。現行 plan は WAL に
   言及がなく、デフォルトの rollback journal だと TUI 側が writer 中にブロックされる。

6. **`schema_version` テーブルの使い方が曖昧（§3 Phase 1 DB スキーマ冒頭）**
   `CREATE TABLE schema_version (version INTEGER PRIMARY KEY)` だけ用意しても、
   何をもって「バージョン N」とするか / 初回 INSERT のタイミング / 読み取り側の
   チェックロジックが書かれていない。`trace-store.ts:140 ensureTaskSessionsColumns` の
   「PRAGMA table_info で欠損列だけ ALTER」パターンのみで足りる現状なら
   `schema_version` は **一旦削除**し、実際に破壊的変更が必要になった時点で導入する
   方針に揃える（YAGNI）。

### 推奨修正 (Should Fix)

1. **削除・transfer された issue の扱いを「既知の制限」として明記する（§8 既知リスク）**
   GitHub REST `/issues` は transferred / deleted issue を返さない。`since` 基準の
   差分同期ではキャッシュから消えない。plan に「`--full` を月 1 程度で走らせる」等の
   運用上の注意を書き、`cmdGhStatus` に「前回 full sync から N 日経過」を表示する
   とよい。

2. **`raw_json` 列の肥大化リスクに GC 方針を（§3 Phase 1 各 CREATE TABLE）**
   500 issue × 数十 KB + comments / reviews / review_comments それぞれ × 数 KB で、
   半年運用で 100MB 超は現実的。plan の「将来拡張用」ではなく「N 日経過 or closed から
   M 日経過したら raw_json のみ NULL 化する GC」など、最低限の運用方針を書いておく。
   実装は後続 Phase でも良いが plan に残存リスクではなく **将来作業項目**として明示。

3. **`@me` の解決方式を決定する（§8 未解決事項 2）**
   未解決のまま Phase 2 に進むと CLI 実装が止まる。推奨: `sync_meta` に
   `viewer_login TEXT` 列を追加し、`syncFull` / `syncIncremental` 開始時に
   `GET /user` を 1 回だけ叩いて保存。`--assignee @me` は DB から取得。これなら
   都度 `GET /user` を叩かずに済む。

4. **i18n の一貫性（§8 既知リスク "rate limit 表示の I18n"）**
   `skills/cmux-team/manager/i18n.ts` は既に存在し `dashboard.tsx:22` で import
   されている。`cmdGhStatus` / `cmdGhSync` / Issues タブの表示文字列も **新規キーを
   i18n.ts に追加して `t()` 経由**で出す方針に統一すること。現行 plan は「日本語固定」
   と書いているがアドホックなハードコードに流れやすい。

5. **`rate-limit-display.ts` / `rate-limit-persistence.ts` との役割分担を触れる（§2 モジュール責務分担）**
   これらは Anthropic API rate limit 用だが、GitHub rate limit を `dashboard` に
   表示する場合 UI 表示ロジックを参考にできる。別軸の rate limit であることを
   plan に明記し、**同じ仕組みを再利用しない**（混同防止）と書く。

6. **`--help` / サブサブコマンド dispatch の既存ヘルパ確認（§3 Phase 1 `cmdGh` 骨子）**
   plan の `cmdGh` は `hasHelpFlag()` を使う前提だが、既存 main.ts に同名ヘルパは
   無いかもしれない。`cmdSend` / `cmdTraceHooks` の引数パース実装に揃える。
   命名は既存に合わせて `hasFlag("help")` で良い。

7. **`.gitignore` への追加を Phase 1 タスクに含める（§8 未解決事項 5）**
   「推奨: 追加」で止めず、Phase 1 完了条件に `.gitignore` へ `.team/gh-cache.db*`
   を追加する作業を含める。未解決のまま残さない。

8. **SQL は必ず prepared statement / `?` プレースホルダで（§3 Phase 1 全般）**
   plan 本文では CREATE TABLE しか書いていないが、`upsertIssue` 等で
   `sanitize` 不要な bun:sqlite prepared statement を必ず使う、と 1 行入れる。
   GitHub 由来の文字列を素の `${}` で挿入しないことを念押し。

### 任意改善 (Nice to Have)

1. **初回 sync の進捗表示**: §8 既知リスクで「数秒〜十数秒」と触れているが、1000 API call 想定なら
   プログレスバー / `page X/5 + 付属 N/500` の逐次表示が UX として欲しい。`cmdGhSync` の
   stdout に 1 秒ごとの進捗行を出すだけでもよい。
2. **fixture の置き場所**: §6 TDD で fetch mock を使うなら `skills/cmux-team/manager/__fixtures__/gh/`
   等の慣習を plan 段階で決めておく。
3. **PR 分割**: plan の 4 PR 案は妥当。ただし **Phase 1 だけ先行マージ**（reviewer のレビュー負荷最小化）
   のほうが実利があるので、これを第 1 推奨、Phase 1〜3 一括 + Phase 4 別 PR を第 2 推奨と
   優先順位を明記するのが親切。
4. **`token_hash` 長さ**: 16 hex でも実用十分だが、監査目的なら 32 hex（256 bit 前半）でもよい。
   コスト差はほぼ無いので 32 hex 推奨。

## 良かった点

- `.team/gh-cache.db` と `.team/traces/traces.db` を **別 DB に分離**し、rotation / GC の
  非互換性を回避する判断と理由づけが明確（§2 "DB を分離する理由"）
- REST `/repos/{o}/{r}/issues` が PR を同時に返す仕様を把握し、issue と PR を
  同一テーブル + `type` 列で扱う割り切りが合理的（§5 "初回 500 件 エンドポイント"）
- 外部依存（`@octokit/*`）を入れず素の `fetch` + `bun:sqlite` で完結させる判断（§2 "外部依存"）
- トークンローテ時に `token_hash` 不一致で自動 purge する設計（§3 "トークンローテ対応"）
- `gh issue list --json` の互換キー名（`state` を `OPEN` / `CLOSED` / `MERGED` 大文字、
  `author: { login }`, `assignees[].login`）までプロトコル互換を意識している（§3 Phase 2 "JSON 出力スキーマ"）
- 書き込み系は対象外と明記し、誘導 skill 本文でも「書き込みは `gh` を使う」と徹底している
- exit code 規約（0/1/2/3/4）が CLI 設計として明確で、TUI 側の handling にも
  流用しやすい（§3 Phase 1 "exit code 規約"）
- Phase ごとの依存関係と PR サイズ見積もりが具体的で、Conductor が判断しやすい（§9）
- 誘導 skill を既存 `cmux-team` と同居させず **独立 skill** として切り出した理由が
  明確（§3 Phase 4 "配置先"）
