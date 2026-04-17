# タスク割り当て

## タスク内容

---
id: 173
title: THROTTLE 中に spawn-agent が新規サブ Agent を起動してしまう穴を塞ぐ: /rate-limit API + exit 75 + Conductor retry
priority: medium
depends_on: [169]
created_at: 2026-04-12T09:01:01.527Z
---

## タスク
# 背景

現状の rate-limit throttle は **idle Conductor への新規タスク割り当て**しか止めていない。daemon.ts:800-814 で `THROTTLE_5H_THRESHOLD = 0.90` を超えていると `allExecutable` を skip するロジック。

一方で **実行中の Conductor が `cmux-team spawn-agent` でサブ Agent を起動するのは素通り**している。トークン消費の最大源は Conductor 自身ではなくサブ Agent（Planner/Implementer/Inspector 等）なので、ここが素通りだと throttle の意味が薄い。

実際に 2026-04-12 14:15 前後の manager.log で、95% throttle 中にも関わらず `agent_spawned conductor_surface=surface:245 surface=surface:402 role=impl` が発火している。

# 方針（ユーザー確定）

1. **proxy に `GET /rate-limit` エンドポイントを新設**し、rate-limit 情報全般を外部公開する（専用 API として正式化）
2. **`spawn-agent` コマンドの先頭で `/rate-limit` を fetch し、`throttled: true` なら spawn せずに exit 75 + stdout で structured response を返す**
3. **`conductor-role.md` に exit 75 を捕まえて reset まで待機 → retry するループ**を追加（jitter 入り）
4. dashboard 側（#172 で進行中）の `isThrottled` 判定は**触らない**。in-memory アクセスのまま。

# 詳細設計

## 1. `proxy.ts` に `GET /rate-limit` を追加

`skills/cmux-team/manager/proxy.ts:102-131` 近辺の GET エンドポイント群（`/state`, `/tasks`, `/conductors`）と同じパターンで追加。

レスポンス仕様:

```typescript
{
  throttled: boolean,            // unified5hUtilization >= THROTTLE_5H_THRESHOLD && running && bootPhase === "ready"
  threshold: number,             // THROTTLE_5H_THRESHOLD (0.90)
  unified5hUtilization: number | null,
  unified5hReset: number | null, // epoch seconds
  unified7dUtilization: number | null,
  unified7dReset: number | null,
  unifiedStatus: string | null,  // \"allow\" | \"rate_limited\" | ...
  resetRemaining: string | null, // \"1h 42m\" のような人間可読
}
```

- rate limit 情報がまだ取れていない起動直後は `throttled: false, threshold: 0.90, ...null` を返す
- `resetRemaining` は 5h reset までの残時間（human-friendly）
- `THROTTLE_5H_THRESHOLD` は `schema.ts:171` にある既存定数をインポート
- レスポンス生成ロジックは daemon.ts の isThrottled 判定と同じ式を**共有ヘルパー関数に切り出す**と重複しない（必須ではない。重複実装でも可）

## 2. `main.ts cmdSpawnAgent` で throttle チェック

`skills/cmux-team/manager/main.ts:1057` から始まる `cmdSpawnAgent`。

- タブ作成（1072 行目以降）の**前**に `/rate-limit` を fetch
- proxy port は `.team/proxy-port` から取得（既存の `resolveProxyPort()` ヘルパー、1070 行目で使用）
- `throttled: true` の場合:
  - タブも作らない、Claude も起動しない
  - **stdout に以下の構造化テキストを出力**:
    ```
    THROTTLED=true
    RESET_EPOCH=1775977200
    RESET_REMAINING=1h 42m
    UTILIZATION=95%
    THRESHOLD=90%
    MESSAGE=Rate limit exceeded. Wait until RESET_EPOCH before retrying spawn-agent.
    ```
  - **exit 75** （POSIX sysexits.h の `EX_TEMPFAIL` = temporary failure, retry later。既存の exit 42 は daemon 自動再起動で使用中なので避ける）
- proxy への fetch が失敗した場合は warn ログを出して通常通り続行（throttle チェックは best-effort。proxy が死んでいる場合に spawn-agent がロックされるのを避ける）

