# T382 検品レポート（Inspector）

## 判定: **GO**

一次対応（`selectToken` の 7d ブロッカー追加）は plan.md §1〜§5 の通りに実装され、テスト・回帰・typecheck・構造的整合性すべてパス。CLAUDE.md ガードレール違反なし。Dear T318 root cause に対する効力範囲と限界も plan.md §6 / 検品観点 §7 と整合した形で実装されている。

---

## 1. plan.md との一致

| 観点 | plan.md | 実装 | 判定 |
|---|---|---|---|
| 変更ファイル一覧 | §2 の 5 ファイル | 同じ 5 ファイル（`token-store.ts` / `pool-throttle.ts` / `token-store.test.ts` / `pool-throttle.test.ts` / `docs/spec/09-token-pool.md`）。過剰な変更・抜けなし | ✓ |
| 定数 `BLOCKER_5H` / `BLOCKER_7D` の配置・命名・export | §3.1 で `token-store.ts` の最上部に export const | `token-store.ts:18-22` に配置、両方 export、命名・JSDoc は仕様通り | ✓ |
| `admitCandidates` 改修 | §3.2: `if (effUtil5h > BLOCKER_5H) continue; if (effUtil7d > BLOCKER_7D) continue;` | `token-store.ts:967-968` で 2 行 OR 条件に置換、コメントで Dear T318 への対処である旨を明記 | ✓ |
| stale 救済の温存 | §3.2: `reset_7d_at` 過去なら effUtil7d=0 で評価する旧仕様維持 | `token-store.ts:954-961` で 5h / 7d 両軸を救済（既存 5h 救済は手付かず、7d 救済は元々入っていた T373 の構造をそのまま使用） | ✓ |
| `countPoolTokens` 改修 | §3.4.2: stale 救済 7d 追加 + blocker 7d 追加 + 定数 import 化 | `pool-throttle.ts:139-156` で `admitCandidates` と完全一致するロジック（手で diff 照合済み） | ✓ |
| `hasPoolHeadroomFromSummary` 改修 | §3.4.3: util7d も blocker 判定、util7d=null は headroom あり扱い保持 | `pool-throttle.ts:198-207` で `blocked5h || blocked7d` で `continue`、null は条件式で false → 通過 | ✓ |
| spec 更新 4 箇所 | §3.5: ブロッカー除外節 / 例表 / 構造的整合性節 / 閾値節 / peek 節 | 5 箇所すべて反映（`docs/spec/09-token-pool.md:245` 付近、`@hot` 行へ「（5h 軸）」追記、`@over7d` / `@reset7d` 例表行追加、構造的整合性 §保証 / §閾値 / §peek 節すべて両軸記述） | ✓ |
| JSDoc 更新 | §3.2: `selectToken` / `peekNextToken` / `admitCandidates` 全部 | 3 箇所すべてに `BLOCKER_5H` / `BLOCKER_7D` 表記を反映、`effectiveDefault` でも blocker は免除されない旨も明記（`token-store.ts:885-886, 1034-1037, 1079`） | ✓ |

軽微な追加点として `@reset7d` 行（reset_7d_at=過去で救済される例）が plan.md §3.5 の指示にない形で例表に挿入されているが、これは「7d 救済が壊れていない」ことを spec 例で明示する加点であり、過剰実装ではない。

---

## 2. テスト網羅

### token-store.test.ts (`describe("selectToken (T382: 7d blocker)")`)

| ケース | aim | assertion | 判定 |
|---|---|---|---|
| T382-1 | 7d=0.96/5h=0 単独で除外 | `expect(sel).toBeNull()` | ✓ |
| T382-2 | 全 token 7d>0.95 で null | `expect(sel).toBeNull()` | ✓ |
| T382-3 | 境界値 0.95 は admit（`>` 厳密） | `expect(sel?.token.handle).toBe("@boundary")` | ✓ |
| T382-4 | default 一致でも 7d=0.96 で除外 | selectable=false + projectDefault="@deftok" + util_7d=0.96 → null。default 昇格より blocker が手前であることを正しく検証 | ✓ |
| T382-5 | stale + reset_7d 過去 + 0.99 で救済 admit | `expect(sel?.token.handle).toBe("@reset7d")` | ✓ |
| T382-6 | stale + reset_7d 未来 + 0.97 で除外 | `expect(sel).toBeNull()` | ✓ |

### pool-throttle.test.ts

| ケース | aim | assertion | 判定 |
|---|---|---|---|
| T382-T1 | 全 token 7d=0.96 で throttled=true | `expect(result).toBe(true)` | ✓ |
| T382-T2 | 片方 7d=0.5 残れば throttled=false | `expect(result).toBe(false)` | ✓ |
| T382-C1 | 3件中 1件のみ admit → available=1 | `expect(r.available).toBe(1)` | ✓ |
| T382-C2 | stale + reset_7d 過去 + 0.99 → available 1 | `expect(r.available).toBe(1)` + `r.stale=1` も追加 assert | ✓ |
| T382-H1 | util7d=0.96 → false | `expect(...).toBe(false)` | ✓ |
| T382-H2 | util7d=null → true（5h で判定） | `expect(...).toBe(true)` | ✓ |

