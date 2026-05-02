---
id: A027
type: research
title: "Corpus2Skill 論文に基づく dockeeper リプレース可否の検討"
created: 2026-05-02T00:00:00+09:00
author: master
tags: [dockeeper, docs-spec, ai-readable-docs, corpus2skill, navigation, research]
references:
  - "Sun, Wei, Hsieh. \"Don't Retrieve, Navigate: Distilling Enterprise Knowledge into Navigable Agent Skills for QA and RAG.\" arXiv:2604.14572v2, 29 Apr 2026. Code: https://github.com/dukesun99/Corpus2Skill"
---

## 1. 解いている問い

> 仕様書 (`docs/spec/`) は **人間が読む** ためではなく **AI が正しく理解する** ためのものであるべき。
> 人間はオンデマンドに必要な軸の要約を読めばいい。
> Corpus2Skill (arXiv 2604.14572) のアプローチで dockeeper をリプレースすべきか?

結論を先に述べる:

**完全リプレースはしない。設計原則を輸入して dockeeper のスコープを拡張する。**

理由は規模・性質・更新頻度のミスマッチ、および「論文がレコメンドする条件」を docs/spec が **部分的にしか満たしていない** こと。詳細は §4 / §5。

---

## 2. Corpus2Skill の中核アイディア

### 2.1 アプローチ

| 観点 | RAG (従来) | Corpus2Skill |
|------|-----------|-------------|
| primitive | retrieve (passive) | navigate (active) |
| index | flat vector store | filesystem hierarchy of skill files |
| agent visibility | ブラックボックス | corpus 全体の bird's-eye view |
| backtrack | 不可能 | unproductive branch から離脱可 |
| cross-branch synthesis | 困難 | 複数 subgroup を combine 可能 |

### 2.2 構造 (Figure 2)

```
docs root
├── SKILL.md             # root cluster, frontmatter (name, description, level, num_documents)
│                          + Sub-groups listing + cluster summary
├── group-XX/
│   ├── INDEX.md         # sub-cluster, < 2KB, list of leaf doc IDs + brief summary
│   └── ...
└── documents.json       # full document text store, ID で参照
```

- **SKILL.md / INDEX.md は < 2KB**: routing 専用、要約 + 子ノードのリストのみ
- **YAML frontmatter**: `name, description, level, num_documents` で agent が「どの枝に降りるか」を判断
- **2 つの tool だけで navigate**: `code_execution` (view SKILL.md/INDEX.md) と `get_document(doc_id)`
- **Progressive disclosure**:
  1. metadata (startup): skill name + one-line description (< 100 tokens each)
  2. instructions (on demand): full SKILL.md
  3. resources (as needed): full document via `get_document`

### 2.3 Compile phase (オフライン1回)

1. Document loading + sentence embedding (Qwen3-Embedding-0.6B)
2. Iterative bottom-up K-Means clustering (branching ratio p=10, top-level K=7)
3. LLM が各 cluster を 2–3 文で要約 + 2–5 word の filesystem-safe label を生成
4. Skill tree を filesystem として materialize

### 2.4 評価結果 (WixQA: 6,221 docs / 200 expert queries)

| Method | F1 | Factuality | CtxR | $/q |
|--------|------|-----------|------|------|
| BM25 | 0.342 | 0.470 | 0.386 | 0.007 |
| Dense | 0.363 | 0.536 | 0.450 | 0.008 |
| RAPTOR | 0.389 | 0.675 | 0.616 | 0.012 |
| Agentic | 0.381 | 0.719 | 0.498 | 0.088 |
| **Corpus2Skill** | **0.468** | **0.739** | **0.673** | 0.089 |

prompt caching ON で Agentic とほぼ同コスト。Sonnet 4.6 → Haiku 4.5 入替で 91% の F1 を保ちつつ $/q が 29% 減。

### 2.5 論文が明示する適用条件 (§4.4 + §5)

**Corpus2Skill が勝つ条件**:
- (i) Atomic, topically-coherent documents (1 doc = 1 feature/entity)
- (ii) Document granularity 0.5–3k characters
- (iii) Recoverable implicit taxonomy

**flat retrieval に負ける条件**:
- Open-domain pools where retrieval recall is the bottleneck (CovidQA, ExpertQA)
- Long extractive documents (CUAD ≈ 7,500 chars/doc)
- Homogeneous tabular corpora (TatQA, top-level cluster summary が collapse)

---

## 3. dockeeper の現状

### 3.1 役割 (skills/dockeeper/SKILL.md)

実装が先行し docs/README が遅れる diff を検出して同期する。

対象:
- `docs/spec/*.md` (12 ファイル + glossary)
- `README.md` / `README.ja.md`
- `skills/cmux-team-guide/SKILL.md`

入力ソース: `git log <last_docs_commit>..HEAD -- skills/ commands/ bin/` + closed タスク。

### 3.2 現状の docs/spec/ 構造

