# cmux-team

Claude Code + cmux 多智能体开发编排的技能/命令包。
Master（用户交互）→ Manager（事件驱动监控）→ Conductor（任务执行）→ Agent（实际工作）的4层结构。

## 项目使命

**利用 cmux 的终端复用功能，协调 Claude Code 的多个会话，自主完成开发任务。**

### 目标

1. **用户只需下达指令** — 实现、测试、评审全部由智能体完成
2. **进度可见** — 通过 cmux 的窗格分割实时可视化智能体的工作
3. **安全地失败** — 通过 git worktree 隔离，main 始终不受影响
4. **任何人都能作为插件安装** — 以 Claude Code Plugin 形式分发

### 设计原则

| 原则 | 含义 |
|------|------|
| **上层监控下层（pull 型）** | 不依赖下层的 push 报告。规避语义动作的可靠性问题 |
| **确定性的用代码，需要判断的用 AI** | 事件检测要确保可靠，决策要保持灵活 |
| **各层只做自己的工作** | Master 不做具体工作，Agent 不做报告，Conductor 不询问用户 |
| **与其防止偏离，不如构建即使偏离也安全的结构** | worktree 隔离 + 事后评审 |
| **简洁优先** | 以最小配置实现可运行的系统。避免过度抽象 |

## 判断标准与优先级

### 任务优先级（高→低）

1. **Bug 修复** — 现有功能损坏时最优先
2. **修复实验中发现的问题** — 实际运行后发现的 issue（如 #12 之类的具体失败案例）
3. **用户体验改善** — 使安装、启动、操作更简便的变更
4. **文档准确性** — README 或 SKILL.md 与实现不一致时进行修正
5. **新功能** — 新增智能体角色或命令
6. **优化** — 性能、token 消耗、速率限制对策

### 判断犹豫时

- **"能不能跑？"最优先** — 比起理论上的优雅，实际能运行更重要
- **先实验验证再正式实现** — 在 cmux-team-lab 等环境试过后再反映到 SKILL.md
- **不破坏现有行为** — 保持 CLI 命令接口的稳定
- **询问用户** — 设计决策拿不准时创建 issue 征求用户意见

## GitHub issue 创建指南

> **注意:** 这里的「issue」指 GitHub issue。与本地任务管理（`.team/tasks/`）是不同的概念。

### 应该创建 issue 的场景

- 实验中发现的具体失败模式（附带复现步骤）
- SKILL.md 的指示与实际智能体行为的偏差
- 由于 cmux 侧的限制需要变通方案的情况
- 需要设计决策且存在多个选项的情况

### issue 中应包含的信息

- **问题**: 发生了什么（如有实际案例请具体描述）
- **原因**: 为什么发生
- **修复内容**: 具体的变更方案（精确到文件名和章节号）
- **目标文件**: 需要修改的文件列表

### 不应该创建 issue 的场景

- typo 或格式的轻微修正 → 直接提交即可
- 明显的 bug 修复 → 直接提交即可
- 未来的理想功能 → 聚焦于当前目标

## 仓库结构

