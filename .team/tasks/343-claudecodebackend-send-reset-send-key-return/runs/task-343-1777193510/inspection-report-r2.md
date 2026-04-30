# T343 検品レポート (Round 2)

## 判定: GO

Round 1 の NOGO 要因（tsc 新規エラー 16 件）が解消され、テスト 0 fail を維持。修正は assertion ロジックを変えていない。

## 検品結果

### tsc

```bash
cd skills/cmux-team/manager
bunx tsc --noEmit
```

- claude-code-backend.test.ts 由来エラー: **0 件**
- 全体エラー: **0 件**（tsc 出力ファイル `wc -l` = 0、`grep -c "error TS"` = 0）
- 詳細: 既存ファイル（`claude-code-backend.ts`, `conductor.test.ts`）にも新規エラーなし。Round 1 で NOGO 判定の原因となった 16 件は完全に解消。

### テスト

| ファイル | 結果 | expect() |
|---|---|---|
| `claude-code-backend.test.ts` | **14 pass / 0 fail** | 47 |
| `conductor.test.ts` | **38 pass / 0 fail** | 144 |

両方 0 fail を維持。Round 1 の機能テスト結果と同値。

### 修正レビュー

Read で `claude-code-backend.test.ts` を確認した結果、以下の修正は妥当:

1. **`events[i]!` / `invocationCallOrder[i]!` の non-null assertion 追加**
   - 例: line 40 `order: sendOrders[i]!`, line 58 `expect(events[0]!.kind).toBe("send")`
   - `events.length` を直前で `expect(events.length).toBe(2)` 等で確定させており、添字アクセスは到達可能性が保証されている。
   - assertion 対象（kind / args / order）の比較ロジックは Round 1 と完全に同じで、テストが検証する `cmux.send → cmux.sendKey(return)` の順序検査の意図に変化なし。

2. **`spawn()` 呼び出しに `role` / `prompt` / `workdir` 必須フィールド追加**
   - `runtime-backend.ts:90` の `SessionRole = "master" | "conductor" | "agent"` に対し、テストでは `role: "conductor"` (line 171, 203) と `role: "master"` (line 188) を使用。型として妥当。
   - `prompt: ""`, `workdir: "/tmp"` はシェル経路の挙動（launchCmd 末尾 \n 自動付加 / sendKey 不発火）に影響しないダミー値で、既存テストの「シェル経路は send-key return を呼ばない」というカバレッジを変えていない。
   - `env` 付きケース (line 197-214) も追加引数のみで、export 行 + launchCmd の検証ロジックは Round 1 から同一。

3. **既存テストの意図・カバレッジ**
   - AC1 (send 順序), AC1 long prompt, AC2 (reset 4 ステップ), AC2 long prompt, AC4 (シェル経路 \n 維持), disposed 後 throw — すべて Round 1 と同じテストケース・同じ assertion を維持。
   - カバレッジに後退なし。

## Fix Required

なし（GO 判定）。
