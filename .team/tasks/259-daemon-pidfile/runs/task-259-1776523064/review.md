# Design Review: T259 pidfile ロック

## 判定

**Approved**

## 良い点

- **現状分析が極めて正確** — 行番号、関数スコープ、shutdown 呼び出し経路、`onFullQuit` が `shutdown()` を呼ばず直接 `process.exit(0)` する点まで実コードと一致している。
- **pidfile acquire の挿入位置の根拠が明確** — preflight 後・direnv/resolveMainBranch の前・`createDaemon` の前、という 3 条件で位置を決めている。特に `resolveMainBranch` が `.team/config.json` を書き換える副作用を持つため、その前に排他を取るという論点を押さえている。
- **shutdown 経路の網羅性が高い** — SIGINT / SIGTERM / SHUTDOWN message / メインループ正常抜け (L739) / onFullQuit / restartRequested / onReload / cmdStop の 7 経路を全てカバーしている。特に `onFullQuit` が `shutdown()` を通らない点、`restartRequested` (L732-737) で exit 42 する前に release する必要がある点を正しく抽出している。
- **auto-restart の pidfile 所有権移転の設計が正しい** — `onReload` の親が `execFileSync` でブロッキングするため、親 PID で書いた pidfile のまま子が acquire しようとすると「生きているプロセスが自分自身」と判定して fail-stop する、という落とし穴を正確に診断し、親が release → 子が acquire の順で所有権を渡す解決策を示している（Section 1.3, 2.2D, 2.3 擬似コード）。
- **stale 判定の優先順位が適切** — `isAlive(pid)` false が最優先、alive でも `ps -p` 出力に "main.ts"/"cmux-team" が含まれなければ pid 再利用とみなす、の 2 段階判定は macOS の pid 再利用への保険として妥当。
- **DI 戦略が一貫している** — `isAliveImpl` / `psCommand` をオプション引数で受けられる設計は、既存の `cmux.ts:__setIsAliveImpl` / `main-branch.test.ts` の `git` DI と整合しており、並列実行でも決定論的なテストを書ける。
- **tmp dir 戦略** — `mkdtemp` は既存テスト慣行と一致し、CI 並列でも衝突しない。
- **リスク評価が現実的** — NFS / Windows / SIGKILL / race を「ローカルディスク前提で割り切る」と明記し、過剰設計を避けている。5.6 の release→exec 間 race についても「仮に刺さっても child が即死するだけで親子とも壊れない」と正しく結論づけている。

## 懸念点 / Recommendations

### 任意改善（nice to have）

1. **`isAlive` の重複 vs re-export の判断を明記** (Section 2.1 L146-147)
   - plan.md は「複製。または cmux.ts から re-export」と選択肢を示したまま。循環依存の懸念は `pidfile.ts` → `cmux.ts` のみの import なら起きないため、**`cmux.ts` の `isAlive` / `__setIsAliveImpl` を再利用**（import して内部で使う）するのが自然。独自に複製すると、将来 `cmux.ts` 側の `isAlive` が修正されたときに追従漏れが発生しうる。実装時に re-export または import 再利用に統一することを推奨。

2. **`cmdStop` の 5 秒待機ループ (Section 2.2E)**
   - 既存の `cmdStop` は `postMessage` して即 return する設計。5 秒のポーリングを入れると、CLI レスポンスが体感で遅くなる。pidfile は daemon 側の shutdown / onFullQuit / SIGTERM 経路で確実に削除される設計になっているので、**この「保険」は省略するか、大幅に短縮 (1s 程度)** してよい。`cmux-team status` が既に pidfile を stale 判定する経路を備えていれば、次回 start 時にどうせ掃除される。
   - もし残すなら「pidfile 残存時にのみ最小限の stale チェック」に留め、正常系で sleep しない構造にする。

