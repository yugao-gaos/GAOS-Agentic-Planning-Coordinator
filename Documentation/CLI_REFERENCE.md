# CLI Reference

The APC CLI (`apc` command) provides command-line access to all APC functionality, designed for AI agent interaction.

## Installation

### Via VS Code Extension

```bash
# Install from extension
Cmd/Ctrl+Shift+P → "Agentic: Install CLI (apc command)"
```

### Manual Installation

The CLI is installed to `~/.local/bin/apc` (Unix) or added to PATH (Windows).

## Command Structure

```
apc <category> <action> [options]
```

### Categories

| Category | Description |
|----------|-------------|
| `system` | Daemon management |
| `plan` | Planning operations |
| `exec` | Execution control |
| `pool` | Agent pool management |
| `task` | Task operations |
| `unity` | Unity integration |

## Daemon Commands

### Start Daemon

```bash
# Start daemon in headless mode (background)
apc daemon run --headless

# Start with verbose logging
apc daemon run --headless --verbose

# Start on specific port
apc daemon run --headless --port 19841
```

### Check Status

```bash
# Get daemon status
apc daemon status

# Output:
# Daemon: running (port 19840)
# Uptime: 2h 15m
# Clients: 1
# Ready: true
```

### Stop Daemon

```bash
# Graceful shutdown
apc daemon stop
```

## Planning Commands

### Create New Plan

```bash
# Start planning with requirement
apc plan new "Implement a combo system for the fighting game"

# With reference documents
apc plan new "Implement combo system" --docs docs/combat.md docs/input.md

# Output:
# Created session: ps_abc123
# Status: planning
# Estimated time: ~200 seconds
```

### Check Plan Status

```bash
# Get planning status
apc plan status ps_abc123

# Output:
# Session: ps_abc123
# Status: ready_for_review
# Plan: _AiDevLog/Plans/ps_abc123/plan.md
# Tasks: 5
# Recommended agents: 3
```

### Approve Plan

```bash
# Approve and auto-start execution
apc plan approve ps_abc123

# Approve without auto-start
apc plan approve ps_abc123 --no-execute
```

### Revise Plan

```bash
# Revise with feedback
apc plan revise ps_abc123 "Add unit tests for each task"

# Output:
# Revision started for ps_abc123
# Estimated time: ~80 seconds
```

### Cancel Planning

```bash
# Cancel ongoing planning
apc plan cancel ps_abc123
```

### List Sessions

```bash
# List all planning sessions
apc plan list

# Output:
# ID          Status          Requirement
# ps_abc123   executing       Implement combo system
# ps_def456   ready_for_review Add multiplayer support
```

## Execution Commands

### Start Execution

```bash
# Start execution for approved plan
apc exec start ps_abc123

# Output:
# Execution started
# Engineers: 3
# Tasks: 5
```

### Check Execution Status

```bash
# Get execution status
apc exec status ps_abc123

# Output:
# Session: ps_abc123
# Status: executing
# Progress: 2/5 tasks completed
# Active: task_003 (Echo), task_004 (Finn)
# Failed: 0
```

### Pause Execution

```bash
# Pause all workflows
apc exec pause ps_abc123
```

### Resume Execution

```bash
# Resume paused execution
apc exec resume ps_abc123
```

### Stop Execution

```bash
# Stop and release all agents
apc exec stop ps_abc123
```

## Pool Commands

### Pool Status

```bash
# Get agent pool status
apc pool status

# Output:
# Total: 10
# Available: 5 (Alex, Betty, Cleo, Dany, Echo)
# Allocated: 2 (Finn, Gwen)
# Busy: 3 (Hugo, Iris, Jake)
# Resting: 0
```

### Resize Pool

```bash
# Change pool size
apc pool resize 15

# Output:
# Pool resized: 10 → 15
# Added: Kate, Liam, Mona, Noah, Olga
```

### Release Agent

```bash
# Release specific agent
apc pool release Hugo

# Output:
# Hugo released → resting (5s cooldown)
```

## Task Commands

### List Tasks

```bash
# List tasks for session
apc task list ps_abc123

# Output:
# ID          Status      Description
# task_001    completed   Create ComboManager
# task_002    in_progress Implement input buffer
# task_003    pending     Add combo effects
```

### Retry Task

