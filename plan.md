# 実装計画書: Conductor 実装系タスクフロー4フェーズ刷新

## 1. 概要

### 目的

Conductor の実装系タスクフローを **Plan → Design Review → TDD Implementation → Inspection** の4フェーズに刷新する。sdd-orchestrator の仕様駆動開発（SDD）パターンを cmux-team の4層アーキテクチャに適合させ、「生成と批評の分離」「フロー分岐」を実現する。

### 影響範囲

- テンプレート: 4ファイル改修（planner, design-reviewer, implementer, inspector）、2ファイル削除（tester, reviewer）
- conductor-role.md: フェーズ実行セクションの全面改訂
- Manager daemon（conductor.ts, template.ts）: Agent プロンプト生成の仕組みに**変更なし**（Conductor が自律的にフェーズを進行するため）

### 前提条件

- tester.md, reviewer.md は既に存在しない（削除済み）
- planner.md, design-reviewer.md, inspector.md は既に存在し、基本構造が整っている
- conductor-role.md には既に4フェーズのフロー定義が記載されている

## 2. 現状分析

### 既存ファイルの状態

| ファイル | 状態 | 問題点 |
|---------|------|--------|
| `conductor-role.md` | 4フェーズのフロー定義あり | フロー分岐の判断基準が曖昧（「いずれかに該当すれば中規模以上」のみ）。Design Review の「Changes Requested → 再 Plan」のループ仕様が簡素。Inspection の NOGO 時の修正指示伝達方法が未定義 |
| `planner.md` | 基本構造あり | sdd-orchestrator の知見（Decision Log、メソッド制約、削除タスク必須ルール）が未反映。サブタスク分割の粒度指針がない |
| `design-reviewer.md` | 5観点のレビュー定義あり | sdd-orchestrator の CRITICAL チェック項目（受理基準→タスクカバレッジ、統合テスト、リファクタリング完全性）が未反映。Approved/Changes Requested の判定基準が未定義 |
| `implementer.md` | TDD サイクル定義あり | テスト基盤なし時のフォールバックが弱い。plan.md のサブタスクとの連携方法が未定義。cmux-team 固有のテスト方法（E2E 手動テスト）への対応不足 |
| `inspector.md` | GO/NOGO 判定基準あり | sdd-orchestrator の8カテゴリと比べ5観点で簡素。メソッド制約検証、削除タスク検証、配線タスク検証が未実装 |
| `tester.md` | 存在しない | 削除済み（TDD により Implementer に統合済み） |
| `reviewer.md` | 存在しない | 削除済み（Design Reviewer + Inspector に分割済み） |

### 根本問題

現在のテンプレートは「骨格は正しいが肉付けが足りない」状態。sdd-orchestrator で実運用を通じて得られた以下の知見が未反映:

1. **計画の具体性不足**: サブタスクに「使用すべきメソッド・クラス」の制約がないため、Implementer が自由裁量で実装し、結果的に既存パターンから逸脱する
2. **レビューの判定基準不足**: Approved/Changes Requested の境界が曖昧で、レビューが「意見交換」に堕する
3. **検品の検証力不足**: コードの存在確認（grep）を行わないため、「計画にあるが実装されていない」を検出できない
4. **フロー分岐の粒度不足**: 「軽微/中規模以上」の2段階では、ドキュメント修正にも全4フェーズが適用されうる

## 3. 変更計画

### 3.1 templates/planner.md — 計画立案の強化

**方針**: sdd-orchestrator の spec-tasks.md の知見（メソッド制約、削除タスク必須、並列実装禁止）を取り込む。

**変更内容**:

#### a. サブタスク分割セクションの強化

現在:
```markdown
### 4. サブタスク分割
- 実装順序を考慮した作業リスト
- 各サブタスクの完了条件
```

変更後:
```markdown
### 4. サブタスク分割

実装順序を考慮した番号付き作業リスト。各サブタスクには以下を含める:

- **タスク名**: 何をするか（動詞で始める）
- **対象ファイル**: 変更するファイルパス
- **完了条件**: 検証可能な条件
- **メソッド制約**（該当する場合）: 使用すべき既存の関数・クラス・パターン
  - 例: 「`cmux.send()` を使用してプロンプトを送信する」
- **検証コマンド**（該当する場合）: `grep` 等で確認できるパターン

#### サブタスクのカテゴリ

1. **実装タスク**: 新規ロジック・コンポーネント・サービスの作成
2. **配線タスク**: 既存ファイルの import 更新・エントリーポイント接続
3. **削除タスク**: 旧実装の物理削除（ファイル削除・未使用コード除去）

#### 制約

- **並列実装禁止**: 旧実装と新実装を並行させない。「Replace X with Y」なら「Delete X」タスクを含めること
- **削除タスク必須**: リファクタリングで不要になるコードは明示的に削除タスクを作成すること
```

