import * as fs from 'fs';
import { PlanParser, ParsedPlan } from './PlanParser';

// ============================================================================
// PlanCache - Mtime-based caching for parsed plans
// ============================================================================

interface CachedPlan {
    plan: ParsedPlan;
    mtimeMs: number;
    cachedAt: number;
}

/**
 * Caches parsed plans to avoid re-parsing on every operation.
 * Uses file modification time (mtime) for invalidation.
 * 
 * Obtain via ServiceLocator:
 *   const cache = ServiceLocator.resolve(PlanCache);
 */
export class PlanCache {
    private cache: Map<string, CachedPlan> = new Map();
    
    // Cache stats for debugging
    private hits = 0;
    private misses = 0;
    
    constructor() {}
    
    /**
     * Get a parsed plan, using cache if available and valid
     * 
     * @param planPath Absolute path to the plan.md file
     * @returns Parsed plan
     * @throws Error if file doesn't exist or can't be parsed
     */
    getPlan(planPath: string): ParsedPlan {
        try {
            const stat = fs.statSync(planPath);
            const cached = this.cache.get(planPath);
            
            // Cache hit - file hasn't been modified
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                this.hits++;
                return cached.plan;
            }
            
            // Cache miss - parse and cache
            this.misses++;
            const plan = PlanParser.parsePlanFile(planPath);
            
            this.cache.set(planPath, {
                plan,
                mtimeMs: stat.mtimeMs,
                cachedAt: Date.now()
            });
            
            return plan;
        } catch (e) {
            // Remove from cache if file is gone or unreadable
            this.cache.delete(planPath);
            throw e;
        }
    }
    
    /**
     * Check if a plan is cached (for debugging/testing)
     */
    isCached(planPath: string): boolean {
        return this.cache.has(planPath);
    }
    
    /**
     * Invalidate a specific plan cache entry
     * Call this after modifying a plan file
     */
    invalidate(planPath: string): void {
        this.cache.delete(planPath);
    }
    
    /**
     * Invalidate all cached plans for a session
     * @param sessionId The session ID to invalidate plans for
     */
    invalidateSession(sessionId: string): void {
        for (const path of this.cache.keys()) {
            if (path.includes(sessionId)) {
                this.cache.delete(path);
            }
        }
    }
    
    /**
     * Clear all cached plans
     */
    clear(): void {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }
    
    /**
     * Get cache statistics
     */
    getStats(): { hits: number; misses: number; hitRate: number; size: number } {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            hitRate: total > 0 ? this.hits / total : 0,
            size: this.cache.size
        };
    }
    
    /**
     * Dispose the cache (for testing/cleanup)
     */
    dispose(): void {
        this.clear();
    }
}

