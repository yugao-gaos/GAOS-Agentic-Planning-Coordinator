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
    params?: Record<string, any>;
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
    data?: any;
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
    data: any;
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
    }>;
}

export interface SessionStatusParams {
    id: string;
}

export interface SessionStatusResponse {
    sessionId: string;
    status: string;
    requirement: string;
    currentPlanPath?: string;
    isRevising: boolean;
    workflows: WorkflowSummaryData[];
    pendingWorkflows: number;
    completedWorkflows: number;
}

export interface SessionPauseParams {
    id: string;
}

export interface SessionResumeParams {
    id: string;
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

export interface ExecPauseParams {
    sessionId: string;
}

export interface ExecResumeParams {
    sessionId: string;
}

export interface ExecStopParams {
    sessionId: string;
}

export interface ExecStatusParams {
    sessionId: string;
}

export interface ExecStatusResponse {
    sessionId: string;
    isRevising: boolean;
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
    input?: Record<string, any>;
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
    busy: Array<{
        name: string;
        roleId?: string;
        coordinatorId: string;
        sessionId: string;
        task?: string;
    }>;
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
    busyCount: number;
    busy: Array<{
        name: string;
        roleId?: string;
        coordinatorId: string;
        task?: string;
    }>;
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
    result?: any;
}

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
    | 'exec.paused'
    | 'exec.resumed'
    | 'exec.stopped'
    | 'exec.completed'
    
    // Workflow events
    | 'workflow.started'
    | 'workflow.progress'
    | 'workflow.completed'
    | 'workflow.failed'
    | 'workflow.paused'
    
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
    | 'daemon.ready'
    | 'daemon.shutdown'
    | 'client.connected'
    | 'client.disconnected'
    | 'error';

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
    isCompiling: boolean;
    isPlaying: boolean;
    errorCount: number;
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
export function createRequest(cmd: string, params?: Record<string, any>): ApcRequest {
    return {
        id: generateRequestId(),
        cmd,
        params
    };
}

/**
 * Create an event message
 */
export function createEvent(event: ApcEventType, data: any, sessionId?: string): ApcEvent {
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
export function isApcResponse(msg: any): msg is ApcResponse {
    return msg && typeof msg.id === 'string' && typeof msg.success === 'boolean';
}

/**
 * Type guard for ApcEvent
 */
export function isApcEvent(msg: any): msg is ApcEvent {
    return msg && typeof msg.event === 'string' && msg.timestamp;
}

