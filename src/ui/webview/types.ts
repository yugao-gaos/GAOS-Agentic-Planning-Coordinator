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
    agents: AgentInfo[];
    unity: UnityInfo;
    unityEnabled: boolean;
    coordinatorStatus: CoordinatorStatusInfo;
    connectionHealth: ConnectionHealthInfo;
}

export interface ConnectionHealthInfo {
    state: 'healthy' | 'unhealthy' | 'unknown';
    lastPingSuccess: boolean;
    consecutiveFailures: number;
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
    isRevising: boolean;
    failedTasks: FailedTaskInfo[];
    sessionAgents: AgentInfo[];  // All agents associated with this session (for workflow display)
    /** True if the plan is partial/incomplete (workflow was interrupted) */
    hasPartialPlan?: boolean;
    /** Reason the plan was interrupted, if applicable */
    interruptReason?: string;
}

export interface FailedTaskInfo {
    taskId: string;
    description: string;
    attempts: number;
    lastError: string;
    canRetry: boolean;
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