```
cmux-team/
├── .claude-plugin/
│   ├── plugin.json                   # 插件清单
│   └── marketplace.json              # Marketplace 目录
├── package.json                      # npm 包定义
├── .npmignore                        # npm publish 排除设置
├── bin/
│   ├── cmux-team.js                  # CLI 入口点
│   └── postinstall.js                # npm postinstall 脚本
├── skills/
│   ├── cmux-team/
│   │   ├── SKILL.md                  # 4层架构定义技能
│   │   ├── manager/                  # Manager daemon（TypeScript / Bun）
│   │   │   ├── main.ts               #   CLI 入口（子命令实现）
│   │   │   ├── daemon.ts             #   主循环・文件监控
│   │   │   ├── conductor.ts          #   Conductor 初始化・任务分配・监控
│   │   │   ├── master.ts             #   Master spawn・监控
│   │   │   ├── cmux.ts               #   cmux 命令封装
│   │   │   ├── proxy.ts              #   日志代理（API 透明拦截）
│   │   │   ├── queue.ts              #   消息队列
│   │   │   ├── trace-store.ts        #   SQLite FTS5 追踪
│   │   │   ├── task.ts               #   任务管理
│   │   │   ├── template.ts           #   提示词模板展开
│   │   │   ├── artifact.ts           #   Artifact 管理
│   │   │   ├── dashboard.tsx         #   TUI 仪表盘
│   │   │   ├── logger.ts             #   日志输出
│   │   │   ├── schema.ts             #   Zod schema 定义
│   │   │   └── package.json          #   Bun 依赖
│   │   └── templates/                # 智能体提示词模板 (14个)
│   │       ├── common-header.md      #   全智能体通用头部
│   │       ├── master.md             #   Master 角色
│   │       ├── manager.md            #   Manager 角色
│   │       ├── conductor.md          #   Conductor 角色（旧）
│   │       ├── conductor-role.md     #   Conductor 常驻角色
│   │       ├── conductor-task.md     #   Conductor 任务分配时提示词
│   │       ├── researcher.md         #   研究员角色
│   │       ├── architect.md          #   架构师角色
│   │       ├── planner.md            #   计划制定角色
│   │       ├── design-reviewer.md    #   设计评审角色
│   │       ├── implementer.md        #   实现者角色
│   │       ├── inspector.md          #   检验角色
│   │       ├── dockeeper.md          #   文档管理者角色
│   │       └── task-manager.md       #   任务管理者角色
│   └── cmux-agent-role/
│       └── SKILL.md                  # 子智能体行为规范技能
├── commands/                         # 斜杠命令定义 (5个)
│   ├── master.md                     #   Master 角色重新加载（/clear 恢复用）
│   ├── team-spec.md                  #   需求头脑风暴（交互式）
│   ├── team-task.md                  #   任务管理
│   ├── team-archive.md              #   已完成任务的归档
│   └── artifact.md                  #   知识的 Artifact 化
├── docs/
│   ├── spec/                         # 集成规格书（与实现同步的规格）
│   │   ├── 00-project-overview.md
│   │   ├── 01-skill-cmux-team.md
│   │   ├── 02-skill-cmux-agent-role.md
│   │   ├── 03-commands.md
│   │   ├── 04-templates.md
│   │   ├── 05-install-and-infrastructure.md
│   │   └── 06-implementation-tasks.md
│   ├── research/                     # 研究文档
│   └── slides/                       # 演示资料
├── CHANGELOG.md                      # 变更日志
├── LICENSE                           # MIT
├── README.md                         # 面向用户的文档（英语）
└── README.ja.md                      # 面向用户的文档（日语）
```

### 两个技能的职责分工

| 技能 | 谁来读取 | 内容 |
|--------|-----------|------|
| `cmux-team` (SKILL.md) | Master（用户会话） | 4层架构整体定义、Master 行为原则 |
| `cmux-agent-role` (SKILL.md) | Agent（实际工作智能体） | 输出协议・任务创建・工作边界 |

### docs/spec/（集成规格书）

与实现同步的集成规格书。各文件定义了项目的设计・实现规格，是代码变更时应参考的文档。

**当被询问 cmux-team 的规格・行为时，应 Read 对应的 `docs/spec/` 文件后回答。**

| 文件 | 内容 |
|---------|------|
| 00-project-overview.md | 项目概要・4层架构・设计原则 |
| 01-skill-cmux-team.md | cmux-team 技能（SKILL.md）的规格 |
| 02-skill-cmux-agent-role.md | cmux-agent-role 技能（SKILL.md）的规格 |
| 03-commands.md | 斜杠命令定义 |
| 04-templates.md | 智能体提示词模板规格 |
| 05-install-and-infrastructure.md | 安装・基础设施配置 |
| 06-implementation-tasks.md | 实现任务定义 |

## 技能・命令的添加・修改方法

### 添加技能

1. 创建 `skills/<skill-name>/SKILL.md`
2. 在 YAML frontmatter 中填写 `name`, `description`（包含触发条件）
3. 在 Markdown 正文中描述技能的知识・协议

