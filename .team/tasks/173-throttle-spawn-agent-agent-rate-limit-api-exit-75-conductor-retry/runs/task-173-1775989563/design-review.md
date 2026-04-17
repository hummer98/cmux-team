# Design Review — Task #173 (v2)

## 判定: Changes Requested

前回の review（v1）で指摘した `unified5hReset` の epoch 化、Conductor retry の空値・DEADLINE ガード、`daemon.ts:824` vs `dashboard.tsx:882` の記述訂正はすべて v2 plan で解消済み。新たに 1 件の blocker（`taskId` TDZ）と数件の確認事項がある。

## 主要所見

### 1. 行番号・既存実装の参照はすべて正確 ✓

実際にファイルを照合した結果、plan が引用する行番号・コード内容はすべて現物と一致。

- `proxy.ts:102-131` — /state, /tasks, /conductors の GET ルーティングが存在。L131 `}` 直前（`// Master 状態更新エンドポイント` の直前）が追加位置として妥当。
- `main.ts:1125-1170` — `cmdSpawnAgent` の冒頭〜タブ作成ブロック、plan の記述通り。`resolveProxyPort()` は L1138 に存在。
- `daemon.ts:1241-1259` — `formatResetRemaining` が既にコピー運用（コメント「dashboard.tsx からコピー」も一致）。epoch/ISO 両対応は L1244-1245。
- `dashboard.tsx:189-195` — 同じ複製が存在。3 箇所目のコピー方針に無理なし。
- `daemon.ts:824` — `(state.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD` のみ。
- `dashboard.tsx:882` — `isThrottled && daemon.running && daemon.bootPhase === "ready"`。
- `schema.ts:159` — `unified5hReset: string | null`（ISO 文字列で保持）。
- `schema.ts:171` — `THROTTLE_5H_THRESHOLD = 0.90`。
- `daemon.ts:40-41` — `DaemonState.running` / `bootPhase`、`opts.getState()` 経由でアクセス可。
- `templates/ja/conductor-role.md:109-118` — 依存タスク #169 のマージ後状態と完全一致。

### 2. **Blocker: `taskId` が TDZ（Temporal Dead Zone）** ⚠️

Plan 2 章「追加位置」で throttle チェックは `resolveProxyPort()` 直後（L1138 と L1141 の間）に挿入するとしている。一方、plan サンプルコード L128-129 で使用している `taskId` は `main.ts:1178` の `let taskId: string | undefined;` で宣言され、実際の解決は L1180-1182。

```ts
// main.ts 現在の構造
L1138:  const proxyPort = await resolveProxyPort();
// ← plan はここに throttle チェックを挿入したい
// ← でもその中で taskId を参照するとランタイム ReferenceError
...
L1178:  let taskId: string | undefined;
L1180-1182: team.json から解決
```

このまま実装すると throttled 時に `cmdSpawnAgent` 自体がクラッシュし、タブ未作成・exit 75 未送出・stdout フォーマット未出力の三重破綻となり、Conductor 側の retry ループは exit 1 と解釈して即 abort する。

### 3. その他の完全性 ✓

- `GET /rate-limit` のレスポンスフィールド（throttled / threshold / unified5h{Utilization,Reset} / unified7d{Utilization,Reset} / unifiedStatus / resetRemaining）は仕様網羅。
- `toEpochSec` の実装と適用範囲（unified5hReset / unified7dReset 両方）が明確で、ISO / epoch 両対応が v1 review の宿題を解消。
- exit 75 = BSD sysexits `EX_TEMPFAIL` のコメント追加も plan 3 章「方針メモ」で明記。
- proxy 失敗時の best-effort 続行、stdout の key=value 形式、複数行 stdout を `grep` + `cut` で parseする設計は Conductor 側の retry ループと整合。

### 4. Conductor retry ループのエッジケース網羅 ✓

- 空値 / 非整数 / 0 の `RESET` に対する冒頭ガード ✓
- 内側 wait ループの `DEADLINE` 監視 ✓（v1 review で指摘した暴走防止）
- `RESET >= DEADLINE` 時の即 abort ✓
- jitter 0-30 秒で同時 reset 殺到を回避 ✓
- 非 75 の非ゼロ exit は従来通り即 abort ✓

### 5. throttled 判定式の選択は妥当 ✓

`dashboard.tsx:882` 準拠（`running && bootPhase === "ready"` を追加）を採用している点は、spawn-agent が boot 完了後にのみ呼ばれる現実と整合し、過渡期の誤判定を防ぐ。

### 6. 互換性 ✓

- 既存 spawn-agent の exit 0 パス（stdout の `SURFACE=...` 等）は変更なし。
- dashboard.tsx、daemon.ts:824 の既存判定は不変 → #172 と衝突しない。
- 英語テンプレート未対応は対象外として明示されている。

