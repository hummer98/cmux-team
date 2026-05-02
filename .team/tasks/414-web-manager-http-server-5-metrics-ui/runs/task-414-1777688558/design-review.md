# T414 Design Review — 内部 Web ダッシュボード

> Reviewer: 別 Conductor 経由の独立レビュー
> 対象: `plan.md`（同 runs ディレクトリ）
> 関連 task: T414 `task.md`

---

## 1. Verdict

**Changes Requested**

## 2. Summary

全体としてスコープ・責務分担・段階的実装の構造は良くできており、SSOT 維持・観察箱原則・既存集計関数の流用方針も妥当。ただし B（アーキテクチャ整合性）に 1 つの重大、加えて A / C / D で軽〜中の懸念が散見され、特に **§5.1 の擬似コードと §2.1 の方針が矛盾している（traceDb の scope / 取得経路）** ため Implementer が実装時に必ず詰まる。下記 Recommendations を plan に取り込めば Approved 相当。

## 3. Strengths

1. **既存集計関数の徹底検証**: §4.1 で `trace-store.ts` / `metrics-aggregate.ts` の関数 11 個を file:line 付きで検査し、流用可否を表で明示。SSOT を `metrics-aggregate.ts` に一元化する宣言（§4.1 末尾）も明確。
2. **新規 SQL を最小限に絞っている**: `countToolCallsByPeriod` / `failureRateByTool` / `aggregateApiUsageByBucket` の 3 本のみ追加。既存呼出側を壊さない設計。
3. **段階的実装ステップが PR 化可能**: Step 1（型・骨格）→ Step 2（集計 API）→ Step 3（Agent Strategy）→ Step 4（HTML + Overview）→ Step 5/6（残ページ）→ Step 7（docs）は merge 順序が論理的で、各 step の動作確認手順も明示。
4. **uPlot vendoring の判断根拠が網羅的**: bundle サイズ / ライセンス / npm dep 化の運用負荷 / build step 不要性 を比較表（§3）で評価し、`vendor/UPLOT_VERSION` での運用ルールまで決めている。
5. **テスト境界の網羅**: §8.2 で `from > to`、ISO parse 失敗、taskId 不在、127.0.0.1 listen の 0.0.0.0 拒否、bucket key 形式まで列挙。`bun test` 全体実行禁忌を §8.5 で再確認。

## 4. Findings

| 観点 | 判定 | 主な懸念 / 引用 |
|---|---|---|
| **A. 仕様一致性** | 懸念あり | task.md「Per-tool failure rate テーブル — **Bash 強調**」が plan §4.2 `perToolFailure` / §6.4 で明文化されていない（DOM 側暗黙対応とも読めるが要追記） |
| **B. アーキテクチャ整合性** | **重大な問題あり** | (B-1) §5.1 擬似コード `const dashboardDb = traceDb ?? initDB(PROJECT_ROOT)` の `traceDb` は main.ts:760 の **`else` ブロック内ローカル変数** で外から参照不可。proxy 再利用パスでは未定義参照になる。§2.1 では「自前で `initDB` を呼ぶ」と書いているが §5.1 と齟齬。<br>(B-2) main.ts:815 コメント「quit 時は proxy を停止しない（既存 Master/Conductor の接続を維持するため）」と plan §5.1「shutdown 冒頭で `dashboardHandle?.stop()` を呼ぶ」が乖離。dashboard だけ明示的 stop する理由が plan 内に書かれていない |
| **C. リスクの妥当性** | 懸念あり | (C-1) §10「長クエリで daemon が止まる」の AbortSignal + 5s timeout は方針として妥当だが、`readTaskLifecycle` の `for await (line of rl)` (`metrics-aggregate.ts:155`) に割り込みを入れる箇所が plan で具体化されていない。<br>(C-2) §10 CSP は `script-src 'self' 'unsafe-inline'` のみ言及。CSS も inline するため `style-src 'self' 'unsafe-inline'` の追加が必須（脱漏） |
| **D. テスト計画** | OK（軽微） | (D-1) drill-down 経路 `getAgentStrategyForTask` の outcome 補完テスト（events.jsonl + `readTaskLifecycle`）が §8.3 で薄い。§8.2 に追加したい |
| **E. 段階的実装ステップ** | OK | Step 4 が新規 4 ファイル + vendor + bundle + GET / 追加 + `package.json` 改変と最も幅広いが、「最初に動くフロント 1 ページ」を出す節目として許容範囲 |
| **F. 既存コードへの影響** | OK | proxy.ts の port / lifecycle 影響なし（§5.3 表で明示）、TUI Metrics / CLI 未変更、`package.json` files に `dashboard-web/**` 追加は既存 `*.test.ts` exclude と衝突せず |
| **G. docs/spec** | OK | `12-web-dashboard.md` の章構成は `11-metrics.md` と整合。glossary / 00-project-overview / 05-install-and-infrastructure / CLAUDE.md の追記内容も必要十分 |
| **H. 設計判断の妥当性** | OK | uPlot vendor / vanilla JS / 6 値分類（暫定明記あり）/ 30s polling すべて根拠が説得的。`?refresh=on` 既定 ON と client-side `Cache-Control: no-store` の組み合わせも観察値の即時性を優先する判断として整合 |
| **I. 観察箱原則との整合** | OK | retrospective 観察 UI として位置付け明示（§1）、trace DB は read-only（§2.1）、SPA 状態は URL 経由で外部化、サーバ側 cache なし — 観察を阻害しない方向に揃っている |

