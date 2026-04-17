# 検品結果 — T170

## 判定

**GO**

## 記録上の注意

Inspector Agent を spawn したが、書き出し直前に 2 回連続で API Error（socket closed）で切断された。2 回の実行ログ上で以下がすべて GO 判定されていたため、Conductor が最終確認して本レポートを作成した（Agent の検品プロセス自体は完走）。

## チェックリスト（必須観点）

### 1. 差分の妥当性 ✅

- [✅] `switchTab(tab)` ヘルパー関数が定義されている（dashboard.tsx:1067-1077）
  - `app.view(buildViewWithApp);` の直後、`app.keys({...})` より前に配置（クロージャで `app` を参照可能）
  - `FOCUSED_AREA_FOR_TAB` マップで tab → focusedArea を辞書化
  - `app.update` で `activeTab` と `focusedArea` を一括更新
- [✅] タブボタン onPress が `switchTab` に統一（dashboard.tsx:969/976/983）
- [✅] 数字キー `"1"` / `"2"` / `"3"` が `switchTab` 呼び出し（dashboard.tsx:1125-1127）— **バグ修正確認**（以前は activeTab のみ更新）
- [✅] `Tab` キーが `switchTab` 呼び出し（dashboard.tsx:1128-1132）— **バグ修正確認**
  - `(ctx) => ...` ハンドラで `ctx.state.activeTab` から現在値を参照（既存の Enter ハンドラと同じパターン）
- [✅] `J` / `A` / `L` キーが `switchTab` 呼び出し（dashboard.tsx:1135-1137）
- [✅] フッターヒント追加
  - tasks ブランチ: `J` journal / `A` artifacts / `L` log（自分のタブ軸なし・タブ全列挙）
  - journal ブランチ: `A` artifacts / `L` log（自タブ J を省略）
  - log ブランチ: `J` journal / `A` artifacts（自タブ L を省略）
  - artifacts ブランチ: `J` journal / `L` log（自タブ A を省略）
- [✅] Escape ハンドラ変更なし（`focusedArea: "global"` リセットのみ）

### 2. 型チェック ✅

`bunx tsc --noEmit` を `skills/cmux-team/manager` で実行。

**検出されたエラー（4件、すべて既存・本修正と無関係）:**
- `cmux.ts(22,5)` — Bun stdout/stderr 型と TypeScript 期待型の不一致
- `dashboard.tsx(372,5)` — `"unstyled"` variant 未定義（既存）
- `dashboard.tsx(956,11)` — `"unstyled"` variant 未定義（既存）
- `main.ts(394,42)` — null 許容の型不一致（既存）

**新規エラーなし。** switchTab 追加箇所・onPress/キーハンドラ置換・フッター追記では型エラーは発生していない。

### 3. 構文的整合性 ✅

- `switchTab` は `app.view(...)` 後・`app.keys(...)` 前に配置（クロージャ OK）
- Tab キーは `(ctx) => ...` の形式で ctx.state.activeTab を参照。これは Enter ハンドラと同じ既存パターンのため rezi-ui の keys API と整合
- `try/catch` は既存 onPress と同じ慣習
- `FOCUSED_AREA_FOR_TAB` のキーは `TabId` と完全一致

### 4. 計画との一致 ✅

plan.md §2 の変更箇所と実装が一致:
- §2-1 タブボタン onPress: 一致
- §2-2 数字キー: 一致
- §2-3 Tab キー: 一致（ctx.state 参照パターン）
- §2-4 J/A/L: 一致
- §2-5 フッターヒント: 一致（自タブ省略ルール含む）
- §2-6 Escape: 変更なし（plan 通り）

plan からの逸脱なし。

## 発見事項

### ✅ 良かった点

- `FOCUSED_AREA_FOR_TAB` 辞書化により、将来新タブ追加時の変更点が集約されている
- switchTab の配置位置が明確（キーハンドラより前）でクロージャ参照が安全
- フッターヒントの自タブ省略ルールが統一的（冗長さ回避）
- 既存コードへの副作用なし。変更は必要最小限（36 insertions / 13 deletions、1 ファイル完結）

### ⚠️ 警告（GO 可、記録のみ）

- `dashboard.tsx(372,5)` / `(956,11)` の `"unstyled"` variant 未定義エラーは実装前から存在。本タスクの範囲外だが将来の対応候補
- 手動 E2E 確認（plan §3 のチェックリスト）は Conductor/Inspector では実行不可（dashboard の実起動が必要）。ユーザー側で最終確認することを推奨

### ❌ 問題点

なし。

## 手動テスト観点（未実施・参考）

plan.md §3 の 5 カテゴリは dashboard を実起動して人間が確認する項目。本検品では静的解析・計画整合性のみ保証。
