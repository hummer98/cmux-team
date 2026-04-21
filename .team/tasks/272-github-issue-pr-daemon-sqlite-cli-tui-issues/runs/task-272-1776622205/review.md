# T272 Design Review v2

## 判定

Approved

## 総評

必須修正 6 件すべてが plan v2 に明示的に反映されており、各箇所に Must Fix 番号の
コメント（例: `Must Fix 3 反映`, `Must Fix 5 反映`）が添えられているため差分の
追跡も容易。特に Phase 3 の Rezi 移行は単なる記述置換ではなく、既存
`dashboard.tsx` の辞書形式キーバインド（`"5"` / `I` / `R` / `Enter` / `O` / `B`）と
`openArtifactInViewer` / `resolveMarkdownViewer` の再利用まで一貫して書かれて
おり、実装で破綻する箇所が見当たらない。Should Fix も全 8 件が反映されていて、
本プランで Implementer に渡せる状態。

## 必須修正 (Must Fix) の反映状況

1. Must-1 (Rezi への書き直し): 反映済
   - §3 Phase 3 冒頭で「@rezi-ui/core + @rezi-ui/node ベースで実装する / ink API
     （useInput、raw mode、useApp、Box/Text）は使わない」と明示（plan.md:552-558）
   - キーバインド追加は既存 `dashboard.tsx:1382-1396` の辞書形式（`"5"` / `I` /
     `R` / `Enter` / `O` / `B` / `ArrowUp` / `ArrowDown`）で記述（plan.md:614-649）
   - `Shift+Enter` を「Rezi 仕様不明」として採用見送り、最初から `O` キーで代替
     する方針を **実装仕様** として明記（plan.md:634-636, 1187-1188）
2. Must-2 (pager 再利用): 反映済
   - `openInViewer` 内で `openArtifactInViewer(app, tmp, onResume)` を呼ぶ形に
     揃えた（plan.md:674-695）
   - 独自 `spawn(cmd, args, { stdio: "inherit" })` は plan から除去。ブラウザ
     起動のみ `Bun.spawn(["open", html_url])` で分離しており pager パスとは衝突
     しない
3. Must-3 (assignees PK): 反映済
   - `assignees` テーブル: `id INTEGER PRIMARY KEY`, `login TEXT NOT NULL`,
     `UNIQUE(login)`（plan.md:221-227）
   - `issue_assignees` テーブル: PK `(issue_number, user_id)`, FK
     `user_id → assignees(id)`（plan.md:229-236）
4. Must-4 (repo_mismatch purge): 反映済
   - `openGhCacheDB` 初期化フローで `tokenMismatch || repoMismatch` を判定
     （plan.md:302-319）
   - `gh_cache_purged reason=repo_mismatch` のログイベント追加（plan.md:408）
5. Must-5 (WAL): 反映済
   - `openGhCacheDB` 内で `db.exec("PRAGMA journal_mode=WAL;")` を明記
     （plan.md:293-294）。trace-store.ts:115 と同一形式
   - Phase 1 完了条件にも「WAL モードで DB が開く（`PRAGMA journal_mode` が
     `wal` を返す — Must Fix 5）」を追加（plan.md:437）
6. Must-6 (schema_version 削除): 反映済
   - DB スキーマから `CREATE TABLE schema_version` を除去
   - 「`schema_version` テーブルは **削除**（Must Fix 6 反映 — YAGNI）。
     マイグレーションは `trace-store.ts:140 ensureTaskSessionsColumns` と同じ
     `PRAGMA table_info` ベースで行う」と明示（plan.md:128-130, 276-278）

## 良かった点

- Must Fix の反映箇所がすべて `Must Fix N 反映` のインラインコメント付きで
  示され、reviewer と implementer の相互参照が容易
- `Shift+Enter` を「Rezi 仕様不明」として残存リスクに残さず、plan 段階で
  `O`（open）キーに置き換える決断をした（実装段階の不確実性を排除）
- `viewer_login` を `sync_meta` に格納する設計で、`@me` 解決が 1 sync あたり
  `/user` 1 コールに収束。rate 予算見積（500→1001）も整合
- `openGhCacheDB` 初期化時の mismatch 判定を `tokenMismatch || repoMismatch`
  として統一し、`purgeAll(db, reason)` の reason 列挙型として `token_rotated` /
  `repo_mismatch` を明示。ログの追跡性が高い
- Should Fix も全 8 件反映済み（`.gitignore` 追記が Phase 1 完了条件入り、
  i18n 経由が各 Phase 完了条件入り、prepared statement 原則が Phase 1 実装原則
  入りなど）

## 残存リスク（Approved 時 — Implementer への申し送り）

- **`openArtifactInViewer` の実シグネチャ確認**: plan では
  `openArtifactInViewer(app, tmp, onResume)` の 3 引数形式で呼んでいるが、
  実装時に現行 `dashboard.tsx:970` の引数・戻り値を読み直し、`app.stop()` /
  `app.start()` / `refresh()` / `spinnerInterval` 復元のタイミングが既存
  Artifacts タブと完全一致しているか確認のこと。ブラウザ surface で `mo` を
  起動するパスと `cat` フォールバックで挙動が分岐する点に注意
- **Rezi の `KeyContext<AppState>` / `focusedArea` 型仕様**: plan のキーバインド
  例（`ctx.state.focusedArea === "issues"`）は既存コードからの類推で記述。
  既存の `focusedArea` 型 union に `"issues"` を追加する必要があるかどうか
  実装時に確認し、無ければ代替（`activeTab === "issues"` ベースの判定）に
  切り替える
- **`i18n.ts` の placeholder 展開 API**: plan は `t("gh_auth_missing", { host })`
  形式を前提にしているが、既存 `i18n.ts` が placeholder をサポートしているか
  実装前に確認。未サポートなら文字列結合側で展開する方針に倒す
- **`ensureAssigneesColumns` / `ensureSyncMetaColumns` の新設**: plan は
  `trace-store.ts:140 ensureTaskSessionsColumns` パターンを踏襲とあるが、
  実装時に列追加ごとに同形のヘルパを書く必要がある。`viewer_login` のような
  将来追加列も同じ形式で増やせるように、汎用 `ensureColumns(db, table, columns)`
  を切り出すのが望ましい（plan 段階での指示はない）
- **進捗表示（Nice to Have 1）**: plan では Conductor 判断に委ねる扱い。初回
  `--full` が 1001 コール × 十数秒かかる想定なので、stderr への 1 秒ごとの
  `page X/5, issue N/500` 出力は UX 上欲しい。Implementer が余裕があれば実装
  することを推奨
