# Design Review: T229 (Round 2)

## Verdict

Approved

## Previous Issues Status

### C1-C4 Critical

- **C1. `spawnMaster` のマーカー書き込み経路** — ✅ 解消。S2 (L215-218) で「成功直後に `.team/masters/<normalizeSurfaceForPath(surface)>.json` を `{surface, pid: null, status: "idle", startedAt, disconnectedAt: null}` で書き込む」「`.team/master.surface` は spawnMaster からは一切書かない」と明記。§PID 取得・watcher 起動の唯一の正式経路 (L161-196) でファイル書き込みのタイミングも確定している。
- **C2. `normalizeSurfaceForPath(surface)` の仕様未定義** — ✅ 解消。独立の「§ファイル名規則」節 (L100-128) を新設し、規則（コロンのみ `_` に置換）・配置場所・真のソース（ファイル名は一意キー、内容の surface フィールドが真）・3 ケースのテスト対象を確定。R-B の内容がそのまま反映されている。
- **C3. `main.ts:779` caffeinate 制御の変更漏れ** — ✅ 解消。S8-5 (L516-530) で L779 の置換を明示。「複数 Master のいずれかが `running` ならスリープ抑止」の意図も 1 行で補足。R-C どおり。
- **C4. `startMaster` restore の矛盾** — ✅ 解消。Q2 判断で `surface_fallback` 撤廃を確定 (L30-37)。S3-4 (L242-259) が「pid 無し／数値でない／dead → ファイルを unlink して廃棄」の単一経路に整理された。マイグレーション時のみ team.json の旧 `master.pid` を拾う救済を S4 擬似コード (L405-410) で担保しており、S3-4 と R6 の矛盾は消えた。

### M1-M4 Major

- **M1. Map 登録と PID watcher 起動タイミング未規定** — ✅ 解消。§PID 取得・watcher 起動の唯一の正式経路 (L161-196) が 6 ステップで明示:
  1. spawnMaster 戻り値は `{surface, startedAt}` のみ（pid 無し）
  2. 呼び出し側が pid undefined で Map 登録
  3. **この時点では PID watcher を起動しない**
  4. SESSION_STARTED 受信時に pid 設定 + watcher 起動 + ファイル再書き込み
  「これ以外の経路で Master を `state.masters` に入れない／watcher を起動しない」の不変条件も明記。
- **M2. `/master-state` 方針 A の T229 単独動作** — ✅ 解消。§既知の制約 (L571-590) で T229 完了時点の制約を 3 項目に分けて明示:
  - 2 Master 以上のとき surface 指定なし body は `master_state_surface_ambiguous` ログのみで何もしない
  - hook への CMUX_SURFACE 注入は T230
  - cmdStart は 1 Master spawn のまま
- **M3. artifact author 意味変更の docs 反映** — ✅ 解消。Q3 判断で T229 実施を確定 (L39-45)。§docs/spec 更新箇所 (L705-749) に CLAUDE.md §Artifacts のフォーマット節更新・YAML 例更新・`docs/spec/` 配下の rg 洗い出し指示まで含む。後方互換（既存 `author: "master"` 値は保持）も明記。
- **M4. dashboard / statusline の複数 Master 表示方針** — ✅ 解消。S5 spinner check (L463-466) で「running Master が 1 個以上あればスピナー 1 個だけ」と方針確定。S6 §Map → Array 変換の責務 (L479-481) で proxy.ts L238 周辺で `[...state.masters.values()]` を作って渡すと実装位置を指定。

### m1-m6 Minor

