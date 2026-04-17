# Plan: close-agent コマンド追加と status 分離

## 事前調査結果

### S1. cmdKillAgent の構造（main.ts:2111-2133）

- **関数シグネチャ**: `async function cmdKillAgent(): Promise<void>`
- **コピー対象範囲**: `main.ts:2111-2133`（23 行、関数まるごと）
- **関数本体**:
  ```ts
  async function cmdKillAgent(): Promise<void> {
    if (hasHelpFlag()) showHelp(t("help_kill_agent"));
    let surface: string;
    try {
      surface = await normalizeSurfaceArg(requireArg("surface"));
    } catch (e: any) {
      console.error(`Error: ${e?.message ?? e}`);
      process.exit(1);
    }

    // surface を閉じる（closeSurface は SESSION_ENDED を送信しないため、明示的に通知する）
    await cmux.closeSurface(surface);

    // daemon に SESSION_ENDED を通知して agents リストから削除させる
    await postMessage({
      type: "SESSION_ENDED",
      surface,
      reason: "kill-agent",
      timestamp: new Date().toISOString(),
    });

    console.log(`OK killed ${surface}`);
  }
  ```
- **cmdCloseAgent としての変更点**:
  - 関数名: `cmdKillAgent` → `cmdCloseAgent`
  - `t("help_kill_agent")` → `t("help_close_agent")`
  - `reason: "kill-agent"` → `reason: "close-agent"`
  - 末尾出力: `OK killed ${surface}` → `OK closed ${surface}`
- **switch case の追加位置**: `main.ts:3674-3676` の `case "kill-agent":` 直後に
  ```ts
  case "close-agent":
    await cmdCloseAgent();
    break;
  ```
  を追加する（指示の `main.ts:3618` は実コードでは `3674` にずれている — タスク本文の行番号は古い）。
- **冒頭コメントの usage 例**: `main.ts:15` の `kill-agent` 行の直下に `./main.ts close-agent --surface <s>` を追記する。

### S2. daemon.ts の該当箇所（daemon.ts:975-1037、書き換え対象は 1014-1035 のループ内）

- **現在の実装**（`daemon.ts:1014-1035`）:
  ```ts
  // Agent surface かチェック (T181: done マーカーを書き出す)
  for (const c of state.conductors.values()) {
    const idx = c.agents.findIndex(a => a.surface === message.surface);
    if (idx !== -1) {
      const agent = c.agents[idx]!;
      try {
        await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
          status: "crashed",
          reason: message.reason ?? "session_end",
        });
      } catch (e: any) {
        await log("error", `writeAgentDone failed (session_ended): ${e.message}`);
      }
      c.agents.splice(idx, 1);
      notifyStateChanged("daemon.ts:handleMessage:session-ended-agent");
      await log(
        "agent_done",
        `${formatPair(c.surface, message.surface, "C", "A")} trigger=session_ended status=crashed`
      );
      break;
    }
  }
  ```
- **置換後**:
  ```ts
  // Agent surface かチェック (T181: done マーカーを書き出す)
  for (const c of state.conductors.values()) {
    const idx = c.agents.findIndex(a => a.surface === message.surface);
    if (idx !== -1) {
      const agent = c.agents[idx]!;
      // T231: close-agent は正常完了、それ以外（kill-agent, session_end 等）は crashed
      const agentStatus = message.reason === "close-agent" ? "completed" : "crashed";
      try {
        await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
          status: agentStatus,
          reason: message.reason ?? "session_end",
        });
      } catch (e: any) {
        await log("error", `writeAgentDone failed (session_ended): ${e.message}`);
      }
      c.agents.splice(idx, 1);
      notifyStateChanged("daemon.ts:handleMessage:session-ended-agent");
      await log(
        "agent_done",
        `${formatPair(c.surface, message.surface, "C", "A")} trigger=session_ended status=${agentStatus}`
      );
      break;
    }
  }
  ```
- **影響範囲確認**: `writeAgentDone` を呼ぶ他の箇所（daemon.ts:1158, 1210, 1521）はそれぞれ session_idle / session_ask / pid_watcher で、status は別途設定されているため今回は変更不要。

### S3. schema.ts の reason 型

