/**
 * ApcClient.ts - Abstract client interface for APC daemon communication
 * 
 * This interface defines how any UI (VS Code, TUI, headless) communicates
 * with the APC daemon server. Implementations handle the actual WebSocket
 * connection and message serialization.
 */

import { EventEmitter } from 'events';
import {
    ApcRequest,
    ApcResponse,
    ApcEvent,
    ApcEventType,
    StatusResponse,
    SessionListResponse,
    SessionStatusResponse,
    PlanListResponse,
    PlanCreateResponse,
    ExecStartResponse,
    ExecStatusResponse,
    PoolStatusResponse,
    PoolResizeResponse,
    AgentPoolResponse,
    AgentRolesResponse,
    UnityStatusResponse,
    WorkflowSummaryData
} from './Protocol';

// ============================================================================
// Client Interface
// ============================================================================

/**
 * Abstract client interface for APC daemon communication.
 * Implementations: VsCodeClient, TuiClient, HeadlessClient
 */
export interface IApcClient {
    // ========================================================================
    // Connection Management
    // ========================================================================
    
    /**
     * Connect to the APC daemon
     * @param url Optional WebSocket URL (default: ws://127.0.0.1:19840)
     * @returns Promise that resolves when connected
     */
    connect(url?: string): Promise<void>;
    
    /**
     * Disconnect from the daemon
     */
    disconnect(): void;
    
    /**
     * Check if currently connected
     */
    isConnected(): boolean;
    
    /**
     * Get connection state
     */
    getConnectionState(): ConnectionState;
    
    // ========================================================================
    // Command Execution
    // ========================================================================
    
    /**
     * Send a command and wait for response
     * @param cmd Command string (e.g., 'pool.status', 'session.create')
     * @param params Command parameters
     * @returns Promise with response data
     */
    send<T = any>(cmd: string, params?: Record<string, any>): Promise<T>;
    
    /**
     * Send a request without waiting for response (fire-and-forget)
     */
    sendAsync(cmd: string, params?: Record<string, any>): void;
    
    // ========================================================================
    // Event Handling
    // ========================================================================
    
    /**
     * Subscribe to a specific event type
     * @param event Event type to listen for
     * @param handler Callback function
     * @returns Unsubscribe function
     */
    on(event: ApcEventType | 'connected' | 'disconnected' | 'error', handler: (data: any) => void): () => void;
    
    /**
     * Subscribe to all events
     * @param handler Callback for any event
     * @returns Unsubscribe function
     */
    onAny(handler: (event: ApcEvent) => void): () => void;
    
    /**
     * Remove event listener
     */
    off(event: string, handler: (...args: any[]) => void): void;
}

// ============================================================================
// Connection State
// ============================================================================

export type ConnectionState = 
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'error';

// ============================================================================
// Client Options
// ============================================================================

export interface ApcClientOptions {
    /** WebSocket URL (default: ws://127.0.0.1:19840) */
    url?: string;
    /** Auto-reconnect on disconnect (default: true) */
    autoReconnect?: boolean;
    /** Reconnect delay in ms (default: 1000) */
    reconnectDelay?: number;
    /** Maximum reconnect attempts (default: 10) */
    maxReconnectAttempts?: number;
    /** Request timeout in ms (default: 30000) */
    requestTimeout?: number;
    /** Client identifier for logging */
    clientId?: string;
}

export const DEFAULT_CLIENT_OPTIONS: Required<ApcClientOptions> = {
    url: 'ws://127.0.0.1:19840',
    autoReconnect: true,
    reconnectDelay: 1000,
    maxReconnectAttempts: 10,
    requestTimeout: 30000,
    clientId: 'apc-client'
};

// ============================================================================
// Base Client Implementation
// ============================================================================

/**
 * Base abstract class that implements common client functionality.
 * Concrete implementations (VsCodeClient, etc.) extend this.
 */
