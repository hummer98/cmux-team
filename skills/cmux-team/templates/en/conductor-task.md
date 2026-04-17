# Task Assignment

## Task Content

{{TASK_CONTENT}}

## Working Directory

All work must be done within the git worktree `{{WORKTREE_PATH}}`.
```bash
cd {{WORKTREE_PATH}}
```
Do not make changes directly on the {{MAIN_BRANCH}} branch.

Branch name: `{{CONDUCTOR_ID}}/task`

## Pre-work Verification (Bootstrap)

The worktree only contains tracked files. Before starting work, verify the following:
- If `package.json` exists, run `npm install`
- Check for runtime directories listed in `.gitignore` (`node_modules/`, `dist/`, `workspace/`, etc.) and rebuild if necessary
- Set up `.envrc` or environment variables

## Output Directory

```
{{OUTPUT_DIR}}
```

Write the result summary to `{{OUTPUT_DIR}}/summary.md`.

## Merge Target Branch

Merge the deliverables of this task into `{{BASE_BRANCH}}`.
Follow the delivery method (local merge or PR) as specified in conductor-role.md's completion procedures.

## Completion Notification

When all processing is complete:

1. Display a completion report on the session (refer to conductor-role.md "Completion Procedures" Step 12. Concisely output design decisions, trial-and-error, independent judgments, concerns, and key outcomes)
2. Send the completion notification:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
