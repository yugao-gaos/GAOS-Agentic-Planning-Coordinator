/**
 * TaskIdValidator.ts - Single source of truth for task ID validation and normalization
 * 
 * This service provides centralized validation for:
 * - Session IDs: PS_XXXXXX format (e.g., PS_000001)
 * - Global Task IDs: PS_XXXXXX_<taskPart> format (e.g., PS_000001_T1, PS_000001_T7_TEST)
 * 
 * NOTE: Simple IDs (T1, CTX1) are NOT supported. All task IDs must be in global format.
 * 
 * All validation methods are static for convenience, but the class is registered
 * with ServiceLocator for consistency with the project's service pattern.
 */

/**
 * Result of task ID validation
 */
export interface TaskIdValidationResult {
    /** Whether the ID is valid */
    valid: boolean;
    /** Error message if invalid */
    error?: string;
    /** Normalized ID in uppercase (if valid) */
    normalizedId?: string;
    /** Session part extracted (e.g., "PS_000001") */
    sessionPart?: string;
    /** Task part extracted (e.g., "T1", "T7_TEST") */
    taskPart?: string;
}

/**
 * Result of session ID validation
 */
export interface SessionIdValidationResult {
    /** Whether the session ID is valid */
    valid: boolean;
    /** Error message if invalid */
    error?: string;
    /** Normalized session ID in uppercase (if valid) */
    normalizedId?: string;
}

/**
 * TaskIdValidator - Centralized task ID validation service
 * 
 * Regex patterns explained:
 * - Session: /^ps_\d{6}$/i matches "PS_" followed by exactly 6 digits
 * - Task part pattern: T followed by digits, optional letter suffix (T7A), optional underscore suffix (T24_EVENTS)
 *   - T1, T2, T24 (simple numbered tasks)
 *   - T7A, T24B (sub-tasks with letter suffix)
 *   - T24_EVENTS, T15_TEST, T47_PLAYMODE (tasks with underscore + alphabetic suffix)
 *   - CTX1, CTX2 (context tasks)
 * 
 * IMPORTANT: Only global format is supported. Simple IDs like "T1" are rejected.
 * IMPORTANT: Suffixes MUST be preceded by underscore (T24_EVENTS not T24EVENTS).
 */
export class TaskIdValidator {
    // ========================================================================
    // Regex Patterns - Single source of truth
    // ========================================================================
    
    /** Session ID pattern: PS_XXXXXX (6 digits) */
    static readonly SESSION_PATTERN = /^ps_\d{6}$/i;
    
    /**
     * Task part pattern (used in global task ID validation)
     * Matches:
     * - T followed by digits: T1, T24
     * - Optional single letter suffix for sub-tasks: T7A, T24B
     * - Optional underscore + alphabetic suffix: T24_EVENTS, T15_TEST
     * - CTX followed by digits: CTX1, CTX2
     */
    static readonly TASK_PART_PATTERN = /^(T\d+[A-Z]?(?:_[A-Z]+)?|CTX\d+)$/i;
    
    /** Global task ID pattern: PS_XXXXXX_<taskPart> with strict task part validation */
    static readonly GLOBAL_TASK_PATTERN = /^(ps_\d{6})_(T\d+[A-Z]?(?:_[A-Z]+)?|CTX\d+)$/i;
    
    /** Global task ID pattern for extraction (non-anchored, for parsing text) */
    static readonly GLOBAL_TASK_EXTRACT_PATTERN = /(ps_\d{6})_(T\d+[A-Z]?(?:_[A-Z]+)?|CTX\d+)/i;

    // ========================================================================
    // Session ID Validation
    // ========================================================================
    
    /**
     * Validate a session ID (PS_XXXXXX format)
     * 
     * @param sessionId The session ID to validate
     * @returns Validation result with normalized ID if valid
     */
    static validateSessionId(sessionId: string): SessionIdValidationResult {
        if (!sessionId) {
            return { valid: false, error: 'Session ID is required' };
        }
        
        const trimmed = sessionId.trim();
        
        if (!this.SESSION_PATTERN.test(trimmed)) {
            return { 
                valid: false, 
                error: `Invalid sessionId "${sessionId}": Must match format "PS_XXXXXX" (e.g., "PS_000001")` 
            };
        }
        
        return { 
            valid: true, 
            normalizedId: trimmed.toUpperCase() 
        };
    }
    
    /**
     * Check if a string is a valid session ID
     */
    static isValidSessionId(sessionId: string): boolean {
        return this.SESSION_PATTERN.test(sessionId?.trim() || '');
    }

    // ========================================================================
    // Global Task ID Validation
    // ========================================================================
    
    /**
     * Validate a global task ID (PS_XXXXXX_TN format)
     * 
     * @param taskId The task ID to validate
     * @returns Validation result with normalized ID and extracted parts if valid
     */
    static validateGlobalTaskId(taskId: string): TaskIdValidationResult {
        if (!taskId) {
            return { valid: false, error: 'Task ID is required' };
        }
        
        const trimmed = taskId.trim();
        const match = trimmed.match(this.GLOBAL_TASK_PATTERN);
        
        if (!match) {
            return { 
                valid: false, 
                error: `Invalid taskId "${taskId}": Must be global format PS_XXXXXX_TN (e.g., "PS_000001_T1", "PS_000001_T7A", "PS_000001_T24_EVENTS"). Suffixes require underscore separator.` 
            };
        }
        
        const [, sessionPart, taskPart] = match;
        const normalizedSession = sessionPart.toUpperCase();
        const normalizedTask = taskPart.toUpperCase();
        
        return { 
            valid: true, 
            normalizedId: `${normalizedSession}_${normalizedTask}`,
            sessionPart: normalizedSession,
            taskPart: normalizedTask
        };
    }
    
