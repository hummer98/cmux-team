# T327 サマリ — `bun test` 全体実行ハング調査

- 実行 worktree: `task-327-1777146078`
- 環境: macOS 25.4.0 (arm64), Bun 1.3.12
- 詳細レポート: `research.md` （同一ディレクトリ）
- artifact ID: _Conductor 検品時に追記_

## 完了したサブタスク

1. **Phase 1 — 再現と切り分け**
   - 240 s gtimeout で従来の症状を再現（exit 137、ログは 8 行で止まり `gh-cache-cli.test.ts:` までしか出ない）。
   - `--reporter=dots` で進捗を可視化、13 分経過時点で 420 dots（pass 累計）まで進むことを確認。
   - 47 個 `.test.ts` を個別ファイル実行する loop を組み、合計 **68.4 秒**で全 pass のベースラインを取得（per-file-timing.log）。
   - bg バンテストの状態観察（lsof, ps, sample）を 30 秒間隔で 5 回採取。CPU active / fd 299 安定 / 子プロセス無し / `proxy.test.ts` の token-store DB を握っていることを確認。

2. **Phase 2 — 原因特定**
   - SQLite db 競合: 8 ファイル（conductor / pool-cli / proxy / daemon / trace-store / token-store / token-cli / trace-store-metrics）。temp dir 衛生は OK だが **module-level に Database singleton を保持** している。
   - subprocess spawn: `Bun.spawn` / `child_process.spawn` を使う test は **`main.test.ts` のみ**。一方で 13 時間前のセッションで spawn された `bun run main.ts token add` が 7 個 leak、CPU 770 分以上を浪費中（ps -ef で確認）。
   - bun test のフラグ: `--concurrency` は存在しない。`--max-concurrency=20` は test 関数 concurrency。`--concurrent` で全テストを並列化できるが状態漏れがあれば悪化。
   - macOS リソース上限: `ulimit -n` unlimited、`ulimit -u` 10666、`lsof | wc -l` 33497。**枯渇は不発生**。
   - 追加発見: bun test の引数は **substring match**。`bun test conductor.test.ts` で `dashboard-conductor.test.tsx` も実行される（38 tests, 20.6 s）。`.test.tsx` を含めると実ファイル数は **47 → 50**。
   - 追加発見: `bun test` は **SIGTERM をほぼ無視**。`gtimeout 240 bun test` は 13 分経過しても生存。`gtimeout --kill-after=10 240` で初めて確実に停止。

3. **Phase 3 — 報告**
   - `research.md` に要約 / 再現手順 / 仮説検証 / 原因 / 推奨修正 / 回避策 / 観察ログを記載。
   - `summary.md`（本ファイル）に Conductor 引き渡し用の要点を整理。

## 再現手順（短く）

```bash
cd skills/cmux-team/manager

# 1. 従来の hang 体験を再現
gtimeout --kill-after=10 240 bun test --timeout 60000
# → exit 137、ログは 8 行で `gh-cache-cli.test.ts:` まで

# 2. 実は走っていることを確認
gtimeout --kill-after=10 360 bun test --timeout 30000 --reporter=dots
# → 13 分で 420 dots、停止していない

# 3. 個別実行のベースライン
for f in *.test.ts state-machine/*.test.ts; do
  bun test --timeout 30000 "$f"
done
# → 約 68 秒で全 pass
```

## 推奨される暫定回避策

- **`for f in *.test.ts state-machine/*.test.ts; do bun test "$f"; done`** を `prepublishOnly` 相当の場所で使う。確実に終わる、合計 68 〜 90 秒。
- 全件まとめて走らせたいなら `--reporter=dots` を必ず付ける。「進んでいない」と誤認しない。
- `gtimeout` を使う際は **必ず `--kill-after=N`** を併用（bun test は SIGTERM を実質無視）。

## 恒久修正の方向性（粒度を分けて TODO 化）

A. **package.json / docs**
   - `scripts.test` を `bun test --reporter=dots` に変更。
   - `scripts/test-each.sh` 追加（ファイル単位逐次ループ）。`prepublishOnly` をこれに切り替え。
   - CLAUDE.md / README に「`bun test` がハングして見える理由」「個別ループの暫定手順」「`gtimeout --kill-after`」を明記。

B. **構造的バグ修正（最有力の根本原因対策）**
   - `eventBus.ts` の module-level singleton を **factory 化**、または全 test の `--preload` で `__resetBusForTest()` を仕込む。
   - `bun:sqlite` を使う 8 モジュールの Database 保持を棚卸し、明示的 `init/close` を導入。
   - `main.test.ts` の `spawn("bun", ["run", MAIN_TS, ...])` を **直接 import スタイル**に書き換え（`token-cli.test.ts` 等と同じパターン）。leak の根本原因を消す。

C. **テスト構成の整理**
   - `dashboard-*.test.tsx` で ink を render しているテストの cleanup（`render(...).unmount()`）を全件確認。
   - bun test の引数 substring match を docs に明記、CI では明示的なファイル列挙を推奨。

## 完了条件チェック

- [x] 原因が 1 つ以上特定され research.md に記載されている（5 つの原因を特定）
- [x] 全体実行を完走させる暫定回避策が判明（個別ループ・dots reporter）
- [x] 実装修正は別タスクとして起票可能な粒度で残課題化（A-C 11 項目）
- [x] research.md と summary.md が出力ディレクトリに存在する

## 引き渡しメモ

- 別タスク化推奨の最優先 3 件:
  1. `scripts/test-each.sh` の追加 + `prepublishOnly` 切り替え（即効性、構造変更不要）
  2. `eventBus` の test 隔離（累積負荷の最有力候補に直接アタック）
  3. `main.test.ts` の spawn 撤廃（leak の構造的解消、過去 4h+ ハングの主犯候補）
- 残課題として「O(N²) 累積負荷の直接的な数値証拠（listenerCount 時系列、heap snapshot）」がまだ取れていない。実装側で `__listenerCountForTest()` を全テスト後に出すロガーを仕込めば、修正の効果検証も同時に取れる。
- 過去セッションで leak した `bun run main.ts token add` プロセス 7 個（PID 11560 系）はそのまま生存中。**手動で `kill -KILL 11560 11562 11564 17149 17160 25147 25152 32141 32137 32141` を推奨**（CPU を 13 時間×7 プロセス分浪費中）。今回の調査では実害なしと判断して放置。