### 添加命令

1. 创建 `commands/<command-name>.md`
2. 在 YAML frontmatter 中填写 `allowed-tools`, `description`
3. 在 Markdown 正文中描述步骤・参数规格・注意事项
4. 使用 `$ARGUMENTS` 引用用户传入的参数

### 添加模板

1. 创建 `skills/cmux-team/templates/<role-name>.md`
2. 使用 `{{VARIABLE}}` 占位符（见下文）
3. Conductor（或 Manager）在 spawn 时替换模板变量并写出到 `.team/prompts/`

## 模板变量规格

模板内的 `{{VARIABLE}}` 占位符，由 Conductor（或 Manager）在生成提示词时替换为实际值。

### 通用变量（来自 common-header.md）

| 变量 | 说明 |
|------|------|
| `{{ROLE_ID}}` | 智能体的标识符（例: `researcher-1`, `architect`） |
| `{{TASK_DESCRIPTION}}` | 任务的描述文本 |
| `{{PROJECT_ROOT}}` | 项目根目录的绝对路径 |

### Conductor 变量

| 变量 | 使用模板 | 说明 |
|------|----------------|------|
| `{{TASK_CONTENT}}` | conductor-task | 任务文件正文 |
| `{{WORKTREE_PATH}}` | conductor, conductor-task | git worktree 的路径 |
| `{{OUTPUT_DIR}}` | conductor, conductor-task | 输出目录路径（例: `.team/output/<taskRunId>/`） |
| `{{CONDUCTOR_ID}}` | conductor, conductor-task | Conductor 执行 ID（`task-<NNN>-<timestamp>` 格式。例: `task-042-1712345678`） |
| `{{TASK_STATUS_FILE}}` | conductor, conductor-task | 完成标记文件路径 |
| `{{PROJECT_ROOT}}` | conductor-role | 项目根目录的绝对路径 |

### Agent 角色专用变量

| 变量 | 使用模板 | 说明 |
|------|----------------|------|
| `{{COMMON_HEADER}}` | 全 Agent 角色 | common-header.md 的展开结果 |
| `{{OUTPUT_FILE}}` | 全 Agent 角色 | 输出文件路径（例: `.team/output/researcher-1.md`） |
| `{{TOPIC}}` | researcher | 研究主题 |
| `{{SUB_QUESTIONS}}` | researcher | 需要调查的子问题列表 |
| `{{REQUIREMENTS_CONTENT}}` | architect | requirements.md 的内容 |
| `{{RESEARCH_SUMMARY}}` | architect | 研究结果摘要 |
| `{{CODEBASE_CONTEXT}}` | architect | 现有代码库的上下文 |
| `{{PLAN_CONTENT}}` | planner, design-reviewer, implementer, inspector | plan.md 的内容 |
| `{{TASK_CONTENT}}` | planner, design-reviewer, inspector | 任务内容 |
| `{{DESIGN_CONTENT}}` | implementer | design.md 的内容 |
| `{{TASKS_CONTENT}}` | implementer | tasks.md 中分配的任务 |
| `{{SPECS_CONTENT}}` | dockeeper | 当前规格书全文 |
| `{{LAST_SNAPSHOT_SUMMARY}}` | dockeeper | 上次 docs 快照的摘要 |
| `{{OPEN_TASKS_LIST}}` | task-manager | 未完成任务列表 |

## 安装方法

```bash
npm install -g @hummer98/cmux-team
```

`postinstall` 脚本会自动解析 manager/ 的依赖。

## 测试方法

没有自动测试。按以下步骤进行 E2E 测试。

### 前提条件

- 已安装 cmux
- Claude Code 可用（推荐 Claude Max）

### 安装测试

```bash
# 全局安装
npm install -g @hummer98/cmux-team
# → 技能・命令・模板应被部署到 ~/.claude/
# → cmux-team 命令应可用

# 卸载
npm uninstall -g @hummer98/cmux-team
```

### 功能测试（在终端中执行）

