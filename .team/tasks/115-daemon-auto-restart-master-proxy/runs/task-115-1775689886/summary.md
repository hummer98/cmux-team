# T115 サマリー: daemon_auto_restart 後の Master proxy 見失い修正

## 完了ステータス: GO（検品合格）

## 変更ファイル

- `skills/cmux-team/manager/daemon.ts` — DaemonState に `proxyPortChanged` フラグ追加、startMaster() に proxy 変化時の Master 再起動ロジック追加
- `skills/cmux-team/manager/main.ts` — proxy 起動前に前回ポート読み取り、起動後に変化検出、cmdLaunchMaster() にログ追加

## 変更内容

1. **DaemonState.proxyPortChanged**: boolean フラグ（デフォルト false）
2. **proxy ポート変化検出**: main.ts で `.team/proxy-port` から前回ポートを読み取り、新ポートと比較。変化時に `proxy_port_changed` ログ + フラグセット
3. **Master 自動再起動**: daemon.ts の `startMaster()` で Master alive かつ `proxyPortChanged` が true の場合、旧 Master を close して新 Master を spawn
4. **ログ追加**: `master_spawn_proxy port=<port>` を cmdLaunchMaster() に追加

## マージ

ローカルマージ: commit `197dd51` (Merge branch 'task-115-1775689886/task')