#### b. Decision Log セクションの追加

```markdown
### 6. Decision Log

計画策定中に行った設計判断を記録する。

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | ... | ... | ... |
```

### 3.2 templates/design-reviewer.md — レビュー判定基準の明確化

**方針**: 「意見交換」ではなく「合否判定」として機能するよう、判定基準と CRITICAL チェック項目を追加。

**変更内容**:

#### a. CRITICAL チェック項目の追加（レビュー観点セクション内）

```markdown
### 6. CRITICAL チェック項目

以下は漏れると実装フェーズで必ず問題になる項目。1つでも該当すれば Changes Requested とする:

- **サブタスクカバレッジ**: plan.md の全変更対象が、サブタスクとして分割されているか（実装タスクだけでなく配線・削除タスクも）
- **統合テスト/検証**: コンポーネント間の接続を検証するサブタスクが存在するか
- **削除タスクの完全性**: 旧実装を置き換える場合、旧コードの削除タスクが含まれているか
- **既存テストへの影響**: 既存テストが壊れる可能性がある場合、修正タスクが含まれているか
```

#### b. Approved/Changes Requested の判定基準を明記

```markdown
## 判定基準

- **Approved**: Critical findings 0件 AND 全 CRITICAL チェック項目パス
- **Changes Requested**: Critical findings 1件以上 OR CRITICAL チェック項目に不合格あり

Minor findings のみの場合は Approved とし、Recommendations に改善提案を記載する。
```

### 3.3 templates/implementer.md — cmux-team 固有のテスト対応

**方針**: cmux-team プロジェクトは自動テストフレームワークを持たない（E2E 手動テスト）。テスト基盤がない場合のフォールバックを強化し、plan.md のサブタスクとの連携を明確にする。

**変更内容**:

#### a. サブタスク実行セクションの追加

```markdown
## サブタスク実行

plan.md のサブタスクを番号順に実行する。各サブタスクに対して:

1. サブタスクの内容を確認
2. メソッド制約がある場合、指定されたメソッド・パターンを使用
3. TDD サイクル（下記）を適用
4. 完了条件を検証
5. 検証コマンドがある場合、実行して結果を記録
```

#### b. テスト基盤がない場合のフォールバック強化

現在:
```markdown
## テスト基盤がない場合のフォールバック

自動テストフレームワークが存在しない場合:
1. 手動検証手順を plan.md のリスク欄に基づいて作成
2. 各検証手順を実行し、結果を記録
3. 検証結果を出力ファイルに含める
```

変更後:
```markdown
## テスト基盤がない場合のフォールバック

自動テストフレームワークが存在しない場合、TDD の RED/GREEN を以下に読み替える:

### RED → 検証手順の定義
- plan.md のリスク欄・完了条件に基づき、検証すべき項目をリストアップ
- 各検証項目に対して具体的な確認コマンドまたは手順を記述
- 例: `grep -r "oldFunction" src/` → 0件であること（旧関数が除去されていること）
- 例: `bun run skills/cmux-team/manager/main.ts status` → エラーなく実行できること

### GREEN → 実装 + 検証実行
- 実装を行い、定義した検証手順を全て実行
- 検証結果（コマンド出力）を記録

### REFACTOR → コード整理
- 通常通り

### VERIFY → 全検証再実行
- 新規検証と、変更に関連する既存の動作確認を再実行
- TypeScript の場合: `bun build` または型チェックでコンパイルエラーがないことを確認
```

#### c. 出力セクションの TDD Cycles を検証結果対応に更新

```markdown
## 出力

{{OUTPUT_FILE}} に以下を書き出す:
- ## Completed Tasks（サブタスク番号 + タスク名）
- ## Files Changed（パス + 変更概要）
- ## TDD Cycles / Verification Results
  - テストフレームワークあり: 各サイクルの RED/GREEN/REFACTOR/VERIFY 結果
  - テストフレームワークなし: 各検証項目の手順と結果
- ## Issues Encountered（あれば）
```

### 3.4 templates/inspector.md — 検証力の強化

**方針**: sdd-orchestrator の spec-inspection から、cmux-team に適用可能な検証手法を取り込む。特にコード存在確認（grep 検証）と削除タスク検証。

**変更内容**:

#### a. 検品観点の強化（既存5観点を拡充）

観点1「計画充足」に grep 検証を追加:
```markdown
### 1. 計画充足（Critical if 未実装）
- plan.md の各サブタスクが実装されているか
- 変更対象ファイルが全て変更されているか（`git diff --name-only` で確認）
- サブタスクが全て完了しているか
- **メソッド制約の検証**: plan.md にメソッド制約がある場合、`grep` で該当パターンが実装に存在するか確認
- **削除タスクの検証**: 削除対象のファイル・コードが物理的に削除されているか確認（`find` / `grep` で不在を確認）
```