```bash
# 1. 启动 cmux
cmux

# 2. 构建团队体制（daemon + Master + Conductor 启动）
cmux-team start
# → .team/ 应被创建且 team.json 正确
# → daemon 应启动并作为 Manager 运行
# → Master Claude 会话应被 spawn
# → 3个 Conductor 应被放置在固定窗格中

# 3. 创建任务（在 Master 会话内）
cmux-team create-task --title "测试任务" --status ready --body "测试用"
# → 任务文件应在 .team/tasks/ 中创建
# → daemon 应检测到任务并分配给空闲的 Conductor
# → Conductor 应自主执行任务

# 4. 确认状态
cmux-team status
# → 应显示 daemon 状态、Conductor 列表、任务数、日志

# 5. 清理
cmux-team stop
# → daemon 应优雅关闭
```

### 确认要点

- 4层结构（Master → Manager(daemon) → Conductor → Agent）正常运作
- daemon 检测到任务并分配给空闲的 Conductor
- Conductor 完成任务后创建 done 标记并回到空闲状态
- Agent 在 git worktree 内工作，不污染主分支
- `cmux send` 后通过 `cmux send-key return` 发送
- 出现 Trust 确认时自动批准

## 编码规范

- **文档・注释**: 日语
- **代码（变量名・函数名・命令）**: 英语
- 技能使用 YAML frontmatter + Markdown
- 命令使用 YAML frontmatter（`allowed-tools`, `description`）+ Markdown
- 模板使用 `{{VARIABLE}}` 占位符
- README.md 和面向用户的文本使用日语

### 开发者用技能

其他项目（mado, Dear 等）的 `.team/` 调查请参考 `.claude/skills/cmux-team-investigate/SKILL.md`。
该技能仅在此仓库的工作树内有效，不包含在 npm publish 中（非分发范围）。

## cmux API 使用注意事项

`cmux tree` 默认返回**所有工作区**的 surface。
在多个工作区同时运行 cmux-team 时，可能导致与其他工作区的 surface ID 混淆。

请遵守以下规则：

- 使用 `validateSurface(surface, workspace)` 而非 `validateSurface(surface)`
- 使用 `tree(workspace)` 而非 `tree()`（对应 `cmux tree --workspace <id>`）
- daemon 的 `state.workspace` 中存储了启动时的工作区（在 `main.ts` 启动时通过 `getCallerWorkspace()` 获取・设置）
- 可通过 `getCallerWorkspace()` 获取调用方的工作区（`cmux identify` 的 `caller.workspace_ref`）
- 验证现有 surface（`initializeLayout`, `isMasterAlive`, `checkConductorStatus` 等）时必须传入 workspace
- `newSplit` 之后等**新创建的 surface** 必定属于当前工作区，因此无需指定 workspace

## 日志策略

Manager daemon（`skills/cmux-team/manager/`）的日志相关规则。

### 日志接口

使用 `logger.ts` 的 `log(event, detail)`。通过事件名区分级别。

| 事件名模式 | 用途 | 示例 |
|-------------------|------|-----|
| `error` | 操作失败・异常 | `log("error", "assignTask failed: ...")` |
| `*_failed` | 特定操作的失败 | `log("proxy_start_failed", ...)` |
| `*_started`, `*_completed` | 生命周期事件 | `log("daemon_started", ...)` |
| 其他 | 状态变化・决策记录 | `log("conductor_reset", ...)` |

### 必须记录的事件

1. **异常捕获时**: 在 `catch` 中处理异常时，至少用 `log("error", ...)` 记录消息
2. **外部命令失败时**: cmux 命令（`send`, `sendKey`, `tree` 等）的失败用 `log("error", ...)` 记录。**当 error 对象包含 `stderr` / `stdout` 时，必须在 detail 中包含**（仅 `e.message` 会以 "Command failed: <cmd>" 结尾，无法追踪原因）。例: `log("error", \`tree failed: ${e.message} stderr=${e.stderr ?? ""}\`)`。
3. **判断分支**: 存在多个路径时，记录进入了哪个路径（例: done 标记检测方式、fallback 触发）
4. **状态转换**: Conductor/Agent 的状态变化必须记录（现有实现已做到）

