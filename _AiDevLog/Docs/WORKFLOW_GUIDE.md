# APC Workflow Guide

This guide explains how to use the Agentic Planning Coordinator for development workflows.

---

## Quick Start

### 1. Open the APC Panel

Click the **Agentic Planning** icon in the VS Code Activity Bar (sidebar).

### 2. Start a Planning Session

Click the **+** button or run command:
```bash
apc plan new "Implement user authentication with OAuth2"
```

### 3. Wait for Planning to Complete

Watch the Output panel for live progress. The AI analysts will:
- Analyze your requirement
- Inspect the Unity project (if applicable)
- Debate the best approach
- Generate an execution plan

### 4. Review the Plan

Once planning completes:
- Status changes to **reviewing**
- Open `_AiDevLog/Plans/ps_XXXXXX/plan.md` to review

### 5. Approve and Execute

```bash
apc plan approve --id ps_000001
```

Or click the ✓ button in the UI.

### 6. Monitor Execution

The sidebar shows:
- Active agents and their tasks
- Progress percentage
- Any errors or warnings

---

## Detailed Workflows

### Planning Phase

#### Starting a Plan with Documents

If you have specification documents:

```bash
apc plan new "Implement combo system" --docs "_AiDevLog/Docs/GDD.md,_AiDevLog/Docs/TDD.md"
```

Documents are copied to `_AiDevLog/Docs/` and referenced by planning agents.

#### Understanding the Debate

During planning, you'll see output like:

```
[12:34:56] [PHASE-3] 🤖 RUNNING MULTI-AGENT DEBATE VIA CURSOR CLI...
[12:34:57] [AGENTS]   ✓ Cursor CLI available
[12:34:57] [AGENTS]   🎯 Running 4 parallel agent sessions:
[12:34:57] [AGENTS]     • Context Gatherer (gemini-3-pro) - Background context gathering
[12:34:58] [AGENTS]     • Opus Analyst (opus-4.5) - Architecture & Design
[12:34:58] [AGENTS]     • Codex Analyst (gpt-5.1-codex-high) - Implementation & Performance
[12:34:58] [AGENTS]     • Gemini Analyst (gemini-3-pro) - Testing & Integration
```

Each analyst focuses on different aspects:
- **Opus**: Architecture, design patterns, dependencies
- **Codex**: Implementation details, performance, code structure
- **Gemini**: Testing strategy, integration points

#### Revising a Plan

If the plan needs changes:

```bash
apc plan revise --id ps_000001 --feedback "Focus more on unit tests and add error handling for network failures"
```

The revision agent will update the plan based on your feedback.

---

### Execution Phase

#### Understanding Auto Mode

In **auto** mode (default), the coordinator:
1. Parses tasks from the plan
2. Tracks dependencies
3. Dispatches ready tasks to available agents
4. Handles Unity compilation/testing
5. Routes errors to appropriate agents
6. Generates summary when complete

#### Understanding Interactive Mode

In **interactive** mode:
- Coordinator waits for human approval before dispatching
- Use for sensitive operations or learning

```bash
apc exec start --session ps_000001 --mode interactive
```

#### Monitoring Progress

```bash
# Overall progress
apc task progress coord_abc12345

# List all tasks
apc task list coord_abc12345

# Check specific agent
apc agent status coord_abc12345 Alex
```

#### Pausing and Resuming

```bash
# Pause execution
apc exec pause --session ps_000001

# Resume later
apc exec resume --session ps_000001
```

---

### Agent Management

#### Scaling Up

If more agents are needed:

```bash
# Request 2 more engineers
apc agent request coord_abc12345 2 --role engineer
```

#### Releasing Idle Agents

When agents are idle and not needed:

```bash
apc agent release coord_abc12345 Betty
```

#### Viewing Agent Logs

```bash
# Last 100 lines
apc agent log coord_abc12345 Alex --lines 100
```

Or click on an agent in the sidebar to open their terminal.

---

### Unity Integration

#### How Unity Testing Works

1. Agent completes implementation
2. Agent calls `apc agent complete --unity "prep,test_editmode"`
3. Agent process **exits**
4. UnityControlManager queues the pipeline
5. Unity reimports assets and compiles
6. Tests run (EditMode, then PlayMode if specified)
7. Results are sent to Coordinator
8. Coordinator dispatches fixes or marks complete

