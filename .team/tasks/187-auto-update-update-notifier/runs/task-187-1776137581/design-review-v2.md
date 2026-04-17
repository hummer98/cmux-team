# Design Review (v2): T187

## Verdict: Approved

前回 Recommendations 1〜7 はすべて plan.md v2 に反映されている。既存コードとの整合性（`main.ts:30,134,259,601,619-623`、`daemon.ts:61,132,1304` の削除／改名対象）も plan §2 の記述と一致。軽微な補足を 1 点挙げるが、Approved の妨げにならない範囲。

## 反映状況

| # | 指摘 | 状態 | 根拠（plan.md 行番号） |
|---|------|------|------------------------|
| 1 | **High-1** env `"0"`/`"false"` の source=env 維持 | ✅ | Step 4-3（L108-114）で `"0"\|"false"\|"off"` → off(source=env) を厳密化。テストマトリックス（L126-127）に `env=0` / `env=false` → off/env を明示追加。§6 互換表（L330）も整合 |
| 2 | **High-2** update-notifier API・ESM・configstore・fallback | ✅ | Step 1（L52-79）で `fetchInfo()` の戻り値を直接使う疎通コードに修正。ESM-only + default export 変更の注意（L66）、configstore ディスクキャッシュ（L67）、`simple-update-notifier` の API 形状（L68-78）を追記 |
| 3 | **Medium-1** 重複検出を kind ベース化 | ✅ | Step 6-1（L157-164）で frontmatter `kind: cmux-team-update` による重複検出、古い latest の open タスクは close + 再起票、assigned 状態は skip + ログのロジックを具体化。E2E マトリックス（L274-275）にも反映 |
| 4 | **Medium-2** `createTaskProgrammatic` 共通化を確定 | ✅ | §2（L32, L37）で `task.ts` を「変更あり」に格上げし `createTaskProgrammatic` 新設を確定。cmdCreateTask は薄いラッパーへリファクタ（L32）。Step 6-2（L165-175）で引数形状と kind 対応を明記 |
| 5 | **Medium-3** `docs/spec/` 更新漏れ | ✅ | §2（L41-43）と Step 11（L245-247）で `00-project-overview.md` / `05-install-and-infrastructure.md` / `06-implementation-tasks.md` の更新を明示 |
| 6 | **Medium-4** 廃止ログイベント + CHANGELOG 破壊的変更 | ✅ | Step 9 に「削除するログイベント」セクション（L213-216）、「フォーマット変更（破壊的）」セクション（L218-221）を追加。Step 11-6（L248-251）で CHANGELOG に破壊的変更として明記 |
| 7 | **Low-1〜4** createdTaskId / バナー仕様 / テスト追加 / self-update 異常系 | ✅ | `state.updateAvailable.createdTaskId?` を型に追加（L26, L92, L95）。Step 10（L223-233）でバナー文言・色・rateLimit との縦並列配置を詳細化。§4 自動テストに (a)(b)(c)(d) の 4 ケース追加（L260-263）。Step 8-2（L194-198）で self-update の fetchInfo 失敗／同版／run_after_all 競合／新版ありの 4 分岐を exit code 付きで定義 |

## 指摘事項（残存）

### [Severity: Info / Optional] `normalizeAutoUpdate(undefined)` と `resolveAutoUpdateMode` の二重定義

- Step 2-1（L88）で `normalizeAutoUpdate(undefined) → "off"` と定義されているが、Step 4-4（L117-118）では「config も未設定なら `{ mode: "off", source: "default" }`」と別経路でも `off` を返す。機能上は同一結果になるが、**どちらのパスで未設定を判定するか**が曖昧で、テストで「source が default になるケース」と「config key はあるが value が undefined のケース」の区別が付きにくい。
- **推奨（任意）**: `resolveAutoUpdateMode` 側で「config.autoUpdate が key ごと無い ⇒ default」「明示的に undefined/null を書いた ⇒ normalizeAutoUpdate 経由で `off` + source=config」と運用する、もしくは `normalizeAutoUpdate(undefined)` を throw にして呼び出し側で空判定を強制する。実装時に即決できる範囲なので本 Review では指摘のみ。

### [Severity: Info] E2E テストの「assigned 状態の古いタスク」シナリオ

- Step 6-1（L163）で「assigned 状態の古い更新タスクは skip + `update_task_skipped_assigned_in_progress` ログ」と定義されているが、§4 手動 E2E マトリックスにこのケースが無い。
- **推奨（任意）**: マトリックスに 1 行追加しておくと実装検証が楽。Approved の条件ではない。

## 既存コードとの整合性

- `main.ts:30`（checkNpmUpdate import）、`main.ts:134`（resolveAutoUpdateEnabled 定義）、`main.ts:259,282`（呼び出し＋ログ）、`main.ts:601,619-623`（NPM_CHECK_INTERVAL + 呼び出しブロック）、`daemon.ts:61,132`（lastNpmCheckAt）、`daemon.ts:1304`（checkNpmUpdate 関数） — plan §2 / Step 3 の削除対象と一致。
- `main.test.ts` L280-288 の `env=0`/`env=false` テスト挙動も High-1 で維持されるため破壊されない。
- `task.ts` への `createTaskProgrammatic` 切り出しは既存 `cmdCreateTask`（slug 生成 / max ID / frontmatter / task-state.json 更新）の責務移譲と整合。
- `dashboard.tsx` の既存 rateLimit バナーとの共存方針（縦並列・色差別化）も妥当。

## 新たな矛盾・見落とし

なし。前回指摘は全件反映済みで、反映に伴う新たな矛盾は検出されなかった。

---

Planner は本 Review の Info 指摘 2 点を参考に（必須ではない）、Implementer に進んで問題なし。
