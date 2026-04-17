# タスク割り当て

## タスク内容

---
id: 206
title: cmdConductor/cmdResume の CMUX_SURFACE 必須撤廃 + --surface が UUID も受け付ける + conductor-settings.json を共通化
priority: medium
created_at: 2026-04-15T07:47:26.460Z
---

## タスク
## 背景

現状、`cmdConductor` / `cmdResume` は `CMUX_SURFACE` env var を必須としている。これは Manager が `export CMUX_SURFACE=surface:NNN` を手動注入している前提に依存していて、以下の問題を生む:

- 人間が手動デバッグで `cmux-team conductor` / `cmux-team resume` を叩けない（env なしで `Error: CMUX_SURFACE environment variable is required` で exit 1）
- cmux が自動注入する `CMUX_SURFACE_ID`（UUID）を活用していない

加えて、`cmux send --surface` は cmux native で **UUID と surface:NNN ref の両方を受け付ける**ことが判明した（`cmux --help` 参照）。cmux-team 側の CLI も同様に両対応すれば、scripting やデバッグの柔軟性が上がる。

さらに `generateConductorSettings(projectRoot, surface)` を精読すると、**surface 引数はファイル名 (`.team/prompts/surface:NNN-settings.json`) にしか使われておらず、ファイル内容は完全に surface 独立**（hook コマンドは `\${CMUX_SURFACE}` / `\$CONDUCTOR_ID` の shell 展開で処理）。N 個の同一ファイルを生成し続ける冗長性があり、共通ファイル 1 個に集約できる。

## やること

### 1. `cmdConductor` から `CMUX_SURFACE` 必須を撤廃

`skills/cmux-team/manager/main.ts:1189-1195` を以下のように変更:

```typescript
async function cmdConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_conductor", { model: DEFAULT_MODEL }));
  let surface = process.env.CMUX_SURFACE;
  if (!surface) {
    // cmux identify で自身の surface_ref を取得
    const id = await cmux.identify();
    surface = id?.caller?.surface_ref;
    if (!surface) {
      console.error("Error: cannot determine own surface (CMUX_SURFACE env unset and cmux identify returned no surface_ref)");
      process.exit(1);
    }
  }
  // 以降は従来通り
  ...
}
```

### 2. `cmdResume` から同様に撤廃

`skills/cmux-team/manager/main.ts:1276-1282` を上記と同じパターンで変更。

### 3. `--surface` CLI オプションが UUID / ref 両対応

対象コマンド: `send` / `send-key` / `await-agent` / `conductor` / `resume` / `spawn-agent` / `close-agent` 等、`--surface` を受け取る全 CLI。

正規化ヘルパを追加:

```typescript
/**
 * --surface 引数を team.json の primary key（surface:NNN 形式）に正規化する。
 * UUID 形式の入力を受け取った場合は cmux tree --id-format both で逆引きする。
 */
async function normalizeSurfaceArg(input: string): Promise<string> {
  if (/^surface:\d+$/.test(input)) return input;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    // UUID → surface:NNN 逆引き
    const tree = await cmux.tree({ idFormat: "both" });
    const found = findSurfaceRefByUuid(tree, input);
    if (!found) throw new Error(`surface UUID not found: ${input}`);
    return found;
  }
  throw new Error(`invalid --surface format: ${input}`);
}
```

- cmux CLI 側は `--surface` が UUID / ref どちらも受け付けるので、`cmux send` への pass-through 箇所は正規化不要（そのまま渡しても動く）
- ただし **cmux-team 内部で team.json / ConductorState の key lookup に使う箇所**（`findConductor(state, surface)` 等）は surface:NNN 形式に統一されているため、正規化してから lookup する必要がある
- 既存 `cmux.tree()` wrapper に `idFormat: "both"` オプションを追加（`cmux --id-format both tree` へ）

### 4. `generateConductorSettings` から surface 引数を削除、共通ファイル化

`skills/cmux-team/manager/main.ts:1114` を:

```typescript
export function generateConductorSettings(projectRoot: string): string {
  const conductorSettingsPath = join(projectRoot, ".team/prompts/conductor-settings.json");
  // ... 既存の hook 定義（surface に依存していない）
  writeFileSync(conductorSettingsPath, JSON.stringify(conductorSettings, null, 2));
  return conductorSettingsPath;
}
```

