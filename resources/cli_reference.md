# APC CLI Reference for AI Agents

## Task Management Commands

Use these commands to manage tasks in the coordinator's TaskManager.

### Create a Task
```bash
apc task create <coordinator_id> "<description>" --id T1 --deps T2,T3 --engineer Alex
```
- `coordinator_id`: The active coordinator ID (e.g., `coord_6vt39z10`)
- `description`: Task description
- `--id`: Task ID (e.g., T1, T2)
- `--deps`: Comma-separated dependency task IDs (optional)
- `--engineer`: Assigned engineer name (optional)

### Start a Task (Spawns Engineer AI)
```bash
apc task start <coordinator_id> <task_id> --engineer Alex
```
Marks task as in_progress AND spawns an engineer AI process to work on it.

### Complete a Task
```bash
apc task complete <coordinator_id> <task_id> --files "path1.cs,path2.cs"
```
Marks task as completed. `--files` lists modified files (optional).

### Fail a Task
```bash
apc task fail <coordinator_id> <task_id> --reason "compilation error"
```

### Reset a Task (for retry)
```bash
apc task reset <coordinator_id> <task_id>
```

### List All Tasks
```bash
apc task list <coordinator_id> --status ready
```
Filter by status: `pending`, `ready`, `in_progress`, `completed`, `failed`

### Get Ready Tasks
```bash
apc task ready <coordinator_id>
```
Returns tasks with all dependencies satisfied.

### Get Progress
```bash
apc task progress <coordinator_id>
```

### Assign Task to Engineer
```bash
apc task assign <coordinator_id> <task_id> --engineer Betty
```

---

## Engineer Monitoring Commands

### List All Engineers
```bash
apc engineer list <coordinator_id>
```
Shows all engineers with their current status, task, and activity.

### Get Engineer Status
```bash
apc engineer status <coordinator_id> <engineer_name>
```
Detailed info: current task, waiting tasks, history, files modified.

### Get Engineer Log
```bash
apc engineer log <coordinator_id> <engineer_name> --lines 100
```
Read recent output from the engineer's session.

---

## Coordinator Workflow Example

### Phase 1: Setup (Create Tasks)
```bash
# Read plan, then create all tasks
apc task create coord_001 "GAOS Framework Integration" --id T1
apc task create coord_001 "Special Gem Type System" --id T2 --deps T1
apc task create coord_001 "Special Gem Combinations" --id T3 --deps T2
apc task create coord_001 "Obstacles Set A" --id T4 --deps T1
apc task create coord_001 "Obstacles Set B" --id T5 --deps T4
```

### Phase 2: Dispatch (Assign Ready Tasks)
```bash
# Check what's ready
apc task ready coord_001
# → T1 is ready (no dependencies)

# Start engineers on ready tasks
apc task start coord_001 T1 --engineer Alex
```

### Phase 3: Monitor (React to Completions)
```bash
# When you see "📢 TASK COMPLETED" notification:

# Check what's now ready
apc task ready coord_001
# → T2, T4 are now ready (T1 completed)

# Check which engineers are idle
apc engineer list coord_001

# Dispatch more work
apc task start coord_001 T2 --engineer Alex
apc task start coord_001 T4 --engineer Betty

# If engineer seems stuck, check their log
apc engineer log coord_001 Alex --lines 50
```

### Progress Check
```bash
apc task progress coord_001
# → completed: 3, inProgress: 2, ready: 1, pending: 5, total: 11
```