- **現在の定義**（`schema.ts:49-55`）:
  ```ts
  export const SessionEndedMessage = z.object({
    type: z.literal("SESSION_ENDED"),
    surface: z.string(),
    pid: z.number().optional(),
    reason: z.string().optional(),
    timestamp: z.string().datetime(),
  });
  ```
- **追加方法**: `reason` は **`z.string().optional()` のままで `"close-agent"` 文字列を受け付ける**。union 型（`z.enum`）にはなっていないため、schema レベルでの新規追加は不要。
  - タスク本文 S5 では「reason の union 型に `"close-agent"` を追加」とあるが、現状 union ではないため schema 変更は実質ゼロ。
  - 念のためコメントで「reason には close-agent / kill-agent / session_end / other 等が入る」旨を 1 行記述するに留める（任意。なくても動く）。
- **判断**: schema 変更はコメント追加のみ、または完全省略でよい。型レベルでは破壊的変更ゼロ。

### S4. テンプレート該当行

| ファイル | 行 | 用途 | 置換 |
|---------|----|----|----|
| `templates/ja/conductor-role.md:329` | 完了処理ステップ 2「Agent のタブを閉じる」 | 正常完了 | `kill-agent` → `close-agent` |
| `templates/en/conductor-role.md:281` | Step 2 "Close Agent tabs" | 正常完了 | `kill-agent` → `close-agent` |
| `templates/ja/conductor-role.md:489` | やらないこと（禁止事項）の説明文 | 説明 | 「Agent の終了は `cmux-team kill-agent` を使う」→「Agent の正常終了は `cmux-team close-agent`、強制終了は `cmux-team kill-agent` を使う」 |
| `templates/en/conductor-role.md:441` | What NOT to Do の説明文 | 説明 | "stop them with `cmux-team kill-agent`" → "close them normally with `cmux-team close-agent`, force-stop with `cmux-team kill-agent`" |
| `templates/ja/conductor.md:215` | Reviewer 確認後にタブを閉じる | 正常完了 | `kill-agent` → `close-agent` |
| `templates/ja/conductor.md:227` | 完了時 Agent タブを閉じる | 正常完了 | `kill-agent` → `close-agent` |
| `templates/en/conductor.md:215` | Close the Reviewer tab | 正常完了 | `kill-agent` → `close-agent` |
| `templates/en/conductor.md:227` | Close Agent tabs（完了処理） | 正常完了 | `kill-agent` → `close-agent` |

**注**: タスク本文 S3 の「ja/conductor-role.md:329（await-agent 後の通常終了）」は実際には完了処理ステップ 2 で文脈的に「Inspection で GO 判定済み → Agent タブを閉じる」の正常完了パスである。await-agent 自体の参照は近隣行にはないが、文脈上「正常完了後の終了」で間違いないため close-agent への置換が適切。

### S5. i18n.ts への help 追加（タスク本文未記載だが必須）

- `i18n.ts:234-245`（en `help_kill_agent`）の直下に `help_close_agent` を追加（"close (normal exit)" のニュアンス）
- `i18n.ts:782-793`（ja `help_kill_agent`）の直下に同じく `help_close_agent` を追加（「Agent を正常終了」）
- `i18n.ts:553`（en help summary）に `cmux-team close-agent --surface <surface>    close an agent (normal exit)` を `kill-agent` 行の直前に追加
- `i18n.ts:1102`（ja help summary）に `cmux-team close-agent --surface <surface>    Agent を正常終了` を `kill-agent` 行の直前に追加

### S6. 型チェック

- 実行コマンド: `cd skills/cmux-team/manager && bunx tsc --noEmit`
- worktree パス: `/Users/yamamoto/git/cmux-team/.worktrees/task-231-1776377956/skills/cmux-team/manager`
- 期待: エラーゼロ

## 実装手順

依存順序を考慮した実行順:

1. **S1: main.ts に cmdCloseAgent 追加**
   - `cmdKillAgent`（main.ts:2111-2133）の直下に `cmdCloseAgent` をコピー＋差分適用
   - 冒頭 usage コメント（main.ts:15 付近）に `close-agent` 行を追加
   - switch 文（main.ts:3674 付近）に `case "close-agent":` を追加
