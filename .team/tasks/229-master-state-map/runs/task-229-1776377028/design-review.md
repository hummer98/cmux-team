# Design Review: T229

## Verdict
Changes Requested

## Strengths
- **データモデルの方向性が明確**: singleton フラット field 6 個 → `Map<surface, MasterState>` への整理は Conductor と対称で読みやすい。「`state.masters.has(surface)` を Master 判定の唯一のソースとする」の不変条件宣言（データフロー §1）は実装者が迷わない。
- **`removeMaster` ヘルパー新設**（R4 / D5）によって `clearInterval` + `Map.delete` + ファイル削除をセットで行う単一経路に集約する設計は、PID watcher interval リーク対策として筋が良い。
- **非スコープの線引きが明快**（D7）: cmdStart 挙動不変・self-register は T230 というスコープ分離が計画全体を通して徹底されている。
- **hook handler 5 箇所の置換パターン化**（S3-5）でコードレビュー負荷が低く、網羅チェックコマンドまで添えている（R3）。
- **マイグレーションの冪等性と failure fallback**（S4 / マイグレーション実装詳細 §冪等性）が明示されており、失敗しても daemon 起動が止まらない設計になっている。
- **Decision Log が「なぜ方針 A か」「なぜ T229 で hook を触らないか」を残している**（D2, D3）ため、T230 着手時に混乱しない。

## Concerns

### Critical (blocking)

#### C1. `spawnMaster` のマーカー書き込み経路が新形式に対応していない
現状 `master.ts:32` は `writeFile(".team/master.surface", surface)` を実行する。plan は「マイグレーション後は `.team/masters/<surface>.json` を真のソースにする」(D4) と宣言しているが、**S2（master.ts セクション）に「spawnMaster の中で新形式ファイル `.team/masters/<surface>.json` を書く」ロジックの記述がない**。このままでは:
- マイグレーション済み環境で新規 Master を spawn した直後、新形式ファイルが作られない
- 次回起動時に `.team/masters/` が空のため復元できず、毎回新規 spawn になる（= restart が壊れる）
- もしくは旧マーカーが再生成されると「マイグレーション後に旧マーカーが復活」する一貫性破壊

→ spawnMaster 側で新形式ファイル書き込みを担うか、もしくは呼び出し側 `startMaster` の責務にするかを **明示的に決めて plan に書くこと**。

#### C2. `normalizeSurfaceForPath(surface)` の仕様が未定義
マイグレーション擬似コード（S4）および `.team/masters/<surface>.json` 全般で `normalizeSurfaceForPath(surface)` が使われているが、**この関数の挙動が計画書に書かれていない**。
- `surface:100` → `surface_100.json` か `100.json` か
- コロン以外の記号（UUID 経路や `-` を含む ref）をどう扱うか
- 逆変換（ファイル名 → surface）は必要か（restore 時に surface 文字列を ファイル中身の `surface` フィールドから読むなら逆変換不要）

→ 仕様を確定させないと実装が分岐する。推奨: **ファイル名は任意の一意キー（UUIDv4 等）にし、内容側の `surface` フィールドを常に真とする**。これなら正規化が不要。もしくは `surface:100` → `surface_100` の 1 段階置換で十分と明記し、テスト計画の検証ファイル名を揃える。

#### C3. `main.ts:779` caffeinate 制御の `state.masterStatus === "running"` が変更範囲から漏れている
grep 結果:
```
main.ts:779 state.masterStatus === "running" ||
```
これは `updateCaffeinate` の判定で、Master が running 中はスリープ抑止する制御。S8（main.ts）セクションでは full-quit (L592) と cmdStatus (L1055) しか列挙されていない。

→ **S8 に追加で以下を明記**:
```
S8-5. caffeinate 判定 (L779)
- `state.masterStatus === "running"` → `[...state.masters.values()].some(m => m.status === "running")`
```
見落とすと「Master が busy でもスリープに入る」退行が発生する。

#### C4. `startMaster` の restore で PID 不明な Master の扱いが二重にブレている
現状 (L530-543) は pid 欠落時に `surface_fallback` 経路で surface 生存だけを確認して restore する。plan は以下で矛盾している:
- S3-4: 「各ファイルから `{surface, pid}` を読み、PID 生存確認 (`process.kill(pid, 0)`) → 生存していれば `state.masters.set`」 ← pid 必須
- R6: 「PID 不明の Master は廃棄 (過去の surface_fallback 経路は維持するが、1 つに限定する条件を付ける)」 ← 条件付き maintained

