# 任务分配

## 任务内容

{{TASK_CONTENT}}

## 工作目录

所有工作在 git worktree `{{WORKTREE_PATH}}` 内进行。
```bash
cd {{WORKTREE_PATH}}
```
不得直接修改 main 分支。

分支名: `{{CONDUCTOR_ID}}/task`

## 开始工作前的确认（引导）

worktree 仅包含 tracked files。开始工作前请确认以下事项:
- 如果存在 `package.json`，执行 `npm install`
- 检查 `.gitignore` 中列出的运行时目录（`node_modules/`, `dist/`, `workspace/` 等）是否存在，如有需要则重建
- `.envrc` 和环境变量的设置

## 输出目录

```
{{OUTPUT_DIR}}
```

将结果摘要写入 `{{OUTPUT_DIR}}/summary.md`。

## 合并目标分支

此任务的成果应合并到 `{{BASE_BRANCH}}`。
交付方式（本地合并或 PR）请参照 conductor-role.md 中的完成处理说明。

## 完成通知

所有处理完成后:

1. 在会话中显示完成报告（参见 conductor-role.md「完成时的处理」步骤 8。简洁输出设计决策、试错经过、自主判断、疑虑、成果等要点）
2. 发送完成通知:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
