# Design Review: T210 plan.md

## 判定: Approved

## 総評

plan.md は全参照箇所の行番号・コンテキストを現行 worktree と突き合わせて正確に把握しており、2 コミット分割（C1: Producer 側 / C2: Consumer 側）の戦略も妥当。zod の extra-key strip（デフォルト挙動）に依存した前方互換の判断は schema.ts を読んで確認した通り正しく、旧 hook からの `conductorId` フィールドは silently strip されるため C2 後も壊れない。`{{CONDUCTOR_ID}}` テンプレート変数（`template.ts:114` で `taskRunId` に置換）と環境変数 `CONDUCTOR_ID` を明確に区別しており、誤置換リスクの緩和策（§R3）も十分。

指摘は Minor のみで、Implementer に渡して問題ないレベル。

## 正しいと確認した点

- **schema の extra-key 挙動**: `schema.ts:76-103` で `SessionAskMessage` / `SessionStopMessage` / `SessionClearMessage` はいずれも `z.object({...})` のみで `.strict()` / `.passthrough()` なし。zod v3 のデフォルトは strip なので、旧 hook の `conductorId: ""` は parse 時に単に除去される。C1/C2 分割の安全性は成立。
- **行番号と参照箇所の一致（現行 worktree と完全一致）**:
  - `main.ts:1306` SessionEnd(clear) の `--conductor-id "$CONDUCTOR_ID"` ✓
  - `main.ts:1314` SessionEnd(logout|prompt_input_exit) の `--conductor-id "$CONDUCTOR_ID"` ✓
  - `main.ts:1134, 1140, 1142` DETECT_ASK_SCRIPT 内の `CONDUCTOR_ID=` 行・printf フォーマット・jq 合成 ✓
  - `main.ts:1370` cmdConductor の `process.env.CONDUCTOR_ID = surface` ✓
  - `main.ts:1455` cmdResume の同一設定 ✓
  - `main.ts:779-784` 空文字正規化コメントと `if (o.conductorId === "") o.conductorId = undefined` ✓
  - `main.ts:929, 939` SESSION_ASK / SESSION_CLEAR case の `conductorId: getArg("conductor-id")` ✓
  - `schema.ts:81, 89, 100` SessionAskMessage / SessionStopMessage / SessionClearMessage の `conductorId: z.string().optional()` ✓
  - `daemon.ts:972` SESSION_STOP → SESSION_ASK 合成時の `conductorId: message.conductorId` ✓
  - `statusline.sh:92` `${CONDUCTOR_ID:-}` jq arg ✓
  - `i18n.ts:153, 673` SESSION_CLEAR ヘルプの `--conductor-id <id>` ✓
- **`{{CONDUCTOR_ID}}` は別概念**: `template.ts:114` で `taskRunId` に置換されるテンプレート変数であり、環境変数 `CONDUCTOR_ID` と無関係。`skills/cmux-team/templates/ja/conductor.md:239,245,261` `ja/conductor-task.md:15` `en/conductor.md:239,245,261` `en/conductor-task.md:15` の 8 箇所はすべて `git merge {{CONDUCTOR_ID}}/task` 等のブランチ名プレースホルダー。触ってはならない。plan.md §3.6 と §R3 で明記済み。
- **proxy.ts の HTTP ヘッダー `x-cmux-conductor-id` は別スコープ**: `proxy.ts:241` でのみ参照され、ローカル変数は既に `conductorSurface` と命名されている。送信側（client）を確認したが manager 配下には setter が存在しない（事実上のデッドコード or 外部から注入）。T210 で触ると trace DB 互換性に波及するため分離判断は妥当。
- **テスト L910-922 は現状で SessionStart hook の `--conductor-id` 不在を verifying しているだけ**で、SessionEnd 系は未検証。plan.md §4.2 の 3 テスト追加（clear / logout / DETECT_ASK_SCRIPT）でカバレッジが埋まる。

## 指摘事項

### Critical（Changes Requested の根拠になる項目）

なし。

### Major（修正が望ましい）

- **SESSION_ENDED hook の `--conductor-id` は既に dead arg である点を明記すべき**  
  `cmdSend` の `SESSION_ENDED` case（`main.ts:896-904`）は `getArg("conductor-id")` を呼ばず、`SessionEndedMessage` schema（`schema.ts:48-54`）にも `conductorId` フィールドが無い。よって `main.ts:1314` の `--conductor-id "$CONDUCTOR_ID"` は **今の時点で既に誰にも読まれず silently drop されている**。C1 で削除するのは正しいが、plan.md §3.1 変更 A ではこの事実に触れていない。Implementer の混乱防止のため「SESSION_ENDED 側は schema にも CLI parser にも conductorId が無いため、hook の `--conductor-id` は現状 dead arg。削除しても message payload は変わらない」を §3.1 or §R1 に 1 行追記するのが親切。

