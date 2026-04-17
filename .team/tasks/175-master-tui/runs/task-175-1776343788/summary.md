# T175 Task Summary — Master の稼働中ステータス (スピナー) を TUI に反映

## 完了フェーズ
- **Phase 1 (Plan)**: Planner Agent により plan.md 作成
- **Phase 3 (Impl)**: Implementer Agent が TDD で実装
- **Phase 4 (Inspection)**: Inspector Agent が独立セッションで検品 → **GO**

## 設計判断（Planner 発見）

タスク本文の前提が古く、T211 で案B（`POST /master-state` 経由）はすでに実装済みだった。Planner は状況を再分析し、**案A+案B のハイブリッド**が最適と判断:

- **案A** (SessionStart/End hook): `masterPid` 取得 + 死亡検知に必須
- **案B** (UserPromptSubmit/Stop → /master-state): busy 切り替えのトリガーに必須
- 両者は補完関係で、どちらも必要

加えて案B の既存実装は `notifyStateChanged()` を呼んでいなかった（TUI refresh 不安定）、`/master-state` にログが無かった（検証不能）という2つの欠陥を発見して合わせて修正。

## 変更ファイル（5 files, +219 lines）

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | `generateMasterSettings` に SessionStart/SessionEnd hook 追加、`cmdLaunchMaster` で `CMUX_SURFACE` defensive 設定 + `master_spawn_surface` ログ |
| `skills/cmux-team/manager/proxy.ts` | `/master-state` ハンドラで `notifyStateChanged()` 呼び出し追加（busy/idle/prompt の 3 branch）、`master_state` ログ追加 |
| `skills/cmux-team/manager/main.test.ts` | Master SessionStart/SessionEnd hook 構造テスト 4 件追加 |
| `skills/cmux-team/manager/proxy.test.ts` | `/master-state` notifyStateChanged + log 検証テスト 5 件追加 |
| `package-lock.json` | `bun install` による整合性修正 |

## 検証結果

- `bun test` (manager 全件): **377 pass / 0 fail / 815 expect**
- `bunx tsc --noEmit --project skills/cmux-team/manager`: **EXIT=0（型エラーゼロ）**
- EventBus ポリシー遵守: `bus.emit`/`bus.on` 直接呼び出し **0 件**
- command 文字列: Conductor の `generateConductorSettings` と完全一致

## Inspector 判定

**GO** — Critical 0 件、Minor 2 件のみ（行番号のわずかな食い違い、`eventBus` import 関係の補足）

## 残課題 (deferred)

**手動 E2E 検証**（plan.md サブタスク 6）— Implementer では実行不能のため deferred:

1. `cmux-team stop && cmux-team start` で daemon + Master 再起動
2. Master に長いプロンプトを投げ、TUI ダッシュボードでスピナーが回ることを目視
3. 応答完了後 `● [num]` 緑円に戻ることを確認
4. `manager.log` に `master_session_started` / `master_state status=busy` / `master_state status=idle` / (kill 時) `master_session_ended` が記録されていることを確認

これはリリース後にユーザーが `npm install -g @hummer98/cmux-team` → `cmux-team start` で実施する想定。

## マージコミット

Merge commit: `213a291` (→ main)
