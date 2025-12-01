/**
 * Type definitions for sidebar webview state.
 * These mirror the types in SidebarViewProvider but are exported for component use.
 */

export interface SidebarState {
    systemStatus: 'checking' | 'ready' | 'missing' | 'daemon_missing';
    missingCount: number;
    sessions: SessionInfo[];
    agents: AgentInfo[];
    unity: UnityInfo;
    unityEnabled: boolean;
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
    progressLogPath?: string;
    activeWorkflows: WorkflowInfo[];
    isRevising: boolean;
    failedTasks: FailedTaskInfo[];
    sessionAgents: AgentInfo[];
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
    status: 'available' | 'busy';
    roleId?: string;
    coordinatorId?: string;
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
}

