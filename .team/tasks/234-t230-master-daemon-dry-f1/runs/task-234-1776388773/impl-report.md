# T234 実装レポート

T230（Master self-register）の follow-up 5 項目を単一 worktree で実装した。

- worktree: `.worktrees/task-234-1776388773`
- ブランチ: `task-234-1776388773/task`

## 変更ファイル

| ファイル | 種別 | 変更 |
|---------|------|------|
| `skills/cmux-team/manager/paths.ts` | 新規 | +24 行 |
| `skills/cmux-team/manager/master.test.ts` | 新規 | +180 行 |
| `skills/cmux-team/manager/daemon.ts` | 変更 | +83 / -7 行 |
| `skills/cmux-team/manager/main.ts` | 変更 | +30 / -59 行 |
| `skills/cmux-team/manager/master.ts` | 変更 | +8 / -5 行 |
| `skills/cmux-team/manager/schema.ts` | 変更 | +6 / -0 行 |

## 実装内容

### [S12-2] stopDaemon clearInterval 漏れ対応

**対応**: `daemon.ts` に `stopDaemon(state)` を追加し、`state.conductors` / `state.conductors[].agents` / `state.masters` の全ウォッチャー interval を clearInterval する。

**配線**:
- `main.ts` の 3 箇所の `state.running = false` を `stopDaemon(state);` に置換
  - shutdown handler
  - `onReload`
  - `onFullQuit`
- `daemon.ts` の SHUTDOWN handler と「source changed」パスも `stopDaemon(state)` に統一

**設計判断**: `state.running = false` は即値代入のみでタイマーが残るため、SIGTERM や proxy-port 再起動時に Node プロセス終了まで interval が空転していた。`stopDaemon` は冪等（`interval = undefined` 後に再呼び出しても安全）。

### [S12-1] normalizeSurfaceForPath 重複定義整理

**対応**: 共有モジュール `paths.ts` を新設し、以下を集約。

```typescript
export function normalizeSurfaceForPath(surface: string): string {
  return surface.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}
```

- `master.ts`: 旧定義削除 → `paths` から re-export
- `daemon.ts`: 旧定義削除 → `paths` の実装を export

**設計判断**: master.ts の旧実装は `replaceAll(":", "_")`（コロンのみ置換）、daemon.ts は regex（英数字/_/- 以外を全て `_`）だった。`surface:NNN` 形式では両者の出力が一致するため、既存テスト / ファイルレイアウトに互換性がある regex 版を採用した。より防御的で、不正文字混入時もファイル名として安全。判断理由は `paths.ts` のコメントに残した。

### [S12-3] master.test.ts 新規作成

**対応**: `bun:test` を使用した 10 ケースのテスト。

- 正常系: persist → list、複数 surface、上書き
- 空ディレクトリ / ディレクトリ不在での list（throw しない）
- 不正 JSON / schema 違反 / 非 .json ファイルの skip
- deleteMasterFile の冪等性（不在削除 OK）
- ランタイム専用フィールド（`fallback`, `pidWatcherInterval`）が永続化されないことの検証
- `normalizeSurfaceForPath` のエッジケース（コロン置換、英数字保持、不正文字の `_` 化）

**設計判断**: `daemon.test.ts` のパターン（`mkdtemp` + `tmpdir()` + afterEach cleanup）を踏襲。`PROJECT_ROOT` env を testDir に向けて log ヘルパーを動作させる。タスク仕様書の関数名 `loadMasterFiles` は実コードでは `listMasterFiles` だったため正しい名前でテスト。

### [F1-cleanup] F1 fallback master 仮登録の掃除

**対応**:

1. `schema.ts`: `MasterState` 型にランタイム専用 `fallback?: boolean` を追加（Zod schema には含めない → 永続ファイルには書かない）。
2. `master.ts` の `persistMasterFile`: payload に fallback を含めない（既存仕様のまま）。
3. `daemon.ts` SESSION_STARTED handler の F1 fallback パス: 新規 MasterState に `fallback: true` を立てる。
4. `daemon.ts` CONDUCTOR_REGISTERED handler: 先頭で `state.masters.get(surface)?.fallback` を検査し、該当すれば `removeMaster` で掃除（`master_fallback_cleanup reason=conductor_registered_late`）。
5. `daemon.ts` MASTER_REGISTERED handler: 既存 entry が fallback の場合は **削除せず** `fallback` フラグを落として canonical 化（SESSION_STARTED で既に得ている pid/startedAt を保持）、永続ファイルを更新、`master_register_skipped` ログで idempotent skip。

**設計判断**: 「F1 cleanup」の解釈を整理。
- CONDUCTOR_REGISTERED での F1: 推測が **誤り**（本当は conductor だった）→ master entry を削除
- MASTER_REGISTERED での F1: 推測が **正しい**（master だった）→ entry を残し fallback フラグだけ落として canonical 化

master 側を削除・再生成する素直な実装では既存テスト `T4: SESSION_STARTED が MASTER_REGISTERED より先着した場合...` の期待（pid=99999 保持 + `master_register_skipped` ログ）が壊れるため、上記の方針で両立させた。

### [DRY] registerSelf 共通化

**対応**: `main.ts` の `registerSelfAsMaster` と `registerSelfAsConductor` を `registerSelf(role: "master" | "conductor", surface: string)` に統合。

- role → POST メッセージ種別 (`MASTER_REGISTERED` / `CONDUCTOR_REGISTERED`) / ログイベント名 / formatSurface ロール (`U` / `C`) をマッピング
- proxy ポート解決 / fetch POST / 失敗時 `exit(1)` / 成功ログの共通ロジックは 1 箇所に集約
- 呼び出し元 3 箇所を更新: `cmdConductor` / `cmdResume` / `cmdLaunchMaster`

**設計判断**: 後方互換は不要（feedback memory）なので薄いラッパーを残さず完全置換。grep で旧関数名への参照 0 件を確認済み。

## 検証結果

worktree 内 `skills/cmux-team/manager/` で実行。

### `bunx tsc --noEmit`

エラー 0 件。

初回は `master.test.ts` の `files[0]` に対する `TS2532 Object is possibly 'undefined'` が 8 件出たため、non-null assertion (`files[0]!`) で修正。

### `bun test`

```
436 pass
0 fail
963 expect() calls
Ran 436 tests across 21 files. [10.29s]
```

- 元の 423 pass + 新規 `master.test.ts` 13 pass（describe 2 つ合計）
- 初回は MASTER_REGISTERED handler の設計誤り（fallback を削除 → 再生成）で `T4` が 1 件失敗したが、設計を「fallback flag だけ落として entry 保持」に修正して全 pass。

## 懸念・残課題

- **`paths.ts` の defensive regex 化**: `docs/spec/05-install-and-infrastructure.md` にはコロン置換のみの記述がある。正規化ロジックを regex 化したので、仕様書側を次回 docs-sync で追従させる必要あり（本タスク範囲外）。
- **fallback フラグの lifecycle**: SESSION_STARTED F1 で立ち、CONDUCTOR_REGISTERED で削除 / MASTER_REGISTERED で落とす。restoreMasters（boot 復元）では永続ファイルに含まれないため自然に不在。handler 全経路を grep で確認済み、想定外の永続化パスは無し。
- **CONDUCTOR_REGISTERED の fallback 掃除は条件付き**: 掃除対象は `fallback=true` の master entry のみ。通常の master entry（`fallback` 未定義）は影響を受けない。既存の T4 と競合しない設計。

## 完了条件

- [x] 5 項目すべて実装
- [x] `bun test` 全 pass（436/436）
- [x] `bunx tsc --noEmit` エラー 0
- [x] 新規 `master.test.ts` 追加
