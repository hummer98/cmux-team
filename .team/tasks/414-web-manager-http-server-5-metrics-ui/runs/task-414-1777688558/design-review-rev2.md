# T414 Design Review (rev2) — 内部 Web ダッシュボード

> Reviewer: 別 Conductor 経由の独立レビュー（rev2）
> 対象: `plan.md`（rev1 で更新後）
> 関連: `design-review.md`（rev1 のレビュー、Recommendations 5 項目）
> 関連 task: T414 `task.md`

---

## 1. Verdict

**Approved**

5 つの Recommendations すべてが ✓ で反映されており、後退（前回 OK 項目の崩れ）も検出されなかった。残る軽微な点は §4 の Out-of-scope Nits に格下げ。

## 2. Recommendation Compliance

| # | 観点 | 判定 | 反映箇所 |
|---|---|---|---|
| 1 | §5.1 traceDb 取得経路の確定（A 案 / B 案） | **✓** | §2.1 で「**B 案に確定**」と明記、§5.1 擬似コードも `db` を渡さず `dashboard-server.ts` 内で自前 `initDB(PROJECT_ROOT)`。§2.1 末尾に rev1 補足として「A 案を採らない理由（main.ts:752-759 コメントブロックとの整合）」を記述 |
| 2 | shutdown / onFullQuit で `dashboardHandle.stop()` を呼ぶ根拠の明記、または「呼ばない方針」に統一 | **✓** | §5.1「**shutdown / onFullQuit での停止方針 — 明示停止しない**」セクションを新設。3 理由（既存 proxy 方針 main.ts:815 と整合 / in-flight fetch 破壊回避 / read-only で commit 義務なし）を列挙。§5.3 の表でも proxy.ts と dashboard-server.ts の両方を「**呼ばない**（process.exit 任せ）」に揃え、停止順序「dashboard → proxy」の規定を撤回。テスト経路でのみ `handle.stop()` を呼ぶ例外も明記。完了条件 §12 でも対応 |
| 3 | CSP に `style-src 'self' 'unsafe-inline'` 追加（§10 / §12 両方） | **✓** | §10 リスク表、§12 完了条件、§8.2 dashboard-server.test.ts のテストケース、いずれにも `style-src 'self' 'unsafe-inline'` が含まれている。§10 では rev1 補足として「inline `<style>` を許可するため必須」と理由も記載 |
| 4 | Tool Use ページの「Bash 強調」を §6.4 `renderToolUse()` に明文化 | **✓** | §6.4 表の `renderToolUse()` 行に「**Bash 強調**: `tool_name === "Bash"` の行は per-tool table と failure 表で色付き + table 上位ピン留め、horizontal bar / failure timeline では太線描画」と具体的なビジュアル方針まで明記。task.md 該当条項への参照も付記 |
| 5 | §10「長クエリで daemon が止まる」対処を AbortSignal / Promise.race に具体化 | **✓** | §10 で「**endpoint ハンドラ層で `Promise.race`**」と確定。`Promise.race([work, sleep(5000).then(() => Symbol("TIMEOUT"))])` のスニペットと閾値 5s、503 レスポンス body 形状、AbortSignal を threading しない理由 3 点を明記。§4.3 エラー設計表に 503 を追加、§8.2 テストにも「集計関数を 6s sleep に差し替えた fixture」での 503 検証を追加 |

**集計**: 必須 5 項目すべて ✓ → 判定基準「4 項目以上 ✓ → Approved」を満たす。

## 3. 後退（retrograde）チェック

前回 OK / 軽微だった観点（A 仕様一致性 / E 段階的実装 / F 既存コード影響 / G docs/spec / H 設計判断 / I 観察箱原則）について崩れがないか確認:

- **A 仕様一致性**: Bash 強調が §6.4 に追記されたことで前回 A の指摘が解消、後退なし
- **E 段階的実装**: Step 1 に「dashboard-server 内で自前 initDB(projectRoot)（§2.1 B 案）」「stop は呼ばない」「CSP header 付与」の具体化が追加されただけで、merge 順序や PR 化粒度は不変
- **F 既存コード影響**: §5.3 表で proxy.ts の停止方針記述が「dashboard-server も同様に呼ばない」に揃った副次効果として、proxy.ts への影響表現が一段クリアになっている（後退ではなく改善方向）
- **G docs/spec**: 章構成・追記内容に変更なし
- **H 設計判断**: 30s polling / vendoring / vanilla JS / 6 値分類すべて維持
- **I 観察箱原則**: trace DB read-only / SPA 状態の URL 外部化 / サーバ側 cache なし、いずれも維持