### 禁止事项

- **空的 `catch {}`**: 不得完全吞掉异常。至少保留日志。但以下情况例外允许:
  - **幂等的后处理**（`closeSurface`, `renameTab`, `branch -d` 等）: 失败也没有影响的操作
  - **存在性检查类操作**（`validateSurface`, 文件存在确认等）: 失败＝不存在的设计
- **高频循环中的过度日志**: 不需要每次 `tick()` 都记录。仅在状态变化时记录
- **机密信息日志**: 不在日志中包含 API key、token 等

### 日志格式

```
[2026-04-04T10:30:00+09:00] event_name key1=value1 key2=value2
```

- 时间戳为带本地时区的 ISO 8601（由 `logger.ts` 的 `localISOString()` 生成）
- detail 为空格分隔的 `key=value`。值包含空格时直接追加到末尾
- 每行一个事件。避免多行日志

## 提示词编辑规则（严格遵守）

**模板 (`skills/cmux-team/templates/*.md`) 是唯一真实来源（Source of Truth）。** 运行时提示词 (`.team/prompts/*.md`) 是派生物，不得直接编辑。

| 应该做的 | 不应该做的 |
|---------|-------------|
| 编辑 `skills/cmux-team/templates/master.md` | 直接编辑 `.team/prompts/master.md` |
| 编辑 `skills/cmux-team/templates/manager.md` | 直接编辑 `.team/prompts/manager.md` |
| 编辑后通过 `cmux-team start` 重新生成或从模板复制 | 只修改运行时文件就算"改好了" |

**原因:** 如果只修改运行时提示词，与模板的偏差会不断累积。下次 `cmux-team start` 或在其他项目启动时变更将丢失。

变更提示词的步骤:
1. 编辑 `skills/cmux-team/templates/*.md`
2. 复制到 `.team/prompts/*.md`（或通过 `cmux-team start` 重新生成）
3. 同时更新其他项目（Dear 等）的运行时提示词
4. 提交・发布

## Manager 协议（内部实现）

以 TypeScript daemon（`skills/cmux-team/manager/main.ts`）形式在 Bun 中运行。基于队列的事件驱动进行任务管理。

- **日志**: 以追加形式记录状态变化到 `.team/logs/manager.log`（`conductor_started`, `task_completed`, `idle_start` 等）
- **状态确认**: 通过 `cmux-team status` 显示 daemon 状态・Conductor 列表・任务数・日志末尾

### 任务检测

在 `task-state.json` 中检测 `status: ready` 的任务并分配给 Conductor。如果没有则等待并重新检查。

### 向 Conductor 分配任务

1. 检测空闲的 Conductor（ConductorState 的 `status: "idle"` + surface 存活）
2. 创建 worktree・生成提示词
3. 向 Conductor surface 发送 `/clear` + 新提示词

**Conductor 不会被 spawn。** 只是向启动时创建的固定窗格发送任务。

### Conductor 监控（pull 型）

- **主要判定**: 通过 done 标记文件（`.team/output/conductor-N/done`）的存在判定完成
- **Fallback**: 通过 `cmux list-status` 检测 Idle
- **重要**: 是 pull 型而非 push 型。Conductor 创建 done 标记并回到空闲状态，Manager 来查看

### 任务的创建・更新通过 CLI（禁止直接文件操作）

任务的创建・更新必须使用 CLI。对 `.team/tasks/` 的直接文件写入会被 hook 阻止。

```bash
cmux-team create-task --title "标题" --status draft --body "描述"
cmux-team update-task --task-id 112 --status ready
```

> **注意:** `.team/artifacts/` 以直接创建文件为前提，但 `.team/tasks/` 仅限 CLI。不要混淆。

### 禁止编辑 assigned 状态的任务

禁止编辑 assigned 状态的任务文件。Conductor 基于启动时的提示词快照运行，任务文件的变更不会反映到正在执行的工作中。需要变更时: 用 `abort-task` 中止 → 创建新任务。

### 结果回收

