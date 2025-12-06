/**
 * Example usage of AgentInstaller abstraction
 * 
 * This demonstrates how the backend abstraction works with static methods
 * that don't require ServiceLocator or daemon.
 */

import { AgentInstaller } from '../AgentInstaller';
import { AgentBackendType } from '../AgentBackend';

/**
 * Example 1: Install CLI for a backend
 * This can be called from client-side (VS Code extension UI) without daemon
 */
async function exampleInstallCLI() {
    // Default: uses 'cursor' backend
    const result1 = await AgentInstaller.installCLI();
    console.log(result1.message);
    
    // Explicit backend type
    const result2 = await AgentInstaller.installCLI('cursor');
    console.log(result2.message);
    
    // Future: other backends (not yet implemented)
    const result3 = await AgentInstaller.installCLI('some-other-backend' as AgentBackendType);
    console.log(result3.message); // Will show "not supported" message
}

/**
 * Example 2: Install MCP configuration
 */
async function exampleInstallMCP() {
    // Install Unity MCP with HTTP transport
    const result1 = await AgentInstaller.installMCP({
        name: 'unity-mcp',
        url: 'http://localhost:3000'
    }, 'cursor');
    
    if (result1.success) {
        console.log('Unity MCP configured successfully!');
    } else {
        console.error('Failed to configure Unity MCP:', result1.message);
    }
    
    // Install another MCP with stdio transport
    const result2 = await AgentInstaller.installMCP({
        name: 'my-custom-mcp',
        command: 'node',
        args: ['path/to/mcp-server.js']
    }, 'cursor');
    
    console.log(result2.message);
}

/**
 * Example 3: Check if backend is available
 */
async function exampleCheckAvailability() {
    const isAvailable = await AgentInstaller.isAvailable('cursor');
    
    if (isAvailable) {
        console.log('Cursor backend is ready to use!');
    } else {
        console.log('Cursor backend not available - need to install');
        // Trigger installation
        const result = await AgentInstaller.installCLI('cursor');
        console.log(result.message);
    }
}

/**
 * Example 4: Check MCP configuration
 */
function exampleCheckMCP() {
    const isConfigured = AgentInstaller.isMcpConfigured('unity-mcp', 'cursor');
    
    if (isConfigured) {
        console.log('Unity MCP is already configured');
    } else {
        console.log('Unity MCP needs to be configured');
    }
    
    // Get config path
    const configPath = AgentInstaller.getMcpConfigPath('cursor');
    console.log('MCP config location:', configPath);
}

/**
 * How the abstraction works internally:
 * 
 * 1. AgentInstaller is a static utility class (no instance needed)
 * 2. Each method accepts a backend type parameter
 * 3. Methods switch on backend type and delegate to specific implementations
 * 4. For 'cursor' backend, creates CursorAgentRunner instance internally
 * 5. No ServiceLocator dependency - works in client and daemon
 * 
 * Architecture benefits:
 * - Clean separation: installation separate from runtime agent execution
 * - No daemon dependency: can install before daemon starts
 * - Backend agnostic: easy to add new backends in future
 * - Simple API: static methods, no complex setup
 */

export const AgentInstallerExamples = {
    exampleInstallCLI,
    exampleInstallMCP,
    exampleCheckAvailability,
    exampleCheckMCP
};

