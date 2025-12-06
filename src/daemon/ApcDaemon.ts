/**
 * ApcDaemon.ts - Main WebSocket server for APC
 * 
 * This is the central daemon that hosts all business logic and services.
 * Clients (VS Code, TUI, headless) connect via WebSocket to interact with
 * the planning and execution system.
 */

import WebSocket, { WebSocketServer } from 'ws';
import * as http from 'http';
import { ApcRequest, ApcResponse, ApcEvent, ApcMessage } from '../client/Protocol';
import { ApiHandler, ApiServices } from './ApiHandler';
import { EventBroadcaster } from './EventBroadcaster';
import { ServiceLocator } from '../services/ServiceLocator';
import { DependencyService, DependencyStatus } from '../services/DependencyService';
import {
    CoreConfig,
    ConfigLoader,
    findWorkspaceRoot,
    writeDaemonInfo,
    cleanupDaemonInfo,
    getDaemonPort,
    isDaemonRunning
} from './DaemonConfig';
import { Logger } from '../utils/Logger';
import { ScriptableWorkflowRegistry } from '../services/workflows/ScriptableWorkflowRegistry';

const log = Logger.create('Daemon', 'ApcDaemon');

// ============================================================================
// Types
// ============================================================================

/**
 * Connected client information
 */
interface ConnectedClient {
    id: string;
    ws: WebSocket;
    type: 'vscode' | 'tui' | 'headless' | 'unknown';
    connectedAt: string;
    lastActivity: string;
    subscribedSessions: Set<string>;
}

/**
 * Daemon options
 */
export interface DaemonOptions {
    /** Port to listen on (default: from config or 19840) */
    port?: number;
    /** Workspace root (default: auto-detect) */
    workspaceRoot?: string;
    /** Services to use (required for production) */
    services?: ApiServices;
    /** Enable verbose logging */
    verbose?: boolean;
}

/**
 * Daemon state
 */
export type DaemonState = 'stopped' | 'starting' | 'running' | 'stopping';
export type DaemonReadyState = 'starting' | 'checking_dependencies' | 'initializing_services' | 'ready';

// ============================================================================
// APC Daemon
// ============================================================================

/**
 * Main WebSocket server daemon for APC.
 * Manages client connections, routes requests to services, and broadcasts events.
 */
export class ApcDaemon {
    private state: DaemonState = 'stopped';
    private readyState: DaemonReadyState = 'starting';
    private wss: WebSocketServer | null = null;
    private httpServer: http.Server | null = null;
    private clients: Map<string, ConnectedClient> = new Map();
    private apiHandler: ApiHandler | null = null;
    private broadcaster: EventBroadcaster;
    private config: CoreConfig;
    private configLoader: ConfigLoader;
    private startTime: number = 0;
    private verbose: boolean;
    private services: ApiServices | null = null;
    
    /** Cache of initialization progress messages for late-joining clients */
    private initializationHistory: Array<{
        event: string;
        data: any;
        timestamp: string;
    }> = [];
    
    /** Idle shutdown timer - daemon shuts down after 60s with no clients */
    private idleShutdownTimer: NodeJS.Timeout | null = null;
    private static readonly IDLE_SHUTDOWN_MS = 60000;  // 60 seconds
    
    constructor(options: DaemonOptions = {}) {
        const workspaceRoot = options.workspaceRoot || findWorkspaceRoot();
        this.configLoader = new ConfigLoader(workspaceRoot);
        this.config = this.configLoader.getConfig();
        
        if (options.port) {
            this.config.port = options.port;
        }
        
        this.services = options.services || null;
        this.verbose = options.verbose || false;
        this.broadcaster = ServiceLocator.resolve(EventBroadcaster);
        
        // Register broadcast handler
        this.broadcaster.onBroadcast((event, targetClients) => {
            // Cache ALL initialization-related events for late-joining clients
            if (this.readyState !== 'ready') {
                const cacheableEvents = ['daemon.starting', 'daemon.progress', 'deps.list', 'deps.progress'];
                if (cacheableEvents.includes(event.event)) {
                    this.initializationHistory.push({
                        event: event.event,
                        data: event.data,
                        timestamp: event.timestamp || new Date().toISOString()
                    });
                    // Keep only last 100 messages to prevent memory bloat
                    if (this.initializationHistory.length > 100) {
                        this.initializationHistory.shift();
                    }
                }
            }
            
            this.broadcastEvent(event, targetClients);
        });
    }
    