完成检测后: 记录日志 → 重置 Conductor（`/clear`）→ 删除 done 标记。

Manager 不做的事:
- 关闭任务（Conductor 执行 `cmux-team close-task`）
- 关闭 Conductor 窗格（persistent — 不关闭）
- 删除 worktree（Conductor 的职责）
- 合并处理（Conductor 判断交付方式）

### 循环继续・空闲化

- **Conductor 运行中**: 默认10秒间隔（`CMUX_TEAM_POLL_INTERVAL`）执行 pull 型监控
- **空闲时（open tasks 为零）**: 停止并等待。记录 `idle_start` 日志
- **唤醒触发**: 通过 `[TASK_CREATED]` 通知重新启动

## 通信协议

### 基于文件的通信

`.team/` 目录结构:

```
.team/
├── tasks/             # 任务文件（扁平结构）
├── task-state.json    # 任务状态管理（status: draft/ready/assigned/closed）
├── artifacts/         # Axxx — 知识记录（调查・设计决策・会话摘要）
├── output/            # Conductor/Agent 的输出（按 taskRunId 分组）
├── conductors/        # Conductor 状态文件
├── prompts/           # 提示词（审计轨迹）
├── specs/             # 需求・设计文档
├── queue/             # 消息队列（incoming/ + processed/）
├── logs/              # manager.log + traces/bodies/
├── traces/            # SQLite 追踪 DB（traces.db）
├── sessions/          # 会话信息
├── proxy-port         # 代理端口号
└── team.json          # 团队配置（daemon 自动更新）
```

### cmux 命令通信

| 命令 | 用途 |
|---------|------|
| `cmux send` | 上层→下层的提示词发送 |
| `cmux send-key return` | 多行提示词的发送确认 |
| `cmux list-status` | 上层获取下层的状态（pull 型监控） |
| `cmux read-screen` | Trust 确认・错误确认 |
| `cmux close-surface` | 关闭已完成的 Agent 标签页 |
| `cmux-team spawn-agent` | Agent 启动（标签页创建・代理设置・Trust 批准一并执行） |

### 多行文本发送

单行可以在末尾加 `\n` 发送。多行提示词在 `cmux send` 之后通过 `sleep 0.5` + `cmux send-key return` 确认发送。

## 团队状态管理

### team.json

由 daemon 的 `updateTeamJson()` 定期自动更新。Master、Conductor、手动命令不得直接写入。

### 获取进度信息（面向 Master）

status.json 已废弃。Master 从以下真实来源直接获取信息:

| 信息 | 真实来源 | 获取方法 |
|------|-----------|---------|
| Manager 的状态 | Manager workspace | `cmux list-status --workspace MANAGER_WS` |
| 运行中的 Conductor | cmux 窗格配置 | `cmux tree` |
| open task 数 | task-state.json | `cat .team/task-state.json`（按 status 筛选） |
| 已完成任务历史 | 日志 | `cat .team/logs/manager.log` |

## 布局策略

### 固定2x2布局

启动时创建固定的2x2布局（4个窗格，5个 surface），在会话结束前不变。

```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```

- **左上**: Manager（daemon）| Master（用户会话）— 2个 surface 以标签页形式共存
- **右上〜右下**: Conductor-1〜3（常驻 Claude 会话）
- **4个窗格不变** — 不关闭
- **子智能体**通过 `spawn-agent` CLI 在 Conductor 窗格内以标签页形式创建（标签页不占用空间，因此布局不会错乱）
- **最多3个任务并行**，第4个及之后排队等待

## git worktree（概要）

所有工作在 `.worktrees/<taskRunId>/` 内进行。main 分支始终不受影响。

- **创建**: `git worktree add .worktrees/<taskRunId> -b <taskRunId>`（taskRunId 为 `task-<NNN>-<timestamp>` 格式。例: `task-042-1712345678`）
- **引导**: 由于只检出 tracked files，需要 `npm install` 等初始化（详情参见 `templates/conductor.md`）
- **成功时**: 在 worktree 内提交 → 合并到 main → 删除 worktree
- **失败时**: `git worktree remove --force` + 删除分支
- **清理**: 用 `git worktree list` 确认，用 `git worktree remove <path> --force` 删除，用 `git worktree prune` 修复损坏的引用

