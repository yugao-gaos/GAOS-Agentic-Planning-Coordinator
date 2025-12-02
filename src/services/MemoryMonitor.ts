/**
 * MemoryMonitor.ts - Memory usage tracking and reporting
 * 
 * Provides utilities to track memory usage across major services
 * and detect potential memory leaks.
 */

/**
 * Memory statistics for a service
 */
export interface ServiceMemoryStats {
    serviceName: string;
    timestamp: string;
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    rss: number;
    customMetrics?: Record<string, number>;
}

/**
 * Memory snapshot across all services
 */
export interface MemorySnapshot {
    timestamp: string;
    totalHeapUsedMB: number;
    totalHeapTotalMB: number;
    externalMB: number;
    rssMB: number;
    services: ServiceMemoryStats[];
}

/**
 * Memory trend detection result
 */
export interface MemoryTrend {
    isGrowing: boolean;
    growthRateMBPerHour: number;
    confidence: 'low' | 'medium' | 'high';
    message: string;
}

/**
 * Memory monitoring configuration
 */
export interface MemoryMonitorConfig {
    /** Enable automatic memory snapshots */
    enableAutoSnapshot: boolean;
    /** Snapshot interval in milliseconds */
    snapshotIntervalMs: number;
    /** Maximum number of snapshots to keep in history */
    maxSnapshots: number;
    /** Memory threshold for warnings (MB) */
    warningThresholdMB: number;
    /** Memory threshold for critical alerts (MB) */
    criticalThresholdMB: number;
}

const DEFAULT_CONFIG: MemoryMonitorConfig = {
    enableAutoSnapshot: true,
    snapshotIntervalMs: 5 * 60 * 1000, // 5 minutes
    maxSnapshots: 100,
    warningThresholdMB: 512,
    criticalThresholdMB: 1024
};

/**
 * MemoryMonitor - Track and analyze memory usage
 */
export class MemoryMonitor {
    private config: MemoryMonitorConfig;
    private snapshots: MemorySnapshot[] = [];
    private snapshotTimer: NodeJS.Timeout | null = null;
    private serviceCallbacks: Map<string, () => Record<string, number>> = new Map();
    
    constructor(config?: Partial<MemoryMonitorConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        if (this.config.enableAutoSnapshot) {
            this.startAutoSnapshot();
        }
    }
    
    // ========================================================================
    // Service Registration
    // ========================================================================
    
    /**
     * Register a service for memory tracking
     * 
     * @param serviceName Unique name for the service
     * @param metricsCallback Function that returns custom metrics for the service
     */
    registerService(serviceName: string, metricsCallback: () => Record<string, number>): void {
        this.serviceCallbacks.set(serviceName, metricsCallback);
    }
    
    /**
     * Unregister a service
     */
    unregisterService(serviceName: string): void {
        this.serviceCallbacks.delete(serviceName);
    }
    
    // ========================================================================
    // Snapshot Management
    // ========================================================================
    
    /**
     * Take a memory snapshot
     */
    takeSnapshot(): MemorySnapshot {
        const memUsage = process.memoryUsage();
        const timestamp = new Date().toISOString();
        
        const services: ServiceMemoryStats[] = [];
        
        // Collect metrics from registered services
        for (const [serviceName, callback] of this.serviceCallbacks) {
            try {
                const customMetrics = callback();
                services.push({
                    serviceName,
                    timestamp,
                    heapUsedMB: memUsage.heapUsed / 1024 / 1024,
                    heapTotalMB: memUsage.heapTotal / 1024 / 1024,
                    externalMB: memUsage.external / 1024 / 1024,
                    rss: memUsage.rss / 1024 / 1024,
                    customMetrics
                });
            } catch (e) {
                console.error(`[MemoryMonitor] Error collecting metrics from ${serviceName}:`, e);
            }
        }
        
        const snapshot: MemorySnapshot = {
            timestamp,
            totalHeapUsedMB: memUsage.heapUsed / 1024 / 1024,
            totalHeapTotalMB: memUsage.heapTotal / 1024 / 1024,
            externalMB: memUsage.external / 1024 / 1024,
            rssMB: memUsage.rss / 1024 / 1024,
            services
        };
        
        // Add to history with sliding window
        this.snapshots.push(snapshot);
        if (this.snapshots.length > this.config.maxSnapshots) {
            this.snapshots.shift();
        }
        
        // Check thresholds
        this.checkThresholds(snapshot);
        
        return snapshot;
    }
    
    /**
     * Get all snapshots
     */
    getSnapshots(): MemorySnapshot[] {
        return [...this.snapshots];
    }
    
    /**
     * Get the most recent snapshot
     */
    getLatestSnapshot(): MemorySnapshot | null {
        return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
    }
    
    /**
     * Clear snapshot history
     */
    clearHistory(): void {
        this.snapshots = [];
    }
    
    // ========================================================================
    // Auto Snapshot
    // ========================================================================
    
    /**
     * Start automatic periodic snapshots
     */
    private startAutoSnapshot(): void {
        if (this.snapshotTimer) {
            return;
        }
        
        // Take initial snapshot
        this.takeSnapshot();
        
        // Schedule periodic snapshots
        this.snapshotTimer = setInterval(() => {
            this.takeSnapshot();
        }, this.config.snapshotIntervalMs);
    }
    
