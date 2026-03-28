---
id: 038
title: TUI の Conductors/Tasks セクションで1行目が表示されない問題の調査・修正
priority: medium
status: ready
created: 2026-03-29
depends_on: [037]
---

## 概要

TUI ダッシュボードの Conductors セクションと Tasks セクションで、各セクションの1行目が表示されない問題を調査・修正する。

## 現象

- Conductors: ヘッダ「─ Conductors 2/3 ─」直後の1エントリが表示されない
- Tasks: ヘッダ「─ Tasks ─」直後の1エントリ（034）が表示されない
- 2行目以降は正常に表示される

## 調査方針

1. `GET /state` API（037 で追加）で内部状態を確認し、データに問題があるか描画に問題があるかを切り分ける
2. データ側: taskList に 034 が含まれているか、conductors Map の内容は正しいか
3. 描画側: ink の Box/Text レイアウト、ターミナル高さ、overflow の影響

## 影響範囲
- skills/cmux-team/manager/dashboard.tsx

## Journal

- summary: ConductorsSection/TasksSection の Box flexDirection=column ラッパーを React Fragment に変更し、fixedLines 計算のオフバイワンも修正
- files_changed: 1
