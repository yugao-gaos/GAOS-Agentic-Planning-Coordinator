// ============================================================================
// ErrorClassifier - Distinguishes transient vs permanent errors
// ============================================================================

/**
 * Error classification result
 */
export interface ErrorClassification {
    type: 'transient' | 'permanent' | 'unknown';
    category: ErrorCategory;
    confidence: 'high' | 'medium' | 'low';
    suggestedAction: 'retry' | 'fail' | 'escalate' | 'fix_and_retry';
    details: string;
}

/**
 * Error categories for more granular handling
 */
export type ErrorCategory = 
    // Transient categories
    | 'network'
    | 'timeout'
    | 'rate_limit'
    | 'service_unavailable'
    | 'process_crash'
    
    // Permanent categories
    | 'authentication'
    | 'authorization'
    | 'not_found'
    | 'invalid_input'
    | 'configuration'
    | 'compilation'
    | 'test_failure'
    
    // Special
    | 'user_cancelled'
    | 'unknown';

/**
 * Pattern for error classification
 */
interface ErrorPattern {
    patterns: string[];
    category: ErrorCategory;
    type: 'transient' | 'permanent';
    confidence: 'high' | 'medium';
    suggestedAction: ErrorClassification['suggestedAction'];
}

/**
 * Error patterns for classification
 */
const ERROR_PATTERNS: ErrorPattern[] = [
    // === TRANSIENT ERRORS (can retry) ===
    
    // Network errors
    {
        patterns: ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'socket hang up', 'network error'],
        category: 'network',
        type: 'transient',
        confidence: 'high',
        suggestedAction: 'retry'
    },
    
    // Timeout errors
    {
        patterns: ['timeout', 'timed out', 'took too long', 'deadline exceeded'],
        category: 'timeout',
        type: 'transient',
        confidence: 'high',
        suggestedAction: 'retry'
    },
    
    // Rate limiting
    {
        patterns: ['rate limit', 'too many requests', '429', 'throttle', 'quota exceeded'],
        category: 'rate_limit',
        type: 'transient',
        confidence: 'high',
        suggestedAction: 'retry'
    },
    
    // Service unavailable
    {
        patterns: ['503', 'service unavailable', 'temporarily unavailable', 'overloaded', '502', '504'],
        category: 'service_unavailable',
        type: 'transient',
        confidence: 'high',
        suggestedAction: 'retry'
    },
    
    // Process crashes
    {
        patterns: ['process exited', 'exit code', 'crashed', 'SIGKILL', 'SIGTERM', 'killed'],
        category: 'process_crash',
        type: 'transient',
        confidence: 'medium',
        suggestedAction: 'retry'
    },
    
    // === PERMANENT ERRORS (don't retry) ===
    
    // Authentication
    {
        patterns: ['401', 'unauthorized', 'authentication failed', 'invalid token', 'expired token'],
        category: 'authentication',
        type: 'permanent',
        confidence: 'high',
        suggestedAction: 'fail'
    },
    
    // Authorization
    {
        patterns: ['403', 'forbidden', 'permission denied', 'access denied', 'not allowed'],
        category: 'authorization',
        type: 'permanent',
        confidence: 'high',
        suggestedAction: 'fail'
    },
    
    // Not found
    {
        patterns: ['404', 'not found', 'does not exist', 'no such file', 'ENOENT'],
        category: 'not_found',
        type: 'permanent',
        confidence: 'high',
        suggestedAction: 'fail'
    },
    
    // Invalid input
    {
        patterns: ['invalid', 'malformed', 'bad request', '400', 'validation failed', 'syntax error'],
        category: 'invalid_input',
        type: 'permanent',
        confidence: 'medium',
        suggestedAction: 'fix_and_retry'
    },
    
    // Configuration errors
    {
        patterns: ['not configured', 'missing configuration', 'missing required', 'environment variable'],
        category: 'configuration',
        type: 'permanent',
        confidence: 'high',
        suggestedAction: 'fail'
    },
    
    // Compilation errors
    {
        patterns: ['compilation error', 'compile error', 'CS', 'build failed', 'syntax error in'],
        category: 'compilation',
        type: 'permanent',
        confidence: 'high',
        suggestedAction: 'fix_and_retry'
    },
    
    // Test failures
    {
        patterns: ['test failed', 'assertion failed', 'expected', 'actual', 'NUnit', 'XUnit'],
        category: 'test_failure',
        type: 'permanent',
        confidence: 'medium',
        suggestedAction: 'fix_and_retry'
    },
    
    // User cancelled
    {
        patterns: ['cancelled', 'aborted', 'user cancelled', 'interrupted'],
        category: 'user_cancelled',
        type: 'permanent',
        confidence: 'high',
        suggestedAction: 'fail'
    }
];

