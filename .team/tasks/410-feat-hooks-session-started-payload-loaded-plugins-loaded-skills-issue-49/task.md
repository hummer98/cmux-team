---
id: 410
title: feat(hooks): SESSION_STARTED payload に loaded_plugins / loaded_skills を含める (issue #49)
priority: medium
created_at: 2026-05-01T10:58:17.308Z
---

## タスク
## 背景

cmux-team metrics の cohort 比較 (spec 11.4 CodeDNA 評価判定基準) で「該当 session で plugin X が loaded だったか」を trace DB のみから判定するための基盤。現状 SESSION_STARTED hook_signal payload には loaded plugin / skill 情報が含まれず、ctxd の cmux-team field study (T025〜T029) で plugin install 有無を session 単位で post-hoc 判定できない。

issue #49 (https://github.com/.../issues/49) の提案を反映。

## 取得方法の確認 (実機済)

`claude plugins list --json` が存在し、構造化データ (id / version / scope / enabled / installedAt / installPath) を返すことを確認済。これを SessionStart hook 内で 1 度呼んで payload に含める。

例:
```json
{
  "id": "claude-code-setup@claude-plugins-official",
  "version": "1.0.0",
  "scope": "user",
  "enabled": true,
  "installPath": "/Users/.../cache/.../1.0.0",
  "installedAt": "2026-03-07T13:31:26.568Z"
}
```

## スコープ

### 1. hook script から plugin / skill 情報を収集

- SessionStart hook (matcher: "" / 全 source) で `claude plugins list --json` を実行し、enabled=true の plugin id を抽出して `<id>` 形式の文字列配列にする
- skills は plugin の installPath 配下 `<installPath>/skills/*/` を walk して skill name を抽出
  - user skills (~/.claude/skills/) と project skills (.claude/skills/) も含める (loaded_skills は session で実際に読み込まれた skill 全体を表す)
- 取得失敗 (CLI 実行エラー / parse 失敗) 時は loaded_plugins / loaded_skills を null で送る (consumer は missing 許容)
- hook script に walk ロジックを書くと複雑化するので、cmux-team subcommand を新設する (例: `cmux-team session-enrichment --json` を hook が呼ぶ) のが筋。実装者が判断

### 2. schema.ts の SessionStartedMessage 拡張

```ts
export const SessionStartedMessage = z.object({
  type: z.literal("SESSION_STARTED"),
  // 既存フィールド ...
  loadedPlugins: z.array(z.string()).nullable().optional(),
  loadedSkills: z.array(z.string()).nullable().optional(),
});
```

- snake_case (`loaded_plugins`) で受け、内部表現は camelCase (既存パターンに合わせる)
- 既存 SESSION_STARTED の field は変更しない (後方互換)

### 3. main.ts buildMessageFromHookInput / handleMessage

- buildMessageFromHookInput で `loaded_plugins` / `loaded_skills` を新フィールドに取り出して message に含める
- 既存の SESSION_STARTED ハンドラは変更不要 (insertHookSignal が payload_json に丸ごと格納するので自動で trace DB に入る)

### 4. spec 追記

- docs/spec/11-metrics.md §3.5.1 系列に「session-level plugin/skill marker の acquisition tactic」を追記
- payload 例と JSON_EXTRACT 用の SQL 例を含める
- consumer の missing 許容仕様を明記

### 5. テスト

- hook script 経由の e2e:
  - plugin install 後に SessionStart したら payload.loaded_plugins に該当 plugin id が含まれる
  - plugin uninstall 後の SessionStart で消える
- unit:
  - SessionStartedMessage schema の loadedPlugins null / undefined / array 各パターン
  - buildMessageFromHookInput の field 取り出し
- 取得失敗時 fallback (CLI 実行不可 / parse error → loaded_plugins: null) のテスト

### 6. スコープ外

- consumer 側 (cmux-team metrics compare の cohort filter / dashboard 表示) — 別タスクで議論
- daemon 内キャッシュ最適化 — hot path 性能問題が顕在化したら follow-up
- plugin_install_events 等の正規化テーブル化 — payload 直書きで運用、ストレージ問題が顕在化したら別途

## 受け入れ条件

- SESSION_STARTED hook_signal payload に loaded_plugins (array of string | null) が含まれる
- 同様に loaded_skills (array of string | null) が含まれる
- 取得失敗時は両 field が null になり consumer が破綻しない
- spec §3.5.1 系列に acquisition tactic が文書化されている
- plugin install 後に SessionStart したら payload に該当 plugin が出ることが e2e test で検証されている
- 既存 SESSION_STARTED 処理経路に regression が無い (T203 / T407 関連の resume / pre-inject テストが green)

## 関連

- issue #49: SESSION_STARTED hook_signal payload に loaded plugins / skills を含める
- T407 (b3d4734): session_id pre-inject (SESSION_STARTED の上流変更で本タスクと同一 file 群を触る可能性)
- ctxd T025〜T029 (外部 repo): 本タスクの直接の consumer
- spec 11.4: CodeDNA 評価判定基準
