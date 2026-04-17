# Design Review: T192

## 判定

**Changes Requested**

主要な blocking 指摘は **2 点**: (a) e2e.ts の `waitForLog` が `task_id=N` 形式に依存している、(b) `parseJournalEntries` が surface 以外にも `task_id=(\S+)` / `conductor_id=(\S+)` / `title=` / `journal_summary=` を抽出しており、フォーマット変更の影響範囲が plan 5.3 に書かれている「surface 抽出の併存」だけでは足りない。

## 評価

### 1. 設計の妥当性（formatSurface / formatPair / 剥がしルール）

**強み**
- ヘルパーを「トークン生成関数」として切り出し logger.ts を薄く保つ方針は妥当（2.2 の設計判断に同意）。
- `SurfaceRole` を `"C"|"A"|"M"|"U"` の union 型で持つのは grep / 型安全性の両面で良い。
- ID プレフィックス（`T`, `A`）と role プレフィックス（`C[..]` 等）を揃えて detail 冒頭に並べるという規約は、視認性 / パース容易性ともに合理的。

**懸念**
- `formatSurface("surface:665","C")` と `formatSurface("665","C")` の両方を受ける設計は良いが、**空文字 / `undefined` が渡った場合の挙動**が plan に書かれていない。`conductors_restored` の N surfaces 連結や、cmux 応答が空だった fallback 経路で `C[]` のような空トークンが出る可能性がある。`formatSurface` は入力が空なら何を返すか（空文字を返してトークンごと消す / `C[?]` にする）を仕様化すべき。
- `formatTaskId` が `string | number` を両方受ける点は plan 7.1 のテストにあるが、`"T"` を 2 重に付けないよう `"T192"` → `"T192"` の冪等性保証は必須。plan に書いてあるが実装時に忘れないよう明示しておきたい。

### 2. call-site 置換の網羅性

**強み**
- ファイル別の件数把握（daemon.ts:52, main.ts:47, conductor.ts:26 等）と surface 含有箇所 24 件の内訳が具体的で、実装順序 (master→main→conductor→daemon) も小→大で妥当。
- `agent_*` イベントで親子を `formatPair` にする方針は正しい。

**懸念（Blocking / Non-blocking 両方）**
- **Blocking**: 4.3 で daemon.ts の該当行を列挙しているが `conductor_forced_close` / `conductor_journal_written` / `agent_recovered` / `agent_spawn_failed` など、`manager.log` で頻出する他の surface 付きイベントの列挙が不完全に見える。実装時は `rg -n 'surface=\\$\\{' skills/cmux-team/manager` で網羅確認してからコミットすることをタスクに書き込むべき。
- **Blocking**: `conductors_restored` の `surfaces=s1,s2,s3` は新フォーマットで `C[665],C[719],C[800]` のようにトークン列挙に変えることになるが、この形式をパースする側（dashboard.tsx / 外部解析スクリプト）が居ないことを確認する必要がある。plan 4.3 に「surfaces= フィールドはカンマ区切りで複数化必要」とあるが、`C[..]` だけを並べるのか `surfaces=C[665],C[719]` を維持するのかが未決。推奨: **`surfaces=C[665],C[719]` のように key を残す**（単一 surface の場合との整合性のため、複数形 ID はトークン単独置換より key= 維持が読みやすい）。
- **Non-blocking**: `cmux.ts:160` の `S[..]`（role 不明フォールバック）はロール特定の作業コストと実装シンプルさのバランスで案 B（汎用 S）で良いが、**`SurfaceRole` を `"C"|"A"|"M"|"U"|"S"` に拡張**して型定義に含めること。plan 2.1 の型定義が union に "S" を入れ忘れている。

### 3. 既存テスト互換性

**強み**
- logger.test.ts（PROJECT_ROOT 遅延評価）は `log()` API を使うだけでフォーマットに依存しないので、plan 通り非破壊で通る。
- `classify-stop.test.ts` / `task.test.ts` 等の他のユニットテストも log フォーマット文字列には触れていない（grep 済）。

**懸念**
- **Blocking**: `e2e.ts` が以下のような **exact substring** を `waitForLog` に渡している:
  - `waitForLog("task_completed task_id=1", ...)`（L386, L391, L396, L479-481）
  - `waitForLog("conductor_started task_id=10", ...)`（L467-469, L484）
  - `logBefore.includes("conductor_started task_id=13")`（L476）

  新フォーマット（`conductor_started C[665] T10 ...` のように `task_id=N` が消える）に切り替えると **e2e の 11 箇所以上が一斉に失敗**する。plan 9.1 の「waitForLog は部分一致なので event 名を変えなければ問題なし」は `task_id=N` の依存を見落としている。

  対応方針（plan に明記すべき）:
  - (A) **task_id= を key=value のまま温存する**（surface のみトークン化、task_id は`T192` を併記しない）。最小侵襲。
  - (B) e2e.ts 側も新フォーマット（`task_completed T1` 等）に追随する。影響範囲が広いが一貫性が高い。
  - **推奨は (A)**: plan 2.2 の剥がしルールを「**surface / conductor_surface / agent_surface のみ** トークン化し、`task_id=`, `conductor_id=`, `artifact_id=`, `agent_id=` などは `key=value` を維持」に狭める。T192 プレフィックス表示は dashboard 側の描画で演出すれば十分（parseLogLine で `task_id=(\d+)` を拾って `T\d+` スタイルで描画）。これなら e2e / parseJournalEntries / 既存ログ全てが影響を受けない。