呼び出し箇所 (`main.ts:1240`, `main.ts:1325`) から `surface` 引数を除去。

### 5. リリースノートに full quit 推奨を明記

`CHANGELOG.md` に以下の旨を記載:

```
## BREAKING (soft)

このリリースで Conductor の settings ファイル配置が変わります
（`.team/prompts/surface:NNN-settings.json` → `.team/prompts/conductor-settings.json`）。

既存の Conductor Claude プロセスは古いパスを参照しているため、このリリースを適用後は
**cmux を full quit してから restart することを推奨します**:

1. `cmux-team stop` で daemon を止める
2. cmux app を full quit（Cmd+Q など）
3. cmux を起動
4. `cmux-team start` で新レイアウトを作成

古い `.team/prompts/surface:*-settings.json` ファイルは放置で問題ありません
（再起動後に参照されなくなります）。
```

## やらないこと

- state の primary key を UUID (`surfaceId`) に移行する（動機が薄く、コストに見合わない）
- `.team/conductors/surface_NNN/` ディレクトリの UUID 化（hook の done ファイル配置、ref のまま維持）
- resume 時の呼び出し元 surface と task owner の照合（起きないシナリオの防御、過剰）
- `ts.sessionId` / `/clear` 追従（T203 の担当範囲）
- aborted タスクからの resume / restart（T204 の担当範囲）
- 古い `.team/prompts/surface:*-settings.json` の自動クリーンアップ（full quit 後に放置で害なし）
- ログフォーマットの UUID 併記（現時点で動機が薄い）

## テスト計画

1. **手動デバッグ確認**
   - 任意の cmux terminal で `cmux-team conductor` を env なしで実行 → `cmux identify` から surface 解決して起動すること
   - 同様に `cmux-team resume <task-id>` が env なしで動くこと
   - `cmux-team send --surface surface:133 "test"` が従来通り動くこと
   - `cmux-team send --surface <uuid> "test"` も動くこと（正規化で surface:NNN に変換されて cmux.send に渡る）
   - 不正な形式 `cmux-team send --surface foo` がエラーになること

2. **E2E**
   - `cmux-team start` → `create-task` → `status` → `resume` → `stop` のフルサイクル
   - full quit → restart → `cmux-team start` で新 `conductor-settings.json` が生成され、Conductor が正常起動すること
   - update 前の `.team/prompts/surface:*-settings.json` が残っていても新起動に影響しないこと

3. **リグレッション**
   - `cmux-team await-agent --surface <uuid>` / `--surface <ref>` どちらも動作
   - spawn-agent / close-agent も両対応
   - 既存の hook (`SESSION_STARTED` / `SESSION_CLEAR` / `SESSION_ENDED`) が `conductor-settings.json` 経由で正常発火

## 参考ファイル

- `skills/cmux-team/manager/main.ts:1114-1182 generateConductorSettings` — surface 引数削除
- `skills/cmux-team/manager/main.ts:1189-1270 cmdConductor` — CMUX_SURFACE 必須撤廃
- `skills/cmux-team/manager/main.ts:1276-1343 cmdResume` — 同上
- `skills/cmux-team/manager/main.ts:1240, 1325` — generateConductorSettings 呼び出し箇所
- `skills/cmux-team/manager/cmux.ts` — identify / tree wrapper（`idFormat` オプション追加）
- `skills/cmux-team/manager/main.ts` の `--surface` を受け取る各コマンド — 正規化レイヤ挿入
- `CHANGELOG.md` — リリースノート

## 関連タスク

- T203: sessionId を SessionStart hook 経由で一元化（並行作業可能、衝突箇所は `generateConductorSettings` の hook 定義だが軽微）
- T204: restart-task を aborted から使えるようにする（無関係）
- T205: handleMessage 後に team.json を同期 flush（無関係）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-206-1776239539` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-206-1776239539
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-206-1776239539/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/206-cmdconductor-cmdresume-cmux-surface-surface-uuid-conductor-settings-json/runs/task-206-1776239539
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/206-cmdconductor-cmdresume-cmux-surface-surface-uuid-conductor-settings-json/runs/task-206-1776239539/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