    /**
     * Stop automatic snapshots
     */
    stopAutoSnapshot(): void {
        if (this.snapshotTimer) {
            clearInterval(this.snapshotTimer);
            this.snapshotTimer = null;
        }
    }
    
    // ========================================================================
    // Analysis
    // ========================================================================
    
    /**
     * Analyze memory trend over time
     */
    analyzeTrend(): MemoryTrend {
        if (this.snapshots.length < 2) {
            return {
                isGrowing: false,
                growthRateMBPerHour: 0,
                confidence: 'low',
                message: 'Insufficient data for trend analysis (need at least 2 snapshots)'
            };
        }
        
        // Calculate growth rate using first and last snapshot
        const first = this.snapshots[0];
        const last = this.snapshots[this.snapshots.length - 1];
        
        const memoryDiffMB = last.totalHeapUsedMB - first.totalHeapUsedMB;
        const timeDiffMs = new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
        const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
        
        const growthRateMBPerHour = timeDiffHours > 0 ? memoryDiffMB / timeDiffHours : 0;
        
        // Determine confidence based on number of snapshots and time span
        let confidence: 'low' | 'medium' | 'high' = 'low';
        if (this.snapshots.length >= 20 && timeDiffHours >= 1) {
            confidence = 'high';
        } else if (this.snapshots.length >= 10 && timeDiffHours >= 0.5) {
            confidence = 'medium';
        }
        
        // Determine if growing (threshold: +5MB/hour)
        const isGrowing = growthRateMBPerHour > 5;
        
        let message = '';
        if (isGrowing) {
            message = `Memory growing at ${growthRateMBPerHour.toFixed(2)} MB/hour`;
            if (growthRateMBPerHour > 20) {
                message += ' - CRITICAL growth rate!';
            } else if (growthRateMBPerHour > 10) {
                message += ' - Warning: significant growth';
            }
        } else if (growthRateMBPerHour < -5) {
            message = `Memory shrinking at ${Math.abs(growthRateMBPerHour).toFixed(2)} MB/hour`;
        } else {
            message = 'Memory usage stable';
        }
        
        return {
            isGrowing,
            growthRateMBPerHour,
            confidence,
            message
        };
    }
    
    /**
     * Check memory thresholds and emit warnings
     */
    private checkThresholds(snapshot: MemorySnapshot): void {
        if (snapshot.totalHeapUsedMB > this.config.criticalThresholdMB) {
            console.error(`[MemoryMonitor] CRITICAL: Memory usage at ${snapshot.totalHeapUsedMB.toFixed(2)} MB (threshold: ${this.config.criticalThresholdMB} MB)`);
        } else if (snapshot.totalHeapUsedMB > this.config.warningThresholdMB) {
            console.warn(`[MemoryMonitor] WARNING: Memory usage at ${snapshot.totalHeapUsedMB.toFixed(2)} MB (threshold: ${this.config.warningThresholdMB} MB)`);
        }
    }
    
    /**
     * Get memory statistics summary
     */
    getSummary(): {
        current: MemorySnapshot | null;
        trend: MemoryTrend;
        snapshotCount: number;
        timeSpanHours: number;
    } {
        const current = this.getLatestSnapshot();
        const trend = this.analyzeTrend();
        
        let timeSpanHours = 0;
        if (this.snapshots.length >= 2) {
            const first = this.snapshots[0];
            const last = this.snapshots[this.snapshots.length - 1];
            const timeDiffMs = new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
            timeSpanHours = timeDiffMs / (1000 * 60 * 60);
        }
        
        return {
            current,
            trend,
            snapshotCount: this.snapshots.length,
            timeSpanHours
        };
    }
    
    /**
     * Format summary for logging
     */
    formatSummary(): string {
        const summary = this.getSummary();
        
        if (!summary.current) {
            return 'No memory data available';
        }
        
        const lines = [
            '=== Memory Monitor Summary ===',
            `Current Usage: ${summary.current.totalHeapUsedMB.toFixed(2)} MB / ${summary.current.totalHeapTotalMB.toFixed(2)} MB`,
            `RSS: ${summary.current.rssMB.toFixed(2)} MB`,
            `Snapshots: ${summary.snapshotCount} over ${summary.timeSpanHours.toFixed(2)} hours`,
            `Trend: ${summary.trend.message} (confidence: ${summary.trend.confidence})`,
            '=============================='
        ];
        
        return lines.join('\n');
    }
    
    // ========================================================================
    // Cleanup
    // ========================================================================
    
    /**
     * Dispose the monitor
     */
    dispose(): void {
        this.stopAutoSnapshot();
        this.serviceCallbacks.clear();
        this.snapshots = [];
    }
}

/**
 * Global memory monitor instance
 * Can be accessed from anywhere via ServiceLocator
 */
let globalMonitor: MemoryMonitor | null = null;

/**
 * Get or create the global memory monitor
 */
export function getMemoryMonitor(config?: Partial<MemoryMonitorConfig>): MemoryMonitor {
    if (!globalMonitor) {
        globalMonitor = new MemoryMonitor(config);
    }
    return globalMonitor;
}

/**
 * Dispose global memory monitor
 */
export function disposeMemoryMonitor(): void {
    if (globalMonitor) {
        globalMonitor.dispose();
        globalMonitor = null;
    }
}

