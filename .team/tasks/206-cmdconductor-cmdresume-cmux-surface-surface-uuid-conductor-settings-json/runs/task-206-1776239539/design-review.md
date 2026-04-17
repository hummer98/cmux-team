# Design Review: T206

## Verdict
**Changes Requested**

主要な設計方針（境界正規化・state key 不変・hook 内容無変更で `conductor-settings.json` 共通化・`cmdConductor`/`cmdResume` から `CMUX_SURFACE` 必須撤廃）はすべて妥当。ただし **§3.1 / §3.2 の cmux invocation が事実誤認に基づいており、このまま実装すると normalizeSurfaceArg の UUID 経路が動かない**。そのため Critical 1 件、Major 数件を修正してから着手してほしい。修正自体は軽量で、骨子・スコープ・out-of-scope・テスト戦略は維持できる。

## Findings

### Critical（実装ブロッカー）

#### C1. `cmux --json tree` だけでは UUID が出力されない（§3.1 / §3.2）

plan §3.1 は次の主張をしている:

> `cmux tree --help` の出力上 `--id-format` フラグは存在しない（タスク本文の記述は誤り）。代わりに `cmux --json tree` を用いる。

これは事実誤認。実機で `cmux --help` を確認すると以下が明記されている:

```
Handle Inputs:
  Use UUIDs, short refs (window:1/workspace:2/pane:3/surface:4), or indexes ...
  Output defaults to refs; pass --id-format uuids or --id-format both to include UUIDs.
```

つまり `--id-format` は **`tree` サブコマンドのフラグではなく cmux グローバルフラグ**であり、`cmux --id-format both <command>` で全コマンドの出力に UUID を含められる。タスク本文 §3 が `cmux.tree({ idFormat: "both" })` と書いているのは正しく、plan の側が誤り。

実出力で確認した:

- `cmux --json tree`: surface オブジェクトに `id` フィールド **なし**（`ref` / `tty` / `title` などのみ）。
- `cmux --id-format both --json tree`: surface オブジェクトに `id`（UUID 大文字）と `ref`（`surface:NNN`）の **両方**が含まれる。pane / workspace / window も同様。

```json
{
  "surfaces" : [
    {
      "ref" : "surface:44",
      "id" : "A5AC4F23-70D9-4B81-8958-168CD68CF8DF",
      "pane_id" : "F381CC4E-...",
      "pane_ref" : "pane:42",
      ...
    }
  ]
}
```

このため plan §3.1 / §3.2 の実装をそのままコピーすると `cmux --json tree` が UUID なしの JSON を返し、`s?.id === input` が常に false となり normalizeSurfaceArg は **入力 UUID を全て reject** する。リスク §5.1 の懸念は実は不要で、`--id-format both` を渡すだけで解決する。

**修正案:**

1. `cmux.ts` の `tree()` シグネチャを以下に変更する:

   ```ts
   type TreeOpts = { json?: boolean; idFormat?: "refs" | "uuids" | "both" };

   export async function tree(workspace?: string, opts?: TreeOpts): Promise<string> {
     if (treeImpl) return treeImpl(workspace, opts);
     const args: string[] = [];
     if (opts?.idFormat) args.push("--id-format", opts.idFormat);
     if (opts?.json) args.push("--json");
     args.push("tree");
     if (workspace) args.push("--workspace", workspace);
     const { stdout } = await runCmux(args, { timeout: TREE_TIMEOUT_MS });
     return stdout;
   }
   ```

   - `--json` と `--id-format` は **どちらもグローバルフラグなのでサブコマンド `tree` より前に置く**（plan の「`["--json", "tree", ...]` の順で組み立てる」という注意は正しい方向だが `--id-format` も同じ位置に必要）。
   - `idFormat: "ref" | "json"` という命名は出力フォーマットと id フォーマットを混同しているので避ける。`json` フラグと `idFormat` を独立した opts キーにする。

2. `normalizeSurfaceArg` 側は `cmux.tree(undefined, { json: true, idFormat: "both" })` を呼ぶ。

3. UUID 比較は **大文字小文字を無視**する（cmux は uppercase で出力するが、ユーザー入力は lowercase で来る可能性がある）。`s.id?.toLowerCase() === input.toLowerCase()` または正規化後比較にする。`UUID_RE` の `i` flag は入力検証側のみ吸収しているため、比較側で失敗する。

4. **リスク §5.1 は完全に削除可能**。`cmux --id-format both` で UUID は確実に取れるので、「UUID 経路を未サポートとして reject する」フォールバックも plan から消してよい。

### Major（修正推奨）

#### M1. `tree()` のテスト差し替えフック型と既存テストへの影響（§4.2）

`cmux.ts:133` の `treeImpl` の型は現状:

