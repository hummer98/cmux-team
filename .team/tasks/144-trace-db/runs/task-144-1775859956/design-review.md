# Design Review Result

## Verdict: Changes Requested

## Good Points

- **削除範囲の網羅性が高い**: proxy.ts の `insertTrace` / `bodiesDir` 関連の削除箇所が行番号付きで正確に特定されており、streaming パス・非 streaming パスの両方をカバーしている
- **マイグレーション戦略が堅実**: 旧テーブルの存在チェック → DROP → 新スキーマ作成の順序で、既存 DB を壊さず移行できる
- **JSONL トレースを残す判断が正しい**: HTTP リクエストの時系列ログとしての価値を認識し、SQLite 記録のみ削除する判断は適切
- **実装順序が依存関係を正しく反映**: trace-store.ts → proxy.ts → conductor.ts/main.ts の順序で、コンパイルエラーを最小化できる
- **JSONL パス導出のリスク認識**: Claude Code 内部実装への依存を明示し、フォールバック方針を示している
- **WAL モードによる並行アクセスの安全性**: CLI コマンドと daemon の並行 DB アクセスを WAL で担保する判断は正しい

## Issues

### Critical

1. **空の `catch {}` がロギングポリシー違反（3箇所）**

   `cmdSpawnAgent`、`cmdCloseTask`、`cmdAbortTask` の DB 記録コードがすべて `try { ... } catch {}` になっている。CLAUDE.md のロギングポリシーで「空の `catch {}` は禁止。最低限ログを残す」と明記されており、これは許容される例外（冪等な後処理、存在チェック）に該当しない。DB 書き込みの失敗は調査に必要な情報なので、少なくとも `catch (e: any) { log("error", ...) }` にすべき。

   ```typescript
   // 修正例:
   } catch (e: any) {
     log("error", `insertTaskSession failed: task_id=${taskId} ${e.message}`).catch(() => {});
   }
   ```

2. **ファイル変更一覧と最終結論の矛盾**

   計画書冒頭の変更対象ファイル一覧で:
   - `daemon.ts`: 「DB インスタンスを DaemonState に保持（proxy 経由ではなく直接）」
   - `schema.ts`: 「DaemonState に `db` フィールドを追加（必要に応じて）」

   しかしセクション 5 の最終結論は「daemon.ts への DaemonState 変更は不要。各 CLI コマンド内で `initDB()` を直接呼ぶ方針で統一する」。これは矛盾しており、実装者が混乱する。冒頭の表を最終結論に合わせて修正すべき。

### Recommendations

1. **`drainAndLog` の `chunks` 配列がデッドコードになる**

   proxy.ts の `drainAndLog` 関数内で `const chunks: Uint8Array[] = []`（L379）と `chunks.push(value)`（L386）は、bodies 保存（L416-426 のマージ処理）のためだけに存在する。bodies 保存を削除すると `chunks` 関連コードが全てデッドコードになる。削除対象として明記すべき。reader ループ自体は `responseBytes` カウントのために残す必要があるが、`chunks` の蓄積は不要。

2. **`deriveJsonlDir` で `require("crypto")` は ESM に不適切**

   プロジェクトは Bun + ESM で構成されている。`require("crypto")` ではなく、ファイル先頭で `import { createHash } from "crypto"` を使うか、Bun の `Bun.hash` API を使用すべき。

3. **`assignTask` のシグネチャ変更に関する記述が混在**

   セクション 3（conductor.ts）で「引数の追加: `assignTask()` のシグネチャに `db?: Database` を追加（4番目の引数）」と記載されているが、セクション 5 の最終結論では「修正版: conductor.ts の `assignTask()` のシグネチャは変更しない」と明記されている。セクション 3 の記述を最終結論に合わせて修正すべき。現状だと思考の変遷が残っており、実装指示として曖昧。

4. **`cmdSpawnAgent` の sessionId 処理に関する冗長な検討過程**

   セクション 4 で sessionId の取り扱いについて「推奨」→「代替案」→「最終判断」と3段階の検討過程がそのまま残っている。最終判断のみを残し、検討過程は「備考」として分離するか削除すべき。実装者が誤った選択肢を採用するリスクがある。

5. **`cmdSpawnAgent` で `crypto.randomUUID()` を生成してコメントで否定**

   コード例で `session_id: crypto.randomUUID()` とし、直後のコメントで「仮 UUID を記録するか、sessionId は空にして...」と別方針を示し、最終判断で「sessionId は空文字にする」と結論している。コード例自体を最終判断に合わせて `session_id: ""` にすべき。

6. **daemon.ts の `assignTask()` 呼び出し箇所（L786）に DB 記録が必要か未検討**

   conductor.ts の `assignTask()` 内部で `initDB()` して記録する方針だが、daemon.ts L786 の `assignTask()` 呼び出しが失敗した場合（`AssignTaskError` の catch で `status: "aborted"` に更新）、abort イベントの DB 記録がされない。`cmdAbortTask` は CLI 経由の abort にのみ対応しているため、daemon 内部の自動 abort（assign 失敗時）は trace に記録されない。これが意図的かどうか明記すべき。

## Summary

計画書は全体として完成度が高く、タスク要件を網羅的にカバーしている。特に proxy.ts の削除範囲の特定は正確で、既存機能（JSONL、レート制限、デバッグエンドポイント）を適切に保全している。

主な問題は2点:
1. **ロギングポリシー違反**（空 catch）は CLAUDE.md の明示的な禁止事項であり修正必須
2. **検討過程が最終結論と混在**しており、実装指示として曖昧な箇所がある（ファイル変更一覧、assignTask シグネチャ、sessionId 処理）

これらを修正すれば Approved にできる。設計方針自体は妥当であり、実装順序・リスク認識・テスト方針も適切。