3. **Step 9-alt の抽出関数シグネチャを plan.md に書く**
   - 「`runPidfileAcquire(projectRoot, log)` を export して単体テストで spy」とあるが、戻り値・例外・console 出力との責務分担が曖昧。実装時に決めてよいが、plan 段階で「`acquireOrExit(projectRoot, pidFilePath): Promise<void>` で `PidFileLockedError` を捕えたら `console.error` + `process.exit(1)` する薄いラッパー」程度まで具体化しておくと実装ブレが減る。

4. **proxy プロセスとの関係を 1 行明記**
   - `cmux-team start` は proxy を再利用する (`proxy_reused` 経路) ため、同じ `.team/` に対して **daemon は 1 プロセス、proxy プロセスは別ライフサイクル**という関係がある。pidfile はあくまで「daemon main.ts プロセス」のみを指すことを plan.md に 1 行書いておくと、将来 proxy の pidfile と混同されないため親切。

5. **ドキュメント更新は「推奨」ではなく「実施」にする**
   - Section 4.3 は「必須ではない」と書かれているが、CLAUDE.md の「Manager プロトコル（内部実装）」セクションは既に詳細で、pidfile 仕様を書かないとここだけ実装と乖離する。`.team/daemon.pid` の項目を `.team/` ディレクトリ構造表にも追記するのが望ましい。

6. **`main.ts` の `restartRequested` 経路で `updateTeamJson` の後に release する順序 (Section 2.2D)**
   - 既存コードで L735 `await updateTeamJson(state)` → L736 `process.exit(42)` という順。`releasePidFile` は **`updateTeamJson` の後 / `process.exit(42)` の直前**に置くのが plan.md の意図。この順序を実装時に守ること (plan.md の例示はこの順で書かれているが、本文で「必ず state 永続化の後に release」と明記するとよい)。

## 検証結果

現状分析の正確性について実コードと突き合わせた結果:

- **`cmdStart` は `main.ts:251`** — 一致 ✓
- **preflight は L263 (成功判定 L267)** — plan.md は L267-269 の間に挿入と記述、実コードと整合 ✓
- **`createDaemon` は L323** — 一致 ✓
- **`shutdown` 関数は L434-454 (クロージャ)** — `cmdStart` スコープ内のローカル関数であり、plan.md の記述通り ✓
- **`process.on("SIGINT" | "SIGTERM", shutdown)` は L456-457** — 一致 ✓
- **`onReload` は L462-501 / `onFullQuit` は L504-536** — 一致 ✓
- **`onFullQuit` は `shutdown()` を呼ばず L535 で直接 `process.exit(0)`** — 一致 ✓ (そのため pidfile unlink を別途挿入する必要がある plan.md の設計は正しい)
- **`restartRequested` ブロックは L732-737 で `process.exit(42)`** — 一致 ✓
- **`shutdown` 呼び出しはメインループ抜け後の L739** — 一致 ✓
- **SHUTDOWN message handler は `daemon.ts:1813-1818`** — `state.running = false` (= `stopDaemon(state)`) のみで `process.exit` しない実装を確認 ✓
- **`cmdStop` は `main.ts:1846-1853`** — `postMessage({type:"SHUTDOWN"})` → `console.log` のみ、実 shutdown は daemon 側に委ねる実装を確認 ✓
- **`isAlive` は `cmux.ts:224-232`** — `__setIsAliveImpl` で DI 可能な形で実装済み。plan.md の「cmux.ts から re-export」は可能 ✓
- **`onReload` の `execFileSync` がブロッキングで親がシグナルを受け取らない構造** — L480-484 で `stdio:"inherit"` の同期 exec を確認 ✓ (plan.md Section 1.3 の重要観測は正しい)

## 総評

現状分析の精度が高く、shutdown 経路の網羅性・auto-restart との整合性・DI によるテスト容易性が揃っており、このまま Implementer に渡して問題ない。必須修正なし。`cmdStop` の sleep ループだけは実装段階で過剰さを再検討し、その他は任意改善として取り込めば更に磨きがかかる。
