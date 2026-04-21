# T258 リリース v3.54.1

## 変更

- `feat(manager): Mac スリープ復帰を検出する wake_detected ログを追加`（9e1e15d）
  - `sleepUntilWakeup` の前後経過時間を計測し、`pollInterval` の 3 倍超で `wake_detected gap=<秒>s` を manager.log に出力

## リリース成果

- タグ: v3.54.1（ac269f6）
- npm: `@hummer98/cmux-team@3.54.1`（OIDC Trusted Publishing 経由、GitHub Actions release ジョブ 33s で success）
- plugin: `cmux-team@hummer98-cmux-team` 再インストール済み
- ローカル: `cmux-team --version` → `cmux-team 3.54.1`

## バージョン判定

タスクタイトル「リリース（バージョン自動判定）」のためコミットから自動判定するが、v3.54.0 以降コミットがゼロの状態で未コミット差分が残っていた。ユーザー選択により差分を先に commit してから v3.54.1（patch）としてリリース。
