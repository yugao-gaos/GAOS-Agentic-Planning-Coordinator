# APC CLI Reference

## Overview

The `apc` command-line interface allows AI agents to interact with the Agentic Planning Coordinator extension. It communicates with the extension via WebSocket IPC.

## Installation

```bash
# Install via VS Code command palette
Agentic: Install CLI (apc command)

# Or manually symlink
ln -s /path/to/extension/scripts/apc ~/.local/bin/apc
```

## Usage

```bash
apc <command> [subcommand] [options]
```

---

## Command Reference

### Global Status

```bash
apc status
```

Returns overall system status including active sessions, coordinators, and agent pool.

**Response**:
```json
{
  "success": true,
  "data": {
    "activePlanningSessions": 1,
    "activeCoordinators": 1,
    "agentPool": {
      "total": 5,
      "available": 2,
      "busy": 3
    }
  }
}
```

---

### Plan Commands

#### List Planning Sessions
```bash
apc plan list
```

#### Start Planning Session
```bash
apc plan new "<requirement>" [--docs <path1,path2>]
```

**Example**:
```bash
apc plan new "Implement a combo system for melee attacks" --docs "_AiDevLog/Docs/GDD.md,_AiDevLog/Docs/TDD.md"
```

**Response**:
```json
{
  "success": true,
  "message": "Planning session ps_000001 completed - reviewing",
  "data": {
    "sessionId": "ps_000001",
    "status": "reviewing",
    "planPath": "_AiDevLog/Plans/ps_000001/plan.md",
    "recommendedAgents": 4,
    "debateSummary": {
      "phases": ["Document Analysis", "Unity Project Inspection", ...],
      "concerns": ["Existing input system may need refactoring"],
      "recommendations": ["Use ScriptableObject for combo data"]
    }
  }
}
```

#### Get Session Status
```bash
apc plan status --id <session_id>
```

#### Revise Plan
```bash
apc plan revise --id <session_id> --feedback "<revision feedback>"
```

#### Approve Plan
```bash
apc plan approve --id <session_id>
```

Approving a plan automatically starts execution.

#### Cancel Plan
```bash
apc plan cancel --id <session_id>
```

---

### Execution Commands

#### Start Execution
```bash
apc exec start --session <session_id> [--mode auto|interactive] [--engineers <n>]
```

#### Pause Execution
```bash
apc exec pause --session <session_id>
```

#### Resume Execution
```bash
apc exec resume --session <session_id>
```

#### Stop Execution
```bash
apc exec stop --session <session_id>
```

#### Execution Status
```bash
apc exec status --session <session_id>
```

---

### Task Commands

Tasks are managed by the Coordinator agent during execution.

#### Create Task
```bash
apc task create <coordinator_id> "<description>" --id T1 [--deps T2,T3] [--agent Alex] [--role engineer]
```

**Example**:
```bash
apc task create coord_abc123 "Create ComboData ScriptableObject" --id T1 --deps None --agent Alex
```

#### Start Task
```bash
apc task start <coordinator_id> <task_id> --agent <name> [--role engineer]
```

Spawns an AI agent process to work on the task.

#### Complete Task
```bash
apc task complete <coordinator_id> <task_id> [--files "path1.cs,path2.cs"]
```

#### Fail Task
```bash
apc task fail <coordinator_id> <task_id> --reason "<error message>"
```

#### Reset Task
```bash
apc task reset <coordinator_id> <task_id>
```

Resets a failed task to "ready" status for retry.

#### List Tasks
```bash
apc task list <coordinator_id> [--status ready|pending|completed|in_progress|deferred]
```

#### Get Ready Tasks
```bash
apc task ready <coordinator_id>
```

Returns tasks with satisfied dependencies ready for dispatch.

#### Task Progress
```bash
apc task progress <coordinator_id>
```

**Response**:
```json
{
  "success": true,
  "data": {
    "completed": 5,
    "total": 12,
    "percentage": 41.67
  }
}
```

#### Assign Task
```bash
apc task assign <coordinator_id> <task_id> --agent <name> [--role engineer]
```

Assigns without starting (for pre-allocation).

#### Update Task Status
```bash
apc task status <coordinator_id> <task_id> <stage> [--reason "why"]
```

Valid stages: `test_passed`, `test_failed`, `compile_failed`, `completed`, `failed`