### 7. セキュリティ / 副作用 ✓

- `/rate-limit` は localhost 限定・読み取り専用・認証なしで既存 `/state` 等と整合。
- stdout フォーマットに機密情報は含まれない。
- ログに API キー / トークン等は残らない。

## Recommendations

### R1（必須 / blocker）: `taskId` の解決タイミングを修正する

以下いずれかに plan を修正し、挿入位置とサンプルコードの `taskId` 参照が一貫するようにする。

**案 A（推奨）**: `main.ts:1177-1183` の `taskId` 解決ブロックを L1138 の `resolveProxyPort()` 直後に前倒しする。team.json を 2 回読むことにはなるが cost は軽微（同一プロジェクトの小さな JSON、同期 IO は発生しない）。または cmdSpawnAgent の冒頭（`requireArg` 直後）に `taskId` 解決を移し、throttle チェック・既存タブ作成ロジックの双方で同じ変数を参照させる。

**案 B**: throttle チェックの `await log("spawn_agent_throttled", ...)` から `task_id=...` を外す（`conductor=${conductorSurface} role=${role}` のみに）。task_id は後続の spawn 成功 / 失敗ログで追跡可能。plan 2 章の「判断のポイント」箇条書きから `task_id` 追加の利点記述を削除する。

plan 2 章「追加コード概要」のサンプルと「判断のポイント」「import 追加」の節を選んだ案に揃えて書き換えること。

### R2（確認）: `log` の API シグネチャ

plan 2 章のサンプルで `await log("spawn_agent_throttled", ...)` としているが、`main.ts` で実際に import されている logger が **非同期の `log` 関数**（ファイルパス: `skills/cmux-team/manager/logger.ts`）であることを実装時に再確認する。既に他箇所で `await log(...)` 形式が使われていれば問題ない。

### R3（軽微）: `resetRemaining: null` の境界条件を plan サンプルで反映

Plan 1 章「レスポンス仕様」で「reset が null / 不正 / 過去 → null」としているが、同 1 章「reset 値の型と正規化」で示している疑似コード例（`formatResetRemaining` を使う旨）では `""` / `"0m"` / `"<1m"` を null に読み替える変換が明示されていない。実装時に次のようなラッパー関数を用意する旨を plan に 1 行追記すると曖昧さが消える:

```ts
const remaining = formatResetRemaining(rawReset);
const resetRemaining = (!remaining || remaining === "0m" || remaining === "<1m") ? null : remaining;
```

「過去」だけでなく「< 1 分」も null に倒す判断は CLI 表示上むしろ望ましい（Conductor の `sleep 60` サイクルとの整合）。

## 軽微な提案（任意）

- **S1**: `/rate-limit` レスポンスの `threshold: number` について、「0.0-1.0 の float（例: 0.9）」であることをレスポンス仕様表のコメントに明記すると、`/rate-limit` を自前で叩く将来のユーザー / 別ツールの混乱を防げる。
- **S2**: `formatResetRemaining` 3 箇所目のコピーに「`dashboard.tsx` / `daemon.ts` からコピー — 別タスク（#175 等）で整理予定」のコメントを **同じ文面** で貼ると、将来 grep で 3 箇所同時整理できる。
- **S3**: exit 75（`EX_TEMPFAIL`）の意味を `main.ts` の throttle ブロック冒頭に 1 行コメントで残すと、将来別 exit code を追加する保守者の混乱を防げる（plan 2 章「判断のポイント」に既記載だが、実装ファイル側にも残す方が保守に有利）。
- **S4**: テスト方針 5 章のシミュレーション手段として、`daemon.state.rateLimit.unified5hUtilization = 0.95` を強制する方法が 3 つ候補で列挙されているが、最も再現しやすい「`.team/queue/incoming/` 経由の RPC」手順を 1 行サンプルで書いておくと、実装者が迷わない。
- **S5**: `log` の detail に `reset_epoch=${rl.unified5hReset ?? 0}` を含めると、`0` が「取得失敗」と「本当に 1970-01-01」の両方を意味する曖昧さが残る。`unified5hReset=${rl.unified5hReset ?? "null"}` として文字列 "null" を使えば grep で区別可能。

## 結論

設計の核心（`/rate-limit` 仕様、throttled 判定式、retry ループのガード、非破壊範囲）は堅牢。v1 review で指摘した 4 件はすべて解消済み。

**R1 の `taskId` TDZ のみ blocker** のため Changes Requested。R1 を plan 内で明確化すれば即実装に入って良い（本質的な設計変更ではなくコード配置の微修正）。
