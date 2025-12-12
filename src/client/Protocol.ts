/**
 * Protocol.ts - Shared types for client-server communication
 * 
 * This file defines the WebSocket message protocol between
 * APC daemon (server) and clients (VS Code, TUI, headless).
 */

// ============================================================================
// Base Message Types
// ============================================================================

/**
 * Request message from client to server
 */
export interface ApcRequest {
    /** Unique request ID for matching responses */
    id: string;
    /** Command to execute (e.g., 'session.create', 'pool.status') */
    cmd: string;
    /** Command parameters */
    params?: Record<string, unknown>;
    /** Client identifier for multi-client scenarios */
    clientId?: string;
}

/**
 * Response message from server to client
 */
export interface ApcResponse {
    /** Request ID this response is for */
    id: string;
    /** Whether the command succeeded */
    success: boolean;
    /** Result data (command-specific) */
    data?: unknown;
    /** Error message if success is false */
    error?: string;
    /** Human-readable message */
    message?: string;
}

/**
 * Event message pushed from server to clients
 */
export interface ApcEvent {
    /** Event type (e.g., 'session.updated', 'agent.progress') */
    event: string;
    /** Event payload */
    data: unknown;
    /** When the event occurred */
    timestamp: string;
    /** Session ID if event is session-scoped */
    sessionId?: string;
}

/**
 * Union type for all WebSocket messages
 */
export type ApcMessage = 
    | { type: 'request'; payload: ApcRequest }
    | { type: 'response'; payload: ApcResponse }
    | { type: 'event'; payload: ApcEvent };

// ============================================================================
// Command Categories
// ============================================================================

/**
 * Available command categories
 */
export type CommandCategory = 
    | 'status'
    | 'session'
    | 'plan'
    | 'exec'
    | 'workflow'
    | 'pool'
    | 'agent'
    | 'unity';

// ============================================================================
// Status Commands
// ============================================================================

export interface StatusResponse {
    activePlanningSessions: number;
    agentPool: {
        total: number;
        available: number;
        busy: number;
    };
    daemonUptime: number;
    connectedClients: number;
}

// ============================================================================
// Session Commands
// ============================================================================

export interface SessionListResponse {
    sessions: Array<{
        id: string;
        status: string;
        requirement: string;
        activeWorkflows: number;
        totalWorkflows: number;
        createdAt: string;
        updatedAt: string;
        /** Path to current plan file (if any) */
        currentPlanPath?: string;
        /** Plan version history */
        planHistory?: Array<{ version: number; path: string; timestamp: string }>;
    }>;
}

export interface SessionStatusParams {
    id: string;
}

export interface SessionStatusResponse {
    sessionId: string;
    status: string;  // Check status === 'revising' for revision state
    requirement: string;
    currentPlanPath?: string;
    workflows: WorkflowSummaryData[];
    pendingWorkflows: number;
    completedWorkflows: number;
}

/**
 * Info about a completed session (lightweight, for listing)
 */
export interface CompletedSessionInfo {
    id: string;
    requirement: string;
    completedAt: string;
    createdAt: string;
    currentPlanPath?: string;
    /** Task progress at completion time */
    taskProgress?: {
        completed: number;
        total: number;
        percentage: number;
    };
}

/**
 * Response for listing completed sessions
 */
export interface CompletedSessionListResponse {
    sessions: CompletedSessionInfo[];
    /** Total count of completed sessions (may be more than returned if limit applied) */
    total: number;
}

// ============================================================================
// Plan Commands
// ============================================================================

export interface PlanListResponse {
    plans: Array<{
        id: string;
        status: string;
        requirement: string;
        currentPlanPath?: string;
        version: number;
    }>;
}

export interface PlanCreateParams {
    prompt: string;
    docs?: string[];
}

export interface PlanCreateResponse {
    sessionId: string;
    status: string;
    planPath?: string;
    recommendedAgents?: {
        count: number;
        justification: string;
    };
    debateSummary?: string;
}

export interface PlanStatusParams {
    id: string;
}

export interface PlanReviseParams {
    id: string;
    feedback: string;
}

export interface PlanApproveParams {
    id: string;
    autoStart?: boolean;
}

export interface PlanCancelParams {
    id: string;
}

// ============================================================================
// Execution Commands
// ============================================================================

export interface ExecStartParams {
    sessionId: string;
    mode?: 'auto' | 'interactive';
    engineerCount?: number;
}