2. **S5 (i18n)**: `i18n.ts` の en/ja 両方に `help_close_agent` を追加し、help summary（en:553 / ja:1102）にも `close-agent` 行を追加
   - **注**: S1 で `t("help_close_agent")` を参照しているため、i18n 側の追加が無いと TypeScript エラーになる可能性がある。よって S1 の `bunx tsc` 単独実行前に S5 を済ませる
3. **S2: daemon.ts の status 分岐**
   - daemon.ts:1014-1035 の Agent ループ内 `writeAgentDone` 呼び出しに `agentStatus` 三項演算を追加
   - `agent_done` ログも `status=${agentStatus}` で動的化
4. **S3: schema.ts**
   - 実質変更なし。コメント追記のみ（任意）。skip 可能
5. **S4: テンプレート 4 ファイル更新（ja/en × conductor.md/conductor-role.md）**
   - 完了処理パス（正常終了）の `kill-agent` → `close-agent` に置換（ja:329/489, en:281/441, ja:215/227, en:215/227）
   - 禁止事項の説明文は単純置換ではなく文面リライト（kill-agent と close-agent の使い分けを明記）
6. **S6: 型チェック**
   - `cd skills/cmux-team/manager && bunx tsc --noEmit`
   - エラーゼロを確認

## リスク・懸念事項

- **行番号のずれ**: タスク本文記載の `main.ts:2055`（実際は 2111）と `main.ts:3618`（実際は 3674）は古い。実装者は本 plan に記載の最新行番号を参照すること。daemon.ts:1000 も実際の置換対象は 1014-1035 のループ内であり、行先頭の数字より文脈での特定が確実。
- **schema.ts の union 型は存在しない**: タスク本文 S5「reason の union 型に追加」は誤認。`z.string().optional()` は任意文字列を受け付けるため schema 変更不要。実装者がここで時間を使わないよう注意。
- **i18n の help_close_agent 追加が必須**: タスク本文 S1 に「help 文字列追加（i18n）」とあるが、S1 のサブステップとして見落とされやすい。`t("help_close_agent")` を参照する以上、i18n.ts への追加は型レベルでは直接エラーにならない（`t()` の戻り値は any/string 系の場合が多い）が、`/help` 表示が空になるため必須。
- **テンプレート禁止事項の文面**: ja:489 / en:441 は「Agent の終了は `cmux-team kill-agent` を使う」と明記しているため単純置換ではなく「正常終了は close-agent、強制終了は kill-agent」と書き分ける必要がある。dockeeper 系テンプレや SKILL.md にも同様の記述がないか念のため確認すると安全。
- **後方互換**: `kill-agent` 経路は **何も変更しない**。reason="kill-agent" は引き続き crashed として記録される。この不変条件は受け入れ条件で明示されている。
- **SESSION_ENDED の reason="other" は早期 return**: `daemon.ts:979-985` で `reason === "other"` は state 遷移なしで record-only。`close-agent` は `reason==="other"` ではないため、この分岐の影響は受けない。
- **既存ランタイムプロンプトへの影響**: テンプレート編集後、CLAUDE.md の「プロンプト編集ルール」に従い `.team/prompts/*.md`（特に conductor-role.md）への反映は実装外（実装者は触らない）。リリース時に通常の運用フローで再生成される。
- **trace_session の event ラベル**: 既存の `agent_done` ログ表記（`status=crashed` / `status=completed`）以外に trace DB に書く箇所が見つからなかったため副次的な変更なし。`writeAgentDone` 経由の done ファイル content は status フィールドを正しく書き分ける（既に対応済み）。

## 受け入れ条件チェックリスト

- [ ] cmux-team close-agent --surface <s> が動作する（main.ts に cmdCloseAgent + switch case 追加）
- [ ] 正常完了 → agent_done status=completed（daemon.ts の三項分岐 + writeAgentDone の status="completed"）
- [ ] kill-agent → agent_done status=crashed（既存動作維持、reason="kill-agent" 経路は変更なし）
- [ ] テンプレート更新完了（ja/en × conductor.md/conductor-role.md の正常完了パスを close-agent に置換、禁止事項を書き分け）
- [ ] i18n.ts に help_close_agent 追加 + help summary に行追加（en/ja 両方）
- [ ] cmdCloseAgent の `OK closed ${surface}` 出力が kill 用と区別できる
- [ ] bunx tsc --noEmit でエラーゼロ
