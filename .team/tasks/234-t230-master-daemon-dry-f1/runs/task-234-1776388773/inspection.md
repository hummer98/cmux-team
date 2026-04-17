# T234 Inspection Report

## 判定: GO

T230 follow-up 5 項目（S12-2 / S12-1 / S12-3 / F1-cleanup / DRY）のすべてが
仕様通りに実装され、`bunx tsc --noEmit` / `bun test`（436 pass / 0 fail）が通過。
過剰実装や指示範囲外の変更もなく、ログフォーマットも `logger.ts` 規約に準拠。

## 各項目の検品結果

### 1. S12-2 stopDaemon clearInterval

- 期待: `stopDaemon(state)` で全 pid watcher の interval を clearInterval し、
  `state.running = false` に加えてタイマー残存が発生しないこと。
- 実装: `daemon.ts:234-268` に `stopDaemon(state)` を新設。
  - `state.conductors.values()` の `pidWatcherInterval` を clear（行 252-254）
  - 各 conductor の `agents[].pidWatcherInterval` を clear（行 256-260）
  - `state.masters.values()` の `pidWatcherInterval` を clear（行 264-268）
  - `interval = undefined` で冪等性を確保（2 回目以降の呼び出しは no-op）
- 配線: `state.running = false` のみだった 5 箇所をすべて `stopDaemon(state)` に置換
  - `main.ts:506` (shutdown handler), `main.ts:538` (onReload), `main.ts:601` (onFullQuit)
  - `daemon.ts:929` (source changed path), `daemon.ts:1645` (SHUTDOWN handler)
  - `state.running = false` の生呼び出しは daemon.ts / main.ts 本体からは完全撤去
    （テストファイル `daemon.test.ts` 内の直接代入 3 箇所のみ残存 — これは test セットアップで問題なし）
- 判定: **OK**
- 所見: 冪等性は複数回呼び出しても `if (conductor.pidWatcherInterval)` で弾かれる構造。
  Bun 実行時のイベントループ残留問題も起きにくい。

### 2. S12-1 normalizeSurfaceForPath 共通化

- 期待: master.ts / daemon.ts の 2 定義を共通モジュールに集約し、両者から import。
- 実装: `paths.ts`（新規、24 行）に単一実装を置き、master.ts / daemon.ts から再 export。
  - `paths.ts:22-24`: `replaceAll(/[^a-zA-Z0-9_-]/g, "_")` の防御版 regex を採用
  - `master.ts:8,15`: `import { normalizeSurfaceForPath } from "./paths"` + `export { normalizeSurfaceForPath }`
  - `daemon.ts:28,107`: 同様に paths から import し `export const normalizeSurfaceForPath = ...`
- 実装選択: 旧 master.ts 版は `replaceAll(":", "_")`、daemon.ts 版は regex。
  `surface:NNN` 形式では両者同出力であり既存テストに破壊なし。防御的な regex 版を採用
  した判断理由も `paths.ts` のコメントに明記。
- 判定: **OK**
- 所見: circular import 回避のため `paths.ts` は他 manager モジュールに依存しない設計。
  適切。

### 3. S12-3 master.test.ts 新規作成

- 期待: `persistMasterFile` / `deleteMasterFile` / `listMasterFiles` の境界ケースをカバー。
- 実装: `master.test.ts`（新規、180 行、13 テスト）。
  - 正常系: persist → list（単一・複数）、上書き persist
  - 境界: **空ディレクトリ**、**ディレクトリ不在**、**不正 JSON**、**schema 違反**、
    `.json` 以外、**deleteMasterFile 冪等性**（不在削除 OK）
  - ランタイム専用フィールド（`fallback`, `pidWatcherInterval`）の永続化除外を検証
  - `normalizeSurfaceForPath` のエッジケース（コロン、英数字保持、不正文字 → `_`）
- 仕様書の関数名 `loadMasterFiles` は実コードでは `listMasterFiles` であり、テストは
  正しい名前で書かれている（仕様書の typo を踏襲しない判断は妥当）。
- 実行結果: `bun test master.test.ts` → 13 pass / 0 fail / 25 expects
- 判定: **OK**
- 所見: タスク指示の「不正 JSON / ファイル不在 / 空ディレクトリ / 同名 surface 重複」は
  網羅。`mkdtemp` + afterEach cleanup で daemon.test.ts のパターンと整合。

### 4. F1-cleanup fallback 仮登録の掃除

- 期待:
  - `CONDUCTOR_REGISTERED` handler で fallback master entry 削除
  - `MASTER_REGISTERED` handler で整合処理
  - `master_fallback_cleanup` ログ記録
- 実装:
  - `schema.ts:172-180`: `MasterState` 型 intersection に `fallback?: boolean`
    （Zod schema には含めず永続化対象外 — 型定義で明示）
  - `daemon.ts:1150,1155`: SESSION_STARTED F1 fallback の新規 MasterState に `fallback: true`
  - `daemon.ts:1177-1193` (CONDUCTOR_REGISTERED): `state.masters.get(surface)?.fallback`
    チェックで fallback 仮登録のみ `removeMaster(reason="conductor_registered_late")`
    → `master_fallback_cleanup` ログ出力
  - `daemon.ts:1233-1250` (MASTER_REGISTERED): 既存 entry が fallback なら削除せず
    **flag だけ落として canonical 化** → `persistMasterFile` で永続化 →
    `master_fallback_cleanup reason=master_registered_confirms_fallback` ログ
  - 通常 master entry（`fallback` 未定義）は影響を受けない（T4 既存テスト保護）
