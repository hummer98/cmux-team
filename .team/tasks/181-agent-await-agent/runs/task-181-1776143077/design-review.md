# Design Review v2 — T181 plan.md

## Verdict: Approved

前回レビューで指摘した [Critical] 2 件と [Important] 4 件が、冒頭の「Review 対応履歴」だけでなく **本文の該当セクション** にも具体的かつ妥当な形で反映されている。[Suggestion] もほぼ全て取り込まれており、新規に生じた重大な副作用・矛盾も見当たらない。**実装着手可能。**

---

## Previous Issues — Status

### [Critical] 1 (TOCTOU race in cmdAwaitAgent): **Resolved**

- §8.4 の `cmdAwaitAgent` 実装が **watcher 先起動 → `handleDoneIfFresh()`** の 3 段構えに書き換わっている。
- `handleDoneIfFresh` が冪等で、watcher 起動前/後どちらの書き込みも拾える設計。race 窓が構造的に消えている。
- §12.1 でこの race 検証の unit テストを **必須** に昇格（temp dir で「watcher 前/後の書き込み」「古い timestamp の skip」3 シナリオ）。修正確認の担保として十分。
- `cmdAwaitTask` (main.ts:1947 付近) と同パターンを踏襲している点も保守性的に良い。

### [Critical] 2 (exit 75 handling in await-agent): **Resolved**

- §8.3 に「await-agent は Agent プロセス wait ではなく done ファイル fs.watch なので rate limit を直接受けず、exit 75 を返すケースは構造的に存在しない」と明記。根拠が明確。
- §10.2 に Agent 実行中の rate limit フローを 2 通り（`STATUS=timeout` で continue / `STATUS=crashed` で output 確認 → spawn-agent or send-agent で再開）に整理。memory「異常検知時のリカバリーは人間に委ねる」との整合性も取れている。
- §15 にも実装者向けコメントとして再度明示（cmdAwaitAgent 本文にも 1 行入れる指示あり）。

### [Important] 3 (Stop hook turn-boundary false completion): **Resolved**

- **方針 (a) + (b) の二重防御** を採用。前回レビューで求めた「どちらか必須」を超えた対応。
  - (a) §5.1 / §5.2 で `detect-ask.sh` に Case B（tool_use/tool_result を一切含まない純粋 text stop は exit 0 で無視、done を書かせない）を追加。Agent のみ適用し Conductor は従来通り。
  - (b) §10.3 で `STATUS=completed` 受信時の成果物再確認を Conductor テンプレに **必須化**（「余地を残す」ではなく「確認する」）。
- Case B を Agent 限定にして Conductor の既存 recovery 経路を壊さない切り分けも妥当（§5.3 で設計根拠も明示）。

### [Important] 4 (tail -n 50 memory risk): **Resolved**

- §5.2 で `tail -n 10` に変更。AskUserQuestion 直後の Stop hook 前提という設計根拠を §5.3 に追記。
- python3 フォールバックは「割愛」から明示言及に格上げされており、jq/python3 双方欠落時は SESSION_IDLE に degrade する fail-safe も維持。

### [Important] 5 (shell escape for --question): **Resolved**

- `--question` オプション方式を **廃止**、`cmux-team send --from-stdin` 方式に全面差し替え（§5.2 / §7.6 / §14）。
- hook 側は `jq -n --arg ...` で JSON を組み立てて stdin に pipe。shell エスケープ問題は根絶。
- §7.6 で既存 `cmdSend` の後方互換性（`--key value` 形式）を維持する記述あり。破壊的変更なし。

### [Important] 6 (done file race): **Resolved**

- [Critical] 1 の watcher 先起動で大半解消。残る「古い done を新 await-agent が拾う」ケースは、§7.5 の `writeAgentDone` が `timestamp_ms` を必ず書き込み、§8.4 の `handleDoneIfFresh` が `ts < startedAt` で unlink + skip する防御に対応。
- await-agent 側で古い残骸を能動的に掃除するため、前回 await-agent がクラッシュして unlink し損ねた場合にも耐える。

### [Suggestion] 反映状況

| 指摘 | 対応 |
|---|---|
| `generateAgentSettings` の未使用 `conductorSurface` 引数 | ✓ §4.1 で削除（daemon 側で team.json から逆引き） |
| surface ID ファイル名正規化 (`:` 以外にも汎用化) | ✓ §7.5 で `replaceAll(/[^a-zA-Z0-9_-]/g, "_")` 採用 |
| 未知 surface の SESSION_IDLE に warning ログ | ✓ §7.2 で `session_idle_unknown_surface` 追加 |
| dashboard `asking` ソート順を running より上位 | ✓ §9 で `starting → asking → running → idle` に変更 |
| `cmdAwaitAgent` race unit テストの必須化 | ✓ §12.1 で必須化（[Critical] 1 の担保） |

未対応 Suggestion は無し。

---

## New Issues

なし（重大なもの）。

### [Nit] 細かな残課題（Approved ブロッカーではない）

- **§5.2 Case B の Conductor 側 skip**: `IS_CONDUCTOR=1` のとき Case B に落ちない分岐は良いが、Conductor で「純粋 text stop」が来たときに従来通り `SESSION_IDLE` を送ると、Master への通知（既存 `conductor_started`→`conductor_idle` recovery）は動く。設計意図は分かるが、Conductor の `asking` と自己 `SESSION_IDLE` が同時に立つ状況（ユーザー質問中に stop）は dashboard 側で `asking` を優先表示する想定か、コメントで補足するとなお親切。実装中に追記で足りる。
- **§7.5 question の改行エスケープ**: `q.replace(/\r?\n/g, " ")` で改行を空白化しているが、複数改行が連続するとスペース 1 個に潰れて読みにくい可能性。`\\n` リテラルで残す選択肢もあるが、done ファイルは key=value 形式のまま保ちたい意図も理解できるので、実装時に見え方で判断可。

いずれも Nit 止まり、実装中の微調整で足りる。

---

## Final verdict 理由

1. **前回 [Critical] 2 件が本文で完全に解消**。特に TOCTOU race は watcher 先起動＋`timestamp_ms` 防御＋unit テスト必須化の 3 段構えで、設計・検証両面でカバーされている。
2. **[Important] 4 件も本文反映済み**、かつ [Important] 3 は求めた (a)/(b) のどちらかを超えて両方採用という積極的対応。
3. **反映内容が妥当**。`--from-stdin` 方式、Case B の Agent 限定適用、`timestamp_ms` 比較など、どれも安直な書き換えではなく設計意図を追って選んだ選択肢になっている。
4. **新たな副作用・矛盾なし**。Case B が Conductor の既存 recovery を壊さない切り分け、`--from-stdin` の後方互換維持、`writeAgentDone` の `timestamp_ms` を await-agent 側でも読む対応など、周辺整合性も取れている。
5. **memory / CLAUDE.md ルールとの整合**（pull 型、cmux send/send-key で Agent を直接操作しない、異常時は人間に委ねる、プロンプトはテンプレート編集）も §15 で実装者に明示されており、逸脱リスクが低い。

残る Nit は実装中に吸収できるレベルで、Approved ブロッカーではない。**実装着手して良い。**
