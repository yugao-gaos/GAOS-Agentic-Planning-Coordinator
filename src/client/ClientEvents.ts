/**
 * ClientEvents.ts - Type-safe event definitions for APC client
 * 
 * This module provides strongly-typed event handlers for the various
 * events that the APC daemon can emit.
 */

import { ApcEventType } from './Protocol';

// ============================================================================
// Event Data Types
// ============================================================================

/**
 * Session created event data
 */
export interface SessionCreatedEventData {
    sessionId: string;
    requirement: string;
    createdAt: string;
}

/**
 * Session updated event data
 */
export interface SessionUpdatedEventData {
    sessionId: string;
    status: string;
    previousStatus: string;
    changes: string[];
    updatedAt: string;
}

/**
 * Session deleted event data
 */
export interface SessionDeletedEventData {
    sessionId: string;
    deletedAt: string;
}

/**
 * Plan created event data
 */
export interface PlanCreatedEventData {
    sessionId: string;
    planPath: string;
    version: number;
    createdAt: string;
}

/**
 * Plan updated event data
 */
export interface PlanUpdatedEventData {
    sessionId: string;
    planPath: string;
    version: number;
    changes: string[];
    updatedAt: string;
}

/**
 * Plan approved event data
 */
export interface PlanApprovedEventData {
    sessionId: string;
    planPath: string;
    approvedAt: string;
    autoStart: boolean;
}

/**
 * Execution started event data
 */
export interface ExecStartedEventData {
    sessionId: string;
    coordinatorId: string;
    workflowCount: number;
    startedAt: string;
}

/**
 * Execution completed event data
 */
export interface ExecCompletedEventData {
    sessionId: string;
    coordinatorId: string;
    success: boolean;
    tasksCompleted: number;
    tasksFailed: number;
    duration: number;
    completedAt: string;
}

/**
 * Workflow progress event data
 */
export interface WorkflowProgressEventData {
    workflowId: string;
    sessionId: string;
    type: string;
    status: string;
    phase: string;
    phaseIndex: number;
    totalPhases: number;
    percentage: number;
    message: string;
    taskId?: string;
    agentName?: string;
    updatedAt: string;
}

/**
 * Workflow completed event data
 */
export interface WorkflowCompletedEventData {
    workflowId: string;
    sessionId: string;
    type: string;
    success: boolean;
    output?: unknown;
    error?: string;
    duration: number;
    completedAt: string;
}

/**
 * Agent assigned event data
 */
export interface AgentAssignedEventData {
    agentName: string;
    sessionId: string;
    coordinatorId: string;
    workflowId: string;
    roleId: string;
    task?: string;
    assignedAt: string;
}

/**
 * Agent allocated event data (for terminal creation)
 */
export interface AgentAllocatedEventData {
    agentName: string;
    sessionId: string;
    roleId: string;
    workflowId: string;
    logFile?: string;
}

/**
 * Agent released event data
 */
export interface AgentReleasedEventData {
    agentName: string;
    sessionId: string;
    coordinatorId: string;
    reason: 'completed' | 'failed' | 'cancelled' | 'manual';
    releasedAt: string;
}

/**
 * Agent progress event data (streaming output)
 */
export interface AgentProgressEventData {
    agentName: string;
    sessionId: string;
    coordinatorId: string;
    roleId?: string;
    task?: string;
    /** Progress message or phase */
    progress: string;
    /** Type of output: text, thinking, tool, error */
    outputType?: 'text' | 'thinking' | 'tool' | 'tool_result' | 'error' | 'info';
    /** Streaming output chunk */
    outputChunk?: string;
    timestamp: string;
}

/**
 * Agent error event data
 */
export interface AgentErrorEventData {
    agentName: string;
    sessionId: string;
    coordinatorId: string;
    error: string;
    recoverable: boolean;
    timestamp: string;
}

/**
 * Pool changed event data
 * 
 * Agent lifecycle states:
 * - available: Ready to be allocated
 * - allocated: On bench, assigned to workflow but waiting for work
 * - busy: Actively working on a task
 * - resting: In cooldown after release (5 seconds) before becoming available
 */
export interface PoolChangedEventData {
    totalAgents: number;
    available: string[];
    allocated: Array<{
        name: string;
        workflowId: string;
        roleId?: string;
    }>;
    busy: Array<{
        name: string;
        coordinatorId: string;
        roleId?: string;
    }>;
    resting: string[];
    changedAt: string;
}

/**
 * Pool resized event data
 */
export interface PoolResizedEventData {
    previousSize: number;
    newSize: number;
    added: string[];
    removed: string[];
    resizedAt: string;
}

