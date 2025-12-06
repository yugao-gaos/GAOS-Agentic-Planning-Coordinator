# APC CLI Reference for AI Agents

## Overview

The APC (Agentic Planning Coordinator) CLI provides commands for agents to interact with the workflow system. The primary mechanism for agents to communicate results is through **CLI callbacks**.

---

## Agent Completion Callbacks (NEW - Preferred Method)

Agents should signal completion using the `apc agent complete` command. This is the **primary and preferred** method for agent-to-workflow communication.

### Signal Completion

```bash
apc agent complete \
    --session <session_id> \
    --workflow <workflow_id> \
    --stage <stage_name> \
    --result <result_type> \
    [--data '<json_payload>']
```

**Parameters:**
- `--session`: Planning session ID (e.g., `ps_000001`)
- `--workflow`: Workflow ID running the agent (provided in prompt)
- `--stage`: The stage being completed (see table below)
- `--result`: Result type (see table below)
- `--data`: JSON payload with structured data (optional)

### Stages and Results

| Stage | Valid Results | Payload Fields |
|-------|---------------|----------------|
| `implementation` | `success`, `failed` | `files`, `message`, `error` |
| `review` | `approved`, `changes_requested` | `feedback`, `files` |
| `analysis` | `pass`, `critical`, `minor` | `issues`, `suggestions` |
| `error_analysis` | `complete` | `rootCause`, `affectedFiles`, `suggestedFix`, `relatedTask` |
| `context` | `success`, `failed` | `briefPath`, `message` |
| `delta_context` | `success`, `failed` | `message` |
| `finalize` | `success`, `failed` | `message` |

### Examples

**Implementation Success:**
```bash
apc agent complete \
    --session ps_000001 \
    --workflow wf_abc123 \
    --stage implementation \
    --result success \
    --data '{"files":["Assets/Scripts/Player.cs","Assets/Scripts/Enemy.cs"]}'
```

**Review Approved:**
```bash
apc agent complete \
    --session ps_000001 \
    --workflow wf_abc123 \
    --stage review \
    --result approved
```

**Review with Changes Requested:**
```bash
apc agent complete \
    --session ps_000001 \
    --workflow wf_abc123 \
    --stage review \
    --result changes_requested \
    --data '{"feedback":"Missing null checks in ProcessInput method","files":["Assets/Scripts/InputHandler.cs"]}'
```

**Analysis with Critical Issues:**
```bash
apc agent complete \
    --session ps_000001 \
    --workflow wf_abc123 \
    --stage analysis \
    --result critical \
    --data '{"issues":["Plan misses authentication requirement","No error handling strategy"]}'
```

**Error Analysis:**
```bash
apc agent complete \
    --session ps_000001 \
    --workflow wf_abc123 \
    --stage error_analysis \
    --result complete \
    --data '{"rootCause":"Missing using directive","affectedFiles":["Assets/Scripts/UI/MenuController.cs"],"suggestedFix":"Add using UnityEngine.UI"}'
```

### Retry on Failure

If the `apc` command fails (network error, daemon not running):
1. Wait 2 seconds
2. Retry up to 3 times
3. If still failing, output the error and exit

---

## Task Management Commands

### Get Task Progress

```bash
apc task progress --session <session_id>
```

Returns task progress and list of tasks for a session.

### Get Task Status

```bash
apc task status --session <session_id> --task <task_id>
```

Returns detailed status of a specific task.

### Mark Task Failed

```bash
apc task fail --session <session_id> --task <task_id> --reason "error message"
```

Marks a task as failed with a reason.

---

## Agent Management Commands

### Show Agent Pool

```bash
apc agent pool
```

Show available agents not assigned to any coordinator.

### List Available Roles

```bash
apc agent roles
```

List all available agent roles (engineer, reviewer, context, custom roles).

### Release Agent

```bash
apc agent release <agent_name>
```

Release an agent back to the pool.

---

## Session & Workflow Commands

### List Sessions

```bash
apc session list
```

List all planning sessions with workflow information.

### Get Session Status

```bash
apc session status --id <session_id>
```

Get detailed session status including active workflows.

### Pause Session

```bash
apc session pause --id <session_id>
```

Pause all workflows in a session.

### Resume Session

```bash
apc session resume --id <session_id>
```

Resume a paused session.

---

## Execution Commands

### Start Execution

```bash
apc exec start --session <session_id>
```

Start executing tasks for a session (dispatches task workflows).

### Pause Execution

