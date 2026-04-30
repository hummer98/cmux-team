# T301 plan.md 設計レビュー（2 回目）

## Verdict: Approved

## Summary

前回の 3 件の major Findings はすべて plan.md に反映された。`docs/spec/05 L193` と `docs/spec/06 L198` の書き換えがサブタスク 1（作業 3・6）および「3. 変更対象」表に追加され、サブタスク 1 / 6 の grep パターンも `auto[-_]restart|自動再起動|exit[ _]code[ _]?42|exit\(42\)|status === 42` を含む拡張形に差し替えられている。さらに minor Finding 4（`readdir` 残し / `stat` 削除の明示）と補足の `daemon_reload_restart` 0 件確認もサブタスク 3 作業 7・サブタスク 8 完了条件にそれぞれ取り込まれており、実装着手可能な状態。

## Findings（反映確認）

### 1. ✅ docs/spec/05 L193 の書き換え（前回 major Finding 1）

- 「3. 変更対象」表の `docs/spec/05-install-and-infrastructure.md` 行に `L193（daemon の auto-restart 後にポートが変わった場合は Master セッションを自動再接続）を daemon 起動時に proxy を再利用し、前回ポートと異なる場合は Master セッションを自動再接続 に書き換え` が明記
- サブタスク 1 作業 3 に「同 L193 の `daemon の auto-restart 後にポートが変わった場合は Master セッションを自動再接続` を `daemon 起動時に proxy を再利用し、前回ポートと異なる場合は Master セッションを自動再接続` に書き換え（auto-restart 前提を削除。`proxyPortChanged` / `proxy_port_changed` は残るため機能自体は生きる）」が追加
- 前回 Recommendations 修正 1 と完全一致

### 2. ✅ docs/spec/06 L198 の書き換え（前回 major Finding 2）

- 「3. 変更対象」表の `docs/spec/06-implementation-tasks.md` 行に `L198（**daemon auto-restart 後の Master proxy 再接続（T115）** — proxy ポート変化を検出して Master を自動再起動）を **proxy 再利用時の Master 再接続（T115）** — proxy ポート変化を検出して Master を再接続 に書き換え` が明記
- サブタスク 1 作業 6 に同内容が追加され、「Phase 6 Task 6.1 L119 と同じ扱い：実装履歴記述から auto-restart 前提を外す」という理由付けも含む
- 前回 Recommendations 修正 1 と完全一致

### 3. ✅ grep パターンの拡張（前回 major Finding 3）

- サブタスク 1 完了条件の grep が以下に差し替え済み:
  ```
  grep -rnE 'source_changed|daemon_auto_restart|initSourceWatcher|checkSourceChanged|sourceMtimes|auto[-_]restart|自動再起動|exit[ _]code[ _]?42|exit\(42\)|status === 42' docs/ CLAUDE.md README*.md
  ```
- サブタスク 6 作業 2 の grep も同一の拡張パターンに差し替え済み
- サブタスク 6 作業 3 で `grep -rnE 'exit.*42|exit 42|status === 42|exit\(42\)' bin/ skills/cmux-team/manager/ docs/ CLAUDE.md` → 0 件も追加され、コード・docs 両側で二重検証
- 前回盲点だった `auto-restart` / `自動再起動` / `exit code 42` / `exit(42)` / `status === 42` すべてをカバー

### 4. ✅ サブタスク 3 作業 7 の具体化（前回 minor Finding 4）

- 「`readdir` は `daemon.ts:706` の `restoreMasters`（`mastersDir` 読み取り）で使用中のため **残す**」
- 「`stat` は `daemon.ts:411` / `daemon.ts:428`（いずれも `initSourceWatcher` / `checkSourceChanged` 内）でしか使われていないため、今回の関数削除で完全未使用になる → import 文から **削除する**」
- さらに「念のため `grep -nE '\bstat\(' skills/cmux-team/manager/daemon.ts` で 0 件を確認してから import 削除」というガードステップまで追加されており、実装時の迷いが残らない

### 5. ✅ サブタスク 8 への `daemon_reload_restart` 0 件確認追加（前回補足）

- 完了条件の「`manager.log` に以下のログが **1 件も新規発火しない** こと」リストに以下 3 種が揃っている:
  - `source_changed`
  - `daemon_auto_restart`
  - `daemon_reload_restart`（「Decision Log D2 と整合：exit 42 ループ撤去後は発火経路なし」の注釈付き）
- Decision Log D2 と観測レベルで整合が取れる

### 6. (参考) 前回 minor Findings 5 / 6 / 7 の扱い

- Finding 5（`execFileSync` を top-level import に寄せる）: **未反映**。ただし前回レビューでも「どちらでも動作するため受け入れ可能」と明記した軽微な指摘。減点対象としない
- Finding 6（T259 コメント削除の情報喪失確認）: 前回レビューで「問題なし」と明記済み。CLAUDE.md §T259 節は今回の修正対象外で情報は保全される
- Finding 7（D2 再確認）: Decision Log D2 はそのまま維持され、サブタスク 6 の grep で `exit\(42\)` / `status === 42` が検証される構造になっている

## 新規 Finding

今回の再レビューで plan.md を再度精査したが、**Approved を阻害する新規問題は見つからなかった**。以下は任意の nit コメント。

### (a) [nit] サブタスク 8 作業 1 の pid ファイル停止経路

「既存 daemon があれば `cat .team/daemon.pid | xargs kill` で停止」は pidfile が正常に書かれている前提。pidfile が空 / 不整合だった場合は `xargs` が no-op になるため副作用はないが、`cmux-team status` で daemon の生死を先に確認する 1 ステップがあるとより堅牢。Approved の障害ではないため任意反映で可。

### (b) [nit] サブタスク 3 「メソッド制約」の文言

「`stopDaemon(state)` 自体は削除しない」の直下に「`DaemonState` 型宣言の他フィールドの順序は変更しない」と続く。意図は明確だが、「差分を最小化してレビュー負荷を下げるため declaration 順序を保持する」と目的付けがあるとより親切。Approved の障害ではない。

### (c) [nit] Finding 5（execFileSync 一貫性）の取り込み余地

`main.ts` 冒頭の `import { execFile } from "child_process";` に `execFileSync` を追記する方が CJS require 呼び出しより一貫性が高い。ただし plan.md サブタスク 4 作業 4 の置換コードは現行スタイル（`const { execFileSync } = require("child_process");`）に合わせており、そのまま採用しても動作・可読性とも問題なし。任意改善。

## Recommendations

Approved のため必須の修正なし。実装に進んでよい。

任意改善（後追いでも差し支えない）:
- 上記 (a): サブタスク 8 冒頭に `cmux-team status` での現状確認 1 ステップ追加
- 上記 (c) / 前回 Finding 5: `main.ts` L30 付近の既存 `import { execFile } from "child_process";` に `execFileSync` を追記して onReload の require 呼び出しと統一
