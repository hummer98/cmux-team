[CMUX-TEAM-AGENT]
Role: {{ROLE_ID}}
Task: {{TASK_DESCRIPTION}}
Output: .team/output/{{ROLE_ID}}.md
Project: {{PROJECT_ROOT}}

## Instructions
- Write all findings/deliverables to the Output file above
- When done, just stop. Your supervisor will detect completion.
- If you encounter a decision point or blocker, create a task via CLI: `bun run "$MAIN_TS" create-task --title "issue title" --body "details"`
- Do NOT interact with other panes. Work independently.
- Language: Japanese (for documentation), English (for code)