「1 つに限定する条件」の具体が計画書に**存在しない**。複数 Master 時代に surface_fallback を残すなら、どういう条件下で発動するのかを plan に書く必要がある。

→ 推奨の整理: **「T229 は PID 不明 Master を廃棄 (= restore しない)。surface_fallback 経路は削除。v3.46.0 → v3.47.0 マイグレーション互換はマイグレーション時に team.json の `master.pid` があれば拾う (S4 擬似コードと同じ) で担保」**。そうすれば S3-4 と R6 の矛盾が解消し、「PID watcher が必ず起動する」という不変条件が得られる。

### Major (strong recommendation)

#### M1. `spawnMaster` が pid を返さないとき、Map 登録と PID watcher 起動のタイミングが未規定
spawnMaster は現状 `{ surface: string }` しか返さない（master.ts:36）。plan S2 は戻り値を `{ surface, pid?, startedAt }` に拡張するとしているが、**cmux 経由で起動した直後は pid は取れない** (pid は SESSION_STARTED hook 経由で後追いで届く)。つまり:
- spawnMaster 後に `state.masters.set(surface, { surface, status: "idle", pid: undefined, startedAt: now })` を入れる
- PID watcher は **起動しない** (pid 無し)
- SESSION_STARTED 受信時に初めて pid を設定し PID watcher を起動

この順序が plan S3-4 と S3-5 の両方に散っているため、実装者が取りこぼすリスクがある。

→ **「spawnMaster 成功直後の Map 登録フォーマット」** と **「SESSION_STARTED hook で初回 pid が届いた時の PID watcher 起動」** を S3-4 か新セクションでまとめて書くこと。

#### M2. `/master-state` エンドポイント (方針 A) は T229 単独では壊れる
plan S7 / D2 で「body に optional `surface` を受け付け、未指定時は Master が 1 個の場合のみ自動解決」と宣言しているが、T229 では **hook スクリプト側に `CMUX_SURFACE` を body に乗せる改修は T230 で行う** (D3)。つまり T229 完了時点でも hook は surface 無しで POST する。Master が **1 個** (cmdStart 直後) であれば自動解決できるが、テスト M5（擬似的に 2 Master 登録）の直後に実際の Master が UserPromptSubmit を発火させると **どちらの Master の busy か不明** で警告ログのみ＝ dashboard の spinner が更新されない。

→ **plan に「T229 完了時の既知の制約」として明記する**:
- hook からの POST が surface 無しの場合、Master が 2 個以上なら状態更新スキップ（`master_state_surface_ambiguous` ログ）
- このギャップは T230 で hook に `CMUX_SURFACE` を追加して解消
- 本タスクのテスト M5（擬似 2 Master）では UX 確認対象外

「完全な複数 Master サポート」を T229 で名乗らず、「基盤整備のみ」を明示する。

#### M3. artifact の `author` 意味変更に伴う docs/spec 更新が列挙されていない
S10 で `author: "master"` ハードコード → `process.env.CMUX_SURFACE ?? "unknown"` に変更するが、CMUX_SURFACE は **Conductor / Agent でも設定されている**（conductor.ts:112, main.ts:1651）。つまり今後は:
- Master が artifact 作成 → `author: surface:<master>`
- Conductor が artifact 作成 → `author: surface:<conductor>`
- Agent が artifact 作成 → `author: surface:<agent>`

となり、artifact フォーマット定義の **「author の意味」が「master 固定文字列」から「作成者 surface」に変わる**。これは破壊的仕様変更。CLAUDE.md §Artifacts（本ドキュメント L691）の `author: master | conductor-N | agent-xxx` 表記もアップデートが必要。

→ plan の「docs/spec 更新箇所」に以下を追加:
- `CLAUDE.md` の Artifacts セクション §フォーマットで author の意味を再定義
- 既存 artifact (`author: master` 文字列) との読み取り互換性を明記（既存値は保持）