観点5「統合」を強化:
```markdown
### 5. 統合（Critical if 未接続）
- エントリーポイントが正しく接続されているか
- import パスが正しいか
- 設定ファイルの更新が漏れていないか
- **配線タスクの検証**: 新規コンポーネントが消費者ファイルから正しく参照されているか（`grep` で確認）
- **TypeScript コンパイル**: `bun build` または型チェックでエラーがないか
```

#### b. NOGO 時の修正指示フォーマット

```markdown
## Fix Required（NOGO の場合のみ）

番号付きの具体的な修正指示。Implementer が修正できるよう以下を含める:
- **対象ファイル**: 修正するファイルパス
- **問題**: 何が問題か
- **期待する状態**: どうなっていれば正しいか
- **検証方法**: 修正後に確認するコマンド
```

### 3.5 templates/conductor-role.md — フロー分岐ロジックの精緻化

**方針**: 「軽微/中規模以上」の2段階を3段階に拡張し、フロー深度を変える。

**変更内容**:

#### a. フロー分岐セクションの改訂

現在:
```markdown
### フロー分岐

タスクの複雑度を判断し、適切なフローを選択する:

- **軽微**（typo, 設定変更, ドキュメント修正）→ Phase 3（Implementer）のみ
- **中規模以上**（機能追加, バグ修正, リファクタリング）→ 全4フェーズ
```

変更後:
```markdown
### フロー分岐

タスクの複雑度を判断し、適切なフロー深度を選択する:

| レベル | 条件 | フロー |
|--------|------|--------|
| **軽微** | typo, 設定値変更, コメント修正, 単一ファイルのドキュメント修正 | Phase 3（Implementer）のみ |
| **中規模** | 単一機能のバグ修正, 既存パターンに沿った小規模追加, テンプレート修正 | Phase 1（Plan）→ Phase 3（Impl）→ Phase 4（Inspection） |
| **大規模** | 新機能追加, 複数ファイルにまたがるリファクタリング, 設計判断を伴う変更, API/インターフェース変更 | 全4フェーズ（Plan → Design Review → Impl → Inspection） |

判断基準（1つでも該当すれば上のレベルに格上げ）:
- コード変更が3ファイル以上 → 大規模
- 設計判断（「AかBか」の選択）が必要 → 大規模
- 既存のインターフェースや振る舞いが変わる → 大規模
- コード変更を伴うが上記に該当しない → 中規模
- コード変更を伴わない → 軽微
```

#### b. Design Review ループの仕様明確化

現在:
```markdown
3. レビュー結果を確認:
   - **Approved** → Phase 3 に進む
   - **Changes Requested** → Planner Agent を再 spawn して修正、再レビュー（最大2往復）
```

変更後:
```markdown
3. レビュー結果を確認:
   - **Approved** → Phase 3 に進む
   - **Changes Requested** →
     a. Design Reviewer の出力ファイルから Recommendations を読み取る
     b. Planner Agent を再 spawn し、プロンプトに「前回の plan.md」+「レビュー指摘事項」を含める
     c. 更新された plan.md を再度 Design Reviewer に投入
     d. 最大2往復。2往復後も Changes Requested なら、最新の plan.md で Phase 3 に進む（ログに警告記録）
```

#### c. Inspection NOGO ループの仕様明確化

現在:
```markdown
3. 検品結果を確認:
   - **GO** → 完了処理に進む
   - **NOGO** → Implementer Agent を再 spawn して修正指示、再検品（最大2回）
```

変更後:
```markdown
3. 検品結果を確認:
   - **GO** → 完了処理に進む
   - **NOGO** →
     a. Inspector の出力ファイルから Fix Required を読み取る
     b. Implementer Agent を再 spawn し、プロンプトに「plan.md」+「修正指示」を含める
     c. 修正後、Inspector Agent を再 spawn して再検品
     d. 最大2往復。2往復後も NOGO なら、ログに Critical findings を記録し、完了処理に進む（summary.md に NOGO 状態を明記）
```

## 4. フロー分岐ロジック

### 判定フローチャート

```
タスクを受け取る
  │
  ├─ コード変更を伴わない？ ──── Yes ──→ 軽微 → Implementer のみ
  │
  ├─ 以下のいずれかに該当？
  │   ・3ファイル以上の変更
  │   ・設計判断が必要
  │   ・インターフェース変更
  │   ・新機能追加
  │
  │   Yes ──→ 大規模 → Plan → Design Review → Impl → Inspection
  │
  └─ No ──→ 中規模 → Plan → Impl → Inspection
```

### Conductor の判断タイミング

1. タスク受信時にタスクファイルを読む
2. 上記フローチャートに基づきレベルを判定
3. 判定結果をログに記録: `log("flow_decision", "task_id=xxx level=large reason=多ファイル変更")`
4. 判定に基づきフェーズを順次実行