- **m1. マイグレーション実装位置のブレ** — ✅ 解消。S4 §呼び出し位置の不変条件 (L358-362) で「initInfra の末尾で 1 度だけ」「startMaster はマイグレーションを呼ばない」を不変条件として宣言。S3-4 step 6 (L257) でも重ねて明記。
- **m2. schema.ts の循環依存制約** — ✅ 解消。§型定義 (L69-72) と S1 (L208-209) の両方で「schema.ts は logger.ts / cmux.ts に依存しない純粋な型・zod schema のみ」を維持制約として明示。`pidWatcherInterval` は Zod schema 対象外（TypeScript intersection で後付け）と分離設計も記述。
- **m3. テスト計画のカバレッジ追加** — ✅ 解消。自動テスト 9 項目中 4 項目が追加対応:
  - test 2: migrate idempotent (`master_migration_skipped` ログ確認)
  - test 7: normalizeSurfaceForPath 3 ケース
  - test 8: removeMaster で interval 停止確認
  - test 9: cmdStatus 複数 Master 表示が壊れないこと
- **m4. stopDaemon watcher 全停止の実装位置** — ✅ 解消。S3-10 (L345-354) を新設し `for (const m of state.masters.values()) clearInterval(...)` を明記。R4 の記述とも整合。
- **m5. `.team/.gitignore` の旧エントリ削除** — ✅ 解消。S11 (L557-565) / D11 (L867-870) で「daemon 側で自動書き換え」方針確定。`migrateGitignore` ヘルパーを `migrateMasterLayout` 末尾で呼ぶ、冪等性・ログ (`gitignore_migrated`) も記述。
- **m6. ログイベント名の衝突チェック** — ✅ 解消。S4 §ログイベント名 (L447-452) で `master_migration_single_to_multi` / `master_migration_failed` / `master_migration_skipped` の 3 イベント名と、実装時の確認コマンド (`rg 'master_'`) を記載。

### Conductor 判断の反映確認

- **Q1. spawnMaster 戻り値に pid を含めない** — ✅ L21-28 / D8 / S2 / §PID 取得・watcher 起動の唯一の正式経路 で一貫して反映。
- **Q2. surface_fallback 経路を T229 で撤廃** — ✅ L30-37 / D9 / S3-4 / R6 で一貫。マイグレーション時のみ team.json の旧 `master.pid` を拾う救済経路のみ残すことも S4 擬似コードに記述。
- **Q3. artifact author 意味変更を T229 で実施** — ✅ L39-45 / D10 / S10 / §docs/spec 更新箇所 で一貫。後方互換（既存値は読み取り時に保持）も明記。

## New Concerns

### n1. Zod schema と書き込み値の `null` / `undefined` 不整合（Minor / nice to have）

`MasterStateSchema` (L55-62) は `pid: z.number().optional()` / `disconnectedAt: z.string().datetime().optional()` と定義している。一方で S2 / S4 擬似コード (L217 / L412-418) のファイル書き込みは `pid: null` / `disconnectedAt: null` を使う。

- `JSON.stringify` の出力としては問題ないが、実装者が restore 時に `MasterStateSchema.safeParse(parsed)` で検証する選択をした場合、`null` は `.optional()` に合致しない（`.nullable().optional()` か `undefined`/未定義キーにする必要がある）
- 対策案: Zod 側を `.nullable().optional()` に揃えるか、書き込み時に `undefined` を使ってキーを省略する、のどちらかを plan に明記する

実害はロード経路次第（現状の startMaster は JSON.parse + type assertion のみで Zod 検証していないため実行時には通る）。nice-to-have。

### n2. S3-4 step 4 の「removeMaster で close」が cmux surface を閉じない（Minor）

S3-4 step 4 (L255):
> `proxyPortChanged === true` の場合、restore した全 Master を `removeMaster` で close し、`state.proxyPortChanged = false` にリセットしてから step 5 へ進む

しかし S3-7 の `removeMaster` 擬似コード (L320-329) は `clearInterval` + `state.masters.delete` + `deleteMasterFile` + ログのみで、**`cmux.closeSurface(surface)` を呼ばない**。proxyPortChanged で既存 Master を捨てて新規 spawn し直すケースでは、古い cmux 側の surface（古い proxy port env を持つ Claude Code プロセス）がゾンビ pane として残る懸念がある。

