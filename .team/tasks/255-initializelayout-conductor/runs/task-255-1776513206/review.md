# Design Review: T255 (2nd pass)

## 判定

**Approved**

前回 Changes Requested で挙げた 11 件 Recommendations はすべて plan.md に反映済み。特に中核懸念である「pane 新規分割の扱い（懸念 1）」「unmatched resume の救済（懸念 2）」「pre-set rollback（懸念 3）」「tree 失敗時 degrade（懸念 4）」は設計レベルで明文化され、テストケースも M10〜M16 で拡充されている。方針変更（unmatched resume は新 slot 合流ではなく task-state を ready に戻す運用）も懸念 1（pane 補充しない）と整合しており、実用観点で問題なし。実装に進んでよい。

## 11 件 Recommendations への対応状況

| # | 前回指摘 | plan 該当箇所 | 対応 | 備考 |
|---|---------|-------------|------|------|
| 1 | pane 新規分割廃止 or kept 起点分割 | §1（L17）、§3.1（L89-91）、§3.2 step 8（L228-241）、§4.2（L318） | ✓ | 「復帰時は pane 新規作成しない」方針を採用。`conductorsFromJson.length === 0` のときのみ `initializeConductorSlots` を呼ぶ。kept.size > 0 時は `maxConductors` 未満で稼働を許容。R7 として可観測化（`layout_kept_partial`） |
| 2 | unmatched resume ステップ追加 | §3.2 step 4b（L151-165）、§3.2 補足（L247-250） | ✓ | 方針 1 との整合で「新 slot 合流」ではなく「task-state を ready に戻し次 tick の scanTasks に委ねる」に変更。ログは `resume_unmatched_to_ready`（Recommendations の `resume_unmatched_to_new_slot` から改名）。方針転換の合理性は plan 本文で説明済み |
| 3 | pre-set → launchConductor throw 時の rollback | §3.2 step 7（L197-226）、§7（L366）、§8.3 M16（L411） | ✓ | `state.conductors.delete(surface)` + `taskState[taskId].status = "ready"` + `saveTaskState` + `conductor_resume_launch_failed` ログを明記。テストケース M16 として追加 |
| 4 | tree 失敗時の B/C/D degrade | §3.1 右列（L77-83）、§3.1 補足（L85-86）、§3.2 擬似コード（L142-144）、§8.3 M7・M13（L402・L408） | ✓ | B→A 相当保守、C→cleanup せず discard のみ、D→unmatched として ready 戻し。`tree_fetch_failed degrade=pid_only` ログ先頭出力も明記 |
| 5 | task-state 整合性リコンサイル | §3.2 step 6（L174-194）、§8.3 M10（L405） | ✓ | `taskState[taskId]?.status !== "assigned"` なら `taskId`/`taskRunId`/`worktreePath` クリア + status idle リセット。`conductor_taskid_reconciled` ログ、テストケース M10 追加 |
| 6 | spawnPidWatcher 二重起動ガード確定記述 | §7 表の該当行（L365） | ✓ | 「既存実装済み（`daemon.ts:2046-2048` で `clearInterval` 済み）。本 PR では touch せず現状維持」と確定形で記載 |
| 7 | layout_mismatch_on_resume ログ保持 | §3 冒頭（L72-73）、§3.2 擬似コード L103-105、§8.3 M14（L409） | ✓ | 出力タイミングを「team.json 読み込み直後、`planLayoutRestore` 呼び出し前」と確定。CHANGELOG 記述にも反映、テストケース M14 追加 |
| 8 | worktree 消失 TOCTOU 許容根拠 | §9 R6（L428） | ✓ | (1) 実運用で稼働中 worktree 削除は稀、(2) 次 tick の disconnected 経路で最終的に人間判断に委ねる、と feedback_error_recovery 準拠で根拠明記 |
| 9 | テストケース M10〜M14 拡張 | §8.3（L405-411） | ✓ | M10〜M16 の 7 ケース追加（要求より多い）。maxConductors=0、unmatched resume 単体、workspace 不明、layout_mismatch、pre-set → self-register race（新経路）、launchConductor throw を網羅 |
| 10 | `conductor_resume_noop` 依存調査エビデンス | 付録 A（L476-488）、§9 R5（L427） | ✓ | `rg -n "conductor_resume_noop"` 実行結果を付録 A に貼付。本体 `daemon.ts:876` と過去タスクの run ドキュメントのみで外部依存なしを確認。CHANGELOG 雛形も付録 A に明記 |
| 11 | コミット 2 の分割選択肢 | §10 代替（L457-464） | ✓ | 2a（B-path のみ）/ 2b（unmatched + cleanup + reconcile）/ 2c（tree degrade）の 3 分割案を明記。「diff 肥大時に切り替える運用」と条件付きで採用 |

