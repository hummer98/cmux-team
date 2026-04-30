# T319 Conflict Resolution Report

## taskRunId
task-319-1777097734

## branch
task-319-1777097734/task

## rebase target
main (HEAD: cc2d124)

## pre-rebase HEAD (worktree branch)
64f1920 feat: cmux-team token add|list|remove|rotate|set-plan CLI (T319)

## failure_mode
**spec_divergence**

## 状況

main 側で **同じ T319 が別 Agent (Sonnet 4.6) によって既に実装済み・commit 済み**。さらに T319 を前提とする T320 / T321 も main に commit されており、私の T319 を採用しようとすると T320 / T321 の cascade 修正が必要になる。

### 私の作業（worktree 64f1920）

| 項目 | 内容 |
|------|------|
| token-cli.ts | 871 行（補償トランザクション、handle sanitize、organization_id 必須、`__setKeychainTestFailureMode` 等） |
| token-cli.test.ts | 1101 行 / 56 テスト pass |
| token-store.ts | `deleteToken` / `updateTokenAuth` / `updateTokenPlan` を追加（45 行） |
| token-store.test.ts | 11 テスト追加 |
| auth_hash 形式 | **full 64 文字 hex** を保存、表示時のみ先頭 12 文字 |
| organization_id 取得 | `~/.claude/.credentials.json` の `organizationId` フィールド |
| 開発工程 | Plan → Design Review (Changes Requested → Approved) → TDD Impl → Inspection (GO) |
| リグレッション | 1360 pass / 1 skip / 0 fail / tsc 新規エラー 0 |

### main 側の既存実装

| commit | 内容 |
|--------|------|
| 39510e4 (T319) | token-cli.ts 450 行、main.ts 22 行。auth_hash は **12 文字 prefix のみ** 保存。organization_id は **/v1/models probe** で取得。**テストファイル無し** |
| f8a45dd (T320) | proxy auto-discover。`computeProxyAuthHash` で 12 文字 prefix を作り、`getTokenByAuthHash` で lookup |
| cc2d124 (T321) | `selectToken` / `releaseLeaseByHolder` を token-store に追加。`./token-cli` から `cmdTokenRotate` 等を import |

### 衝突詳細

```
$ git rebase main
Auto-merging skills/cmux-team/manager/main.ts            ← 自動マージ可
Auto-merging skills/cmux-team/manager/token-store.ts     ← 自動マージ可（追加 API が直交）
CONFLICT (add/add): Merge conflict in skills/cmux-team/manager/token-cli.ts
```

token-cli.ts は **両側で完全に別実装** (add/add conflict)。

## 衝突の本質的な non-mergeability

semantic resolution での自解決が成立しない理由:

### 1. auth_hash フォーマットの構造的非互換

| | 私 | main |
|---|----|------|
| 保存値 | sha256("Bearer "+token) **64 hex** | 同じ計算の **先頭 12 文字 prefix** |
| 表示 | 先頭 12 文字 | そのまま |
| T320 (proxy) lookup | `getTokenByAuthHash(64hex)` を期待 | `getTokenByAuthHash(12char)` を実装済み |

→ 私の hash 形式に合わせると T320 の proxy 側 hash 比較も書き直す必要がある（cascade）。
→ 規範の出典:
   - **A019 §DB スキーマ**: 「`auth_hash`: 現行 access token の sha256 **12 文字 prefix**」 ← main 準拠
   - **A020 §後続実装提言**: 「**full 64 hex** 保存、表示は 12 文字」 ← 私の準拠

両方の規範 artifact が存在し、どちらを取るかは **ユーザー判断**。

### 2. token-cli の API 形状非互換

| | 私 | main |
|---|----|------|
| エクスポート | `cmdToken(args)` ディスパッチャ + `cmdTokenAdd(args)` 等 | `cmdTokenAdd()` 等の no-args |
| main.ts 配線 | `case "token": await cmdToken(args)` 1 箇所 | 5 case 個別配線（22 行） |
| T321 import | 互換性無し（args 必須化） | `cmdTokenRotate, cmdTokenSetPlan` をそのまま import |

→ 私の API 形状を採ると T321 の `main.ts` 側 wiring と T320 / T321 すべてを書き直す必要。

### 3. organization_id 取得経路の違い

- **私**: credentials.json の `organizationId` フィールドを読む（offline、ファイル形式依存）
- **main**: `/v1/models` を probe してレスポンスヘッダ `anthropic-organization-id` を読む（online、ネットワーク依存）

A019 §データフローは「`~/.claude/.credentials.json` から rateLimitTier 取得」を明示しているが organization_id の取得経路は明記なし。A020 §設計検証は `/v1/models` probe を「正攻法」として記載。これも規範解釈の分岐。

### 4. 工程・品質の非対称

- **私**: Plan → Review → TDD Impl → Inspection の 4 フェーズを完了。テスト 56 ケース + 既存 11 ケース追加 + 全リグレッション緑 + 補償トランザクション・Keychain failure mode・stderr token mask まで網羅
- **main**: 単一 commit (Sonnet 4.6 単独)。テストファイル無し。Keychain 失敗時の DB 巻き戻しが補償トランザクションになっているか未検証

## なぜ私が semantic resolution を試みなかったか