export abstract class BaseApcClient extends EventEmitter implements IApcClient {
    protected options: Required<ApcClientOptions>;
    protected state: ConnectionState = 'disconnected';
    protected reconnectAttempts: number = 0;
    protected pendingRequests: Map<string, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    }> = new Map();
    
    constructor(options: ApcClientOptions = {}) {
        super();
        this.options = { ...DEFAULT_CLIENT_OPTIONS, ...options };
    }
    
    // ========================================================================
    // Abstract Methods (implemented by concrete clients)
    // ========================================================================
    
    abstract connect(url?: string): Promise<void>;
    abstract disconnect(): void;
    protected abstract sendRaw(data: string): void;
    
    // ========================================================================
    // Connection State
    // ========================================================================
    
    isConnected(): boolean {
        return this.state === 'connected';
    }
    
    getConnectionState(): ConnectionState {
        return this.state;
    }
    
    protected setState(state: ConnectionState): void {
        const oldState = this.state;
        this.state = state;
        if (oldState !== state) {
            this.emit('stateChanged', { oldState, newState: state });
        }
    }
    
    // ========================================================================
    // Command Execution
    // ========================================================================
    
    async send<T = any>(cmd: string, params?: Record<string, any>): Promise<T> {
        if (!this.isConnected()) {
            throw new Error('Not connected to APC daemon');
        }
        
        const request: ApcRequest = {
            id: this.generateRequestId(),
            cmd,
            params,
            clientId: this.options.clientId
        };
        
        return new Promise<T>((resolve, reject) => {
            // Set up timeout
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(request.id);
                reject(new Error(`Request timeout for ${cmd}`));
            }, this.options.requestTimeout);
            
            // Store pending request
            this.pendingRequests.set(request.id, { resolve, reject, timeout });
            
            // Send request
            try {
                this.sendRaw(JSON.stringify({ type: 'request', payload: request }));
            } catch (err) {
                clearTimeout(timeout);
                this.pendingRequests.delete(request.id);
                reject(err);
            }
        });
    }
    
    sendAsync(cmd: string, params?: Record<string, any>): void {
        if (!this.isConnected()) {
            console.warn('Not connected to APC daemon, dropping async message');
            return;
        }
        
        const request: ApcRequest = {
            id: this.generateRequestId(),
            cmd,
            params,
            clientId: this.options.clientId
        };
        
        try {
            this.sendRaw(JSON.stringify({ type: 'request', payload: request }));
        } catch (err) {
            console.error('Failed to send async message:', err);
        }
    }
    
    // ========================================================================
    // Event Handling
    // ========================================================================
    
    /**
     * Subscribe to an event. Returns an unsubscribe function.
     */
    subscribe(event: ApcEventType | 'connected' | 'disconnected' | 'error' | string, handler: (data: any) => void): () => void {
        super.on(event, handler);
        return () => super.removeListener(event, handler);
    }
    
    /**
     * Subscribe to all events. Returns an unsubscribe function.
     */
    subscribeAll(handler: (event: ApcEvent) => void): () => void {
        const wrapper = (event: ApcEvent) => handler(event);
        super.on('*', wrapper);
        return () => super.removeListener('*', wrapper);
    }
    
    // Implement IApcClient interface methods using the subscribe methods
    // @ts-ignore - Return type differs from EventEmitter but matches IApcClient
    on(event: ApcEventType | 'connected' | 'disconnected' | 'error' | string, handler: (data: any) => void): () => void {
        return this.subscribe(event, handler);
    }
    
    onAny(handler: (event: ApcEvent) => void): () => void {
        return this.subscribeAll(handler);
    }
    
    // @ts-ignore - Return type differs from EventEmitter but matches IApcClient
    off(event: string, handler: (...args: any[]) => void): void {
        super.removeListener(event, handler);
    }
    
    // ========================================================================
    // Message Handling
    // ========================================================================
    
    protected handleMessage(data: string): void {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'response') {
                this.handleResponse(message.payload as ApcResponse);
            } else if (message.type === 'event') {
                this.handleEvent(message.payload as ApcEvent);
            } else {
                console.warn('Unknown message type:', message.type);
            }
        } catch (err) {
            console.error('Failed to parse message:', err);
        }
    }
    
    protected handleResponse(response: ApcResponse): void {
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(response.id);
            
            if (response.success) {
                pending.resolve(response.data);
            } else {
                pending.reject(new Error(response.error || 'Unknown error'));
            }
        }
    }
    
    protected handleEvent(event: ApcEvent): void {
        // Emit specific event
        this.emit(event.event, event.data);
        // Emit wildcard for onAny subscribers
        this.emit('*', event);
    }
    
    // ========================================================================
    // Reconnection Logic
    // ========================================================================
    
    protected async attemptReconnect(): Promise<void> {
        if (!this.options.autoReconnect) {
            return;
        }
        
        if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
            this.setState('error');
            this.emit('error', new Error('Max reconnect attempts reached'));
            return;
        }
        
        this.reconnectAttempts++;
        this.setState('reconnecting');
        
        await this.delay(this.options.reconnectDelay * this.reconnectAttempts);
        
        try {
            await this.connect();
            this.reconnectAttempts = 0;
        } catch (err) {
            console.warn(`Reconnect attempt ${this.reconnectAttempts} failed:`, err);
            this.attemptReconnect();
        }
    }
    
    protected resetReconnectAttempts(): void {
        this.reconnectAttempts = 0;
    }
    
    // ========================================================================
    // Utilities
    // ========================================================================
    
    protected generateRequestId(): string {
        return `${this.options.clientId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
    
    protected delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // ========================================================================
    // Cleanup
    // ========================================================================
    
    dispose(): void {
        // Cancel all pending requests
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Client disposed'));
        }
        this.pendingRequests.clear();
        
        // Disconnect
        this.disconnect();
        
        // Remove all listeners
        this.removeAllListeners();
    }
}

// ============================================================================
// Convenience Methods Interface
// ============================================================================

/**
 * Extended client interface with typed convenience methods.
 * Implementations can optionally implement these for better DX.
 */
export interface IApcClientExtended extends IApcClient {
    // Status
    getStatus(): Promise<StatusResponse>;
    
    // Sessions
    listSessions(): Promise<SessionListResponse>;
    getSessionStatus(id: string): Promise<SessionStatusResponse>;
    pauseSession(id: string): Promise<void>;
    resumeSession(id: string): Promise<void>;
    
    // Plans
    listPlans(): Promise<PlanListResponse>;
    createPlan(prompt: string, docs?: string[]): Promise<PlanCreateResponse>;
    approvePlan(id: string, autoStart?: boolean): Promise<void>;
    revisePlan(id: string, feedback: string): Promise<void>;
    cancelPlan(id: string): Promise<void>;
    
    // Execution
    startExecution(sessionId: string): Promise<ExecStartResponse>;
    pauseExecution(sessionId: string): Promise<void>;
    resumeExecution(sessionId: string): Promise<void>;
    stopExecution(sessionId: string): Promise<void>;
    getExecutionStatus(sessionId: string): Promise<ExecStatusResponse>;
    
    // Pool
    getPoolStatus(): Promise<PoolStatusResponse>;
    resizePool(size: number): Promise<PoolResizeResponse>;
    
    // Agents
    getAgentPool(): Promise<AgentPoolResponse>;
    getAgentRoles(): Promise<AgentRolesResponse>;
    releaseAgent(agentName: string): Promise<void>;
    
    // Unity
    getUnityStatus(): Promise<UnityStatusResponse>;
}