合計 12 ケース。すべて plan.md §4.1 / §4.2 の aim と一致した assertion を持ち、テスト名のコメントだけで通過しているケースはなし。境界値 (0.95) は T382-3 で `>` 厳密不等号を確認、default 一致でも除外される点は T382-4 で明示。

---

## 3. 回帰テスト実測

```
cd /Users/yamamoto/git/cmux-team/.worktrees/task-382-1777433105/skills/cmux-team/manager
```

| ファイル | 結果 | impl-summary 記載 |
|---|---|---|
| `token-store.test.ts` | 134 pass / 1 skip / 0 fail | 134 pass / 1 skip / 0 fail ✓ |
| `pool-throttle.test.ts` | 31 pass / 0 fail | 31 pass / 0 fail ✓ |
| `dashboard-pool.test.tsx` | 2 pass / 0 fail | 2 pass / 0 fail ✓ |
| `pool-summary.test.ts` | 12 pass / 0 fail | 12 pass / 0 fail ✓ |
| `pool-header-display.test.ts` | 13 pass / 0 fail | 13 pass / 0 fail ✓ |
| `pool-cli.test.ts` | 3 pass / 0 fail | 3 pass / 0 fail ✓ |
| `pool-status-header.test.ts` | 30 pass / 0 fail | 30 pass / 0 fail ✓ |
| `token-cli.test.ts` | 37 pass / 4 skip / 0 fail | 37 pass / 4 skip / 0 fail ✓ |
| `proxy.test.ts` | 48 pass / 0 fail | 48 pass / 0 fail ✓ |

全 9 ファイル green、impl-summary の数値と完全一致。

---

## 4. typecheck

```
bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json
```

Exit code 0、出力なし。**Pass**。

---

## 5. 構造的整合性

- `canSelectAnyToken` (`token-store.ts:1022`) / `selectToken` (`:1060`) / `peekNextToken` (`:1101`) のいずれも `admitCandidates` 経由で blocker 判定を共有。本タスクで `admitCandidates` 内部だけ修正することで 3 経路すべて自動追従していることをコードで再確認。
- `countPoolTokens` のロジックを `admitCandidates` と並べて手で diff:
  - effectiveDefault 解決式: 同一
  - exclude / selectable=0 default 昇格 / lease check: 同一
  - stale 判定（30 分）: 同一（定数名は `staleThresholdMs` vs `STALE_THRESHOLD_MS` で異なるが値は等しい）
  - 5h / 7d 各軸の reset 救済式（`parseResetEpochMs(...) <= now`）: 同一
  - blocker 判定 `effUtil5h > BLOCKER_5H` / `effUtil7d > BLOCKER_7D`: 同一（同じ定数を import）
  - admit 判定（default → include → OSS → tag）: 同一
  
  → drift なし。
- 仕様書例表（`docs/spec/09-token-pool.md:266-272`）の数値を手計算で再検証:
  - `@kami` (0.07, 0.18, 未来, 未来): effUtil=(0.07, 0.18), score=0.3·0.07 + 0.7·0.18 = 0.147 ✓
  - `@tayo` (0.02, 0.91, 過去, 未来): effUtil=(0, 0.91), score=0.7·0.91 = 0.637 ✓ blocker 不該当（0.91 < 0.95）
  - `@hot` (0.97, 0.5, 未来, 未来): effUtil=(0.97, 0.5) → 5h blocker 除外 ✓
  - `@over7d` (0.5, 0.96, 未来, 未来): effUtil=(0.5, 0.96) → 7d blocker 除外 ✓（新規例、T382 追加）
  - `@reset7d` (0.5, 0.99, 未来, 過去): effUtil=(0.5, 0), score=0.3·0.5 = 0.15 ✓（新規例、7d 救済の維持確認）

---

## 6. CLAUDE.md ガードレール

| 観点 | 結果 |
|---|---|
| `taskState[...] =` / `saveTaskState(` の daemon.ts / main.ts への直接書き込み増加 | 0 件（grep で検出されたのは `main.ts:370` のコメント中の参照のみ） |
| `bus.emit` / `bus.on` の eventBus.ts 外からの呼び出し増加 | 0 件 |
| 空 `catch {}` の増加（pool-throttle.ts / token-store.ts） | 0 件 |
| 外部コマンド失敗時の stderr/stdout ログ省略 | 該当変更なし（外部コマンド呼び出しを伴う改修ではない） |
| 直接ファイル書き込み禁止（.team/tasks/） | 該当なし（CLI 経由の運用） |

ガードレール違反なし。

---