#### Manual Unity Commands

```bash
# Queue compilation check
apc unity compile --coordinator coord_abc12345 --agent Alex

# Queue EditMode tests
apc unity test editmode --coordinator coord_abc12345 --agent Alex

# Check Unity status
apc unity status

# Wait for task completion
apc unity wait --task unity_12345 --timeout 120
```

---

### Error Handling

#### When Tests Fail

The coordinator automatically:
1. Identifies failed tests
2. Creates fix tasks
3. Dispatches agents to fix issues
4. Re-runs tests

#### Manual Intervention

```bash
# Reset a failed task for retry
apc task reset coord_abc12345 T5

# Manually fail a task
apc task fail coord_abc12345 T5 --reason "Manual intervention needed"

# Defer a task (conflicts with ongoing work)
apc task defer coord_abc12345 T7 --reason "Waiting for T5 to complete" --blocked-by T5
```

---

### Role Customization

#### Viewing Available Roles

```bash
apc agent roles
```

#### Customizing Roles (UI)

1. Open Command Palette (Cmd+Shift+P)
2. Run "APC: Configure Agent Roles"
3. Edit role properties:
   - Prompt template
   - Default model
   - Allowed tools/commands
   - Rules and documents

#### Creating Custom Roles

In the Role Settings panel:
1. Click "Create Custom Role"
2. Fill in:
   - ID (lowercase, no spaces): `qa_specialist`
   - Name: "QA Specialist"
   - Description: "Focuses on testing and quality"
   - Prompt template
3. Save

---

## Best Practices

### Writing Good Requirements

**Good**:
```
Implement a combo system for the player character with:
- ComboData ScriptableObject for combo definitions
- ComboController component for state management  
- Input buffering for responsive feel
- Animation events for hit detection
Reference: GDD Section 4.2
```

**Bad**:
```
Add combos to the game
```

### Organizing Documents

```
_AiDevLog/
├── Docs/
│   ├── GDD.md           # Game Design Document
│   ├── TDD.md           # Technical Design Document
│   ├── API_Reference.md # External API docs
│   └── Decisions/       # Architecture Decision Records
├── Context/
│   ├── project_overview.md
│   ├── coding_standards.md
│   └── architecture.md
└── Plans/
    └── ps_000001/
        └── plan.md
```

### Monitoring Best Practices

1. **Watch the Output panel** during planning for live updates
2. **Review plans before approving** - check task breakdown and dependencies
3. **Check agent logs** when execution stalls
4. **Use Unity console** to catch runtime errors early

---

## Troubleshooting

### "No agents available"

All agents are allocated. Either:
- Wait for agents to complete their tasks
- Release idle agents: `apc agent release coord_xxx Betty`
- Increase pool size in settings

### "Coordinator not found"

The coordinator ID is invalid or the coordinator was stopped. Check:
```bash
apc coordinator list
```

### Planning Seems Stuck

1. Check Output panel for errors
2. Look for Cursor CLI issues
3. Verify network connectivity (AI backends)
4. Check `_AiDevLog/Plans/ps_xxx/progress.log`

### Unity Tests Not Running

1. Ensure Unity is open and not compiling
2. Check Unity MCP connection
3. Verify test framework is installed
4. Check Unity Console for errors

### Agent Process Stuck

```bash
# Show running processes
apc agent list coord_xxx

# Kill stuck processes
# Via VS Code command: "Agentic: Kill Stuck Processes"
```

---

## File Reference

| Path | Purpose |
|------|---------|
| `_AiDevLog/.extension_state.json` | Global extension state |
| `_AiDevLog/.agent_pool.json` | Agent allocation state |
| `_AiDevLog/Plans/{id}/session.json` | Planning session state |
| `_AiDevLog/Plans/{id}/coordinator.json` | Coordinator state |
| `_AiDevLog/Plans/{id}/plan.md` | The execution plan |
| `_AiDevLog/Plans/{id}/progress.log` | Live progress updates |
| `_AiDevLog/Plans/{id}/logs/` | Agent log files |
| `_AiDevLog/Plans/{id}/summaries/` | Execution summaries |
| `_AiDevLog/Roles/` | Custom role configurations |
| `_AiDevLog/Context/` | Project context files |
| `_AiDevLog/Docs/` | Documentation files |

