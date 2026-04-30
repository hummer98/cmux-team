# Design Review — T392 plan.md (Round 2)

## 総合判定: Approved

Round 1 で挙げた必須修正 2 件は両方反映済み。任意修正 5 件もすべて採用され、plan.md 末尾の「設計判断の注釈（Round 2 — Design Review 反映）」セクションに反映先が一覧化されている。実装段階で立ち往生する瑕疵は残っておらず、Approved 相当。

## Round 1 必須修正の反映状況

1. **StopFailureMessage.pid required**: 反映
   - §4.1 (plan.md:217) の diff が `pid: z.number()` に変更済み。
   - §4.1 直下の注記 (plan.md:230) に「`NotificationMessage` (schema.ts:152) / `SessionStopMessage` (schema.ts:122) と整合。settings.json は `--pid "$PPID"` を hardcode で必ず送る契約」と明記。
   - §Step 2 RED テスト一覧 (plan.md:336) に `case: "T392 STOP_FAILURE pid 欠落で zod throw"` が追加済み。
2. **buildMasterSection export**: 反映
   - §Step 6 GREEN (plan.md:414) に「**`dashboard.tsx:513` の `function buildMasterSection` を `export function buildMasterSection` に変更する**（必須修正 Design Review #2: テストファイル `dashboard-master.test.tsx` から直接 import するため）」が太字で追加済み。
   - 実コード状態確認: `dashboard.tsx:513` は現状 `function buildMasterSection(state: DaemonState)` で非 export（grep 結果と一致）。実装時に plan.md の指示通り export を追加すればテストが立ち上がる。

## Round 1 任意修正の反映状況

- **A. `acceptHookSignal` フィルタ要否**: 採用 — §9.2 (plan.md:609) で「フィルタは不要」を確定方針として明文化、§9.5 (plan.md:636) で「対処不要・確定」と書き直し済み。
- **B. await-agent 常時 watch 前提の明記**: 採用 — §3.2 (plan.md:135) に「done file 上書き race（理論上の懸念、実害なし）」段落として独立追記し、「**await-agent が常時 watch している前提でこの race は実害なし**」と太字明示。
- **C. README hook 一覧更新方針の確定**: 採用 — §Step 8 (plan.md:463) で「**`grep -l "Notification" README*` で hit すれば StopFailure を 1 行追加、hit しなければ skip**（任意修正 Design Review C 採用、確定方針）」と確定的指針に書き換え済み。
- **D. fallback 経路コメント**: 採用 — §3.1 末尾 (plan.md:117) に「契約上 role は常に来る、fallback は将来互換のため」コメントを `resolveStopFailureTarget` の fallback 分岐に 1 行入れる旨を明記。
- **E. shadowObserveConductor への STOP_FAILURE 流入禁止**: 採用 — §Step 6 GREEN (plan.md:418) に「**`shadowObserveConductor` への `STOP_FAILURE` 流入は起こさない**（任意修正 Design Review E 採用）」を明記し、reducer 監視は P3 まで shadow only である §1.5 不変条件 C-I4 と整合させている。

## 強み（Round 2 で追加）

- **Round 1 指摘の追跡可能性**: plan.md 末尾「設計判断の注釈（Round 2 — Design Review 反映）」セクション (plan.md:657-680) が必須修正 2 件 / 任意修正 5 件の反映先を表形式でまとめており、Round 1 → Round 2 の差分が一目で追える。後続レビュー・実装時のコンテキスト復元コストが低い。
- **行番号の軽微訂正反映**: §2.4 SESSION_IDLE (2316-2335 → 2305-2334) / §2.5 buildMasterSection (524-555 → 513-555) / §7.1 §1.5 (102-110 → 102-109) の Round 1 指摘行番号差分が plan.md:677-679 で訂正済み。実装者が「コメント基準で読む」運用に統一されている。
- **§3.2 race 議論の独立段落化**: 「done file 上書き race（理論上の懸念、実害なし）」が §3.2 末尾の独立段落になり、Round 1 で要望した「await-agent 常時 watch 前提」が前提条件として明文化された。実装者が race 懸念を持ち込んだ際の判断材料が plan 内で完結している。
- **§9.2 / §9.5 の重複情報整理**: Round 1 では「§9.2 でフィルタ要、§9.5 で要確認」と二重に書かれていたものが、Round 2 では「§9.2 = 不要・確定、§9.5 = 対処不要・確定（A025 Design Review A 採用）」と一本化された。implementer が `daemon.ts:1455` で迷わない構造になっている。

以上、必須修正 2 件と任意修正 5 件がすべて反映済みであり、実装に支障が出る論点は残っていないため **Approved**。
