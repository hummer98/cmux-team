---
id: 256
title: caffeinate フラグを -i から -dis に強化
priority: medium
created_by: surface:130
created_at: 2026-04-17T21:39:31.908Z
---

## タスク
## 背景

Manager daemon が起動中に Mac がスリープする事象が確認された。`pmset -g log` で確認したところ、蓋閉じでもないのに sleep に入っているログがあり、現在の `caffeinate -i` は `PreventUserIdleSystemSleep` しか立てないため idle 以外の経路（display sleep → system sleep の連鎖等）を防げていない可能性が高い。

## 変更内容

`skills/cmux-team/manager/main.ts:423` の caffeinate 起動コマンドを変更する:

```ts
// 変更前
caffeinateProc = Bun.spawn(["caffeinate", "-i"], { ... });
// 変更後
caffeinateProc = Bun.spawn(["caffeinate", "-dis"], { ... });
```

### フラグの意味

- `-d`: PreventUserIdleDisplaySleep（display sleep 防止 → 連鎖 system sleep を断つ）
- `-i`: PreventUserIdleSystemSleep（現状維持）
- `-s`: PreventSystemSleep（AC 電源時のみ有効）

### トレードオフ

- **`-d` によりディスプレイが常時点灯**する。Manager 稼働中はずっと画面が明るい状態になる。
- **`-s` はバッテリー駆動時は無視される**仕様。AC 時のみ効果あり。

### 代替案（実装時に判断可）

- `-is` のみ: display は sleep できるが、display→system の連鎖経路は防げない
- `-dis`（推奨）: 最も確実だがディスプレイが常時点灯
- 設定可能化: `config.ts` の `sleepPrevention` を `boolean` から `off | idle | aggressive` のような enum にする（スコープクリープ気味なので慎重に判断）

## 制約

- Apple Silicon + 蓋閉じの `Clamshell Sleep` はどのフラグでも防げない（ハードウェア強制）。これは本タスクのスコープ外。

## 影響範囲・更新必須ファイル

- `skills/cmux-team/manager/main.ts:423` — caffeinate 起動コマンド
- `skills/cmux-team/manager/i18n.ts:91, 101, 734, 744` — ヘルプテキストの説明文（`caffeinate -i` と書かれている箇所）
- `CLAUDE.md` / `docs/spec/` — caffeinate 関連の記述があれば更新
- `CHANGELOG.md` — 挙動変更（ディスプレイ常時点灯）は破壊的変更に近いのでエントリ必須

## 検証

1. 変更後ビルド → `cmux-team start` で Manager 起動
2. `pmset -g assertions | grep -i prevent` で以下を確認:
   - `PreventUserIdleDisplaySleep 1`
   - `PreventUserIdleSystemSleep 1`
   - `PreventSystemSleep 1`（AC 接続時のみ）
3. Manager 稼働中にディスプレイが sleep しないこと
4. 全 agent idle 時に caffeinate が停止し assertion が解除されること