```ts
let treeImpl: ((workspace?: string) => Promise<string>) | null = null;
```

§3.1 の変更で `(workspace?, opts?) => Promise<string>` に拡張する必要がある。plan §4.2 は「mock 関数は引数を無視しているため変更不要のはず（型互換性のみ確認）」と書いているが、**`__setTreeImpl` の引数型シグネチャ自体を変える**必要があり、`__setTreeImpl(impl: ...)` の `impl` 型注釈は呼び出し元（テスト）からも見えるため、テストの mock 定義の型がエラーになる場合がある。具体的に `cmux.test.ts` / `daemon.test.ts` を `Read` で確認し、差し替え mock の型注釈を更新するか、`__setTreeImpl` の入力を `(...args: any[]) => Promise<string>` に緩めるかを決めること。

#### M2. `main.test.ts` の既存呼び出しは「修正可能性あり」ではなく「必修正」（§3.5 / §4.2）

`main.test.ts:30, 43, 55, 91` の 4 箇所が `generateConductorSettings(testDir, "surface:100")` を呼んでいる（実機 grep で確認済）。plan §3.5 は「main.test.ts がインポートしている可能性があるので、シグネチャ変更時に併せて修正する」と書いているが、**確実に存在するので「修正必須」と断言してよい**。引数 1 個に変更するだけ。

#### M3. `cmdSpawnConductor` の caller surface 解決パターンも統一対象に含めるか明示する（§3.4）

`cmdSpawnConductor`（main.ts:1410-1416）に既に同じパターンがある:

```ts
const surface = process.env.CMUX_SURFACE ?? await cmux.getCallerSurface();
```

§3.4 で導入する `resolveCallerSurfaceOrExit()` を `cmdConductor` / `cmdResume` のみに適用する設計だが、`cmdSpawnConductor` も類似なので、**「本タスクでは触らない」と明示的に out-of-scope に追記**してほしい（これも触ると差分が膨らみすぎる）。`cmdSendAgent` については §5.5 で除外を明記しているが、`cmdSpawnConductor` についても同じ判断を成文化する。

#### M4. UUID の大文字小文字（§3.2）

cmux 出力の UUID は大文字（例: `A5AC4F23-70D9-4B81-8958-168CD68CF8DF`）。ユーザーが手で打つ場合は小文字になりがち。`SURFACE_REF_RE` / `UUID_RE` は `i` フラグで入力検証を吸収できるが、JSON walk での比較 `s?.id === input` は **完全一致**なので fail する。比較箇所で `toLowerCase()` 同士 / `toUpperCase()` 同士に揃えること。これは Critical C1 の修正ついでに直す。

#### M5. CHANGELOG の version label（§3.7）

`CHANGELOG.md` 最新は `[3.47.1] - 2026-04-15` で `[Unreleased]` セクションは存在しない（既存リリースは Unreleased を経由せず日付付きで直接追加されている）。plan §3.7 は「`## [Unreleased]` セクション（無ければ新規追加）または次バージョン（v3.48.0）見出し」と曖昧。

- breaking-soft（settings ファイルパス変更）と新機能（`--surface` UUID 両対応）の両方を含むので **MINOR バンプの v3.48.0** が妥当。
- 既存リリースに合わせるなら `[Unreleased]` セクションを作らず `## [3.48.0] - YYYY-MM-DD` で直接追加する方針に統一する。
- `release` skill との整合性を確認し、release タスクが Unreleased セクションを前提にしているなら方針合わせ。

実装段階で「どの section 名で追記するか」を決めるか、plan に明記すること。

#### M6. `cmdSend` の正規化失敗時の例外処理（§3.6）

§3.6 の実装パターンで `surface: await normalizeSurfaceArg(requireArg("surface"))` を switch case の中で書いているが、`normalizeSurfaceArg` は throw する。switch 〜 break 〜 `postMessageAndExit(message)` の構造で、throw された場合の挙動が plan に明記されていない（top-level の uncaught exception で stack trace が出てしまう）。

**対応案:** switch の前に `try { /* 全 case */ } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }` で wrap するか、各 case の前に正規化済みの `const normalizedSurface = await normalizeSurfaceArg(requireArg("surface"));` を取得するヘルパを切り出してから switch に入る。後者の方が DRY で I/O 1 回。

```ts
// 例: 全 case で surface を要求する case のみ事前正規化
const needsSurface = ["CONDUCTOR_DONE", "CONDUCTOR_REGISTERED", "AGENT_SPAWNED",
                     "SESSION_STARTED", "SESSION_ENDED", "SESSION_ACTIVE",
                     "SESSION_IDLE", "SESSION_ASK", "SESSION_CLEAR",
                     "CONDUCTOR_SESSION"];
let normalizedSurface: string | undefined;
if (needsSurface.includes(type)) {
  try {
    normalizedSurface = await normalizeSurfaceArg(requireArg("surface"));
  } catch (e: any) {
    console.error(`Error: ${e.message}`); process.exit(1);
  }
}
```

