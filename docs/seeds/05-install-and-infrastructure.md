# Seed: Install Script & Infrastructure

---

## install.sh

**Purpose:** Copy skills, commands, and templates to `~/.claude/`

**Behavior:**
1. Detect `~/.claude/` exists (error if not — Claude Code not installed)
2. Create directories:
   - `~/.claude/skills/cmux-team/`
   - `~/.claude/skills/cmux-agent-role/`
   - `~/.claude/commands/`
3. Copy files:
   - `.claude/skills/cmux-team/SKILL.md` → `~/.claude/skills/cmux-team/SKILL.md`
   - `.claude/skills/cmux-team/templates/` → `~/.claude/skills/cmux-team/templates/`
   - `.claude/skills/cmux-agent-role/SKILL.md` → `~/.claude/skills/cmux-agent-role/SKILL.md`
   - `.claude/commands/*.md` → `~/.claude/commands/`
4. Verify cmux is installed (`command -v cmux`)
   - Warn if not found (skills install fine, but won't work without cmux)
5. Print summary with available commands

**Flags:**
- `--uninstall` — remove all installed files
- `--check` — verify installation without modifying

---

## uninstall.sh (or install.sh --uninstall)

Remove:
- `~/.claude/skills/cmux-team/`
- `~/.claude/skills/cmux-agent-role/`
- `~/.claude/commands/team-*.md`

Do NOT remove:
- `~/.claude/` itself
- Other skills/commands
- Project `.team/` directories

---

## CLAUDE.md (for cmux-team repo development)

```markdown
# cmux-team

AI sub-agent orchestration via cmux for Claude Code.

## Structure
- `.claude/skills/` — Skill definitions (SKILL.md files)
- `.claude/commands/` — Slash command definitions
- `docs/seeds/` — Design seed documents (input for implementation)
- `templates/` — Agent prompt templates

## Development Rules
- Skills use YAML frontmatter + Markdown content
- Commands reference skills via $instructions
- Templates use {{VARIABLE}} placeholders
- All user-facing text in Japanese, code in English
```

---

## .gitignore

```
# OS
.DS_Store

# Editor
.vscode/
.idea/

# Per-project state (not part of this repo)
.team/output/
.team/prompts/
.team/docs-snapshot/
```

---

## Hooks Configuration (optional, recommended)

Documented in README for users to add to their `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "command -v cmux >/dev/null 2>&1 && cmux claude-hook notification || true"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "command -v cmux >/dev/null 2>&1 && cmux claude-hook stop || true"
          }
        ]
      }
    ]
  }
}
```
