---
id: A001
type: research
title: "using-cmux の SessionStart hook によるタブタイトル上書き問題"
created: 2026-04-03T00:30:00Z
author: master
tags: [cmux, using-cmux, tab-title, conductor]
---

## 背景

cmux-team は Conductor 起動時に `cmux rename-tab` で `[N] ♦ idle` のようなタブタイトルを設定する。
auto-restart 時に既存 Conductor を発見するため、当初はこの ♦ タブ名を `cmux tree` から検索する方式を採用した。

しかし、♦ が消えて `[N] Claude Code` になってしまい、Conductor を発見できない問題が発生した。

## 調査結果

### 原因

using-cmux プラグインの `SessionStart` hook が原因。

```json
// using-cmux/.claude-plugin/plugin.json
"command": "if [ -n \"$CMUX_SURFACE_ID\" ]; then REF=$(cmux identify | jq -r '.caller.surface_ref'); NUM=$(echo \"$REF\" | cut -d: -f2); cmux rename-tab --surface \"$REF\" \"[$NUM] Claude Code\"; fi"
```

Claude Code セッション開始時に全タブを `[N] Claude Code` にリネームするため、cmux-team が設定した ♦ タイトルが上書きされる。

### タイミング

1. `initializeConductorSlots` で surface 作成 → `renameTab("[N] ♦ idle")` を実行
2. `cmux-team conductor` コマンドで Claude Code を起動
3. Claude Code の SessionStart で using-cmux の hook が発火 → `[N] Claude Code` に上書き

### cmux 本体の状況

- cmux は内部的に `customTitle` (Optional) を管理しており、`rename-tab` → `setCustomTitle(title)`、`clear-name` → `setCustomTitle(nil)` で操作される
- しかし `cmux tree` API にはカスタムタイトル設定済みかのフラグが**公開されていない**
- manaflow-ai/cmux#1581 で OSC タイトルシーケンスによる上書き防止（タイトルロック）が要望されているが未実装

### 依存関係の問題

- using-cmux 側で `CMUX_SURFACE`（cmux-team 独自の環境変数）を見てスキップする案は、using-cmux → cmux-team の逆依存になるため不適切
- using-cmux は汎用スキルであり、特定のオーケストレーションツールを意識すべきではない

## 結論

### 現時点の回避策

タブタイトルでの Conductor 発見を断念し、`.team/conductors/conductor.surface:NNN` マーカーファイル方式を採用した（v3.13.1）。

### 理想的な解決

1. **cmux 本体**: `rename-tab` で設定したカスタムタイトルを OSC タイトルシーケンスで上書きしない（タイトルロック）機能の追加
2. **cmux API**: `cmux tree` の JSON 出力に `hasCustomTitle` フラグを追加し、外部ツールがカスタムタイトルの有無を判定できるようにする
3. **using-cmux**: カスタムタイトル判定 API が利用可能になったら、既にカスタムタイトルが設定済みのタブは上書きしないように修正