### 4. TUI dashboard 色付け（parseLogLine との整合）

**強み**
- `parseLogLine` の返り値に `roles` 配列を足す方針は既存構造を壊さず良い（5.1）。
- MAGENTA を新規追加する方針、および 4 色のパレット選定（C=シアン, A=黄, M=マゼンタ, U=緑）は識別性が高い。既存パレットに MAGENTA が無い（`dashboard.tsx:128-132` で GREEN/YELLOW/RED/CYAN/GRAY のみ）ことを確認済。

**懸念**
- **Blocking**: `parseJournalEntries`（dashboard.tsx:280-323）は `event=conductor_started / task_completed / task_aborted / task_deleted` の分岐で **`task_id=(\S+)` / `title=...` / `journal_summary=...` / `surface=surface:(\S+)` / `conductor_id=(\S+)`** を抽出している。plan 5.3 は「`surface=surface:` 抽出は残しつつ `[CAMU]\[(\d+)\]` も読めるよう拡張」としか言及がない。
  - 仮に task_id= を維持する方針（上記 3. 推奨 (A)）なら parseJournalEntries への影響は surface 抽出の並存のみで済むので、**3. の対応方針を決めた上でこの節を更新する**のが筋。
  - task_id= も T192 化する場合は、`detail.match(/T(\d+)/)` を追加し、`surface=surface:(\S+)` と並立させるロジックを parseJournalEntries の全分岐に入れる必要がある。plan に追記が必要。
- **Non-blocking**: `ui.text` セグメント連結の挙動が不安な場合のフォールバック（9.5 で言及済）について、plan は「ドミナントロール色を行全体に当てる簡易版」としているが、実際どの条件で判断するか（セグメント描画が動かない環境の検出方法）が不明。**初版は常にセグメント方式にし、ダメなら次 PR で簡易版** の前提で OK だが、そう明記すべき。

### 5. 後方互換

**強み**
- 既存の `manager.log` 旧行が混在しても dashboard が落ちない方針（5.3, 9.1）は正しい。
- logger.ts の `log()` API シグネチャは不変で、呼び出し側の detail を変えるだけという切り分けは最小侵襲。

**懸念**
- **Non-blocking**: 旧フォーマット行は色付けされない（`roles=[]`）ことで、過去ログを参照したときに新旧で視覚的に混在する。許容範囲だが、CLAUDE.md に「旧ログ行はフォールバックで無色表示される」ことを明記するか、parseLogLine に `surface=surface:(\S+)` → `S[...]` 相当の後方互換トークン化を入れるか、**選択**を明示すべき。

### 6. package.json version 読み取り

**強み**
- ルート `package.json` を読む方針（manager/package.json ではなく）は正しい。配布パッケージ名が `@hummer98/cmux-team` で version 3.45.0 を確認済。
- 失敗時 `v?.?.?` fallback で daemon 起動を阻害しない設計も適切。

**懸念**
- **Blocking 手前（Non-blocking 強）**: plan 3.2 は `require.resolve("../../../package.json")` と `import.meta.resolveSync` の両方に触れているが、**Bun 環境では `import.meta.dir + "/../../../package.json"` を `Bun.file().json()` で読むのが最も堅牢**。npm install 後の配置は `package.json` の `files` で `skills/cmux-team/manager/**/*.ts` が含まれるため、`__dirname` の 3 階層上に package.json が来ることは保証される。plan の書き方だとどの方式を採用するか曖昧なので **1 案に決めて書く**ことを推奨:
  ```ts
  import { readFile } from "fs/promises";
  import { join } from "path";
  export async function formatVersion(): Promise<string> {
    try {
      const pkg = await readFile(join(import.meta.dir, "../../../package.json"), "utf-8");
      return `v${JSON.parse(pkg).version}`;
    } catch { return "v?.?.?"; }
  }
  ```
- **Non-blocking**: `formatVersion()` を毎回呼ぶとファイル I/O が発生する。**main.ts で起動時に 1 回取得し、state に保持する**ほうが良い（daemon_started 以外で version を使うなら特に）。logger.ts には `formatVersion()` を置かず、main.ts で直接 package.json を読む責務分担のほうがクリーン、という選択肢もある（logger.ts を I/O ヘルパーで汚さない）。

### 7. 抜け漏れ

