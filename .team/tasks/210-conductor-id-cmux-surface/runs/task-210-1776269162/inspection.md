# Inspection: T210

## 判定: GO

## 検品結果

### 1. DoD チェック

- [x] **C1 コミット存在**: `471f0aa refactor(manager): T210 Conductor hook から CONDUCTOR_ID 参照を除去`
- [x] **C2 コミット存在**: `c61d808 refactor(manager): T210 schema から conductorId フィールドを撤去`
- [x] **C1 diff = plan.md §3.1 (変更 A/B/C) + §3.4 (statusline) + §4.2 (guard テスト 3 本)** と完全一致
  - SessionEnd(clear) / SessionEnd(logout|prompt_input_exit) hook command から `--conductor-id "$CONDUCTOR_ID"` を削除
  - DETECT_ASK_SCRIPT から `CONDUCTOR_ID="${CONDUCTOR_ID:-}"` 行と printf 内 `conductorId` フィールド・`jq -Rs` 展開を削除
  - `cmdConductor()` / `cmdResume()` の `process.env.CONDUCTOR_ID = surface` を削除し `process.env.CMUX_SURFACE = surface` に置換（§R2 defensive）
  - `statusline.sh` L92 を `${CONDUCTOR_ID:-}` → `${CMUX_SURFACE:-}`
- [x] **C2 diff = plan.md §3.2 / §3.3 / §3.5 / §4.1 テスト修正** と完全一致
  - `schema.ts` の `SessionAskMessage` / `SessionStopMessage` / `SessionClearMessage` から `conductorId: z.string().optional()` 削除
  - `main.ts` L776-785 の空文字正規化削除（コメント含む）
  - `main.ts` SESSION_ASK / SESSION_CLEAR ケースの `conductorId: getArg("conductor-id")` 削除
  - `daemon.ts` L972 の SESSION_STOP → SESSION_ASK 合成時の `conductorId: message.conductorId` 削除
  - `i18n.ts` L153 / L673 の SESSION_CLEAR ヘルプ `--conductor-id <id>` 行削除
  - `main.test.ts` L852-867 / `daemon.test.ts` L1488 の `conductorId` 参照削除
  - docstring / 古いコメント整理（§「気になった点 2」に記載あり、範囲逸脱ではない）
- [x] `bun test` グリーン（283 pass / 0 fail / 595 expect）
- [x] `bun x tsc --noEmit` 型エラー 0 件

### 2. テスト実行結果

```
$ cd skills/cmux-team/manager && bun test 2>&1 | tail -5
 283 pass
 0 fail
 595 expect() calls
Ran 283 tests across 14 files. [9.91s]

$ bun x tsc --noEmit 2>&1 | tail
(no output — exit 0)
```

### 3. grep 残留チェック結果

本体コード（`skills/cmux-team/manager/` から `*.test.ts` / `template.ts` / `proxy.ts` を除外）からは完全除去:

| コマンド | 結果 |
|---------|------|
| `rg -n "CONDUCTOR_ID" skills/cmux-team/manager --glob '!*.test.ts' --glob '!template.ts'` | **0 件** |
| `rg -n "conductorId" skills/cmux-team/manager --glob '!*.test.ts'` | **0 件** |
| `rg -n "conductor-id" skills/cmux-team/manager --glob '!*.test.ts' --glob '!proxy.ts'` | **0 件** |

**意図的残存**（plan.md §R3 / §R4 / impl-summary.md §4 の通り OK）:

| ファイル:行 | 文字列 | 種別 |
|------------|-------|------|
| `template.ts:114` | `{{CONDUCTOR_ID}}` | 別概念のテンプレート変数（`taskRunId` 置換） |
| `proxy.ts:241` | `x-cmux-conductor-id` | HTTP ヘッダー名（T020 文脈、本タスクスコープ外） |
| `main.test.ts` | `--conductor-id` / `CONDUCTOR_ID` | guard テストの assert 文字列（dead arg 復活防止） |
| `skills/cmux-team/templates/**/conductor*.md` | `{{CONDUCTOR_ID}}` | Conductor の git merge ブランチ名プレースホルダー（別概念） |

