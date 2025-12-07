/**
 * EventBroadcaster.ts - Centralized event broadcasting for APC daemon
 * 
 * This module provides an event broadcaster that services use
 * to push events to all connected clients. It decouples services from
 * the WebSocket server implementation.
 * 
 * Obtain via ServiceLocator:
 *   const broadcaster = ServiceLocator.resolve(EventBroadcaster);
 */

import { EventEmitter } from 'events';
import { ApcEvent, ApcEventType, createEvent } from '../client/Protocol';
import { ApcEventMap } from '../client/ClientEvents';
import { ServiceLocator } from '../services/ServiceLocator';
import { getMemoryMonitor } from '../services/MemoryMonitor';

// ============================================================================
// Event Broadcaster Interface
// ============================================================================

/**
 * Interface for event broadcasting to connected clients
 */
export interface IEventBroadcaster {
    /**
     * Broadcast an event to all connected clients
     * @param event Event type
     * @param data Event data
     * @param sessionId Optional session ID to scope the event
     */
    broadcast<T extends keyof ApcEventMap>(
        event: T,
        data: ApcEventMap[T],
        sessionId?: string
    ): void;
    
    /**
     * Broadcast an event to a specific client
     * @param clientId Target client ID
     * @param event Event type
     * @param data Event data
     */
    broadcastTo<T extends keyof ApcEventMap>(
        clientId: string,
        event: T,
        data: ApcEventMap[T]
    ): void;
    
    /**
     * Broadcast an event to clients subscribed to a specific session
     * @param sessionId Session to broadcast to
     * @param event Event type
     * @param data Event data
     */
    broadcastToSession<T extends keyof ApcEventMap>(
        sessionId: string,
        event: T,
        data: ApcEventMap[T]
    ): void;
    
    /**
     * Subscribe a client to session events
     */
    subscribeToSession(clientId: string, sessionId: string): void;
    
    /**
     * Unsubscribe a client from session events
     */
    unsubscribeFromSession(clientId: string, sessionId: string): void;
    
    /**
     * Register a broadcast handler (called when broadcasting)
     */
    onBroadcast(handler: (event: ApcEvent, targetClients?: string[]) => void): void;
    
    /**
     * Get event statistics
     */
    getStats(): EventStats;
}

/**
 * Event broadcasting statistics
 */
export interface EventStats {
    totalBroadcasts: number;
    eventCounts: Record<string, number>;
    lastEventAt?: string;
    sessionSubscriptions: Map<string, Set<string>>;
}

// ============================================================================
// Event Broadcaster Implementation
// ============================================================================

/**
 * Event broadcaster for the APC daemon.
 * Services call this to push events, and the daemon's WebSocket server
 * registers a handler to actually send messages to clients.
 */
export class EventBroadcaster extends EventEmitter implements IEventBroadcaster {
    private stats: EventStats = {
        totalBroadcasts: 0,
        eventCounts: {},
        sessionSubscriptions: new Map()
    };
    
    private broadcastHandlers: Array<(event: ApcEvent, targetClients?: string[]) => void> = [];
    
    // Map clientId -> Set of sessionIds they're subscribed to
    private clientSubscriptions: Map<string, Set<string>> = new Map();
    
    // Map sessionId -> Set of clientIds subscribed to it
    private sessionClients: Map<string, Set<string>> = new Map();
    
    constructor() {
        super();
        this.setMaxListeners(100); // Allow many listeners for services
        
        // Register with memory monitor
        const memMonitor = getMemoryMonitor();
        memMonitor.registerService('EventBroadcaster', () => ({
            handlerCount: this.broadcastHandlers.length,
            clientSubscriptions: this.clientSubscriptions.size,
            sessionClients: this.sessionClients.size,
            totalBroadcasts: this.stats.totalBroadcasts
        }));
    }
    
    // ========================================================================
    // Broadcasting Methods
    // ========================================================================
    