### フェーズ間のデータフロー

```
Phase 1 (Plan)
  → plan.md（worktree 内に作成、git commit）
  
Phase 2 (Design Review)
  ← plan.md を入力として読み取り
  → review.md（OUTPUT_DIR に出力）
  → Approved: そのまま Phase 3 へ
  → Changes Requested: plan.md を更新して再レビュー

Phase 3 (Implementation)
  ← plan.md を入力として読み取り
  → 実装コード（worktree 内で変更、git commit）
  → impl-result.md（OUTPUT_DIR に出力）

Phase 4 (Inspection)
  ← plan.md + git diff を入力として読み取り
  → inspection.md（OUTPUT_DIR に出力）
  → GO: 完了処理
  → NOGO: 修正指示を Implementer に伝達
```

## 5. 変更ファイル一覧

| ファイル | 操作 | 変更概要 |
|---------|------|---------|
| `skills/cmux-team/templates/planner.md` | **改修** | サブタスク分割の強化（メソッド制約・カテゴリ・制約ルール）、Decision Log 追加 |
| `skills/cmux-team/templates/design-reviewer.md` | **改修** | CRITICAL チェック項目追加、判定基準の明確化 |
| `skills/cmux-team/templates/implementer.md` | **改修** | サブタスク実行セクション追加、テスト基盤なし時のフォールバック強化 |
| `skills/cmux-team/templates/inspector.md` | **改修** | grep 検証・削除タスク検証・配線タスク検証の追加、NOGO 修正指示フォーマット追加 |
| `skills/cmux-team/templates/conductor-role.md` | **改修** | フロー分岐を3段階に拡張、Design Review / Inspection ループ仕様の明確化 |
| `docs/spec/04-templates.md` | **改修** | テンプレート仕様書をフロー変更に合わせて更新 |
| `CLAUDE.md` | **改修** | テンプレート変数表の更新（新変数があれば追加） |

**削除対象:**
- `templates/tester.md` — 既に存在しない（確認済み）
- `templates/reviewer.md` — 既に存在しない（確認済み）

**変更不要:**
- `skills/cmux-team/manager/conductor.ts` — Conductor がフェーズを自律実行するため、daemon 側のロジック変更は不要
- `skills/cmux-team/manager/template.ts` — テンプレート変数の追加がないため変更不要
- `skills/cmux-team/templates/common-header.md` — 変更なし
- `skills/cmux-team/templates/conductor-task.md` — 変更なし

## 6. リスクと注意点

### 既存機能への影響

- **conductor-role.md のフロー分岐変更**: 現在「軽微/中規模以上」の2段階を3段階にするため、「中規模」タスクの挙動が変わる。従来は全4フェーズだったものが Plan → Impl → Inspection の3フェーズになる。Design Review をスキップすることで速度は向上するが、設計品質が低下するリスクがある
  - **緩和策**: 中規模の定義を保守的にし、迷ったら大規模に格上げするルールを明記

### テスト戦略

- cmux-team は自動テストフレームワークを持たない
- 検証方法:
  1. テンプレートファイルの構文確認（Markdown として正しいか）
  2. テンプレート変数の整合性確認（`{{VARIABLE}}` が template.ts の展開ロジックと一致するか）
  3. 実際の `cmux-team start` + タスク実行で E2E テスト

### 互換性

- テンプレートの変数名は既存のまま（`{{PLAN_CONTENT}}`, `{{TASK_CONTENT}}`, `{{OUTPUT_FILE}}` 等）
- conductor-role.md の Agent 起動手順・監視ループ・完了時の処理は変更しない
- 既に削除済みの tester.md / reviewer.md を参照している箇所がないか確認が必要

### Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | フロー分岐を2段階のままにするか3段階にするか | 3段階（軽微/中規模/大規模） | 2段階では「テンプレートの1行修正」にも全4フェーズが適用されうる。中規模では Design Review をスキップし、速度と品質のバランスを取る |
| D2 | sdd-orchestrator の8カテゴリ検品を全て取り込むか | 5観点を維持し、grep 検証等の手法のみ取り込む | cmux-team は Electron アプリと異なり、ロギングガイドライン準拠やE2Eパイプライン等は不要。観点を増やすより各観点の検証力を上げる |
| D3 | Manager daemon 側にフロー分岐ロジックを実装するか | しない（Conductor の自律判断に委ねる） | 設計原則「決定論的なものはコードで、判断が必要なものは AI で」に基づく。タスク複雑度の判断は AI の判断領域 |
| D4 | メソッド制約（_Method: / _Verify:）のフォーマットを sdd-orchestrator と同じにするか | より簡素な自然言語形式にする | cmux-team のタスクは sdd-orchestrator ほど構造化されていない。厳密なフォーマットより、Planner が読みやすい自然言語で記述する |
