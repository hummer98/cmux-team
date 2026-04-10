# 実装計画: worktree 作成後に source_up の .envrc を生成する

## 背景

Agent は worktree 内で claude を起動するが、`.envrc` は untracked のため worktree に含まれない。
OAuth トークンなどの環境変数が継承されず、別の契約で動作してしまう問題がある。
`.envrc` をそのままコピーすると `pwd` 解決の問題があるため、`source_up` だけを書いた `.envrc` を生成する。

## 変更箇所

### ファイル: `skills/cmux-team/manager/conductor.ts`

#### 変更1: import に `writeFileSync` を追加

**行番号**: 6行目

**現在のコード**:
```typescript
import { existsSync } from "fs";
```

**変更後**:
```typescript
import { existsSync, writeFileSync } from "fs";
```

#### 変更2: worktree 作成後、npm install の前に .envrc 生成処理を追加

**挿入位置**: 293行目（settings.local.json コピー処理の直後、npm install の前）

**追加するコード**:
```typescript
    // .envrc を生成（source_up で親の .envrc を継承）
    const envrcSrc = join(projectRoot, '.envrc');
    if (existsSync(envrcSrc)) {
      writeFileSync(join(worktreePath, '.envrc'), 'source_up\n');
      await log("envrc_generated", `worktree=${worktreePath}`);
    }
```

## 既存コードへの影響分析

### direnv allow 処理（301-309行目付近）との連携

現在の direnv allow 処理:
```typescript
    if (existsSync(join(worktreePath, ".envrc"))) {
      try {
        await execFile("direnv", ["allow"], { cwd: worktreePath });
        await log("direnv_allowed", `worktree=${worktreePath}`);
      } catch (e: any) {
        await log("error", `direnv allow failed: ...`);
      }
    }
```

- **現状の問題**: `.envrc` は untracked のため worktree に存在せず、`existsSync` が `false` を返す。つまり `direnv allow` が一度も実行されていない。
- **修正後**: `.envrc` 生成処理が先に実行されるため、`existsSync` が `true` を返し、`direnv allow` が正しく実行される。
- **影響**: 既存の direnv allow 処理はそのまま活用される。変更不要。

### その他の影響

- `writeFileSync` は同期 API だが、単一の小さなファイル書き込みのため問題なし
- 親プロジェクトに `.envrc` がない場合はスキップされるため、副作用なし
- `source_up` は direnv の標準機能で、親ディレクトリの `.envrc` を探して読み込む
- worktree は `projectRoot` の子ディレクトリ（`.worktrees/<taskRunId>/`）に作成されるため、`source_up` は確実に親の `.envrc` を見つける

## import の追加

`writeFileSync` を `fs` から追加で import する必要がある（6行目）。
`existsSync` は既に `fs` から import されているため、同じ import 文に追加するだけでよい。

## 処理の流れ（変更後）

1. git worktree 作成（272-279行目）
2. `.claude/settings.local.json` コピー（281-292行目）
3. **`.envrc` 生成（新規追加）** ← ここ
4. npm install（294-299行目）
5. direnv allow（301-309行目）← `.envrc` が存在するため正しく実行される

## テスト方針（手動確認手順）

1. プロジェクトルートに `.envrc` があることを確認
2. `cmux-team start` でチーム起動
3. タスクを作成・実行させる
4. worktree ディレクトリ（`.worktrees/task-xxx-xxx/`）に `.envrc` が作成されていることを確認
5. `.envrc` の内容が `source_up\n` のみであることを確認
6. `manager.log` に `envrc_generated` と `direnv_allowed` の両方のログが記録されていることを確認
7. worktree 内で `direnv exec . env` を実行し、親の `.envrc` の環境変数が継承されていることを確認