/**
 * ErrorClassifier
 * 
 * Analyzes error messages to determine if they are transient (can retry)
 * or permanent (should fail without retry).
 * 
 * Obtain via ServiceLocator:
 *   const classifier = ServiceLocator.resolve(ErrorClassifier);
 */
export class ErrorClassifier {
    constructor() {}
    
    /**
     * Classify an error based on its message
     */
    classify(error: string | Error): ErrorClassification {
        const errorMessage = error instanceof Error ? error.message : error;
        const lowerMessage = errorMessage.toLowerCase();
        
        // Try to match against known patterns
        for (const pattern of ERROR_PATTERNS) {
            for (const p of pattern.patterns) {
                if (lowerMessage.includes(p.toLowerCase())) {
                    return {
                        type: pattern.type,
                        category: pattern.category,
                        confidence: pattern.confidence,
                        suggestedAction: pattern.suggestedAction,
                        details: `Matched pattern: "${p}"`
                    };
                }
            }
        }
        
        // Unknown error - default to retry with low confidence
        return {
            type: 'unknown',
            category: 'unknown',
            confidence: 'low',
            suggestedAction: 'retry',
            details: 'No known pattern matched'
        };
    }
    
    /**
     * Quick check if an error is retryable
     */
    isRetryable(error: string | Error): boolean {
        const classification = this.classify(error);
        return classification.type !== 'permanent';
    }
    
    /**
     * Quick check if an error is permanent
     */
    isPermanent(error: string | Error): boolean {
        const classification = this.classify(error);
        return classification.type === 'permanent';
    }
    
    /**
     * Get suggested action for an error
     */
    getSuggestedAction(error: string | Error): ErrorClassification['suggestedAction'] {
        return this.classify(error).suggestedAction;
    }
    
    /**
     * Extract error code from error message if present
     */
    extractErrorCode(error: string | Error): string | undefined {
        const errorMessage = error instanceof Error ? error.message : error;
        
        // Look for common error code patterns
        const patterns = [
            /\b(CS\d{4})\b/,           // C# compiler errors (CS0001, etc.)
            /\b(E[A-Z]+)\b/,            // Node.js errors (ENOENT, ETIMEDOUT, etc.)
            /\b(\d{3})\b/,              // HTTP status codes
            /error[:\s]+(\w+)/i,        // Generic "error: CODE" pattern
        ];
        
        for (const pattern of patterns) {
            const match = errorMessage.match(pattern);
            if (match) {
                return match[1];
            }
        }
        
        return undefined;
    }
    
    /**
     * Create a human-readable summary of the classification
     */
    summarize(error: string | Error): string {
        const classification = this.classify(error);
        const errorCode = this.extractErrorCode(error);
        
        let summary = `[${classification.type.toUpperCase()}] `;
        summary += `Category: ${classification.category}`;
        
        if (errorCode) {
            summary += `, Code: ${errorCode}`;
        }
        
        summary += `, Action: ${classification.suggestedAction}`;
        summary += ` (${classification.confidence} confidence)`;
        
        return summary;
    }
}

import { ServiceLocator } from '../ServiceLocator';

/**
 * Convenience function to classify an error
 */
export function classifyError(error: string | Error): ErrorClassification {
    return ServiceLocator.resolve(ErrorClassifier).classify(error);
}

/**
 * Convenience function to check if error is retryable
 */
export function isRetryable(error: string | Error): boolean {
    return ServiceLocator.resolve(ErrorClassifier).isRetryable(error);
}

/**
 * Convenience function to check if error is permanent
 */
export function isPermanent(error: string | Error): boolean {
    return ServiceLocator.resolve(ErrorClassifier).isPermanent(error);
}

