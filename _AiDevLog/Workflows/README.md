# Scriptable Workflow System - Feature Summary

## Overview

The scriptable workflow system now supports two powerful node types that enable replicating built-in workflow functionality:

1. **EventNode** - System API calls (predefined)
2. **ScriptNode** - Custom JavaScript code (user-defined)

## EventNode - System API Calls

EventNode now supports **system event types** that call internal APIs and return data.

### Available System Events

| Event Type | Config Required | Output Ports | Description |
|------------|----------------|--------------|-------------|
| `read_task_state` | `taskId` | `task_data` (object) | Read task metadata from StateManager |
| `request_agent_with_return` | `role` | `agent_name` (string), `success` (boolean) | Request and return agent name |
| `release_agent_call` | `agent_name` | `success` (boolean) | Release agent back to pool |
| `demote_agent_to_bench` | `agent_name` | `success` (boolean) | Move agent to bench (idle) |
| `read_plan_file` | `session_id` | `content` (string), `path` (string) | Read plan file content |
| `read_context_brief` | `session_id` | `content` (string), `path` (string) | Read context brief |

### Example: Reading Task State

```yaml
- id: read_task
  type: event
  config:
    eventType: read_task_state
    taskId: "{{parameters.task_id}}"
  outputs:
    - id: task_data
      type: object  # Contains: id, description, dependencies, status, assignedTo, metadata

# Connect to next node
connections:
  - from: { nodeId: read_task, portId: task_data }
    to: { nodeId: next_node, portId: input }
```

### Example: Managing Agents

```yaml
# Request agent
- id: get_engineer
  type: event
  config:
    eventType: request_agent_with_return
    role: engineer

# Later: Demote to bench
- id: bench_engineer
  type: event
  config:
    eventType: demote_agent_to_bench
    agent_name: "{{get_engineer.agent_name}}"

# Finally: Release
- id: release_engineer
  type: event
  config:
    eventType: release_agent_call
    agent_name: "{{get_engineer.agent_name}}"
```

## ScriptNode - Custom JavaScript

Execute arbitrary JavaScript code with sandboxed access to workflow context.

### Available in Scripts

```javascript
// Input data from connected ports
inputData.somePort  // Any data passed from previous nodes

// Context API (limited, safe methods only)
context.getVariable(id)
context.setVariable(id, value)
context.getParameter(name)
context.evaluate(expression)
context.renderTemplate(template)

// Logging
log(message, 'info')  // Levels: info, warn, error, debug

// Console (aliases log)
console.log(...)
console.warn(...)
console.error(...)
console.debug(...)

// Safe built-ins
JSON.parse(), JSON.stringify()
Math.*
Date
Array.isArray(), Array.from()
Object.keys(), Object.values(), Object.entries(), Object.assign()
String, Number, Boolean

// Return value (object with output port names as keys)
return {
  result: someValue,
  success: true,
  message: "Processing complete"
};
```

### What's NOT Available (Security)

Scripts run in a sandboxed VM with no access to:
- `require()` - Cannot import modules
- `process` - Cannot access process/environment
- `fs` - Cannot read/write files directly
- `child_process` - Cannot spawn processes
- `global`, `globalThis` - Cannot access global scope
- `__dirname`, `__filename` - No file system paths

### Example: Data Validation

```yaml
- id: validate_data
  type: script
  config:
    script: |
      const data = inputData.data;
      
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid data format');
      }
      
      const errors = [];
      
      if (!data.name || data.name.length < 3) {
        errors.push('Name must be at least 3 characters');
      }
      
      if (!data.email || !data.email.includes('@')) {
        errors.push('Invalid email format');
      }
      
      const valid = errors.length === 0;
      
      log(`Validation result: ${valid ? 'PASS' : 'FAIL'}`);
      if (!valid) {
        log(`Errors: ${errors.join(', ')}`, 'warn');
      }
      
      return {
        valid: valid,
        errors: errors,
        error_count: errors.length
      };
    timeout: 2000
```

### Example: Review Result Parsing

```yaml
- id: parse_review
  type: script
  config:
    script: |
      const reviewOutput = inputData.review_output || '';
      const approved = reviewOutput.toUpperCase().includes('APPROVED');
      const iteration = context.getVariable('review_iteration') || 0;
      
      context.setVariable('review_approved', approved);
      context.setVariable('review_iteration', iteration + 1);
      
      log(`Review ${approved ? 'approved' : 'rejected'} (iteration ${iteration + 1})`);
      
      return {
        approved: approved,
        iteration: iteration + 1,
        max_reached: iteration >= 2,
        feedback: reviewOutput
      };
```

## Complete Example: Task Implementation Workflow

See `_AiDevLog/Workflows/example_task_implementation.yaml` for a full example that demonstrates:

1. **Reading task state** (EventNode with `read_task_state`)
2. **Reading plan and context** (EventNode with `read_plan_file`, `read_context_brief`)
3. **Agent orchestration** (EventNode for request/release/demote)
4. **Custom logic** (ScriptNode for parsing review results)
5. **Control flow** (If conditions, loops)
6. **Logging and debugging** (LogNode + script logs)

## Workflow Flow

```
Start
  ↓
Read Task State (event)
  ↓
Store in Variables (script)
  ↓
Read Plan & Context (events)
  ↓
Request Engineer (event)
  ↓
Implement Task (agentic_work)
  ↓
Request Reviewer (event)
  ↓
Review Implementation (agentic_work)
  ↓
Parse Review Result (script)
  ↓
Check Approval (if_condition)
  ├─ Approved → Release agents → Complete
  └─ Not Approved → Loop back to Implement (max 3 iterations)
```

## Key Advantages

### EventNode
- ✅ Access to internal system state (tasks, sessions, plans)
- ✅ Agent lifecycle management
- ✅ File reading without direct fs access
- ✅ Type-safe outputs
- ✅ No security risks (predefined operations)

### ScriptNode
- ✅ Full JavaScript expressiveness
- ✅ Complex logic and data transformations
- ✅ Access to workflow variables
- ✅ Safe sandboxing (no file/process access)
- ✅ Timeout protection
- ✅ Error handling with stack traces

## Comparison: Built-in vs Scriptable

| Capability | Built-in Workflow | Scriptable Workflow |
|------------|-------------------|---------------------|
| Agent management | ✅ Native methods | ✅ EventNode + ScriptNode |
| Task state access | ✅ Direct StateManager | ✅ EventNode (read_task_state) |
| Custom logic | ✅ TypeScript code | ✅ ScriptNode (JavaScript) |
| Review loops | ✅ While loops | ✅ If + connections |
| Unity integration | ✅ Async queue + wait | ✅ EventNode (fire-and-forget) |
| Parallel execution | ✅ Promise.all | ✅ Branch + Sync nodes |
| Hot-reload | ❌ Requires rebuild | ✅ YAML changes auto-reload |
| Visual editing | ❌ Code only | ✅ Node graph editor |

**Conclusion**: Scriptable workflows can now replicate most built-in workflow functionality while offering better maintainability and visual design.