### 独立検証で確認した既存コードの事実

レビュー時に直接読んだソース（plan の主張の事実検証）:

- `trace-store.ts:1075/1119/1179/1227/1271/1321/1348/793/807` — plan §4.1 の line 番号は全て正確 ✓
- `metrics-aggregate.ts:143/263/352` — 同上 ✓
- `daemon.ts:4141 updateTeamJson` — tmp+rename atomic write を実装、plan §5.2 の方針と一致 ✓
- `main.ts:752-759` のコメントブロックで「proxy 再利用パスでは traceDb を意図的に開かない」「shutdown では proxy を stop しない」が明文化されている — これが上記 B-1/B-2 の懸念の根拠
- `metrics-aggregate.ts:340 bucketKey` の対応 groupBy は **`"day" | "week"`** のみ。plan §4.1 #3 で `"hour"` 拡張が必要と認識されているが、§4.1 表で `aggregateMetricsByBucket` を `◎`（流用可）と書いているのは部分的に misleading（軽微、Recommendations には含めず）

## 5. Recommendations（採用必須）

1. **§5.1 を §2.1 と整合させる**: 擬似コード `const dashboardDb = traceDb ?? initDB(PROJECT_ROOT)` を以下のいずれかに修正
   - (A) `main.ts` 冒頭で `let traceDbHandle: Database | null = null` を宣言し、proxy 起動 / 再利用の双方で値をセット。dashboard は `traceDbHandle ?? initDB(PROJECT_ROOT)` で参照
   - (B) dashboard-server は **常に** 自前で `initDB(PROJECT_ROOT)` を呼ぶ方針に決定する（§2.1 の主張に合わせる）。WAL なので writer 別ハンドル / 別プロセスとも共存可能
   - どちらを採用するかを plan で確定し、「Implementer 判断」のままにしない

2. **shutdown / onFullQuit で `dashboardHandle.stop()` を呼ぶ根拠を明記** — または呼ばない方針に揃える
   - 既存 proxy は意図的に `proxyHandle.stop()` を呼ばず process.exit(0) に委ねている（main.ts:815 コメント参照）
   - dashboard も外部接続（既存 Master/Conductor 等）を持たないので、process.exit に任せれば十分なはず
   - もし明示的 stop が必要なら、in-flight な fetch をどう扱うか（待機 / 中断）を決め、§5.3 の停止順序「dashboard → proxy」の根拠を補強する

3. **CSP に `style-src 'self' 'unsafe-inline'` を追加** — CSS も `<style>...</style>` で inline するため必須。§10 リスク表 / §12 完了条件の CSP 文字列を修正

4. **Tool Use ページの「Bash 強調」を明文化** — task.md「Per-tool failure rate テーブル — **Bash 強調**（即興スクリプト失敗の指標）」を §6.4 の `renderToolUse()` 説明に追加（例: `tool_name === "Bash"` の行に視覚 emphasis を入れる、上位ピン留めなど方針を 1 行）

5. **§10「長クエリで daemon が止まる」対処の具体化** — `readTaskLifecycle` の `for await (line of rl)` ループに `AbortSignal` を伝搬する経路、もしくは `aggregateMetricsByTask` を呼ぶ endpoint ハンドラ層で `Promise.race([work, sleep(5000).then(() => 503)])` する方針か、どちらを採るか plan 内で明記

## 6. Out-of-scope Nits（採用は Planner 任意）

- Step 4 を 4a（`dashboard-web-bundle.ts` + GET / + uPlot vendor + `package.json`）と 4b（`dashboard-web/{index.html,style.css,app.js}` + Overview ページ）の 2 PR に分けると、PR 1 つあたりの review surface が小さくなり sidebar / 時間範囲 picker レビューが集中できる
- §4.2 `recentFailures.error` を「1KB 切り詰め」と書いているが、UTF-8 multibyte 文字の中央で切ると壊れた JSON になる可能性あり。「文字数」基準か、「`Buffer.byteLength` で末尾の不完全 multibyte を捨てる」かを明文化したい
- `vendor/UPLOT_VERSION` の plain text 運用は良いが、CI でファイルの sha256 をチェック（手動更新の取り違え防止）する hook を将来検討の余地
- §6.4 の Canvas 自前実装（per-tool horizontal bar / strategy 円 / per-role pie / histogram）は uPlot で実装可能なものも多い（horizontal bar / pie は workaround あり）。「自前 Canvas 30 行で済む」根拠は §3 で示されているが、複数ページに散らばると合計コード量が増える可能性。Implementer 判断で uPlot に寄せても OK というワーディングを足してもよい
- `?reload=1` の development cache 無効化（§6.1 末尾）を「Implementer 判断」とせず、既定 OFF で `process.env.CMUX_TEAM_DEV` 等の env で切り替える、と決め切る方が運用上明確
