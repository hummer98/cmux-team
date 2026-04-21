# Inspection Report v2 (Round 2): T286

## Verdict

**GO**

判定理由: Round 1 NOGO の必須項目 F-1 / F-2 がいずれも Resolved。任意項目 F-3 も Resolved。
全体検証 (`bun test` 852 pass / 0 fail、`bunx tsc --noEmit` 既存 3 件のみ・新規 0) と
regression チェック（`applyDiscardOnly` の sequential / reason filter 契約、`cmdStop` 削除維持、
`layout_restore_empty_fallback` ログ event）に副作用なし。Round 2 修正は F セクション以外に
波及していないことを git diff で確認済。

---

## A. Round 2 修正項目の検証

### F-1 CLAUDE.md `cmdStop（保険）` 削除

**Status:** Resolved

**根拠:**

- `grep -n "cmdStop（保険）" CLAUDE.md` → **0 件**
- `grep -n "cmdStop" CLAUDE.md` → **0 件**（`cmdStop` の言及自体が CLAUDE.md から完全に消えた）
- 該当箇所 (L431-436) は以下のように修正されており、文章として自然に繋がっている:

  ```
  stale 判定は `isAlive(pid)` false を優先、alive でも `ps -p <pid> -o command=` 出力に
  `main.ts` / `cmux-team` が含まれなければ PID 再利用とみなして上書き。ps 取得失敗
  （空文字）時は保守的に locked 扱いとする。pidfile は shutdown / onFullQuit /
  restartRequested / onReload の全経路で release され、正常系では
  必ず削除される。pidfile は daemon main.ts プロセスのみを指し、proxy は別ライフ
  サイクル。
  ```

- plan.md §3.1 表（L227）「cmdStop を削除、release 経路の列挙からも除く」指示と完全一致

### F-2 docs/spec/01-skill-cmux-team.md blockquote 位置

**Status:** Resolved

**根拠:**

`docs/spec/01-skill-cmux-team.md` L62-98 周辺の構造を Read で確認:

- L62: `**CLI サブコマンド:**`
- L64-65: テーブルヘッダ (`| コマンド | 説明 |` / `|---------|------|`)
- L66-94: テーブル本体（**空行なし、単一テーブルとして連続**、29 行のサブコマンド）
  - L66 `cmux-team start`
  - L67 `cmux-team status`
  - L68 `cmux-team send TASK_CREATED`
  - …
  - L94 `cmux-team list-agent-instructions`（最終行）
- L95: 空行（テーブル終端）
- L96: blockquote `> cmux-team stop は v4.3.0 で廃止（T286）。…`
- L97: 空行
- L98: 次見出し `### 1a. プロジェクト固有の追加指示（…）`

CommonMark 仕様の「空行でテーブル終端」を満たし、blockquote はテーブル末尾の後 + 次見出しの
前に正しく配置されている。テーブルの列数 (2 列)・記述内容は変更されていない。markdown
レンダリング破損なし。

### F-3 i18n.ts 空行整形

**Status:** Resolved

**根拠:**

en side (L169-184 / `help_status` → `help_spawn_conductor` の間):

```
181 `,
182 
183   help_spawn_conductor: `
```

ja side (L833-848 / 同パターン):

```
845 `,
846 
847   help_spawn_conductor: `
```

両方とも閉じバッククォートの後に空行 1 行のみ。他の help エントリ間隔（同ファイル内の他箇所）と
整合する整形になっている。Round 1 の指摘 Minor #11 が解消されている。

---

## B. 全体検証

```
$ bun test --timeout 600000
852 pass
0 fail
2057 expect() calls
Ran 852 tests across 28 files. [42.97s]
```

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3956,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1597,22): error TS2352: Conversion of type 'string | undefined' to type '{ type: "SESSION_STARTED"; ... }' may be a mistake ...
```

- 新規エラー: **0 件**
- 既存エラー: **3 件**（plan.md §6.2 許容範囲と完全一致。Round 1 と同じ箇所・同じ内容）

---

## C. Regression チェック

- **applyDiscardOnly の sequential 実行 / reason filter 契約**: ✅
  - `daemon.ts` 抜粋 (L1124-1145): cleanup ループ・discarded ループとも `for (const ... of ...) { await ... }` の sequential
  - reason filter は `if (d.reason === "surface_missing_no_task")` のみ（Decision D12）
  - JSDoc L1101-1122 に Decision D2/D12/D13/D16 への参照が明示されたまま維持
- **`cmdStop` 削除維持**: ✅
  - `main.ts` の冒頭 usage コメント（旧 L11）から `./main.ts stop` 行が削除済
  - `cmdStop` 関数定義（旧 L2160 付近）が完全削除済
  - switch 文 (L4340-4342) の `case "stop":` 分岐が削除済
  - 復活なし
- **`layout_restore_empty_fallback` ログ event**: ✅
  - `daemon.ts` L1213-1216 で `await log("layout_restore_empty_fallback", \`kept=0 discarded=${plan.discarded.length} layout=${state.layout}\`)` が維持
  - fallback 分岐そのもの (L1208-1227) も維持

---

## D. 補足コメント (GO の場合)

- F-1/F-2/F-3 はいずれもテキスト編集のみで、コード本体・テストロジックには触れていないことを
  git diff で確認済。Round 1 の A/B/C/E (コード正当性 + テスト充足性 + ビルド/型検査 +
  Decision Log 整合性) は Round 2 で副作用を受けていない。
- `cmdStop` の言及は CLAUDE.md から完全に消えたため、grep ベースの将来 audit でも
  「v4.3.0 以降は使わない」が明確になる。
- F-3 は本来 Round 2 の必須スコープ外だったが、同 round で対応されたため Minor #11
  クローズで artifact 残債なし。
- T286 後続候補（Minor #12 / D5 の `initializeLayout` state-machine 化）は Round 1
  の補足通り、必要に応じて別タスク (artifact type=decision で起票) として切り出すことを推奨。
  本 round では追加調査不要。