#### M4. dashboard / statusline の複数 Master 時の表示方針が曖昧
- S5 `buildMasterSection`: 「2 個以上なら複数行」は書かれているが spinner の扱いが未定。複数 Master が同時に running のときスピナーは 1 個か N 個か
- S6 `renderMaster`: statusline は **1 surface 分だけレンダリングする**（resolveRole で自分の surface を判定）ため、複数 Master 表示ではなくロール判定の問題。`state.masters.some(...)` で master 判定する方針は妥当だが、**StatuslineState の型を `masters: Array<...>` と宣言している**（S6）のに daemon.ts 側は `Map<...>` なので、**どこで Array 変換するか**が未定。`formatStatusline` 呼び出し側（proxy.ts L238）に `[...state.masters.values()]` の変換を足す必要がある。

→ S6 に変換ポイント（proxy.ts のどこで Map→Array 化するか）を明記。spinner については「running Master が 1 個以上あればスピナーを 1 個表示する」等の 1 行を入れる。

### Minor (nice to have)

#### m1. マイグレーション実装位置の記述ブレ
「実装位置と順序」節は `initInfra` の末尾と書いてあり、後段「マイグレーションの実装詳細 §実行タイミング」も同様。一方 S3-4 冒頭の「`.team/master.surface` 旧マーカーがある場合はマイグレーションを呼ぶ (S4)」は **startMaster からもマイグレーションを呼ぶ** ように読める。二重呼び出しの可能性を排除するため、**「呼び出しは initInfra 1 箇所のみ」「startMaster はマイグレーション済み前提で新形式ディレクトリだけを読む」** と明記すること。

#### m2. 型定義の循環依存チェック未記載
D1 で「MasterState を schema.ts に置く」を採用するが、schema.ts が master.ts を import するか逆か、循環依存リスクの検証が plan に無い。既存 `ConductorStateSchema` / `AgentStateSchema` が schema.ts 側にあり master.ts からの import で問題無さそうだが、**schema.ts は logger.ts / cmux.ts に依存しない純粋な型・zod schema のみ** という現状制約を明記しておくと安全。

#### m3. テスト計画のカバレッジ追加
plan §自動テスト の 5 項目は妥当だが以下が欲しい:
- **removeMaster 経由で interval が clearInterval されること**（spawnMasterPidWatcherTick の結果が "dead" → `state.masters.has(surface) === false` を確認）
- **migrateMasterLayout 冪等性**: 同じ状態で 2 回呼んでも `master_migration_skipped` が 2 回目に出ること（実装上 `!existsSync(newDir)` で skip するので skipped ログが欠落しないか確認）
- **cmdStatus の複数 Master 表示**: `teamJson.masters` が 2 要素のとき CLI 出力が壊れないこと（最低限スモークテスト）

#### m4. `stopDaemon` の watcher 全停止が R4 で言及されるが実装位置が未指定
「`stopDaemon` (graceful shutdown) でも全 master の interval を stop するロジックを追加」と書かれているが、plan S3 のセクションに `stopDaemon` の改修が明示されていない。S3 のサブ項目に「S3-10. stopDaemon: `for (const m of state.masters.values()) clearInterval(m.pidWatcherInterval)` を追加」を足すこと。

#### m5. `.team/.gitignore` の旧エントリ削除タイミング
S11 で `master.surface` を `masters/` に置き換えるが、既存ユーザー環境の `.team/.gitignore` は daemon 起動時に自動更新されない（現状 `initInfra` の `!existsSync(gitignore)` ガード）。**旧環境では手動で .gitignore を書き換える必要がある**ことを M4 手動検証手順に追加するか、daemon 側で既存の `.gitignore` に「`master.surface` 行を `masters/` に書き換える」マイグレーションを 1 度だけ行うか、方針を決めること。

#### m6. ログイベント名の衝突チェック
新設イベント `master_migration_single_to_multi` / `master_migration_failed` / `master_migration_skipped` は既存イベント (`master_started` / `master_spawning` / `master_restored` / `master_check_failed` 等) と衝突しない。OK。念のため plan に「`rg 'master_' skills/cmux-team/manager/*.ts` で既存イベントと重複しないことを確認した」の 1 行を入れておくと安心。

## Recommendations

実装者が plan.md を修正する際の具体的指示:

### R-A. S2 master.ts セクションに以下を追記
```
- spawnMaster 成功時のマーカー書き込み先を以下に変更:
  - 旧: `writeFile(".team/master.surface", surface)`
  - 新: `.team/masters/<normalized>.json` に `{ surface, pid: undefined, status: "idle", startedAt: now }` を書く
  - pid は SESSION_STARTED hook で後追い更新する (ファイル再書き込みは不要、Map 内のみ更新)
- `.team/master.surface` は spawnMaster からは一切書かない (旧マーカーはマイグレーションで読み取り専用)
```

