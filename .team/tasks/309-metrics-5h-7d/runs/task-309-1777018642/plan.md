# T309 実装計画: Metrics タブの「統合 (5h/7d)」セクション削除

## 背景

Metrics タブ中段の「統合（5時間 / 7日）」セクションは、ヘッダー右端の `buildRateLimitDisplay`
（`rate-limit-display.ts`）が出している `5h:` / `7d:` バー付き表示と情報が重複している。しかも
劣化版（パーセントのみで、プログレスバー・reset 時間・stale 判定なし）なのでユーザー価値が
ほぼ無い。Metrics タブは「ヘッダーに載せきれない detail（burn rate / role / task 別消費）」に
専念させ、`unified*` 系はヘッダーへ一本化する。

## 変更対象一覧（実地確認後の正確な行範囲）

### 1. `skills/cmux-team/manager/dashboard-metrics.ts`

- **L49-52（`MetricsData` interface の JSDoc + フィールド 2 本）を削除**
  ```ts
  /** unified 5h 使用率（0.0-1.0、未取得なら null） */
  unifiedFive: number | null;
  /** unified 7d 使用率 */
  unifiedSeven: number | null;
  ```
- **L317-331（`buildMetricsRows` 内の unified セクション描画ブロック全体）を削除**
  ```ts
  // ── 上段追加: unified 5h / 7d ─────────────────────────────────────────────
  rows.push(ui.text(""));
  rows.push(
    ui.text(`── ${t("metrics_section_unified")} ──`, { dim: true }),
  );
  {
    const five = utilizationColor(data.unifiedFive);
    const seven = utilizationColor(data.unifiedSeven);
    rows.push(
      ui.row({ gap: 2 }, [
        ui.text(`5h: ${five.text}`, { style: { fg: five.color } }),
        ui.text(`7d: ${seven.text}`, { style: { fg: seven.color } }),
      ]),
    );
  }
  ```
  ブロック直前の空行（L316 の `}`）とブロック直後の「── 中段: ロール別集計 ──」コメント
  （L333〜）の間に余計な改行が残らないことを確認する。

### 2. `skills/cmux-team/manager/dashboard.tsx`

- **L1830-1831** の `MetricsData` リテラル（db=null フォールバック側）から 2 行削除
  ```ts
  unifiedFive: daemon.rateLimit?.unified5hUtilization ?? null,
  unifiedSeven: daemon.rateLimit?.unified7dUtilization ?? null,
  ```
- **L1871-1872** の `MetricsData` リテラル（通常パス）から同 2 行削除

  `daemon.rateLimit?.unified5hUtilization` / `unified7dUtilization` 自体は
  **絶対に消さない**（後述「リスクと回避策」参照）。代入行だけ消す。

### 3. `skills/cmux-team/manager/i18n.ts`

- **L786（en）** `metrics_section_unified: "Unified (5h / 7d)",` を削除
- **L1569（ja）** `metrics_section_unified: "統合（5時間 / 7日）",` を削除

  ja/en の両方から 1 行ずつ消す。キーが片方だけ残ると i18n 型 (`keyof typeof en`) が
  食い違う可能性があるので、両方揃える。

### 4. `skills/cmux-team/manager/dashboard-metrics.test.tsx`

- **L40-41** のテストフィクスチャから以下 2 行を削除
  ```ts
  unifiedFive: 0.4,
  unifiedSeven: 0.2,
  ```

  test ファイル全体を `rg 'unified|Unified|統合'` で走査したが、他の参照はない。
  assertion で unified セクションの文言を検証している箇所もなし。

## 削除漏れ防止 grep リスト

実装後、以下 3 本の grep が **すべて 0 件** であることを確認する:

```bash
# 1. MetricsData 側のフィールド
rg -n 'unifiedFive|unifiedSeven' skills/cmux-team/

# 2. i18n キー
rg -n 'metrics_section_unified' skills/cmux-team/ docs/ README*.md

# 3. 念のためリポジトリ全体（docs / CHANGELOG / templates 含む）
rg -n 'unifiedFive|unifiedSeven|metrics_section_unified'
```

**0 件であってはいけない grep（削除してはいけないもの）**:

```bash
# daemon.rateLimit 本体のフィールド — ヘッダー・throttle・proxy・schema で使用中
rg -n 'unified5hUtilization|unified7dUtilization' skills/cmux-team/manager/
# 期待: 30+ ヒット（main.ts / daemon.ts / dashboard.tsx L1226 /
#   rate-limit-display.ts / rate-limit-persistence*.ts / proxy.ts / schema.ts ほか）
```

## テスト戦略

1. **型検査** — 新規エラーが出ないこと
   ```bash
   cd /Users/yamamoto/git/cmux-team/.worktrees/task-309-1777018642
   bunx tsc --noEmit
   ```
   `MetricsData` からフィールドを削除したので、`dashboard.tsx` 側で代入を消し
   忘れていると `Property 'unifiedFive' does not exist on type 'MetricsData'` で
   確実に落ちる（= セーフティネット）。