→ **後退なし**。

## 4. New Findings（修正過程で生まれた新たな懸念）

軽微なものに留まり、いずれも `Changes Requested` 級ではない。Implementer に申し送りで足りるレベル:

1. **(軽微) §4.2 TypeScript schema にタイムアウト 503 のレスポンス型がない**
   §4.3 で 503 + `{ "error": "timeout", "endpoint": "...", "windowSec": 5 }` を新設したが、§4.2 の `interface ...Response` 群は成功時の shape のみで、エラーレスポンス（400 / 404 / 500 / 503）の型を別 union として宣言していない。SPA 側で `if (r.ok)` 判定後に成功 shape を期待する書き方なら実害はなく、慣例的にも許容範囲。Implementer 判断で `interface ApiErrorResponse { error: string; message?: string; ... }` を 1 つ追記すると良い、程度。

2. **(軽微) §8.2 timeout テストの「集計関数を 6s sleep に差し替えた fixture」で差し替え方法が未定義**
   Promise.race は `dashboard-server.ts` のハンドラ層で行うため、集計関数を sleep に差し替えるには (a) 関数 reference を引数で受ける DI 化、(b) `mock.module()` など Bun のテストユーティリティ、(c) fixture DB に enormous fixture を入れて自然に 5s 超えさせる、のいずれかが必要。Step 2 の実装時に方針を一つ選んで `dashboard-server.ts` の構造に反映する必要があるが、plan で明文化されていない。テスト書く段で詰まる可能性あり。

3. **(軽微) §6.4 「table 上位ピン留め」と calls 降順 sort の重複**
   per-tool calls table は通常 calls 降順で表示する想定（horizontal bar も同じ）だろうから、`Bash` が最大 calls なら自然に top に来る。「ピン留め」は calls が他に劣る期間で意味を持つ仕様だが、Implementer が「sort 後そのまま」で実装してしまう余地がある。気になるなら spec で「calls に関わらず Bash 行を先頭に固定する（pinned）」と明文化したい。

これらはいずれも `Approved` を覆さない。Implementer に「Step 2 / Step 5 の実装で気を付けて」程度で足りる。

## 5. Out-of-scope Nits（採用は Planner 任意）

前回レビューで挙げた以下の Nits は rev1 plan で取り込まれていない（Planner 任意領域として残置されている認識）。再掲する必要があれば:

- Step 4 を 4a（bundle / GET / vendor / package.json）と 4b（HTML/CSS/JS + Overview）に分けると review surface が小さくなる
- §4.2 `recentFailures.error` の「1KB 切り詰め」は UTF-8 multibyte 境界の壊れ対策（`Buffer.byteLength` 末尾の不完全 multibyte 切り捨て or 文字数基準）を明文化したい
- `vendor/UPLOT_VERSION` に CI sha256 チェック hook を将来検討
- §6.4 Canvas 自前実装は Implementer が uPlot に寄せても OK、というワーディング許容
- §6.1 `?reload=1` の dev cache 無効化を `process.env.CMUX_TEAM_DEV` などで決め切る

新規の Nit:

- 上記 New Findings #2（timeout テストの差し替え方式）を §8.2 に 1 行（"DI 化を推奨" など）追記しておくと Implementer がスムーズ。

---

## 6. 結論再確認

- 必須 5 項目: **5/5 ✓**
- 後退: **0 件**
- 判定基準: 「4 項目以上 ✓ → Approved」「後退があれば Changes Requested」の両条件を満たす

**Verdict: Approved**

Implementer は plan.md に基づいて Step 1 から着手して問題なし。New Findings #1〜#3 は実装中に気付いた段階で plan の余白を見て調整、もしくは spec ドラフト段階で吸収すれば良い。
