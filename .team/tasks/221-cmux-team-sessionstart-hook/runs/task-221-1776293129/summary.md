# T221 cmux-team プラグインの SessionStart hook を削除 — 完了サマリー

## 変更内容

`.claude-plugin/plugin.json` から `hooks.SessionStart` ブロックのみを削除。

### 削除理由

Master spawn 時、このフックが条件 `[ -z "$CMUX_SURFACE" ]` で発火し、タブ名を `[NUM] Claude Code` に上書きしていた。daemon 側の `master.ts:29` にある `renameTab(surface, "[NUM] Master")` がフックによって上書きされて効かなくなるバグの原因。

- `cmdLaunchMaster` は `CMUX_SURFACE` を env に設定していないため条件が真になり発火していた
- Conductor / Agent は `CMUX_SURFACE` を設定しているので発火していなかった（Master だけタブ名が "Claude Code" になっていた）
- `using-cmux` プラグインにも同等のフックが `$CMUX_NO_RENAME_TAB` で skip される設計で存在しており、cmux-team 側の役目は重複
- `master.ts:29` の daemon 側 rename はそのまま残るため、フックさえ削除すれば Master タブが正しく `[NUM] Master` になる

### 保持したもの

`hooks.PreToolUse` はそのまま残した（別機能: `.team/team.json` / `.team/task-state.json` への直接編集をガードするフック）。

## 変更ファイル

- `.claude-plugin/plugin.json` — SessionStart ブロック削除（PreToolUse は維持）
- `package-lock.json` — bootstrap (`npm install`) による version 同期 (3.48.0 → 3.49.0)、無害な差分

## テスト結果

- `jq '.hooks.SessionStart // "removed"'` → `"removed"` ✅
- `jq '.hooks.PreToolUse | length'` → `1` ✅
- `cat plugin.json | jq .` → valid JSON ✅

## 納品

ローカルマージ（main ブランチへ）。フロー分岐: 軽微レベル（Phase 3 Implementer のみ）。

## マージコミット

- feature: `07e4f7f` fix: T221 .claude-plugin/plugin.json から SessionStart hook を削除
- merge: `c335daf` Merge branch 'task-221-1776293129/task' (T221 SessionStart hook 削除)