### 4. 前方互換性確認

`bun -e` で実 schema を使って 3 種のレガシーメッセージを直接 parse:

```
SESSION_CLEAR OK {"type":"SESSION_CLEAR","surface":"surface:100","pid":1234,"timestamp":"2026-04-16T10:00:00.000Z"}
SESSION_STOP  OK {"type":"SESSION_STOP","surface":"surface:100","pid":1234,"timestamp":"2026-04-16T10:00:00.000Z","payload":{"transcript_path":"/tmp/x.jsonl"}}
SESSION_ASK   OK {"type":"SESSION_ASK","surface":"surface:100","question":"hi","pid":1234,"timestamp":"2026-04-16T10:00:00.000Z"}
```

いずれも `conductorId: "surface:100"` を含む入力が zod エラーなく parse され、出力では silently stripped されていることを確認。外部クライアント（Dear / mado 等）の古い `conductor-settings.json` で生成される旧 hook は引き続き受理される。plan.md §2.1 / §5-5 / §R1 の前提が成立。

### 5. 先行 guard テスト（内容の適切さ）

`main.test.ts` の `describe("SessionStart hook generation (T203)")` 末尾に 3 本追加:

1. `T210: Conductor SessionEnd(clear) hook は --conductor-id を含まない`
   - `generateConductorSettings()` を呼び、`SessionEnd` の `matcher === "clear"` の command から `--conductor-id` と `$CONDUCTOR_ID` が除去されていることを assert
2. `T210: Conductor SessionEnd(logout|prompt_input_exit) hook は --conductor-id を含まない`
   - 同じく `matcher === "logout|prompt_input_exit"` の command を assert
3. `T210: detect-ask.sh（DETECT_ASK_SCRIPT）は CONDUCTOR_ID を参照しない`
   - `ensureAskDetectorScript()` で生成される sh スクリプトから `CONDUCTOR_ID` と `conductorId` が除去されていることを assert

**評価**:
- 3 本とも plan.md §4.2 の仕様と完全一致
- hook 生成（`generateConductorSettings`）と detect-ask.sh 生成（`ensureAskDetectorScript`）の両方をカバーしており、将来 dead arg を復活させようとした際は必ず Red になる
- 既存の `m2: SessionStart hook は --conductor-id を含まない` と合わせ、3 種の hook 系列（SessionStart / SessionEnd(clear) / SessionEnd(logout) / Stop forwarder）をすべて固定できている
- impl-summary.md §「気になった点 3」の通り、design-review.md Minor（`legacyField: "ignored"` 置換案）は採用されず削除のみとなっているが、`m3: 余分なフィールドは無視される`（`conductor_id: "C1"` 含む）が残っているため回帰保護は維持されている

### 6. `cmdConductor` / `cmdResume` の `CMUX_SURFACE` 追加

`main.ts` の C1 diff にて:

```diff
-  process.env.CONDUCTOR_ID = surface;
+  // T210: 通常経路では cmux ペインから env として継承されるため no-op だが、
+  // cmux identify fallback 経路でも statusline.sh / hook が CMUX_SURFACE を
+  // 取得できるよう defensive に明示設定する。
+  process.env.CMUX_SURFACE = surface;
```

- `cmdConductor` / `cmdResume` 両方で元の `CONDUCTOR_ID = surface` の位置に入っており、plan.md §R2 / §T210-8 / §T210-9 と完全一致
- コメントで「通常経路では no-op、fallback 経路のための保険」意図を明記しており、design-review.md Minor §R2 発動条件明示の指摘も解消されている

### 7. コミット分離確認

