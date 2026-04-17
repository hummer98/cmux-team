# Inspection Report: T206

## Verdict
**GO**

## Summary

Implementer は plan.md と design-review.md（Critical C1 + Major M1-M7）の指摘事項を **すべて適切に反映**して実装した。`cmdConductor` / `cmdResume` から `CMUX_SURFACE` 必須撤廃、`--surface` UUID 両対応、`generateConductorSettings` 共通化の 3 つの主要変更がいずれも spec 通りに動作し、bun test 254 件すべて pass、tsc --noEmit エラーゼロ。out-of-scope に列挙された項目（state primary key 移行、`.team/conductors/surface_NNN/` の UUID 化、resume 時の owner 照合、`cmdSpawnConductor` の env パターン等）はいずれも触られていない。

唯一気になる点は `package-lock.json` の version 行（3.46.0 → 3.47.1）が含まれていることだが、これは `package.json` の現バージョン（3.47.1）に追従するための機械的な再生成で、T206 のスコープと衝突しない無害な変更。NOGO 要因ではない。

## Test Results

- `bun test`: **254 pass / 0 fail** (14 files, 500 expect calls, 8.17s)
- `bun x tsc --noEmit`: **pass**（exit 0、エラー出力なし、tsconfig は `skills/cmux-team/manager/tsconfig.json` を使用）

新規追加された `normalizeSurfaceArg` の unit test 6 ケース（ref pass-through / UUID 大文字小文字無視 / UUID not-found / 不正形式 / JSON parse 失敗 / 空 windows）はすべて pass。

## Critical / Major / Minor Findings

### Critical (NOGO 要因)
- **なし**

### Major
- **なし**

### Minor
- **Mi-A. `package-lock.json` の version 行更新が混入**（3.46.0 → 3.47.1）。現リポジトリの `package.json` は 3.47.1 なので機械的な追従であり害はないが、T206 の論理的な diff には属さない。コミット時に分離するかは Conductor の判断に委ねる。
- **Mi-B. `cmdSendAgent` の caller surface 解決パターン統一**は plan §5.5 / design-review M3 の方針通り **意図的に未対応**（grep 可能性のため独自エラーメッセージを温存）。今後のリファクタ余地として残るが、本タスクでは正しく out-of-scope。
- **Mi-C. design-review Mi5 が示唆していた pure 関数化（`parseSendArgs` のような切り出し）**は実施されておらず、`cmdSend` 本体内で switch 前に正規化する形になっている。M6 の最小修正パスとしては妥当で、scope 内で十分許容範囲。
- **Mi-D. design-review Mi3 が指摘していた `i18n.ts` の help_conductor 説明文更新は両言語（en/ja）で実施済み**（`required` → `optional; falls back to cmux identify`）。Notes セクションの記述も更新されていて好印象。

## Coverage Check (Design Review C1 + M1-M7)

| Item | Status | Notes |
|------|--------|-------|
| **C1** `cmux --id-format both --json tree` 経路 | ✓ | `cmux.ts:129` で `TreeOpts = { json?: boolean; idFormat?: "refs"\|"uuids"\|"both" }` の独立 2 キー定義。`tree()` 実装は `--id-format` → `--json` → `tree` の順で args を組み立てる（136-148 行）。`normalizeSurfaceArg` は `cmux.tree(undefined, { json: true, idFormat: "both" })` を呼ぶ（main.ts:218）。 |
| **C1** UUID 比較は toLowerCase | ✓ | `main.ts:213-214, 233-234` で `target = input.toLowerCase()` / `sid = s.id.toLowerCase()` で比較。test では大文字 UUID と小文字入力の双方向で pass を確認。 |
| **M1** `treeImpl` 型拡張 + テスト mock シグネチャ整合 | ✓ | `cmux.ts:135` で `((workspace?, opts?) => Promise<string>) \| null` に拡張。`__setTreeImpl` の引数型注釈も追従。`main.test.ts` の mock は `async (workspace?: string, opts?: any) => ...` で適合。tsc エラーゼロ。 |
| **M2** `main.test.ts` の `generateConductorSettings(testDir, "surface:100")` 4 箇所修正 | ✓ | line 32, 45, 57, 93 の 4 箇所すべて `generateConductorSettings(testDir)` に変更済み。 |
| **M3** `cmdSpawnConductor` は触られていない | ✓ | `main.ts:1507-1512` の `process.env.CMUX_SURFACE ?? await cmux.getCallerSurface()` パターンは現行のまま。out-of-scope を遵守。 |
| **M4** UUID 大文字小文字比較 | ✓ | C1 と同一実装で対応済。test の uppercase / lowercase 双方が pass。 |
| **M5** CHANGELOG `## [3.48.0] - 2026-04-15` 直追加 | ✓ | `[Unreleased]` セクションを作らず、既存 `[3.47.1] - 2026-04-15` の直前に `[3.48.0] - 2026-04-15` を追加。Breaking (soft) / Changed / Removed の 3 セクション構成。 |
| **M6** `cmdSend` 正規化失敗時の例外処理パターン | ✓ | switch の前で `SURFACE_REQUIRED_TYPES` set を作り、該当 type のみ事前に正規化（main.ts:771-803）。try/catch で wrap し、失敗時は `console.error` + `process.exit(1)`。AGENT_SPAWNED の `conductor-surface` も別 try/catch で対応。I/O は最大 2 回（surface + conductor-surface）で最小化。 |
| **M7** `cmdSend --from-stdin` 経路は正規化しない + コードコメント | ✓ | `main.ts:738-739` に「T206: hook は `${CMUX_SURFACE}` を ref 形式で渡す契約なので、ここでは UUID 正規化しない。」のコメントを追加。CHANGELOG にも「`send --from-stdin`（hook 経由）は ref 契約のため正規化対象外」を明記。 |

