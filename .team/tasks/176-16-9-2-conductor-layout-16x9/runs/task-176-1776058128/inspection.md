---
role: inspector
task: T176
run: task-176-1776058128
---

# Inspection: T176 16x9 Layout Mode

## 判定: GO

## 検品サマリー

計画書 Step 1〜9 が完全に実装され、`bun test` が 142 pass / 0 fail（新規 17 テスト含む）。16x9 分岐は `newSplit("down"→"right")` で目的レイアウト（上段フル幅 + 下段 2 分割）を実現し、CLI > config > default の優先順位も単体テストで検証済み。後方互換性（layout 省略 / 旧 team.json）も担保されており、致命的欠陥なし。

## チェックリスト

- [x] 計画書の実装ステップ完了（Step 1〜9 全て）
- [x] bun test pass（142 pass / 0 fail、新規 17 テスト含む）
- [x] 型エラー無し（新規エラー 0、既存 5 件は scope 外）
- [x] 後方互換性確認（layout 省略・旧 team.json → wide）
- [x] ドキュメント更新（docs/spec/00, 05, CLAUDE.md）

## 検品詳細

### 1. 計画書との整合性

| Step | ファイル | 確認結果 |
|------|---------|---------|
| 1 schema 追加 | `schema.ts:175-182` | `LayoutMode` Zod enum + `LAYOUT_MAX_CONDUCTORS` 定数定義 ✅ |
| 2 `resolveLayout` | `main.ts:113-122` | CLI > config > "wide" の優先順位実装、不正値 throw ✅ |
| 3 DaemonState.layout | `daemon.ts:52, 94-124` | `layout: LayoutMode` 追加、envMax > layout 派生値の既存互換維持 ✅ |
| 4 cmdStart layout 注入 | `main.ts:219-229, 247` | `getArg("layout")` → `resolveLayout` → `createDaemon` 連結 ✅ |
| 5 createConductorPanes 16x9 | `conductor.ts:160-191` | `newSplit("down",daemon) → newSplit("right",c1)` 実装、count>2 clamp ✅ |
| 6 initializeConductorSlots 伝搬 | `conductor.ts:221, 229` | `layout` 引数を受け取り `createConductorPanes` へ渡す ✅ |
| 7 team.json layout 記録 | `daemon.ts:1235` | `teamJson.layout = state.layout` ✅ |
| 8 i18n help 更新 | `i18n.ts:85,88-96,597,600,607-608` | ja/en 両方に `--layout` 説明追加 ✅ |
| 9 docs 更新 | `docs/spec/00,05, CLAUDE.md` | レイアウトモード節を新設・更新 ✅ |

### 2. コードレビュー

- **schema.ts**: Zod enum と TS 型を同名で併存させる pattern は既存 (`ConductorStatus`) と整合。定数マップも型安全。
- **main.ts `resolveLayout`**: シンプルかつ export されており単体テスト可能。実装意図通り。
- **daemon.ts `createDaemon`**: envMax 指定時は env 値を `Number()` でそのまま採用し、16x9 + envMax>2 時に警告ログ `max_conductors_layout_mismatch` を出力。実際の pane 数 clamp は `createConductorPanes` 側で行う二層防御構造。logic コメントも明確。
- **daemon.ts resume path** (L406-415): 旧 team.json に `layout` フィールドが無い場合 "wide" として扱い、不一致時に `layout_mismatch_on_resume` を警告。後方互換確保。
- **conductor.ts `createConductorPanes`**: 16x9 分岐は目的レイアウト（上段フル幅 + 下段左右 2 分割）を実現する。`newSplit("down", daemon)` で下段を切り、その下段を `newSplit("right", s1)` で 2 分割する手順は妥当。count==1 エッジケース（right split 省略）も対応済。
- **i18n.ts**: ja/en 両方の `help_start` に `--layout`、`.team/config.json` 連携、env 環境変数との優先順位を記載。情報の一貫性あり。

### 3. テスト

```
bun test 実行結果:
 142 pass
 0 fail
 320 expect() calls
 Ran 142 tests across 9 files. [7.65s]
```

- 新規テスト 17 件（conductor:5 / daemon:6 / main:6）を確認。新規追加テスト群はすべて pass。
- `createConductorPanes` の `newSplit` 呼び出し順序を spy で検証しており、16x9 分岐の正確性を担保。
- `resolveLayout` は全分岐（default / config / CLI / CLI 優先 / 不正値 2 種）を網羅。
- `createDaemon` で env 優先 / layout 派生値 / team.json mismatch warning を検証。

### 4. 後方互換性

- `resolveLayout({}, undefined) → "wide"` ✅（main.test.ts:243-245）
- `createConductorPanes(count, daemonSurface)`（layout 省略）は wide と同挙動 ✅（conductor.test.ts:180）
- 旧 team.json（layout フィールド無し）は `restoredLayout = "wide"` ✅（daemon.ts:407-408）
- `CMUX_TEAM_MAX_CONDUCTORS` 環境変数の挙動は破壊されていない（envMax > layout 派生値時に env 優先） ✅

### 5. ドキュメント

- `docs/spec/05-install-and-infrastructure.md:234-`: 「## レイアウトモード」節を新設、モード表・優先順位・再起動時挙動・`layout_mismatch_on_resume` を網羅。
- `docs/spec/00-project-overview.md:47-`: 「レイアウト」節を wide/16x9 の 2 サブセクションに再構成。
- `CLAUDE.md`（worktree 内）: 「レイアウト戦略」を更新済（impl.md 通り）。

### 6. 型チェック

既存エラー 5 件（`cmux.ts:22`, `dashboard.tsx:372/952`, `main.test.ts:82`, `main.ts:422`）は T176 着手前からのもので対象外。新規導入エラーはゼロ（impl.md §3 の stash 比較で確認済）。

## 残課題（GO 判定には影響なし）

- **E2E 手動確認未実施**: cmux 実環境での pane 構成目視確認は本実装単体テストの範囲外。検証手順 §4 は別途 Conductor 側で実施する必要あり。
- **既存 TS エラー 5 件**: 別タスクでクリーンアップすべき（T176 scope 外）。