## 3. `conductor-role.md` に retry ループを追加

`skills/cmux-team/templates/ja/conductor-role.md:109-118` の既存 spawn-agent 呼び出しを以下のパターンに置き換え:

```bash
# throttle 対応付き spawn ループ
while true; do
  RESULT=$(cmux-team spawn-agent \
    --conductor-surface $CMUX_SURFACE \
    --role impl \
    --task-title "<サブタスクの簡潔な説明>" \
    --prompt-file "$PROMPT_FILE")
  EC=$?

  if [ $EC -eq 75 ]; then
    # throttle 中: reset まで待機
    RESET=$(echo "$RESULT" | grep '^RESET_EPOCH=' | cut -d= -f2)
    REMAINING=$(echo "$RESULT" | grep '^RESET_REMAINING=' | cut -d= -f2-)
    echo "THROTTLED. Waiting until reset: $REMAINING (epoch $RESET)"

    # reset まで sleep（1 分単位、最長 1 時間）
    while [ $(date +%s) -lt $RESET ]; do
      sleep 60
    done

    # jitter: 複数 Conductor の同時リトライを分散（0-30 秒のランダム待機）
    sleep $((RANDOM % 30))
    continue
  fi

  if [ $EC -ne 0 ]; then
    echo "spawn-agent failed (exit $EC): $RESULT"
    exit $EC
  fi

  AGENT_SURFACE=$(echo "$RESULT" | grep -o 'SURFACE=surface:[0-9]*' | cut -d= -f2)
  echo "Agent spawned: $AGENT_SURFACE"
  break
done
```

注意:
- `sleep 60` の内側ループは長くなりすぎないよう上限を設けたい（例: 最大 2 時間でブレーク → エラー扱い）
- exit 75 以外の非ゼロ exit は従来通りエラーとして扱う
- jitter 値は 0-30 秒。複数 Conductor が reset 直後に同時起床して再度 rate limit を叩くのを防ぐ

## 4. dashboard は触らない

`dashboard.tsx` の `isThrottled` 判定（871 行目）は in-memory アクセスのままにする。#172 が同ファイルの throttleLabel 簡素化を進めているので、衝突を避ける。

将来的に dashboard も `/rate-limit` API 経由にリファクタしたくなったら別タスクで。

# テスト観点

1. proxy 起動後に `curl http://localhost:$(cat .team/proxy-port)/rate-limit | jq` で期待通りの JSON が返る（throttle 中 / 非 throttle 両方）
2. spawn-agent を throttle 中に呼んで exit 75 が返り、stdout に `THROTTLED=true` が含まれる
3. spawn-agent を非 throttle で呼んで従来通り `SURFACE=surface:XXX` が返り exit 0
4. conductor-role.md のシェル片が単体で動作する（bash で exit 75 の mock を作って test）
5. proxy を落とした状態で spawn-agent を呼んでも（fetch 失敗時）通常通り spawn されることを確認

# 依存

- **#169（send-agent 追加タスク）に depends-on**。#169 が conductor-role.md と spawn-agent 周辺を編集中のため、マージ後に本タスクを走らせる
- #172（THROTTLED 表示の重複解消）とは並行可（dashboard のみに閉じるので衝突しない）

# やらないこと

- dashboard の isThrottled 判定は触らない
- daemon.ts 側の既存 throttle 判定（800-814）は触らない（別レイヤーなのでそのままで問題ない）
- 英語テンプレート (`templates/en/`) は今回対象外
- proxy の認証（localhost のみなので不要）

# 完了条件

- `proxy.ts` に `GET /rate-limit` エンドポイントが追加されている
- `main.ts cmdSpawnAgent` が throttle 時に exit 75 + 構造化 stdout を返す
- `templates/ja/conductor-role.md` に exit 75 retry ループ（jitter 入り）が追加されている
- 既存の非 throttle 動作に影響なし


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-173-1775989563` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-173-1775989563
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-173-1775989563/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/173-throttle-spawn-agent-agent-rate-limit-api-exit-75-conductor-retry/runs/task-173-1775989563
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/173-throttle-spawn-agent-agent-rate-limit-api-exit-75-conductor-retry/runs/task-173-1775989563/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
