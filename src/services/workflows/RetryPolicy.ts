// ============================================================================
// RetryPolicy - Configurable retry settings for workflows
// ============================================================================

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
    /** Maximum number of retry attempts (default: 3) */
    maxAttempts: number;
    
    /** Base delay between retries in ms (default: 5000) */
    baseDelayMs: number;
    
    /** Maximum delay between retries in ms (default: 60000) */
    maxDelayMs: number;
    
    /** Multiplier for exponential backoff (default: 2) */
    backoffMultiplier: number;
    
    /** Add random jitter to delay to prevent thundering herd (default: true) */
    jitter: boolean;
    
    /** Patterns that indicate transient errors (can retry) */
    retryablePatterns: string[];
    
    /** Patterns that indicate permanent errors (don't retry) */
    permanentPatterns: string[];
}

/**
 * Result of checking if an error is retryable
 */
export interface RetryDecision {
    shouldRetry: boolean;
    reason: string;
    delayMs: number;
    errorType: 'transient' | 'permanent' | 'unknown';
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    baseDelayMs: 5000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
    jitter: true,
    retryablePatterns: [
        // Network/timeout errors
        'timeout',
        'timed out',
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'network error',
        'connection failed',
        'socket hang up',
        
        // Resource errors
        'rate limit',
        'too many requests',
        '429',
        'service unavailable',
        '503',
        'temporarily unavailable',
        
        // Process errors
        'process exited',
        'exit code',
        'killed',
        'SIGTERM',
        
        // API errors
        'API error',
        'server error',
        '500',
        '502',
        '504',
    ],
    permanentPatterns: [
        // Syntax/logic errors
        'syntax error',
        'parse error',
        'invalid',
        'not found',
        '404',
        
        // Permission errors
        'permission denied',
        'unauthorized',
        '401',
        '403',
        'access denied',
        
        // Configuration errors
        'missing required',
        'invalid configuration',
        'not configured',
        
        // Business logic errors
        'already exists',
        'duplicate',
        'conflict',
        'cancelled',
        'aborted',
    ]
};

/**
 * Retry policy configurations for different workflow types
 */
export const WORKFLOW_RETRY_CONFIGS: Record<string, Partial<RetryConfig>> = {
    'task_implementation': {
        maxAttempts: 3,
        baseDelayMs: 10000,  // Longer delay for complex tasks
        maxDelayMs: 120000,
    },
    'planning_new': {
        maxAttempts: 2,
        baseDelayMs: 5000,
    },
    'planning_revision': {
        maxAttempts: 2,
        baseDelayMs: 5000,
    },
    'error_resolution': {
        maxAttempts: 3,
        baseDelayMs: 5000,
    },
};

/**
 * RetryPolicy
 * 
 * Provides retry logic with exponential backoff for workflows.
 * Can be configured per workflow type.
 */
export class RetryPolicy {
    private config: RetryConfig;
    private attemptCount: number = 0;
    private lastError: string | undefined;
    
    constructor(workflowType?: string) {
        // Merge default config with workflow-specific config
        const workflowConfig = workflowType ? WORKFLOW_RETRY_CONFIGS[workflowType] : {};
        this.config = { ...DEFAULT_RETRY_CONFIG, ...workflowConfig };
    }
    
    /**
     * Create a RetryPolicy with custom configuration
     */
    static withConfig(config: Partial<RetryConfig>): RetryPolicy {
        const policy = new RetryPolicy();
        policy.config = { ...DEFAULT_RETRY_CONFIG, ...config };
        return policy;
    }
    
    /**
     * Get the current configuration
     */
    getConfig(): RetryConfig {
        return { ...this.config };
    }
    
    /**
     * Get the current attempt count (0-indexed)
     */
    getAttemptCount(): number {
        return this.attemptCount;
    }
    
    /**
     * Get the maximum number of attempts
     */
    getMaxAttempts(): number {
        return this.config.maxAttempts;
    }
    
    /**
     * Get the last error message
     */
    getLastError(): string | undefined {
        return this.lastError;
    }
    
    /**
     * Record a failed attempt and determine if we should retry
     */
    recordFailure(error: string | Error): RetryDecision {
        this.attemptCount++;
        const errorMessage = error instanceof Error ? error.message : error;
        this.lastError = errorMessage;
        
        // Check if we've exceeded max attempts
        if (this.attemptCount >= this.config.maxAttempts) {
            return {
                shouldRetry: false,
                reason: `Max attempts (${this.config.maxAttempts}) exceeded`,
                delayMs: 0,
                errorType: this.classifyError(errorMessage)
            };
        }
        
        // Classify the error
        const errorType = this.classifyError(errorMessage);
        
        // Don't retry permanent errors
        if (errorType === 'permanent') {
            return {
                shouldRetry: false,
                reason: `Permanent error detected: ${errorMessage.substring(0, 100)}`,
                delayMs: 0,
                errorType
            };
        }
        
        // Calculate delay with exponential backoff
        const delayMs = this.calculateDelay();
        
        return {
            shouldRetry: true,
            reason: `Transient error, retry ${this.attemptCount}/${this.config.maxAttempts}`,
            delayMs,
            errorType
        };
    }
    
    /**
     * Record a successful attempt (resets the policy)
     */
    recordSuccess(): void {
        this.attemptCount = 0;
        this.lastError = undefined;
    }
    
    /**
     * Reset the policy for reuse
     */
    reset(): void {
        this.attemptCount = 0;
        this.lastError = undefined;
    }
    
    /**
     * Check if we have remaining attempts
     */
    hasRemainingAttempts(): boolean {
        return this.attemptCount < this.config.maxAttempts;
    }
    
    /**
     * Classify an error as transient, permanent, or unknown
     */
    classifyError(errorMessage: string): 'transient' | 'permanent' | 'unknown' {
        const lowerError = errorMessage.toLowerCase();
        
        // Check permanent patterns first (more specific)
        for (const pattern of this.config.permanentPatterns) {
            if (lowerError.includes(pattern.toLowerCase())) {
                return 'permanent';
            }
        }
        
        // Check retryable patterns
        for (const pattern of this.config.retryablePatterns) {
            if (lowerError.includes(pattern.toLowerCase())) {
                return 'transient';
            }
        }
        
        // Default to unknown (we'll retry unknown errors)
        return 'unknown';
    }
    
    /**
     * Calculate delay for the current attempt with exponential backoff
     */
    private calculateDelay(): number {
        // Exponential backoff: base * multiplier^attempt
        let delay = this.config.baseDelayMs * 
            Math.pow(this.config.backoffMultiplier, this.attemptCount - 1);
        
        // Cap at max delay
        delay = Math.min(delay, this.config.maxDelayMs);
        
        // Add jitter (±25%) to prevent thundering herd
        if (this.config.jitter) {
            const jitterRange = delay * 0.25;
            delay += (Math.random() * jitterRange * 2) - jitterRange;
        }
        
        return Math.round(delay);
    }
    
    /**
     * Wait for the specified delay
     */
    static async delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

