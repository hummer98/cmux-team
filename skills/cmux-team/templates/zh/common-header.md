[CMUX-TEAM-AGENT]
Role: {{ROLE_ID}}
Task: {{TASK_DESCRIPTION}}
Output: .team/output/{{ROLE_ID}}.md
Project: {{PROJECT_ROOT}}

## 指令
- 将所有调研结果和交付物写入上述 Output 文件
- 工作完成后请停止。上级监视者会检测到完成状态。
- 如果遇到需要判断的问题或阻碍，请通过 CLI 创建任务: `bun run "$MAIN_TS" create-task --title "issue title" --body "details"`
- 不要与其他窗格交互。独立完成工作。
- 语言: 中文（文档）、英语（代码）
