# 実装計画書: T122 Agent起動時の環境変数をシェルに焼き付け + direnv allow 自動化

## 概要

現在 `export A=x && export B=y && claude ...` のワンライナーで環境変数を渡している箇所を、
「export をシェルに焼き付け → sleep → コマンド送信」の2段階に分離する。
また、worktree 作成後に `.envrc` が存在する場合、`direnv allow` を自動実行する。

---

## 1. 変更対象ファイルと関数の一覧

| ファイル | 関数 | 変更内容 |
|---------|------|---------|
| `conductor.ts` | `launchConductorOnSurface()` (L170-174) | export と `cmux-team conductor` を分離 |
| `conductor.ts` | `spawnSingleConductor()` (L96-100) | export と `cmux-team conductor` を分離 |
| `conductor.ts` | `spawnConductor()` (L528-532) | export と `cmux-team conductor` を分離 |
| `conductor.ts` | `assignTask()` (L297-302) | worktree ブートストラップ後に `direnv allow` 追加 |
| `main.ts` | `cmdSpawnAgent()` (L947-969) | export を先行送信、claude コマンドを別送信 |
| `main.ts` | `cmdAbortTask()` (L1363-1364) | export と `cmux-team conductor` を分離 |

### 変更不要

| ファイル | 関数 | 理由 |
|---------|------|------|
| `main.ts` | `cmdConductor()` (L685-831) | `execFileSync` + `process.env` でローカルプロセスに渡すため、ワンライナー不要 |
| `main.ts` | `cmdLaunchMaster()` | 同様に `execFileSync` 使用 |

---

## 2. 各関数の具体的な変更内容

### 2.1 conductor.ts — `launchConductorOnSurface()` (L170-174)

**Before:**
```typescript
  // Claude 起動
  await cmux.send(
    surface,
    `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`
  );
```

**After:**
```typescript
  // 環境変数をシェルに焼き付け
  await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
  await sleep(500);
  // Claude 起動
  await cmux.send(surface, `cmux-team conductor ${surface}\n`);
```

### 2.2 conductor.ts — `spawnSingleConductor()` (L96-100)

**Before:**
```typescript
  // Claude 起動
  await cmux.send(
    surface,
    `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`
  );
```

**After:**
```typescript
  // 環境変数をシェルに焼き付け
  await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
  await sleep(500);
  // Claude 起動
  await cmux.send(surface, `cmux-team conductor ${surface}\n`);
```

### 2.3 conductor.ts — `spawnConductor()` (L528-532)

**Before:**
```typescript
    // cmux-team conductor ラッパー経由で起動（proxy ポートを動的解決）
    await cmux.send(
      surface,
      `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`
    );
```

**After:**
```typescript
    // 環境変数をシェルに焼き付け
    await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
    await sleep(500);
    // cmux-team conductor ラッパー経由で起動（proxy ポートを動的解決）
    await cmux.send(surface, `cmux-team conductor ${surface}\n`);
```

### 2.4 conductor.ts — `assignTask()` (L297-302): direnv allow 追加

**Before:**
```typescript
    // worktree ブートストラップ
    if (existsSync(join(worktreePath, "package.json"))) {
      await execFile("npm", ["install"], { cwd: worktreePath }).catch(async (e: any) => {
        await log("error", `npm install failed in worktree: path=${worktreePath} ${e.message}`);
      });
    }

    // --- 3. Conductor プロンプト生成 ---
```

**After:**
```typescript
    // worktree ブートストラップ
    if (existsSync(join(worktreePath, "package.json"))) {
      await execFile("npm", ["install"], { cwd: worktreePath }).catch(async (e: any) => {
        await log("error", `npm install failed in worktree: path=${worktreePath} ${e.message}`);
      });
    }

    // direnv allow（.envrc が存在する場合のみ）
    if (existsSync(join(worktreePath, ".envrc"))) {
      try {
        await execFile("direnv", ["allow"], { cwd: worktreePath });
        await log("direnv_allowed", `worktree=${worktreePath}`);
      } catch (e: any) {
        await log("error", `direnv allow failed: worktree=${worktreePath} ${e.message}`);
      }
    }

    // --- 3. Conductor プロンプト生成 ---
```

**補足:** `direnv allow` は Manager プロセス側で `execFile` で実行する（cmux.send でシェルに送る必要はない）。
worktree は git checkout したファイルなので `.envrc` は元リポジトリに含まれていれば自動的に存在する。
Conductor/Agent が worktree に `cd` した時点で direnv が自動で環境変数をロードする。

### 2.5 main.ts — `cmdSpawnAgent()` (L947-969)