export interface ExecStartResponse {
    sessionId: string;
    workflowIds: string[];
    message: string;
}

export interface ExecStopParams {
    sessionId: string;
}

export interface ExecStatusParams {
    sessionId: string;
}

export interface ExecStatusResponse {
    sessionId: string;
    // Note: Check session status for 'revising' state
    workflows: WorkflowSummaryData[];
    activeWorkflows: number;
    completedWorkflows: number;
}

// ============================================================================
// Workflow Commands
// ============================================================================

export interface WorkflowDispatchParams {
    sessionId: string;
    type: string;
    input?: Record<string, unknown>;
}

export interface WorkflowDispatchResponse {
    workflowId: string;
    sessionId: string;
    type: string;
}

export interface WorkflowStatusParams {
    sessionId: string;
    workflowId: string;
}

export interface WorkflowCancelParams {
    sessionId: string;
    workflowId: string;
}

export interface WorkflowListParams {
    sessionId: string;
}

export interface WorkflowSummaryData {
    id: string;
    type: string;
    status: string;
    phase: string;
    percentage: number;
    taskId?: string;
    agentName?: string;
}

// ============================================================================
// Pool Commands
// ============================================================================

export interface PoolStatusResponse {
    total: number;
    available: string[];
    allocated: Array<{
        name: string;
        roleId: string;
        sessionId: string;
        workflowId: string;
    }>;
    busy: Array<{
        name: string;
        roleId?: string;
        workflowId: string;
        sessionId: string;
        task?: string;
    }>;
    resting: string[];
}

export interface PoolResizeParams {
    size: number;
}

export interface PoolResizeResponse {
    newSize: number;
    added: string[];
    removed: string[];
}

// ============================================================================
// Agent Commands
// ============================================================================

export interface AgentPoolResponse {
    availableCount: number;
    available: string[];
    allocatedCount: number;
    allocated: Array<{
        name: string;
        roleId: string;
        workflowId: string;
    }>;
    busyCount: number;
    busy: Array<{
        name: string;
        roleId?: string;
        workflowId: string;
        task?: string;
    }>;
    restingCount: number;
    resting: string[];
}

export interface AgentRolesResponse {
    roles: Array<{
        id: string;
        name: string;
        description: string;
        isBuiltIn: boolean;
        defaultModel: string;
        timeoutMs: number;
    }>;
}

export interface AgentReleaseParams {
    agentName: string;
}

// ============================================================================
// Unity Commands
// ============================================================================

export interface UnityCompileParams {
    coordinatorId: string;
    agentName: string;
}

export interface UnityCompileResponse {
    taskId: string;
    type: string;
    requestedBy: {
        coordinatorId: string;
        agentName: string;
    };
}

export interface UnityTestParams {
    mode: 'editmode' | 'playmode';
    coordinatorId: string;
    agentName: string;
    filter?: string[];
    scene?: string;
}

export interface UnityTestResponse {
    taskId: string;
    type: string;
    requestedBy: {
        coordinatorId: string;
        agentName: string;
    };
    filter?: string[];
}

export interface UnityStatusResponse {
    status: string;
    connected: boolean;
    isPlaying: boolean;
    isCompiling: boolean;
    hasErrors: boolean;
    errorCount: number;
    currentTask?: {
        id: string;
        type: string;
        phase: string;
        requestedBy: {
            coordinatorId: string;
            agentName: string;
        };
    };
    queueLength: number;
    lastActivity?: string;
}

export interface UnityWaitParams {
    taskId: string;
    timeout?: number;
}

export interface UnityWaitResponse {
    taskId: string;
    waited: number;
    status: string;
    result?: unknown;
}

// ============================================================================
// Unity Direct WebSocket Types (for Unity package communication)
// ============================================================================

/**
 * Unity state response from direct WebSocket connection
 */
export interface UnityDirectStateResponse {
    isCompiling: boolean;
    isPlaying: boolean;
    isPaused: boolean;
    isBusy: boolean;
    currentOperation: string | null;
    editorReady: boolean;
    projectPath: string;
    unityVersion: string;
}

/**
 * Unity registration parameters
 */
export interface UnityRegisterParams {
    projectPath: string;
    unityVersion: string;
}

/**
 * Unity direct command types
 */
