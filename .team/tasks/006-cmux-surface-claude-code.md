---
id: 006
title: リサーチ: cmux surface 上の Claude Code が実行中かどうかを判定する方法
priority: high
created_at: 2026-03-29T06:10:41.451Z
---

## タスク
## 目的

daemon が Conductor の Claude Code セッションにコマンドを送る前に、そのセッションが idle（❯ プロンプト待ち）か running（処理中）かを確実に判定する方法を調査する。

## 調査項目

### 1. cmux の ⚡ running 表記の仕組み
- cmux はどうやって surface が running かどうかを判定しているか？
- cmux のソースコードを調査（cmux は Rust 製、ソースは ~/.cargo 等にある可能性。または GitHub リポジトリ）
- cmux CLI でこの状態を取得できるコマンドがあるか？（cmux status, cmux info 等）
- cmux tree の出力に running 状態が含まれるか？

### 2. PID の入出力から判定
- Claude Code のプロセス PID を特定する方法
- /proc/<pid>/fd や lsof でプロセスの I/O 状態を確認できるか
- macOS の場合は /proc がないので代替手段（ps, lsof, dtrace 等）
- PTY の activity 検出（pty master fd の read/write 状態）

### 3. Proxy のログから判定
- 現在の cmux-team proxy は API リクエストを中継している
- proxy のログからリクエスト in-flight 状態を取得できるか
- proxy に /status エンドポイントを追加して、アクティブなリクエスト数を返す案

### 4. cmux read-screen から判定
- 現在の方法: cmux read-screen で ❯ と esc to interrupt のパターンマッチ
- 精度の問題点（sleep 中、thinking 中、tool 実行中の各パターン）
- 改善可能か

### 5. その他の方法をネット調査
- Claude Code の status API や internal state の取得方法
- ターミナルマルチプレクサ（tmux, zellij 等）での類似問題と解決策
- LSP や Language Server の idle 検出手法からの応用
- Claude Code の hooks（PostToolUse 等）を活用した能動的通知

## 成果物

.team/output/ に調査結果レポートを出力:
- 各方法の実現可能性・精度・実装コストの比較表
- 推奨アプローチの提案
- 概念実証コード（可能であれば）

## 注意
- これはリサーチタスク。コードの変更は不要
- cmux のソースコードが見つからない場合は cmux --help や cmux のサブコマンド一覧から機能を推測
- ネット調査には WebSearch を活用