**Before:**
```typescript
  // 環境変数を export（Conductor のシェルセッションに永続化し子プロセスに自動継承）
  const exports: string[] = [
    `export ROLE=${role}`,
    `export PROJECT_ROOT=${PROJECT_ROOT}`,
    `export CMUX_SURFACE=${surface}`,
    `export CMUX_NO_RENAME_TAB=1`,
  ];
  if (proxyPort) {
    exports.push(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`);
  }

  const cdPrefix = worktreePath ? `cd ${worktreePath} && ` : "";
  const modelFlag = `--model ${model}`;

  let claudeCmd: string;
  if (promptFile) {
    // --bare は OAuth 認証（Claude Max）をスキップするため使用しない
    claudeCmd = `${cdPrefix}${exports.join(" && ")} && claude --dangerously-skip-permissions ${modelFlag} '${promptFile} を読んで指示に従ってください。'`;
  } else {
    // 後方互換: --prompt でインライン渡し
    claudeCmd = `${cdPrefix}${exports.join(" && ")} && claude --dangerously-skip-permissions ${modelFlag} '${prompt}'`;
  }
  await cmux.send(surface, claudeCmd + "\n");
```

**After:**
```typescript
  // 環境変数をシェルに焼き付け
  const exportVars = [
    `ROLE=${role}`,
    `PROJECT_ROOT=${PROJECT_ROOT}`,
    `CMUX_SURFACE=${surface}`,
    `CMUX_NO_RENAME_TAB=1`,
  ];
  if (proxyPort) {
    exportVars.push(`ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`);
  }
  await cmux.send(surface, `export ${exportVars.join(" ")}\n`);
  await sleep(500);

  // worktree ディレクトリに移動
  if (worktreePath) {
    await cmux.send(surface, `cd ${worktreePath}\n`);
    await sleep(500);
  }

  // Claude Code 起動
  const modelFlag = `--model ${model}`;
  let claudeCmd: string;
  if (promptFile) {
    claudeCmd = `claude --dangerously-skip-permissions ${modelFlag} '${promptFile} を読んで指示に従ってください。'`;
  } else {
    claudeCmd = `claude --dangerously-skip-permissions ${modelFlag} '${prompt}'`;
  }
  await cmux.send(surface, claudeCmd + "\n");
```

### 2.6 main.ts — `cmdAbortTask()` (L1363-1364)

**Before:**
```typescript
  // 8. Conductor を再起動（新しいセッション）
  const slotId = conductor.surface.replace("surface:", "");
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} && cmux-team conductor ${slotId}\n`);
```

**After:**
```typescript
  // 8. Conductor を再起動（新しいセッション）
  const slotId = conductor.surface.replace("surface:", "");
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface}\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor ${slotId}\n`);
```

---

## 3. direnv allow の追加箇所と条件

### 追加箇所

`conductor.ts` の `assignTask()` — worktree ブートストラップ（npm install）の直後、Conductor プロンプト生成の直前（L302付近）。

### 条件

- `existsSync(join(worktreePath, ".envrc"))` が `true` の場合のみ実行
- `.envrc` がなければスキップ（ログも出さない — 大半の場合は存在しないため、ノイズになる）

### 実行方法

- `execFile("direnv", ["allow"], { cwd: worktreePath })` で Manager プロセスから直接実行
- cmux.send でシェルに送る方式は不要（Manager プロセスが worktree パスを知っているため）
- `direnv` コマンドが PATH になくても `.envrc` がなければそもそもスキップされるので問題ない
- `direnv` コマンドが PATH にあるが `.envrc` がない場合もスキップされるので問題ない
- `direnv` コマンドが PATH になく `.envrc` がある場合は catch でログを出して続行

---

## 4. sleep の利用可否

- `conductor.ts` L17-19 に `sleep()` が既に定義済み → 追加不要
- `main.ts` L1490 に `sleep()` が既に定義済み → 追加不要

---

## 5. テスト観点

### 環境変数焼き付け

1. **Conductor 起動**: `cmux-team start` で Conductor が起動し、`CMUX_SURFACE` がシェルに設定されること
   - 確認方法: Conductor ペインで `echo $CMUX_SURFACE` して値が出ること
2. **Agent 起動**: `cmux-team spawn-agent` で Agent が起動し、`ROLE`, `PROJECT_ROOT`, `CMUX_SURFACE`, `CMUX_NO_RENAME_TAB`, `ANTHROPIC_BASE_URL` がシェルに設定されること
3. **abort-task 後のConductor再起動**: `cmux-team abort-task` 後に Conductor が正常に再起動すること
4. **spawnConductor フォールバック**: 新規 Conductor spawn 時に環境変数が正しく設定されること

### direnv allow

5. **`.envrc` あり**: worktree 元リポジトリに `.envrc` がある場合、`direnv allow` が実行されること
   - ログに `direnv_allowed` が記録されること
6. **`.envrc` なし**: `.envrc` がない場合、エラーなくスキップされること
7. **direnv 未インストール**: `direnv` コマンドがない場合、エラーログが出るが処理は続行すること
8. **環境変数の継承**: Agent が worktree 内で起動した際、direnv の環境変数が正しくロードされること

### リグレッション

9. **ワンライナー残存チェック**: `export.*&&.*cmux-team conductor` や `export.*&&.*claude` のパターンが残っていないことを grep で確認
10. **全体 E2E**: `cmux-team start` → タスク作成 → Conductor 割当 → Agent 起動 → 完了 のフルフローが動作すること