export type UnityDirectCommand =
    | 'unity.direct.getState'
    | 'unity.direct.enterPlayMode'
    | 'unity.direct.exitPlayMode'
    | 'unity.direct.loadScene'
    | 'unity.direct.createScene'
    | 'unity.direct.runTests'
    | 'unity.direct.compile'
    | 'unity.direct.focusEditor';

// ============================================================================
// Event Types (Server -> Client)
// ============================================================================

/**
 * All possible event types
 */
export type ApcEventType =
    // Session events
    | 'session.created'
    | 'session.updated'
    | 'session.deleted'
    | 'session.statusChanged'
    
    // Plan events
    | 'plan.created'
    | 'plan.updated'
    | 'plan.approved'
    | 'plan.revised'
    
    // Execution events
    | 'exec.started'
    | 'exec.stopped'
    | 'exec.completed'
    
    // Workflow events
    | 'workflow.started'
    | 'workflow.progress'
    | 'workflow.completed'
    | 'workflow.failed'
    | 'workflow.event'  // Generic workflow events (e.g., review requests)
    
    // Agent events
    | 'agent.assigned'
    | 'agent.released'
    | 'agent.progress'
    | 'agent.completed'
    | 'agent.error'
    
    // Pool events
    | 'pool.changed'
    | 'pool.resized'
    
    // Unity events
    | 'unity.taskQueued'
    | 'unity.taskStarted'
    | 'unity.taskCompleted'
    | 'unity.taskFailed'
    | 'unity.statusChanged'
    
    // System events
    | 'daemon.starting'
    | 'daemon.progress'
    | 'daemon.ready'
    | 'daemon.shutdown'
    | 'client.connected'
    | 'client.disconnected'
    | 'error'
    
    // User interaction events
    | 'user.questionAsked';

// ============================================================================
// Event Payloads
// ============================================================================

export interface SessionUpdatedEvent {
    sessionId: string;
    status: string;
    changes: string[];
}

export interface WorkflowProgressEvent {
    workflowId: string;
    sessionId: string;
    type: string;
    status: string;
    phase: string;
    percentage: number;
    message: string;
}

export interface AgentProgressEvent {
    agentName: string;
    sessionId: string;
    coordinatorId: string;
    roleId?: string;
    task?: string;
    progress: string;
    outputChunk?: string;
}

export interface UnityStatusChangedEvent {
    status: string;
    connected: boolean;
    isCompiling: boolean;
    isPlaying: boolean;
    isPaused: boolean;
    hasErrors: boolean;
    errorCount: number;
    queueLength: number;
    currentTask?: {
        id: string;
        type: string;
        phase?: string;
    };
    timestamp: string;
}

export interface PoolChangedEvent {
    available: string[];
    busy: string[];
    totalAgents: number;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a request message
 */
export function createRequest(cmd: string, params?: Record<string, unknown>): ApcRequest {
    return {
        id: generateRequestId(),
        cmd,
        params
    };
}

/**
 * Create an event message
 */
export function createEvent(event: ApcEventType, data: unknown, sessionId?: string): ApcEvent {
    return {
        event,
        data,
        timestamp: new Date().toISOString(),
        sessionId
    };
}

/**
 * Type guard for ApcResponse
 */
export function isApcResponse(msg: unknown): msg is ApcResponse {
    return typeof msg === 'object' && msg !== null && 'id' in msg && 'success' in msg && typeof (msg as ApcResponse).id === 'string' && typeof (msg as ApcResponse).success === 'boolean';
}

/**
 * Type guard for ApcEvent
 */
export function isApcEvent(msg: unknown): msg is ApcEvent {
    return typeof msg === 'object' && msg !== null && 'event' in msg && 'timestamp' in msg && typeof (msg as ApcEvent).event === 'string';
}

// ============================================================================
// Config Commands
// ============================================================================

export interface ConfigGetParams {
    key?: string; // If omitted, return all config
}

export interface ConfigGetResponse {
    config: Record<string, unknown> | unknown;
}

export interface ConfigSetParams {
    key: string;
    value: unknown;
}

export interface ConfigResetParams {
    key?: string; // If omitted, reset all
}

// ============================================================================
// Folder Commands
// ============================================================================

export interface FoldersGetParams {
    folder?: string; // If omitted, return all folders
}

export interface FoldersGetResponse {
    folders: Record<string, string> | string;
}

export interface FoldersSetParams {
    folder: string;
    name: string;
}

export interface FoldersResetParams {
    folder?: string; // If omitted, reset all
}