| ファイル | lines | 概観 |
|---|---:|---|
| `00-project-overview.md` | 147 | 概要・4 層 |
| `01-skill-cmux-team.md` | 248 | cmux-team スキル仕様 |
| `02-skill-cmux-agent-role.md` | 168 | Agent 行動規範 |
| `03-commands.md` | 189 | スラッシュコマンド |
| `04-templates.md` | **536** | テンプレート変数 |
| `05-install-and-infrastructure.md` | **434** | インストール・インフラ |
| `06-implementation-tasks.md` | 353 | 実装タスク |
| `07-state-machine.md` | 387 | FSM・cascade |
| `08-runtime-boundary.md` | 135 | Deliverable・close-task |
| `09-token-pool.md` | **632** | token pool |
| `10-events-stream.md` | 351 | events stream |
| `11-metrics.md` | **781** | metrics taxonomy |
| `glossary.md` | 186 | 用語インデックス |

### 3.3 dockeeper が「やっていない」こと

- spec ファイルの **AI 向け要約 / frontmatter** の維持
- spec ファイルが **AI が一発で navigate できる構造** になっているかの検査
- 長くなりすぎた spec の **分割提案**
- ファイル間の **依存関係 / 参照グラフ** の整合性検査

現状の dockeeper は「人間 author が書いた docs の差分検出と更新」に最適化されており、AI navigation 観点の品質はノータッチ。

---

## 4. cmux-team docs/spec/ と Corpus2Skill 適用条件の照合

| 条件 | docs/spec/ | 判定 |
|---|---|---|
| (i) Atomic, topically-coherent | 章単位は概ね atomic (state-machine, token-pool, metrics 等)。ただし `04-templates`、`05-install` は複数トピック混在 | **△** (大半は OK、一部分割推奨) |
| (ii) Granularity 0.5–3k chars | 平均的なファイルは 4–10 KB。`09-token-pool` (632 行)、`11-metrics` (781 行)、`04-templates` (536 行) は **論文の sweet spot を 5–10 倍超過** | **×** (論文の Long extractive failure mode に近づく) |
| (iii) Recoverable implicit taxonomy | `glossary.md` が手動で taxonomy を提供済み | **◎** |

### 4.1 規模のミスマッチ

- WixQA: **6,221 documents** → K=7 root cluster × p=10 branching で 3 階層
- cmux-team docs: **~16 documents** → K-Means clustering の出番なし。glossary がすでに taxonomy
- Compile phase の embedding + K-Means + LLM summarization パイプラインは過剰

### 4.2 性質のミスマッチ

| 項目 | Corpus2Skill 前提 | cmux-team docs/spec/ |
|---|---|---|
| Author | LLM (compile time) | 人間 + AI hybrid |
| Mutation | 静的 (recompile required) | 実装と一緒に頻繁に変わる |
| Truth source | 文書群そのもの | **コード**が真。spec はコードに従属 |
| Failure mode | LLM が wrong summary を書く | spec が実装と乖離する |

論文 §5 の Limitations にある "the system cannot reflect real-time corpus updates, risking stale or outdated answers until recompilation occurs" は cmux-team では致命的。実装が日次で進化する前提ではバッチ recompile は破綻する。

### 4.3 それでも輸入すべき設計原則

| 原則 | cmux-team での具体化 |
|---|---|
| **Routing-oriented frontmatter** | 各 spec の冒頭に `name / description / topics / related / level` を YAML で配置 |
| **< 2KB navigation file** | `docs/spec/SKILL.md` (新設) を root navigation として < 2KB に保つ |
| **Progressive disclosure** | Conductor / Agent template 内で "まず SKILL.md を Read → 必要な spec のみ Read" のフローを明示 |
| **Atomic file = atomic topic** | 長すぎる `09-token-pool` / `11-metrics` / `04-templates` を sub-file 化 (例: `09a-token-cli.md`, `09b-token-db.md`) |
| **Filesystem-safe label** | 既に番号 + slug でやっている (改善余地小) |
| **Two-tool design** | Conductor / Agent は `Read` / `Grep` の 2 ツールだけで navigate 可能にする (=現状そのままで OK、構造を整えれば自然にそうなる) |

---

## 5. 判断: dockeeper をどうするか

### 5.1 リプレースしない

理由:
1. 規模が 16 docs vs 6,221 docs。K-Means + embedding は不要
2. docs/spec/ は **静的コーパスではなく実装に追従して mutate する**。バッチ recompile が破綻する
3. 真理値は **コード**。docs を corpus とした LLM 要約は二次資料の自動生成にすぎず、誤要約のリスクが導入コストを上回る
4. 人間 author を排除する設計上の必要性がない (むしろ意図的に維持したい)

### 5.2 dockeeper のスコープを拡張する (推奨)

**Phase A — navigation 構造の整備 (one-shot, 人間レビュー必須)**:

1. `docs/spec/SKILL.md` を新設
   - root navigation file (< 2KB)
   - frontmatter: `name: cmux-team-spec`, `description`, `topics`, `level`
   - 各 spec ファイルへの一行 description リンク (現 glossary §1〜§11 を凝縮)
2. 各 spec ファイルに YAML frontmatter を追加
   - `name, description (< 200 chars, AI が次に読むかを判断するための要約), topics, related, level`
3. 長すぎる 3 ファイルを atomic 分割
   - `09-token-pool.md` (632) → `09a-cli` / `09b-db-schema` / `09c-selection-algorithm` / `09d-config`
   - `11-metrics.md` (781) → `11a-taxonomy` / `11b-data-source` / `11c-snapshot` / `11d-cohort`
   - `04-templates.md` (536) → `04a-variables` / `04b-roles` / `04c-overlay`
4. `glossary.md` を `docs/spec/INDEX.md` 相当に再編 (frontmatter + 用語 → 一次リンクのみ、< 2KB を意識)

**Phase B — dockeeper に navigation 同期ステップを追加 (継続)**:

dockeeper の手順 §4「docs/spec および README と照合」の後に新設:

> ### 4.5 navigation 整合性チェック (新規)
>
> - `docs/spec/SKILL.md` の sub-link が実ファイルと一致するか
> - 各 spec の frontmatter `description` が実装と乖離していないか
> - 単一 spec が **2 KB の routing budget を超えるトピックを混載していないか** (混載していたら分割提案)
> - `related:` 参照が dead link になっていないか

**Phase C — Conductor / Agent template の修正 (継続)**:

`{{COMMON_HEADER}}` または各 role template に明示:

> docs/spec/ を参照する場合は **必ず最初に docs/spec/SKILL.md を Read し、frontmatter description で必要な章を選別してから個別ファイルを Read する**。一度に複数の spec を full read しない。

これによりトークン消費削減と、エージェントが「コーパス全体の地図」を持って判断する状態が両立する (論文の §3.1 Problem Setup と同じ動機)。

### 5.3 やらないこと

- LLM による spec 自動要約・再 cluster (= compile phase 自動化)
- embedding index 構築
- Anthropic Skills API への spec packaging (これは別の議論)

これらは「実装が真理値、docs はコードに追従して人間 + dockeeper が更新」という現体制を壊し、二次的な失敗モード (誤要約・stale snapshot) を導入する。

---

## 6. 優先順位の根拠

CLAUDE.md「タスクの優先順位」に照合:

| 優先順位 | 該当 | 備考 |
|---|---|---|
| 1. バグ修正 | × | 機能は壊れていない |
| 2. 実験で発見された問題の修正 | △ | docs が AI に読みづらいという問題は実運用で観測されているが定量化未 |
| 3. ユーザー体験の改善 | ○ | エージェントの読解効率 = ユーザーから見たレスポンスの質と速度に直結 |
| 4. ドキュメントの正確性 | ◎ | dockeeper の本領 |

提案: **バグ修正系の手が空いたタイミングで Phase A を 1 タスク化**。Phase B / C は spec sweep 後の継続改善として dockeeper のテンプレに織り込む。

---

## 7. オープンな疑問 (要確認)

1. **2 KB という routing budget は cmux-team でも適切か?** — Anthropic Skills API の制約 (8 skills/req, 200 files/skill, 30 MB/skill) は気にしなくていいが、Conductor/Agent の context window 圧縮効果は要計測。Phase A 後に metric (`agent message GC` 系) で前後比較する。
2. **glossary を SKILL.md に統合するか並存させるか** — glossary は人間用の用語辞典として有用。SKILL.md は AI 用の routing。並存し、SKILL.md → glossary の参照を張る案を推奨。
3. **README は対象外で良いか** — README は「初見のユーザー」の navigation。エージェント navigation 構造とは独立。dockeeper の README 同期ロジックは現状維持。
4. **CLAUDE.md は対象外で良いか** — CLAUDE.md はセッション開始時に常時 load される。SKILL.md の代替に近い役割を一部果たしている。CLAUDE.md と spec/SKILL.md の責務分担を明示する必要あり (例: CLAUDE.md = 守るべき制約 / spec/SKILL.md = 知りたいときに辿るインデックス)。

---

## 8. 次のアクション (検討用、未確定)

- [ ] ユーザー判断: Phase A を実行するタスクを切るか
- [ ] (実行する場合) `docs/spec/SKILL.md` の draft を 1 つ書いて proof-of-concept にする
- [ ] (実行する場合) 長尺 3 spec の分割スケッチを作る
- [ ] (実行する場合) dockeeper SKILL.md / commands/docs-sync.md に Phase B のステップ追加
- [ ] (実行する場合) `{{COMMON_HEADER}}` または role template に Phase C の navigation rule を追記

実装ではなく **検討** として artifact に記録した。リプレースではなく拡張という結論はユーザーに提示してから具体化する。
