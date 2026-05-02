# T410 Summary: SESSION_STARTED payload に loaded_plugins / loaded_skills を含める

## 完了したサブタスク

| # | タスク | 状態 |
|---|---|---|
| S1 | session-enrichment.ts module を作成 | ✓ |
| S2 | session-enrichment.ts unit test (9 ケース) | ✓ |
| S3 | SessionStartedMessage schema を拡張 (loadedPlugins / loadedSkills nullable optional) | ✓ |
| S4 | schema.test.ts に T410 ケース 6 件追加 | ✓ |
| S5 | buildMessageFromHookInput opts 拡張 (sync 維持) | ✓ |
| S6 | cmdSend SESSION_STARTED 分岐に enrichment 注入 + manager.log warn | ✓ |
| S7 | main.test.ts に T410 ケース 4 件追加 | ✓ |
| S8 | e2e test 追加 (実機 latency 計測 p95<3s) | ✓ |
| S9 | docs/spec/11-metrics.md §3.5.2 追加 | ✓ |
| S10 | tsc + 全関連テスト green 確認 | ✓ |
| Fix | Inspector minor finding (warn 二重出力) 解消 | ✓ |

## 変更ファイル

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/session-enrichment.ts` | 新規。`collectSessionEnrichment` / `getLoadedPluginsAndSkills` (deps 注入式)。`Bun.spawn(timeout: 3000, killSignal: "SIGTERM")` |
| `skills/cmux-team/manager/session-enrichment.test.ts` | 新規。9 unit + 2 e2e (`describe.skipIf(!claudeAvailable())`) |
| `skills/cmux-team/manager/schema.ts` | SessionStartedMessage に `loadedPlugins` / `loadedSkills: z.array(z.string()).nullable().optional()` 追加 |
| `skills/cmux-team/manager/schema.test.ts` | T410 describe block (6 ケース) 追加 |
| `skills/cmux-team/manager/main.ts` | (a) cmdSend SESSION_STARTED 分岐で enrichment 取得 (try-catch 排他構造)。(b) buildMessageFromHookInput opts 拡張 (sync 維持) |
| `skills/cmux-team/manager/main.test.ts` | T410 ケース 4 件追加 |
| `docs/spec/11-metrics.md` | §3.5.2 「SESSION_STARTED 時 plugin / skill marker (T410)」追加。format BNF / payload 例 / SQL idiom (unknown / empty / loaded 4 状態判別) / null fallback ポリシー / self-detection エッジケース |

## テスト結果

```
$ bunx tsc --noEmit
（エラー 0 件）

$ bun test schema.test.ts                70 pass / 0 fail / 104 expect() / 40ms
$ bun test main.test.ts                  235 pass / 0 fail / 638 expect() / 21.11s
$ bun test session-enrichment.test.ts    11 pass / 0 fail / 18 expect() / 2.02s
$ bun test daemon.test.ts                209 pass / 0 fail / 715 expect() / 25.18s
```

実機 e2e p95 latency: 389〜642ms（3000ms 制約に対し 13〜21% 程度）。T203 / T407 関連の resume / pre-inject 既存テストは全 green、regression 無し。

## 主な設計判断

- **D1**: hook bash command を変更せず `cmdSend` 内で `claude plugins list --json` を呼ぶ構造を採用（CLAUDE.md 「hook shell に分岐ロジックを持たせない」原則）
- **D2**: skills は `<source>:<name>` 形式（plugin / user / project の 3 source、prefix で重複許容）
- **D3**: 取得失敗時は `null` fallback（空配列との区別を spec の SQL idiom で `JSON_TYPE` / `JSON_ARRAY_LENGTH` で 4 状態判別）
- **D6**: `buildMessageFromHookInput` は sync 維持。`cmdSend` で先行取得して opts 経由で渡す（async 化による既存 7 箇所の callsite 改修を回避）
- **D7**: enrichment timeout = 3 秒（hook timeout 5 秒の余裕分）

## マージコミット / PR URL

（後段で埋める）

## Future follow-up 候補（scope 外）

1. F3 noise observation: skill cardinality 膨張時に `existsSync(<dir>/SKILL.md)` 初期 filter 導入（cleanup タスク起票検討）
2. D1 subcommand 化: debug 用途で `cmux-team session-enrichment --json` 新設
3. §3.5.2 view 化: SQL idiom が頻繁化したら `hook_signals_session_started_enriched` view または正規化テーブル化
