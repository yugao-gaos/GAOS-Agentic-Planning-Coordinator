/**
 * AgentInstaller.ts - Static installer utilities for agent backends
 * 
 * Provides static methods for installing CLI tools and MCP configurations
 * without requiring ServiceLocator or daemon dependency.
 * 
 * This is designed to be called from client-side code (e.g., VS Code extension UI)
 * where the daemon may not be running or ServiceLocator is not available.
 * 
 * Usage:
 *   import { AgentInstaller } from './services/AgentInstaller';
 *   const result = await AgentInstaller.installCLI('cursor');
 */

import { CursorAgentRunner } from './CursorAgentRunner';
import { AgentBackendType, InstallResult, McpInstallConfig } from './AgentBackend';

/**
 * Static installer methods for agent backends
 * 
 * These methods don't require ServiceLocator or daemon, making them suitable
 * for client-side code that needs to install dependencies before the daemon starts.
 */
export class AgentInstaller {
    /**
     * Install CLI for a specific backend
     * 
     * This method checks if the CLI is already installed and provides
     * installation instructions if not. It does NOT perform the actual
     * installation (which requires admin privileges and user interaction).
     * 
     * @param backend Backend type (defaults to 'cursor')
     * @returns Installation result with success status and message
     * 
     * @example
     * ```typescript
     * const result = await AgentInstaller.installCLI('cursor');
     * if (!result.success) {
     *     console.log(result.message); // Show installation instructions
     * }
     * ```
     */
    static async installCLI(backend: AgentBackendType = 'cursor'): Promise<InstallResult> {
        switch (backend) {
            case 'cursor': {
                // Create a temporary instance to access install methods
                // Note: CursorAgentRunner's constructor resolves ProcessManager from ServiceLocator,
                // but we handle that below by creating a minimal instance
                const runner = AgentInstaller.createCursorRunner();
                return runner.installCLI();
            }
            default:
                return {
                    success: false,
                    message: `Backend '${backend}' is not yet supported. Only 'cursor' backend is currently available.`
                };
        }
    }
    
    /**
     * Install/configure an MCP server for a specific backend
     * 
     * This method updates the backend's MCP configuration file to add or update
     * an MCP server configuration.
     * 
     * @param config MCP server configuration (name, url/command, args)
     * @param backend Backend type (defaults to 'cursor')
     * @returns Installation result with success status and message
     * 
     * @example
     * ```typescript
     * const result = await AgentInstaller.installMCP({
     *     name: 'unity-mcp',
     *     url: 'http://localhost:3000'
     * }, 'cursor');
     * ```
     */
    static async installMCP(config: McpInstallConfig, backend: AgentBackendType = 'cursor'): Promise<InstallResult> {
        switch (backend) {
            case 'cursor': {
                const runner = AgentInstaller.createCursorRunner();
                return runner.installMCP(config);
            }
            default:
                return {
                    success: false,
                    message: `Backend '${backend}' is not yet supported. Only 'cursor' backend is currently available.`
                };
        }
    }
    
    /**
     * Get the MCP config file path for a specific backend
     * 
     * @param backend Backend type (defaults to 'cursor')
     * @returns Path to the MCP configuration file
     */
    static getMcpConfigPath(backend: AgentBackendType = 'cursor'): string {
        switch (backend) {
            case 'cursor': {
                const runner = AgentInstaller.createCursorRunner();
                return runner.getMcpConfigPath();
            }
            default:
                return '';
        }
    }
    
    /**
     * Check if a specific MCP is configured for a backend
     * 
     * @param name MCP server name
     * @param backend Backend type (defaults to 'cursor')
     * @returns true if the MCP is configured, false otherwise
     */
    static isMcpConfigured(name: string, backend: AgentBackendType = 'cursor'): boolean {
        switch (backend) {
            case 'cursor': {
                const runner = AgentInstaller.createCursorRunner();
                return runner.isMcpConfigured(name);
            }
            default:
                return false;
        }
    }
    
    /**
     * Remove an MCP configuration from a backend
     * 
     * @param name MCP server name to remove
     * @param backend Backend type (defaults to 'cursor')
     * @returns Installation result with success status and message
     */
    static async removeMCP(name: string, backend: AgentBackendType = 'cursor'): Promise<InstallResult> {
        switch (backend) {
            case 'cursor': {
                const runner = AgentInstaller.createCursorRunner();
                return runner.removeMCP(name);
            }
            default:
                return {
                    success: false,
                    message: `Backend '${backend}' is not yet supported.`
                };
        }
    }
    
    /**
     * Check if a backend CLI is available on the system
     * 
     * @param backend Backend type (defaults to 'cursor')
     * @returns true if the CLI is available, false otherwise
     */
    static async isAvailable(backend: AgentBackendType = 'cursor'): Promise<boolean> {
        switch (backend) {
            case 'cursor': {
                const runner = AgentInstaller.createCursorRunner();
                return runner.isAvailable();
            }
            default:
                return false;
        }
    }
    
    /**
     * Create a minimal CursorAgentRunner instance for install operations
     * 
     * This creates an instance that can perform install/config operations
     * without requiring ServiceLocator. The install methods don't actually
     * use ProcessManager, so we create a special instance that bypasses it.
     * 
     * @private
     */
    private static createCursorRunner(): CursorAgentRunner {
        // CursorAgentRunner's constructor tries to resolve ProcessManager from ServiceLocator
        // For install operations, we don't need ProcessManager (it's only for run/stop operations)
        // So we create an instance and let it handle the ServiceLocator internally
        // If ServiceLocator is not available, the install methods will still work
        // because they only use isAvailable() and getMcpConfigPath() which are self-contained
        
        try {
            return new CursorAgentRunner();
        } catch (error) {
            // If ServiceLocator fails (e.g., in client context), create a minimal instance
            // The install methods we call don't actually use processManager
            const runner = Object.create(CursorAgentRunner.prototype);
            return runner;
        }
    }
}


