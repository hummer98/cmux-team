# Design Review

Verdict: Approved (with recommendations)

## Summary

全体として設計は妥当で、実装に着手可能。trace DB を検証ソースから外し `team.json` を採用した判断、hook 正規表現の境界条件、out-of-scope の線引きはどれも合理的。ただし (a) `team.json` 反映ラグへの race condition 対策、(b) 自己送信時のエラーメッセージ品質、(c) hook の JSON パース堅牢性 の 3 点で実装前に明確化しておきたい箇所がある。いずれも軽微で、ブロッカーではない。

## Strengths

1. **検証ソース選定が正しい (§2.3–2.4)**
   - `trace-store.ts` の `task_sessions` に `conductor_surface` 列が無いことを自分でソース確認している。DB マイグレーションを回避し `team.json` を真のソースにした判断は、運用リスク / 同期タイムラグ / 履歴 vs runtime の役割分離の観点で適切。
   - 「trace DB は履歴索引、team.json は runtime の真のソース」という役割分離を明文化している点が良い。

2. **hook 正規表現の設計が task-167 と整合 (§3.1)**
   - `(^|[^-[:alnum:]_])cmux[[:space:]]+(send|send-key)([[:space:]]|$)` の境界条件で `cmux-team`, `sender`, `cmuxsend` が正しく除外される。表形式で誤検知/誤通過パターンを列挙しているため、テストケースへの落とし込みも容易。

3. **検証の二重化 (§3.2.2)**
   - `team.json` 検証に加え、送信直前に `cmux.validateSurface(targetSurface, workspace)` を呼ぶ設計。`team.json` と cmux 実態のズレ (Agent が手動で閉じられた場合等) もキャッチできる。

4. **workspace 明示渡し (§3.2.3)**
   - CLAUDE.md「cmux API 使用上の注意」に従って `workspace` を必ず渡している。複数ワークスペース起動時の surface 混同を回避。

5. **ログ設計がロギングポリシー準拠 (§3.4)**
   - `send_agent_started` / `send_agent_rejected` / `send_agent_completed` の粒度、stderr を error に含める規約、メッセージ本文を bytes に留める秘密情報回避、いずれもロギングポリシーに沿っている。

6. **out-of-scope の線引きが明確 (§7)**
   - 「trace DB スキーマ変更は却下」「他プロジェクトの `.team/prompts/` はテンプレ側だけ」など、拡張するか迷う項目を明示的に棄却理由付きで切っている。

## Concerns

### C1. `team.json` 反映ラグによる false reject の可能性 (§5 表 行 5)

計画書自身が懸念として挙げているが、対策が「Conductor 側で spawn-agent の stdout を読んだ後 1 秒待ってから send-agent を呼ぶガイドを conductor-role.md に添える」に留まっている。

- `AGENT_SPAWNED` postMessage は spawn-agent プロセス内で送信され、daemon queue 処理 → ファイル反映までラグがある。1 秒待っても反映保証はない(ポーリング 10 秒間隔の場合さらに遅れる)。
- Conductor が直後に送信しても agents に未反映だと `Error: surface ... は Agent ではありません` で落ちる。これを「ドキュメントに書いてユーザー責任」にするのは UX として弱い。

**影響度**: 中 — 実運用で Conductor が「spawn-agent 直後の初期指示」を送るユースケースは頻度が高い。実装段階で気づかず E2E で再発する懸念。

### C2. 自己送信チェックが「任意」扱い (§3.2.2)

> `callerSurface === targetSurface`(自己送信): Conductor 一覧に Agent として自分は登録されないため `agent not found` で自然に弾ける。さらに明示チェックを冒頭に入れて親切なメッセージにしてもよい。

「〜してもよい」ではなく **必須** にすべき。

- 同じ `agent not found` エラーで弾かれると、Claude は「team.json が古い / Agent が死んだ」と誤解して再試行ループに入る可能性がある。
- 自己送信は issue #22 の「自分自身への再プロンプト送信」が発端なので、最も警戒すべき誤用ケース。明確な reject メッセージが必要。

### C3. hook の JSON パース堅牢性 (§3.1 / §5 表 行 3)

grep で `"command"` の最初の出現を抜き出す設計だが、PreToolUse payload の実構造を確認していない。

- payload は Claude Code が `{"tool_name":"Bash","tool_input":{"command":"..."}}` 形式で渡す。`"command"` キーは `tool_input` 配下にしか出ないため現行 grep で動くはずだが、今後のペイロードスキーマ変更 (e.g. `"tool_input":{"description":"...","command":"..."}`) で `head -1` が `description` を拾うリスクはゼロではない。
- `"command"` の前に `"` を含む別フィールド値があった場合 (例: `"description":"run \"ls\""`) に正規表現の `[^"]*` が早く打ち切られる可能性がある。テスト §4.2 にこの形のペイロードが含まれていない。

**影響度**: 低〜中 — 実害に至る確率は低いが、task-167 の hook も同じパターンで採用済みなので、このタスクで検証ケースを追加しておくと将来の hook 群全体の保険になる。

### C4. エラーメッセージに使用例が無い (§3.1)

```
cmux send / cmux send-key は Conductor から使用禁止です。Agent へのメッセージ送信は cmux-team send-agent を使ってください。
```

- 「使ってください」で終わっており、どの引数が必要か (`--surface <s> <message>`)、どの surface に送れるか (自分が spawn した Agent のみ) が伝わらない。
- Claude は hook stderr を頼りに次手を決めるため、1 行で代替コマンドを示すだけで試行錯誤が大きく減る。

### C5. テスト §4.3 のセルフ送信ケースの扱い