- **Blocking**: 3. と 4. で指摘した e2e / parseJournalEntries の `task_id=` 依存。
- **Non-blocking**: `proxy.ts` の 6 件（surface 含有なし、現状確認済）、`template.ts:3` / `task.ts:1` / `eventBus.ts:1` / `cmux.ts:2` の分類が plan に反映されていない。**surface を含まない = 変更不要** と plan 9.2 に明記するのが親切。
- **Non-blocking**: CLAUDE.md の「禁止事項」更新に加え、**「ID プレフィックス表記」セクションに S (Surface, role unknown) の行を含める**（plan 9.3 の結論を CLAUDE.md に反映）。
- **Non-blocking**: `docs/spec/06-implementation-tasks.md` に T192 を追記する話は plan 6.2 で「スコープ外」と判断されているが、T192 の実装後に `docs/spec/` のどこかにロギングフォーマット仕様を記録する PR を別出しするかは要検討（今回は合意）。
- **Non-blocking**: テスト戦略 7.2 で「`parseLogLine` を exportable にして直接呼ぶ」としているが、**dashboard.tsx の他のヘルパー関数は現在 export されていない**。export を増やす際のファイル分割（例: `dashboard-parse.ts` に切り出す）を検討するか、今回はそのまま export するだけに留めるか明記すべき。

## Recommendations

### Blocking（実装開始前に plan.md を更新する必要あり）

1. **剥がしルールのスコープを狭める**: plan 2.2 を **「surface / conductor_surface / agent_surface のみトークン化し、`task_id=` / `conductor_id=` / `artifact_id=` / `agent_id=` は `key=value` を維持する」** に修正する。これにより:
   - e2e.ts の `waitForLog("task_completed task_id=1")` が壊れない
   - parseJournalEntries の `task_id=(\S+)` / `conductor_id=(\S+)` 抽出が壊れない
   - T192 プレフィックス表示は parseLogLine 側で `task_id=(\d+)` → `T\d+` に描画変換する（ログ本文には書かない）

2. **`SurfaceRole` 型定義に "S" を追加**: `type SurfaceRole = "C" | "A" | "M" | "U" | "S"`。plan 2.1 を修正。

3. **`parseJournalEntries` の更新方針を plan 5.3 に追記**: 各イベント分岐で `surface=surface:(\S+)` と `[CAMU]\[(\d+)\]` の両方を試す正規表現を書くこと。推奨実装パターンを plan に例示しておく:
   ```ts
   const surface =
     detail.match(/surface=surface:(\S+)/)?.[1]
     ?? detail.match(/[CAMU]\[(\d+)\]/)?.[1]
     ?? "";
   ```

4. **`formatSurface` の空入力仕様を明記**: 空文字 / `undefined` 入力時の返り値（`""` で塗り潰しゼロ幅か `C[?]` か）を決める。plan 2.1 に追記。

5. **`conductors_restored` の `surfaces=` の扱いを決定**: 推奨は `surfaces=C[665],C[719],C[800]` の形式（key= を維持し token をカンマ区切り）。plan 4.3 に書き加える。

6. **call-site 置換の完全性を担保する grep コマンドを plan 9.2 に必須化**:
   ```sh
   ! rg -n 'surface=\$\{' skills/cmux-team/manager --type ts --type tsx
   ! rg -n 'surface=surface:' skills/cmux-team/manager/{daemon,conductor,master,main,cmux}.ts
   ```
   これを実装者がコミット前に必ず実行する手順にする（plan 9.2 の「任意」ではなく「必須」）。

### Non-blocking（あると良い）

7. **`formatVersion()` の実装方針を 1 案に絞る**（上記 6. の例を plan 3.2 に記載）。加えて **main.ts 起動時に 1 度だけ呼び state.version に保持**する旨を 3.2 末尾に追記。

8. **parseLogLine の export 方針を plan 7.2 に明記**: 今回は `export function parseLogLine(...)` を追加するのみで、ファイル分割は行わない（将来必要になったら別 PR）、と範囲確定する。

9. **CLAUDE.md 6.1 に旧ログ互換を明記**: 「旧フォーマット行（`surface=surface:NNN`）は新規コードでは使わないが、dashboard は互換パースを残す。旧行は色付けされず普通の白テキストで表示される」。

10. **`cmux.ts:160` の "S" 汎用プレフィックスを CLAUDE.md の表に追加**: `S = Surface (role unknown — cmux低レベル箇所のみ)`。

11. **proxy.ts / template.ts / task.ts / eventBus.ts は変更なし** の旨を plan 1.2 末尾に明記（surface を含まないため影響なし）。

## Blocking vs Non-blocking

- **Blocking**（Recommendation 1〜6）: これらが解決されないと実装を始めると e2e と TUI dashboard 両方が壊れる。特に Recommendation 1（剥がしルールの狭め）は plan 全体の設計を小さく変える判断なので、Planner が合意の上で plan.md を更新してから実装者に渡すべき。
- **Non-blocking**（Recommendation 7〜11）: 実装品質・保守性の向上提案。plan に反映できれば望ましいが、なくても実装は進められる。
