# T304 Impl Notes

## 変更ファイル一覧

| path | 変更概要 | 追加行 |
|------|---------|-------|
| `skills/cmux-team/manager/main.ts` | 3 つの settings 生成関数に `env.ANTHROPIC_CUSTOM_HEADERS` を追加 | +13 |
| `skills/cmux-team/manager/main.test.ts` | T304 用 test 3 件を追加 | +29 |

`git diff --stat HEAD`:

```
 skills/cmux-team/manager/main.test.ts | 29 +++++++++++++++++++++++++++++
 skills/cmux-team/manager/main.ts      | 13 +++++++++++++
 2 files changed, 42 insertions(+)
```

## main.ts の変更箇所

各 generator の `Record<string, any>` リテラル冒頭に `env:` キーを追加した（3 行 + コメント 1 行 × 3 箇所 = 13 行）。

| 関数 | 追加位置 | env 値 |
|------|---------|--------|
| `generateMasterSettings` | main.ts L1750-1753 | `ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: master"` |
| `generateAgentSettings` | main.ts L1837-1840 | `ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: agent"` |
| `generateConductorSettings` | main.ts L1904-1907 | `ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: conductor"` |

コメントは plan.md の指示に従い T211 regression を踏まないよう「ロール識別ヘッダー」の日本語で記述し、`CMUX_ROLE` 文字列は入れていない。`grep -n "CMUX_ROLE" skills/cmux-team/manager/main.ts` は 0 件を確認済み。

## 新規テスト 3 件の場所

`skills/cmux-team/manager/main.test.ts` L1616-1643:

- L1618 `describe("generateMasterSettings (T304: x-cmux-role)", ...)` — L1619 の test
- L1627 `describe("generateConductorSettings (T304: x-cmux-role)", ...)` — L1628 の test
- L1636 `describe("generateAgentSettings (T304: x-cmux-role)", ...)` — L1637 の test

T211 Phase 4 regression describe（L1608-1614）の直後に配置。

## テスト結果

### `bun test skills/cmux-team/manager/main.test.ts`

```
 148 pass
 0 fail
 396 expect() calls
Ran 148 tests across 1 file. [12.04s]
```

full pass。T211 Phase 4 regression（`main.ts` に `CMUX_ROLE` 文字列が残っていない）も依然 pass。T266 Notification hook test も独立に pass。

### 失敗確認（test-first）

実装前に `bun test -t "T304"` を実行し、3 件とも `expect(settings.env).toBeDefined()` で `Received: undefined` となり fail することを確認。

### `bunx tsc --noEmit`

**新規エラー 0 件。**

既存 3 件のエラーは **base branch (T303 時点 / HEAD=06a074a) から存在**しており、T304 とは無関係:

- `conductor.ts(201,3)`: TS1016 optional parameter follow
- `daemon.test.ts(3870,9)`: TS2322 `"new_session"` not assignable
- `daemon.ts(1558,22)`: TS2352 string → SESSION_STARTED union conversion

実装前に `git stash` で確認済み。plan.md の scope（3 つの settings 生成関数 + test のみ）外のため修正は行っていない。

## plan.md との乖離点

なし。plan.md の採用案（2.1）どおり `env.ANTHROPIC_CUSTOM_HEADERS` を追加するだけの最小変更で完了。proxy.ts / docs/spec / CLAUDE.md には手を入れていない（plan.md 3 の「任意」欄も今回は見送り）。