```bash
# Retry failed task
apc task retry ps_abc123 task_002

# Output:
# Retry started for task_002
# Workflow: wf_xyz789
```

### Task Details

```bash
# Get task details
apc task info ps_abc123 task_002

# Output:
# Task: task_002
# Description: Implement input buffer
# Status: failed
# Attempts: 2
# Last error: Compilation failed
# Dependencies: task_001 (completed)
```

## Unity Commands

### Unity Status

```bash
# Get Unity project status
apc unity status

# Output:
# Unity: detected
# Project: /path/to/unity/project
# Compile: passing
# Tests: 15/15 passing
```

### Trigger Compile

```bash
# Trigger Unity compilation
apc unity compile

# Output:
# Compilation started...
# Result: success
# Warnings: 3
# Errors: 0
```

### Run Tests

```bash
# Run Unity playmode tests
apc unity test

# With filter
apc unity test --filter "ComboTests"

# Output:
# Running tests...
# Passed: 15
# Failed: 0
# Time: 45s
```

### Unity Pipeline

```bash
# Run full pipeline (compile + tests)
apc unity pipeline

# Output:
# Step 1/2: Compilation... success
# Step 2/2: Tests... success
# Pipeline complete
```

## Global Options

| Option | Description |
|--------|-------------|
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |
| `--verbose` | Enable verbose output |
| `--json` | Output as JSON |
| `--workspace <path>` | Specify workspace root |

## Output Formats

### Standard Output

```bash
apc plan status ps_abc123
# Human-readable output
```

### JSON Output

```bash
apc plan status ps_abc123 --json
# {
#   "sessionId": "ps_abc123",
#   "status": "ready_for_review",
#   "planPath": "_AiDevLog/Plans/ps_abc123/plan.md",
#   ...
# }
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Daemon not running |
| 4 | Session not found |
| 5 | Operation failed |

## Typical Workflows

### New Feature Development

```bash
# 1. Start planning
apc plan new "Add multiplayer support"

# 2. Wait for planning (~200 seconds)
sleep 200

# 3. Check status
apc plan status ps_xxx

# 4. Review plan (read the markdown file)
cat _AiDevLog/Plans/ps_xxx/plan.md

# 5. Approve and execute
apc plan approve ps_xxx

# 6. Monitor progress
watch -n 30 'apc exec status ps_xxx'
```

### Handling Failures

```bash
# Check execution status
apc exec status ps_abc123

# If task failed, get details
apc task info ps_abc123 task_002

# Option 1: Retry task
apc task retry ps_abc123 task_002

# Option 2: Revise plan
apc plan revise ps_abc123 "Task 2 needs clearer requirements"
```

### Unity Integration

```bash
# Before execution
apc unity compile

# During development
apc unity pipeline

# After implementation
apc unity test --filter "NewFeatureTests"
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `APC_WORKSPACE` | Workspace root | Current directory |
| `APC_PORT` | Daemon port | 19840 |
| `APC_VERBOSE` | Enable verbose | false |
| `APC_JSON` | JSON output | false |

## Scripting Examples

### Bash: Wait for Planning

```bash
#!/bin/bash
SESSION_ID=$(apc plan new "My requirement" --json | jq -r '.sessionId')

while true; do
    STATUS=$(apc plan status $SESSION_ID --json | jq -r '.status')
    if [[ "$STATUS" == "ready_for_review" ]]; then
        echo "Planning complete!"
        break
    elif [[ "$STATUS" == "failed" ]]; then
        echo "Planning failed!"
        exit 1
    fi
    sleep 30
done
```

### PowerShell: Monitor Execution

```powershell
$sessionId = "ps_abc123"

while ($true) {
    $status = apc exec status $sessionId --json | ConvertFrom-Json
    
    Write-Host "Progress: $($status.completed)/$($status.total) tasks"
    
    if ($status.status -eq "completed") {
        Write-Host "Execution complete!"
        break
    }
    
    Start-Sleep -Seconds 30
}
```

## Troubleshooting

### Daemon Not Running

```bash
# Check if daemon is running
apc daemon status

# If not running, start it
apc daemon run --headless
```

### Connection Failed

```bash
# Check port file
cat _AiDevLog/.daemon_port

# Try connecting to specific port
apc daemon status --port 19840
```

### Session Not Found

```bash
# List all sessions
apc plan list

# Check if session exists in files
ls _AiDevLog/Plans/
```

