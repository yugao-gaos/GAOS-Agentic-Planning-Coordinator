# Unity Integration

APC includes built-in support for Unity game development workflows, including compilation checks, playmode tests, and Unity-aware context gathering.

## MCP for Unity (Recommended)

For AI agents to interact directly with Unity Editor, we recommend **[MCP for Unity by CoplayDev](https://github.com/CoplayDev/unity-mcp)**.

### Features

- Direct Unity Editor control via AI agents
- HTTP transport (default) for reliable communication
- Auto-setup for Cursor, Claude Desktop, and other MCP clients
- Multiple Unity instance support

### Quick Setup (3 Installation Options)

#### Option 1: Auto-Configure (Recommended)
The easiest way to set up MCP for Unity integration with Cursor:

1. **Open System Settings**
   - Go to APC System Settings (Unity tab)
   
2. **Click "Auto-Configure"**
   - Automatically configures `~/.cursor/mcp.json` with proper settings
   
3. **Install Unity Package** (Manual step)
   - Click "Install to Unity" button, or
   - In Unity: Window → Package Manager → + → Add package from git URL:
     ```
     https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity
     ```

4. **Start MCP Server in Unity**
   ```
   Window → MCP for Unity → Start Local HTTP Server
   ```

5. **Restart Cursor**

#### Option 2: Install to Unity (One-Click Package Installation)
Automatically adds the MCP package to your Unity project's `manifest.json`:

1. **Open System Settings** → Unity tab
2. **Click "Install to Unity"**
   - Automatically adds package to `Packages/manifest.json`
   - Unity will import the package automatically
   
3. **Start MCP Server in Unity**
   ```
   Window → MCP for Unity → Start Local HTTP Server
   ```

4. **Configure Cursor**
   - Click "Auto-Configure" to setup Cursor's MCP config
   - Or manually add to `~/.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "UnityMCP": {
         "url": "http://localhost:8080/mcp"
       }
     }
   }
   ```

5. **Restart Cursor**

#### Option 3: Install to Backend CLI
For advanced users who prefer CLI installation:

1. **Install Unity Package** (see Option 2)

2. **Start HTTP Server in Unity**
   ```
   Window → MCP for Unity → Start Local HTTP Server
   ```

3. **Configure via CLI**
   ```bash
   cursor mcp add unity-mcp --url http://localhost:8080/mcp
   ```
   
   Or manually edit `~/.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "UnityMCP": {
         "url": "http://localhost:8080/mcp"
       }
     }
   }
   ```

4. **Restart Cursor**

### Manual Installation (Alternative)

1. **Install Unity Package**
   ```
   In Unity: Window → Package Manager → + → Add package from git URL:
   https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity
   ```

2. **Start MCP Server**
   ```
   In Unity: Window → MCP for Unity → Start Local HTTP Server
   ```

3. **Configure Cursor**
   Add to `~/.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "UnityMCP": {
         "url": "http://localhost:8080/mcp"
       }
     }
   }
   ```

4. **Restart Cursor**

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Unity Integration                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  UnityControlManager                        │ │
│  │  • Project detection                                        │ │
│  │  • Compilation triggering                                   │ │
│  │  • Playmode test execution                                  │ │
│  │  • Status monitoring                                        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│              ┌───────────────┼───────────────┐                   │
│              ▼               ▼               ▼                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │
│  │  Compile       │  │  Test Runner   │  │  Error         │    │
│  │  Pipeline      │  │                │  │  Tracking      │    │
│  └────────────────┘  └────────────────┘  └────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Source Files

| File | Description |
|------|-------------|
| `src/services/UnityControlManager.ts` | Main Unity control service |
| `src/types/unity.ts` | Unity type definitions |
| `scripts/run_playmode_test.py` | Python script for test execution |
| `resources/UnityBestPractices.md` | Unity development guide |

## Enabling Unity Features

### Configuration

Unity features are enabled by default. To disable:

```json
// In VS Code settings
{
    "agenticPlanning.enableUnityFeatures": false
}
```

### Project Detection

APC automatically detects Unity projects by looking for:

```
<workspace>/
├── Assets/
├── ProjectSettings/
│   └── ProjectSettings.asset
├── Packages/
│   └── manifest.json
└── *.sln
```

## Unity Status

### Status Interface

```typescript
interface UnityStatus {
    detected: boolean;
    projectPath?: string;
    compileStatus: 'unknown' | 'passing' | 'failing' | 'compiling';
    testStatus: 'unknown' | 'passing' | 'failing' | 'running';
    lastCompileTime?: string;
    lastTestTime?: string;
    errors: UnityError[];
    warnings: number;
}
```

### Get Status

```typescript
// Via daemon API
const status = await client.getUnityStatus();

// Via CLI
apc unity status
```

## Compilation

### Trigger Compilation

```typescript
interface CompileOptions {
    forceRefresh?: boolean;  // Force reimport all assets
    buildTarget?: string;    // e.g., 'StandaloneWindows64'
}

const result = await client.triggerUnityCompile(options);
```

### Compilation Result

```typescript
interface CompileResult {
    success: boolean;
    errors: UnityError[];
    warnings: UnityWarning[];
    duration: number;
}
```

### Unity Errors

```typescript
interface UnityError {
    id: string;
    type: 'compile' | 'runtime' | 'test';
    message: string;
    file?: string;
    line?: number;
    column?: number;
    code?: string;  // e.g., 'CS0103'
    timestamp: string;
}
```

## Playmode Tests

### Running Tests

```typescript
interface TestOptions {
    filter?: string;          // Test name filter
    category?: string;        // Test category
    timeout?: number;         // Timeout in seconds
    runInBackground?: boolean;
}

const result = await client.runUnityTests(options);
```

### Test Result

```typescript
interface TestResult {
    success: boolean;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
    results: TestCaseResult[];
}

interface TestCaseResult {
    name: string;
    className: string;
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    message?: string;
    stackTrace?: string;
}
```

### Python Test Runner

The `run_playmode_test.py` script provides test execution:

```bash
python scripts/run_playmode_test.py \
    --project /path/to/unity/project \
    --filter "ComboTests" \
    --timeout 300
```

## Unity Pipeline

### Full Pipeline

Combines compilation and testing:

```typescript
interface PipelineOptions {
    compile?: boolean;
    test?: boolean;
    filter?: string;
}

const result = await client.triggerUnityPipeline(options);
```

### Pipeline Flow

```
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│   Compile      │────►│   Check        │────►│   Run Tests    │
│   Project      │     │   Errors       │     │                │
└────────────────┘     └────────────────┘     └────────────────┘
        │                     │                       │
        │                     │ Errors?               │
        │                     ▼                       │
        │              ┌──────────────┐              │
        │              │  Pause &     │              │
        │              │  Report      │              │
        │              └──────────────┘              │
        │                                            │
        └────────────────────┬───────────────────────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  Pipeline      │
                    │  Complete      │
                    └────────────────┘
```

## Workflow Integration

### Task Verification

TaskImplementationWorkflow can verify with Unity:

```typescript
interface TaskImplementationInput {
    // ... other fields
    verifyWithUnity?: boolean;
    unityTestFilter?: string;
}
```

When enabled:
1. After task completion, trigger Unity compile
2. If errors, mark task as failed
3. Optionally run relevant tests

### Error Resolution

UnityErrorPayload triggers error handling:

```typescript
interface UnityErrorPayload {
    type: 'unity_error';
    errors: UnityError[];
    affectedTaskIds: string[];
}
```

Coordinator response:
1. Pause affected tasks
2. Start ErrorResolutionWorkflow
3. Resume when resolved

## Unity Events

| Event | Description |
|-------|-------------|
| `unity.statusChanged` | Unity status changed |
| `unity.compileStarted` | Compilation started |
| `unity.compileCompleted` | Compilation finished |
| `unity.testStarted` | Tests started |
| `unity.testCompleted` | Tests finished |
| `unity.pipelineStarted` | Pipeline started |
| `unity.pipelineCompleted` | Pipeline finished |

### Event Broadcasting

```typescript
// On compile complete
broadcaster.broadcast('unity.compileCompleted', {
    success: result.success,
    errors: result.errors.length,
    warnings: result.warnings.length,
    duration: result.duration
});
```

## CLI Commands

### Status

```bash
apc unity status
# Unity: detected
# Project: /path/to/project
# Compile: passing
# Tests: 15/15 passing
```

### Compile

```bash
apc unity compile
# Compilation started...
# Result: success (3 warnings)
```

### Test

```bash
# Run all tests
apc unity test

# With filter
apc unity test --filter "Combo*"

# Specific category
apc unity test --category "Integration"
```

### Pipeline

```bash
apc unity pipeline
# Step 1/2: Compilation... success
# Step 2/2: Tests... success
# Pipeline complete
```

## Context Gathering

### Unity-Aware Presets

Context gathering includes Unity presets:

```typescript
const UNITY_PRESETS = {
    unity_scripts: {
        extensions: ['.cs'],
        prompt: 'Analyze C# scripts for Unity patterns...',
        focusAreas: ['MonoBehaviour', 'ScriptableObject', 'Editor']
    },
    unity_prefabs: {
        extensions: ['.prefab'],
        prompt: 'Analyze prefab structure...',
        focusAreas: ['Components', 'Hierarchy', 'References']
    },
    unity_scenes: {
        extensions: ['.unity'],
        prompt: 'Analyze scene structure...',
        focusAreas: ['GameObjects', 'Lighting', 'NavMesh']
    },
    unity_shaders: {
        extensions: ['.shader', '.hlsl', '.cginc'],
        prompt: 'Analyze shader code...',
        focusAreas: ['Properties', 'Passes', 'Functions']
    }
};
```

### Auto-Detection

ContextGatheringWorkflow auto-detects Unity assets:

```typescript
// Scan directory
const files = await scanDirectory(target);

// Categorize by extension
for (const file of files) {
    const ext = path.extname(file);
    const preset = getPresetForExtension(ext);
    if (preset) {
        detectedTypes.get(preset).push(file);
    }
}
```

## Best Practices Document

`resources/UnityBestPractices.md` provides guidance for AI agents:

### Topics Covered

1. **Project Structure**
   - Folder organization
   - Assembly definitions
   - Naming conventions

2. **Code Patterns**
   - MonoBehaviour lifecycle
   - Coroutines and async
   - ScriptableObjects

3. **Testing**
   - Test structure
   - EditMode vs PlayMode
   - Test utilities

4. **Performance**
   - Object pooling
   - Update optimization
   - Memory management

## Configuration

### Unity Settings

```typescript
interface UnityConfig {
    enabled: boolean;
    projectPath?: string;  // Override auto-detection
    compileTimeout: number;
    testTimeout: number;
    pythonPath?: string;   // For test runner
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `UNITY_PROJECT_PATH` | Override Unity project path |
| `UNITY_TEST_FILTER` | Default test filter |
| `UNITY_PYTHON_PATH` | Python executable path |

## Error Handling

### Compilation Errors

```typescript
// Error structure
interface UnityCompileError {
    code: string;      // CS0103, CS0246, etc.
    message: string;
    file: string;
    line: number;
    column: number;
}

// Handling
if (compileResult.errors.length > 0) {
    // Pause affected workflows
    await coordinator.pauseAffectedTasks(compileResult.errors);
    
    // Trigger error resolution
    await coordinator.startWorkflow('error_resolution', {
        input: {
            errorType: 'unity_compile',
            errors: compileResult.errors
        }
    });
}
```

### Test Failures

```typescript
// Failure structure
interface TestFailure {
    testName: string;
    message: string;
    stackTrace: string;
    expected?: string;
    actual?: string;
}

// Handling
if (testResult.failed > 0) {
    // Log failures
    for (const failure of testResult.results.filter(r => r.status === 'failed')) {
        log.error(`Test failed: ${failure.name}`);
        log.error(failure.stackTrace);
    }
    
    // Optionally retry or escalate
}
```

## Sidebar Integration

Unity status appears in the sidebar when enabled:

```
┌─────────────────────────────────────────────┐
│ Unity                                        │
├─────────────────────────────────────────────┤
│ ● Compilation: Passing                       │
│ ● Tests: 15/15 passing                       │
│                                              │
│ [Compile] [Test] [Pipeline]                  │
└─────────────────────────────────────────────┘
```

## Troubleshooting

### Unity Not Detected

1. Check project structure (Assets/, ProjectSettings/)
2. Verify workspace root is correct
3. Check `agenticPlanning.enableUnityFeatures` setting

### Compilation Hanging

1. Check Unity Editor is not open with the project
2. Verify Unity installation path
3. Check for hanging Unity processes

### Tests Not Running

1. Verify Python is installed
2. Check `run_playmode_test.py` permissions
3. Verify Unity Test Framework package is installed