    // ========================================================================
    // Lifecycle
    // ========================================================================
    
    /**
     * Start the daemon
     */
    async start(): Promise<void> {
        if (this.state !== 'stopped') {
            throw new Error(`Cannot start daemon in state: ${this.state}`);
        }
        
        // Check if daemon already running
        if (isDaemonRunning(this.config.workspaceRoot)) {
            const existingPort = getDaemonPort(this.config.workspaceRoot);
            throw new Error(`Daemon already running on port ${existingPort}`);
        }
        
        this.state = 'starting';
        this.startTime = Date.now();
        
        // Clear initialization history on fresh start
        this.initializationHistory = [];
        
        try {
            // Initialize API handler if services provided
            if (this.services) {
                // Add daemon reference for cache management and state control
                this.services.daemon = {
                    clearInitializationCache: () => this.clearInitializationCache(),
                    setDependencyCheckComplete: () => this.setDependencyCheckComplete()
                };
                this.apiHandler = new ApiHandler(this.services);
            }
            
            // Create HTTP server for WebSocket upgrade
            this.httpServer = http.createServer((req, res) => {
                // Health check endpoint
                if (req.url === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: this.readyState === 'ready' ? 'ok' : 'initializing',
                        state: this.state,
                        readyState: this.readyState,
                        uptime: Date.now() - this.startTime,
                        clients: this.clients.size,
                        servicesReady: this.readyState === 'ready'
                    }));
                    return;
                }
                
                res.writeHead(404);
                res.end('Not found');
            });
            
            // Create WebSocket server
            this.wss = new WebSocketServer({
                server: this.httpServer
            });
            
            // Handle connections
            this.wss.on('connection', (ws, req) => {
                this.handleConnection(ws, req);
            });
            
            // Start listening
            await new Promise<void>((resolve, reject) => {
                this.httpServer!.on('error', reject);
                this.httpServer!.listen(this.config.port, '127.0.0.1', () => {
                    resolve();
                });
            });
            
            // Write PID and port files
            writeDaemonInfo(this.config.workspaceRoot, process.pid, this.config.port);
            
            this.state = 'running';
            this.log('info', `APC Daemon started on port ${this.config.port}`);
            this.log('info', `Workspace: ${this.config.workspaceRoot}`);
            
            // Broadcast starting event (WebSocket ready, but services may not be)
            this.readyState = this.services ? 'initializing_services' : 'initializing_services';
            this.broadcaster.broadcast('daemon.starting', {
                version: '0.1.0',
                port: this.config.port,
                workspaceRoot: this.config.workspaceRoot,
                startedAt: new Date().toISOString(),
                readyState: this.readyState
            });
            
            // Don't mark as ready yet - wait for services to be set
            // Services will be initialized in background (start.ts)
            // and setServices() will call setServicesReady() when done
            
        } catch (err) {
            this.state = 'stopped';
            cleanupDaemonInfo(this.config.workspaceRoot);
            throw err;
        }
    }
    
    /**
     * Mark services as ready. Called by standalone.ts after all services are initialized.
     * This signals that the daemon is fully ready to handle requests.
     */
    setServicesReady(): void {
        if (this.readyState !== 'ready') {
            this.readyState = 'ready';
            this.log('info', 'All services initialized - daemon is fully ready');
            
            // Cache the daemon.ready event BEFORE broadcasting so late-joining clients receive it
            const readyEvent = {
                event: 'daemon.ready',
                data: {
                    version: '0.1.0',
                    servicesReady: true,
                    readyState: 'ready' as const
                },
                timestamp: new Date().toISOString()
            };
            this.initializationHistory.push(readyEvent);
            
            // Broadcast the ready event
            this.broadcaster.broadcast('daemon.ready', readyEvent.data);
            
            // Keep initialization history for late-joining clients
            // It will only be cleared on daemon restart or dependency refresh
        }
    }
    
    /**
     * Clear initialization history cache.
     * Called when dependency refresh starts to prepare for new initialization events.
     */
    clearInitializationCache(): void {
        this.log('info', 'Clearing initialization cache for fresh dependency check');
        this.initializationHistory = [];
        
        // Temporarily set readyState back to 'initializing_services' during refresh
        // This ensures clients see "Checking..." state while dependencies are being verified
        if (this.readyState === 'ready') {
            this.readyState = 'initializing_services';
            this.log('debug', 'Set readyState to initializing_services for dependency refresh');
            
            // Broadcast that we're re-checking dependencies
            this.broadcaster.broadcast('daemon.progress', {
                step: 'Re-checking system dependencies...',
                phase: 'checking_dependencies',
                timestamp: new Date().toISOString()
            });
        }
    }
    
    /**
     * Mark dependency check as complete after a refresh.
     * Called by ApiHandler after deps.refresh completes.
     */
    setDependencyCheckComplete(): void {
        if (this.readyState === 'initializing_services') {
            // Set back to ready and re-broadcast daemon.ready event
            this.setServicesReady();
        }
    }
    
    /**
     * Set services after daemon is started.
     * Used when daemon starts before services are initialized.
     */
    setServices(services: ApiServices): void {
        this.services = services;
        // Add daemon reference for cache management and state control
        this.services.daemon = {
            clearInitializationCache: () => this.clearInitializationCache(),
            setDependencyCheckComplete: () => this.setDependencyCheckComplete()
        };
        this.apiHandler = new ApiHandler(services);
        this.log('info', 'Services registered with daemon');
        
        // If services are set after daemon started, mark as ready
        this.setServicesReady();
    }
    
    /**
     * Stop the daemon
     */
    async stop(reason: string = 'shutdown'): Promise<void> {
        if (this.state !== 'running') {
            return;
        }
        
        this.state = 'stopping';
        this.log('info', `Stopping daemon: ${reason}`);
        
        // Cancel idle shutdown timer if active
        this.cancelIdleShutdownTimer();
        
        // Gracefully shutdown coordinator (pause workflows, release agents)
        // This saves workflow state so they can be resumed on restart
        if (this.services?.coordinator?.gracefulShutdown) {
            try {
                const result = await this.services.coordinator.gracefulShutdown();
                this.log('info', `Graceful shutdown: ${result.workflowsPaused} workflows paused, ${result.agentsReleased} agents released`);
            } catch (err) {
                this.log('warn', `Graceful shutdown error: ${err}`);
            }
        }
        
        // Stop ScriptableWorkflowRegistry file watcher
        try {
            if (ServiceLocator.isRegistered(ScriptableWorkflowRegistry)) {
                const scriptableRegistry = ServiceLocator.resolve(ScriptableWorkflowRegistry);
                scriptableRegistry.stopWatching();
                this.log('info', 'ScriptableWorkflowRegistry file watcher stopped');
            }
        } catch (err) {
            this.log('warn', `ScriptableWorkflowRegistry cleanup error: ${err}`);
        }
        
        // Broadcast shutdown event
        this.broadcaster.broadcast('daemon.shutdown', {
            reason,
            graceful: true,
            timestamp: new Date().toISOString()
        });
        
        // Close all client connections
        for (const [_clientId, client] of this.clients) {
            try {
                client.ws.close(1000, reason);
            } catch {
                // Ignore close errors
            }
        }
        this.clients.clear();
        
        // Close WebSocket server
        if (this.wss) {
            await new Promise<void>((resolve) => {
                this.wss!.close(() => resolve());
            });
            this.wss = null;
        }
        
        // Close HTTP server
        if (this.httpServer) {
            await new Promise<void>((resolve) => {
                this.httpServer!.close(() => resolve());
            });
            this.httpServer = null;
        }
        
        // Kill any orphan cursor-agent processes
        // This ensures clean shutdown with no lingering processes
        if (this.services?.processManager) {
            try {
                const killedCount = await this.services.processManager.killOrphanCursorAgents();
                if (killedCount > 0) {
                    this.log('info', `Killed ${killedCount} orphan cursor-agent processes during shutdown`);
                }
            } catch (err) {
                this.log('warn', `Failed to kill orphan processes: ${err}`);
            }
        }
        
        // Cleanup PID files
        cleanupDaemonInfo(this.config.workspaceRoot);
        
        this.state = 'stopped';
        this.log('info', 'Daemon stopped');
    }
    
    /**
     * Get daemon state
     */
    getState(): DaemonState {
        return this.state;
    }
    
    /**
     * Get daemon statistics
     */
    getStats(): {
        state: DaemonState;
        uptime: number;
        connectedClients: number;
        clientTypes: Record<string, number>;
        apiStats?: { requestCount: number; uptime: number };
        eventStats?: ReturnType<EventBroadcaster['getStats']>;
    } {
        const clientTypes: Record<string, number> = {};
        for (const client of this.clients.values()) {
            clientTypes[client.type] = (clientTypes[client.type] || 0) + 1;
        }
        
        return {
            state: this.state,
            uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
            connectedClients: this.clients.size,
            clientTypes,
            apiStats: this.apiHandler?.getStats(),
            eventStats: this.broadcaster.getStats()
        };
    }
    
    // ========================================================================
    // Connection Handling
    // ========================================================================
    
    /**
     * Handle new WebSocket connection
     */
    private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
        // Cancel idle shutdown timer - we have a client now
        this.cancelIdleShutdownTimer();
        
        const clientId = this.generateClientId();
        
        const client: ConnectedClient = {
            id: clientId,
            ws,
            type: this.parseClientType(req),
            connectedAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            subscribedSessions: new Set()
        };
        
        this.clients.set(clientId, client);
        this.log('info', `Client connected: ${clientId} (${client.type})`);
        
        // Send client their ID
        this.sendToClient(client, {
            type: 'event',
            payload: {
                event: 'client.connected',
                data: {
                    clientId,
                    clientType: client.type,
                    connectedAt: client.connectedAt,
                    totalClients: this.clients.size
                },
                timestamp: new Date().toISOString()
            }
        });
        
        // Broadcast to other clients
        this.broadcaster.broadcast('client.connected', {
            clientId,
            clientType: client.type,
            connectedAt: client.connectedAt,
            totalClients: this.clients.size
        });
        
        // Send cached initialization history to new client
        // This includes both in-progress initialization events AND the final daemon.ready event
        // Late-joining clients (connecting after daemon is ready) need the daemon.ready event
        if (this.initializationHistory.length > 0) {
            const statusMsg = this.readyState === 'ready' 
                ? `📋 Sending cached initialization state (daemon ready) to new client ${clientId}`
                : `📋 Replaying ${this.initializationHistory.length} initialization steps to new client ${clientId}`;
            this.log('info', statusMsg);
            
            // Send history asynchronously with small delay to ensure WebSocket is ready
            setTimeout(() => {
                // Double-check client is still connected
                if (!this.clients.has(clientId)) {
                    this.log('warn', `Client ${clientId} disconnected before history could be sent`);
                    return;
                }
                
                const currentClient = this.clients.get(clientId)!;
                if (currentClient.ws.readyState !== WebSocket.OPEN) {
                    this.log('warn', `Client ${clientId} WebSocket not OPEN (state: ${currentClient.ws.readyState})`);
                    return;
                }
                
                try {
                    // Send all cached messages
                    let sentCount = 0;
                    for (const cached of this.initializationHistory) {
                        const sent = this.sendToClient(currentClient, {
                            type: 'event',
                            payload: {
                                event: cached.event,
                                data: cached.data,
                                timestamp: cached.timestamp
                            }
                        });
                        if (sent) sentCount++;
                    }
                    this.log('info', `✅ Successfully sent ${sentCount}/${this.initializationHistory.length} cached steps to ${clientId}`);
                } catch (err) {
                    this.log('error', `❌ Failed to send initialization history to ${clientId}:`, err);
                }
            }, 50); // 50ms delay to ensure WebSocket is fully ready
        }
        
        // Handle messages
        ws.on('message', (data) => {
            this.handleMessage(client, data);
        });
        
        // Handle close
        ws.on('close', (code, reason) => {
            this.handleDisconnect(client, code, reason.toString());
        });
        
        // Handle errors
        ws.on('error', (err) => {
            this.log('error', `Client ${clientId} error:`, err);
        });
    }
    
    /**
     * Handle incoming message from client
     */
    private async handleMessage(client: ConnectedClient, data: WebSocket.RawData): Promise<void> {
        client.lastActivity = new Date().toISOString();
        
        let message: ApcMessage;
        try {
            message = JSON.parse(data.toString());
        } catch (err) {
            this.log('error', `Invalid message from ${client.id}:`, err);
            return;
        }
        
        if (message.type === 'request') {
            await this.handleRequest(client, message.payload);
        } else {
            this.log('warn', `Unknown message type from ${client.id}: ${message.type}`);
        }
    }
    
    /**
     * Handle API request from client
     * 
     * IMPORTANT: Commands that are used for connectivity/health checks (like 'status')
     * MUST be handled before the apiHandler check, because apiHandler is only created
     * after services are initialized. During the ~15 second dependency check phase,
     * clients need to ping the daemon to verify connectivity, so 'status' must work
     * even when services aren't ready yet.
     */
    private async handleRequest(client: ConnectedClient, request: ApcRequest): Promise<void> {
        this.log('debug', `Request from ${client.id}: ${request.cmd}`);
        
        // Handle special commands
        if (request.cmd === 'subscribe') {
            const sessionId = request.params?.sessionId as string | undefined;
            this.handleSubscribe(client, sessionId);
            this.sendResponse(client, {
                id: request.id,
                success: true,
                message: `Subscribed to session ${sessionId}`
            });
            return;
        }
        
        if (request.cmd === 'unsubscribe') {
            const sessionId = request.params?.sessionId as string | undefined;
            this.handleUnsubscribe(client, sessionId);
            this.sendResponse(client, {
                id: request.id,
                success: true,
                message: `Unsubscribed from session ${sessionId}`
            });
            return;
        }
        
        // Handle daemon.status (daemon-level status - always works even during initialization)
        // This is used for health checks and system monitoring
        if (request.cmd === 'daemon.status') {
            // Get dependency status if available
            let dependencies: DependencyStatus[] = [];
            let missingCount = 0;
            let hasCriticalMissing = false;
            
            try {
                const depService = ServiceLocator.resolve(DependencyService);
                const allDeps = depService.getCachedStatus();
                const platform = process.platform;
                dependencies = allDeps.filter(d => d.platform === platform || d.platform === 'all');
                const missingDeps = dependencies.filter(d => d.required && !d.installed);
                missingCount = missingDeps.length;
                hasCriticalMissing = missingDeps.some(d => 
                    d.name.includes('Python') || d.name.includes('APC CLI')
                );
            } catch {
                // DependencyService not registered yet
            }
            
            this.sendResponse(client, {
                id: request.id,
                success: true,
                data: {
                    state: this.state,
                    readyState: this.readyState,
                    servicesReady: this.readyState === 'ready',
                    uptime: Date.now() - this.startTime,
                    clients: this.clients.size,
                    // Dependency status
                    dependencies,
                    missingCount,
                    hasCriticalMissing
                }
            });
            return;
        }
        
        // Handle 'status' (application-level status via ApiHandler)
        // BUT: Must work for health checks before services are ready
        // So if apiHandler is null, return a minimal "initializing" status
        if (request.cmd === 'status') {
            if (!this.apiHandler) {
                // Services not ready yet - return minimal status for health checks
                this.sendResponse(client, {
                    id: request.id,
                    success: true,
                    data: {
                        activePlanningSessions: 0,
                        agentPool: {
                            total: 0,
                            available: 0,
                            busy: 0
                        },
                        daemonUptime: Date.now() - this.startTime,
                        connectedClients: this.clients.size,
                        initializing: true // Flag to indicate services not ready
                    }
                });
                return;
            }
            // Services ready - fall through to ApiHandler
        }
        
        // Route to API handler
        if (!this.apiHandler) {
            this.sendResponse(client, {
                id: request.id,
                success: false,
                error: 'Services not initialized'
            });
            return;
        }
        
        try {
            const response = await this.apiHandler.handleRequest(request);
            this.sendResponse(client, response);
        } catch (err) {
            this.sendResponse(client, {
                id: request.id,
                success: false,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }
    
    /**
     * Handle client disconnect
     */
    private handleDisconnect(client: ConnectedClient, code: number, reason: string): void {
        this.log('info', `Client disconnected: ${client.id} (code: ${code}, reason: ${reason})`);
        
        // Unsubscribe from all sessions
        this.broadcaster.unsubscribeClient(client.id);
        
        // Remove from clients map
        this.clients.delete(client.id);
        
        // Broadcast disconnect
        this.broadcaster.broadcast('client.disconnected', {
            clientId: client.id,
            reason: reason || 'unknown',
            disconnectedAt: new Date().toISOString(),
            totalClients: this.clients.size
        });
        
        // Start idle shutdown timer if no clients remaining
        if (this.clients.size === 0) {
            this.startIdleShutdownTimer();
        }
    }
    
    /**
     * Start the idle shutdown timer
     * Daemon will gracefully shutdown after IDLE_SHUTDOWN_MS with no clients
     */
    private startIdleShutdownTimer(): void {
        // Cancel any existing timer
        this.cancelIdleShutdownTimer();
        
        this.log('info', `No clients connected. Starting idle shutdown timer (${ApcDaemon.IDLE_SHUTDOWN_MS / 1000}s)...`);
        
        this.idleShutdownTimer = setTimeout(async () => {
            this.log('info', 'Idle shutdown timer expired. Initiating graceful shutdown...');
            await this.stop('idle_timeout');
        }, ApcDaemon.IDLE_SHUTDOWN_MS);
    }
    
    /**
     * Cancel the idle shutdown timer
     */
    private cancelIdleShutdownTimer(): void {
        if (this.idleShutdownTimer) {
            clearTimeout(this.idleShutdownTimer);
            this.idleShutdownTimer = null;
            this.log('info', 'Idle shutdown timer cancelled (client connected)');
        }
    }
    
    // ========================================================================
    // Subscriptions
    // ========================================================================
    
    /**
     * Subscribe client to session events
     */
    private handleSubscribe(client: ConnectedClient, sessionId?: string): void {
        if (!sessionId) {
            return;
        }
        
        client.subscribedSessions.add(sessionId);
        this.broadcaster.subscribeToSession(client.id, sessionId);
        this.log('debug', `${client.id} subscribed to ${sessionId}`);
    }
    
    /**
     * Unsubscribe client from session events
     */
    private handleUnsubscribe(client: ConnectedClient, sessionId?: string): void {
        if (!sessionId) {
            return;
        }
        
        client.subscribedSessions.delete(sessionId);
        this.broadcaster.unsubscribeFromSession(client.id, sessionId);
        this.log('debug', `${client.id} unsubscribed from ${sessionId}`);
    }
    
    // ========================================================================
    // Message Sending
    // ========================================================================
    
    /**
     * Send response to a specific client
     */
    private sendResponse(client: ConnectedClient, response: ApcResponse): void {
        this.sendToClient(client, {
            type: 'response',
            payload: response
        });
    }
    
    /**
     * Send a message to a specific client
     * Returns true if message was sent, false if WebSocket not ready
     */
    private sendToClient(client: ConnectedClient, message: ApcMessage): boolean {
        if (client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(JSON.stringify(message));
                return true;
            } catch (err) {
                this.log('error', `Failed to send to ${client.id}:`, err);
                return false;
            }
        } else {
            this.log('warn', `Cannot send to ${client.id} - WebSocket not OPEN (state: ${client.ws.readyState})`);
            return false;
        }
    }
    
    /**
     * Broadcast event to clients
     */
    private broadcastEvent(event: ApcEvent, targetClients?: string[]): void {
        const message: ApcMessage = {
            type: 'event',
            payload: event
        };
        
        const messageStr = JSON.stringify(message);
        
        if (targetClients) {
            // Send to specific clients
            for (const clientId of targetClients) {
                const client = this.clients.get(clientId);
                if (client && client.ws.readyState === WebSocket.OPEN) {
                    try {
                        client.ws.send(messageStr);
                    } catch (err) {
                        this.log('error', `Failed to send event to ${clientId}:`, err);
                    }
                }
            }
        } else {
            // Broadcast to all clients
            for (const client of this.clients.values()) {
                if (client.ws.readyState === WebSocket.OPEN) {
                    try {
                        client.ws.send(messageStr);
                    } catch (err) {
                        this.log('error', `Failed to broadcast to ${client.id}:`, err);
                    }
                }
            }
        }
    }
    
    // ========================================================================
    // Utilities
    // ========================================================================
    
    /**
     * Parse client type from request headers
     */
    private parseClientType(req: http.IncomingMessage): ConnectedClient['type'] {
        const userAgent = req.headers['user-agent'] || '';
        const clientType = req.headers['x-apc-client-type'] as string;
        
        if (clientType) {
            if (['vscode', 'tui', 'headless'].includes(clientType)) {
                return clientType as ConnectedClient['type'];
            }
        }
        
        if (userAgent.includes('vscode')) {
            return 'vscode';
        }
        if (userAgent.includes('tui')) {
            return 'tui';
        }
        
        return 'unknown';
    }
    
    /**
     * Generate unique client ID
     */
    private generateClientId(): string {
        return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
    
    /**
     * Log message using unified Logger
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void {
        const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
        const configLevel = logLevels[this.config.logLevel] || 1;
        
        if (logLevels[level] >= configLevel || this.verbose) {
            switch (level) {
                case 'debug':
                    log.debug(...args);
                    break;
                case 'info':
                    log.info(...args);
                    break;
                case 'warn':
                    log.warn(...args);
                    break;
                case 'error':
                    log.error(...args);
                    break;
            }
        }
    }
    
    // ========================================================================
    // Service Management
    // ========================================================================
    
    /**
     * Get configuration
     */
    getConfig(): CoreConfig {
        return this.config;
    }
    
    /**
     * Get config loader for dynamic updates
     */
    getConfigLoader(): ConfigLoader {
        return this.configLoader;
    }
}

// ============================================================================
// Standalone Entry Point
// ============================================================================

/**
 * Run daemon as standalone process
 * Usage: node daemon/index.js [workspaceRoot]
 */
export async function runStandalone(workspaceRoot?: string): Promise<ApcDaemon> {
    const daemon = new ApcDaemon({
        workspaceRoot,
        verbose: process.env.APC_VERBOSE === 'true'
    });
    
    // Handle shutdown signals
    const shutdown = async (signal: string) => {
        log.info(`Received ${signal}, shutting down...`);
        await daemon.stop(signal);
        process.exit(0);
    };
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    await daemon.start();
    
    return daemon;
}