/**
 * Unity task queued event data
 */
export interface UnityTaskQueuedEventData {
    taskId: string;
    taskType: string;
    requestedBy: {
        coordinatorId: string;
        agentName: string;
    };
    queuePosition: number;
    queuedAt: string;
}

/**
 * Unity task started event data
 */
export interface UnityTaskStartedEventData {
    taskId: string;
    taskType: string;
    requestedBy: {
        coordinatorId: string;
        agentName: string;
    };
    startedAt: string;
}

/**
 * Unity task completed event data
 */
export interface UnityTaskCompletedEventData {
    taskId: string;
    taskType: string;
    success: boolean;
    result?: {
        errors?: number;
        warnings?: number;
        testsPassed?: number;
        testsFailed?: number;
    };
    duration: number;
    completedAt: string;
}

/**
 * Unity status changed event data
 */
export interface UnityStatusChangedEventData {
    status: 'idle' | 'compiling' | 'testing' | 'playing' | 'error';
    isCompiling: boolean;
    isPlaying: boolean;
    isPaused: boolean;
    hasErrors: boolean;
    errorCount: number;
    timestamp: string;
}

/**
 * Unity pipeline started event data
 */
export interface UnityPipelineStartedEventData {
    pipelineId: string;
    sessionId?: string;
    operations: string[];
    tasksInvolved: Array<{ taskId: string; description: string }>;
    startedAt: string;
}

/**
 * Unity pipeline progress event data
 */
export interface UnityPipelineProgressEventData {
    pipelineId: string;
    sessionId?: string;
    currentStep: number;
    totalSteps: number;
    currentOperation: string;
    percentage: number;
    timestamp: string;
}

/**
 * Unity pipeline completed event data
 */
export interface UnityPipelineCompletedEventData {
    pipelineId: string;
    sessionId?: string;
    success: boolean;
    failedAtStep?: string;
    operations: string[];
    errors: Array<{ message: string; source?: string }>;
    testFailures: Array<{ test: string; message: string }>;
    tasksInvolved: Array<{ taskId: string; description: string }>;
    duration: number;
    completedAt: string;
}

/**
 * Daemon starting event data (WebSocket ready, services may still be initializing)
 */
export interface DaemonStartingEventData {
    version: string;
    port: number;
    workspaceRoot: string;
    startedAt: string;
    readyState: 'initializing_services' | 'ready';
}

/**
 * Daemon progress event data (initialization step updates)
 */
export interface DaemonProgressEventData {
    step: string;         // e.g., "StateManager initialized", "Checking dependencies"
    phase: 'checking_dependencies' | 'initializing_services' | 'ready';
    timestamp: string;
}

/**
 * Daemon ready event data (fully initialized)
 */
export interface DaemonReadyEventData {
    version: string;
    servicesReady?: boolean;
    readyState?: 'ready';
}

/**
 * Daemon shutdown event data
 */
export interface DaemonShutdownEventData {
    reason: string;
    graceful: boolean;
    timestamp: string;
}

/**
 * Daemon error event data (fatal errors that may cause shutdown)
 */
export interface DaemonErrorEventData {
    fatal: boolean;
    message: string;
    timestamp: string;
}

/**
 * Client connected event data
 */
export interface ClientConnectedEventData {
    clientId: string;
    clientType: 'vscode' | 'tui' | 'headless' | 'cli' | 'unknown';
    connectedAt: string;
    totalClients: number;
}

/**
 * Client disconnected event data
 */
export interface ClientDisconnectedEventData {
    clientId: string;
    reason: string;
    disconnectedAt: string;
    totalClients: number;
}

/**
 * Error event data
 */
export interface ErrorEventData {
    code: string;
    message: string;
    details?: unknown;
    timestamp: string;
}

/**
 * Task failed after all attempts event data
 * Triggers when a task has exhausted retries or needs user clarity
 */
export interface TaskFailedFinalEventData {
    sessionId: string;
    taskId: string;
    description: string;
    attempts: number;
    lastError: string;
    errorType: 'transient' | 'permanent' | 'unknown' | 'needs_clarity';
    canRetry: boolean;
    clarityQuestion?: string;  // Only if errorType is 'needs_clarity'
    failedAt: string;
}

/**
 * Task paused event data
 * Triggered when tasks are paused due to errors or conflicts
 */
export interface TaskPausedEventData {
    sessionId: string;
    taskIds: string[];
    reason: string;
    timestamp: string;
}

/**
 * Coordinator status changed event data
 * Triggered when coordinator state changes (idle, queuing, evaluating, cooldown)
 */
