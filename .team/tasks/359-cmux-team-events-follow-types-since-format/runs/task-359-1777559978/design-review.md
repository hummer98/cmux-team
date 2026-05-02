# T359 plan.md レビュー (Iteration 2)

## Verdict

**Approved**

前回 Iteration 1 の Recommendations 1〜7 はすべて適切に反映されており、設計の一貫性・実装具体性・spec との関係性整理が大きく改善された。残課題は Implementer 判断に委ねるべき粒度の論点のみで、設計の根幹を変えるものはない。Phase 3（Implementer）に進めてよい。

---

## Findings (前回からの改善状況 + 新規)

### Critical

なし。

### Major

#### 前回 Major の反映状況（すべて解消）

- ✅ **M1: line buffering 戦略の経路別分担**
  §1.2 に経路別の表が新設され、non-follow は `FileHandle.createReadStream() + readline.createInterface`、follow は `FileHandle.read()` + 自前 buffer と明示的に分担されている。§2.2 step 3 と §2.6.1 step 1〜4 の擬似コードも上記の分担に整合。共通化を試みない理由（rotate 制御と `readline` の lifecycle 衝突）も §1.2 末尾に書かれており、Implementer が片寄せの誘惑に駆られない構造。

- ✅ **M2: i18n の help_events 方針**
  §1.1 i18n.ts の修正対象記述に「ja blob は en と同一英語文を流用」と明示。§5.2 でも同じ方針が二重に書かれている（既存 `help_status` の慣行と整合）。ja 環境で fallback / 欠落が起きない構造。

- ✅ **M3: `cmdEvents()` の `process.exit` / `finally` 修正**
  §5.1 の擬似コードが「`try` 内では `runEventsCli` のみ呼び、`finally` で listener 解除、try/finally の **外** で `process.exit(exitCode)` を呼ぶ」形に書き換わっており、`process.exit` 後 `finally` 未実行問題が解消。代替案（switch 後段で一括 exit）も段落末で言及されており、Implementer が既存慣行（`cmdStatus` / `cmdTraceTask`）と整合させる根拠も明示。

- ✅ **M4: writer 17 event vs spec §5 16 event の不一致への対応方針**
  §2.5.3 / §6.10 の二箇所で「**writer 実装を真値とし、spec §5 修正は T361 / docs-sync の責務であり本タスクの scope 外**」と明示。writer 真値の正当化（T392 の add-only 経緯、CLI が writer 出力 100% を扱えなければ debug 用途で穴が空く）も §6.10 末尾に補強されている。retro 連携トリガーとしての位置付けも明示。

#### 新規 Major

なし。

### Minor

#### 前回 Minor の反映状況（すべて解消）

- ✅ **m1: `runEventsCli` の戻り値型 `Promise<number>`**
  §1.1 シグネチャ例 (`export function runEventsCli(opts: RunEventsCliOpts): Promise<number>;`)、§1.1 修正対象記述（"runEventsCli(opts): Promise<number> を export し、exit code を返す"）、§5.1（"`runEventsCli` は `Promise<number>` (exit code) を返す"）の 3 箇所で明示。

- ✅ **m2: `< 2` schema skip の根拠**
  §6.6 で「spec §4『並行 schema は維持しない』と明記」を引いて整合性を補強。「writer が v2 に統一された後に v1 以下が混入する経路は通常存在せず、観測時は **不正データ** として扱う」とする論理が筋が通る。

- ✅ **m3: SIGINT exit code 0 の判断**
  §6.5 で「test 容易性のため 0 を初期実装、必要なら follow-up で 130 に変更可能」と Implementer 判断の余地を明示的に残してある。test 書き換えコストの低さも明記されており、後戻りの障壁を下げてある。

- ✅ **m4: `pollIntervalMs` を env でなく option injection に**
  §2.6.1 末尾、§3.2.1、§6.11 の三箇所で「option injection (`pollIntervalMs?: number`) 採用、env (`CMUX_TEAM_EVENTS_POLL_MS`) は採用しない」と確定。理由（test の env leak / cleanup 責務、help / docs 文書化責務、production code path への影響）も §6.11 に列挙。

- ✅ **m5: `--types ""` の扱い**
  §2.3 で「empty Set（`--types ""` や `--types ", ,"`）は **引数エラー扱い**（exit 1）」に方針転換。「**選択の根拠（plan として確定）**」段落で「all pass にすると意図的 0 件出力期待 / シェル変数展開バグ黙殺の区別がつかなくなる、strict に弾く方が予想可能性が高い」と論理を明示。help blob (§5.2) の `--types <list>` 説明にも `(empty list "" / ", ," is rejected with exit 1)` と注記済み。

