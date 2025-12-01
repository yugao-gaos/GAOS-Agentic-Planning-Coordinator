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
import {
    CoreConfig,
    ConfigLoader,
    findWorkspaceRoot,
    writeDaemonInfo,
    cleanupDaemonInfo,
    getDaemonPort,
    isDaemonRunning
} from './DaemonConfig';

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

// ============================================================================
// APC Daemon
// ============================================================================

/**
 * Main WebSocket server daemon for APC.
 * Manages client connections, routes requests to services, and broadcasts events.
 */
export class ApcDaemon {
    private state: DaemonState = 'stopped';
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
        
        try {
            // Initialize API handler if services provided
            if (this.services) {
                this.apiHandler = new ApiHandler(this.services);
            }
            
            // Create HTTP server for WebSocket upgrade
            this.httpServer = http.createServer((req, res) => {
                // Health check endpoint
                if (req.url === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'ok',
                        uptime: Date.now() - this.startTime,
                        clients: this.clients.size
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
            
            // Broadcast ready event
            this.broadcaster.broadcast('daemon.ready', {
                version: '0.1.0',
                port: this.config.port,
                workspaceRoot: this.config.workspaceRoot,
                startedAt: new Date().toISOString()
            });
            
        } catch (err) {
            this.state = 'stopped';
            cleanupDaemonInfo(this.config.workspaceRoot);
            throw err;
        }
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
     */
    private async handleRequest(client: ConnectedClient, request: ApcRequest): Promise<void> {
        this.log('debug', `Request from ${client.id}: ${request.cmd}`);
        
        // Handle special commands
        if (request.cmd === 'subscribe') {
            this.handleSubscribe(client, request.params?.sessionId as string | undefined);
            this.sendResponse(client, {
                id: request.id,
                success: true,
                message: `Subscribed to session ${request.params?.sessionId}`
            });
            return;
        }
        
        if (request.cmd === 'unsubscribe') {
            this.handleUnsubscribe(client, request.params?.sessionId as string | undefined);
            this.sendResponse(client, {
                id: request.id,
                success: true,
                message: `Unsubscribed from session ${request.params?.sessionId}`
            });
            return;
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
     */
    private sendToClient(client: ConnectedClient, message: ApcMessage): void {
        if (client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(JSON.stringify(message));
            } catch (err) {
                this.log('error', `Failed to send to ${client.id}:`, err);
            }
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
     * Log message
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void {
        const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
        const configLevel = logLevels[this.config.logLevel] || 1;
        
        if (logLevels[level] >= configLevel || this.verbose) {
            const prefix = `[ApcDaemon][${level.toUpperCase()}]`;
            if (level === 'error') {
                console.error(prefix, ...args);
            } else if (level === 'warn') {
                console.warn(prefix, ...args);
            } else {
                console.log(prefix, ...args);
            }
        }
    }
    
    // ========================================================================
    // Service Management
    // ========================================================================
    
    /**
     * Set services (can be called after construction)
     */
    setServices(services: ApiServices): void {
        this.services = services;
        this.apiHandler = new ApiHandler(services);
    }
    
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
        console.log(`\nReceived ${signal}, shutting down...`);
        await daemon.stop(signal);
        process.exit(0);
    };
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    await daemon.start();
    
    return daemon;
}

