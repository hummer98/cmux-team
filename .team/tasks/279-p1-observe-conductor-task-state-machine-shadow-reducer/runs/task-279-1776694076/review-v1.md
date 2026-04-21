# T279 Plan Review v1

## 1. 判定

**Approved** — plan.md を元に実装に進んで良い。

以下の Recommendations / 軽微 suggestions は **実装開始前に plan.md を補足** するか、Implementer が実装中に明示的に判断できる粒度まで固めることを推奨するが、approach の骨格に根本的な問題はない。

---

## 2. 良い点

1. **P1 スコープの防衛が明確。** 「副作用は一切実行しない」「別 Map で shadow state を保持」「shadow.ts は logger 以外を import しない」という3重のガードで、shadow が既存 daemon を汚染するリスクを構造的に排除している（§5.4、リスク表）。
2. **ctx を「reducer の決断に最低限必要」に絞り、Action で外出しする設計分離** が綺麗（§4）。ctx 肥大化の罠を事前に意識できている。
3. **TDD 順序（§9）が正しい。** events.ts → invariants 骨格 → test red → reducer 実装の順で、table test が A017 全セルを網羅してから実装に入る。
4. **A017 との対応が具体的。** 状態数・イベント数・セル数（Conductor 84 / Task 54 / 合計 138+）を DoD に数値でコミットしており、後段で「抜け」の判定が定量的にできる。
5. **24h 稼働要件（完了条件 3）を現実的代替に置き換える提案が明文化されている** （§8.1）。DoD にも「impl-report に明記」として残しており、スコープ縮小の透明性が確保されている。
6. **broken 終端性、Master surface 別扱い、T232/T263/T264/T269/T274/T277 の各特殊ケース** が §6.2 の回帰テストとして列挙されており、A017 §4 の race / 留意点が設計に落ちている。
7. **daemon.ts の配線箇所が行番号付きで具体的** （§5.3）。現行 daemon.ts の実際の case 位置（1407 / 1590 / 1698 / 1786 / 1873 / 1983 / 2046 / 2879）と照合して一致を確認済み。scanTasks(2346) / monitorConductors(2739) / forceCloseDisconnectedConductor(2814) / handleConductorDone(2879) の位置も実コードと整合する。
8. **プロンプト編集ルールに抵触しない。** 本計画はコード変更のみで `.team/prompts/*.md` を触らない。

---

## 3. 懸念点

### 3.1 構造的正しさ

**C1. `CLEAR_MANUAL` event の用途が未定義で orphan 化している可能性。**
- §3 の FsmEvent union に `CLEAR_MANUAL` が含まれるが、§5.3 の「handler → event 変換表」に CLEAR_MANUAL を emit する箇所がない。一方で `SESSION_CLEAR` は既に `manualUserInitiated: boolean` flag を持っており、「user_clear 判定済み」の情報を内包できる。
- タスク本文の scope には `CLEAR_MANUAL` が列挙されているため event type 自体は残す必要があるが、「どの経路で emit されるか」「SESSION_CLEAR との関係」を plan で 1 文定義すべき（例: 「CLEAR_MANUAL は現状 daemon から emit されない予約 event。将来 shadow 外の明示 inject 用に確保する」等）。exhaustive switch の case が死に case になることを plan で明示しておかないと、Implementer が迷う。

**C2. `DONE` event / ConductorCtx に `taskStatus` 情報が欠けており、T274 分岐を reducer で判定できない。**
- §3 の `DONE; success; unresolved` で「unresolved は handleConductorDone 分岐後」と注記があるが、T274 の stateMismatchOnSuccess（`success=true` かつ task 側が `assigned` のまま）の判定は `unresolved` flag に畳み込めない（T274 は success=true の異常系）。
- §6.2 の T274 テストケース「DONE success=true かつ task state=assigned → auto close_task + idle」を reducer 単体で書くには、**ctx に `taskStatusAtDone?: TaskStatus` を載せる** か **DONE event に `currentTaskStatus` を加える** 必要がある。plan §4 の ctx 表には taskStatus 系が無い。

**C3. `prev` 状態のスナップショット取得タイミングが plan で未明記。**
- shadow API は `(surface, prev, event, ctx, actualNext)` を受け取る。しかし既存 daemon は case 内で `conductor.status` を破壊的に更新するため、「case 末尾 break 直前」に呼ぶ時点で `conductor.status === actualNext` になっている。
- 実装では **case 冒頭で `const prevStatus = conductor.status` を保存** する必要があるが、これは「既存コードに 1 行も触れない」ポリシー（§5.4 / DoD）と抵触する読み方もできる。plan で「prev 捕捉のための最小追記は許容」と明文化するか、shadow ヘルパ側で capture する設計（例: `shadowBegin(surface)` → `shadowEnd(surface, event, ctx)` 2 段階 API）に切り替えるか選択すべき。

