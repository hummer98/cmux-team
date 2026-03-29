# 改修プラン: Agent 状態判定を `read-screen` → `list-status` に移行

## 背景

リサーチ (run-1774764648) により、cmux が Claude Code hooks を自動注入しており `cmux list-status` で Running/Idle/Needs input を正確に取得できることが判明。現在の `read-screen` + パターンマッチ (`❯` + `esc to interrupt`) は誤判定リスクがあり、置き換えが妥当。

## メリット

| 項目 | read-screen (現状) | list-status (改修後) |
|------|-------------------|---------------------|
| 判定精度 | 中（パターン依存） | 最高（hooks ベース） |
| 応答速度 | ~50ms | ~5ms |
| Needs input 検出 | 不可 | 可能 |
| UI 変更耐性 | 弱い | 強い |

## 重要な制約

- `list-status` は **workspace 単位**の API（`--surface` フラグなし）
- workspace 内の各 Claude セッションは `claude_code`, `c1`, `c2`, ... として列挙される
- surface → `cN` のマッピングの安定性が未検証 → **Phase 0 で実験が必須**

## 改修フェーズ

```
Phase 0 (実験検証) ─┬→ Phase 1 (conductor.md)  ─┬→ Phase 3 (SKILL.md)  ─┬→ Phase 4 (docs)
                     └→ Phase 2 (manager.md)    ─┘                       └→ Phase 5 (read-screen 再定義)
```

### Phase 0: list-status の surface↔cN マッピング実験検証 [ブロッカー]

**全フェーズの方針を決定する実験。** 結果次第で Phase 1 の実装が A案/B案に分岐する。

検証項目:
1. Agent spawn 時に新 `cN` エントリが出現するか
2. Agent 完了時に対応 `cN` が `Idle` に変わるか
3. `cN` 番号の割り当てルール（作成順序に対応するか）
4. Agent タブ close 時に `cN` が消えるか

### Phase 1: Conductor テンプレート — Agent 監視ループ置換

**対象:** `skills/cmux-team/templates/conductor.md`

Phase 0 結果による分岐:

**A案 (cN マッピングが安定):**
```bash
# spawn 直後に cN を特定
STATUS_BEFORE=$(cmux list-status --workspace "$WS")
# ... spawn agent ...
STATUS_AFTER=$(cmux list-status --workspace "$WS")
AGENT_KEY=$(diff <(echo "$STATUS_BEFORE") <(echo "$STATUS_AFTER") | grep "^>" | head -1 | cut -d= -f1)

# 監視ループ
while true; do
  STATE=$(cmux list-status --workspace "$WS" | grep "^${AGENT_KEY}=" | sed 's/.*=//' | sed 's/ .*//')
  case "$STATE" in
    Running) ;;  # 実行中
    Idle|○*)  echo "Agent 完了"; break ;;
    Needs*)   echo "WARNING: Agent が入力待ち" ;;
  esac
  sleep 30
done
```

**B案 (cN マッピングが不安定):**
- 全 `cN` エントリが非 Running になったら全 Agent 完了と判定
- 個別 Agent の状態は `read-screen` をフォールバックとして残す

### Phase 2: Manager テンプレート — Conductor 監視フォールバック置換

**対象:** `skills/cmux-team/templates/manager.md`

変更量: 小。フォールバック部分 1 箇所のみ。
```bash
# 旧: read-screen フォールバック
SCREEN=$(cmux read-screen --surface surface:N --lines 10 2>&1)

# 新: list-status フォールバック
WS=$(cmux identify --surface surface:N 2>/dev/null | jq -r '.caller.workspace_ref')
STATE=$(cmux list-status --workspace "$WS" | grep "^claude_code=\|^c[0-9]*=" | ...)
```

### Phase 3: SKILL.md 更新

**対象:** `skills/cmux-team/SKILL.md`

8 箇所の記述更新:
1. 通信方式テーブル (§0)
2. Master の行動原則 (§1)
3. Conductor へのタスク割り当て (§2.2)
4. Conductor 監視 (§2.3)
5. Agent 起動 (§3.3)
6. Agent 監視 (§3.4)
7. Agent プロトコル (§4)
8. 通信プロトコル (§5)

### Phase 4: CLAUDE.md・docs 更新

関連ドキュメントの `read-screen` 参照を更新:
- `CLAUDE.md` — 既知の注意点、テスト確認ポイント
- `docs/seeds/04-templates.md` — Agent 監視記述
- `.team/specs/requirements.md` — REQ-012
- `README.md` — Communication flow

### Phase 5: read-screen の役割再定義

`read-screen` を「状態判定」から外し、以下に限定:
1. Trust 確認の自動承認（`Yes, I trust` 検出）
2. 画面内容の取得（出力テキスト、エラーメッセージ）
3. Claude 以外のプロセスの確認

## 変更しないもの

- `spawn-conductor.sh` / `spawn-team.sh` の Trust 承認ポーリング — 画面テキスト検出が目的なので `read-screen` 維持
- `.claude/settings.local.json` の `Bash(cmux read-screen:*)` 許可 — 引き続き必要
- Agent のプロンプトテンプレート (`common-header.md` 等) — Agent 自身は状態判定しない