- 対策案 A: `removeMaster` に `{ closeSurface?: boolean }` オプションを追加し、この経路では true を渡す
- 対策案 B: step 4 を「`for (const surface of state.masters.keys()) { await cmux.closeSurface(surface); await removeMaster(state, surface, "proxy_port_changed"); }`」と明記する

旧実装の該当経路挙動（既存の L506-585 で closeSurface をしているか）を確認の上、実装者が判断すれば良いレベル。blocking ではないが plan に追記しておくと安全。

### n3. `master_file_conflict` ログイベントが §ログイベント名 未列挙（very minor）

§ファイル名規則 (L122) で「ファイル名の衝突時は `master_file_conflict` を出す」と書かれているが、S4 §ログイベント名 (L447-452) の列挙に含まれていない。m6 の衝突チェック対象コマンド (`rg 'master_'`) には自然に掛かるが、網羅性の観点で 1 行追加しても良い。

## Verdict 理由

前回の Critical 4 件・Major 4 件・Minor 6 件すべてが明示的に plan.md に反映されている。特に:

1. C1-C4 は R-A / R-B / R-C / R-D の Recommendations をほぼそのまま取り込み、実装者が迷わないレベルの具体化ができている
2. M1 の「spawnMaster 直後の Map 登録 → SESSION_STARTED 到達まで PID watcher 未起動」という順序は §PID 取得・watcher 起動の唯一の正式経路 として独立節にまとまり、「それ以外の経路で入れない」という不変条件が宣言されている
3. Conductor 判断 (Q1/Q2/Q3) が Open Questions への方針決定 / Decision Log D8-D10 / 各サブセクションに一貫して反映されており、矛盾がない
4. テスト計画が 5 項目 → 9 項目に拡張され、normalizeSurfaceForPath・removeMaster・cmdStatus 複数 Master 表示の検証が追加された

新規 concerns (n1-n3) はいずれも nice-to-have レベルで、実装者が plan.md と既存コードを突き合わせれば解決できる範囲。Critical も Major も無いため Approved とする。

## Recommendations (任意対応)

### R-A. Zod schema と書き込み値の null/undefined を統一する（n1）

S2 / S4 のファイル書き込み箇所に以下を追記:

```
`pid` / `disconnectedAt` の未確定値は JSON.stringify で省略される前提で `undefined`
を使う（書き込み側は `JSON.stringify({ surface, pid, status, startedAt,
disconnectedAt }, null, 2)` で pid / disconnectedAt が undefined ならキー自体を
省略）。restore 時は `MasterStateSchema.safeParse` で検証しても optional 判定に
適合する。

- 現 `pid: null` / `disconnectedAt: null` という表記は疑似コード上の都合。
  実装では undefined を使うこと。
```

### R-B. S3-4 step 4 で cmux surface を明示的に close する（n2）

```
#### S3-4 step 4 (改訂):

`proxyPortChanged === true` の場合:
1. restore した全 Master について以下を順に実行:
   - `await cmux.closeSurface(surface)` — 古い proxy port 環境の Claude Code プロセスを終了
   - `await removeMaster(state, surface, "proxy_port_changed")` — state / file / watcher クリーンアップ
2. `state.proxyPortChanged = false` にリセット
3. step 5 へ進む（`spawnMaster` で 1 個新規起動）
```

（あるいは `removeMaster` 側に `closeSurface` オプションを足し、呼び出し側を簡素化しても可）

### R-C. `master_file_conflict` を §ログイベント名 に追加（n3）

```
#### ログイベント名（m6）追加:

- `master_file_conflict` — 同一 surface に対する複数ファイルを検出した異常状態（§ファイル名規則 参照）
- `master_restore_discarded` — pid 不明/dead で restore せず廃棄（S3-4）
- `master_file_corrupted` — JSON.parse 失敗で廃棄（S3-4）
```

（`master_restore_discarded` / `master_file_corrupted` も S3-4 本文で使われているが列挙されていないので同時に拾うと良い）