- **C1** `471f0aa`: `main.test.ts` / `main.ts` / `statusline.sh` の 3 ファイル（hook 定義・env 設定・statusline.sh 参照・guard テスト）のみ。schema / daemon / i18n / daemon.test.ts には一切触れていない。
- **C2** `c61d808`: `daemon.test.ts` / `daemon.ts` / `i18n.ts` / `main.test.ts` / `main.ts` / `schema.ts` の 6 ファイル。schema フィールド削除と producer 側（CLI parser / daemon 合成 / i18n help / テスト）の呼び出し側後始末のみ。hook / env / statusline には触れていない。

→ 「hook/env/statusline」と「schema/parser/合成」がきれいに分離されており、C1 単体でのロールバック・CI 通過が可能な状態。

### 8. 副作用確認

- **`package-lock.json` が unstaged**: 差分は v3.47.1 → v3.48.0 のバージョン更新（4 行）のみで、worktree 初期状態から既に modified 扱いだった。C1 / C2 いずれのコミットにも含まれておらず T210 とは無関係（impl-summary.md §5 / §「気になった点 5」で明記済み）。DoD §7 は package-lock.json に言及していないため問題なし。
- **plan.md / design-review.md に記載されていない意図せぬ変更**: なし。C1 / C2 の `git show --stat` と plan.md §3 の変更ファイル一覧が完全に対応している。
- **範囲逸脱**: C2 で追加された `main.ts:1115` docstring の `surface/conductorId/pid/type` → `surface/pid/type` と SessionStart hook の `// m2: --conductor-id は...` コメント削除は、schema 撤去に付随する整合性維持であり、plan.md §3.2 / §3.3 の変更範囲内と評価できる（範囲外の機能変更ではない）。

## Critical findings（NOGO の根拠）

なし。

## Minor findings（GO だが気になる点）

1. **`package-lock.json` の unstaged 差分**（ブロッカーではない）
   - 内容は v3.47.1 → v3.48.0 のバージョン更新のみで T210 とは独立。
   - impl-summary.md §5 の通り「別途 Conductor 側で処理してほしい」との申し送りあり。
   - 今回のマージ判断には影響しないが、Conductor がコミット・PR 化する段階で「リリース準備済みの差分を含めるか、stash して分離するか」を決定する必要がある。

2. **docstring / コメント整理が C2 に混入**（範囲逸脱ではない）
   - C2 で `main.ts:1115` の `DETECT_ASK_SCRIPT` docstring と SessionStart hook の `// m2: ...` コメントが更新されている。
   - 機能的には schema 撤去の付随整理で正しいが、コミット境界の厳密解釈では C1（docstring は DETECT_ASK_SCRIPT の実装と一緒に更新）と C2（コメントは getArg 削除と一緒に更新）に分かれても良かった。
   - レビュー時の混乱を招くほどではないので Minor。

3. **design-review.md の Minor 指摘 (§4.1 L852-867 の `legacyField` 置換案)** が未反映
   - impl-summary.md §「気になった点 3」で「plan.md §8 指示通り削除のみ」と判断されており、`m3: 余分なフィールドは無視される` が回帰保護を肩代わりしているため機能的には問題なし。
   - 今後「余分な key を含む SESSION_STOP の旧 QueueMessage パス」に特化した回帰保護を厚くしたい場合はフォローアップ可能。

## 結論

**GO: マージ可能**

- plan.md §7 DoD の全項目が達成されており、C1 / C2 の 2 コミット分割・diff 内容・テスト追加・grep 残留チェック・前方互換性の 5 点すべてが Pass。
- テスト 283 pass / 0 fail、型エラー 0、旧 hook を模した 3 種のレガシーメッセージ parse も OK。
- コミット境界は「hook/env/statusline」vs「schema/parser/合成」で clean に分離されており、C1 単独ロールバックも可能な状態。
- `package-lock.json` の unstaged 差分は T210 とは無関係（v3.47.1 → v3.48.0 のリリース差分）であり、コミットへの混入もない。Conductor が次の納品フェーズで処理すれば良い。
