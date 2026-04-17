# Design Review: task-162

## Verdict

**Approved**

## Summary

`.envrc` への `CMUX_CLAUDE_HOOKS_DISABLED=1` 追記を初回起動時に対話的に確認する設計として、plan は「ツール領域は黙って、ユーザー領域は聞く」原則に忠実で、最小の侵襲で目的を達成している。新規モジュール `envrc-prompt.ts` への切り出し、TUI 起動前の同期実行、`CMUX_TEAM_NO_PROMPT` / 非 TTY / 既存設定 / 永続 silence の各 gating、追記成功/失敗時のログ、テスト容易性のためのラッパー（`askYNQuestion`）設計まで、いずれも実装観点で破綻がない。

既存コードベース（`main.ts:cmdStart` の起動順序、`logger.ts` のイベント命名、Zod 未導入の `config.json` 扱い）とも整合しており、後方互換性を壊さない。`Y` 入力時に `.envrc` 追記が失敗した場合だけ `console.error` で 1 行通知するという扱いも UX として妥当。

## Strengths

- **gating の網羅性**: `noop_no_envrc` / `noop_already_set` / `noop_silenced` / `noop_no_tty` / `CMUX_TEAM_NO_PROMPT` を順序立てて整理し、漏れがない。
- **責務分離**: 「副作用を伴う対話」を `preflight.ts`（issue 集約型）と混ぜず別モジュールに切り出した判断が良い。
- **テスト容易性**: `askYNQuestion` を export してテストでモックする設計まで先回りしている。`process.stdin.isTTY` のテスト難しさにも言及あり。
- **失敗時の安全側設計**: `.envrc` 追記/`direnv allow` 失敗で `cmux-team start` 全体は止めない。daemon の本来の役割を阻害しない。
- **Zod 導入をスコープ外と明示**: 既存 `loadConfig()` が JSON.parse + interface キャストで動いているので、最小変更で揃えた判断が良い。
- **ログイベント命名がポリシー準拠**: `*_failed` / `*_started` / 状態変化系の使い分けが CLAUDE.md ロギングポリシーに沿っている。
- **completion 条件が明確**: 8 ケースのテスト + main.ts 組み込み + ログ仕様準拠 + 既存テスト非破壊、と検証可能な形になっている。

## Recommendations（実装段階で考慮、Approved のまま反映可）

以下は plan を blocking する要素ではなく、実装時に軽く反映してもらえれば品質が上がる程度の提案。

- **`action` 値の意味重複の解消**: 現 plan では `CMUX_TEAM_NO_PROMPT=1` も `envrcHookPromptSkipped=true` も `noop_silenced` を返す。ログでは `reason=` で区別されているが、戻り値も `noop_env_silenced` / `noop_user_silenced` と分けるとテスト時の検証が明確になる（任意）。
- **対話プロンプトの文言を plan に明示**: 「仕様文言通り表示」とだけ書かれているが、実装者が文言を再考しなくて済むよう、タスク要件にある正確なプロンプト文字列を plan or 実装に直書きしてほしい。i18n は本タスクのスコープ外で、日本語ハードコードで良い（既存 `t()` の使用要否は実装判断）。
- **`Bun.which("direnv")` の戻り値型**: Bun は string | null。`null` 時に `direnv_not_found` ログ + warnings 追加 → そのまま継続、を実装で確実に行うこと。
- **`.envrc` 末尾改行保証**: 追記前に「現在の本文を読んで末尾が `\n` でなければ `\n` を足してから append」する手順を実装側でテストケースに含めてほしい（テストケース表で「`.envrc` の末尾改行なしのケース」を 1 つ追加すると尚良い）。
- **`direnv allow` 引数**: `execFile("direnv", ["allow", projectRoot])` で OK だが、`cwd: projectRoot` を `execFile` の options に渡しておくと挙動が安定する（direnv は cwd ベースで判断するため）。
- **`config.json` 書き込みの atomicity**: 既存実装が temp + rename を使っていなければ揃えなくて良いが、並行起動で壊さないか軽く確認してほしい（cmux-team は通常単一プロセスなので実害は薄い）。
- **`envrcHookPromptSkipped` を再度 false に戻す UX が非スコープ**: plan の「補足」に明記されている通り。将来の `cmux-team config reset envrc-prompt` まで見越されており妥当。利用者が手動で `.team/config.json` を編集すれば戻せる旨を help/docs に書く必要があれば dockeeper タスクで対応すれば良い。

## 確認した既存実装との整合性

- `main.ts:86` の `interface TeamConfig` への `envrcHookPromptSkipped?: boolean` 追加は後方互換性あり（optional）。
- `main.ts:cmdStart` の `initInfra(state)` (207行目) → `log("infra_ready")` (208行目) → `daemon_started` ログ (209-212行目) → proxy 起動 (220-238行目) → `startDashboard` (274行目) の流れに対し、208 と 209 の間（または 212 と 215 の間）に挿入する案は妥当。Ink TUI が stdin/stdout を奪う前に確実に対話できる。
- proxy 起動より前か後かは plan が「後でよい」としているが、proxy は対話に関与しないため順序依存はない。**proxy 起動前**に置く方が、proxy 起動失敗時にも対話のみは完了する利点があるので僅かに推奨（任意）。
- `logger.ts` のイベント名は規則準拠。
- `daemon.ts` の `initInfra` で生成するデフォルト `config.json` への `envrcHookPromptSkipped: false` 追加は「明示しておくだけ」とあるが、実害なしなのでそのまま追加して良い。
