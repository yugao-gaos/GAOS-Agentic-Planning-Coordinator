# Context Gathering Workflow Guide

## Overview

The `context_gathering` workflow helps gather and analyze context from folders/files before or during task execution. This workflow can be associated with specific tasks to build targeted context summaries.

## When to Use Context Gathering

### 1. **Parallel with Planning**
Run context gathering when building plans to get a general understanding of the project structure.

```bash
apc workflow dispatch ps_000001 context_gathering --input '{
  "targets": ["Assets/Scripts", "Assets/Prefabs"],
  "depth": "shallow",
  "focusAreas": ["architecture overview", "main systems"]
}'
```

### 2. **Before Starting Unfamiliar Tasks**
Gather context before implementing tasks that work with unfamiliar code areas.

```bash
apc workflow dispatch ps_000001 context_gathering --input '{
  "targets": ["Assets/Scripts/Combat", "Assets/Scripts/AI"],
  "depth": "deep",
  "focusAreas": ["enemy AI patterns", "combat state machine"],
  "taskId": "ps_000001_T3"
}'
```

### 3. **After Repeated Errors**
When a task fails multiple times, gather context to understand the problem area better.

```bash
apc workflow dispatch ps_000001 context_gathering --input '{
  "targets": ["Assets/Scripts/UI/MenuSystem.cs", "Assets/Scripts/UI/DialogManager.cs"],
  "depth": "deep",
  "focusAreas": ["UI event handling", "state management"],
  "taskId": "ps_000001_T7"
}'
```

### 4. **Before Asset-Heavy Tasks**
If you foresee tasks that need to build assets (prefabs, scenes, GUIs), run context gathering before the implementation workflow to understand:
- What assets are available
- How to choose them based on requirements
- Existing patterns and naming conventions

```bash
apc workflow dispatch ps_000001 context_gathering --input '{
  "targets": ["Assets/Prefabs/UI", "Assets/Scenes", "Assets/Resources/UI"],
  "depth": "shallow",
  "focusAreas": ["available UI prefabs", "menu structure", "dialog system"],
  "taskId": "ps_000001_T12"
}'
```

## Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `targets` | string[] | Yes | Folders/files to analyze |
| `depth` | string | No | 'shallow' (quick scan, default) or 'deep' (thorough) |
| `focusAreas` | string[] | No | Specific areas to focus on |
| `taskId` | string | No | Task ID to associate context with |
| `outputName` | string | No | Output filename (defaults to 'context' or auto-generated) |
| `preset` | string | No | Manual preset to use (skips auto-detection) |

## Task Association

When you provide a `taskId`, the context gathering workflow will:

1. **Name the output file** using the pattern `task_{taskId}_context.md`
2. **Include task metadata** in the context file header
3. **Link the context** to the specific task for future reference

Example output filename: `_AiDevLog/Context/task_ps_000001_T5_context.md`

## Coordinator Integration Example

Here's how the coordinator agent can use context gathering:

```bash
# Step 1: Check which tasks are ready
apc task list

# Step 2: Identify a task that needs asset knowledge (e.g., ps_000001_T5: "Create enemy spawn UI")
# Step 3: Gather context about available UI assets
apc workflow dispatch ps_000001 context_gathering --input '{
  "targets": ["Assets/Prefabs/UI", "Assets/Scripts/UI"],
  "depth": "shallow",
  "focusAreas": ["UI prefabs", "spawn system", "existing enemy UI"],
  "taskId": "ps_000001_T5"
}'

# Step 4: Wait for context gathering to complete (check workflow status)
# Step 5: Create the implementation task - engineer can now read the task-specific context
apc task create --session ps_000001 --id ps_000001_T5 --desc "Create enemy spawn UI" --type implementation
```

## Output Location

Context summaries are written to `_AiDevLog/Context/`:
- General context: `context.md` or `{target}_context.md`
- Task-specific: `task_{taskId}_context.md`

## Depth Levels

### Shallow (Recommended for Most Cases)
- Quick scan focusing on high-level patterns
- Good for understanding project structure
- Use before planning or for general overview
- Faster execution (saves agent time and costs)

### Deep
- Comprehensive analysis with detailed examples
- Good for complex problem areas
- Use after errors or for critical implementation tasks
- Slower but more thorough

## Best Practices

1. **Run in parallel with planning** to build initial project understanding
2. **Use shallow depth by default** - only go deep when necessary
3. **Associate with tasks** using `taskId` for task-specific context
4. **Be specific with focusAreas** - helps the gatherer focus on relevant information
5. **Gather asset context before asset-heavy tasks** - helps engineers choose the right assets

## Example Coordinator Decision Flow

```
1. Coordinator triggered (task completed or agent available)
2. Check task list - find ps_000001_T5: "Create gem collection UI"
3. Notice ps_000001_T5 involves UI prefabs (asset-heavy task)
4. Decision: Dispatch context_gathering FIRST
   - targets: ["Assets/Prefabs/UI/Gems", "Assets/Scripts/UI"]
   - depth: "shallow"
   - focusAreas: ["gem UI patterns", "collection displays"]
   - taskId: "ps_000001_T5"
5. Wait for context gathering to complete
6. Then dispatch task_implementation for ps_000001_T5
   - Engineer can now read _AiDevLog/Context/task_ps_000001_T5_context.md
   - Engineer knows what gem UI prefabs are available
   - Engineer can follow existing patterns
```

This approach maximizes success rate by ensuring engineers have the right context before starting work.

