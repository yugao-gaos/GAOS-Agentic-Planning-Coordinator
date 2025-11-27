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
}

export type PlanningStatus = 'debating' | 'reviewing' | 'approved' | 'revising' | 'cancelled';

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