## 错误恢复

| 故障 | 检测者 | 应对 |
|------|--------|------|
| Agent 崩溃 | Conductor | 通过 `cmux list-status` 检测消失 → 重新 spawn |
| Conductor 崩溃 | Manager | 一直 Idle 且无 done 标记 → 重新 spawn 或 abort 后 reopen 任务 |
| Manager 崩溃 | Master | Manager 无响应 → 重新 spawn |
| API 速率限制 | 各层 | 等待后重试，减少同时 Agent 数 |

**异常检测**: 通过 `cmux list-status` 判定 Running/Idle。无法检测时回退到 `cmux read-screen`（显示 shell 提示符 → Claude 已终止，错误消息 → 崩溃，画面为空 → 窗格消失）。

## 已知注意事项

### Trust 确认（首次启动时）

在新目录中启动 Claude 时会显示「Trust this folder?」确认。Manager 或 Conductor 通过 `cmux read-screen` 检测并用 `cmux send-key return` 自动批准，但因时序问题有时可能需要手动介入。

### 窗格宽度注意事项

子智能体在 Conductor 的同一 pane 内以标签页形式创建（`cmux new-surface`）。标签页创建失败时会回退到 `new-split right`。

### 权限确认

即使以 `--dangerously-skip-permissions` 启动，写入 `.claude/commands/` 或 `.claude/skills/` 时也可能出现确认对话框。请在首次确认时选择「Yes, and allow Claude to edit its own settings for this session」。

### 可追溯性（v3.4.0）

daemon 启动时 API Proxy 自动启动，将所有 API 请求记录到 SQLite FTS5 数据库。

- **DB 路径**: `.team/traces/traces.db`
- **正文保存**: `.team/logs/traces/bodies/`
- **搜索**: `cmux-team trace --task <id>`, `--search <query>`, `--show <id>`
- **元数据**: 通过 `x-cmux-task-id`, `x-cmux-conductor-surface`, `x-cmux-role` 头部传播
- **自动设置**: 为 Master/Conductor 设置 `ANTHROPIC_BASE_URL`，使所有请求经过 Proxy

### API 速率限制

多智能体同时执行容易造成 API 过载。由于4层结构增加了同时会话数，推荐使用 Claude Max。

## Artifacts（知识记录）

会话中的调查结果・设计决策・会话摘要以 Axxx 编号保存在 `.team/artifacts/` 中。

### Txxx 与 Axxx 的区别

| | Txxx（任务） | Axxx（Artifact） |
|---|---|---|
| 本质 | 「要做的事」的管理 | 「了解到的事」的记录 |
| 生命周期 | draft → ready → assigned → closed | 创建 → 引用（→ 归档） |
| 谁创建 | Master / 用户 | 任何人（Master, Conductor, Agent） |

### 何时创建 Artifact

- 进行调查・研究时（type: research）
- 做出设计决策时（type: decision）
- 会话结束时有重要发现时（type: session）
- 整理需求・规格时（type: spec）
- 创建分析报告时（type: report）

### 格式

文件名: `.team/artifacts/Axxx-<slug>.md`

```yaml
---
id: A001
type: research          # research | decision | session | spec | report
title: "标题"
created: <ISO 8601>
updated: <ISO 8601>     # 可选 — 更新时附加
author: master          # master | conductor-N | agent-xxx
task: T038              # 可选 — 关联任务
tags: [tag1, tag2]      # 可选
---
```

### 引用方法

- 会话中: 「如 A001 调查所示」「基于 A003 的设计决策」
- 与任务关联: 通过 frontmatter 的 `task: T038` 进行关联
- 新会话开始时: 查看最近的 artifacts 恢复上下文

### 命令

- `/artifact [type] "标题"` — 从会话上下文生成摘要・保存
- `/artifact list` — 列表显示
- `/artifact show Axxx` — 显示内容
