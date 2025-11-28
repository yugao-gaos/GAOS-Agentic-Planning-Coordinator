// ============================================================================
// State Types
// ============================================================================

export interface ExtensionState {
    globalSettings: GlobalSettings;
    activePlanningSessions: string[];
    activeCoordinators: string[];
}

export interface GlobalSettings {
    engineerPoolSize: number;
    defaultBackend: 'cursor' | 'claude-code' | 'codex';
    workingDirectory: string;
}

// ============================================================================
// Engineer Pool Types
// ============================================================================

export interface EngineerPoolState {
    totalEngineers: number;
    engineerNames: string[];
    available: string[];
    busy: Record<string, BusyEngineerInfo>;
}

export interface BusyEngineerInfo {
    coordinatorId: string;
    sessionId: string;
    task?: string;
    startTime: string;
    processId?: number;
    logFile?: string;
}

export interface EngineerStatus {
    name: string;
    status: 'available' | 'busy' | 'paused' | 'error';
    coordinatorId?: string;
    sessionId?: string;
    task?: string;
    logFile?: string;
    processId?: number;
}

// ============================================================================
// Planning Session Types
// ============================================================================

export interface PlanningSession {
    id: string;
    status: PlanningStatus;
    requirement: string;
    currentPlanPath?: string;
    planHistory: PlanVersion[];
    revisionHistory: RevisionEntry[];
    recommendedEngineers?: EngineerRecommendation;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, any>;  // Optional metadata for pause/resume state
    
    // === Execution State (embedded coordinator) ===
    execution?: ExecutionState;
}

/**
 * Planning-only statuses (for the plan creation phase)
 * - debating: AI analysts creating plan
 * - reviewing: Plan complete, user reviewing for approval
 * - revising: Agents revising based on feedback
 * - approved: Plan approved, ready to execute
 * - stopped: Planning stopped by user (can resume)
 * - cancelled: Planning cancelled, cannot resume
 */
export type PlanningOnlyStatus = 
    | 'debating' 
    | 'reviewing' 
    | 'approved' 
    | 'revising' 
    | 'stopped'
    | 'cancelled';

/**
 * Execution-only statuses (for the execution phase)
 * - executing: Engineers actively working
 * - paused: Execution paused (can resume)
 * - completed: All tasks done
 * - failed: Execution failed
 */
export type ExecutionOnlyStatus =
    | 'executing'
    | 'paused'
    | 'completed'
    | 'failed';

/**
 * Combined status for PlanningSession
 * The session tracks both planning phase and execution phase
 */
export type PlanningStatus = PlanningOnlyStatus | ExecutionOnlyStatus;

/**
 * Execution state embedded in PlanningSession for UI display
 * The actual execution is managed by CoordinatorService
 */
export interface ExecutionState {
    /** Links to the CoordinatorService's coordinator */
    coordinatorId: string;
    mode: 'auto' | 'interactive';
    startedAt: string;
    /** Snapshot of engineer states for UI display (synced from coordinator) */
    engineers: Record<string, EngineerExecutionState>;
    progress: TaskProgress;
    currentWave: number;
    lastActivityAt: string;
}

/**
 * Per-engineer execution state (synced from CoordinatorService)
 */
export interface EngineerExecutionState {
    name: string;
    status: 'idle' | 'starting' | 'working' | 'paused' | 'completed' | 'error';
    sessionId: string;
    currentTask?: string;
    logFile: string;
    processId?: number;
    startTime: string;
    lastActivity?: string;
}

export interface PlanVersion {
    version: number;
    path: string;
    timestamp: string;
}

export interface RevisionEntry {
    version: number;
    feedback: string;
    timestamp: string;
}

export interface EngineerRecommendation {
    count: number;
    justification: string;
}

// ============================================================================
// Coordinator Types
// ============================================================================

export interface CoordinatorState {
    id: string;
    planPath: string;
    planSessionId?: string;
    status: CoordinatorStatus;
    mode: 'auto' | 'interactive';
    engineerSessions: Record<string, EngineerSessionInfo>;
    planVersion: number;
    progress: TaskProgress;
    logFile: string;  // Coordinator log file for terminal streaming
    executionSummaryPath?: string;  // Path to execution summary/review file
    createdAt: string;
    updatedAt: string;
}

export type CoordinatorStatus = 'initializing' | 'running' | 'paused' | 'stopped' | 'reviewing' | 'completed' | 'error';

export interface EngineerSessionInfo {
    sessionId: string;
    status: 'starting' | 'working' | 'paused' | 'completed' | 'error' | 'stopped' | 'idle';
    task?: string;
    logFile: string;
    processId?: number;
    startTime: string;
    lastActivity?: string;
}

export interface TaskProgress {
    completed: number;
    total: number;
    percentage: number;
}

// ============================================================================
// Plan Types
// ============================================================================

export interface PlanInfo {
    title: string;
    path: string;
    sessionId?: string;
    status: PlanningStatus;
}

export interface PlanTask {
    id: string;
    title: string;
    description: string;
    assignedTo?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    dependencies?: string[];
    wave?: number;
}

// ============================================================================
// CLI Response Types
// ============================================================================

export interface CliResponse {
    success: boolean;
    message?: string;
    error?: string;
    data?: unknown;
}

export interface PlanStartResponse extends CliResponse {
    data: {
        sessionId: string;
        status: PlanningStatus;
        analysts?: string[];
    };
}

export interface CoordinatorStartResponse extends CliResponse {
    data: {
        coordinatorId: string;
        status: CoordinatorStatus;
        engineersAllocated: string[];
        plan: {
            title: string;
            progress: TaskProgress;
        };
    };
}

export interface StatusResponse extends CliResponse {
    data: {
        activePlanningSessions: number;
        activeCoordinators: number;
        engineerPool: {
            total: number;
            available: number;
            busy: number;
        };
    };
}

export interface PoolStatusResponse extends CliResponse {
    data: {
        total: number;
        available: string[];
        busy: Array<{
            name: string;
            coordinatorId: string;
            sessionId: string;
            task?: string;
        }>;
    };
}

// ============================================================================
// Terminal Types
// ============================================================================

export interface EngineerTerminal {
    name: string;
    sessionId: string;
    terminal: import('vscode').Terminal;
    logFile: string;
}










