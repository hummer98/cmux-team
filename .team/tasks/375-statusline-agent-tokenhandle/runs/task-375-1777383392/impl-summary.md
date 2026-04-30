# T375 実装サマリ — statusline に agent の tokenHandle を表示

## 変更ファイル

- `skills/cmux-team/manager/statusline.ts`
  - `StatuslineConductor.agents` 要素型に `tokenHandle?: string` を追加
  - `StatuslineRole`(kind: agent) の `agent` 型にも `tokenHandle?: string` を追加
  - `renderAgent` で末尾に `${dim}|${reset} @<handle>` セグメントを追加（taskId 有無の両分岐に共通の `handleSeg` を後付け）
  - `tokenHandle` 未設定時は空文字なので既存出力と完全一致（後方互換）
- `skills/cmux-team/manager/statusline.test.ts`
  - 4 ケース追加（指示は 3 ケースだが、NF on/off の両軸を担保するため NF on/Color on のケースを別出し）

## 追加テスト

`describe("formatStatusline - agent tokenHandle (T375)")`

1. `tokenHandle あり / NF off — \`@pers\` が末尾セグメントとして出る`
   - 期待: `▸ implementer | T042 | ctx 42% | @pers`
2. `tokenHandle あり / NF on / Color on — dim 区切り + \`@pers\``
   - 末尾が `@pers` で終わり、直前が `\x1b[2m|\x1b[0m` (dim 区切り) であることを確認
3. `tokenHandle なし — 既存出力と完全一致（後方互換）`
   - 期待: `▸ researcher | T042 | ctx 42%`（既存スナップショットと bit 一致）
4. `conductor.taskId なし + tokenHandle あり — タスクなし表示でも \`@pers\` が出る`
   - 期待: `▸ implementer | ctx 42% | @pers`

## 完了条件チェック

- `bun test --timeout 30000 statusline.test.ts`: **47 pass / 0 fail**（既存 43 + 新規 4）
- `bunx tsc --noEmit | grep statusline`: **no statusline errors**
- 後方互換: `tokenHandle` 未指定で既存スナップショット完全一致をテストで担保

## 備考

- proxy.ts は `formatStatusline` に `...rawState` をスプレッドで渡しており、daemon の `state.conductors[].agents[].tokenHandle` はそのまま流れてくる。statusline 側のレンダリング追加だけで動作する想定（タスク本文の通り）。
- 区切りに `${dim}|${reset}` を使ったのは既存セグメント区切りと同一形式に揃えるため。color OFF 時は `dim`/`reset` が空文字になるので `▸ implementer | T042 | ctx 42% | @pers` と等幅で出る。
- NF on/off で agent セクションの差分は icon (`▸` vs `` ）のみで、追加した tokenHandle セグメントは NF 非依存（`@<handle>` 文字列のみ）。
- スコープ外（master/conductor 表示・pool util 等）は触っていない。
- commit / merge は Conductor が行うため未実施。
