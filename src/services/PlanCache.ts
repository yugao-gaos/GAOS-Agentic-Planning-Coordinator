import * as fs from 'fs';
import { PlanParser, ParsedPlan } from './PlanParser';

// ============================================================================
// PlanCache - LRU cache with mtime-based invalidation
// ============================================================================

interface CachedPlan {
    plan: ParsedPlan;
    mtimeMs: number;
    cachedAt: number;
    lastAccessed: number;
}

/**
 * LRU cache configuration
 */
interface CacheConfig {
    maxSize: number;        // Maximum number of cached plans
    maxMemoryMB: number;    // Maximum memory usage in MB (approximate)
}

const DEFAULT_CACHE_CONFIG: CacheConfig = {
    maxSize: 50,           // Max 50 plans in memory
    maxMemoryMB: 100       // Max ~100MB of cached plans
};

/**
 * Caches parsed plans to avoid re-parsing on every operation.
 * Uses LRU eviction policy and file modification time (mtime) for invalidation.
 * 
 * Obtain via ServiceLocator:
 *   const cache = ServiceLocator.resolve(PlanCache);
 */
export class PlanCache {
    private cache: Map<string, CachedPlan> = new Map();
    private config: CacheConfig;
    
    // Cache stats for debugging
    private hits = 0;
    private misses = 0;
    private evictions = 0;
    
    constructor(config?: Partial<CacheConfig>) {
        this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    }
    
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
                // Update LRU timestamp
                cached.lastAccessed = Date.now();
                return cached.plan;
            }
            
            // Cache miss - parse and cache
            this.misses++;
            const plan = PlanParser.parsePlanFile(planPath);
            
            // Evict old entries if needed before adding new one
            this.evictIfNeeded();
            
            this.cache.set(planPath, {
                plan,
                mtimeMs: stat.mtimeMs,
                cachedAt: Date.now(),
                lastAccessed: Date.now()
            });
            
            return plan;
        } catch (e) {
            // Remove from cache if file is gone or unreadable
            this.cache.delete(planPath);
            throw e;
        }
    }
    
    /**
     * Evict least recently used entries if cache is full
     */
    private evictIfNeeded(): void {
        // Check size limit
        if (this.cache.size >= this.config.maxSize) {
            // Find LRU entry
            let oldestPath: string | null = null;
            let oldestTime = Date.now();
            
            for (const [path, entry] of this.cache.entries()) {
                if (entry.lastAccessed < oldestTime) {
                    oldestTime = entry.lastAccessed;
                    oldestPath = path;
                }
            }
            
            if (oldestPath) {
                this.cache.delete(oldestPath);
                this.evictions++;
            }
        }
        
        // Optionally check memory limit (rough estimation)
        // Estimate: each plan ~1-5KB, so we check if we're near the limit
        const estimatedMemoryMB = (this.cache.size * 3) / 1024; // Assume avg 3KB per plan
        if (estimatedMemoryMB > this.config.maxMemoryMB) {
            // Evict oldest 10% of cache
            const toEvict = Math.ceil(this.cache.size * 0.1);
            const entries = Array.from(this.cache.entries())
                .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
            
            for (let i = 0; i < toEvict && i < entries.length; i++) {
                this.cache.delete(entries[i][0]);
                this.evictions++;
            }
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
    getStats(): { hits: number; misses: number; hitRate: number; size: number; evictions: number; maxSize: number } {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            hitRate: total > 0 ? this.hits / total : 0,
            size: this.cache.size,
            evictions: this.evictions,
            maxSize: this.config.maxSize
        };
    }
    
    /**
     * Set cache configuration
     */
    setConfig(config: Partial<CacheConfig>): void {
        this.config = { ...this.config, ...config };
        // Evict if new limits require it
        this.evictIfNeeded();
    }
    
    /**
     * Dispose the cache (for testing/cleanup)
     */
    dispose(): void {
        this.clear();
    }
}