**C4. ConductorStatus / TaskStatus 型の出所が未明記。**
- reducer は `schema.ts` の既存 enum を参照すべきか、state-machine/ 内で重複定義すべきか plan で決まっていない。
- 推奨は **`schema.ts` から type-only import**（`import type { ConductorStatus } from "../schema"`）。値ではなく型のみ依存することで循環依存を回避できる。§5.4 の「shadow.ts は logger 以外 import しない」は shadow.ts 限定の制約だが、conductor-fsm.ts / task-fsm.ts でも同じ方針を採るか plan で言及すべき。

### 3.2 A017 整合

**A1. `assigning` 中の `SESSION_IDLE` no-op（T277）が reducer の戻り値で「next=assigning, actions=[]」として明示されるべき。**
- A017 §1.2 と §4.1 は「R1 保険経路を撤去し、assigning 中の SESSION_IDLE は no-op」と明示している。plan §6.2 T276/T277 のテストはこれを網羅するとあるが、reducer の振る舞いとしては **状態を維持する（next=assigning）** のが正解であることを §6.2 で明文化した方が Implementer 読解に優しい。

**A2. SESSION_STARTED の source 別分岐で `startup` / `resume` / `clear` / `compact` のうち、`clear` のみが `assigning→running` を起こす点（T232）が plan で明示されていない。**
- §3 の `SESSION_STARTED` は `source: "startup" | "resume" | "clear" | "compact" | undefined` を持つが、A017 §1.2 と daemon.ts:1457 に従えば、**source=clear の場合のみ** assigning→running へ遷移する（T232 メイン経路）。他 source での assigning 中 SESSION_STARTED の扱い（恐らく log only の no-op）を reducer でどう扱うか plan で 1 行言及した方が、テストテーブル作成時の迷いが減る。

**A3. `SESSION_CLEAR(manualUserInitiated=true)` の判定は reducer 外（§3 コメント「user_clear 判定済み」）で行われるが、判定ロジックの所在が plan で未明記。**
- 実 daemon の user_clear 判定（daemon.ts:2119）は `decision_reason=running_with_taskid` 等の複数条件で決まる。shadow 側はこの判定結果を受け取る前提だが、「呼び出し側 = daemon.ts の既存判定結果をそのまま event に載せる」というワイヤリング方針を §5.3 の SESSION_CLEAR 行に追記すべき。

### 3.3 既存コード整合

**E1. Action `notify_state_changed` が reducer から返される件。**
- §3 の ConductorAction に `notify_state_changed; source` が列挙されている。§5.4 で「notifyStateChanged は log only」とあるので P1 では実行されないが、EventBus ポリシー（CLAUDE.md）の「emit 箇所 = state mutation 箇所」の不変条件に対して **shadow が意味的に state mutation を示唆する Action を返す** のは紛らわしい。P2 で effects.ts が実行する際に、reducer が Action で state mutation を「指示」する体になる方向性を plan §10 / §7.1 の 07-state-machine.md で補足しておきたい（P2 設計の前振り）。

**E2. `ctx.isMasterSurface` の解決元が plan で未明記。**
- plan §3 で event に `isMasterSurface: boolean` を載せているが、daemon 側でこれをどう計算するか（`state.masters.some(m => m.surface === surface)` 相当）を §5.3 の SESSION_STARTED 行に書いておくと、Implementer が迷わない。`state.masters` は配列（T229、CLAUDE.md）なので単純 lookup ではない点も注意。

### 3.4 リスク

**R1. shadow の exception 隔離が「二重 try/catch」で十分か検討済み。**
- §5.1 の shadow.ts 内 try/catch + §5.4 の呼び出し側 try/catch で二重化されており、shadow 例外が既存処理に漏れる経路は遮断できる。妥当。
- ただし「shadow.ts 内で `JSON.stringify(a)` が循環参照で throw」等のエッジは呼び出し側の catch で拾う前提。Action 型が discriminated union で primitive フィールドしか持たない設計なので実害はない見込みだが、念のため `JSON.stringify` の代わりに key ベースの短縮 formatter を使うと堅い（軽微）。

**R2. 24h 観測要件の代替案の妥当性。**
- 「reducer 単体テストで A017 全セル網羅 + 既知 violation を fsm.test.ts で再現 + impl-report に deferral 明記」は、本タスク期間内で構造品質を示す最良案として妥当。
- ただし DoD 完了条件 3（「shadow mode を 24h 稼働」）を本タスクで未達にする **スコープ縮小判断** であることは間違いない。Master に対して「T280 で 24h 観測 + 統計採取を P2 作業に含める」ことを明示的に合意取得してから実装に入ることを推奨（§8.1 の方針を実質追認するステップ）。Plan §8.1 はこの方針を提案として書いており reviewer として合理的と判断するが、「なし崩し的な縮小」を避けるため impl-report に deferral を列挙することを DoD 末尾（§11）に追記する Recommendation を出しておく。

