---
allowed-tools: Bash, Read
description: "チーム体制を構築する（Master + Manager を spawn）"
---

# /cmux-team:start

cmux-team のチーム体制を構築する。`spawn-team.sh` が全フェーズを一括実行する。

**重要: このコマンドを実行したセッション自身はどの層にもならない。ランチャーの役割のみ。**

## 手順

### 1. スクリプトの存在確認

```bash
# .team/scripts/spawn-team.sh がなければ plugin キャッシュからコピー
if [[ ! -f .team/scripts/spawn-team.sh ]]; then
  mkdir -p .team/scripts
  for candidate in \
    ~/.claude/plugins/cache/hummer98-cmux-team/cmux-team/*/skills/cmux-team/scripts \
    ./skills/cmux-team/scripts \
    ~/.claude/skills/cmux-team/scripts; do
    if [[ -f "${candidate}/spawn-team.sh" ]]; then
      cp -f "${candidate}/"*.sh .team/scripts/
      chmod +x .team/scripts/*.sh
      break
    fi
  done
fi
```

### 2. スクリプト実行

```bash
bash .team/scripts/spawn-team.sh
```

出力は `KEY=VALUE` 形式:
- `STATUS=spawned` — 新規起動完了
- `STATUS=already_running` — 既にチーム稼働中（プロンプトのみ更新済み）
- `MASTER_SURFACE=surface:N` — Master の surface
- `MANAGER_SURFACE=surface:N` — Manager の surface

### 3. 結果報告

**STATUS=spawned の場合:**
```
チーム準備完了。

  [M] Master (surface:M)  |  [G] Manager (surface:G)

Master ペインに切り替えてタスクを伝えてください。
```

**STATUS=already_running の場合:**
```
チーム稼働中。プロンプトを最新に更新しました。
Master (surface:M) に切り替えてタスクを伝えてください。
```

**このセッションの役割はここで終了。** 以降の操作はすべて Master ペインで行う。

## 引数

なし

## 注意事項

- spawn-team.sh がインフラ準備・既存セッション検出・プロンプト生成・ペイン作成・Trust 承認を一括処理
- `.team/` が既に存在する場合はディレクトリ作成をスキップ
- プロンプトは毎回 plugin キャッシュのテンプレートから再生成（plugin 更新の即時反映）
- Conductor や Agent は Manager が必要に応じて spawn する
- このセッション自身は Master にも Manager にもならない