- conductor-role Step 8-3 の semantic resolution 制約は「**conflict marker が出たファイルに限定**」「scope_violation を許容しない」。
- conflict marker は `token-cli.ts` 1 ファイルだが、本質的な互換性は **T320 / T321 の auth_hash 形式と API import** に依存しており、token-cli.ts 内の修正だけでは不整合解消できない（scope_violation 不可避）。
- Step 8-3 の iteration を超えた **structural decision** が必要（auth_hash format の確定、API shape の選択）→ Step 8-6 spec_divergence の典型例と判断。

## 推奨される選択肢（人間判断用）

### Option A: main 側を採用（私の作業を破棄）
- **手順**: worktree branch を破棄 (`git worktree remove --force`、`git branch -D`)。task-319 を `delete-task` または `close-task --deliverable-kind none` で閉じる
- **得るもの**: T319/T320/T321 のチェーンが既に整合的に動作する（main は緑のはず、要確認）
- **失うもの**: 私の補償トランザクション・56 テスト・token-store 拡張 3 関数・stderr token mask 等の防御的実装

### Option B: 私側を採用（main の T319/T320/T321 を巻き戻して再実装）
- **手順**:
  1. 私の commit (64f1920) を採用
  2. main から T319/T320/T321 (39510e4 / f8a45dd / cc2d124) を `git revert` で巻き戻し
  3. T320 / T321 を私の T319 API（`cmdToken(args)` 形状、auth_hash full 64 hex）に合わせて新規実装
- **規模**: 大（少なくとも 3 タスク相当）。並行作業の戻し損なので Master 判断必須
- **得るもの**: 統一された設計（補償トランザクション・テスト網羅・full hex auth_hash）

### Option C: 折衷（私の token-store 拡張のみ採用）
- **手順**:
  1. main の T319/T320/T321 はそのまま残す
  2. 私の `deleteToken` / `updateTokenAuth` / `updateTokenPlan` (token-store.ts) と関連 11 テストのみ別 commit として cherry-pick
  3. main の token-cli.ts も `cmdTokenRemove` 内で `deleteToken` を使うよう小修正（オプショナル）
  4. 私の token-cli.ts と token-cli.test.ts はアーカイブして破棄
- **規模**: 中（45 行 + 11 テストのチェリーピック + main 側 token-cli の `tokens` テーブル + 関連テーブルへの整合的 DELETE 修正）
- **得るもの**: token-store の API 完全性（CRUD の D 系列が揃う）+ remove の参照整合性

### Option D: 完全マージ（auth_hash 64 hex に統一して T320 修正）
- **手順**:
  1. 私の token-cli.ts を採用、main の token-cli.ts を捨てる
  2. main の T320 (proxy.ts の `computeProxyAuthHash` と `getTokenByAuthHash`) を 64 hex 比較に修正
  3. main の T321 (main.ts の token-cli import) を `cmdToken(args)` 形状に合わせて wiring 書き直し
  4. テスト全実行で確認
- **規模**: 中（T320/T321 の cascade 修正は局所的だが、auth_hash 12 char vs 64 hex の DB 互換性で migration の検討が必要）
- **得るもの**: 私の高品質実装 + main の T320/T321 の機能を両方保持

## 私の推奨

**Option C** を推奨。理由:
1. main の T319/T320/T321 が既に動作している前提（要確認）なら、それを温存するのが既存ユーザー影響最小
2. 私の **token-store の D 系列拡張**は「remove で参照整合性を保つために必須」であり、実装の正当性が高い（main の token-cli.ts も DELETE 時に `usage_snapshots` / `leases` を残す orphan を生む可能性がある）
3. 56 テストすべてを破棄するより、**11 テスト + 3 関数を救う**ほうが投資対効果が良い

ただし Option A（私の作業を完全破棄）が最速で最も risk が低い。Master 判断に委ねる。

## required_input

以下のいずれを採用するか:

- [ ] Option A: 私の作業を完全破棄（main を維持）
- [ ] Option B: 私の T319 で main の T319/T320/T321 を巻き戻して再構築（大規模）
- [ ] Option C: 私の token-store 拡張 (3 関数 + 11 テスト) のみ cherry-pick、CLI は main 維持（推奨）
- [ ] Option D: 私の T319 を採用 + auth_hash 形式統一のため main の T320/T321 を修正

その他、規範解釈について:
- auth_hash は **12 char prefix** (A019 §DB スキーマ) か **full 64 hex** (A020 §後続提言) か（決定後、規範文書も追記して矛盾を解消すべき）
- organization_id 取得は **credentials.json field** か **/v1/models probe** か

## 現在の状態

- worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-319-1777097734` （**保持**、削除せず）
- branch: `task-319-1777097734/task` HEAD = `64f1920` （rebase 中断済み、pre-rebase 状態に復元済み）
- task-state: `assigned`（私が close-task を呼ばないため）→ daemon 側で `aborted` に遷移する想定

人間が Option を選んだ後の継続オペレーション:
- Option A → `cmux-team delete-task --task-id 319` で worktree / branch 含めて削除
- Option B/C/D → 別タスクとして起票し、judgment を踏まえた手順を新規 Conductor に渡す。本タスクは `aborted` のまま放置 or `close-task --deliverable-kind none --journal "spec_divergence; main で並行実装あり、別タスクで cherry-pick"`
