/**
 * SystemSettingsPanel.ts - Webview panel for system/daemon settings
 * 
 * Provides a comprehensive settings panel with categories:
 * - General: Pool size, state interval, auto-open terminals
 * - Unity: Enable/disable Unity features
 * - Folders: Customize folder structure
 * - System Prompts: Coordinator Agent configuration
 * - Advanced: Port, log level, backend
 * 
 * This panel replaces the VS Code extension settings with our own config system.
 * Settings are stored in _AiDevLog/.config/daemon.json
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VsCodeClient } from '../vscode/VsCodeClient';
import { Logger } from '../utils/Logger';
import { DefaultSystemPrompts, SystemPromptConfig } from '../types';
import { getSettingsCommonStyles } from './webview/styles/settingsCommon';

const log = Logger.create('Client', 'SystemSettings');

// ============================================================================
// Types
// ============================================================================

interface ConfigData {
    workingDirectory: string;
    agentPoolSize: number;
    defaultBackend: string;
    enableUnityFeatures: boolean;
    port: number;
    logLevel: string;
    autoOpenTerminals: boolean;
}

interface FolderStructure {
    [key: string]: string;
}

/**
 * System prompt data for UI display
 */
interface SystemPromptData {
    id: string;
    name: string;
    description: string;
    category: 'execution' | 'planning' | 'utility' | 'coordinator';
    defaultModel: string;
    promptTemplate: string;
    roleIntro?: string;
    decisionInstructions?: string;
    isCustomized: boolean;
}

// ============================================================================
// SystemSettingsPanel
// ============================================================================

/**
 * Webview panel for system/daemon settings.
 * Uses the same design pattern as WorkflowSettingsPanel and RoleSettingsPanel.
 */
export class SystemSettingsPanel {
    public static currentPanel: SystemSettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly vsCodeClient: VsCodeClient;
    private readonly workspaceRoot: string;
    private disposables: vscode.Disposable[] = [];
    
    // Cached data
    private config: ConfigData | null = null;
    private folders: FolderStructure | null = null;
    private systemPrompts: SystemPromptData[] = [];
    private daemonConnected: boolean = false;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        vsCodeClient: VsCodeClient,
        workspaceRoot: string
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.vsCodeClient = vsCodeClient;
        this.workspaceRoot = workspaceRoot;

