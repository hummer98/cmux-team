# Inspection Result

## Verdict: NOGO

## Findings

### 1. 変更の正確性

**OK** — plan.md で指定された3箇所の変更は正しく行われている:

- `main.ts` L12: ヘッダーコメントから `[--surface <surface>]` が削除済み
- `main.ts` `cmdSpawnConductor()`: `getArg("surface")` が削除され、`process.env.CMUX_SURFACE ?? await cmux.getCallerSurface()` のみに変更済み
- `i18n.ts`: `help_spawn_conductor` の英語・日本語ヘルプから `--surface` オプション説明が削除済み

### 2. 残存参照

**NG** — `--surface` が spawn-conductor のコンテキストで参照されている箇所が4箇所残っている:

1. **`skills/cmux-team/manager/i18n.ts:449`** — 英語の全体ヘルプ（`help_main`）内に `cmux-team spawn-conductor [--surface <s>]` が残存
2. **`skills/cmux-team/manager/i18n.ts:893`** — 日本語の全体ヘルプ（`help_main`）内に `cmux-team spawn-conductor [--surface <s>]` が残存
3. **`docs/spec/01-skill-cmux-team.md:72`** — CLI コマンド表に `--surface` が記載されたまま
4. **`docs/spec/05-install-and-infrastructure.md:112`** — サブコマンド表に `--surface` が記載されたまま

### 3. 動作の一貫性

**OK** — `const surface = process.env.CMUX_SURFACE ?? await cmux.getCallerSurface();` により、`CMUX_SURFACE` 環境変数があればそれを使い、なければ `getCallerSurface()` にフォールバックする動作が正しく維持されている。

### 4. 余計な変更

**OK** — plan.md に記載のない変更は含まれていない。

## Fix Required

以下の4箇所から spawn-conductor の `--surface` 記述を削除する必要がある:

1. `skills/cmux-team/manager/i18n.ts:449` — `cmux-team spawn-conductor [--surface <s>]` → `cmux-team spawn-conductor`
2. `skills/cmux-team/manager/i18n.ts:893` — `cmux-team spawn-conductor [--surface <s>]` → `cmux-team spawn-conductor`
3. `docs/spec/01-skill-cmux-team.md:72` — `（`--direction right|down`, `--surface`）` から `--surface` を削除
4. `docs/spec/05-install-and-infrastructure.md:112` — `（`--direction right|down`, `--surface`）` から `--surface` を削除