ただし AGENT_SPAWNED は `conductor-surface` も正規化が必要なので、その分岐も忘れずに。

#### M7. `from-stdin` 経路は正規化しないことを CHANGELOG / コメントに明記（§3.6）

plan §3.6 の本文に「hook 経由の `cmdSend --from-stdin` 経路はすでに `${CMUX_SURFACE}` shell 展開で ref を渡すため正規化不要」とあるが、**コードコメントとして残さないと将来の改修者が混乱する**。`if (hasFlag("from-stdin"))` 直後に「ここでは正規化しない（hook は ref 形式を渡すという契約に依存）」のコメントを追加することを plan に追記する。

### Minor（任意）

#### Mi1. `findConductor` のフォールバックテスト（§5.3）

plan §5.3 は「UUID 形式と `task-NNN-timestamp` は別形式なので衝突なし」を妥当に分析している。念のため `daemon.test.ts` に「`findConductor(state, "<UUID>")` が undefined を返す」という 1 行 unit test を追加してもよいが必須ではない。

#### Mi2. `plan §5.5` の `cmdSendAgent` 統一を後回しにする判断は妥当

`cmdSendAgent` のエラーメッセージ文言は grep 可能性のために維持する判断は OK。ただし `resolveCallerSurfaceOrExit` ヘルパを作るなら、エラーメッセージを **テンプレート引数化**しておくと将来の統一が楽になる:

```ts
async function resolveCallerSurfaceOrExit(errMsg?: string): Promise<string> {
  ...
  console.error(errMsg ?? "Error: surface を解決できません。...");
  ...
}
```

これは scope 内で十分実装できる軽微なリファクタ。

#### Mi3. `i18n.ts` の help_conductor 更新（§3.3）

plan §3.3 で `help_conductor` の説明を更新するとあるが、`i18n.ts:425-441` の help_conductor は現状「`CMUX_SURFACE  Conductor surface ID (required, set by daemon)`」という記述。`required` を「optional (falls back to cmux identify)」に変えるのが最小修正。`help_conductor` は ja / en 両方にあるので忘れずに（`i18n.ts:425, 945`）。

#### Mi4. `normalizeSurfaceArg` の UUID lookup を memoize するか

`cmdSend` の switch case で 1 surface しか正規化しないので不要だが、将来 `--from-stdin` 経路や複数 surface 取り扱いが入った場合に備えて、**少なくとも 1 process 内で `cmux --json tree` 結果を memo するパターン**は plan に書いておくとよい（実装は scope 外でよい）。

#### Mi5. テスト方針: pure 関数化

§4.1 の `cmdSend` 正規化テストは「`postMessageAndExit` を mock するか pure 関数化したヘルパ部分だけテストする」と曖昧。**正規化部分を `parseSendArgs` のような pure 関数に切り出して unit test する**方が筋がよい（cmdSend 本体は副作用が多くテストしにくい）。ただし scope 内で実装するならよし、scope 外なら明示的に out-of-scope に追加。

## Recommendations

1. **plan §3.1 / §3.2 を C1 の修正案で書き直す**。`cmux --id-format both --json tree` を使うことを明記し、リスク §5.1 を削除する。`TreeOpts` の型を `{ json?: boolean; idFormat?: "refs" | "uuids" | "both" }` のように分離する。
2. **plan §3.5 / §4.2 で main.test.ts 修正を「必須」と断言**する（4 箇所）。
3. **plan §3.6 に正規化失敗時の例外処理パターンを追記**（M6 の try/catch wrap または事前ヘルパ）。
4. **plan §5.5 を「out-of-scope 表」に統合**し、`cmdSpawnConductor` も明示的に out-of-scope に加える（M3）。
5. **CHANGELOG の追記方針を確定**（M5）。
6. 余裕があれば normalizeSurfaceArg のテスト用に `cmux.__setTreeImpl()` で fake JSON を返す pattern を plan §4.1 に具体的に書く（既に「mock JSON」と書かれているが、`{ "windows": [{ "workspaces": [{ "panes": [{ "surfaces": [{"id": "...", "ref": "..."}] }] }] }] }` のサンプルを 1 つ載せると実装者が迷わない）。

これら 6 点を反映できれば Approved。骨格・スコープ境界・out-of-scope の定義はすべて妥当で、再 plan 不要。Critical C1 だけは「実装着手すると即詰まる」レベルなので、plan 修正 → 再レビュー不要 → そのまま実装、で進めてよい。

