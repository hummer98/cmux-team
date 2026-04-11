# Inspection: T151

## 判定: GO

plan.md の全 Step が正しく実装されており、削除対象の関数・コードも完全に除去されている。
TypeScript エラーは3件あるが、すべて既存（dashboard.tsx の型不一致、main.ts L401 の null/undefined 不一致）であり、今回の変更に起因しない。

## チェックリスト

- [x] schema.ts: ConductorSessionMessage 型追加 (L77-82)
- [x] schema.ts: QueueMessage union に追加 (L99)
- [x] conductor.ts: spawnSingleConductor 削除 (grep 確認: コメント参照のみ残存、関数本体は完全削除)
- [x] conductor.ts: launchConductorOnSurface 削除 (grep 確認: 0件)
- [x] conductor.ts: spawnConductor 削除 (grep 確認: 0件)
- [x] conductor.ts: launchConductor 新規追加 (L76-116、paneId 自動解決 L82-84 あり)
- [x] conductor.ts: initializeConductorSlots 簡素化 (L166-183、sessionIds Map 削除済み)
- [x] conductor.ts: assignTask の non-null assertion 修正 (L352: `conductor.sessionId ?? ""`)
- [x] conductor.ts: resetConductor の sessionId 保持 (L462: コメント付きで sessionId を保持)
- [x] main.ts: cmdConductor で sessionId 自己生成 + HTTP POST (L853: `crypto.randomUUID()`, L854-871: fetch)
- [x] main.ts: abort から --session-id 削除 (L1594-1597: `cmux-team conductor\n` のみ、CMUX_CLAUDE_HOOKS_DISABLED=1 追加済み)
- [x] main.ts: restart から --session-id 削除 (L1677-1680: abort と同一パターン)
- [x] main.ts: cmdSend に CONDUCTOR_SESSION 追加 (L619-626: case 追加、L633: usage メッセージに含まれる)
- [x] main.ts: cmdSpawnConductor を launchConductor 呼び出しに変更 (L1033-1034)
- [x] main.ts: import 更新 (L33: `import { launchConductor } from "./conductor"`)
- [x] daemon.ts: CONDUCTOR_SESSION ハンドラ追加 (L561-576: findConductor + sessionId 設定 + ログ)
- [x] daemon.ts: pidWatcher の sessionId 保持 (L881-882: コメント付きで `conductor.sessionId = undefined` を削除)
- [x] TypeScript ビルド成功 (bun build 成功、tsc エラー3件は既存で今回の変更に起因しない)

## 詳細確認メモ

### 削除漏れ確認
- `spawnSingleConductor`: conductor.ts L106 のコメント内に「旧 spawnSingleConductor」として言及が残るが、歴史的理由の説明であり問題なし
- `conductor.sessionId!` (non-null assertion): grep で 0件。完全に除去済み
- `--session-id` (abort/restart): main.ts L885 の cmdConductor 内のみ残存（計画通り — 自己生成した sessionId を claude に渡す箇所）

### abort/restart の統一性
- abort (L1594-1597): `CMUX_CLAUDE_HOOKS_DISABLED=1` 追加、`newSessionId` 生成・直接設定削除
- restart (L1677-1680): abort と同一パターン

### エッジケース対応
- cmdConductor の HTTP POST 失敗時: catch ブロックで無視、Claude 起動は続行 (L869-871)
- assignTask の sessionId 未設定時: `?? ""` でフォールバック (L352)
- initializeConductorSlots のフォールバック: CONDUCTOR_REGISTERED 未到達時に手動登録 (L171-183)