```bash
apc exec pause --session <session_id>
```

Pause all execution workflows.

### Resume Execution

```bash
apc exec resume --session <session_id>
```

Resume paused execution.

### Stop Execution

```bash
apc exec stop --session <session_id>
```

Stop all execution workflows.

### Get Execution Status

```bash
apc exec status --session <session_id>
```

Get execution status including task progress.

---

## Unity Commands

### Queue Compilation

```bash
apc unity compile --coordinator <id> --agent <name>
```

### Queue Tests

```bash
apc unity test <editmode|playmode> --coordinator <id> --agent <name> [--filter "TestName"]
```

### Get Unity Status

```bash
apc unity status
```

### Wait for Unity Task

```bash
apc unity wait --task <taskId> [--timeout 120]
```

### Read Console

```bash
apc unity console [--type error|warning] [--count 10]
```

---

## Plan Management Commands

### List Plans

```bash
apc plan list
```

### Start Planning

```bash
apc plan start --prompt "<requirement>" [--docs <paths>]
```

### Get Plan Status

```bash
apc plan status --id <session_id>
```

### Revise Plan

```bash
apc plan revise --id <session_id> --feedback "<feedback>"
```

### Approve Plan

```bash
apc plan approve --id <session_id>
```

### Cancel Plan

```bash
apc plan cancel --id <session_id>
```

---

## Workflow Commands

### Dispatch Workflow

```bash
apc workflow dispatch <sessionId> <type> [--input JSON]
```

Types: `planning_new`, `planning_revision`, `task_implementation`, `error_resolution`, `context_gathering`

**Context Gathering Example:**
```bash
apc workflow dispatch ps_000001 context_gathering --input '{
  "targets": ["Assets/Scripts/Combat", "Assets/Prefabs/Enemies"],
  "depth": "shallow",
  "focusAreas": ["enemy AI patterns", "combat system"],
  "taskId": "T5"
}'
```

**Input Parameters by Workflow Type:**

- `context_gathering`:
  - `targets` (string[]): Folders/files to analyze
  - `depth` (string): 'shallow' (quick scan) or 'deep' (thorough)
  - `focusAreas` (string[]): Optional specific areas to focus on
  - `taskId` (string): Optional task ID to associate context with
  - `outputName` (string): Optional output filename (defaults to 'context')
  - `preset` (string): Optional preset to use (skips auto-detection)

- `task_implementation`:
  - `taskId` (string): Task ID from plan
  - `taskDescription` (string): Task description
  - `dependencies` (string[]): Dependency task IDs
  - `planPath` (string): Path to plan file

- `error_resolution`:
  - `errors` (object[]): Array of error objects with id, message, file, line
  - `coordinatorId` (string): Coordinator ID requesting fix
  - `sourceWorkflowId` (string): Optional source workflow ID

### Get Workflow Status

```bash
apc workflow status --session <id> --id <workflowId>
```

### Cancel Workflow

```bash
apc workflow cancel --session <id> --id <workflowId>
```

### List Workflows

```bash
apc workflow list --session <id>
```

---

## Available Roles

| Role | Description | Default Model |
|------|-------------|---------------|
| `engineer` | Executes implementation tasks | sonnet-4.5 |
| `code_reviewer` | Reviews code before build/test | opus-4.5 |
| `context_gatherer` | Gathers project context | gemini-3-pro |
| `delta_context` | Updates context after task approval | gemini-3-pro |
| `error_analyst` | Analyzes compilation/test errors | sonnet-4.5 |
| `analyst_codex` | Reviews plans for implementation | gpt-5.1-codex-high |
| `analyst_gemini` | Reviews plans for testing | gemini-3-pro |
| `analyst_architecture` | Reviews plans for architecture | sonnet-4.5 |
| `planner` | Creates and updates execution plans | opus-4.5 |

Use `apc agent roles` to see all available roles including custom ones.

---

## CLI Callback vs Output Parsing

The workflow system supports two modes of agent communication:

### CLI Callbacks (Preferred)

- Agent explicitly calls `apc agent complete` with structured data
- Workflow receives data immediately via signal mechanism
- More reliable, less fragile
- **This is the recommended approach**

### Output Parsing (Legacy Fallback)

- Workflow parses agent's text output for patterns
- Used when agent exits without calling CLI callback
- More fragile, can fail if agent output format varies
- Kept for backward compatibility

Agents should always use CLI callbacks when possible. The workflow system will automatically inject CLI callback instructions into agent prompts.
