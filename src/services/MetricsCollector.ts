/**
 * MetricsCollector - Track system metrics for monitoring and debugging
 * 
 * Tracks workflow errors, client connections, UI refreshes, and other metrics
 * to help identify patterns and performance issues.
 */
export class MetricsCollector {
    private metrics = {
        workflowNotFoundErrors: 0,
        clientConnections: 0,
        clientDisconnections: 0,
        workflowsCompleted: 0,
        workflowsCleaned: 0,
        uiRefreshes: 0
    };
    
    private startTime = Date.now();
    
    /**
     * Record a metric event
     */
    record(metric: keyof typeof this.metrics): void {
        this.metrics[metric]++;
    }
    
    /**
     * Get current metrics snapshot
     */
    getMetrics() {
        const uptimeMs = Date.now() - this.startTime;
        const uptimeHours = uptimeMs / 3600000;
        
        return {
            ...this.metrics,
            uptime: uptimeMs,
            uptimeHours: Math.round(uptimeHours * 100) / 100,
            errorsPerHour: uptimeHours > 0 
                ? Math.round((this.metrics.workflowNotFoundErrors / uptimeHours) * 100) / 100 
                : 0,
            connectionsPerHour: uptimeHours > 0
                ? Math.round((this.metrics.clientConnections / uptimeHours) * 100) / 100
                : 0,
            disconnectionsPerHour: uptimeHours > 0
                ? Math.round((this.metrics.clientDisconnections / uptimeHours) * 100) / 100
                : 0
        };
    }
    
    /**
     * Reset all metrics
     */
    reset(): void {
        this.metrics = {
            workflowNotFoundErrors: 0,
            clientConnections: 0,
            clientDisconnections: 0,
            workflowsCompleted: 0,
            workflowsCleaned: 0,
            uiRefreshes: 0
        };
        this.startTime = Date.now();
    }
    
    /**
     * Get metrics summary as string
     */
    getSummary(): string {
        const m = this.getMetrics();
        return `Metrics (${m.uptimeHours}h uptime):
  - Workflow not-found errors: ${m.workflowNotFoundErrors} (${m.errorsPerHour}/hr)
  - Client connections: ${m.clientConnections} (${m.connectionsPerHour}/hr)
  - Client disconnections: ${m.clientDisconnections} (${m.disconnectionsPerHour}/hr)
  - Workflows completed: ${m.workflowsCompleted}
  - Workflows cleaned: ${m.workflowsCleaned}
  - UI refreshes: ${m.uiRefreshes}`;
    }
}