#### Defer Task
```bash
apc task defer <coordinator_id> <task_id> --reason "why" [--blocked-by <task_id>]
```

Used when a task conflicts with ongoing work.

#### Undefer Task
```bash
apc task undefer <coordinator_id> <task_id>
```

---

### Agent Commands

#### List Agents
```bash
apc agent list <coordinator_id>
```

#### Agent Status
```bash
apc agent status <coordinator_id> <agent_name>
```

#### Agent Log
```bash
apc agent log <coordinator_id> <agent_name> [--lines 50]
```

#### Request Agents
```bash
apc agent request <coordinator_id> [count] [--role engineer]
```

Request additional agents from the pool when all assigned agents are busy.

**Example**:
```bash
apc agent request coord_abc123 2 --role engineer
```

#### Release Agent
```bash
apc agent release <coordinator_id> <agent_name>
```

Release an idle agent back to the pool.

#### Agent Complete
```bash
apc agent complete <coordinator_id> --agent <name> --task <task_id> --stage <stage> [--unity "prep,test_editmode"] [--files "a.cs,b.cs"]
```

**Critical**: Agent process should EXIT after this call. The coordinator handles Unity pipeline results.

**Example**:
```bash
apc agent complete coord_abc123 --agent Alex --task T3 --stage implementation --unity "prep,test_editmode" --files "Assets/Scripts/ComboSystem.cs"
```

#### Show Pool
```bash
apc agent pool
```

#### List Roles
```bash
apc agent roles
```

---

### Unity Commands

#### Queue Compilation
```bash
apc unity compile --coordinator <id> --agent <name>
```

#### Queue Tests
```bash
apc unity test <editmode|playmode> --coordinator <id> --agent <name> [--filter "TestName"]
```

**Example**:
```bash
apc unity test editmode --coordinator coord_abc123 --agent Alex --filter "ComboSystemTests"
```

#### Unity Status
```bash
apc unity status
```

#### Wait for Task
```bash
apc unity wait --task <taskId> [--timeout 120]
```

#### Read Console
```bash
apc unity console [--type error|warning] [--count 10]
```

---

## Response Format

All commands return JSON:

```json
{
  "success": true|false,
  "message": "Human-readable message",
  "error": "Error description (if success=false)",
  "data": { ... }
}
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Command error |
| 2 | Connection error (extension not running) |

---

## Agent Workflow Example

A typical engineer agent workflow:

```bash
# 1. Check what task to work on
TASK=$(apc task ready coord_abc123 | jq -r '.data[0]')

# 2. Start the task
apc task start coord_abc123 T5 --agent Alex

# 3. (AI agent does implementation work)

# 4. Complete and queue Unity validation
apc agent complete coord_abc123 \
  --agent Alex \
  --task T5 \
  --stage implementation \
  --unity "prep,test_editmode" \
  --files "Assets/Scripts/MyFeature.cs,Assets/Scripts/MyFeatureTest.cs"

# 5. Agent process EXITS
# Coordinator handles Unity results and re-dispatches as needed
```

---

## Coordinator Workflow Example

```bash
# 1. Parse plan and create tasks
apc task create coord_abc123 "Create data model" --id T1 --deps None
apc task create coord_abc123 "Implement service" --id T2 --deps T1
apc task create coord_abc123 "Add UI binding" --id T3 --deps T2
apc task create coord_abc123 "Write tests" --id T4 --deps T2

# 2. Dispatch loop
while [ $(apc task progress coord_abc123 | jq '.data.percentage') != 100 ]; do
  # Get ready tasks
  READY=$(apc task ready coord_abc123)
  
  # Get available agents
  AVAILABLE=$(apc agent pool | jq '.data.available')
  
  # Dispatch tasks to agents
  for task in $READY; do
    agent=$(echo $AVAILABLE | jq -r '.[0]')
    apc task start coord_abc123 $task --agent $agent
  done
  
  # Wait for activity
  sleep 30
done
```

---

## Notes

- Session IDs format: `ps_000001`, `ps_000002`, etc.
- Coordinator IDs format: `coord_xxxxxxxx` (8-char hash)
- Agent names: Alex, Betty, Cleo, Dany, Echo, Finn, Gwen, Hugo, Iris, Jake, Kate, Liam, Mona, Noah, Olga, Pete, Quinn, Rose, Sam, Tina
- All paths are relative to workspace root unless absolute