## タスク要件への適合性

| 要件 | Status | Notes |
|------|--------|-------|
| `cmdConductor` から `CMUX_SURFACE` 必須撤廃 | ✓ | `resolveCallerSurfaceOrExit()` ヘルパで CMUX_SURFACE → cmux identify の順に解決（main.ts:1271-1287）。 |
| `cmdResume` から `CMUX_SURFACE` 必須撤廃 | ✓ | 同ヘルパを呼ぶ（main.ts:1379）。 |
| `--surface` UUID / ref 両対応 — 対象 CLI 網羅 | ✓ | `cmdSend` (10 case), `cmdSpawnAgent` (--conductor-surface), `cmdKillAgent`, `cmdSendAgent`, `cmdAwaitAgent` の 5 関数に正規化を適用。CHANGELOG にも 5 コマンド名を明記。 |
| `generateConductorSettings` 共通化 — 呼び出し 2 箇所修正 | ✓ | シグネチャから `surface` 引数を削除し、ファイル名を `conductor-settings.json` に固定。`cmdConductor` (1438) / `cmdResume` (1419) の 2 箇所で引数 1 個版を呼ぶ。 |
| CHANGELOG 追記 | ✓ | Breaking (soft) で full quit 推奨、Changed で env 任意化と UUID 両対応、Removed で旧ファイル再生成停止を明記。 |

## scope 外の確認（触られていないこと）

| 項目 | Status |
|------|--------|
| state primary key の UUID 移行 | ✓ 触られていない（`state.conductors` の Map key は ref のまま） |
| `.team/conductors/surface_NNN/` の UUID 化 | ✓ 触られていない |
| resume 時の owner 照合 | ✓ 触られていない |
| ts.sessionId / `/clear` 追従 | ✓ 触られていない |
| aborted からの resume / restart | ✓ 触られていない |
| 古い `surface:*-settings.json` の自動クリーンアップ | ✓ 触られていない（CHANGELOG にも「放置しても害はない」と明記） |
| `cmdSpawnConductor` の env パターン | ✓ 触られていない（M3 遵守） |

## コード品質

- **既存パターンへの整合性**: ✓ `requireArg` → `try { normalizeSurfaceArg(...) } catch { exit 1 }` のパターンは 5 関数で統一されており、横並びで読める。
- **エラーハンドリング**: ✓ 形式不一致 / cmux 接続失敗 / JSON parse 失敗 / not-found の 4 種類で個別エラーメッセージを返す。test もそれぞれを別ケースで検証。
- **後方互換性**: ✓ hook 経由の `cmdSend --from-stdin` 経路では正規化を skip しているため、daemon の高頻度呼び出し path に I/O 追加なし。コメントで契約を明示。
- **不要な変更**: 上記 Mi-A の `package-lock.json` 以外は確認されず。

## CHANGELOG 内容

- ✓ Breaking (soft) で「**既存の起動中 Conductor は古いファイルパスを参照しているため、本バージョンに上げる場合は `cmux-team start` を full quit → restart する必要がある**」「`/clear` だけでは復旧しない」を明記。
- ✓ Changed で env 撤廃の動機（手動デバッグ）と UUID 両対応の対象 CLI を列挙。
- ✓ Removed で旧ファイル再生成停止と「放置しても害はない」を明記。
- 文体: 既存 [3.47.x] エントリと整合、bullet 末尾の句点「。」がない箇所が 3 つあり統一性は微妙だが、既存 entries の表記揺れ範囲内。

## Fix Required (NOGO の場合のみ)

なし。

## Notes

- 検品中に発見した「Mi-A. `package-lock.json` の version 行更新」は単独でコミットを分けるかどうかは Conductor の判断。コミット文言で言及しておけば trace 上は十分。
- `normalizeSurfaceArg` は `export` されているため、将来 `cmdSendAgent` 等の caller surface 解決にも再利用可能。今すぐの統一は不要だが、参考まで。
- design-review.md の Notes に書かれていた cmux JSON 出力サンプル（`surface_ids`, `selected_surface_id` 等）の確認は test 内で固定 JSON を返すことで間接的に検証できている。実機 cmux 出力との突合は 4.3 手動 E2E に委ねられているが、それは Inspector の責務ではない。
- `bun test` 出力に `.envrc` 警告が複数表示されたが、これは別テストの副作用で T206 と無関係。