### 3.5 ドキュメント

**D1. 07-state-machine.md の Mermaid 図の粒度を「主要経路 + broken 集約」に絞る方針は妥当。**
- §7.1 の方針通り、全セルを Mermaid で描くと読めないので、主要経路を 1 本、broken への集約を別ノードで可視化するのが最善。全セルは表で補完する構成で OK。

**D2. A017 §5 補正欄の粒度。**
- plan §7.2 / §7.3 は「乖離発見時に reducer は実装を正とし、A017 §5 補正欄と impl-report に追記」としている。妥当。ただし「補正欄が空のまま終わる場合もその旨記載」を DoD に書いておくと、dockeeper skill 側が A017 を再生成するときの扱いが明確になる（A017 artifact の更新 timestamp 運用）。

---

## 4. Recommendations（必須修正項目は無し）

Approved 判定のため「必須修正」は無い。ただし以下 6 点は **実装着手前に plan.md を 1 段更新する** ことを推奨する（軽微だが Implementer の判断コストを下げる）。

1. **C1 解消**: CLEAR_MANUAL が現状 emit されない予約 event である旨を §3 または §5.3 に 1 文で明記する。
2. **C2 解消**: ConductorCtx に `taskStatusAtDone?: TaskStatus` を追加するか、DONE event に `currentTaskStatus` を載せて T274 auto-close 分岐を reducer 内で判定可能にする。§6.2 の T274 テストが書けることを plan で保証する。
3. **C3 解消**: `prev` 状態のスナップショット取得方針を明記（推奨: 各 case 冒頭で `const prevStatus = conductor.status` を保存する追記は「既存ロジック書き換え」に含めない = 許容、を §5.4 に追記）。あるいは `shadowBegin` / `shadowEnd` 2 段 API に変更する旨を §5.1 に反映。
4. **C4 解消**: ConductorStatus / TaskStatus を `schema.ts` から **type-only import** する方針を §2 または §5.4 に明記。循環依存回避の根拠を添える。
5. **R2 解消（合意取得）**: Master（ユーザー）に「24h 稼働要件は T280 に送る」旨の合意を取ったことを impl-report 冒頭に明記する要件を DoD §11 に追加する。
6. **D2 解消**: A017 §5 補正欄が「空の節としてでも存在する」ことを DoD §11 に 1 行追加する（plan の DoD 既存項目で「§5 補正欄が追加されている（空でも節として存在）」と書かれており、既に十分 — 念押し）。

---

## 5. 軽微な suggestions（Approved 付帯）

- **S1**: §5.3 の配線表に「prev 捕捉」「event 構築」「shadow 呼び出し」の 3 行を case ごとに示すミニパッチ例（疑似コード）を 1 箇所だけ plan に載せると、14 箇所 × 3 ロールの配線で齟齬が出にくい。
- **S2**: §6.1 の Conductor セル計算で「7 states × 12 events = 84」とあるが、`broken` 終端で 12 cells を 1 行に圧縮 + Master surface 別扱いで SESSION_STARTED を 2 分岐 + source 4 種 → 実質セル数は 84 より増える。describe ブロックごとのケース数コメントに「ゴール: **table.length ≥ 138**」とだけ示せば十分。
- **S3**: `state-machine/` 内の import 規約を最初の PR description で明文化すると以降の拡張が安定する（推奨: `logger`, `schema (type-only)` のみ許可、`daemon`, `conductor`, `task`, `eventBus` は禁止）。
- **S4**: §8.1 の「自己スモーク（runSelfSmoke）」は任意だが実装すると P2 着手時のデバッグ基盤にもなるので、**任意ではなく「軽量の 5 ケース程度を cmdStart 冒頭で emit」を推奨** に格上げしても良い。
- **S5**: `fsm_shadow_diff` / `fsm_shadow_action` / `fsm_shadow_error` / `fsm_invariant_violation` の 4 種のログイベント名を、ロギングポリシー（CLAUDE.md）の表記規則に整合させるため `fsm_*` prefix で揃えている点は既に OK。07-state-machine.md 内の「ログキー」節でこの 4 種を列挙しておくと運用時の grep 検索性が上がる（`rg fsm_shadow_diff .team/logs/`）。
- **S6**: §6.4 の実行環境注記で `cd skills/cmux-team/manager && bun test state-machine/` としているが、repository ルート用の npm script（`bun test` / `npm test` 等）に state-machine テスト alias を追加する提案を §9 最終ステップに入れると、CI/ユーザー実行時の摩擦が減る（任意）。
- **S7**: §2 の「バレル（index.ts）不要」判断は合理的。同意。

---

以上。plan.md は P1 スコープを守りつつ A017 全セルを reducer で構造化する設計として完成度が高い。上記 Recommendations は plan を 1 段追記すれば解消できる範囲で、実装着手をブロックしない。