## 強み（前回レビューから継続）

- A〜E のマトリクス分解と `planLayoutRestore` pure function 化の方向性が明確で単体テストしやすい
- 副作用実行順序（A 登録 → cleanup → B resume → plain 新規）が layout 崩れを防ぐ意図で整合
- 既存 `launchConductor` / `CONDUCTOR_REGISTERED` idempotent skip を流用する形で新規コード面を最小化
- CHANGELOG 雛形が付録に明記され、破壊的変更（`conductor_resume_noop` 廃止・新ログ 7 種）の告知漏れが起こりにくい

## 方針変更の妥当性評価（懸念 1・2 の合わせ技）

前回懸念 1 で推奨した「復帰時 pane 新規作成しない」と懸念 2 で推奨した「unmatched を新 slot 合流」は実装時に矛盾する（新 slot を作らないなら合流先がない）。plan はこの矛盾を「unmatched は task-state を ready に戻す」で解消しており、妥当:

- 次 tick の `scanTasks` が通常の assignment フローで ready タスクを拾う → 空き Conductor があれば新規割当される
- session-id resume は失われるが、`cmux-team resume` の fallback で新セッションが張られるため機能断絶しない
- `layout_kept_partial` ログで部分復元状態を可観測化、人間が `cmux-team stop/start` で再配置すれば完全復旧

R7 として「将来 session-id resume を優先したくなったら `createConductorPanes` を kept 起点に拡張する後続タスク」と逃げ道も用意されており、段階的改善の道筋が明確。

## 実装者への注意事項

1. **テスト M12 の挙動確認**: 「team.json 空 + resumePlan 非空」のとき、擬似コード L231 の `conductorsFromJson.length === 0` 分岐で `initializeConductorSlots` が呼ばれるので、unmatched として ready に戻した後に改めて resume plan がそこに渡される流れになる。step 4b と step 8 の resume plan の handoff が二重にならないよう、**step 4b で ready に戻した item は step 8 の `resumePlan` から除外するか、そのまま渡してもよいか**を実装時に確認（`main.ts:596-605` の resume_fallback_to_ready が `rawResumePlan` 構築時のみ走る点と整合させる）。plan の擬似コード L236 は `[...resumePlan]` をそのまま渡しているが、ready に戻した item は `task-state` 側で `assigned` → `ready` になっているので、呼び出し先で再度 filter されるなら問題なし。実装時にこの assumption を `daemon.test.ts` の M12 で明示的に検証すること。

2. **`fetchLiveSurfaces(undefined)` の契約**: plan §4.2 で `workspace === undefined` のとき `null` を返す契約とあるが、実装時に `cmux.ts` 側の `tree(workspace)` が `undefined` を渡されたときの挙動（CLAUDE.md の「`tree()` ではなく `tree(workspace)` を使う」ルール）と整合させること。`fetchLiveSurfaces` の中で `if (!workspace) return null` の早期 return を入れるのが安全。

3. **`launchConductor` が sequential である確認**: R4 で「B 経路も sequential にする」とあるが、擬似コード step 7 の `for...of` ループ + `await launchConductor(...)` で自然に sequential になっているはず。念のため Promise.all で並列化しないこと（Claude Max レート制限回避）。

4. **コミット 2 の diff 肥大判断**: plan §10 の 2a/2b/2c 分割は「必須ではない」とされているが、懸念 1・2・3・4 の対応が全て入ると diff 行数が増える可能性が高い。実装着手時に「新規テスト 7 ケース + helper 抽出 + rollback + unmatched 処理」の diff 規模を一度見積もり、400 行超える見込みなら 2a/2b/2c 分割を採用することを推奨。

5. **`conductor_register_skipped` との整合確認**: M15（pre-set → `CONDUCTOR_REGISTERED` race 新経路）のテストで、pre-set した `taskId`/`taskRunId`/`worktreePath`/`taskTitle` が `CONDUCTOR_REGISTERED` ハンドラで上書きされないことを明示的に assert すること（T228 テストは既存 skip ロジックの検証で、新経路の pre-set フィールドを網羅していない可能性あり）。
