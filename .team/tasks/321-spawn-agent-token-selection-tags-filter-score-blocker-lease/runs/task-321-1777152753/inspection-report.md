# T321 検品レポート

## 判定: GO

実装は plan.md に沿って完了しており、完了条件を全て満たす。テスト・型検査も clean。後述の Minor 指摘は将来対応で十分（リリース blocker ではない）。

---

## 検証実行結果（自分で再実行）

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-321-1777152753`

```
$ bun test skills/cmux-team/manager/project-tags.test.ts
project_tags_config_parse_failed: JSON Parse error: Expected '}'
 23 pass / 0 fail / 24 expect() calls
Ran 23 tests across 1 file. [101.00ms]

$ bun test skills/cmux-team/manager/token-store.test.ts
 74 pass / 1 skip / 0 fail / 140 expect() calls
Ran 75 tests across 1 file. [1.65s]

$ bun test skills/cmux-team/manager/main.test.ts
 169 pass / 0 fail / 417 expect() calls
Ran 169 tests across 1 file. [16.06s]

$ bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json
EXIT=0  (clean / no output)
```

合計: 266 pass / 1 skip / 0 fail / 581 expect()。impl-report の数字と一致。

console.error の `project_tags_config_parse_failed: ...` は test 専用ケース（"JSON parse 失敗 → fallback"）の期待動作で、出力 1 行のみ。テストノイズとして許容範囲。

---

## 必須チェック結果

- [x] **完了条件の充足**: `resolveProjectTags` / `parseRemoteOriginToTags` を `project-tags.ts` から export 済 (lines 25, 43, 129)。`main.ts:2694` で第 3 引数 `projectTags` を渡している。bun test / tsc いずれも pass。
- [x] **テスト実行**: 上記の通り 4 コマンド全て成功。
- [x] **`selectToken` シグネチャ不変**: `token-store.ts:710-715` で `(db, holder, projectTags = ["any"], nowIso = ISO)` のまま。第 3 引数 default `["any"]` も維持。
- [x] **`["any"]` フォールバック整合性**: resolver 内部で 3 段階 fail-safe (`config.json` → git remote → `["any"]`)、caller (main.ts:2685-2693) でも try/catch + `projectTags = ["any"]` で二重防護。`selectToken` 側で `projectTagSet.has("any")` を wildcard 扱い (`token-store.ts:734-736`) しており、`["any"]` を渡せば全 selectable token が候補に入る。整合性 OK。
- [x] **plan.md の host 判定ルール準拠**: `parseRemoteOriginToTags` test (project-tags.test.ts:9-77) が以下を固定:
  - `github.com` SSH/HTTPS/.git 各形式 → `["any"]`
  - `www.github.com` → `["any"]`
  - `gitlab.com` / `bitbucket.org` → `["any"]`
  - `github.kddi.com` SSH/HTTPS/`ssh://...:22/...` → `["org:kddi"]`
  - `github.acme.com` SSH → `["org:acme"]`
  - `git.internal.example.com` / `gitea.example.com` → 最初のラベル
  - 空文字 / `not-a-url` → `["any"]`
  - `GitHub.KDDI.com` → 大文字小文字正規化して `["org:kddi"]`
  全て plan.md §1.3 / §4 の表と一致。
- [x] **Implementer の自己判断（cmdSpawnAgent E2E のスコープ外化）の妥当性**: `cmdSpawnAgent` (main.ts:2483-2730 付近) は `process.exit` 多用 + `cmux.send` / `postMessage` / direnv check / preflight などの副作用を抱えており、`exportVars` の build 部分を pure 関数として切り出すリファクタが必要。本タスクのスコープを明らかに超える。代替として `token-store.test.ts` に selectToken の tags フィルタ 6 ケース (lines 1061-1149) を追加しており、tags フィルタの core 動作は十分カバー。判断は妥当で、後続タスク提案も適切（impl-report §後続タスク 1）。
- [x] **二重防護**: resolver 内部の throw 防止 (project-tags.ts:131-156 の `try/catch`、`extractHost` 失敗時の null 返し、`readGitOriginUrl` の try/catch + 空文字返し) + caller 側 try/catch (main.ts:2685-2693) が両方あり。
- [x] **副作用ログ**: `project_tags_resolve_failed` を caller 側で `await log(...)` 経由 (main.ts:2688-2691)。resolver 内部は `console.error` のみで logger 依存なし — plan.md §1.4 の方針通り。

---

## 見落とし候補チェック