    /**
     * Broadcast an event to all connected clients
     */
    broadcast<T extends keyof ApcEventMap>(
        event: T,
        data: ApcEventMap[T],
        sessionId?: string
    ): void {
        const apcEvent = createEvent(event as ApcEventType, data, sessionId);
        
        this.updateStats(event);
        
        // Call registered broadcast handlers
        for (const handler of this.broadcastHandlers) {
            try {
                handler(apcEvent);
            } catch (err) {
                console.error('Broadcast handler error:', err);
            }
        }
        
        // Also emit locally for in-process subscribers
        this.emit(event, data);
        this.emit('*', apcEvent);
    }
    
    /**
     * Broadcast to a specific client
     */
    broadcastTo<T extends keyof ApcEventMap>(
        clientId: string,
        event: T,
        data: ApcEventMap[T]
    ): void {
        const apcEvent = createEvent(event as ApcEventType, data);
        
        this.updateStats(event);
        
        for (const handler of this.broadcastHandlers) {
            try {
                handler(apcEvent, [clientId]);
            } catch (err) {
                console.error('Broadcast handler error:', err);
            }
        }
    }
    
    /**
     * Broadcast to clients subscribed to a session
     */
    broadcastToSession<T extends keyof ApcEventMap>(
        sessionId: string,
        event: T,
        data: ApcEventMap[T]
    ): void {
        const subscribers = this.sessionClients.get(sessionId);
        
        if (!subscribers || subscribers.size === 0) {
            // No subscribers, broadcast to all
            this.broadcast(event, data, sessionId);
            return;
        }
        
        const apcEvent = createEvent(event as ApcEventType, data, sessionId);
        
        this.updateStats(event);
        
        for (const handler of this.broadcastHandlers) {
            try {
                handler(apcEvent, Array.from(subscribers));
            } catch (err) {
                console.error('Broadcast handler error:', err);
            }
        }
    }
    
    // ========================================================================
    // Session Subscriptions
    // ========================================================================
    
    /**
     * Subscribe a client to session events
     */
    subscribeToSession(clientId: string, sessionId: string): void {
        // Update client -> sessions map
        if (!this.clientSubscriptions.has(clientId)) {
            this.clientSubscriptions.set(clientId, new Set());
        }
        this.clientSubscriptions.get(clientId)!.add(sessionId);
        
        // Update session -> clients map
        if (!this.sessionClients.has(sessionId)) {
            this.sessionClients.set(sessionId, new Set());
        }
        this.sessionClients.get(sessionId)!.add(clientId);
        
        // Update stats
        this.stats.sessionSubscriptions = new Map(this.sessionClients);
    }
    
    /**
     * Unsubscribe a client from session events
     */
    unsubscribeFromSession(clientId: string, sessionId: string): void {
        this.clientSubscriptions.get(clientId)?.delete(sessionId);
        this.sessionClients.get(sessionId)?.delete(clientId);
        
        // Cleanup empty sets
        if (this.clientSubscriptions.get(clientId)?.size === 0) {
            this.clientSubscriptions.delete(clientId);
        }
        if (this.sessionClients.get(sessionId)?.size === 0) {
            this.sessionClients.delete(sessionId);
        }
        
        this.stats.sessionSubscriptions = new Map(this.sessionClients);
    }
    
    /**
     * Unsubscribe a client from all sessions (call when client disconnects)
     */
    unsubscribeClient(clientId: string): void {
        const sessions = this.clientSubscriptions.get(clientId);
        if (sessions) {
            for (const sessionId of sessions) {
                this.sessionClients.get(sessionId)?.delete(clientId);
                // Clean up empty session entries to prevent memory leaks
                if (this.sessionClients.get(sessionId)?.size === 0) {
                    this.sessionClients.delete(sessionId);
                }
            }
            // Clear the set to release memory
            sessions.clear();
        }
        this.clientSubscriptions.delete(clientId);
        this.stats.sessionSubscriptions = new Map(this.sessionClients);
    }
    
