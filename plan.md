# T097: Master idle 時にスピナーが回り続けるバグ — 修正計画

## 1. バグの根本原因分析

### 現象

TUI ダッシュボードで Master が idle 状態になった後も、Master 行のスピナーが回り続ける。

### 原因: `spinnerInterval` が DaemonState をダッシュボードに同期していない

`dashboard.tsx` の `spinnerInterval`（1061-1065行目）は 180ms ごとに `spinnerFrame` のみをインクリメントし、`app.update` で再描画をトリガーしている。しかし、**DaemonState（`masterStatus` 等）をダッシュボードの AppState に同期していない**。

```typescript
// 現在のコード（dashboard.tsx:1061-1065）
spinnerInterval = setInterval(() => {
    try {
      app.update((s) => ({ ...s, spinnerFrame: s.spinnerFrame + 1 }));
    } catch {}
  }, SPINNER_INTERVAL);
```

一方、DaemonState の `masterStatus` は以下の経路で更新される:

| 経路 | トリガー | 更新先 |
|------|---------|--------|
| `.claude/settings.json` の `UserPromptSubmit` hook | ユーザーがプロンプト送信 | `POST /master-state` → `state.masterStatus = "running"` |
| `.claude/settings.json` の `Stop` hook | Claude 応答完了 | `POST /master-state` → `state.masterStatus = "idle"` |
| キューメッセージ `SESSION_ACTIVE` | daemon がメッセージ受信 | `handleMessage()` → `state.masterStatus = "running"` |
| キューメッセージ `SESSION_IDLE` | daemon がメッセージ受信 | `handleMessage()` → `state.masterStatus = "idle"` |

`proxy.ts` の `/master-state` エンドポイント（126-143行目）は DaemonState を**直接変更する**が、ダッシュボードの AppState は反映されない。AppState が更新されるのは `refresh()` が呼ばれたときのみ。

### `refresh()` の呼び出しタイミング

`refresh()` は `scheduleRefresh()` 経由でのみ呼ばれ、`scheduleRefresh()` はメインループの `tick()` 後にのみ呼ばれる:

```
メインループ: tick() → updateTeamJson() → scheduleRefresh() → sleepUntilWakeup(10秒)
```

**つまり、Master が idle になってから最大10秒間、ダッシュボードは古い `masterStatus = "running"` を表示し続ける。** その間 `spinnerInterval` が 180ms ごとに再描画するため、ユーザーにはスピナーが回り続けているように見える。

### 副次的問題: `spinnerInterval` が不要な再描画を行う

全 Conductor と Master が idle の場合でも `spinnerInterval` は 180ms ごとに再描画を行う（毎秒約5.5回）。アニメーションが不要な状態で CPU を浪費している。

## 2. 修正方針

### 修正箇所: `dashboard.tsx` の `spinnerInterval` コールバック（1061-1065行目）

`spinnerInterval` で `getState()` を呼び DaemonState を同期する。さらに、アニメーションが不要な場合は `app.update` をスキップして不要な再描画を防止する。

```typescript
// 修正後のコード
let wasAnimating = false;

spinnerInterval = setInterval(() => {
    try {
      const daemon = getState();
      const needsAnimation =
        daemon.masterStatus === "running" ||
        [...daemon.conductors.values()].some(c => c.status === "running" || c.status === "starting");

      if (needsAnimation) {
        wasAnimating = true;
        app.update((s) => ({ ...s, daemon, spinnerFrame: s.spinnerFrame + 1 }));
      } else if (wasAnimating) {
        // アニメーション → idle 遷移時: 最後の1回で idle 状態を反映
        wasAnimating = false;
        app.update((s) => ({ ...s, daemon }));
      }
    } catch {}
  }, SPINNER_INTERVAL);
```

### 動作フロー

1. **Master が running のとき**: `needsAnimation = true` → DaemonState を同期しつつスピナーフレームを進める（180ms 間隔でアニメーション）
2. **Master が idle に遷移した瞬間**: 次の 180ms tick で `needsAnimation = false`, `wasAnimating = true` → DaemonState を同期して idle 表示に切り替え
3. **全てが idle のとき**: `needsAnimation = false`, `wasAnimating = false` → `app.update` を呼ばない（CPU 節約）

### 修正が不要な箇所

- `buildMasterSection()` (291-328行目): idle/running の分岐ロジックは正しい。問題は表示ロジックではなく、データの同期タイミング
- `proxy.ts` の `/master-state` エンドポイント: DaemonState 更新ロジックは正しい。ダッシュボード側で読み取れていなかっただけ
- `refresh()` / `scheduleRefresh()`: tick ベースのフルリフレッシュ（ログ・ジャーナル・artifacts 含む）は引き続き必要。spinnerInterval の daemon 同期はあくまでスピナー表示のための軽量同期

## 3. 影響範囲

### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/dashboard.tsx` | `spinnerInterval` コールバックを修正（1061-1065行目付近） |

### 影響なし

- `daemon.ts`: 変更なし
- `proxy.ts`: 変更なし
- `main.ts`: 変更なし
- テンプレート・スキル: 変更なし

### パフォーマンス改善

- idle 時の不要な再描画がなくなる（180ms/回 × 5.5回/秒 → 0回/秒）
- `getState()` は DaemonState オブジェクトの参照を返すだけで I/O なし → 180ms ごとの呼び出しコストは無視できる

### リスク

- 低: `getState()` が返す DaemonState は proxy.ts と daemon.ts で共有される同一オブジェクト。spinnerInterval からの読み取りは副作用なし
- `wasAnimating` フラグの初期値は `false` で、起動直後に running 状態のものがあれば次の tick で `true` に切り替わる。フラグの初期状態による問題なし

## 4. 完了条件

### 動作確認

1. **Master idle 時にスピナーが停止すること**: `cmux-team start` → Master spawn → ユーザーがプロンプトを送信 → 応答完了後にスピナーが停止し `●` (緑) が表示される
2. **Master running 時にスピナーが回ること**: ユーザーがプロンプトを送信したとき、180ms 以内にスピナーが開始される
3. **Conductor のスピナーが影響を受けないこと**: Conductor running 時のスピナーが正常に動作する
4. **idle 状態で不要な再描画が行われないこと**: 全て idle のときに CPU 使用率が低い状態を維持する
