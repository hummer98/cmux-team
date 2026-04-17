# T244 Summary: reload/再起動時の Master fallback 誤作成対策

## 結論

タスク背景にあった「reload 時に誤作成された Master」は **reload 事象ではなく、Agent spawn 時の race condition** だった。`cmdSpawnAgent` が `AGENT_SPAWNED` を Claude 起動**後**に POST していたため、Claude の SessionStart hook が送る `SESSION_STARTED` が先に daemon に届き、daemon の fallback 経路が「未登録 surface = master」と誤判定して master 仮登録する現象が発生していた。

## 実施した変更

### 対策 A（根本対策）: `main.ts:cmdSpawnAgent` で AGENT_SPAWNED を Claude 起動前に POST

**Before:**
```
L2013 newSurface
L2044 cmux.send(export ROLE=...)
L2068 cmux.send(claudeCmd)   ← Claude 起動、SessionStart hook 発火
L2075 postMessage(AGENT_SPAWNED)  ← 遅すぎる
```

**After:**
```
L2013 newSurface
L2027 postMessage(AGENT_SPAWNED)  ← surface 作成直後・Claude 起動前
L2059 cmux.send(export ROLE=...)
L2083 cmux.send(claudeCmd)   ← この時点では daemon 側で agent 登録済み
```

これにより、Claude 起動 → SessionStart hook → `SESSION_STARTED` が daemon に届いた時点で surface は必ず `state.conductors.<c>.agents` に登録されており、`agentMatched` 経路に入る。fallback 経路は暴発しない。

### 対策 B（保険）: `daemon.ts` の AGENT_SPAWNED ハンドラに master fallback 掃除を追加

`CONDUCTOR_REGISTERED` ハンドラ（T234, daemon.ts:1211-1227）と対称的に、`AGENT_SPAWNED` ハンドラ（daemon.ts:1022-1056）にも以下を追加:

```ts
const staleMaster = state.masters.get(message.surface);
if (staleMaster?.fallback) {
  await removeMaster(state, message.surface, "agent_spawned_late");
  await log("master_fallback_cleanup",
    `${formatSurface(message.surface, "U")} reason=agent_spawned_late`);
}
```

対策 A で通常経路の race は解消されるが、キュー詰まり・手動 POST・将来的な変更への保険として残す。

### 関連コメント更新

`daemon.ts:1156-1190` の fallback 経路コメントを、対策 A/B で保証される内容に合わせて更新。

### テスト追加

`daemon.test.ts` に 3 ケース追加（全 pass 確認済み、既存 92 テスト回帰なし）:

- `fallback=true の master が存在する場合、AGENT_SPAWNED で master を掃除し conductor.agents に追加する`
- `fallback=false(本物の master) が存在する場合、AGENT_SPAWNED で master は削除しない`
- `master 未登録の通常経路では AGENT_SPAWNED は normally conductor.agents に追加されるだけ`

## 検証結果

- `bun test daemon.test.ts` — **92 pass / 0 fail / 269 expect() calls**
- `tsc --noEmit` — エラーなし

## 変更ファイル

- `skills/cmux-team/manager/main.ts` — AGENT_SPAWNED POST の位置を変更
- `skills/cmux-team/manager/daemon.ts` — AGENT_SPAWNED ハンドラに fallback 掃除追加、コメント更新
- `skills/cmux-team/manager/daemon.test.ts` — T244 テストケース 3 つ追加

## Dear プロジェクトの手動清掃手順（既存被害の回復）

Dear には `.team/masters/surface_67.json` が `disconnected` で残存している。以下の手順で安全に削除:

```bash
cd ~/git/Dear

# 1. daemon が掴んでいないか確認
cmux-team status | grep surface:67

# 2. team.json.masters に surface:67 が残っているか確認
jq '.masters[] | select(.surface == "surface:67")' .team/team.json

# 3. 安全に削除
rm -f .team/masters/surface_67.json

# 4. daemon を再起動して state を再同期（必要な場合）
cmux-team stop && cmux-team start
```

本タスクの対策 A/B を含むバージョンをリリース→デプロイ後は、同種の disconnected master が増えることはない。

## follow-up タスク化が望ましい項目（research.md より）

- **C**: SessionStart hook の payload に role を含める（設計変更大、T216 ポリシーとの調整要）
- **D**: `cmdCloseAgent` / `cmdKillAgent` で surface が master でないことを検証して誤操作防止
- **E**: 起動時に fallback=true の古い master エントリを掃除するロジック