| 期待結果の書き方 |
|---|
| `caller が Conductor、target == caller` | `reject(self)` |

C2 の対応とセットで、「reject 理由が `not_conductor` / `agent_not_found` / `self_send` の 3 通りに区別できる」ことを assertion に含めるべき。同じ reject でも理由別にメッセージを分けないと後から切り分けできない。

### C6. Master への hook 展開を「out of scope」にする妥当性 (§7)

- Agent は Claude Code 上で `cmux` コマンドを叩く機会がそもそも稀なので hook なしでも実害は小さい。
- 一方 **Master** は Conductor に直接プロンプトを送る誤用パターンが考えうる(Manager 経由を忘れるなど)。現状 out-of-scope としつつ、追跡用の issue 番号を CHANGELOG か `docs/spec/06-implementation-tasks.md` に記載した方が忘れにくい。

### C7. 再起動必要性の周知 (§5 表 行 1)

> 既存 Conductor は起動時の settings.json を読み込むため hook は **再起動後** に効果が出る。

- CHANGELOG への記載だけだと、ユーザーが plugin 更新後に「効いていない」と感じる可能性。
- `cmux-team start` 実行時に「既存の Conductor が残っている場合は `cmux-team stop` → `start` を推奨」の旨を stdout に出力する軽い改善を検討しても良い(別 PR 可)。

## Recommendations

優先度順:

### R1 (必須). 自己送信を明示チェック + 理由別 reject メッセージ

`cmdSendAgent` の検証ロジック冒頭に以下を追加:

```ts
if (callerSurface === targetSurface) {
  console.error(`Error: 自分自身 (${callerSurface}) には送信できません。cmux-team send-agent は自分が spawn した Agent 宛のみ使用可能です。`);
  log("send_agent_rejected", `caller=${callerSurface} target=${targetSurface} reason=self_send`);
  process.exit(1);
}
```

テスト §4.3 の assertion も reason 区別を含める。

### R2 (必須). `team.json` 反映ラグへの retry ループ

`validateSendAgentTarget` を 200ms × 最大 5 回リトライするラッパーで呼ぶ(合計 1 秒)。

```ts
async function waitForAgentRegistered(
  teamJsonPath: string,
  caller: string,
  target: string,
  maxRetries = 5,
  intervalMs = 200,
): Promise<{ ok: boolean; reason?: string }> {
  for (let i = 0; i < maxRetries; i++) {
    const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
    const result = validateSendAgentTarget(teamJson, caller, target);
    if (result.ok || result.reason !== "agent_not_found") return result;
    await sleep(intervalMs);
  }
  return { ok: false, reason: "agent_not_found_after_retry" };
}
```

- `agent_not_found` のときのみリトライ(他の reject 理由は恒久的なのでリトライ無意味)。
- spawn-agent 直後の race を吸収しつつ、本当に存在しない surface は最大 1 秒で確定的に reject。
- conductor-role.md の「1 秒待ってから send-agent」ガイドは維持しても良いが、retry があれば必須ではなくなる。

### R3 (必須). エラーメッセージに使用例を追加

hook の stderr 出力を 2 行構成に:

```
cmux send / cmux send-key は Conductor から使用禁止です。
代替: cmux-team send-agent --surface <agent-surface> <message>  (自分が spawn した Agent のみ送信可)
```

複数行化で stderr サイズが増えるがごく僅か。テスト §4.2 も 2 行目の存在を assert する。

### R4 (推奨). テスト §4.2 に変則ペイロードを追加

`tool_input` に複数フィールド + エスケープ文字を混在させたケース:

| 入力 tool_input 内容 | 期待 exit |
|---|---|
| `{"description":"run cmux send example","command":"ls"}` | 0 (description に `cmux send` を含むが command が ls) |
| `{"command":"git log --grep=\"cmux send\""}` | 2 (誤検知、許容) — 既存の「埋め込み文字列」扱いを確認 |

現行 grep が `"command"` を正しく特定できるか、実ペイロードで検証。

### R5 (推奨). Master への hook 展開を後続 issue として issue 化

「Master / Agent にも同 hook を展開するか」は別タスクとして GitHub issue 化する (#21, #22 のフォロー)。out-of-scope のまま放置すると忘却される懸念。CHANGELOG か `06-implementation-tasks.md` に「予定タスク」として記録するだけでも良い。

### R6 (任意). `cmux-team start` での再起動案内

`cmdStart` で既存 daemon を検出した際、「Conductor の hook 設定が更新されている可能性があります。反映するには `cmux-team stop` → `start` を推奨」的な 1 行メッセージを出す。別 PR 可。

### R7 (任意). `log_*` イベント名の統一

`send_agent_started` / `send_agent_rejected` / `send_agent_completed` は良いが、他の hook 系と揃えるなら `send_agent_failed` (検証失敗/実行失敗を合流) という選択肢もあり。ロギングポリシーの `*_failed` パターンと整合。ただし reason 情報を明示できる `rejected` も悪くないので、Impl の判断でよい。

---

## 実装順の提案

1. **R1, R3** を先に入れた上で hook 追加 + send-agent CLI 実装 (§3.1, §3.2)
2. §4.1, §4.2, §4.3 テスト実装 (R4 のケース含む)
3. **R2** の retry ループを send-agent CLI に組み込む
4. templates/conductor-role.md 更新 (§3.3)
5. CHANGELOG / コミット (§6.3, §6.4)
6. **R5** を issue として別 PR

plan の §6.4 で分割コミットを提案しているが、R1–R4 を含めても全体変更量は小さいため単一コミット `feat(conductor): block cmux send/send-key hook + add send-agent CLI (#21, #22)` で十分。