    /**
     * Check if a string is a valid global task ID
     */
    static isValidGlobalTaskId(taskId: string): boolean {
        return this.GLOBAL_TASK_PATTERN.test(taskId?.trim() || '');
    }
    
    /**
     * Normalize a global task ID to uppercase.
     * Returns null if the ID is not in valid global format.
     * 
     * This is the primary normalization method - only does uppercase, no prefix adding.
     */
    static normalizeGlobalTaskId(taskId: string): string | null {
        const result = this.validateGlobalTaskId(taskId);
        return result.valid ? result.normalizedId! : null;
    }
    
    /**
     * Alias for normalizeGlobalTaskId for backward compatibility.
     * Only accepts global format PS_XXXXXX_TN.
     */
    static normalizeTaskId(taskId: string): string | null {
        return this.normalizeGlobalTaskId(taskId);
    }

    // ========================================================================
    // Extraction Utilities (for parsing text)
    // ========================================================================
    
    /**
     * Extract a global task ID from text (non-anchored)
     * Useful for parsing dependencies or finding task IDs in strings
     * 
     * @param text Text that may contain a global task ID
     * @returns Normalized ID if found, null otherwise
     */
    static extractGlobalTaskId(text: string): string | null {
        if (!text) return null;
        
        const match = text.match(this.GLOBAL_TASK_EXTRACT_PATTERN);
        if (match) {
            return `${match[1].toUpperCase()}_${match[2].toUpperCase()}`;
        }
        
        return null;
    }

    // ========================================================================
    // Validation with Session Context
    // ========================================================================
    
    /**
     * Validate that a global task ID belongs to a specific session
     * 
     * @param taskId The global task ID to validate
     * @param expectedSessionId The expected session ID
     * @returns Validation result
     */
    static validateTaskIdForSession(taskId: string, expectedSessionId: string): TaskIdValidationResult {
        const result = this.validateGlobalTaskId(taskId);
        
        if (!result.valid) {
            return result;
        }
        
        const normalizedExpectedSession = expectedSessionId.toUpperCase();
        
        if (result.sessionPart !== normalizedExpectedSession) {
            return {
                valid: false,
                error: `Invalid taskId "${taskId}": Session prefix "${result.sessionPart}" doesn't match expected session "${normalizedExpectedSession}"`
            };
        }
        
        return result;
    }
    
    /**
     * Check for double-prefix error (e.g., PS_000001_PS_000001_T1)
     * 
     * @param taskId The task ID to check
     * @param sessionId The current session ID
     * @returns Error message if double-prefix detected, undefined otherwise
     */
    static checkDoublePrefix(taskId: string, sessionId: string): string | undefined {
        const normalizedSession = sessionId.toUpperCase();
        const normalizedTaskId = taskId.toUpperCase();
        
        if (normalizedTaskId.startsWith(`${normalizedSession}_${normalizedSession}_`)) {
            return `Invalid taskId "${taskId}": Contains double session prefix. Use global format "${normalizedSession}_T1"`;
        }
        
        return undefined;
    }

    // ========================================================================
    // Task Part Validation (for parsers)
    // ========================================================================
    
    /**
     * Validate just the task part (without session prefix)
     * Useful for parsers that extract task IDs from markdown
     * 
     * Valid formats:
     * - T1, T24 (simple numbered)
     * - T7A, T24B (sub-tasks with letter suffix)
     * - T24_EVENTS, T15_TEST (tasks with underscore + alphabetic suffix)
     * - CTX1, CTX2 (context tasks)
     * 
     * Invalid formats:
     * - T24EVENTS (missing underscore before suffix)
     * - T7AB (multiple letters without underscore)
     * 
     * @param taskPart The task part to validate (e.g., "T1", "T24_EVENTS")
     * @returns true if valid, false otherwise
     */
    static isValidTaskPart(taskPart: string): boolean {
        if (!taskPart) return false;
        return this.TASK_PART_PATTERN.test(taskPart.trim());
    }
    
    /**
     * Normalize a task part to uppercase if valid, null otherwise
     * 
     * @param taskPart The task part to normalize
     * @returns Normalized task part or null if invalid
     */
    static normalizeTaskPart(taskPart: string): string | null {
        if (!taskPart) return null;
        const trimmed = taskPart.trim();
        if (!this.TASK_PART_PATTERN.test(trimmed)) {
            return null;
        }
        return trimmed.toUpperCase();
    }

    // ========================================================================
    // Formatting Utilities
    // ========================================================================
    
    /**
     * Get a human-readable format example for error messages
     */
    static getFormatExample(sessionId?: string): string {
        const session = sessionId?.toUpperCase() || 'PS_000001';
        return `${session}_T1, ${session}_T7A, ${session}_T24_EVENTS`;
    }
}
