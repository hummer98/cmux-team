# T193 実装レポート

## 概要

plan.md に従い、以下 2 点を実装した:

1. Conductor 起動時の初期プロンプト投入を廃止（`taskPromptFile` 指定時のみ push）
2. cmux タブ名を `[<num>] <役割>` の 4 種に固定化（`Master` / `Manager` / `Conductor` / `Agent`）

## 変更ファイル

| ファイル | 増減 | 内容 |
|---|---|---|
| `skills/cmux-team/manager/conductor.ts` | +5 / -22 | launchConductor タブ名固定、assignTask の rename ブロック削除、resetConductor の rename 削除 |
| `skills/cmux-team/manager/i18n.ts` | +0 / -8 | en/ja の `conductor_wait_prompt` エントリと見出しコメント削除 |
| `skills/cmux-team/manager/main.ts` | +7 / -24 | 初期プロンプト条件付き push、initializeLayout resume rename 削除、cmdSpawnAgent タブ名 `[N] Agent` 化 |
| **合計** | **+12 / -54** | **-42 行** |

## 変更詳細（plan §2 に対応）

### §2-1 main.ts `claudeArgs` 初期プロンプト
- 旧: `initialPrompt = taskPromptFile ? ... : t("conductor_wait_prompt")` を無条件 push
- 新: `if (taskPromptFile)` で push、未指定時は何も push しない

### §2-2 i18n.ts `conductor_wait_prompt`
- en (67-69) / ja (590-592) の 2 エントリと見出しコメントを削除

### §2-3 conductor.ts launchConductor
- `if (!opts?.resumeTaskId)` ガード削除 → 常に `[${num}] Conductor` で rename

### §2-4 conductor.ts assignTask
- `// --- 5. タブ名更新 ---` ブロック（`num` / `shortTitle` / renameTab / catch-error）を削除
- `formatSurface` 他の使用箇所が残るため import は維持

### §2-5 conductor.ts resetConductor
- `// 3. タブ名をリセット` 行（num / renameTab）削除
- コメント `// 4. ConductorState リセット` も 「4.」ラベルのみ維持

### §2-6 main.ts initializeLayout resume rename
- `renameTab` 3 行削除
- taskTitle 取得ループ（576-585）は **そのまま残す**
- コメント `// タスクタイトルを取得（renameTab 用）` → 「ダッシュボード/team.json 用」

### §2-7 main.ts cmdSpawnAgent タブ名
- `roleIcons` / `roleIcon` / `shortTitle` / `tabName` 全削除
- `await cmux.renameTab(surface, \`[${num}] Agent\`)` へ置換
- `taskTitle` は後続の `AGENT_SPAWNED` postMessage 用に残存

## 検証結果

### 型チェック (§5-1)

```bash
cd skills/cmux-team/manager && bunx tsc --noEmit
```

→ **エラーなし（output 空）**

### テスト (§5-2)

```bash
cd skills/cmux-team/manager && bun test
```

→ **246 pass / 0 fail（472 expect calls / 14 files / 14.26s）**

### 事前 rg 確認（§4 / §3.1 実施分）

- `conductor_wait_prompt`: i18n.ts 68 / 591 / main.ts 1247 の 3 箇所のみ → 全て削除対象として網羅
- `roleIcons / roleIcon / shortTitle`: 削除後は `dashboard.tsx:527,535` のみ残存（**変更対象外のローカル定義**で plan §2-8 通り）
- `renameTab`: cmux.ts:110（定義）/ master.ts:35 / main.ts:512 は変更不要、その他の C/A 関連 5 箇所はすべて編集済み

## 変更しなかったもの（plan §1「変更しないもの」遵守）

- `skills/cmux-team/templates/*.md`（触らない）
- `.team/prompts/*.md`（派生物）
- `dashboard.tsx:527` の `roleIcons`（独立）
- `statusline.sh` の `♦` アイコン
- `logger.ts` の `formatSurface`（T192）
- `taskTitle` の ConductorState 保持（dashboard / team.json / statusline 用）
- `CMUX_NO_RENAME_TAB` 環境変数

## 未実施（スコープ外）

- §5-3 E2E 目視動作確認（ユーザー実施想定）
- CHANGELOG / README 等のドキュメント同期（別タスク）
