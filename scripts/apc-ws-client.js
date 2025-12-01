#!/usr/bin/env node
/**
 * apc-ws-client.js - WebSocket client for APC CLI
 * 
 * This script connects to the APC daemon via WebSocket and sends commands.
 * It's called by the `apc` bash script for command execution.
 * 
 * Usage: node apc-ws-client.js <command> [params_json]
 * 
 * Examples:
 *   node apc-ws-client.js status
 *   node apc-ws-client.js plan.create '{"prompt":"Create feature X"}'
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Configuration
const DEFAULT_PORT = 19840;
const CONNECT_TIMEOUT = 5000;
const REQUEST_TIMEOUT = 30000;

/**
 * Get workspace root by looking for markers
 */
function findWorkspaceRoot() {
    let dir = process.cwd();
    
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '_AiDevLog')) || 
            fs.existsSync(path.join(dir, '.git'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    
    return process.cwd();
}

/**
 * Get workspace hash for daemon identification
 */
function getWorkspaceHash(workspaceRoot) {
    return crypto.createHash('md5').update(workspaceRoot).digest('hex').substring(0, 8);
}

/**
 * Get daemon port from port file
 */
function getDaemonPort(workspaceRoot) {
    const hash = getWorkspaceHash(workspaceRoot);
    const portPath = path.join(os.tmpdir(), `apc_daemon_${hash}.port`);
    
    if (fs.existsSync(portPath)) {
        try {
            return parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10);
        } catch {
            return null;
        }
    }
    
    return null;
}

/**
 * Check if daemon is running
 */
function isDaemonRunning(workspaceRoot) {
    const hash = getWorkspaceHash(workspaceRoot);
    const pidPath = path.join(os.tmpdir(), `apc_daemon_${hash}.pid`);
    
    if (!fs.existsSync(pidPath)) {
        return false;
    }
    
    try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Generate unique request ID
 */
function generateRequestId() {
    return `cli_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Send a command to the daemon and wait for response
 */
async function sendCommand(cmd, params = {}) {
    const workspaceRoot = findWorkspaceRoot();
    
    // Check if daemon is running
    if (!isDaemonRunning(workspaceRoot)) {
        throw new Error('APC daemon is not running. Start it from VS Code or run: apc daemon start');
    }
    
    const port = getDaemonPort(workspaceRoot) || DEFAULT_PORT;
    const url = `ws://127.0.0.1:${port}`;
    
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            headers: {
                'X-APC-Client-Type': 'cli'
            }
        });
        
        const requestId = generateRequestId();
        let timeoutHandle;
        
        // Connect timeout
        const connectTimeout = setTimeout(() => {
            ws.terminate();
            reject(new Error(`Connection timeout (${CONNECT_TIMEOUT}ms)`));
        }, CONNECT_TIMEOUT);
        
        ws.on('open', () => {
            clearTimeout(connectTimeout);
            
            // Send request
            const request = {
                type: 'request',
                payload: {
                    id: requestId,
                    cmd,
                    params,
                    clientId: 'cli'
                }
            };
            
            ws.send(JSON.stringify(request));
            
            // Response timeout
            timeoutHandle = setTimeout(() => {
                ws.close();
                reject(new Error(`Request timeout (${REQUEST_TIMEOUT}ms)`));
            }, REQUEST_TIMEOUT);
        });
        
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                
                if (message.type === 'response' && message.payload.id === requestId) {
                    clearTimeout(timeoutHandle);
                    ws.close();
                    
                    if (message.payload.success) {
                        resolve(message.payload);
                    } else {
                        reject(new Error(message.payload.error || 'Unknown error'));
                    }
                }
                // Events are ignored in CLI mode
            } catch (err) {
                // Ignore parse errors
            }
        });
        
        ws.on('error', (err) => {
            clearTimeout(connectTimeout);
            clearTimeout(timeoutHandle);
            reject(new Error(`WebSocket error: ${err.message}`));
        });
        
        ws.on('close', (code, reason) => {
            clearTimeout(connectTimeout);
            clearTimeout(timeoutHandle);
            // Only reject if we haven't resolved yet
        });
    });
}

/**
 * Main entry point
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.error('Usage: node apc-ws-client.js <command> [params_json]');
        process.exit(1);
    }
    
    const cmd = args[0];
    let params = {};
    
    if (args[1]) {
        try {
            params = JSON.parse(args[1]);
        } catch (err) {
            console.error(`Invalid JSON params: ${err.message}`);
            process.exit(1);
        }
    }
    
    try {
        const response = await sendCommand(cmd, params);
        
        // Output response as JSON for bash script to parse
        console.log(JSON.stringify({
            success: true,
            requestId: response.id,
            message: response.message,
            data: response.data
        }));
        
    } catch (err) {
        console.log(JSON.stringify({
            success: false,
            error: err.message
        }));
        process.exit(1);
    }
}

// Run
main();

