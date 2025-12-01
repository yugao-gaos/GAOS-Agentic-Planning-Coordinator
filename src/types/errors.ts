// ============================================================================
// APC Error Types - Typed Error Hierarchy
// ============================================================================

/**
 * Base error class for all APC errors.
 * Provides error code and optional context for debugging.
 */
export class ApcError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly context?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'ApcError';
        // Maintains proper stack trace for where error was thrown (V8 only)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }

    /**
     * Format error for logging with context
     */
    toLogString(): string {
        const contextStr = this.context ? ` Context: ${JSON.stringify(this.context)}` : '';
        return `[${this.code}] ${this.message}${contextStr}`;
    }
}

// ============================================================================
// Session Errors
// ============================================================================

/**
 * Error thrown when a planning session is not found
 */
export class SessionNotFoundError extends ApcError {
    constructor(sessionId: string, context?: Record<string, unknown>) {
        super(`Planning session '${sessionId}' not found`, 'SESSION_NOT_FOUND', {
            sessionId,
            ...context
        });
        this.name = 'SessionNotFoundError';
    }
}

/**
 * Error thrown when a session is in an invalid state for the requested operation
 */
export class SessionStateError extends ApcError {
    constructor(
        sessionId: string,
        currentState: string,
        expectedStates: string[],
        operation: string,
        context?: Record<string, unknown>
    ) {
        super(
            `Cannot ${operation}: session '${sessionId}' is in '${currentState}' state, expected one of: ${expectedStates.join(', ')}`,
            'SESSION_INVALID_STATE',
            { sessionId, currentState, expectedStates, operation, ...context }
        );
        this.name = 'SessionStateError';
    }
}

// ============================================================================
// Workflow Errors
// ============================================================================

/**
 * Error thrown when a workflow operation fails
 */
export class WorkflowError extends ApcError {
    constructor(
        message: string,
        workflowId: string,
        workflowType: string,
        context?: Record<string, unknown>
    ) {
        super(message, 'WORKFLOW_ERROR', { workflowId, workflowType, ...context });
        this.name = 'WorkflowError';
    }
}

/**
 * Error thrown when a workflow is not found
 */
export class WorkflowNotFoundError extends ApcError {
    constructor(workflowId: string, sessionId?: string, context?: Record<string, unknown>) {
        super(`Workflow '${workflowId}' not found`, 'WORKFLOW_NOT_FOUND', {
            workflowId,
            sessionId,
            ...context
        });
        this.name = 'WorkflowNotFoundError';
    }
}

/**
 * Error thrown when there's a conflict between workflows (e.g., task occupancy)
 */
export class WorkflowConflictError extends ApcError {
    constructor(
        message: string,
        conflictingWorkflowIds: string[],
        taskIds: string[],
        context?: Record<string, unknown>
    ) {
        super(message, 'WORKFLOW_CONFLICT', {
            conflictingWorkflowIds,
            taskIds,
            ...context
        });
        this.name = 'WorkflowConflictError';
    }
}

// ============================================================================
// State Errors
// ============================================================================

/**
 * Error thrown when state operations fail (load, save, etc.)
 */
export class StateError extends ApcError {
    constructor(
        message: string,
        operation: 'load' | 'save' | 'delete' | 'lock',
        context?: Record<string, unknown>
    ) {
        super(message, `STATE_${operation.toUpperCase()}_ERROR`, { operation, ...context });
        this.name = 'StateError';
    }
}

/**
 * Error thrown when file lock cannot be acquired
 */
export class LockError extends ApcError {
    constructor(resource: string, timeoutMs: number, context?: Record<string, unknown>) {
        super(
            `Failed to acquire lock on '${resource}' within ${timeoutMs}ms`,
            'LOCK_TIMEOUT',
            { resource, timeoutMs, ...context }
        );
        this.name = 'LockError';
    }
}

// ============================================================================
// Validation Errors
// ============================================================================

/**
 * Error thrown when validation fails
 */
export class ValidationError extends ApcError {
    constructor(
        message: string,
        field: string,
        value?: unknown,
        context?: Record<string, unknown>
    ) {
        super(message, 'VALIDATION_ERROR', { field, value, ...context });
        this.name = 'ValidationError';
    }
}

/**
 * Error thrown when plan format validation fails
 */
export class PlanValidationError extends ApcError {
    constructor(
        planPath: string,
        issues: string[],
        context?: Record<string, unknown>
    ) {
        super(
            `Plan validation failed: ${issues.length} issue(s) found`,
            'PLAN_VALIDATION_ERROR',
            { planPath, issues, ...context }
        );
        this.name = 'PlanValidationError';
    }
}

// ============================================================================
// Task Errors
// ============================================================================

/**
 * Error thrown when a task is not found
 */
export class TaskNotFoundError extends ApcError {
    constructor(taskId: string, sessionId?: string, context?: Record<string, unknown>) {
        super(`Task '${taskId}' not found`, 'TASK_NOT_FOUND', {
            taskId,
            sessionId,
            ...context
        });
        this.name = 'TaskNotFoundError';
    }
}

/**
 * Error thrown when a task operation fails
 */
export class TaskError extends ApcError {
    constructor(
        message: string,
        taskId: string,
        operation: string,
        context?: Record<string, unknown>
    ) {
        super(message, 'TASK_ERROR', { taskId, operation, ...context });
        this.name = 'TaskError';
    }
}

// ============================================================================
// Agent Errors
// ============================================================================

/**
 * Error thrown when no agent is available in the pool
 */
export class NoAgentAvailableError extends ApcError {
    constructor(roleId: string, context?: Record<string, unknown>) {
        super(
            `No agent available for role '${roleId}'`,
            'NO_AGENT_AVAILABLE',
            { roleId, ...context }
        );
        this.name = 'NoAgentAvailableError';
    }
}

/**
 * Error thrown when an agent is not found
 */
export class AgentNotFoundError extends ApcError {
    constructor(agentName: string, context?: Record<string, unknown>) {
        super(`Agent '${agentName}' not found`, 'AGENT_NOT_FOUND', {
            agentName,
            ...context
        });
        this.name = 'AgentNotFoundError';
    }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if an error is an ApcError
 */
export function isApcError(error: unknown): error is ApcError {
    return error instanceof ApcError;
}

/**
 * Check if an error is a specific ApcError by code
 */
export function isApcErrorWithCode(error: unknown, code: string): error is ApcError {
    return isApcError(error) && error.code === code;
}

/**
 * Wrap an unknown error as an ApcError
 */
export function wrapError(error: unknown, code: string, context?: Record<string, unknown>): ApcError {
    if (isApcError(error)) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ApcError(message, code, { originalError: error, ...context });
}