    /**
     * Unsubscribe all clients from a specific session
     * Call when a session completes to free memory
     */
    unsubscribeSession(sessionId: string): void {
        const clients = this.sessionClients.get(sessionId);
        if (clients) {
            for (const clientId of clients) {
                this.clientSubscriptions.get(clientId)?.delete(sessionId);
                // Clean up empty client entries
                if (this.clientSubscriptions.get(clientId)?.size === 0) {
                    this.clientSubscriptions.delete(clientId);
                }
            }
            clients.clear();
            this.sessionClients.delete(sessionId);
            this.stats.sessionSubscriptions = new Map(this.sessionClients);
        }
    }
    
    /**
     * Clean up orphaned session subscriptions
     * Removes session entries that have no clients subscribed
     * Should be called periodically to prevent memory leaks
     */
    cleanupOrphanedSessions(): void {
        let cleanedCount = 0;
        for (const [sessionId, clients] of this.sessionClients.entries()) {
            if (clients.size === 0) {
                this.sessionClients.delete(sessionId);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            this.stats.sessionSubscriptions = new Map(this.sessionClients);
            console.log(`[EventBroadcaster] Cleaned up ${cleanedCount} orphaned session subscriptions`);
        }
    }
    
    // ========================================================================
    // Handler Registration
    // ========================================================================
    
    /**
     * Register a broadcast handler
     * Called by the WebSocket server to receive events to send
     */
    onBroadcast(handler: (event: ApcEvent, targetClients?: string[]) => void): void {
        this.broadcastHandlers.push(handler);
    }
    
    /**
     * Remove a broadcast handler
     */
    offBroadcast(handler: (event: ApcEvent, targetClients?: string[]) => void): void {
        const index = this.broadcastHandlers.indexOf(handler);
        if (index !== -1) {
            this.broadcastHandlers.splice(index, 1);
        }
    }
    
    /**
     * Remove all broadcast handlers
     * Call this when shutting down to prevent memory leaks
     */
    clearBroadcastHandlers(): void {
        this.broadcastHandlers = [];
    }
    
    // ========================================================================
    // Statistics
    // ========================================================================
    
    /**
     * Get event statistics
     */
    getStats(): EventStats {
        return {
            ...this.stats,
            sessionSubscriptions: new Map(this.stats.sessionSubscriptions)
        };
    }
    
    /**
     * Reset statistics
     */
    resetStats(): void {
        this.stats = {
            totalBroadcasts: 0,
            eventCounts: {},
            sessionSubscriptions: new Map(this.sessionClients)
        };
    }
    
    private updateStats(event: string): void {
        this.stats.totalBroadcasts++;
        this.stats.eventCounts[event] = (this.stats.eventCounts[event] || 0) + 1;
        this.stats.lastEventAt = new Date().toISOString();
    }
    
    // ========================================================================
    // Convenience Methods for Common Events
    // ========================================================================
    
    /**
     * Broadcast session status change
     */
    sessionUpdated(sessionId: string, status: string, previousStatus: string, changes: string[]): void {
        this.broadcast('session.updated', {
            sessionId,
            status,
            previousStatus,
            changes,
            updatedAt: new Date().toISOString()
        }, sessionId);
    }
    
    /**
     * Broadcast workflow progress
     */
    workflowProgress(
        workflowId: string,
        sessionId: string,
        type: string,
        status: string,
        phase: string,
        phaseIndex: number,
        totalPhases: number,
        percentage: number,
        message: string,
        taskId?: string,
        agentName?: string
    ): void {
        this.broadcastToSession(sessionId, 'workflow.progress', {
            workflowId,
            sessionId,
            type,
            status,
            phase,
            phaseIndex,
            totalPhases,
            percentage,
            message,
            taskId,
            agentName,
            updatedAt: new Date().toISOString()
        });
    }
    
    /**
     * Broadcast agent progress (streaming output)
     */
    agentProgress(
        agentName: string,
        sessionId: string,
        coordinatorId: string,
        progress: string,
        outputType?: 'text' | 'thinking' | 'tool' | 'tool_result' | 'error' | 'info',
        outputChunk?: string,
        roleId?: string,
        task?: string
    ): void {
        this.broadcastToSession(sessionId, 'agent.progress', {
            agentName,
            sessionId,
            coordinatorId,
            roleId,
            task,
            progress,
            outputType,
            outputChunk,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Broadcast pool change
     *
     * All 4 agent states are included so UI shows complete pool status:
     * - available: Ready to be allocated
     * - allocated: On bench, assigned to workflow but waiting for work
     * - busy: Actively working on a task
     * - resting: In cooldown after release before becoming available
     */
    poolChanged(
        totalAgents: number,
        available: string[],
        allocated: Array<{ name: string; workflowId: string; roleId?: string }>,
        busy: Array<{ name: string; coordinatorId: string; roleId?: string }>,
        resting: string[]
    ): void {
        this.broadcast('pool.changed', {
            totalAgents,
            available,
            allocated,
            busy,
            resting,
            changedAt: new Date().toISOString()
        });
    }
    
    /**
     * Broadcast Unity status change
     */
    unityStatusChanged(
        status: 'idle' | 'compiling' | 'testing' | 'playing' | 'error',
        isCompiling: boolean,
        isPlaying: boolean,
        isPaused: boolean,
        hasErrors: boolean,
        errorCount: number
    ): void {
        this.broadcast('unity.statusChanged', {
            status,
            isCompiling,
            isPlaying,
            isPaused,
            hasErrors,
            errorCount,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Broadcast Unity pipeline started
     */
    unityPipelineStarted(
        pipelineId: string,
        operations: string[],
        tasksInvolved: Array<{ taskId: string; description: string }>,
        sessionId?: string
    ): void {
        this.broadcast('unity.pipelineStarted', {
            pipelineId,
            sessionId,
            operations,
            tasksInvolved,
            startedAt: new Date().toISOString()
        }, sessionId);
    }
    
    /**
     * Broadcast Unity pipeline progress
     */
    unityPipelineProgress(
        pipelineId: string,
        currentStep: number,
        totalSteps: number,
        currentOperation: string,
        sessionId?: string
    ): void {
        const percentage = Math.round((currentStep / totalSteps) * 100);
        this.broadcast('unity.pipelineProgress', {
            pipelineId,
            sessionId,
            currentStep,
            totalSteps,
            currentOperation,
            percentage,
            timestamp: new Date().toISOString()
        }, sessionId);
    }
    
    /**
     * Broadcast Unity pipeline completed
     */
    unityPipelineCompleted(
        pipelineId: string,
        success: boolean,
        operations: string[],
        errors: Array<{ message: string; source?: string }>,
        testFailures: Array<{ test: string; message: string }>,
        tasksInvolved: Array<{ taskId: string; description: string }>,
        duration: number,
        failedAtStep?: string,
        sessionId?: string
    ): void {
        this.broadcast('unity.pipelineCompleted', {
            pipelineId,
            sessionId,
            success,
            failedAtStep,
            operations,
            errors,
            testFailures,
            tasksInvolved,
            duration,
            completedAt: new Date().toISOString()
        }, sessionId);
    }
    
    /**
     * Broadcast error
     */
    error(code: string, message: string, details?: any): void {
        this.broadcast('error', {
            code,
            message,
            details,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Broadcast coordinator status change
     * Notifies clients when coordinator state changes (idle, queuing, evaluating, cooldown)
     */
    coordinatorStatusChanged(
        state: 'idle' | 'queuing' | 'evaluating' | 'cooldown',
        pendingEvents: number,
        evaluationCount: number,
        lastEvaluation?: string
    ): void {
        this.broadcast('coordinator.statusChanged', {
            state,
            pendingEvents,
            lastEvaluation,
            evaluationCount,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Dispose the broadcaster
     */
    dispose(): void {
        this.removeAllListeners();
        this.broadcastHandlers = [];
        this.clientSubscriptions.clear();
        this.sessionClients.clear();
        // Reset stats to release memory
        this.stats = {
            totalBroadcasts: 0,
            eventCounts: {},
            sessionSubscriptions: new Map()
        };
    }
}

// ============================================================================
// Global Instance Export
// ============================================================================

/**
 * Get the EventBroadcaster instance from ServiceLocator
 * Convenience export for services to use
 */
export function getBroadcaster(): IEventBroadcaster {
    return ServiceLocator.resolve(EventBroadcaster);
}

