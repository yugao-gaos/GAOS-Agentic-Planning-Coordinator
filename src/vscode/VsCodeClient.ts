/**
 * VsCodeClient.ts - WebSocket client for VS Code extension
 * 
 * This implements the IApcClient interface for the VS Code extension.
 * It connects to the APC daemon and handles request/response/events.
 */

import WebSocket from 'ws';
import { 
    BaseApcClient, 
    ApcClientOptions, 
    ConnectionState,
    DEFAULT_CLIENT_OPTIONS
} from '../client/ApcClient';
import {
    ApcRequest,
    ApcResponse,
    ApcEvent,
    StatusResponse,
    SessionListResponse,
    PlanCreateResponse,
    PoolStatusResponse,
    UnityStatusResponse
} from '../client/Protocol';

/**
 * VS Code specific client options
 */
export interface VsCodeClientOptions extends ApcClientOptions {
    /** Show notifications for connection events */
    showNotifications?: boolean;
}

/**
 * WebSocket client implementation for VS Code extension
 */
export class VsCodeClient extends BaseApcClient {
    private ws: WebSocket | null = null;
    private showNotifications: boolean;
    
    // VS Code notification callbacks (set by extension)
    private notificationCallbacks: {
        showInfo?: (msg: string) => void;
        showWarning?: (msg: string) => void;
        showError?: (msg: string) => void;
    } = {};
    
    constructor(options: VsCodeClientOptions = {}) {
        super({
            ...options,
            clientId: options.clientId || 'vscode-client'
        });
        this.showNotifications = options.showNotifications ?? true;
    }
    
    /**
     * Set notification callbacks for VS Code integration
     */
    setNotificationCallbacks(callbacks: {
        showInfo?: (msg: string) => void;
        showWarning?: (msg: string) => void;
        showError?: (msg: string) => void;
    }): void {
        this.notificationCallbacks = callbacks;
    }
    
    /**
     * Connect to the APC daemon
     */
    async connect(url?: string): Promise<void> {
        if (this.state === 'connected' || this.state === 'connecting') {
            return;
        }
        
        const targetUrl = url || this.options.url;
        this.setState('connecting');
        
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(targetUrl, {
                    headers: {
                        'X-APC-Client-Type': 'vscode'
                    }
                });
                
                this.ws.on('open', () => {
                    this.setState('connected');
                    this.resetReconnectAttempts();
                    this.emit('connected');
                    
                    if (this.showNotifications && this.notificationCallbacks.showInfo) {
                        this.notificationCallbacks.showInfo('Connected to APC daemon');
                    }
                    
                    resolve();
                });
                
                this.ws.on('message', (data) => {
                    this.handleMessage(data.toString());
                });
                
                this.ws.on('close', (code, reason) => {
                    const wasConnected = this.state === 'connected';
                    this.ws = null;
                    this.setState('disconnected');
                    this.emit('disconnected', { code, reason: reason.toString() });
                    
                    if (wasConnected) {
                        if (this.showNotifications && this.notificationCallbacks.showWarning) {
                            this.notificationCallbacks.showWarning(`Disconnected from APC daemon: ${reason || 'unknown'}`);
                        }
                        // Attempt reconnect
                        this.attemptReconnect();
                    }
                });
                
                this.ws.on('error', (err) => {
                    console.error('[VsCodeClient] WebSocket error:', err);
                    this.emit('error', err);
                    
                    if (this.state === 'connecting') {
                        this.ws?.close();
                        this.ws = null;
                        this.setState('error');
                        reject(err);
                    }
                });
                
            } catch (err) {
                this.setState('error');
                reject(err);
            }
        });
    }
    
    /**
     * Disconnect from the daemon
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        this.setState('disconnected');
    }
    
    /**
     * Send raw data through WebSocket
     */
    protected sendRaw(data: string): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data);
        } else {
            throw new Error('WebSocket not connected');
        }
    }
    
    // ========================================================================
    // Convenience Methods
    // ========================================================================
    
    /**
     * Get system status
     */
    async getStatus(): Promise<StatusResponse> {
        return this.send<StatusResponse>('status');
    }
    
    /**
     * List all planning sessions
     */
    async listSessions(): Promise<SessionListResponse> {
        return this.send<SessionListResponse>('session.list');
    }
    
    /**
     * Create a new planning session
     */
    async createPlan(prompt: string, docs?: string[]): Promise<PlanCreateResponse> {
        return this.send<PlanCreateResponse>('plan.create', { prompt, docs });
    }
    
    /**
     * Approve a plan
     */
    async approvePlan(sessionId: string, autoStart: boolean = false): Promise<void> {
        await this.send('plan.approve', { id: sessionId, autoStart });
    }
    
    /**
     * Revise a plan with feedback
     */
    async revisePlan(sessionId: string, feedback: string): Promise<void> {
        await this.send('plan.revise', { id: sessionId, feedback });
    }
    
    /**
     * Get pool status
     */
    async getPoolStatus(): Promise<PoolStatusResponse> {
        return this.send<PoolStatusResponse>('pool.status');
    }
    
    /**
     * Get Unity status
     */
    async getUnityStatus(): Promise<UnityStatusResponse> {
        return this.send<UnityStatusResponse>('unity.status');
    }
    
    /**
     * Subscribe to session events
     */
    subscribeToSession(sessionId: string): void {
        this.sendAsync('subscribe', { sessionId });
    }
    
    /**
     * Unsubscribe from session events
     */
    unsubscribeFromSession(sessionId: string): void {
        this.sendAsync('unsubscribe', { sessionId });
    }
    
    // ========================================================================
    // VS Code Integration Helpers
    // ========================================================================
    
    /**
     * Execute a VS Code command through the daemon
     * Used for MCP calls that need to go through VS Code
     */
    async executeMcpCommand(tool: string, args: any): Promise<any> {
        return this.send('mcp.execute', { tool, args });
    }
}