export interface CoordinatorStatusChangedEventData {
    state: 'idle' | 'queuing' | 'evaluating' | 'cooldown';
    pendingEvents: number;
    lastEvaluation?: string;
    evaluationCount: number;
    timestamp: string;
}

// ============================================================================
// Event Type Map
// ============================================================================

/**
 * Map of event types to their data types for type-safe event handling
 */
export interface ApcEventMap {
    // Session events
    'session.created': SessionCreatedEventData;
    'session.updated': SessionUpdatedEventData;
    'session.deleted': SessionDeletedEventData;
    'session.statusChanged': SessionUpdatedEventData;
    
    // Plan events
    'plan.created': PlanCreatedEventData;
    'plan.updated': PlanUpdatedEventData;
    'plan.approved': PlanApprovedEventData;
    'plan.revised': PlanUpdatedEventData;
    
    // Execution events
    'exec.started': ExecStartedEventData;
    'exec.paused': { sessionId: string; pausedAt: string };
    'exec.resumed': { sessionId: string; resumedAt: string };
    'exec.stopped': { sessionId: string; stoppedAt: string };
    'exec.completed': ExecCompletedEventData;
    
    // Workflow events
    'workflow.started': { workflowId: string; sessionId: string; type: string; startedAt: string };
    'workflow.progress': WorkflowProgressEventData;
    'workflow.completed': WorkflowCompletedEventData;
    'workflow.failed': WorkflowCompletedEventData;
    'workflow.paused': { workflowId: string; sessionId: string; pausedAt: string };
    
    // Workflow cleanup events
    'workflows.cleaned': { sessionId: string; cleanedCount: number; timestamp: string };
    
    // Agent events
    'agent.assigned': AgentAssignedEventData;
    'agent.allocated': AgentAllocatedEventData;
    'agent.released': AgentReleasedEventData;
    'agent.progress': AgentProgressEventData;
    'agent.completed': AgentReleasedEventData;
    'agent.error': AgentErrorEventData;
    
    // Pool events
    'pool.changed': PoolChangedEventData;
    'pool.resized': PoolResizedEventData;
    
    // Unity events
    'unity.taskQueued': UnityTaskQueuedEventData;
    'unity.taskStarted': UnityTaskStartedEventData;
    'unity.taskCompleted': UnityTaskCompletedEventData;
    'unity.taskFailed': UnityTaskCompletedEventData;
    'unity.statusChanged': UnityStatusChangedEventData;
    'unity.pipelineStarted': UnityPipelineStartedEventData;
    'unity.pipelineProgress': UnityPipelineProgressEventData;
    'unity.pipelineCompleted': UnityPipelineCompletedEventData;
    
    // System events
    'daemon.starting': DaemonStartingEventData;
    'daemon.progress': DaemonProgressEventData;
    'daemon.ready': DaemonReadyEventData;
    'daemon.shutdown': DaemonShutdownEventData;
    'daemon.error': DaemonErrorEventData;
    'client.connected': ClientConnectedEventData;
    'client.disconnected': ClientDisconnectedEventData;
    'error': ErrorEventData;
    
    // Task attention events (require user intervention)
    'task.failedFinal': TaskFailedFinalEventData;
    'task.paused': TaskPausedEventData;
    
    // Coordinator events
    'coordinator.statusChanged': CoordinatorStatusChangedEventData;
}

// ============================================================================
// Type-Safe Event Handler
// ============================================================================

/**
 * Type-safe event handler function type
 */
export type TypedEventHandler<T extends keyof ApcEventMap> = (data: ApcEventMap[T]) => void;

/**
 * Generic event handler for any event
 */
export type AnyEventHandler = <T extends keyof ApcEventMap>(event: T, data: ApcEventMap[T]) => void;

// ============================================================================
// Event Utilities
// ============================================================================

/**
 * Check if an event type is session-scoped
 */
export function isSessionScopedEvent(event: ApcEventType): boolean {
    return event.startsWith('session.') ||
           event.startsWith('plan.') ||
           event.startsWith('exec.') ||
           event.startsWith('workflow.') ||
           event.startsWith('agent.') ||
           event.startsWith('task.');
}

/**
 * Check if an event type is a system event
 */
export function isSystemEvent(event: ApcEventType): boolean {
    return event.startsWith('daemon.') ||
           event.startsWith('client.') ||
           event === 'error';
}

/**
 * Get event category from event type
 */
export function getEventCategory(event: ApcEventType): string {
    const parts = event.split('.');
    return parts[0];
}

/**
 * Get event action from event type
 */
export function getEventAction(event: ApcEventType): string {
    const parts = event.split('.');
    return parts[1] || '';
}