- ✅ **m6: text format escape regex の具体化**
  §6.2 で `/[\s="\\]/` を明示。各文字の escape 必要性（`\s`：空白系、`=`：区切り、`"`：quote 内裸、`\\`：再解釈混乱）も列挙されており、test 設計が容易。

- ✅ **m7: rotate 時の重複出力許容が help にも反映されている**
  §5.2 help blob Notes に `--follow re-opens the file after rotate (inode change or size shrink), re-emitting from the new file's head; the consumer must dedupe if needed.` と記載済み。§2.6.2 と整合。

- ✅ **m8: dispatcher 配置位置の行番号削除**
  §1.3 / §5.1 から行番号 (`main.ts:5506` 等) が完全に削除され、「`case "trace-hooks":` の直後、`case "conductor":` の直前 (行番号は変動するため構造で特定)」と構造で特定する形に統一。完了条件チェックリスト §5.1 にも「行番号削除」が明記されている。

#### 新規 Minor（Implementer 判断レベル、Approved には影響しない）

- [ ] **m9: §5.1 `cmdEvents()` 内の `hasHelpFlag()` と §2.1 の `--help` パーサが二重定義の可能性**
  §5.1 擬似コード冒頭で `if (hasHelpFlag()) showHelp(t("help_events"));` を呼んでいるが、§2.1 の引数パーサ表でも `--help` / `-h` を扱う前提になっている。`hasHelpFlag()` が main.ts 側の既存 helper（top-level の `--help` を検出する）であれば問題ないが、`runEventsCli` 内で再度 `--help` を見る場合は二重 parse になる。Implementer は main.ts の `hasHelpFlag()` の現状実装を確認し、`cmdEvents` での help short-circuit と `runEventsCli` 内 parser のどちらか一方に寄せること。設計の論理上はどちらでも動くため Approved 障害ではない。

- [ ] **m10: §5.1 `args.slice(1)` の起点**
  「`args.slice(1)`（"events" 自身を除く）」とあるが、main.ts 側の既存変数 `args` がどこ起点（`process.argv.slice(2)` か、または既に subcommand 名を含まない slice 済みか）かによっては slice(1) 不要 / 過剰の可能性がある。Implementer は main.ts の既存 dispatcher（`case "trace-hooks":` 周辺の `cmdTraceTask` 等）が `args` をどう扱っているかを確認し整合させる。これも論理上の Approved 障害ではない。

- [ ] **m11: writer mapping 表の field 順序が writer 側と一部不一致**
  §2.5.3 mapping 表は出力順を「order 固定」と書きつつ、`task_sync_guard_rejected` が writer 側 (`task_id`, `kind`, `detail`, `main_branch`) と plan (`task_id`, `kind`, `main_branch`, `detail`) で順が違う。設計上は plan 側の順で固定すれば test も書けるため問題は出ないが、writer 型と一致させた方が後続の docs-sync で混乱しない。微小なので Implementer 判断で OK。

---

## Recommendations

なし（Approved）。

m9 / m10 / m11 はすべて Implementer 判断レベルの細部であり、Phase 3 で実装中に解消できる粒度。plan の再修正は不要。

---

## Approved の場合

**Phase 3（Implementer）に進めてよい。**

実装着手にあたり、以下を Implementer に共有しておくと迷いが減る:

1. **TDD の進め方**: §3.2.2 の 11 ステップ（red→green→refactor）を順守。test #12 / #13 (follow 系) は §3.2.1 のとおり初版では optional 扱い。
2. **mapping 表の field 順**: §2.5.3 の表を test fixture / formatter 実装の唯一の真値として扱う（writer 型との微妙な順序差は plan 表に合わせて固定）。
3. **i18n**: `help_events` を ja / en の両 messages blob に **同一英語文** で追加。`help_main` の subcommand 一覧にも `events` 行を追加（§5.2 末尾）。
4. **行番号 anchor 禁止**: dispatcher 配置は構造で特定（`case "trace-hooks":` の直後、`case "conductor":` の直前）。
5. **option injection**: `pollIntervalMs?: number` のみ、env 経由は実装しない。
6. **SIGINT exit code**: 初版は 0（test 容易性優先）。130 への変更は follow-up タスク扱い。

writer 真値 / spec stale の指摘（§6.10）は retro で T361 / docs-sync 連携トリガーとして扱う。本タスク内では spec §5 を変更しないこと。