## Notes

### 確認した cmux --json tree の出力フォーマット

#### `cmux --json tree`（id-format 指定なし）

```json
{
  "windows": [{
    "workspaces": [{
      "ref": "workspace:9",
      "panes": [{
        "ref": "pane:42",
        "surface_refs": ["surface:44"],
        "selected_surface_ref": "surface:44",
        "surfaces": [{
          "ref": "surface:44",
          "tty": "ttys003",
          "title": "[44] Manager",
          "type": "terminal",
          "pane_ref": "pane:42"
        }]
      }]
    }],
    "ref": "window:2"
  }],
  "active": { ... },
  "caller": { "surface_ref": "surface:183", "workspace_ref": "workspace:9", ... }
}
```

- surface オブジェクトに **`id` / `uuid` フィールドなし**。
- 旧フィールド命名: `surface_refs` (複数) / `selected_surface_ref` (単数)。

#### `cmux --id-format both --json tree`

```json
{
  "windows": [{
    "id": "47745E60-1C24-4182-BD18-E3F3812BF625",
    "ref": "window:2",
    "workspaces": [{
      "id": "52DBA606-F6BC-477A-8C92-271DF60A497E",
      "ref": "workspace:9",
      "panes": [{
        "id": "F381CC4E-3773-4483-B010-C45CE6F5B0A0",
        "ref": "pane:42",
        "surface_refs": ["surface:44"],
        "surface_ids": ["A5AC4F23-70D9-4B81-8958-168CD68CF8DF"],
        "selected_surface_ref": "surface:44",
        "selected_surface_id": "A5AC4F23-70D9-4B81-8958-168CD68CF8DF",
        "surfaces": [{
          "id": "A5AC4F23-70D9-4B81-8958-168CD68CF8DF",
          "ref": "surface:44",
          "pane_id": "F381CC4E-3773-4483-B010-C45CE6F5B0A0",
          "pane_ref": "pane:42",
          ...
        }]
      }]
    }]
  }]
}
```

- すべての window / workspace / pane / surface に `id`（UUID 大文字）と `ref`（短縮形）の両方。
- pane オブジェクトでは `surface_ids` と `selected_surface_id` も併記される。
- normalizeSurfaceArg 実装では `parsed.windows[*].workspaces[*].panes[*].surfaces[*]` を walk して `s.id === input.toUpperCase()` または lowercase 化比較で逆引きすればよい。

### コード位置の事実確認結果

| plan の主張 | 実コードでの確認 |
|---|---|
| `generateConductorSettings` 定義 main.ts:1114-1182 | ✓ 1114-1182、surface 引数はファイル名にのみ使用 (1115)、内容は surface 独立 |
| `cmdConductor` env チェック 1189-1195 | ✓ 1189-1195、`if (!surface) { console.error... process.exit(1); }` |
| `cmdResume` env チェック 1276-1282 | ✓ 1276-1282、cmdConductor と同パターン |
| `generateConductorSettings` 呼び出し 2 箇所 | ✓ main.ts:1240, 1325 のみ。プロダクションコードは 2 箇所。**main.test.ts:30, 43, 55, 91 の 4 箇所も併せて修正必要**（rg 結果） |
| `cmdSendAgent` の caller surface 解決 1734-1742 | ✓ 1734-1742、`process.env.CMUX_SURFACE ?? cmux.getCallerSurface()` パターン |
| `findConductor` daemon.ts:169-177 | ✓ taskRunId fallback あり、UUID と taskRunId の形式衝突なし |
| `getCallerSurface()` cmux.ts:192-200 | ✓ `cmux identify` の `caller.surface_ref` を返す。fallback 用に活用可 |
| `tree()` シグネチャ cmux.ts:140 | ✓ 現状 `tree(workspace?: string)`、opts なし。拡張必要 |
| `cmdSend` 全 case の `requireArg("surface")` | ✓ 742, 755, 765, 775, 785, 795, 804, 813, 824, 834 の 10 箇所、`conductor-surface` は 764 |
| `cmdSpawnConductor` の `process.env.CMUX_SURFACE ?? cmux.getCallerSurface()` | ✓ main.ts:1412 に存在（plan §3.4 で言及されていない、M3 で out-of-scope 追加推奨） |

### 補足

- cmux native の `--id-format` グローバルフラグはタスク本文 §3 で正しく言及されていた。plan 作成時にこの記述を「誤り」と判断したのが C1 の根本原因。タスク本文の妥当性をまず信じて、`cmux --help` で確認するのが正解だった。
- 残りの設計判断（state key を ref に固定 / 境界正規化 / hook 内容無変更 / out-of-scope 列挙）は健全で、修正不要。
