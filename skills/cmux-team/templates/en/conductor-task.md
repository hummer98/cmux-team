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

Follow the completion procedures in `conductor-role.md` ("Completion Procedures" Steps 1-12). In particular:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` closes the task and internally sends CONDUCTOR_DONE to daemon.
- Step 12: Display the completion report on the session.

**Do not call `cmux-team send CONDUCTOR_DONE --success true` yourself** — close-task does that on your behalf. Use the `--success false` path in `conductor-role.md` Step 8 only when you need to abort without calling close-task (e.g. rebase conflict).