### Minor（任意）

- **plan.md §5-3 の grep 期待値コメントが §7 DoD と微妙に不一致**  
  §5-3 は「`conductor-id` は i18n の help / proxy.ts の x-cmux-conductor-id 以外 0 件」と書いているが、C2 で i18n help 行（`i18n.ts:153, 673`）も削除するため、**C2 完了後は `proxy.ts:241` の 1 件のみ**が正しい。§7 DoD は既にこの通り書いているので、§5-3 の文言だけ統一すれば OK。

- **R2 (defensive `CMUX_SURFACE` 明示 export) の発動条件を明示すべき**  
  `resolveCallerSurfaceOrExit()`（`main.ts:1340`）は `process.env.CMUX_SURFACE` を読み、未設定時のみ `cmux.getCallerSurface()` にフォールバックする。通常経路（cmux ペインから `cmux-team conductor` 起動）ではすでに env が継承されており、子プロセス（claude → statusline.sh）にも自動伝播する。`process.env.CMUX_SURFACE = surface` の明示設定は **identify フォールバック経路でのみ意味がある**。plan.md はこれを「defensive / idempotent」と呼んでいるが、「通常経路では no-op、fallback 経路でのみ statusline が壊れないための保険」という意図を 1 行追加すると Implementer が理由を理解しやすい。なお、追加自体は安全かつ小さいので強く推奨。

- **plan.md §4.1 の L852-867 テスト**の `conductorId: ""` 削除は良いが、このテストの本来の意図は「T189 forwarder 互換 — `--from-stdin` + type 引数なしで旧 QueueMessage パスに落ちる」の回帰検証。`conductorId: ""` を消す代わりに「余分な legacy フィールドが来ても無視される」ことを示す別の無害キー（例: `legacyField: "ignored"`）を入れて SESSION_STOP のルーティングテストとしての性格を維持する方が回帰保護が厚い。削除だけでも機能的には OK なので Minor。

- **タスク本文（`conductor-prompt.md`）の schema 名が古い**  
  タスク本文は `SessionClearedMessage` / `SessionEndedMessage` / `SessionStopMessage` と書いているが、実際の schema 名は `SessionAskMessage` / `SessionStopMessage` / `SessionClearMessage`（`SessionEndedMessage` には `conductorId` フィールドが無い）。plan.md は正しい名前を使っているので実装上は問題ないが、Implementer が両ドキュメントを突き合わせて混乱しないよう、plan.md §1 or §3.2 冒頭で「タスク本文の `SessionClearedMessage` は `SessionClearMessage` / `SessionEndedMessage` は該当なし（`SessionAskMessage` が正しい対象）」と 1 行補足してもよい。

- **DoD の手動確認項目 §5-4 は worktree 内での確認が困難**  
  plan.md 自身が「現状、npm global 版を差し替えずに worktree の Bun 実装を直接動かす手段はない」と記載しており、オプショナル扱い。これで OK だが、代替として `bun test` + §5-5 の JSON 直接流し込みで十分な検証粒度が得られていることを DoD §7 で明記するとレビュアーが安心できる（既に "（任意）実 Conductor セッションで..." と書いているので実質 OK）。

## Recommendations

Approved のため Planner に戻す必要はない。そのまま Implementer に渡して問題ない。Implementer に引き継ぐ際、以下 2 点を口頭 or 補足で伝えると実装がスムーズ:

1. **SESSION_ENDED hook の `--conductor-id` は既に dead arg** — 削除しても挙動変化なし。テスト追加（`T210: Conductor SessionEnd(logout|prompt_input_exit) hook は --conductor-id を含まない`）は「将来にわたり dead arg を復活させない」ための guard として機能する、と位置付ける。
2. **R2 の `process.env.CMUX_SURFACE = surface` 追加は `cmux identify` フォールバック経路のためだけの保険** — 通常経路では no-op。削る判断もあり得るが、plan.md の「defensive」通り追加しておくのが安全。

Implementer への注意として plan.md §8 末尾にある「`{{CONDUCTOR_ID}}` プレースホルダには絶対に触らない」「grep は `skills/cmux-team/manager/` サブツリー限定」は必須級の警告なので、実装着手前に必ず読ませること。
