# Configuration

APC uses a layered configuration system with daemon configuration files, VS Code settings, and runtime options.

## Configuration Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                    Configuration Hierarchy                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Priority (highest to lowest):                                   │
│                                                                  │
│  1. Runtime Options (CLI flags, API params)                     │
│  2. Daemon Config (_AiDevLog/.config/daemon.json)               │
│  3. VS Code Settings (settings.json) [DEPRECATED]               │
│  4. Default Values (hardcoded)                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Daemon Configuration

### Location

```
_AiDevLog/.config/daemon.json
```

### Full Configuration

```json
{
  "port": 19840,
  "workingDirectory": "_AiDevLog",
  "logLevel": "info",
  "autoOpenTerminals": true,
  "defaultBackend": "cursor",
  "agentPoolSize": 10,
  "agentNames": ["Alex", "Betty", "Cleo", "Dany", "Echo", 
                 "Finn", "Gwen", "Hugo", "Iris", "Jake"],
  "roles": {
    "engineer": {
      "name": "Engineer",
      "description": "General-purpose implementation agent",
      "systemPrompt": "You are an expert software engineer..."
    },
    "planner": {
      "name": "Planner",
      "description": "Creates execution plans",
      "systemPrompt": "You are an expert project planner..."
    },
    "analyst": {
      "name": "Analyst",
      "description": "Reviews and critiques plans",
      "systemPrompt": "You are a critical analyst..."
    }
  },
  "workflows": {
    "planning_new": {
      "maxIterations": 3,
      "timeout": 300000
    },
    "task_implementation": {
      "timeout": 180000,
      "retryAttempts": 3
    }
  },
  "unity": {
    "enabled": true,
    "compileTimeout": 60000,
    "testTimeout": 300000
  }
}
```

### Configuration Options

#### Core Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | 19840 | WebSocket server port |
| `workingDirectory` | string | "_AiDevLog" | Working directory name |
| `logLevel` | string | "info" | Logging level (debug, info, warn, error) |

#### Agent Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoOpenTerminals` | boolean | true | Auto-open terminals for agents |
| `defaultBackend` | string | "cursor" | AI backend (cursor) |
| `agentPoolSize` | number | 10 | Number of agents in pool |
| `agentNames` | string[] | [...] | Agent name list |

#### Workflow Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workflows.planning_new.maxIterations` | number | 3 | Max planning iterations |
| `workflows.planning_new.timeout` | number | 300000 | Planning timeout (ms) |
| `workflows.task_implementation.timeout` | number | 180000 | Task timeout (ms) |
| `workflows.task_implementation.retryAttempts` | number | 3 | Retry attempts |

#### Unity Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `unity.enabled` | boolean | true | Enable Unity features |
| `unity.compileTimeout` | number | 60000 | Compile timeout (ms) |
| `unity.testTimeout` | number | 300000 | Test timeout (ms) |

## ConfigLoader

### Loading Configuration

```typescript
class ConfigLoader {
    constructor(workspaceRoot: string);
    
    // Get current configuration
    getConfig(): CoreConfig;
    
    // Reload from file
    reload(): CoreConfig;
    
    // Update and save
    update(changes: Partial<CoreConfig>): CoreConfig;
    
    // Get specific section
    get<T>(key: string, defaultValue: T): T;
}
```

### Usage

```typescript
const loader = new ConfigLoader(workspaceRoot);
const config = loader.getConfig();

// Update configuration
loader.update({
    logLevel: 'debug',
    agentPoolSize: 15
});
```

## VS Code Settings (Deprecated)

These settings are deprecated in favor of daemon.json:

```json
{
  "agenticPlanning.workingDirectory": "_AiDevLog",
  "agenticPlanning.defaultBackend": "cursor",
  "agenticPlanning.autoOpenTerminals": true
}
```

### Migration

Settings are automatically migrated to daemon.json on first run.

## Agent Roles

### Role Configuration

```typescript
interface AgentRole {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    capabilities?: string[];
    maxConcurrent?: number;
}
```

### Default Roles

```json
{
  "engineer": {
    "name": "Engineer",
    "description": "General-purpose implementation agent",
    "systemPrompt": "You are an expert software engineer specializing in Unity game development...",
    "capabilities": ["code", "test", "debug", "refactor"]
  },
  "planner": {
    "name": "Planner", 
    "description": "Creates and refines execution plans",
    "systemPrompt": "You are an expert project planner...",
    "capabilities": ["planning", "analysis", "decomposition"]
  },
  "analyst": {
    "name": "Analyst",
    "description": "Reviews plans and provides critical feedback",
    "systemPrompt": "You are a critical analyst who reviews plans...",
    "capabilities": ["review", "critique", "risk-assessment"]
  }
}
```

### Custom Roles

Add custom roles via Settings panel or daemon.json:

```json
{
  "roles": {
    "tester": {
      "name": "Tester",
      "description": "Specialized in writing and running tests",
      "systemPrompt": "You are an expert QA engineer...",
      "capabilities": ["testing", "quality"]
    }
  }
}
```

## Workflow Configuration

### Per-Workflow Settings

```typescript
interface WorkflowConfig {
    timeout: number;           // Overall timeout (ms)
    retryAttempts: number;     // Max retry attempts
    retryDelay: number;        // Delay between retries (ms)
    maxAgents?: number;        // Max concurrent agents
}
```

### Workflow Metadata

```typescript
interface WorkflowMetadata {
    name: string;
    description: string;
    coordinatorPrompt?: string;  // Prompt for coordinator
    phases: string[];
}
```

### Configuration Example

```json
{
  "workflows": {
    "planning_new": {
      "timeout": 300000,
      "maxIterations": 3,
      "analysts": ["architect", "security", "performance"]
    },
    "task_implementation": {
      "timeout": 180000,
      "retryAttempts": 3,
      "retryDelay": 5000,
      "verifyWithUnity": true
    },
    "error_resolution": {
      "timeout": 120000,
      "retryAttempts": 2
    }
  }
}
```

## Context Gathering Presets

### Preset Configuration

```typescript
interface ContextGatheringPresetConfig {
    extensions: string[];
    prompt: string;
    focusAreas: string[];
    maxFiles?: number;
    maxFileSize?: number;
}
```

### Default Presets

```json
{
  "contextPresets": {
    "unity_scripts": {
      "extensions": [".cs"],
      "prompt": "Analyze C# scripts for Unity patterns...",
      "focusAreas": ["MonoBehaviour", "Events", "State"]
    },
    "docs": {
      "extensions": [".md", ".txt"],
      "prompt": "Extract key information from documentation...",
      "focusAreas": ["Requirements", "Architecture", "API"]
    }
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `APC_WORKSPACE` | Override workspace root | cwd |
| `APC_PORT` | Override daemon port | 19840 |
| `APC_VERBOSE` | Enable verbose logging | false |
| `APC_LOG_LEVEL` | Override log level | info |
| `APC_CONFIG_PATH` | Custom config file path | auto |

## Settings Panel

### Access

```
Cmd/Ctrl+Shift+P → "APC: Daemon Settings"
```

Or click the Settings icon in the sidebar.

### Sections

1. **General**
   - Working directory
   - Log level
   - Auto-open terminals

2. **Agent Pool**
   - Pool size
   - Agent names
   - Default backend

3. **Roles**
   - View/edit roles
   - System prompts
   - Capabilities

4. **Workflows**
   - Timeouts
   - Retry settings
   - Per-workflow config

5. **Unity**
   - Enable/disable
   - Timeouts
   - Project path

## Configuration API

### Get Configuration

```typescript
// Via client
const config = await client.getConfig();

// Via CLI
apc config get

// Specific key
apc config get agentPoolSize
```

### Update Configuration

```typescript
// Via client
await client.updateConfig({
    agentPoolSize: 15,
    logLevel: 'debug'
});

// Via CLI
apc config set agentPoolSize 15
```

### Reset to Defaults

```bash
apc config reset
```

## Configuration Validation

### Schema Validation

```typescript
interface ConfigValidation {
    validate(config: unknown): ValidationResult;
}

interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationWarning[];
}
```

### Validation Rules

1. **Port**: 1024-65535
2. **Log Level**: debug | info | warn | error
3. **Pool Size**: 1-20
4. **Timeouts**: > 0
5. **Agent Names**: Unique, non-empty

## Migration

### From VS Code Settings

```typescript
async function migrateSettings(): Promise<void> {
    const vscodeConfig = vscode.workspace.getConfiguration('agenticPlanning');
    const daemonConfig = loader.getConfig();
    
    // Migrate each deprecated setting
    if (vscodeConfig.has('workingDirectory')) {
        daemonConfig.workingDirectory = vscodeConfig.get('workingDirectory');
    }
    
    // Save to daemon.json
    loader.update(daemonConfig);
    
    // Mark as migrated
    await vscodeConfig.update('_migrated', true, true);
}
```

### Version Upgrades

Configuration is auto-upgraded when needed:

```typescript
function upgradeConfig(config: any, fromVersion: string): CoreConfig {
    if (semver.lt(fromVersion, '0.5.0')) {
        // Add new fields with defaults
        config.unity = config.unity || { enabled: true };
    }
    
    return config as CoreConfig;
}
```

## Best Practices

### Development

1. Use `debug` log level during development
2. Keep pool size small for testing
3. Use shorter timeouts for faster iteration

### Production

1. Use `info` or `warn` log level
2. Configure appropriate pool size for team
3. Set reasonable timeouts

### Sharing Configuration

```bash
# Export config
apc config export > apc-config.json

# Import config
apc config import < apc-config.json
```