2. **ユニットテスト** — 該当ファイルだけ実行して早期検知
   ```bash
   bun test skills/cmux-team/manager/dashboard-metrics.test.tsx
   ```
   test fixture の 2 行を削除しないと `MetricsData` の excess property error に
   なる可能性（`makeData` の return 型）。必ず併せて削除する。

3. **フルテスト** — 既存テスト全体の regression なし
   ```bash
   bun test
   ```
   `rate-limit-display.test.ts` / `rate-limit-persistence*.test.ts` は
   `unified5hUtilization` / `unified7dUtilization`（ヘッダー側）を検証しており、
   本変更では触らないのでそのまま通るはず。

## リスクと回避策

### リスク 1: `daemon.rateLimit.unified5hUtilization` / `unified7dUtilization` の誤削除

**絶対禁止。** これらは以下で使用中で、消すと Manager daemon が throttle できなくなる:

- `main.ts:587, 2331-2335` — restore 時のログ + throttle decision 入力
- `daemon.ts:2528-2530, 3377` — `THROTTLE_5H_THRESHOLD` 判定
- `dashboard.tsx:1226` — Master への throttle indicator
- `rate-limit-display.ts:49-64` — ヘッダーの `5h:` / `7d:` バー描画
- `proxy.ts:96-97, 251-277` — proxy 経由の reading / writing
- `schema.ts:304-306` — Zod スキーマ
- `rate-limit-display.test.ts` / `rate-limit-persistence*.test.ts` — 既存テスト

**回避策**: 削除するのは `dashboard.tsx` 中の **`unifiedFive:` / `unifiedSeven:`**
（`MetricsData` リテラルのキー名）のみ。右辺の `daemon.rateLimit?.unified5hUtilization`
はキー参照として生きているので、行ごと削除する＝参照も同時に消える（危険なし）。

### リスク 2: i18n キー削除で runtime エラー

`metrics_section_unified` は `dashboard-metrics.ts:320` の `t("metrics_section_unified")`
でのみ参照されている。L320 も同時に削除するので孤立参照は残らない。
`rg -n '"metrics_section_unified"|metrics_section_unified' skills/` で最終確認する。

### リスク 3: ja/en 片側だけ削除で型不整合

`i18n.ts` は型 `keyof typeof en` を `t()` 引数型として使っており、ja だけ削除すると
「ja に足りないキー」ではなく「en にあって参照されないキー」になる（tsc は通る）。
逆に en だけ削除して ja に残ると `ja[key] as string` で undefined を引く可能性がある。
**必ず L786（en）と L1569（ja）両方を同一コミットで削除する。**

### リスク 4: 空行の後処理ミス

`dashboard-metrics.ts` の L317-331 削除後、L316（前のブロック閉じ `}`）と L333
（次の `// ── 中段: ロール別集計 ──`）の間に空行が 1 本残る。他セクション間の
空白ルール（ブロック→`rows.push(ui.text(""))`→コメント）は各セクションの
**先頭** で空行を挿入している設計なので、ブロック間を詰めれば rendering は正常。
実装後に `bun test` で snapshot 的差分を見る（既存 test は rendering 済み文字列を
`toContain` で検証しているので、空行の余分は検知されない — ここは目視で確認）。

## 確認手順（実装後の実行コマンド）

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-309-1777018642

# 1. 削除漏れチェック（3 本とも 0 件になること）
rg -n 'unifiedFive|unifiedSeven' skills/cmux-team/
rg -n 'metrics_section_unified' skills/cmux-team/ docs/ README*.md
rg -n 'unifiedFive|unifiedSeven|metrics_section_unified'

# 2. ヘッダー側が壊れていないこと（30+ ヒットで不変）
rg -n 'unified5hUtilization|unified7dUtilization' skills/cmux-team/manager/ | wc -l

# 3. 型検査
bunx tsc --noEmit

# 4. 該当テスト + フルテスト
bun test skills/cmux-team/manager/dashboard-metrics.test.tsx
bun test

# 5. dashboard 起動 → Metrics タブ目視確認（任意だが推奨）
#    - 「統合 / Unified」セクションが消えていること
#    - ヘッダー右端の「5h: xx% [bar] reset in ..」「7d: ..」は従来通り出ること
#    - Rate limit / By role / By task セクションはそのまま
bun run skills/cmux-team/manager/main.ts  # or cmux-team start
```

## 作業境界の再確認

- コード変更は本 plan.md では**行わない**。Implementer が別セッションで実施する。
- `.team/artifacts/` には書かない。
- 成果物は `/Users/yamamoto/git/cmux-team/.team/tasks/309-metrics-5h-7d/runs/task-309-1777018642/plan.md` のみ。
