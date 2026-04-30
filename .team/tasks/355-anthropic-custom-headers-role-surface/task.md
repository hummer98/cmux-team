---
id: 355
title: ANTHROPIC_CUSTOM_HEADERS を改行区切りに修正して role/surface 汚染を止める
priority: high
created_by: surface:123
created_at: 2026-04-26T21:58:52.261Z
---

## タスク
## 背景

`api_usage.role` 列に `master, x-cmux-surface: surface:123` のような汚染値が保存されており、Metrics タブのロール別集計が崩れている。

調査の結果、根本原因は `main.ts` で `ANTHROPIC_CUSTOM_HEADERS` 環境変数を **カンマ + スペース** で区切って指定していること:

```ts
// main.ts:1997 (master)
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: master, x-cmux-surface: ${surface}`,

// main.ts:2154 (conductor)
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: conductor, x-cmux-surface: ${surface}`,
```

Anthropic SDK / Claude Code の公式仕様 (`https://code.claude.com/docs/en/llm-gateway`) では `ANTHROPIC_CUSTOM_HEADERS` は **改行 (`\\n`) 区切り** の `Key: Value` ペアと定義されている。カンマ区切りは仕様外で、SDK は全文を `x-cmux-role` の値として 1 つのヘッダーにしてしまう。

その結果 proxy 側 (`proxy.ts:620-623`) で:

```ts
req.headers.get("x-cmux-role")    // "master, x-cmux-surface: surface:123"  ← 汚染
req.headers.get("x-cmux-surface") // null  ← 別ヘッダーとして届かない
```

となり、DB の `role` 列に汚染値、`surface` 列が NULL となる。

修正は **送信側の指定形式を改行区切りに直す** だけで、proxy 側 / DB スキーマには既に正しい受け入れ口（`role` 列と `surface` 列が分かれて存在）があるので追加の正規化処理は不要。

## やってほしいこと（要件）

### 1. ANTHROPIC_CUSTOM_HEADERS の指定を改行区切りに修正

#### 1-1. master surface (`main.ts:1997` 付近)

```ts
// Before
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: master, x-cmux-surface: ${surface}`,

// After
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: master\nx-cmux-surface: ${surface}`,
```

#### 1-2. conductor surface (`main.ts:2154` 付近)

```ts
// Before
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: conductor, x-cmux-surface: ${surface}`,

// After
ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: conductor\nx-cmux-surface: ${surface}`,
```

#### 1-3. agent surface (`main.ts:2083` 付近)

agent には surface 情報が含まれていない（`x-cmux-role: agent` のみ）が、将来的に同様の連結指定をする場合に備えて、**既存テンプレや他箇所も grep して同種の汚染指定が無いか確認**。あれば修正する。

### 2. 検証

- 修正後 Manager を再起動し、master / conductor / agent から API リクエストを発行
- proxy のリクエストログ (`.team/logs/traces/`) または `sqlite3 .team/traces/traces.db "SELECT DISTINCT role FROM api_usage WHERE timestamp > '<修正後の時刻>'"` で:
  - `role` 列が `master` / `conductor` / `agent` の **3 値のみ** になること
  - `surface` 列に `surface:NNN` 形式の値が入ること（NULL ではない）
- Metrics タブのロール別集計が `master` / `conductor` / `agent` の 3 行で表示されること（T354 の正規化を介さなくても綺麗に出るのが理想だが、過去データが残っているので T354 の正規化 SQL は引き続き必要）

### 3. テスト

- `proxy.test.ts` に以下のケースを追加:
  - `x-cmux-role: master\\nx-cmux-surface: surface:123` で送信したとき、proxy が `req.headers.get("x-cmux-role")` で `"master"` を、`req.headers.get("x-cmux-surface")` で `"surface:123"` を取得できること
  - DB に INSERT される `role` 列が `"master"`、`surface` 列が `"surface:123"` であること
- 既存テスト（`proxy.test.ts:1211 / :1261 / :1310 / :1396 / :1427` などの `"x-cmux-role": "master"` 等）は **明示的に単一値で送信しているので壊れない** はず。念のため `bun test` で全パス確認

## やってほしくないこと

- DB に既に保存されている汚染データの **物理 migration はしない**（過去データは T354 の正規化 SQL で読み流す）
- proxy 側の `x-cmux-role` 取得ロジック (`proxy.ts:620-623`) は **触らない**（既に正しく動作する）
- DB スキーマ変更はしない（`role` 列 / `surface` 列は既存）
- `ANTHROPIC_CUSTOM_HEADERS` 以外の環境変数指定は触らない

## 動作確認

1. ブランチ checkout 後 `cmux-team start` で Manager を起動
2. master / conductor から API リクエストが発生するのを待つ（または手動で trigger）
3. ```bash
   sqlite3 .team/traces/traces.db \\
     \"SELECT DISTINCT role, surface FROM api_usage WHERE timestamp > datetime('now', '-5 minutes')\"
   ```
   - `role` が `master` / `conductor` / `agent` の 3 値のみ、surface が分離されていること
4. Metrics タブのロール別集計（T354 適用後なら正規化込み、T354 未適用でも 3 行で表示されるはず）

## 関連

- 修正対象: `main.ts:1997` (master), `:2083` (agent), `:2154` (conductor) の `ANTHROPIC_CUSTOM_HEADERS` 指定
- 受け入れ側（変更不要、参考）: `proxy.ts:620-623` (`req.headers.get`), `proxy.ts:1055-1056` (insert への role/surface 渡し), `trace-store.ts` の `api_usage` スキーマ
- 仕様根拠: https://code.claude.com/docs/en/llm-gateway （\"Newline-separated Key: Value pairs\"）
- 並列タスク: T354（独立、依存なし）— Metrics タブの集計表示改修。本タスクが先に終われば T354 の正規化は将来データに対しては不要になるが、過去データのために残す
