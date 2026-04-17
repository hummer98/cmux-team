---
id: 192
title: ロガー改善: surface表記簡略化 + バージョン記録
priority: medium
created_at: 2026-04-14T09:47:33.949Z
---

## タスク
## 背景

manager.log の冗長性と、daemon の世代不一致による不具合（pre-T181 daemon が hookless agent settings を生成し SESSION_IDLE が飛ばない問題）の経験から、ログフォーマットを以下の方針で改修する。

## 設計方針

ID 系は型がプレフィックスでわかる前提で `key=` を省略する。`key=value` は本当のメタデータだけに残す。

| 種別 | 表記 | 例 |
|------|------|-----|
| version | `vX.Y.Z` | `v3.45.0` |
| surface（役割付き） | `C[NNN]` / `A[NNN]` / `M[NNN]` / `U[NNN]` | `C[665]` |
| 親子関係 | `親>子` | `C[665]>A[719]` |
| task | `Txxx` | `T189` |
| artifact | `Axxx` | `A001` |
| その他メタ | `key=value` 維持 | `role=inspector exit=0 pid=27135 session_id=...` |

役割プレフィックス: `C`=Conductor, `A`=Agent, `M`=Manager (daemon), `U`=User session (Master)

## 改修内容

### 1. logger.ts ヘルパー追加
- `formatSurface(surface: string, role: "C"|"A"|"M"|"U"): string` — `surface:665` → `C[665]`
- `formatPair(parent, child)` — `C[665]>A[719]`
- ID プレフィックス系の値は detail から `key=` を剥がす

### 2. daemon_started イベントに version を追加
- `package.json` から version を読み取り `v3.45.0` 形式で記録
- sha は **入れない**（公式リリースなら version で特定可能、dev ビルドは dirty 判定が煩雑）
- 例: `[14:02:52] daemon_started v3.45.0 pid=27135`

### 3. 全 call-site の置換
- `conductor_surface=surface:665 surface=surface:719` 形式を全廃
- 単独 surface イベント: `[14:02:57] conductor_registered C[665] T189`
- 親子関係イベント: `[17:16:55] agent_done C[665]>A[719] T189 role=inspector exit=0`
- 対象: `daemon.ts`, `conductor.ts`, `master.ts`, `main.ts` の `log(...)` 呼び出し全般

### 4. TUI dashboard の色付け（ロール別）
- `parseLogLine` でプレフィックス（C/A/M/U）を検出して色を付ける
- 配色案: C=シアン, A=黄, M=マゼンタ, U=緑
- `.team/logs/manager.log` 自体は色なし（ANSI を入れない）— TUI 側のみで装飾

### 5. テンプレ・ドキュメント更新
- `CLAUDE.md` の「ロギングポリシー」に新フォーマット例を反映
- 既存ログ例があれば差し替え

## 完了基準

- [ ] 新フォーマットで daemon を再起動して `manager.log` の見た目が改善されている
- [ ] `cmux-team status --log 20` の出力が読みやすい
- [ ] TUI dashboard の Log タブで Conductor/Agent が色で識別できる
- [ ] `grep "C\[665\]"` 等で surface 別フィルタが効く
- [ ] `daemon_started` 行に version が含まれる

## 非ゴール

- ログレベル（info/warn/error）の構造化
- JSON ログへの移行
- ログローテーション

## 関連

- 過去ログとの互換: 既存 `.team/logs/manager.log` は古いフォーマットのまま残る（パーサーは旧形式も読めるよう寛容に）