## 7. Dear T318 root cause に対する効力と限界

### 本実装が防げるもの

`util_7d > 0.95` を示している token を `selectToken` の admit 候補から除外する。これにより:

- **真に枯渇している token が落札される**ことは防げる（snapshot が 0.96+ を返している前提）。
- 全 token が 7d>0.95 のときは `selectToken=null`、`spawn-agent` はフォールバック側に流れ、上位（pool-aware THROTTLE）でも `isThrottled5h=true` を返して spawn を抑制する。

### 本実装では防げないもの（plan.md §6 で別タスク化）

Dear T318 の事故シナリオ:
- `@tayo`: util_7d=0.91 / util_5h=0 / recorded_at が 2 日以上前 stale / reset_5h 過去 / reset_7d 未来
- `@kddi`: exclude
- `@saki` / `@kami`: util_5h>0.95 で 5h blocker 除外

本実装後:
- `@tayo` の effUtil=(0, 0.91) → 0.91 < 0.95 で blocker **通過**（仕様として正しい）
- `@tayo` が唯一の admit 候補のまま落札 → 実際の Anthropic 側 7d 月次枠が満杯（snapshot が固まっているだけ）→ monthly limit hit が **再発しうる**

つまり「snapshot が固まって 0.91 だが実際は >1.0」という状態は本タスクのスコープでは **検知できない**。これは proxy 側の auth_hash mismatch 自己修復（plan.md §6 / 別タスクとして切り出し）が解決すべき問題で、本タスクは「snapshot が真に 0.96 以上を示しているとき」に限り効力を持つ。

検品観点 §7 の整理通り、本実装は:
- ✓ snapshot が 0.96+ を示す全 token に対して admit を防ぐ
- ✓ default 昇格 token であっても blocker を強制（T382-4 で明示）
- ✗ snapshot 自体が古くて util_7d を実態より低く返す問題は解決しない（auth_hash 別タスク）

この限界は plan.md §6 で「別タスクとして切り出した上で本実装単独で十分」と判断されており、impl-summary も「別タスク化の起票は Conductor が行う想定」と記載済み。実装範囲としては T382 一次対応の境界を正しく守っている。

---

## 9. 指摘事項

### Critical

なし。

### Major

なし。

### Minor

- **(observation) `pool-throttle.ts:122` のコメント**: `// selectToken の admit と同一に揃える（B1: default 昇格、B2: exclude、B3: lease、B4: 0.92 OK、stale skip）。` の `B4: 0.92 OK` は T367 当時の表現で、現在の閾値 `0.95` と乖離する古い表現が残存。本タスクのスコープ外だが、次回 pool-throttle.ts に触る際にコメントを `> BLOCKER_*` 表記に更新するとよい。
- **(observation) `docs/spec/09-token-pool.md:269` の `@kddi` 行**: selectable=`no` の token を「候補（負け）」と表記しているが、selectable=0 は default 昇格時のみ runtime 候補化される（plan.md §3.3 / spec §候補抽出 2.）。例表が effectiveDefault=`@kddi` を前提としているのか文脈が省略されており、改修後の admit ロジックと整合しているか読者に伝わりにくい。本タスクで導入された差分ではなく既存の例表記述なので blocker 扱いせず観察として記録。
- **(observation) `pool-throttle.ts:155-156` の blocker 判定**: 構造的に `admitCandidates` と完全一致しているが、plan.md §3.4.2 末尾で示唆された「`admitCandidates` を export して `countPoolTokens` から再利用する refactor」は本タスクで実施されていない（plan.md でも別タスク化を推奨）。drift を抑える追加策として将来検討の余地あり。

### 結論

GO 判定の妨げになる指摘は **無し**。Minor は全て本タスクのスコープ外もしくは将来検討事項。

---

## 10. Recommendations

1. **二次対応（auth_hash auto rotate）の別タスク起票**: plan.md §6 / impl-summary 記載の通り、Conductor 側で別タスク（例: T??? `proxy: auth_hash mismatch 時の auto rotate（T382 followup）`）を起票することを推奨。本タスクのコミット message に `Closes T382` と `Follow-up: T???` を併記すると trace が追いやすい。
2. **`admitCandidates` export refactor の検討**: `countPoolTokens` のロジック複製は本タスクのテスト（T382-C1, T382-C2）で一致を担保しているが、構造的に drift のリスクが残る（例: T373 が 5h 救済を入れた当時、countPoolTokens 側の追従が漏れていた）。中期的には `admitCandidates` を export して `countPoolTokens` から呼び出す refactor を別タスクで切り出すと本質的に解決する（plan.md §3.4.2 末尾も同主旨）。
3. **コメントの閾値表記更新（軽微）**: `pool-throttle.ts:122` の古い `0.92` 表現は将来別の機会で `BLOCKER_*` 表記に更新すると一貫性が増す。

---

検品完了。一次対応として GO。