- [x] **main.ts:120 の import 重複**: `selectToken` import は元々 `from "./token-store"` の named import 内に存在 (line 120)。`resolveProjectTags` import は line 130 で別途追加。重複なし。
- [x] **selectToken の他 caller**: `grep -rn "selectToken(" --include="*.ts" skills/` で確認。プロダクションコードは `main.ts:2694` の 1 箇所のみ。テストは `token-store.test.ts` の 6 箇所（新規）。シグネチャ変更不要、呼出修正漏れなし。
- [x] **config.json `project_tags` の型ガード**: `Array.isArray(candidate) && candidate.length > 0 && candidate.every((t) => typeof t === "string")` (project-tags.ts:142-146)。malformed 入力（数値混入 / "not-array" / 空配列 / null）は全て test 済 (project-tags.test.ts:101-141)。`null` 直書き（`{"project_tags": null}`）も `Array.isArray(null) === false` で fallback、堅牢。
- [x] **`parseRemoteOriginToTags` の正規表現カバレッジ**: SSH `git@host:o/r(.git)`、HTTPS `https?://[user@]host/o/r(.git)[/]`、`ssh://`/`git://` (port 付き含む) の 3 形式を網羅。`https://user:pass@host/o/r` も sanity check で `["org:kddi"]` に解決することを確認済。
- [x] **temp dir cleanup**: `try { ... } finally { await rm(root, { recursive: true, force: true }); }` が 7 ケース全てに付与 (project-tags.test.ts:86-176)。漏れなし。
- [x] **console.error ノイズ**: 1 ケースのみ `project_tags_config_parse_failed: ...` が出るが、これは "JSON parse 失敗 → fallback" 動作の確認テストの副作用。test runner の出力は許容範囲。
- [x] **`import type` 問題**: `resolveProjectTags` は値として呼ばれる (`await resolveProjectTags(...)`) ので value import で正しい。`parseRemoteOriginToTags` も同様。`type` import が必要な箇所はない。

---

## 発見した問題

### Critical (block release)
なし。

### Major (should fix before merge)
なし。

### Minor (nice to have / 後続タスク候補)

1. **HTTPS URL に port が付くと host にコロンが残る**:
   `https://github.com:8080/foo/bar` → `extractHost` が `github.com:8080` を返し、`["org:github"]` と判定される（期待は `["any"]`）。
   原因: HTTPS regex の host capture が `[^/]+`（コロンを許容）。
   実機への影響: git remote が port 付き HTTPS URL のケースは極めて稀。実害なし。
   修正: `extractHost` 内で host から `:port` を strip すれば堅牢化できる。後続タスク or 軽微パッチで OK。

2. **SSH 形式の trailing slash が解析失敗**:
   `git@github.kddi.com:foo/bar.git/` → `extractHost` が null を返し fallback。
   原因: SSH regex に `\/?$` がない（HTTPS 側にはある）。
   影響: trailing slash 付き SSH URL は通常存在しないので実害なし。

3. **resolver が PROJECT_ROOT/.team/config.json を直接読む（TeamConfig 経由でない）**:
   plan.md §4 で意識的に選択された設計（`TeamConfig` 型変更による spec 04/05 への波及を避けるため）。impl-report §後続タスク 2 で正式昇格を提案済。現状で問題なし。

4. **`resolveProjectTags` の git fallback パスは integration test で deep test していない**:
   plan.md §2 Step 3 / §4 で意識的にスコープ外（git の存在に依存する CI が壊れやすいため）。pure 関数 `parseRemoteOriginToTags` で網羅されており、実機検証は impl-report §後続タスク 4 で sanity check として提案済。許容範囲。

---

## 結論と推奨アクション

**判定: GO（リリース可能）**

- plan.md §5 の完了条件チェックリスト（8 項目）全て充足。
- 設計判断（resolver を独立ファイルに置く / `TeamConfig` 経由にしない / cmdSpawnAgent E2E を後続タスク化）はいずれも妥当で、impl-report に明文化されている。
- テスト：23 + 74 + 169 = 266 pass、1 skip（Keychain real darwin 既存）、0 fail。tsc clean。
- selectToken シグネチャ・既存 main.ts 動作・AGENT_TOKEN_BOUND ロジック・isTokenPoolEnabled ガードに副作用なし（grep で全 caller 確認済）。

### 推奨アクション

1. **本タスクは merge 可能**。conductor は `cmux-team close-task --deliverable-kind merged` で close する。
2. **impl-report §後続タスク 1（cmdSpawnAgent E2E refactor）** を別タスクとして起票することを推奨。本検品でも代替カバレッジは十分と判断したが、long-term の堅牢性のためには pure 関数 `buildSpawnExportVars(...)` への切り出しが望ましい。
3. **Minor 1（HTTPS port handling）** は `extractHost` の軽微修正で対応可能。緊急ではないが、follow-up commit で 1 行 (`host.replace(/:\d+$/, "")`) 追加すると堅牢化。後続タスクの一部として扱うか、本 PR の merge 後に独立 commit でも可。
4. **impl-report §後続タスク 4（sanity check）** — token pool が enabled なプロジェクトで `cmux-team spawn-agent` を 1 度走らせ `manager.log` の `token_pool_assigned` ログを確認することを releaser に推奨。
