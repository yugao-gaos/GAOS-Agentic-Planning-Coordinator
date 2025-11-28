// ============================================================================
// Unity Control Agent Types
// ============================================================================

/**
 * Unity task types for the control agent queue
 */
export type UnityTaskType =
    | 'prep_editor'              // Reimport + Compile (combined)
    | 'test_framework_editmode'  // Unity Test Framework - EditMode tests
    | 'test_framework_playmode'  // Unity Test Framework - PlayMode tests
    | 'test_player_playmode';    // Manual player testing with monitoring

/**
 * Task requester information - tracks who requested the Unity task
 */
export interface TaskRequester {
    coordinatorId: string;
    engineerName: string;
}

/**
 * Unity task in the control agent queue
 */
export interface UnityTask {
    id: string;
    type: UnityTaskType;
    priority: number;  // 1=prep_editor, 2=test_framework_edit, 3=test_framework_play, 4=test_player

    requestedBy: TaskRequester[];  // Can be multiple (combined tasks)

    // For test_player_playmode
    testScene?: string;       // Scene to load for testing
    maxDuration?: number;     // Max test duration in seconds

    // For test framework
    testFilter?: string[];    // Specific tests to run

    status: 'queued' | 'executing' | 'completed' | 'failed';
    phase?: 'preparing' | 'waiting_compile' | 'waiting_import' | 'running_tests' | 'monitoring';
    createdAt: string;
    startedAt?: string;
    completedAt?: string;

    result?: UnityTaskResult;
}

/**
 * Result of a Unity task execution
 */
export interface UnityTaskResult {
    success: boolean;
    errors: UnityError[];
    warnings: UnityWarning[];

    // For tests
    testsPassed?: number;
    testsFailed?: number;
    testResults?: TestResult[];

    // For player test
    playDuration?: number;
    exitReason?: 'player_exit' | 'timeout' | 'error' | 'stopped';
}

/**
 * Unity compilation/runtime error
 */
export interface UnityError {
    id: string;
    type: 'compilation' | 'runtime' | 'test_failure';
    code?: string;           // CS0103, CS0246, etc.
    message: string;
    file?: string;
    line?: number;
    column?: number;
    stackTrace?: string;
    timestamp: string;
}

/**
 * Unity warning
 */
export interface UnityWarning {
    code?: string;
    message: string;
    file?: string;
    line?: number;
    timestamp: string;
}

/**
 * Test result from Unity Test Framework
 */
export interface TestResult {
    testName: string;
    className: string;
    passed: boolean;
    duration: number;
    message?: string;
    stackTrace?: string;
}

// ============================================================================
// Error Registry Types
// ============================================================================

/**
 * Error status in the centralized registry
 */
export type ErrorStatus =
    | 'pending'    // Not yet assigned
    | 'fixing'     // Engineer is working on it
    | 'fixed'      // Fixed, awaiting verification
    | 'verified'   // Confirmed fixed after recompile/test
    | 'wontfix';   // Not going to fix (with reason)

/**
 * Error entry in the centralized error registry
 */
export interface ErrorRegistryEntry {
    id: string;
    type: 'compilation' | 'runtime' | 'test_failure';
    summary: string;
    code?: string;
    file?: string;
    line?: number;
    stackTrace?: string;
    status: ErrorStatus;
    assignedTo?: {
        coordinatorId: string;
        engineerName: string;
    };
    assignedAt?: string;
    fixedBy?: string;
    fixedAt?: string;
    fixSummary?: string;
    notes?: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * Error assignment from AI router
 */
export interface ErrorAssignment {
    errorId: string;
    errorSummary: string;
    coordinatorId: string;
    suggestedEngineer: string;
    reason: string;
    isDuplicate: boolean;
    duplicateOf?: string;
}

/**
 * AI router response
 */
export interface ErrorRoutingResult {
    assignments: ErrorAssignment[];
    duplicatesSkipped: Array<{
        error: string;
        duplicateOf: string;
    }>;
}

// ============================================================================
// Unity Editor State Types (from MCP)
// ============================================================================

/**
 * Unity editor state from fetch_mcp_resource('unity://editor/state')
 */
export interface UnityEditorState {
    isPlaying: boolean;
    isPaused: boolean;
    isCompiling: boolean;
    isImporting?: boolean;
    applicationPath: string;
    projectPath: string;
    unityVersion: string;
}

/**
 * Unity console message
 */
export interface UnityConsoleMessage {
    type: 'log' | 'warning' | 'error' | 'exception';
    message: string;
    stackTrace?: string;
    timestamp: string;
}

// ============================================================================
// Unity Control Agent State
// ============================================================================

/**
 * Unity Control Agent status
 */
export type UnityControlAgentStatus =
    | 'idle'           // Waiting for tasks
    | 'executing'      // Running a task
    | 'waiting_unity'  // Waiting for Unity to finish (compile/import)
    | 'monitoring'     // Monitoring player playmode
    | 'error';         // Error state

/**
 * Unity Control Agent state
 */
export interface UnityControlAgentState {
    status: UnityControlAgentStatus;
    currentTask?: UnityTask;
    queueLength: number;
    tempScenePath: string;
    lastActivity: string;
    errorRegistryPath: string;
}

