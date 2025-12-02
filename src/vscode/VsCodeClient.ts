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
    // Execution Control
    // ========================================================================
    
    /**
     * Start execution for an approved plan
     */
    async startExecution(sessionId: string): Promise<{ success: boolean; workflowIds?: string[]; engineerCount?: number; error?: string }> {
        try {
            const response = await this.send<{ workflowIds: string[]; message: string }>('exec.start', { sessionId });
            return { 
                success: true, 
                workflowIds: response.workflowIds,
                engineerCount: response.workflowIds?.length || 0
            };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Pause execution for a session
     */
    async pauseExecution(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('exec.pause', { sessionId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Resume execution for a session
     */
    async resumeExecution(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('exec.resume', { sessionId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Stop execution for a session
     */
    async stopExecution(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('exec.stop', { sessionId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Get execution status for a session
     */
    async getExecStatus(sessionId: string): Promise<any> {
        return this.send('exec.status', { sessionId });
    }
    
    // ========================================================================
    // Session Management
    // ========================================================================
    
    /**
     * Get a specific session by ID
     */
    async getSession(sessionId: string): Promise<any> {
        return this.send('session.get', { id: sessionId });
    }
    
    /**
     * Pause a session
     */
    async pauseSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('session.pause', { id: sessionId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Resume a session
     */
    async resumeSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('session.resume', { id: sessionId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Stop a planning session
     */
    async stopSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('session.stop', { id: sessionId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Remove/delete a planning session
     */
    async removeSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('session.remove', { id: sessionId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    // ========================================================================
    // Plan Management
    // ========================================================================
    
    /**
     * Cancel a plan/revision
     */
    async cancelPlan(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('plan.cancel', { id: sessionId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Restart planning for a cancelled session
     */
    async restartPlanning(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('plan.restart', { id: sessionId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Get plan status
     */
    async getPlanStatus(sessionId: string): Promise<any> {
        return this.send('plan.status', { id: sessionId });
    }
    
    // ========================================================================
    // Pool Management
    // ========================================================================
    
    /**
     * Resize the agent pool
     */
    async resizePool(size: number): Promise<{ success: boolean; added?: string[]; removed?: string[]; error?: string }> {
        try {
            const response = await this.send<{ newSize: number; added: string[]; removed: string[] }>('pool.resize', { size });
            return { success: true, added: response.added, removed: response.removed };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Release an agent from their current coordinator
     */
    async releaseAgent(agentName: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('agent.release', { agentName });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    // ========================================================================
    // Workflow Management
    // ========================================================================
    
    /**
     * Retry a failed task
     */
    async retryTask(sessionId: string, taskId: string): Promise<{ success: boolean; workflowId?: string; error?: string }> {
        try {
            const response = await this.send<{ workflowId: string }>('workflow.retry', { sessionId, taskId });
            return { success: true, workflowId: response.workflowId };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    // ========================================================================
    // Roles Management
    // ========================================================================
    
    /**
     * Get all agent roles
     */
    async getRoles(): Promise<any[]> {
        const response = await this.send<{ roles: any[] }>('roles.list');
        return response.roles || [];
    }
    
    /**
     * Get a specific role
     */
    async getRole(roleId: string): Promise<any> {
        const response = await this.send('roles.get', { roleId });
        return response;
    }
    
    /**
     * Update a role
     */
    async updateRole(roleId: string, updates: Record<string, any>): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('roles.update', { roleId, updates });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Reset a role to default
     */
    async resetRole(roleId: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('roles.reset', { roleId });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
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
    
    // ========================================================================
    // Coordinator
    // ========================================================================
    
    /**
     * Request coordinator evaluation for a session
     * Used when UI detects idle approved plan with available agents
     */
    async requestCoordinatorEvaluation(sessionId: string, reason: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.send('coordinator.evaluate', { sessionId, reason });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
}