        // Listen for daemon connection changes
        if (this.vsCodeClient) {
            this.vsCodeClient.on('connected', () => {
                this.daemonConnected = true;
                this.panel.webview.postMessage({ type: 'daemon-connected' });
                this.loadDataAndRender();
            });
            
            this.vsCodeClient.on('disconnected', () => {
                this.daemonConnected = false;
                this.panel.webview.postMessage({ type: 'daemon-disconnected' });
            });
        }

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                await this.handleMessage(message);
            },
            null,
            this.disposables
        );

        // Handle panel disposal
        this.panel.onDidDispose(
            () => this.dispose(),
            null,
            this.disposables
        );
        
        // Load initial data and render
        this.loadDataAndRender();
    }

    /**
     * Show the system settings panel
     */
    public static show(extensionUri: vscode.Uri, vsCodeClient: VsCodeClient, workspaceRoot: string): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists, reveal it
        if (SystemSettingsPanel.currentPanel) {
            SystemSettingsPanel.currentPanel.panel.reveal(column);
            SystemSettingsPanel.currentPanel.loadDataAndRender();
            return;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'apcSystemSettings',
            'System Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        SystemSettingsPanel.currentPanel = new SystemSettingsPanel(panel, extensionUri, vsCodeClient, workspaceRoot);
    }

    /**
     * Load data from daemon and render
     */
    private async loadDataAndRender(): Promise<void> {
        try {
            if (!this.vsCodeClient?.isConnected()) {
                throw new Error('Daemon not connected. Cannot load system settings. Please start the daemon first.');
            }
            
            // Load from daemon
            this.config = await this.vsCodeClient.getConfig() as ConfigData;
            this.folders = await this.vsCodeClient.getFolders() as FolderStructure;
            this.daemonConnected = true;
            
            // Load all system prompts (includes coordinator)
            await this.loadSystemPrompts();
        } catch (err) {
            log.error('Failed to load system settings from daemon:', err);
            throw new Error(`Cannot load system settings: ${err instanceof Error ? err.message : 'Daemon unavailable'}. Please ensure daemon is running.`);
        }
        
        this.panel.webview.html = this.getWebviewContent();
    }
    
    /**
     * Load all system prompts from daemon or defaults
     */
    private async loadSystemPrompts(): Promise<void> {
        this.systemPrompts = [];
        
        // Build list from DefaultSystemPrompts
        for (const [id, defaults] of Object.entries(DefaultSystemPrompts)) {
            
            try {
                // Try to get customized version from daemon
                const response = await this.vsCodeClient.send<{ prompt: SystemPromptConfig }>('prompts.getSystemPrompt', { id });
                const prompt = response?.prompt;
                
                if (prompt) {
                    this.systemPrompts.push({
                        id: prompt.id,
                        name: prompt.name,
                        description: prompt.description || defaults.description || '',
                        category: prompt.category || defaults.category || 'utility',
                        defaultModel: prompt.defaultModel || defaults.defaultModel || 'mid',
                        promptTemplate: prompt.promptTemplate || defaults.promptTemplate || '',
                        roleIntro: prompt.roleIntro || defaults.roleIntro,
                        decisionInstructions: prompt.decisionInstructions || defaults.decisionInstructions,
                        isCustomized: true
                    });
                } else {
                    // Use defaults
                    this.systemPrompts.push({
                        id: defaults.id,
                        name: defaults.name,
                        description: defaults.description || '',
                        category: defaults.category || 'utility',
                        defaultModel: defaults.defaultModel || 'mid',
                        promptTemplate: defaults.promptTemplate || '',
                        roleIntro: defaults.roleIntro,
                        decisionInstructions: defaults.decisionInstructions,
                        isCustomized: false
                    });
                }
            } catch {
                // Use defaults if daemon call fails
                this.systemPrompts.push({
                    id: defaults.id,
                    name: defaults.name,
                    description: defaults.description || '',
                    category: defaults.category || 'utility',
                    defaultModel: defaults.defaultModel || 'mid',
                    promptTemplate: defaults.promptTemplate || '',
                    roleIntro: defaults.roleIntro,
                    decisionInstructions: defaults.decisionInstructions,
                    isCustomized: false
                });
            }
        }
        
        // Sort: coordinator first, then by category, then by name
        this.systemPrompts.sort((a, b) => {
            if (a.id === 'coordinator') return -1;
            if (b.id === 'coordinator') return 1;
            if (a.category !== b.category) {
                const categoryOrder = { coordinator: 0, planning: 1, execution: 2, utility: 3 };
                return (categoryOrder[a.category] || 99) - (categoryOrder[b.category] || 99);
            }
            return a.name.localeCompare(b.name);
        });
    }

    /**
     * Load config from local file
     */
    private loadConfigFromFile(): ConfigData {
        const configPath = path.join(this.workspaceRoot, '_AiDevLog', '.config', 'daemon.json');
        if (fs.existsSync(configPath)) {
            try {
                const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                return { ...this.getDefaultConfig(), ...fileConfig };
            } catch (err) {
                log.error('Failed to read config file:', err);
            }
        }
        return this.getDefaultConfig();
    }

    /**
     * Load folders from local file
     */
    private loadFoldersFromFile(): FolderStructure {
        const foldersPath = path.join(this.workspaceRoot, '_AiDevLog', '.config', 'folders.json');
        if (fs.existsSync(foldersPath)) {
            try {
                return JSON.parse(fs.readFileSync(foldersPath, 'utf8'));
            } catch (err) {
                log.error('Failed to read folders file:', err);
            }
        }
        return this.getDefaultFolders();
    }

    /**
     * Get default config values
     */
    private getDefaultConfig(): ConfigData {
        return {
            workingDirectory: '_AiDevLog',
            agentPoolSize: 10,
            defaultBackend: 'cursor',
            enableUnityFeatures: true,
            port: 19840,
            logLevel: 'info',
            autoOpenTerminals: true
        };
    }

    /**
     * Get default folder structure
     */
    private getDefaultFolders(): FolderStructure {
        return {
            plans: 'Plans',
            logs: 'Logs',
            state: 'State',
            tasks: 'Tasks',
            config: '.config',
            cache: '.cache'
        };
    }

    /**
     * Save config to local file
     */
    private saveConfigToFile(key: string, value: any): void {
        const configPath = path.join(this.workspaceRoot, '_AiDevLog', '.config', 'daemon.json');
        try {
            let config: Record<string, any> = {};
            if (fs.existsSync(configPath)) {
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
            config[key] = value;
            
            const dir = path.dirname(configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        } catch (err) {
            log.error('Failed to write config file:', err);
            throw err;
        }
    }

    /**
     * Save folder config to local file
     */
    private saveFolderToFile(folder: string, name: string): void {
        const foldersPath = path.join(this.workspaceRoot, '_AiDevLog', '.config', 'folders.json');
        try {
            let folders: any = this.getDefaultFolders();
            if (fs.existsSync(foldersPath)) {
                folders = JSON.parse(fs.readFileSync(foldersPath, 'utf8'));
            }
            folders[folder] = name;
            
            const dir = path.dirname(foldersPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(foldersPath, JSON.stringify(folders, null, 2));
        } catch (err) {
            log.error('Failed to write folders file:', err);
            throw err;
        }
    }

    /**
     * Handle messages from the webview
     */
    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'setConfig':
                await this.setConfig(message.key, message.value);
                break;
            case 'resetConfig':
                await this.resetConfig(message.key);
                break;
            case 'setFolder':
                await this.setFolder(message.folder, message.name);
                break;
            case 'resetFolder':
                await this.resetFolder(message.folder);
                break;
            case 'resetAllFolders':
                await this.resetAllFolders();
                break;
            case 'resetAll':
                await this.resetAll();
                break;
            case 'refresh':
                await this.loadDataAndRender();
                break;
            case 'openConfigFile':
                await this.openConfigFile();
                break;
            case 'selectMcpPackage':
                await this.selectMcpPackage(message.packageId);
                break;
            case 'autoConfigureMcp':
                await this.autoConfigureMcp(message.packageId);
                break;
            case 'openMcpConfig':
                await this.openMcpConfig();
                break;
            case 'refreshMcpStatus':
                await this.refreshMcpStatus();
                break;
            case 'testMcpConnection':
                await this.testMcpConnection();
                break;
            case 'openMcpDocs':
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/CoplayDev/unity-mcp#installation'));
                break;
            case 'installMcpToUnity':
                await this.installMcpToUnity();
                break;
            case 'installMcpToBackendCli':
                await this.installMcpToBackendCli();
                break;
            case 'installCursorAgent':
                await this.installCursorAgent();
                break;
            case 'reinstallCursorAgent':
                await this.reinstallCursorAgent();
                break;
            case 'loginCursorAgent':
                await this.loginCursorAgent();
                break;
            case 'refreshCursorAgentStatus':
                await this.refreshCursorAgentStatus();
                break;
            case 'showMessage':
                vscode.window.showInformationMessage(message.message);
                break;
            case 'saveCoordinatorPrompt':
                // Redirect to system prompt handler (coordinator is now a system prompt)
                await this.saveSystemPrompt('coordinator', message.config);
                break;
            case 'resetCoordinatorPrompt':
                // Redirect to system prompt handler
                await this.resetSystemPrompt('coordinator');
                break;
            case 'installCursorCli':
                await this.installCursorCli();
                break;
            case 'checkCursorCliStatus':
                await this.checkCursorCliStatus();
                break;
            case 'saveSystemPrompt':
                await this.saveSystemPrompt(message.promptId, message.config);
                break;
            case 'resetSystemPrompt':
                await this.resetSystemPrompt(message.promptId);
                break;
        }
    }
    
    /**
     * Save a system prompt
     */
    private async saveSystemPrompt(promptId: string, configData: Partial<SystemPromptConfig>): Promise<void> {
        try {
            if (this.daemonConnected) {
                await this.vsCodeClient.send('prompts.updateSystemPrompt', { id: promptId, config: configData });
                vscode.window.showInformationMessage(`${configData.name || promptId} prompt saved successfully`);
            } else {
                // For non-daemon mode, save to local file
                const promptPath = path.join(this.workspaceRoot, '_AiDevLog', '.config', 'prompts', `${promptId}.json`);
                const dir = path.dirname(promptPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(promptPath, JSON.stringify(configData, null, 2));
                vscode.window.showInformationMessage(`${configData.name || promptId} prompt saved to local config`);
            }
            await this.loadDataAndRender();
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to save prompt: ${message}`);
        }
    }
    
    /**
     * Reset a system prompt to defaults
     */
    private async resetSystemPrompt(promptId: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Reset ${promptId} prompt to defaults? Your customizations will be lost.`,
            { modal: true },
            'Reset'
        );

        if (confirm === 'Reset') {
            try {
                if (this.daemonConnected) {
                    await this.vsCodeClient.send('prompts.resetSystemPrompt', { id: promptId });
                } else {
                    // For non-daemon mode, delete the local config file
                    const promptPath = path.join(this.workspaceRoot, '_AiDevLog', '.config', 'prompts', `${promptId}.json`);
                    if (fs.existsSync(promptPath)) {
                        fs.unlinkSync(promptPath);
                    }
                }
                vscode.window.showInformationMessage(`${promptId} prompt reset to defaults`);
                await this.loadDataAndRender();
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Failed to reset prompt: ${message}`);
            }
        }
    }
    
    /**
     * Set a config value
     */
    private async setConfig(key: string, value: unknown): Promise<void> {
        try {
            // Convert value to proper type
            let typedValue: unknown = value;
            if (key === 'agentPoolSize' || key === 'port') {
                typedValue = parseInt(value as string, 10);
            } else if (key === 'enableUnityFeatures' || key === 'autoOpenTerminals') {
                typedValue = value === 'true' || value === true;
            }
            
            if (this.daemonConnected) {
                // Use daemon API
                const result = await this.vsCodeClient.setConfig(key, typedValue);
                if (result.success) {
                    vscode.window.showWarningMessage(
                        `Setting "${key}" updated. Restart daemon for changes to take effect.`,
                        'Restart Daemon'
                    ).then(selection => {
                        if (selection === 'Restart Daemon') {
                            vscode.commands.executeCommand('agenticPlanning.restartDaemon');
                        }
                    });
                    await this.loadDataAndRender();
                } else {
                    vscode.window.showErrorMessage(`Failed to update: ${result.error}`);
                }
            } else {
                // Write to local file
                this.saveConfigToFile(key, typedValue);
                this.config = this.loadConfigFromFile();
                vscode.window.showInformationMessage(`Setting "${key}" saved to local config. Start daemon to apply.`);
                await this.loadDataAndRender();
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error updating setting: ${err}`);
        }
    }

    /**
     * Reset a config value to default
     */
    private async resetConfig(key?: string): Promise<void> {
        try {
            const result = await this.vsCodeClient.resetConfig(key);
            if (result.success) {
                vscode.window.showInformationMessage(key ? `"${key}" reset to default` : 'All settings reset to defaults');
                await this.loadDataAndRender();
            } else {
                vscode.window.showErrorMessage(`Failed to reset: ${result.error}`);
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error resetting: ${err}`);
        }
    }

    /**
     * Set a folder name
     */
    private async setFolder(folder: string, name: string): Promise<void> {
        try {
            if (this.daemonConnected) {
                // Use daemon API
                const result = await this.vsCodeClient.setFolder(folder, name);
                if (result.success) {
                    vscode.window.showInformationMessage(`Folder "${folder}" set to "${name}"`);
                    await this.loadDataAndRender();
                } else {
                    vscode.window.showErrorMessage(`Failed to set folder: ${result.error}`);
                }
            } else {
                // Write to local file
                this.saveFolderToFile(folder, name);
                this.folders = this.loadFoldersFromFile();
                vscode.window.showInformationMessage(`Folder "${folder}" saved to local config`);
                await this.loadDataAndRender();
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error setting folder: ${err}`);
        }
    }

    /**
     * Reset a folder to default
     */
    private async resetFolder(folder: string): Promise<void> {
        try {
            const result = await this.vsCodeClient.resetFolders(folder);
            if (result.success) {
                vscode.window.showInformationMessage(`Folder "${folder}" reset to default`);
                await this.loadDataAndRender();
            } else {
                vscode.window.showErrorMessage(`Failed to reset folder: ${result.error}`);
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error resetting folder: ${err}`);
        }
    }

    /**
     * Reset all folders to defaults
     */
    private async resetAllFolders(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Reset all folder names to defaults?',
            { modal: true },
            'Reset'
        );

        if (confirm === 'Reset') {
            try {
                const result = await this.vsCodeClient.resetFolders();
                if (result.success) {
                    vscode.window.showInformationMessage('All folders reset to defaults');
                    await this.loadDataAndRender();
                } else {
                    vscode.window.showErrorMessage(`Failed to reset: ${result.error}`);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Error resetting: ${err}`);
            }
        }
    }

    /**
     * Reset all settings to defaults
     */
    private async resetAll(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Reset all system settings to defaults? This will reset all config values and folder names.',
            { modal: true },
            'Reset All'
        );

        if (confirm === 'Reset All') {
            try {
                await this.vsCodeClient.resetConfig();
                await this.vsCodeClient.resetFolders();
                vscode.window.showInformationMessage('All system settings reset to defaults');
                await this.loadDataAndRender();
            } catch (err) {
                vscode.window.showErrorMessage(`Error resetting: ${err}`);
            }
        }
    }

    /**
     * Open the config file in editor
     */
    private async openConfigFile(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }
        
        const path = require('path');
        const fs = require('fs');
        const configPath = path.join(workspaceRoot, '_AiDevLog', '.config', 'daemon.json');
        
        // Create if doesn't exist
        if (!fs.existsSync(configPath)) {
            const dir = path.dirname(configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(configPath, '{}');
        }
        
        const uri = vscode.Uri.file(configPath);
        await vscode.window.showTextDocument(uri);
    }
    
    // ========================================================================
    // MCP Configuration Methods
    // ========================================================================
    
    /**
     * MCP package configurations
     * Only supporting CoplayDev/unity-mcp as the official Unity MCP integration
     * See: https://github.com/CoplayDev/unity-mcp
     */
    private getMcpPackageConfigs(): Record<string, any> {
        return {
            'CoplayDev/unity-mcp': {
                name: 'CoplayDev/unity-mcp',
                displayName: 'MCP for Unity (CoplayDev)',
                description: 'Official Unity MCP integration - requires Unity package installation',
                // HTTP transport is the default and recommended method
                config: {
                    url: 'http://localhost:8080/mcp'
                },
                // Stdio transport config (alternative, requires uv)
                stdioCofig: {
                    command: process.platform === 'win32' 
                        ? 'C:/Users/' + require('os').userInfo().username + '/AppData/Local/Microsoft/WinGet/Links/uv.exe'
                        : 'uv',
                    args: [
                        'run',
                        '--directory',
                        process.platform === 'win32'
                            ? 'C:/Users/' + require('os').userInfo().username + '/AppData/Local/UnityMCP/UnityMcpServer/src'
                            : process.platform === 'darwin'
                                ? require('os').homedir() + '/Library/AppSupport/UnityMCP/UnityMcpServer/src'
                                : require('os').homedir() + '/.local/share/UnityMCP/UnityMcpServer/src',
                        'server.py',
                        '--transport',
                        'stdio'
                    ]
                },
                installUrl: 'https://github.com/CoplayDev/unity-mcp',
                installSteps: [
                    'Install MCP for Unity package in Unity (Window > Package Manager > + > Add from git URL)',
                    'Open Unity and go to Window > MCP for Unity',
                    'Click "Start Local HTTP Server" to run the MCP server',
                    'Use Auto-Setup to configure Cursor, or manually add config below'
                ]
            }
        };
    }
    
    /**
     * Get MCP config path based on backend
     */
    private getMcpConfigPath(): string {
        const path = require('path');
        const os = require('os');
        const backend = this.config?.defaultBackend || 'cursor';
        
        // Different backends might have different config locations
        switch (backend) {
            case 'cursor':
            default:
                return path.join(os.homedir(), '.cursor', 'mcp.json');
        }
    }
    
    /**
     * Select an MCP package (just updates the UI, no action)
     */
    private async selectMcpPackage(packageId: string): Promise<void> {
        // This is handled in the frontend now - just update UI
        log.debug(`MCP package selected: ${packageId}`);
    }
    
    /**
     * Auto-configure MCP package (CoplayDev/unity-mcp only)
     */
    private async autoConfigureMcp(packageId: string): Promise<void> {
        const packages = this.getMcpPackageConfigs();
        const pkg = packages['CoplayDev/unity-mcp'];
        
        const backend = this.config?.defaultBackend || 'cursor';
        
        // Show installation steps
        const result = await vscode.window.showInformationMessage(
            `Configure MCP for Unity (CoplayDev) for ${backend}?\n\n` +
            `This will add the HTTP MCP config to ${this.getMcpConfigPath()}\n\n` +
            `Prerequisites:\n` +
            `• Install MCP for Unity package in Unity\n` +
            `• Start HTTP server in Unity (Window → MCP for Unity)\n` +
            `• Restart ${backend} after configuration`,
            { modal: true },
            'Configure',
            'Open Documentation'
        );
        
        if (result === 'Configure') {
            await this.writeMcpConfig(pkg);
        } else if (result === 'Open Documentation') {
            vscode.env.openExternal(vscode.Uri.parse(pkg.installUrl));
        }
    }
    
    /**
     * Write MCP configuration to config file
     * Configures CoplayDev/unity-mcp with HTTP transport
     */
    private async writeMcpConfig(pkg: any): Promise<void> {
        const path = require('path');
        const fs = require('fs');
        
        const mcpConfigPath = this.getMcpConfigPath();
        
        try {
            // Read existing config or create new
            let config: any = { mcpServers: {} };
            if (fs.existsSync(mcpConfigPath)) {
                try {
                    config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
                    if (!config.mcpServers) {
                        config.mcpServers = {};
                    }
                } catch (e) {
                    log.warn('Failed to parse MCP config, creating new:', e);
                }
            } else {
                // Ensure directory exists
                const dir = path.dirname(mcpConfigPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
            }
            
            // Add Unity MCP configuration (HTTP transport - CoplayDev default)
            // Note: Uses "UnityMCP" as the key to match CoplayDev documentation
            config.mcpServers.UnityMCP = pkg.config;
            
            // Write config
            const newContent = JSON.stringify(config, null, 2);
            log.info(`Writing MCP config to ${mcpConfigPath}: ${newContent}`);
            fs.writeFileSync(mcpConfigPath, newContent);
            
            // Verify the file was written correctly
            const verifyContent = fs.readFileSync(mcpConfigPath, 'utf-8');
            log.info(`Verified MCP config: ${verifyContent}`);
            
            // Refresh status in the webview immediately
            await this.refreshMcpStatus();
            
            // Trigger global dependency refresh (client-side)
            log.info('Triggering global dependency refresh...');
            await vscode.commands.executeCommand('agenticPlanning.refreshDependencies');
            
            // Also refresh via daemon (server-side comprehensive check)
            if (this.vsCodeClient.isConnected()) {
                try {
                    await this.vsCodeClient.send('deps.refresh');
                    log.info('Daemon dependency check completed');
                } catch (err) {
                    log.warn('Failed to refresh dependencies on daemon:', err);
                }
            }
            
            const backend = this.config?.defaultBackend || 'cursor';
            
            vscode.window.showInformationMessage(
                `MCP for Unity configured!\n\nNext steps:\n1. Install Unity package from CoplayDev/unity-mcp\n2. Start HTTP server in Unity\n3. Restart ${backend}`,
                'Open Documentation',
                'Reload Window'
            ).then(async selection => {
                if (selection === 'Open Documentation') {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/CoplayDev/unity-mcp'));
                } else if (selection === 'Reload Window') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
            
        } catch (err) {
            log.error('Failed to configure MCP:', err);
            vscode.window.showErrorMessage(`Failed to configure MCP: ${err}`);
        }
    }
    
    /**
     * Open MCP config file
     */
    private async openMcpConfig(): Promise<void> {
        const path = require('path');
        const fs = require('fs');
        const os = require('os');
        
        const mcpConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');
        
        // Create if doesn't exist
        if (!fs.existsSync(mcpConfigPath)) {
            const dir = path.dirname(mcpConfigPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }, null, 2));
        }
        
        const uri = vscode.Uri.file(mcpConfigPath);
        await vscode.window.showTextDocument(uri);
    }
    
    /**
     * Refresh and send MCP status to webview
     * Queries daemon for comprehensive status (not local file read)
     * MCP is a core service used by AgentRunner in the daemon
     * Checks for both "UnityMCP" (CoplayDev format) and "unityMCP" (legacy format)
     */
    private async refreshMcpStatus(): Promise<void> {
        const fs = require('fs');
        const path = require('path');
        
        const mcpConfigPath = this.getMcpConfigPath();
        const daemonConnected = this.vsCodeClient && this.vsCodeClient.isConnected();
        
        let status: {
            installed: boolean;
            connected?: boolean;
            configPath?: string;
            configSnippet?: string;
            packageId?: string;
            backend?: string;
            error?: string;
            // Step-specific statuses
            cursorAgentInstalled?: boolean;
            cursorAgentVersion?: string;
            cursorAuthValid?: boolean;
            unityPackageInstalled?: boolean;
            platform?: string;
            daemonConnected?: boolean;
        } = { 
            installed: false,
            backend: this.config?.defaultBackend || 'cursor',
            platform: process.platform,
            daemonConnected
        };
        
        try {
            // Step 1: Check Cursor Agent CLI installation
            const cursorAgentStatus = await this.checkCursorAgentStatus(false);
            status.cursorAgentInstalled = cursorAgentStatus.installed;
            status.cursorAgentVersion = cursorAgentStatus.version;
            
            // Step 2: Check Cursor CLI authentication (if agent is installed)
            if (status.cursorAgentInstalled) {
                status.cursorAuthValid = cursorAgentStatus.authenticated || false;
            }
            
            // Step 3: Check MCP configuration exists and is valid
            // Look for the config file AND verify it has unity-mcp entry
            if (fs.existsSync(mcpConfigPath)) {
                try {
                    const config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
                    const unityConfig = 
                        config.mcpServers?.['unity-mcp'] ||
                        config.servers?.['unity-mcp'] ||
                        config.mcpServers?.UnityMCP || 
                        config.servers?.UnityMCP;
                    
                    // Only mark as installed if we found a valid unity-mcp configuration
                    if (unityConfig && (unityConfig.url || unityConfig.command)) {
                        status.installed = true;
                        status.configPath = mcpConfigPath;
                        log.debug('MCP config found and validated:', { unityConfig, configPath: mcpConfigPath });
                    } else {
                        log.debug('MCP config file exists but no unity-mcp entry found');
                    }
                } catch (e) {
                    log.warn('Failed to parse MCP config:', e);
                }
            } else {
                log.debug('MCP config file does not exist:', mcpConfigPath);
            }
            
            // Step 4: Check Unity package installation
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                const workspaceRoot = workspaceFolders[0].uri.fsPath;
                const manifestPath = path.join(workspaceRoot, 'Packages', 'manifest.json');
                
                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                        const hasUnityMcp = manifest.dependencies && 
                            Object.keys(manifest.dependencies).some((key: string) => 
                                key.includes('unity-mcp') || key.includes('MCPForUnity')
                            );
                        status.unityPackageInstalled = hasUnityMcp;
                    } catch (e) {
                        log.warn('Failed to parse Unity manifest:', e);
                    }
                }
            }
            
            // Step 5: Check connection via daemon (only if prerequisites are met and daemon is connected)
            // Client uses daemon's cached dependency check result (doesn't trigger new check)
            if (status.installed && status.unityPackageInstalled && daemonConnected) {
                try {
                    const response = await this.vsCodeClient.send('deps.status');
                    const depsData = (response as any)?.data;
                    
                    if (depsData && Array.isArray(depsData.dependencies)) {
                        const unityMcp = depsData.dependencies.find((d: any) => 
                            d.name === 'MCP for Unity' || d.name.includes('Unity MCP')
                        );
                        
                        if (unityMcp && unityMcp.installed) {
                            status.connected = true;
                        }
                    }
                } catch (daemonErr) {
                    log.debug('Daemon MCP check failed (expected if server not running):', daemonErr);
                    // Don't treat as error - server might just not be started yet
                }
            }
            
        } catch (e) {
            log.error('Error checking MCP status:', e);
            status.error = e instanceof Error ? e.message : String(e);
        }
        
        // Send status to webview
        this.panel.webview.postMessage({
            type: 'mcpStatus',
            status
        });
    }
    
    /**
     * Test MCP connection explicitly (for Step 5)
     */
    private async testMcpConnection(): Promise<void> {
        try {
            vscode.window.showInformationMessage('Testing Unity MCP connection...', { modal: false });
            
            if (!this.vsCodeClient.isConnected()) {
                vscode.window.showErrorMessage('Daemon is not connected. Please ensure the system daemon is running.');
                return;
            }
            
            // Trigger a full dependency check via daemon
            const response = await this.vsCodeClient.send('deps.status');
            const depsData = (response as any)?.data;
            
            if (depsData && Array.isArray(depsData.dependencies)) {
                const unityMcp = depsData.dependencies.find((d: any) => 
                    d.name === 'MCP for Unity' || d.name.includes('Unity MCP')
                );
                
                if (unityMcp && unityMcp.installed) {
                    vscode.window.showInformationMessage(
                        '✅ Unity MCP connection successful! All systems ready.',
                        'OK'
                    );
                } else {
                    vscode.window.showWarningMessage(
                        '⚠️ Unity MCP is not responding.\n\n' +
                        'Make sure:\n' +
                        '• Unity Editor is open\n' +
                        '• MCP HTTP server is started (Window → MCP for Unity → Start Local HTTP Server)\n' +
                        '• Server is running on http://localhost:8080',
                        'Open Unity MCP Guide'
                    ).then(selection => {
                        if (selection === 'Open Unity MCP Guide') {
                            vscode.env.openExternal(vscode.Uri.parse('https://github.com/CoplayDev/unity-mcp#usage'));
                        }
                    });
                }
            } else {
                vscode.window.showErrorMessage('Failed to get dependency status from daemon.');
            }
            
            // Refresh the display
            await this.refreshMcpStatus();
            
        } catch (error) {
            log.error('Error testing MCP connection:', error);
            vscode.window.showErrorMessage(
                `Failed to test Unity MCP connection: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
    
    /**
     * Install MCP package to Unity via manifest.json
     */
    private async installMcpToUnity(): Promise<void> {
        const fs = require('fs');
        const path = require('path');
        
        // Get workspace root
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder found. Please open a Unity project.');
            return;
        }
        
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const manifestPath = path.join(workspaceRoot, 'Packages', 'manifest.json');
        
        // Check if Packages/manifest.json exists (Unity project)
        if (!fs.existsSync(manifestPath)) {
            vscode.window.showErrorMessage(
                'Packages/manifest.json not found. This does not appear to be a Unity project.',
                'Open Documentation'
            ).then(selection => {
                if (selection === 'Open Documentation') {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/CoplayDev/unity-mcp'));
                }
            });
            return;
        }
        
        // Show confirmation dialog
        const result = await vscode.window.showInformationMessage(
            `Install MCP for Unity package to Unity?\n\n` +
            `This will add the CoplayDev/unity-mcp package to Packages/manifest.json\n\n` +
            `Package: https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity\n\n` +
            `After installation:\n` +
            `• Unity will automatically import the package\n` +
            `• Go to Window → MCP for Unity → Start Local HTTP Server\n` +
            `• Use Auto-Configure to setup Cursor`,
            { modal: true },
            'Install to Unity',
            'Open Documentation'
        );
        
        if (result === 'Install to Unity') {
            try {
                // Read existing manifest
                let manifest: any = {};
                try {
                    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
                    manifest = JSON.parse(manifestContent);
                    if (!manifest.dependencies) {
                        manifest.dependencies = {};
                    }
                } catch (e) {
                    log.warn('Failed to parse manifest.json, creating new structure:', e);
                    manifest = { dependencies: {} };
                }
                
                // Add MCP for Unity package using git URL
                const packageUrl = 'https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity';
                const packageName = 'com.coplaydev.unity-mcp';
                
                // Check if already installed
                if (manifest.dependencies[packageName]) {
                    vscode.window.showInformationMessage(`MCP for Unity package is already installed: ${manifest.dependencies[packageName]}`);
                    return;
                }
                
                // Add package
                manifest.dependencies[packageName] = packageUrl;
                
                // Write manifest
                const newContent = JSON.stringify(manifest, null, 2);
                fs.writeFileSync(manifestPath, newContent);
                
                // Verify the file was written correctly
                const verifyContent = fs.readFileSync(manifestPath, 'utf-8');
                log.info(`Updated manifest.json: ${verifyContent}`);
                
                vscode.window.showInformationMessage(
                    '✓ MCP for Unity package added to manifest.json!\n\n' +
                    'Unity will automatically import the package. Next steps:\n' +
                    '1. Wait for Unity to finish importing\n' +
                    '2. Go to Window → MCP for Unity\n' +
                    '3. Click "Start Local HTTP Server"\n' +
                    '4. Use Auto-Configure to setup Cursor',
                    'Open Unity Documentation'
                ).then(selection => {
                    if (selection === 'Open Unity Documentation') {
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/CoplayDev/unity-mcp#installation'));
                    }
                });
                
                // Auto-refresh dependency status (both client & daemon)
                log.info('Auto-refreshing dependency status after Unity package installation...');
                await this.refreshMcpStatus();
                
                // Trigger global dependency refresh (client-side)
                await vscode.commands.executeCommand('agenticPlanning.refreshDependencies');
                
                // Also refresh via daemon (server-side comprehensive check)
                if (this.vsCodeClient.isConnected()) {
                    try {
                        await this.vsCodeClient.send('deps.refresh');
                        log.info('Daemon dependency check completed');
                    } catch (err) {
                        log.warn('Failed to refresh dependencies on daemon:', err);
                    }
                }
                
            } catch (err) {
                log.error('Failed to install MCP to Unity:', err);
                vscode.window.showErrorMessage(`Failed to install MCP to Unity: ${err}`);
            }
        } else if (result === 'Open Documentation') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/CoplayDev/unity-mcp'));
        }
    }
    
    /**
     * Install MCP to Backend CLI (Cursor CLI or other supported CLI)
     */
    private async installMcpToBackendCli(): Promise<void> {
        const backend = this.config?.defaultBackend || 'cursor';
        
        // Show instructions with multi-platform support
        const instructions = 
            `Install MCP for Unity via ${backend} CLI:\n\n` +
            `1. Install Unity package (see "Install to Unity" button)\n` +
            `2. Start HTTP server in Unity (Window → MCP for Unity)\n` +
            `3. Configure via CLI:\n\n` +
            `   ${backend} mcp add unity-mcp --url http://localhost:8080/mcp\n\n` +
            `Or manually edit ${this.getMcpConfigPath()}:\n` +
            `{\n` +
            `  "mcpServers": {\n` +
            `    "UnityMCP": {\n` +
            `      "url": "http://localhost:8080/mcp"\n` +
            `    }\n` +
            `  }\n` +
            `}\n\n` +
            `4. Restart ${backend}`;
        
        const result = await vscode.window.showInformationMessage(
            instructions,
            { modal: true },
            'Copy CLI Command',
            'Copy Config Path',
            'Open Documentation'
        );
        
        if (result === 'Copy CLI Command') {
            await vscode.env.clipboard.writeText(`${backend} mcp add unity-mcp --url http://localhost:8080/mcp`);
            vscode.window.showInformationMessage('CLI command copied to clipboard!');
        } else if (result === 'Copy Config Path') {
            await vscode.env.clipboard.writeText(this.getMcpConfigPath());
            vscode.window.showInformationMessage('Config path copied to clipboard!');
        } else if (result === 'Open Documentation') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/CoplayDev/unity-mcp#installation'));
        }
    }
    
    /**
     * Install Cursor CLI
     */
    private async installCursorCli(): Promise<void> {
        // Show instructions since Cursor CLI is installed via Cursor itself
        vscode.window.showInformationMessage(
            'To install Cursor CLI: Open Command Palette (Ctrl+Shift+P) → Type "Install cursor command" → Press Enter',
            'Open Command Palette'
        ).then(selection => {
            if (selection === 'Open Command Palette') {
                vscode.commands.executeCommand('workbench.action.showCommands', 'cursor');
            }
        });
    }
    
    /**
     * Check Cursor CLI status
     */
    private async checkCursorCliStatus(): Promise<void> {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsyncRaw = promisify(exec);
        // Wrapper to hide terminal windows on Windows
        const execAsync = (cmd: string, opts?: any) => execAsyncRaw(cmd, { ...opts, windowsHide: true });
        
        let status: {
            installed: boolean;
            version?: string;
        } = { installed: false };
        
        try {
            const { stdout } = await execAsync('cursor --version');
            status = {
                installed: true,
                version: stdout.trim()
            };
        } catch {
            status = { installed: false };
        }
        
        // Send status to webview
        this.panel.webview.postMessage({
            type: 'cursorCliStatus',
            status
        });
    }
    
    /**
     * Install cursor-agent CLI
     */
    private async installCursorAgent(): Promise<void> {
        const platform = process.platform;
        
        // Get the absolute path from extension bundle
        const scriptName = platform === 'win32' 
            ? 'install-cursor-agent.ps1'
            : 'install-cursor-agent.sh';
        const scriptUri = vscode.Uri.joinPath(
            this.extensionUri,
            'out',
            'scripts',
            scriptName
        );
        const scriptPath = scriptUri.fsPath;
        
        // Verify script exists
        if (!fs.existsSync(scriptPath)) {
            vscode.window.showErrorMessage(
                `Installation script not found at: ${scriptPath}\n\nPlease ensure the extension is properly installed.`
            );
            return;
        }
        
        const message = platform === 'win32'
            ? 'This will run the PowerShell installation script for cursor-agent in WSL.\n\n' +
              'The script will:\n' +
              '• Check/install WSL if needed\n' +
              '• Install Ubuntu if needed\n' +
              '• Install cursor-agent in WSL\n' +
              '• Configure PATH automatically\n\n' +
              'Administrator privileges may be required for WSL installation.'
            : 'This will run the installation script for cursor-agent.\n\n' +
              'The script will:\n' +
              '• Download the official cursor-agent installer\n' +
              '• Install cursor-agent to ~/.local/bin\n' +
              '• Configure your shell PATH automatically';
        
        const result = await vscode.window.showInformationMessage(
            message,
            { modal: true },
            'Install',
            'Cancel'
        );
        
        if (result === 'Install') {
            const terminal = vscode.window.createTerminal({
                name: 'Install cursor-agent',
                hideFromUser: false
            });
            
            terminal.show();
            
            if (platform === 'win32') {
                // Use Start-Process with -Verb RunAs to request admin privileges
                const command = `Start-Process powershell.exe -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-NoProfile','-File','"${scriptPath}"'`;
                terminal.sendText(command);
                log.info(`Running setup script: ${scriptPath}`);
            } else {
                terminal.sendText(`sudo bash "${scriptPath}"`);
                log.info(`Running setup script: ${scriptPath}`);
            }
            
            vscode.window.showInformationMessage(
                'Installation script started. Check the terminal for progress.',
                'Refresh Status'
            ).then(selection => {
                if (selection === 'Refresh Status') {
                    this.refreshCursorAgentStatus();
                }
            });
        }
    }
    
    /**
     * Reinstall cursor-agent CLI
     */
    private async reinstallCursorAgent(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Reinstall cursor-agent CLI?\n\nThis will reinstall cursor-agent to the latest version.',
            { modal: true },
            'Reinstall',
            'Cancel'
        );
        
        if (confirm === 'Reinstall') {
            await this.installCursorAgent();
        }
    }
    
    /**
     * Login to cursor-agent CLI
     */
    private async loginCursorAgent(): Promise<void> {
        const platform = process.platform;
        
        const message = 'This will open a terminal to login to cursor-agent.\n\n' +
            'You can login using:\n' +
            '• Cursor account credentials\n' +
            '• CURSOR_API_KEY environment variable';
        
        const result = await vscode.window.showInformationMessage(
            message,
            { modal: true },
            'Open Login Terminal',
            'Cancel'
        );
        
        if (result === 'Open Login Terminal') {
            const terminal = vscode.window.createTerminal({
                name: 'cursor-agent login',
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            });
            
            terminal.show();
            
            if (platform === 'win32') {
                terminal.sendText('wsl -d Ubuntu bash -c "~/.local/bin/cursor-agent login"');
            } else {
                terminal.sendText('cursor-agent login');
            }
            
            vscode.window.showInformationMessage(
                'Complete the login in the terminal, then click Refresh to update status.',
                'Refresh Status'
            ).then(selection => {
                if (selection === 'Refresh Status') {
                    this.refreshCursorAgentStatus();
                }
            });
        }
    }
    
    /**
     * Refresh cursor-agent status
     * 
     * IMPORTANT: Uses the SAME detection logic as DependencyService for consistency
     */
    
    /**
     * Check cursor agent status (used by MCP status refresh)
     * @param updateWebview - if true, also updates the UI status
     */
    private async checkCursorAgentStatus(updateWebview: boolean = true): Promise<{
        installed: boolean;
        version?: string;
        platform: string;
        authenticated?: boolean;
    }> {
        const { execSync } = require('child_process');
        
        let status: {
            installed: boolean;
            version?: string;
            platform: string;
            authenticated?: boolean;
        } = { 
            installed: false,
            platform: process.platform
        };
        
        try {
            let stdout: string;
            
            if (process.platform === 'win32') {
                // On Windows, check in WSL using the SAME method as DependencyService (execSync)
                stdout = execSync(
                    'wsl -d Ubuntu bash -c "if [ -f ~/.local/bin/cursor-agent ]; then ~/.local/bin/cursor-agent --version 2>&1; else echo NOT_FOUND; fi"',
                    { 
                        encoding: 'utf8',
                        stdio: ['pipe', 'pipe', 'pipe'],
                        timeout: 15000,  // 15 seconds - WSL can be slow
                        windowsHide: true
                    }
                ).trim();
                
                if (stdout && !stdout.includes('NOT_FOUND') && stdout.trim()) {
                    status = {
                        installed: true,
                        version: stdout.split('\n')[0] + ' (in WSL)',
                        platform: process.platform,
                        authenticated: undefined // Will check below
                    };
                    
                    // Check authentication status
                    try {
                        const authOutput = execSync(
                            'wsl -d Ubuntu bash -c "~/.local/bin/cursor-agent status 2>&1"',
                            { 
                                encoding: 'utf8',
                                stdio: ['pipe', 'pipe', 'pipe'],
                                timeout: 10000,
                                windowsHide: true
                            }
                        );
                        status.authenticated = !authOutput.includes('Authentication required') && !authOutput.includes('login');
                    } catch {
                        status.authenticated = false;
                    }
                }
            } else {
                // macOS/Linux: Check local installation
                stdout = execSync(
                    'cursor-agent --version 2>&1',
                    { 
                        encoding: 'utf8',
                        stdio: ['pipe', 'pipe', 'pipe'],
                        timeout: 10000
                    }
                ).trim();
                
                if (stdout && stdout.trim()) {
                    status = {
                        installed: true,
                        version: stdout.split('\n')[0],
                        platform: process.platform,
                        authenticated: undefined
                    };
                    
                    // Check authentication status
                    try {
                        const authOutput = execSync(
                            'cursor-agent status 2>&1',
                            { 
                                encoding: 'utf8',
                                stdio: ['pipe', 'pipe', 'pipe'],
                                timeout: 10000
                            }
                        );
                        status.authenticated = !authOutput.includes('Authentication required') && !authOutput.includes('login');
                    } catch {
                        status.authenticated = false;
                    }
                }
            }
        } catch (error) {
            log.debug('cursor-agent not found or error:', error);
            status.installed = false;
        }
        
        if (updateWebview) {
            this.panel.webview.postMessage({
                type: 'cursorAgentStatus',
                status
            });
        }
        
        return status;
    }
    
    private async refreshCursorAgentStatus(): Promise<void> {
        // Just call the helper with updateWebview=true
        await this.checkCursorAgentStatus(true);
    }
    
    // ========================================================================
    /**
     * Generate the webview HTML content
     */
    private getWebviewContent(): string {
        // Default values for display
        const defaults = {
            workingDirectory: '_AiDevLog',
            agentPoolSize: 10,
            defaultBackend: 'cursor',
            enableUnityFeatures: true,
            port: 19840,
            logLevel: 'info',
            autoOpenTerminals: true
        };

        const folderDefaults: FolderStructure = {
            plans: 'Plans',
            tasks: 'Tasks',
            logs: 'Logs',
            context: 'Context',
            docs: 'Docs',
            errors: 'Errors',
            scripts: 'Scripts',
            history: 'History',
            notifications: 'Notifications'
        };

        // Escape JSON for embedding in JS
        const configJson = JSON.stringify(this.config || defaults);
        const foldersJson = JSON.stringify(this.folders || folderDefaults);
        const defaultsJson = JSON.stringify(defaults);
        const folderDefaultsJson = JSON.stringify(folderDefaults);
        const systemPromptsJson = JSON.stringify(this.systemPrompts);
        const defaultSystemPromptsJson = JSON.stringify(
            Object.values(DefaultSystemPrompts).map(p => ({
                id: p.id,
                name: p.name,
                description: p.description || '',
                category: p.category || 'utility',
                defaultModel: p.defaultModel || 'mid',
                promptTemplate: p.promptTemplate || '',
                roleIntro: p.roleIntro,
                decisionInstructions: p.decisionInstructions
            }))
        );
        const daemonStatusJson = JSON.stringify({ connected: this.daemonConnected });

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>System Settings</title>
    <style>
${getSettingsCommonStyles()}
        
        /* Panel-specific styles */
        .sidebar {
            width: 180px;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        /* SystemSettings-specific overrides */
        .badge.default { background: rgba(100, 100, 100, 0.2); opacity: 0.7; }
        
        .form-group {
            margin-bottom: 16px;
        }
        
        .form-group:last-child {
            margin-bottom: 0;
        }
        
        .form-group label {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
        }
        
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .checkbox-group input[type="checkbox"] {
            width: auto;
        }
        
        .folder-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 12px;
        }
        
        .folder-item {
            padding: 12px;
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 4px;
        }
        
        .folder-item .folder-key {
            font-weight: 500;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .folder-item input {
            margin-bottom: 8px;
        }
        
        .config-display {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 12px;
            white-space: pre-wrap;
            word-break: break-all;
        }
        
        .info-box {
            padding: 12px;
            background: rgba(59, 130, 246, 0.1);
            border-left: 3px solid #3b82f6;
            border-radius: 0 4px 4px 0;
            margin-bottom: 16px;
        }
        
        .mcp-config-box {
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            margin: 12px 0;
            overflow: hidden;
        }
        
        .mcp-config-header {
            padding: 8px 12px;
            background: var(--input-bg);
            border-bottom: 1px solid var(--border-color);
        }
        
        .mcp-config-content {
            padding: 12px;
        }
        
        .mcp-config-content code {
            display: inline-block;
            padding: 2px 6px;
            background: var(--input-bg);
            border-radius: 3px;
            font-size: 0.9em;
            margin-bottom: 8px;
        }
        
        .mcp-config-content pre {
            margin: 8px 0 0 0;
            padding: 12px;
            background: var(--input-bg);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-all;
        }
        
        .badge.installed { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
        .badge.missing { background: rgba(239, 68, 68, 0.2); color: #f87171; }
        .badge.checking { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
        
        .install-step {
            display: flex;
            gap: 12px;
            margin-bottom: 16px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .install-step:last-child {
            margin-bottom: 0;
            padding-bottom: 0;
            border-bottom: none;
        }
        
        .step-number {
            width: 28px;
            height: 28px;
            background: var(--button-bg);
            color: var(--button-fg);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 600;
            flex-shrink: 0;
        }
        
        .step-content {
            flex: 1;
        }
        
        .step-content strong {
            display: block;
            margin-bottom: 8px;
        }
        
        .command-box {
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 8px 12px;
        }
        
        .command-box code {
            flex: 1;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
            background: none;
            padding: 0;
        }
        
        .copy-btn {
            padding: 4px 8px;
            font-size: 0.85em;
            background: transparent;
            border: 1px solid var(--border-color);
        }
        
        .copy-btn:hover {
            background: var(--input-bg);
        }
        
        .step-content pre {
            margin: 8px 0 0 0;
            padding: 12px;
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            overflow-x: auto;
            white-space: pre;
        }
        
        /* Sidebar section label */
        .sidebar-section-label {
            font-size: 0.7em;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.5;
            padding: 16px 12px 6px 12px;
            margin-top: 4px;
        }
        
        .sidebar-section-label:first-child {
            padding-top: 0;
            margin-top: 0;
        }
        
        /* Prompt form header */
        .prompt-form-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 8px;
        }
        
        .prompt-form-header h2 {
            margin: 0;
            font-size: 1.3em;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="header-row">
        <h1>⚙️ System Settings</h1>
        <div class="header-actions">
            <button class="secondary" onclick="openConfigFile()">Open Config File</button>
            <button class="secondary" onclick="refresh()">Refresh</button>
            <button class="danger" onclick="resetAll()">Reset All</button>
        </div>
    </div>
    
    <div class="layout">
        <div class="sidebar">
            <div class="sidebar-tabs" id="sidebar-tabs">
                <button class="sidebar-tab active" data-tab="general">
                    <span class="tab-icon">🎛️</span>General
                </button>
                <button class="sidebar-tab" data-tab="unity">
                    <span class="tab-icon">🎮</span>Unity
                </button>
                <button class="sidebar-tab" data-tab="folders">
                    <span class="tab-icon">📁</span>Folders
                </button>
                
                <!-- System Prompts Section -->
                <div class="sidebar-section-label">System Prompts</div>
                <div id="prompt-tabs">
                    <!-- Populated by JavaScript -->
                </div>
            </div>
        </div>
        
        <div class="main-content">
            <!-- General Tab -->
            <div id="general" class="tab-content active">
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">Daemon Configuration</div>
                    </div>
                    
                    <div class="form-group">
                        <label>
                            Port
                            <span id="port-badge" class="badge default">Default</span>
                        </label>
                        <input 
                            type="number" 
                            id="port" 
                            min="1024"
                            max="65535"
                            onchange="setConfig('port', this.value)"
                        />
                        <div class="hint">WebSocket port for daemon communication. Requires daemon restart.</div>
                    </div>
                    
                    <div class="form-group">
                        <label>
                            Log Level
                            <span id="logLevel-badge" class="badge default">Default</span>
                        </label>
                        <select id="logLevel" onchange="setConfig('logLevel', this.value)">
                            <option value="debug">Debug (verbose)</option>
                            <option value="info">Info (default)</option>
                            <option value="warn">Warning</option>
                            <option value="error">Error only</option>
                        </select>
                        <div class="hint">Daemon log verbosity level.</div>
                    </div>
                    
                    <div class="form-group">
                        <label>
                            Backend
                            <span id="defaultBackend-badge" class="badge default">Default</span>
                        </label>
                        <select id="defaultBackend" onchange="setConfig('defaultBackend', this.value)">
                            <option value="cursor">Cursor</option>
                            <option value="claude">Claude</option>
                            <option value="codex">Codex</option>
                        </select>
                        <div class="hint">AI backend for agent sessions. Each backend requires its CLI to be installed.</div>
                    </div>
                </div>
                
                <div class="section" data-requires-daemon>
                    <div class="section-header">
                        <div class="section-title">
                            Cursor Agent CLI
                            <a href="https://cursor.com/docs/cli/installation" style="color: #c084fc; text-decoration: none; font-size: 0.85em; margin-left: 8px;">📖 Docs</a>
                        </div>
                        <span id="cursor-agent-status-badge" class="badge default">Checking...</span>
                    </div>
                    
                    <p style="opacity: 0.8; margin: 0 0 12px 0; font-size: 0.9em;">
                        Required for running AI agents with the Cursor backend.
                        <span id="cursor-agent-platform-hint" style="display: inline;"></span>
                    </p>
                    
                    <div id="cursor-agent-status-section" style="margin-bottom: 12px;">
                        <div style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">
                            <span style="opacity: 0.7;">Status:</span>
                            <code id="cursor-agent-version" style="flex: 1;">Not installed</code>
                        </div>
                    </div>
                    
                    <div class="button-row">
                        <button id="install-cursor-agent-btn" onclick="installCursorAgent()">
                            Install cursor-agent
                        </button>
                        <button class="secondary" id="reinstall-cursor-agent-btn" onclick="reinstallCursorAgent()" style="display: none;">
                            Reinstall
                        </button>
                        <button class="secondary" id="login-cursor-agent-btn" onclick="loginCursorAgent()" style="display: none;">
                            Login
                        </button>
                        <button class="secondary" onclick="refreshCursorAgentStatus()">
                            Refresh
                        </button>
                    </div>
                </div>
                
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">Current Configuration</div>
                    </div>
                    
                    <div class="config-display" id="config-display"></div>
                </div>
            </div>
            
            <!-- Unity Tab -->
            <div id="unity" class="tab-content">
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">Unity Integration</div>
                    </div>
                    
                    <div class="form-group">
                        <div class="checkbox-group">
                            <input 
                                type="checkbox" 
                                id="enableUnityFeatures"
                                onchange="setConfig('enableUnityFeatures', this.checked)"
                            />
                            <label for="enableUnityFeatures" style="margin-bottom: 0;">
                                Enable Unity Features
                                <span id="enableUnityFeatures-badge" class="badge default">Default</span>
                            </label>
                        </div>
                        <div class="hint">
                            MCP integration, Unity Control Manager, compilation/testing pipelines.
                        </div>
                    </div>
                </div>
                
                <div class="section" data-requires-daemon>
                    <div class="section-header">
                        <div class="section-title">
                            MCP for Unity - Installation Guide
                            <a href="https://github.com/CoplayDev/unity-mcp" style="color: #c084fc; text-decoration: none; font-size: 0.85em; margin-left: 8px;">CoplayDev</a>
                        </div>
                        <span id="mcp-overall-status-badge" class="badge default">Checking...</span>
                    </div>
                    
                    <p style="opacity: 0.8; margin: 0 0 16px 0; font-size: 0.9em;">
                        Follow these steps to enable AI agents to control Unity Editor. 
                        <a href="https://github.com/CoplayDev/unity-mcp#installation" style="color: #60a5fa;">Full setup guide</a>
                    </p>
                    
                    <!-- Installation Steps -->
                    <div id="mcp-installation-steps" style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px;">
                        
                        <!-- Step 1: Install Cursor Agent CLI in WSL -->
                        <div class="installation-step" id="step-cursor-agent" style="border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; background: rgba(0,0,0,0.2);">
                            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                                <span id="step-cursor-agent-icon" class="step-icon" style="font-size: 20px;">⏳</span>
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; margin-bottom: 4px;">
                                        Step 1: Install Cursor Agent CLI in WSL
                                        <span id="step-cursor-agent-badge" class="badge default" style="margin-left: 8px; font-size: 0.75em;">Checking...</span>
                                    </div>
                                    <div style="opacity: 0.7; font-size: 0.85em;">
                                        <span id="step-cursor-agent-platform-hint"></span>
                                    </div>
                                </div>
                                <button id="step-cursor-agent-btn" class="secondary" onclick="installStepCursorAgent()" style="min-width: 100px;">
                                    Install
                                </button>
                            </div>
                            <div id="step-cursor-agent-details" style="font-size: 0.85em; opacity: 0.7; padding-left: 32px; display: none;">
                                Status details will appear here
                            </div>
                        </div>
                        
                        <!-- Step 2: Cursor CLI Authentication -->
                        <div class="installation-step" id="step-cursor-auth" style="border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; background: rgba(0,0,0,0.2);">
                            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                                <span id="step-cursor-auth-icon" class="step-icon" style="font-size: 20px;">⏳</span>
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; margin-bottom: 4px;">
                                        Step 2: Cursor CLI Authentication
                                        <span id="step-cursor-auth-badge" class="badge default" style="margin-left: 8px; font-size: 0.75em;">Waiting...</span>
                                    </div>
                                    <div style="opacity: 0.7; font-size: 0.85em;">Login to Cursor account via CLI</div>
                                </div>
                                <button id="step-cursor-auth-btn" class="secondary" onclick="loginStepCursorAuth()" style="min-width: 100px;" disabled>
                                    Login
                                </button>
                            </div>
                            <div id="step-cursor-auth-details" style="font-size: 0.85em; opacity: 0.7; padding-left: 32px; display: none;">
                                Status details will appear here
                            </div>
                        </div>
                        
                        <!-- Step 3: Install MCP Configuration -->
                        <div class="installation-step" id="step-mcp-config" style="border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; background: rgba(0,0,0,0.2);">
                            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                                <span id="step-mcp-config-icon" class="step-icon" style="font-size: 20px;">⏳</span>
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; margin-bottom: 4px;">
                                        Step 3: Install MCP Configuration
                                        <span id="step-mcp-config-badge" class="badge default" style="margin-left: 8px; font-size: 0.75em;">Waiting...</span>
                                    </div>
                                    <div style="opacity: 0.7; font-size: 0.85em;">
                                        Add Unity MCP to <code id="step-mcp-config-path" style="font-size: 0.9em;">~/.cursor/mcp.json</code>
                                    </div>
                                </div>
                                <button id="step-mcp-config-btn" class="secondary" onclick="installStepMcpConfig()" style="min-width: 100px;" disabled>
                                    Configure
                                </button>
                            </div>
                            <div id="step-mcp-config-details" style="font-size: 0.85em; opacity: 0.7; padding-left: 32px; display: none;">
                                Status details will appear here
                            </div>
                        </div>
                        
                        <!-- Step 4: Install Package to Unity -->
                        <div class="installation-step" id="step-unity-package" style="border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; background: rgba(0,0,0,0.2);">
                            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                                <span id="step-unity-package-icon" class="step-icon" style="font-size: 20px;">⏳</span>
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; margin-bottom: 4px;">
                                        Step 4: Install Package to Unity
                                        <span id="step-unity-package-badge" class="badge default" style="margin-left: 8px; font-size: 0.75em;">Waiting...</span>
                                    </div>
                                    <div style="opacity: 0.7; font-size: 0.85em;">
                                        Add Unity MCP package to Unity project, then start HTTP server
                                    </div>
                                </div>
                                <button id="step-unity-package-btn" class="secondary" onclick="installStepUnityPackage()" style="min-width: 100px;" disabled>
                                    Install
                                </button>
                            </div>
                            <div id="step-unity-package-details" style="font-size: 0.85em; opacity: 0.7; padding-left: 32px; display: none;">
                                After installation:
                                <ul style="margin: 8px 0; padding-left: 20px;">
                                    <li>Unity will import the package automatically</li>
                                    <li>Open Unity Editor</li>
                                    <li>Go to <strong>Window → MCP for Unity → Start Local HTTP Server</strong></li>
                                    <li>Server should start on <code>http://localhost:8080</code></li>
                                </ul>
                            </div>
                        </div>
                        
                        <!-- Step 5: Test Connection -->
                        <div class="installation-step" id="step-test-connection" style="border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; background: rgba(0,0,0,0.2);">
                            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                                <span id="step-test-connection-icon" class="step-icon" style="font-size: 20px;">⏳</span>
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; margin-bottom: 4px;">
                                        Step 5: Test Connection
                                        <span id="step-test-connection-badge" class="badge default" style="margin-left: 8px; font-size: 0.75em;">Waiting...</span>
                                    </div>
                                    <div style="opacity: 0.7; font-size: 0.85em;">Verify Unity MCP connection and run dependency check</div>
                                </div>
                                <button id="step-test-connection-btn" class="secondary" onclick="testStepConnection()" style="min-width: 100px;" disabled>
                                    Test
                                </button>
                            </div>
                            <div id="step-test-connection-details" style="font-size: 0.85em; opacity: 0.7; padding-left: 32px; display: none;">
                                Status details will appear here
                            </div>
                        </div>
                        
                    </div>
                    
                    <!-- Quick Actions -->
                    <div class="button-row" style="margin-top: 8px;">
                        <button class="secondary" onclick="openMcpConfig()">
                            Open Config
                        </button>
                        <button class="secondary" onclick="refreshAllMcpSteps()">
                            Refresh All Steps
                        </button>
                        <button class="secondary" onclick="vscode.postMessage({ command: 'openMcpDocs' })">
                            Documentation
                        </button>
                    </div>
                </div>
                
            </div>
            
            <!-- Folders Tab -->
            <div id="folders" class="tab-content">
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">Folder Structure</div>
                        <button class="secondary" onclick="resetAllFolders()">Reset All</button>
                    </div>
                    
                    <p style="opacity: 0.8; margin: 0 0 16px 0;">
                        Customize folder names within <code>_AiDevLog/</code>. Changes apply immediately.
                    </p>
                    
                    <div class="folder-grid" id="folder-grid"></div>
                </div>
            </div>
            
            <!-- System Prompt Tabs (dynamically generated) -->
            <div id="prompt-contents">
                <!-- Populated by JavaScript - one tab-content per prompt -->
            </div>
            
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const daemonStatus = ${daemonStatusJson};
        
        // Data
        const config = ${configJson};
        const folders = ${foldersJson};
        const defaults = ${defaultsJson};
        const folderDefaults = ${folderDefaultsJson};
        const systemPrompts = ${systemPromptsJson};
        const defaultSystemPrompts = ${defaultSystemPromptsJson};
        
        // Active prompt tracking
        let activePromptId = 'coordinator';
        
        // Update daemon-dependent features based on connection state
        function updateDaemonFeatures() {
            const daemonSections = document.querySelectorAll('[data-requires-daemon]');
            daemonSections.forEach(section => {
                const buttons = section.querySelectorAll('button');
                buttons.forEach(btn => {
                    btn.disabled = !daemonStatus.connected;
                });
                
                // Update explanatory text
                let statusText = section.querySelector('.daemon-status-text');
                if (!statusText) {
                    statusText = document.createElement('p');
                    statusText.className = 'daemon-status-text';
                    statusText.style.cssText = 'opacity: 0.6; font-size: 0.9em; margin-top: 8px;';
                    const buttonRow = section.querySelector('.button-row');
                    if (buttonRow) {
                        section.insertBefore(statusText, buttonRow);
                    }
                }
                
                if (daemonStatus.connected) {
                    statusText.textContent = '✓ Daemon connected';
                    statusText.style.color = 'var(--success-color)';
                } else {
                    statusText.textContent = '⚠ Requires daemon connection. Start daemon to use these features.';
                    statusText.style.color = 'var(--warning-color)';
                }
            });
        }
        
        // Listen for connection state changes from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'daemon-connected') {
                daemonStatus.connected = true;
                updateDaemonFeatures();
            } else if (message.type === 'daemon-disconnected') {
                daemonStatus.connected = false;
                updateDaemonFeatures();
            }
        });
        
        // Initialize UI
        function init() {
            // Set form values
            document.getElementById('enableUnityFeatures').checked = config.enableUnityFeatures ?? defaults.enableUnityFeatures;
            document.getElementById('port').value = config.port ?? defaults.port;
            document.getElementById('logLevel').value = config.logLevel ?? defaults.logLevel;
            document.getElementById('defaultBackend').value = config.defaultBackend ?? defaults.defaultBackend;
            
            // Update badges
            updateBadge('enableUnityFeatures', config.enableUnityFeatures, defaults.enableUnityFeatures);
            updateBadge('port', config.port, defaults.port);
            updateBadge('logLevel', config.logLevel, defaults.logLevel);
            updateBadge('defaultBackend', config.defaultBackend, defaults.defaultBackend);
            
            // Render folders
            renderFolders();
            
            // Initialize system prompts UI (tabs in sidebar)
            renderPromptTabs();
            
            // Show config JSON
            document.getElementById('config-display').textContent = JSON.stringify(config, null, 2);
            
            // Set up tab switching
            document.querySelectorAll('.sidebar-tab').forEach(tab => {
                tab.onclick = () => {
                    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                    tab.classList.add('active');
                    document.getElementById(tab.dataset.tab).classList.add('active');
                };
            });
            
            // Note: Form submit handlers are now set up dynamically in renderPromptContent()
            
            // Initialize daemon-dependent features
            updateDaemonFeatures();
        }
        
        // ========== System Prompts Functions ==========
        
        function getPromptIcon(prompt) {
            const icons = {
                coordinator: '🎯',
                new_plan: '📝',
                revise_plan: '✏️',
                add_task: '➕',
                task_agent: '📋'
            };
            return icons[prompt.id] || '💬';
        }
        
        function renderPromptTabs() {
            const tabsContainer = document.getElementById('prompt-tabs');
            const contentsContainer = document.getElementById('prompt-contents');
            if (!tabsContainer || !contentsContainer) return;
            
            // Generate sidebar tabs for each prompt
            let tabsHtml = '';
            systemPrompts.forEach(prompt => {
                tabsHtml += \`
                    <button class="sidebar-tab" data-tab="prompt-\${prompt.id}">
                        <span class="tab-icon">\${getPromptIcon(prompt)}</span>\${prompt.name}
                    </button>
                \`;
            });
            tabsContainer.innerHTML = tabsHtml;
            
            // Generate tab content for each prompt
            let contentsHtml = '';
            systemPrompts.forEach(prompt => {
                contentsHtml += \`<div id="prompt-\${prompt.id}" class="tab-content">\${renderPromptForm(prompt)}</div>\`;
            });
            contentsContainer.innerHTML = contentsHtml;
            
            // Attach click handlers to new tabs
            tabsContainer.querySelectorAll('.sidebar-tab').forEach(tab => {
                tab.onclick = () => {
                    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                    tab.classList.add('active');
                    const tabId = tab.dataset.tab;
                    document.getElementById(tabId).classList.add('active');
                    activePromptId = tabId.replace('prompt-', '');
                };
            });
        }
        
        function renderPromptForm(prompt) {
            // Check if this is a coordinator-style prompt (two-part) or standard prompt
            const isCoordinatorStyle = prompt.id === 'coordinator' || (prompt.roleIntro !== undefined && prompt.decisionInstructions !== undefined);
            
            let html = \`
                <div class="section">
                    <div class="prompt-form-header">
                        <span style="font-size: 1.5em;">\${getPromptIcon(prompt)}</span>
                        <h2>\${prompt.name}</h2>
                        <span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa;">System</span>
                    </div>
                    <p style="opacity: 0.8; margin: 0 0 8px 0;">\${prompt.description}</p>
                    \${isCoordinatorStyle ? \`
                        <p class="hint" style="margin: 0 0 16px 0;">
                            <strong>Note:</strong> This prompt has two configurable parts (roleIntro and decisionInstructions), 
                            while runtime context is injected dynamically between them.
                        </p>
                    \` : \`
                        <p class="hint" style="margin: 0 0 16px 0;">
                            <strong>Note:</strong> This prompt template is used directly by the agent.
                        </p>
                    \`}
                </div>
                
                <form id="promptForm-\${prompt.id}" onsubmit="savePromptById(event, '\${prompt.id}')">
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Settings</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="promptName-\${prompt.id}">Display Name</label>
                            <input type="text" id="promptName-\${prompt.id}" name="name" value="\${escapeHtml(prompt.name)}" />
                        </div>
                        
                        <div class="form-group">
                            <label for="promptDescription-\${prompt.id}">Description</label>
                            <input type="text" id="promptDescription-\${prompt.id}" name="description" value="\${escapeHtml(prompt.description)}" />
                        </div>
                        
                        <div class="form-group">
                            <label for="promptModel-\${prompt.id}">Model Tier</label>
                            <select id="promptModel-\${prompt.id}" name="defaultModel">
                                <option value="low" \${prompt.defaultModel === 'low' ? 'selected' : ''}>Low (Fast, cheaper - simple tasks)</option>
                                <option value="mid" \${prompt.defaultModel === 'mid' ? 'selected' : ''}>Mid (Balanced - most tasks)</option>
                                <option value="high" \${prompt.defaultModel === 'high' ? 'selected' : ''}>High (Most capable - complex tasks)</option>
                            </select>
                        </div>
                    </div>
            \`;
            
            if (isCoordinatorStyle) {
                // Two-part prompt form (roleIntro + decisionInstructions)
                html += \`
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Role Introduction</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="roleIntro-\${prompt.id}">Introduction Prompt</label>
                            <textarea id="roleIntro-\${prompt.id}" name="roleIntro" style="min-height: 150px;">\${escapeHtml(prompt.roleIntro || '')}</textarea>
                            <div class="hint">This sets the context and identity. It appears at the start of the prompt.</div>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Decision Instructions</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="decisionInstructions-\${prompt.id}">Decision Making Instructions</label>
                            <textarea id="decisionInstructions-\${prompt.id}" name="decisionInstructions" style="min-height: 300px;">\${escapeHtml(prompt.decisionInstructions || '')}</textarea>
                            <div class="hint">These instructions guide decision-making. Runtime context is injected between the introduction and these instructions.</div>
                        </div>
                    </div>
                \`;
            } else {
                // Standard single prompt form
                html += \`
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Prompt Template</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="promptTemplate-\${prompt.id}">System Prompt</label>
                            <textarea id="promptTemplate-\${prompt.id}" name="promptTemplate" style="min-height: 300px;">\${escapeHtml(prompt.promptTemplate || '')}</textarea>
                            <div class="hint">The complete prompt template for this agent.</div>
                        </div>
                    </div>
                \`;
            }
            
            html += \`
                    <div class="section">
                        <div class="button-row">
                            <button type="submit">Save Changes</button>
                            <button type="button" class="secondary" onclick="resetPrompt('\${prompt.id}')">Reset to Default</button>
                        </div>
                    </div>
                </form>
            \`;
            
            return html;
        }
        
        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function savePromptById(event, promptId) {
            event.preventDefault();
            
            const prompt = systemPrompts.find(p => p.id === promptId);
            if (!prompt) return;
            
            const isCoordinatorStyle = prompt.id === 'coordinator' || (prompt.roleIntro !== undefined && prompt.decisionInstructions !== undefined);
            
            const data = {
                id: promptId,
                name: document.getElementById('promptName-' + promptId).value,
                description: document.getElementById('promptDescription-' + promptId).value,
                defaultModel: document.getElementById('promptModel-' + promptId).value
            };
            
            if (isCoordinatorStyle) {
                data.roleIntro = document.getElementById('roleIntro-' + promptId).value;
                data.decisionInstructions = document.getElementById('decisionInstructions-' + promptId).value;
            } else {
                data.promptTemplate = document.getElementById('promptTemplate-' + promptId).value;
            }
            
            // For coordinator, use the existing command for backwards compatibility
            if (promptId === 'coordinator') {
                vscode.postMessage({ command: 'saveCoordinatorPrompt', config: data });
            } else {
                vscode.postMessage({ command: 'saveSystemPrompt', promptId: promptId, config: data });
            }
        }
        
        function resetPrompt(promptId) {
            if (promptId === 'coordinator') {
                vscode.postMessage({ command: 'resetCoordinatorPrompt' });
            } else {
                vscode.postMessage({ command: 'resetSystemPrompt', promptId: promptId });
            }
        }
        
        // Legacy functions for backwards compatibility
        function saveCoordinatorPrompt() {
            savePromptById({ preventDefault: () => {} }, 'coordinator');
        }
        
        function resetCoordinatorPrompt() {
            resetPrompt('coordinator');
        }
        
        function updateBadge(key, value, defaultValue) {
            const badge = document.getElementById(key + '-badge');
            if (badge) {
                const isDefault = value === undefined || value === defaultValue;
                badge.className = isDefault ? 'badge default' : 'badge custom';
                badge.textContent = isDefault ? 'Default' : 'Custom';
            }
        }
        
        function renderFolders() {
            const grid = document.getElementById('folder-grid');
            grid.innerHTML = '';
            
            for (const [key, value] of Object.entries(folders)) {
                // Skip non-customizable folders
                if (key === 'config' || key === 'cache') continue;
                
                const isDefault = value === folderDefaults[key];
                const badgeClass = isDefault ? 'badge default' : 'badge custom';
                const badgeText = isDefault ? 'Default' : 'Custom';
                
                const item = document.createElement('div');
                item.className = 'folder-item';
                item.innerHTML = \`
                    <div class="folder-key">
                        \${key}
                        <span class="\${badgeClass}">\${badgeText}</span>
                    </div>
                    <input 
                        type="text" 
                        value="\${value}"
                        onchange="setFolder('\${key}', this.value)"
                    />
                    \${!isDefault ? \`<button class="secondary" onclick="resetFolder('\${key}')">Reset</button>\` : ''}
                \`;
                grid.appendChild(item);
            }
        }
        
        // Actions
        function setConfig(key, value) {
            vscode.postMessage({ command: 'setConfig', key, value });
        }
        
        function resetConfig(key) {
            vscode.postMessage({ command: 'resetConfig', key });
        }
        
        function setFolder(folder, name) {
            vscode.postMessage({ command: 'setFolder', folder, name });
        }
        
        function resetFolder(folder) {
            vscode.postMessage({ command: 'resetFolder', folder });
        }
        
        function resetAllFolders() {
            vscode.postMessage({ command: 'resetAllFolders' });
        }
        
        function resetAll() {
            vscode.postMessage({ command: 'resetAll' });
        }
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function openConfigFile() {
            vscode.postMessage({ command: 'openConfigFile' });
        }
        
        // MCP package configuration - Only CoplayDev/unity-mcp is supported
        // See: https://github.com/CoplayDev/unity-mcp
        const mcpConfig = {
            name: 'CoplayDev/unity-mcp',
            displayName: 'MCP for Unity',
            // HTTP transport is the default and recommended
            config: {
                url: 'http://localhost:8080/mcp'
            },
            installUrl: 'https://github.com/CoplayDev/unity-mcp',
            unityPackageUrl: 'https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity'
        };
        
        function copyCommand(elementId) {
            const element = document.getElementById(elementId);
            const text = element.textContent;
            navigator.clipboard.writeText(text).then(() => {
                vscode.postMessage({ command: 'showMessage', message: 'Command copied to clipboard!' });
            });
        }
        
        function copyConfig() {
            const configText = document.getElementById('mcp-config-template').textContent;
            navigator.clipboard.writeText(configText).then(() => {
                vscode.postMessage({ command: 'showMessage', message: 'Configuration copied to clipboard!' });
            });
        }
        
        // ========== MCP Installation Steps ==========
        
        // Step 1: Install Cursor Agent CLI
        function installStepCursorAgent() {
            vscode.postMessage({ command: 'installCursorAgent' });
        }
        
        // Step 2: Login Cursor CLI
        function loginStepCursorAuth() {
            vscode.postMessage({ command: 'loginCursorAgent' });
        }
        
        // Step 3: Install MCP Configuration
        function installStepMcpConfig() {
            vscode.postMessage({ command: 'autoConfigureMcp', packageId: 'CoplayDev/unity-mcp' });
        }
        
        // Step 4: Install Unity Package
        function installStepUnityPackage() {
            const detailsEl = document.getElementById('step-unity-package-details');
            if (detailsEl) {
                detailsEl.style.display = detailsEl.style.display === 'none' ? 'block' : 'none';
            }
            vscode.postMessage({ command: 'installMcpToUnity' });
        }
        
        // Step 5: Test Connection
        function testStepConnection() {
            vscode.postMessage({ command: 'testMcpConnection' });
        }
        
        // Legacy functions for backward compatibility
        function openMcpConfig() {
            vscode.postMessage({ command: 'openMcpConfig' });
        }
        
        function refreshAllMcpSteps() {
            vscode.postMessage({ command: 'refreshMcpStatus' });
        }
        
        // Update individual step status
        function updateStepStatus(stepId, status) {
            const iconEl = document.getElementById(stepId + '-icon');
            const badgeEl = document.getElementById(stepId + '-badge');
            const btnEl = document.getElementById(stepId + '-btn');
            const detailsEl = document.getElementById(stepId + '-details');
            const stepEl = document.getElementById(stepId);
            
            if (!iconEl || !badgeEl || !btnEl) return;
            
            // Update icon
            iconEl.textContent = status.icon || '⏳';
            
            // Update badge
            badgeEl.textContent = status.badgeText || 'Unknown';
            badgeEl.className = 'badge ' + (status.badgeClass || 'default');
            if (status.badgeBackground) badgeEl.style.background = status.badgeBackground;
            if (status.badgeColor) badgeEl.style.color = status.badgeColor;
            
            // Update button
            btnEl.textContent = status.buttonText || 'Action';
            btnEl.disabled = status.buttonDisabled || false;
            
            // Update details if provided
            if (detailsEl && status.details) {
                detailsEl.innerHTML = status.details;
                detailsEl.style.display = 'block';
            } else if (detailsEl && !status.details) {
                detailsEl.style.display = 'none';
            }
            
            // Update step appearance based on greyed out and completion status
            if (stepEl) {
                if (status.greyedOut) {
                    // Greyed out state when daemon not connected
                    stepEl.style.borderColor = 'rgba(100, 116, 139, 0.2)';
                    stepEl.style.background = 'rgba(0,0,0,0.1)';
                    stepEl.style.opacity = '0.5';
                } else if (status.completed) {
                    stepEl.style.borderColor = 'rgba(34, 197, 94, 0.4)';
                    stepEl.style.background = 'rgba(34, 197, 94, 0.05)';
                    stepEl.style.opacity = '1';
                } else if (status.error) {
                    stepEl.style.borderColor = 'rgba(239, 68, 68, 0.4)';
                    stepEl.style.background = 'rgba(239, 68, 68, 0.05)';
                    stepEl.style.opacity = '1';
                } else if (status.inProgress) {
                    stepEl.style.borderColor = 'rgba(59, 130, 246, 0.4)';
                    stepEl.style.background = 'rgba(59, 130, 246, 0.05)';
                    stepEl.style.opacity = '1';
                } else {
                    stepEl.style.borderColor = 'rgba(255,255,255,0.1)';
                    stepEl.style.background = 'rgba(0,0,0,0.2)';
                    stepEl.style.opacity = '1';
                }
            }
        }
        
        // Update all MCP steps based on status data
        function updateMcpStatus(status) {
            const daemonConnected = status.daemonConnected !== false;
            
            // Update overall status badge
            const overallBadge = document.getElementById('mcp-overall-status-badge');
            if (overallBadge) {
                if (!daemonConnected) {
                    overallBadge.className = 'badge';
                    overallBadge.textContent = 'Daemon Not Connected';
                    overallBadge.style.background = 'rgba(100, 116, 139, 0.2)';
                    overallBadge.style.color = '#94a3b8';
                } else if (status.connected) {
                    overallBadge.className = 'badge installed';
                    overallBadge.textContent = 'All Steps Complete ✓';
                    overallBadge.style.background = 'rgba(34, 197, 94, 0.2)';
                    overallBadge.style.color = '#4ade80';
                } else if (status.error) {
                    overallBadge.className = 'badge missing';
                    overallBadge.textContent = 'Error';
                    overallBadge.style.background = 'rgba(239, 68, 68, 0.2)';
                    overallBadge.style.color = '#f87171';
                } else {
                    overallBadge.className = 'badge';
                    overallBadge.textContent = 'Setup Required';
                    overallBadge.style.background = 'rgba(234, 179, 8, 0.2)';
                    overallBadge.style.color = '#fbbf24';
                }
            }
            
            // Update config path
            const configPath = document.getElementById('step-mcp-config-path');
            if (configPath) {
                configPath.textContent = status.configPath || '~/.cursor/mcp.json';
            }
            
            // Step 1: Cursor Agent CLI - works without daemon
            const cursorAgentInstalled = status.cursorAgentInstalled || false;
            updateStepStatus('step-cursor-agent', {
                icon: cursorAgentInstalled ? '✅' : '❌',
                badgeText: cursorAgentInstalled ? 'Installed' : 'Not Installed',
                badgeClass: cursorAgentInstalled ? 'installed' : 'missing',
                badgeBackground: cursorAgentInstalled ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                badgeColor: cursorAgentInstalled ? '#4ade80' : '#f87171',
                buttonText: cursorAgentInstalled ? '✓ Installed' : 'Install',
                buttonDisabled: cursorAgentInstalled,
                completed: cursorAgentInstalled,
                details: status.cursorAgentVersion ? 'Version: ' + status.cursorAgentVersion : null,
                greyedOut: false  // Always available
            });
            
            // Update platform hint
            const platformHint = document.getElementById('step-cursor-agent-platform-hint');
            if (platformHint) {
                if (status.platform === 'win32') {
                    platformHint.innerHTML = '<strong>Windows: Requires WSL with Ubuntu</strong>';
                } else {
                    platformHint.textContent = 'Native installation';
                }
            }
            
            // Step 2: Cursor CLI Authentication - works without daemon
            const cursorAuthValid = status.cursorAuthValid || false;
            updateStepStatus('step-cursor-auth', {
                icon: cursorAuthValid ? '✅' : (cursorAgentInstalled ? '⚠️' : '⏳'),
                badgeText: cursorAuthValid ? 'Logged In' : (cursorAgentInstalled ? 'Not Logged In' : 'Waiting'),
                badgeClass: cursorAuthValid ? 'installed' : (cursorAgentInstalled ? 'missing' : 'default'),
                badgeBackground: cursorAuthValid ? 'rgba(34, 197, 94, 0.2)' : (cursorAgentInstalled ? 'rgba(234, 179, 8, 0.2)' : 'rgba(100, 116, 139, 0.2)'),
                badgeColor: cursorAuthValid ? '#4ade80' : (cursorAgentInstalled ? '#fbbf24' : '#94a3b8'),
                buttonText: cursorAuthValid ? '✓ Logged In' : 'Login',
                buttonDisabled: !cursorAgentInstalled || cursorAuthValid,
                completed: cursorAuthValid,
                greyedOut: false  // Always available
            });
            
            // Step 3: MCP Configuration - REQUIRES DAEMON
            const mcpConfigExists = status.installed || false;
            updateStepStatus('step-mcp-config', {
                icon: mcpConfigExists ? '✅' : (cursorAuthValid && daemonConnected ? '⚠️' : '⏳'),
                badgeText: daemonConnected 
                    ? (mcpConfigExists ? 'Configured' : (cursorAuthValid ? 'Not Configured' : 'Waiting'))
                    : 'Daemon Required',
                badgeClass: mcpConfigExists ? 'installed' : (cursorAuthValid && daemonConnected ? 'missing' : 'default'),
                badgeBackground: mcpConfigExists ? 'rgba(34, 197, 94, 0.2)' : (cursorAuthValid && daemonConnected ? 'rgba(234, 179, 8, 0.2)' : 'rgba(100, 116, 139, 0.2)'),
                badgeColor: mcpConfigExists ? '#4ade80' : (cursorAuthValid && daemonConnected ? '#fbbf24' : '#94a3b8'),
                buttonText: mcpConfigExists ? '✓ Configured' : 'Configure',
                buttonDisabled: !daemonConnected || !cursorAuthValid || mcpConfigExists,
                completed: mcpConfigExists,
                details: mcpConfigExists ? 'Config: ' + (status.configPath || 'Unknown') : (!daemonConnected ? 'Start daemon to configure MCP' : null),
                greyedOut: !daemonConnected
            });
            
            // Step 4: Unity Package - works without daemon
            const unityPackageInstalled = status.unityPackageInstalled || false;
            updateStepStatus('step-unity-package', {
                icon: unityPackageInstalled ? '✅' : (mcpConfigExists ? '⚠️' : '⏳'),
                badgeText: unityPackageInstalled ? 'Installed' : (mcpConfigExists ? 'Not Installed' : 'Waiting'),
                badgeClass: unityPackageInstalled ? 'installed' : (mcpConfigExists ? 'missing' : 'default'),
                badgeBackground: unityPackageInstalled ? 'rgba(34, 197, 94, 0.2)' : (mcpConfigExists ? 'rgba(234, 179, 8, 0.2)' : 'rgba(100, 116, 139, 0.2)'),
                badgeColor: unityPackageInstalled ? '#4ade80' : (mcpConfigExists ? '#fbbf24' : '#94a3b8'),
                buttonText: unityPackageInstalled ? '✓ Installed' : 'Install',
                buttonDisabled: !mcpConfigExists || unityPackageInstalled,
                completed: unityPackageInstalled,
                greyedOut: !daemonConnected && !unityPackageInstalled  // Grey if daemon not connected and not yet installed
            });
            
            // Step 5: Test Connection - REQUIRES DAEMON
            const connectionWorking = status.connected || false;
            updateStepStatus('step-test-connection', {
                icon: connectionWorking ? '✅' : (unityPackageInstalled && daemonConnected ? '⚠️' : '⏳'),
                badgeText: daemonConnected
                    ? (connectionWorking ? 'Connected' : (unityPackageInstalled ? 'Not Connected' : 'Waiting'))
                    : 'Daemon Required',
                badgeClass: connectionWorking ? 'installed' : (unityPackageInstalled && daemonConnected ? 'missing' : 'default'),
                badgeBackground: connectionWorking ? 'rgba(34, 197, 94, 0.2)' : (unityPackageInstalled && daemonConnected ? 'rgba(234, 179, 8, 0.2)' : 'rgba(100, 116, 139, 0.2)'),
                badgeColor: connectionWorking ? '#4ade80' : (unityPackageInstalled && daemonConnected ? '#fbbf24' : '#94a3b8'),
                buttonText: connectionWorking ? '✓ Connected' : 'Test',
                buttonDisabled: !daemonConnected || !unityPackageInstalled,
                completed: connectionWorking,
                details: connectionWorking 
                    ? 'Unity MCP is responding correctly' 
                    : (daemonConnected && unityPackageInstalled 
                        ? 'Start HTTP server in Unity: <strong>Window → MCP for Unity → Start Local HTTP Server</strong>' 
                        : (!daemonConnected ? 'Start daemon to test connection' : null)),
                greyedOut: !daemonConnected
            });
        }
        
        // Cursor Agent CLI functions
        function installCursorAgent() {
            vscode.postMessage({ command: 'installCursorAgent' });
        }
        
        function reinstallCursorAgent() {
            vscode.postMessage({ command: 'reinstallCursorAgent' });
        }
        
        function loginCursorAgent() {
            vscode.postMessage({ command: 'loginCursorAgent' });
        }
        
        function refreshCursorAgentStatus() {
            vscode.postMessage({ command: 'refreshCursorAgentStatus' });
        }
        
        function updateCursorAgentStatus(status) {
            const badge = document.getElementById('cursor-agent-status-badge');
            const version = document.getElementById('cursor-agent-version');
            const installBtn = document.getElementById('install-cursor-agent-btn');
            const reinstallBtn = document.getElementById('reinstall-cursor-agent-btn');
            const loginBtn = document.getElementById('login-cursor-agent-btn');
            const platformHint = document.getElementById('cursor-agent-platform-hint');
            
            // Update platform hint
            if (status.platform === 'win32') {
                platformHint.innerHTML = '<strong>Windows: Requires WSL</strong> (Ubuntu in Windows Subsystem for Linux).';
            } else if (status.platform === 'darwin') {
                platformHint.textContent = 'macOS: Native installation.';
            } else {
                platformHint.textContent = 'Linux: Native installation.';
            }
            
            // Update version display
            version.textContent = status.version || 'Not installed';
            
            if (status.installed) {
                // Check if authenticated
                if (status.authenticated === false) {
                    badge.className = 'badge';
                    badge.textContent = 'Not Authenticated';
                    badge.style.background = 'rgba(234, 179, 8, 0.2)';
                    badge.style.color = '#fbbf24';
                    installBtn.style.display = 'none';
                    reinstallBtn.style.display = 'inline-block';
                    loginBtn.style.display = 'inline-block';
                    version.textContent = (status.version || 'Installed') + ' - Login required';
                } else {
                    badge.className = 'badge installed';
                    badge.textContent = 'Installed ✓';
                    badge.style.background = 'rgba(34, 197, 94, 0.2)';
                    badge.style.color = '#4ade80';
                    installBtn.style.display = 'none';
                    reinstallBtn.style.display = 'inline-block';
                    loginBtn.style.display = 'none';
                }
            } else {
                badge.className = 'badge missing';
                badge.textContent = 'Not Installed';
                badge.style.background = 'rgba(239, 68, 68, 0.2)';
                badge.style.color = '#f87171';
                installBtn.style.display = 'inline-block';
                reinstallBtn.style.display = 'none';
                loginBtn.style.display = 'none';
            }
        }
        
        // Cursor CLI functions
        function installCursorCli() {
            vscode.postMessage({ command: 'installCursorCli' });
        }
        
        function checkCursorCliStatus() {
            vscode.postMessage({ command: 'checkCursorCliStatus' });
        }
        
        function updateCursorCliStatus(status) {
            const badge = document.getElementById('cursor-cli-badge');
            const installSection = document.getElementById('cursor-cli-install-section');
            const statusSection = document.getElementById('cursor-cli-status-section');
            const versionSpan = document.getElementById('cursor-cli-version');
            
            if (status.installed) {
                badge.className = 'badge installed';
                badge.textContent = 'Installed ✓';
                badge.style.background = 'rgba(34, 197, 94, 0.2)';
                badge.style.color = '#4ade80';
                installSection.style.display = 'none';
                statusSection.style.display = 'block';
                versionSpan.textContent = status.version || 'cursor';
            } else {
                badge.className = 'badge missing';
                badge.textContent = 'Not Installed';
                badge.style.background = 'rgba(239, 68, 68, 0.2)';
                badge.style.color = '#f87171';
                installSection.style.display = 'block';
                statusSection.style.display = 'none';
            }
        }
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'mcpStatus') {
                updateMcpStatus(message.status);
            } else if (message.type === 'cursorCliStatus') {
                updateCursorCliStatus(message.status);
            } else if (message.type === 'cursorAgentStatus') {
                updateCursorAgentStatus(message.status);
            } else if (message.type === 'daemon-connected') {
                // Refresh MCP status when daemon connects
                refreshMcpStatus();
            } else if (message.type === 'daemon-disconnected') {
                // Update UI to show daemon disconnected state
                updateMcpStatus({ daemonConnected: false });
            }
        });
        
        // Initialize
        init();
        
        // Request MCP status on load
        refreshMcpStatus();
        
        // Request Cursor CLI status on load
        checkCursorCliStatus();
        
        // Request cursor-agent status on load
        refreshCursorAgentStatus();
    </script>
</body>
</html>`;
    }

    /**
     * Get the Unity MCP URL that works across Windows/WSL networking
     * 
     * On Windows + WSL: Unity runs on Windows, cursor-agent runs in WSL
     * - Must use Windows host IP instead of localhost
     */
    private getUnityMcpUrl(): string {
        const DEFAULT_PORT = '8080';  // Unity MCP default port (confirmed from Unity settings)
        
        if (process.platform === 'win32') {
            // On Windows, cursor-agent runs in WSL
            // We'll use a placeholder that the user or system will resolve
            // at runtime. For now, return the localhost URL with correct port
            // and add a note about WSL networking
            return `http://localhost:${DEFAULT_PORT}`;
        } else {
            // macOS/Linux: direct localhost works
            return `http://localhost:${DEFAULT_PORT}`;
        }
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        SystemSettingsPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}