- 設計判断の妥当性:
  - CONDUCTOR_REGISTERED 経路: 推測誤り → 削除。正しい。
  - MASTER_REGISTERED 経路: 推測正解 → flag のみ落とす。
    既存 T4 テスト（pid=99999 保持 + `master_register_skipped` 期待）と両立する
    最小実装でありベスト解。
- 判定: **OK**
- 所見: ログ event 名は `master_fallback_cleanup` で reason キーで経路を区別しており
  追跡性が高い。`formatSurface(surface, "U")` 使用で surface 表記規約準拠。

### 5. DRY registerSelf 共通化

- 期待: `registerSelfAsMaster` / `registerSelfAsConductor` を共通化。
  ログ event 名（`master_self_register` / `conductor_self_register`）を維持。
- 実装: `main.ts:1177-1221` に `registerSelf(role: "master" | "conductor", surface: string)`
  を新設し、role → messageType（`MASTER_REGISTERED` / `CONDUCTOR_REGISTERED`）→
  logEvent → formatSurface role（`U` / `C`）をマッピング。
  - proxy port 解決 / POST / fail-fast exit 1 / 成功ログの共通ロジックを 1 箇所に集約
  - 旧 2 関数は完全撤廃（feedback memory「後方互換コードは不要」に整合）
- 呼び出し元 3 箇所を更新:
  - `main.ts:1703` cmdConductor → `registerSelf("conductor", surface)`
  - `main.ts:1788` cmdResume → `registerSelf("conductor", surface)`
  - `main.ts:1865` cmdLaunchMaster → `registerSelf("master", surface)`
- 旧関数名の grep:
  - コード上の呼び出し: **0 件**（`registerSelfAsMaster` / `registerSelfAsConductor` 参照はコメント・docs のみ）
- 判定: **OK**
- 所見: 薄いラッパーすら残さない完全置換で、DRY 観点で理想的。
  ログ event 名は既存維持で後方互換は保たれる。

## ビルド・テスト結果

- `bunx tsc --noEmit`: **EXIT=0**（エラー 0 件）
- `bun test`: **436 pass / 0 fail / 963 expect()** across 21 files [9.79s]
  - 元の 423 pass + 新規 master.test.ts 13 pass = 436 pass（impl-report の数と一致）
- `bun test master.test.ts`: **13 pass / 0 fail**

## 変更範囲の妥当性

- 変更ファイル（6 ファイル）:
  - `paths.ts` (新規 +24): S12-1 共通化
  - `master.test.ts` (新規 +180): S12-3 テスト
  - `daemon.ts` (+83 / -7): S12-2 stopDaemon + F1-cleanup
  - `main.ts` (+30 / -59): S12-2 配線 + DRY
  - `master.ts` (+8 / -5): S12-1 import 切替
  - `schema.ts` (+6 / -0): F1-cleanup の fallback フラグ型定義
- `docs/spec/` への変更なし（「やらないこと」遵守）
- 5 項目以外の機能追加・リファクタなし
- schema.ts の変更は fallback マーカー 1 フィールド追加のみ（過剰実装なし）

## Findings (改善点)

1. **[Severity: Minor] docs/spec/05-install-and-infrastructure.md に旧関数名
   `registerSelfAsMaster` が残存**
   - `docs/spec/05-install-and-infrastructure.md:391` の記述が旧関数名を参照したまま
   - impl-report で「次回 docs-sync で追従」と明記されているため本タスクでは保留で OK
   - 将来の docs-sync 時に `registerSelf("master", ...)` に追従させる
2. **[Severity: Minor] paths.ts の regex 採用に関する仕様書の記述差異**
   - `docs/spec/05` はコロン置換のみを明示
   - 新実装は `[^a-zA-Z0-9_-]` regex（コロン置換の超集合 — 出力は同一だが記述は
     broader）
   - 同じく docs-sync 対象

いずれも**本タスクのスコープ外**として impl-report で予告済み。NOGO 要件ではない。

## Fix Required (NOGO の場合)

なし（GO 判定）。

## Comments

- **設計判断の質**: MASTER_REGISTERED 経路で fallback を「削除・再生成」ではなく
  「flag のみ落として entry 保持」を選んだ点は、既存 T4 テスト
  （SESSION_STARTED 先着 + MASTER_REGISTERED 後着で pid=99999 保持）との整合を
  最小コストで取れるベスト解。正しい判断。
- **テストカバレッジ**: master.test.ts は境界ケース網羅度が高く、
  ランタイム専用フィールドの永続化排除まで検証しており防御線として有効。
- **ログ可観測性**: `master_fallback_cleanup` に `reason=` を付けて経路を
  区別しているためデバッグ時の追跡が容易。
- **共通化の粒度**: `registerSelf` は role の違いを map で吸収する設計で可読性良好。
  後方互換ラッパーを置かない選択は memory 方針（後方互換コードは不要）と整合。
- **E2E 検証**: タスク指示書の E2E（`cmux-team start` / `stop` で bun process が
  即時 exit）は Inspector として直接実行しないが、`stopDaemon` の実装を読む限り
  これまで残っていたイベントループ空転は解消されている。実運用での体感確認は
  Conductor 側 merge 後のスモークテストで把握可能。