### R-B. 「§ファイル名規則」節を新設
```
### ファイル名規則

`.team/masters/<surface-safe>.json` の <surface-safe> は以下の正規化を適用する:
- `surface:100` → `surface_100`
- コロン `:` を `_` にのみ置換（それ以外の記号は想定外なのでエラー）
- ファイル内容の `surface` フィールドが真のソース。ファイル名は単なる一意キー。
- restore 時はファイル名から surface を逆算せず、内容の `surface` フィールドを使う

`normalizeSurfaceForPath(surface: string): string` を `master.ts` に新設し、daemon.ts
/ master.ts 共通で使う。テストは surface 文字列「surface:100」「surface:abc-def」「空文字」の 3 ケース。
```

### R-C. S8 に S8-5 を追加
```
#### S8-5. caffeinate 判定 (main.ts L779)

- `state.masterStatus === "running"` → `[...state.masters.values()].some(m => m.status === "running")`
- 複数 Master のいずれかが running ならスリープ抑止
```

### R-D. S3-4 の restore 方針を簡明化
```
#### S3-4. startMaster (daemon.ts L506-585) — 新形式のみを読む

1. `.team/masters/*.json` を readdir。ファイルがあれば JSON.parse し
   `{ surface, pid?, status, startedAt }` を取得
2. pid が数値 → `process.kill(pid, 0)` で生存確認。生存なら
   `state.masters.set(surface, {...})` + `spawnMasterPidWatcher(state, surface, pid)`
3. pid 無し、または dead → そのファイルを unlink して廃棄 (surface_fallback は撤廃)
4. 1 個も restore できなければ `spawnMaster` で 1 個新規起動
5. マイグレーションは呼ばない (initInfra で 1 回だけ実行済み)
```
R6 との矛盾を解消し、surface_fallback 廃止を明言する。

### R-E. M2 を「既知の制約」として plan に追記
```
## 既知の制約 (T229 完了時点)

- `/master-state` POST は body に `surface` 指定が無い場合、Master が 1 個のときのみ
  状態を更新する。2 個以上のときは `master_state_surface_ambiguous` ログを出して
  何もしない。hook スクリプトへの CMUX_SURFACE 注入は T230 で対応。
- 複数 Master 登録状態で dashboard の Master セクションは正しく一覧表示されるが、
  statusline のロール判定は surface 単位で行われるため問題なし。
```

### R-F. docs/spec 更新箇所に追加
```
### CLAUDE.md — Artifacts セクション
- §フォーマットの `author` の値ドメインを「`surface:<id>` 文字列 or 既存値 (master/conductor-N 等) との互換」に更新
- 新規 artifact は作成者 surface を記録。既存 artifact は値を保持
```

### R-G. S3-10 を新設 (stopDaemon 改修)
```
#### S3-10. stopDaemon (graceful shutdown)

- state.masters 全エントリの `pidWatcherInterval` を clearInterval
- state.masters.clear() は不要 (プロセス終了で自然に破棄)
```

### R-H. マイグレーション呼び出しを 1 箇所に固定
```
### 呼び出し位置の不変条件

- `migrateMasterLayout` は `initInfra` の末尾で 1 度だけ呼ばれる
- `startMaster` はマイグレーションを呼ばない。`.team/masters/` ディレクトリのみを
  真のソースとして読む
- マイグレーション失敗時は旧マーカーが残り、次回 daemon 起動の `initInfra` で再試行
```

## Open Questions

1. **`spawnMaster` が現状 pid を返さないが、plan S2 は戻り値に `pid?` を含めている。** cmux の API が Master 起動直後に pid を返す経路はあるか？ 無ければ M1 の通り「spawnMaster 戻り値に pid を含めない」が素直。確認してどちらで行くか決めたい。
2. **surface_fallback 経路 (daemon.ts L533-543) を T229 で撤廃することに合意できるか？** R6 と S3-4 の矛盾を解消するには撤廃推奨だが、Conductor が先に M1 ユーザーから spawnMaster pid 不明ケースで動いていた実績があれば残す必要あり。Conductor 判断を仰ぎたい。
3. **artifact の `author` 意味変更 (M3) は破壊的変更になり得るが、T229 範囲で実施して良いか？** T231 等に切り出す選択肢もある。スコープ明確化のため Conductor 判断を仰ぎたい。
