/**
 * Type definitions for sidebar webview state.
 * These mirror the types in SidebarViewProvider but are exported for component use.
 */

export interface MissingDependencyInfo {
    name: string;
    description: string;
    installUrl?: string;
    installCommand?: string;
    /** Special handling - e.g. 'apc-cli' for custom install, 'cursor-agent-cli' for cursor-agent installer */
    installType?: 'url' | 'command' | 'apc-cli' | 'vscode-command' | 'cursor-agent-cli' | 'retry';
}

export interface SidebarState {
    /**
     * System status:
     * - initializing: Daemon process starting
     * - connecting: Client attempting to connect
     * - checking: Connected, daemon checking dependencies
     * - ready: All checks passed
     * - missing: Checks completed, dependencies missing
     * - daemon_missing: Not connected
     */
    systemStatus: 'initializing' | 'connecting' | 'checking' | 'ready' | 'missing' | 'daemon_missing';
    missingCount: number;
    missingDependencies: MissingDependencyInfo[];
    /** Connection retry count for daemon_missing state */
    connectionRetries: number;
    /** Current initialization step (for initializing/checking states) */
    initializationStep?: string;
    sessions: SessionInfo[];
    /** Completed sessions (most recent first, limited to 5 for sidebar display) */
    completedSessions: CompletedSessionSummary[];
    /** Total count of completed sessions */
    completedSessionsTotal: number;
    agents: AgentInfo[];
    unity: UnityInfo;
    unityEnabled: boolean;
    coordinatorStatus: CoordinatorStatusInfo;
    connectionHealth: ConnectionHealthInfo;
}

/**
 * Lightweight summary of a completed session for sidebar display
 */
export interface CompletedSessionSummary {
    id: string;
    requirement: string;
    completedAt: string;
    createdAt: string;
    planPath?: string;
    /** Task progress at completion */
    taskProgress?: {
        completed: number;
        total: number;
        percentage: number;
    };
}

export interface ConnectionHealthInfo {
    /**
     * Connection health states:
     * - 'healthy': Connected and responding
     * - 'unhealthy': Connection issues (attempting to reconnect)
     * - 'daemon_stopped': Daemon was intentionally stopped (not reconnecting)
     * - 'unknown': Initial state
     */
    state: 'healthy' | 'unhealthy' | 'daemon_stopped' | 'unknown';
    lastPingSuccess: boolean;
    consecutiveFailures: number;
    /** True if daemon was intentionally stopped (vs connection lost) */
    daemonStopped?: boolean;
}

export interface CoordinatorStatusInfo {
    state: 'idle' | 'queuing' | 'evaluating' | 'cooldown';
    pendingEvents: number;
    lastEvaluation?: string;
    evaluationCount: number;
}

export interface WorkflowInfo {
    id: string;
    type: string;
    status: string;
    phase: string;
    phaseIndex: number;
    totalPhases: number;
    percentage: number;
    startedAt: string;
    taskId?: string;
    /** Path to workflow log file */
    logPath?: string;
    /** True when workflow is waiting for agent allocation */
    waitingForAgent?: boolean;
    /** Role ID of agent being waited for */
    waitingForAgentRole?: string;
    /** Brief summary of what was accomplished or why it failed */
    summary?: string;
    /** Explicit success flag (for completed workflows) */
    success?: boolean;
    /** Error message (for failed workflows) */
    error?: string;
    /** Workflow output data (workflow-specific) */
    output?: any;
}

export interface SessionInfo {
    id: string;
    requirement: string;
    status: string;
    taskCount: number;
    completedTasks: number;
    agentCount: number;
    createdAt: string;
    planPath?: string;
    planStatus?: string;
    planVersion: number;
    executionStatus?: string;
    activeWorkflows: WorkflowInfo[];
    workflowHistory: WorkflowInfo[];  // Completed workflows (newest first)
    // Note: Check status === 'revising' instead of separate isRevising flag
    sessionAgents: AgentInfo[];  // All agents associated with this session (for workflow display)
    /** True if the plan is partial/incomplete (workflow was interrupted) */
    hasPartialPlan?: boolean;
    /** Reason the plan was interrupted, if applicable */
    interruptReason?: string;
    /** True if session is ready for manual completion (approved + all tasks done) */
    readyForCompletion?: boolean;
}

export interface AgentInfo {
    name: string;
    status: 'available' | 'allocated' | 'busy' | 'resting';  // All 4 agent states
    roleId?: string;
    workflowId?: string;  // The specific workflow this agent is working on
    roleColor?: string;
    workflowType?: string;
    currentPhase?: string;
    taskId?: string;
    sessionId?: string;
}

export interface UnityInfo {
    connected: boolean;
    isPlaying: boolean;
    isCompiling: boolean;
    hasErrors: boolean;
    errorCount: number;
    queueLength: number;
    status?: 'idle' | 'compiling' | 'testing' | 'playing' | 'error';
    currentTask?: {
        id: string;
        type: string;
        phase?: string;
    };
}

/**
 * Format Unity task type for short display (status bar).
 * Returns concise names suitable for inline status text.
 */
export function formatTaskTypeShort(type: string): string {
    const typeMap: Record<string, string> = {
        'prep': 'Prep',
        'prep_editor': 'Prep',
        'test_editmode': 'EditMode',
        'test_playmode': 'PlayMode',
        'test_player_playmode': 'Player',
        'test_framework_editmode': 'EditMode',
        'test_framework_playmode': 'PlayMode'
    };
    return typeMap[type] || type;
}

/**
 * Format Unity task type for detailed display (tooltips, expanded views).
 * Returns descriptive names with context.
 */
export function formatTaskTypeDetailed(type: string): string {
    const typeMap: Record<string, string> = {
        'prep': 'Prep (compile)',
        'prep_editor': 'Prep (compile)',
        'test_editmode': 'EditMode Tests',
        'test_playmode': 'PlayMode Tests',
        'test_player_playmode': 'Player Test',
        'test_framework_editmode': 'EditMode Tests',
        'test_framework_playmode': 'PlayMode Tests'
    };
    return typeMap[type] || type;
}

