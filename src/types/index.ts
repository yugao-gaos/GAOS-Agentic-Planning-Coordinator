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
    
    // === Execution State (embedded coordinator) ===
    execution?: ExecutionState;
}

/**
 * Planning status now includes execution phases
 * - debating: AI analysts creating plan
 * - reviewing: User reviewing plan
 * - revising: Agents revising based on feedback
 * - approved: Plan approved, ready to execute
 * - executing: Plan being executed by engineers
 * - paused: Execution paused (can resume)
 * - stopped: Stopped by user (can resume)
 * - completed: All tasks done
 * - cancelled: Cancelled, cannot resume
 */
export type PlanningStatus = 
    | 'debating' 
    | 'reviewing' 
    | 'approved' 
    | 'revising' 
    | 'cancelled' 
    | 'stopped'
    | 'executing'
    | 'paused'
    | 'completed';

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
    createdAt: string;
    updatedAt: string;
}

export type CoordinatorStatus = 'initializing' | 'running' | 'paused' | 'stopped' | 'completed' | 'error';

export interface EngineerSessionInfo {
    sessionId: string;
    status: 'starting' | 'working' | 'paused' | 'completed' | 'error' | 'stopped';
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










