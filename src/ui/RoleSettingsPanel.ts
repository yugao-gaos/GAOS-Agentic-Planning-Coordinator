import * as vscode from 'vscode';
import { AgentRoleRegistry } from '../services/AgentRoleRegistry';
import { AgentRole, DefaultRoleConfigs } from '../types';
import { VsCodeClient } from '../vscode/VsCodeClient';
import { Logger } from '../utils/Logger';
import { getSettingsCommonStyles } from './webview/styles/settingsCommon';

const log = Logger.create('Client', 'RoleSettings');

/**
 * Webview panel for configuring agent roles.
 * Provides a tabbed interface for:
 * - Agent Roles: Built-in (engineer, reviewer, context) + custom roles
 * 
 * Note: System prompts (coordinator, unity_polling) are managed in SystemSettingsPanel.
 * 
 * Uses VsCodeClient to communicate with daemon for role management.
 */
export class RoleSettingsPanel {
    public static currentPanel: RoleSettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly registry: AgentRoleRegistry | null;
    private readonly vsCodeClient: VsCodeClient | null;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private cachedRoles: any[] = [];
    private cachedConfig: { agentPoolSize?: number; autoOpenTerminals?: boolean } = {};

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        registry?: AgentRoleRegistry,
        vsCodeClient?: VsCodeClient
    ) {
        this.panel = panel;
        this.registry = registry || null;
        this.vsCodeClient = vsCodeClient || null;
        this.extensionUri = extensionUri;

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

        // Listen for role changes (only in local registry mode)
        if (this.registry) {
            this.registry.onRolesChanged(() => {
                this.updateWebviewContent();
            });
        }
        
        // Set initial content
        this.updateWebviewContent();
    }

    /**
     * Show the role settings panel using VsCodeClient (daemon mode)
     */
    public static showWithClient(client: VsCodeClient, extensionUri: vscode.Uri): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists, reveal it
        if (RoleSettingsPanel.currentPanel) {
            RoleSettingsPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'apcRoleSettings',
            'Agent Role Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        RoleSettingsPanel.currentPanel = new RoleSettingsPanel(panel, extensionUri, undefined, client);
    }

    /**
     * Show the role settings panel using local AgentRoleRegistry (offline mode)
     */
    public static showWithRegistry(registry: AgentRoleRegistry | undefined, extensionUri: vscode.Uri): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists, reveal it
        if (RoleSettingsPanel.currentPanel) {
            RoleSettingsPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'apcRoleSettings',
            'Agent Role Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        RoleSettingsPanel.currentPanel = new RoleSettingsPanel(panel, extensionUri, registry, undefined);
    }


    /**
     * Handle messages from the webview
     */
    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'save':
                await this.saveRole(message.role);
                break;
            case 'reset':
                await this.resetRole(message.roleId);
                break;
            case 'delete':
                await this.deleteRole(message.roleId);
                break;
            case 'create':
                await this.createRole(message.role);
                break;
            case 'exportConfig':
                await this.exportConfig();
                break;
            case 'importConfig':
                await this.importConfig();
                break;
            case 'resetAll':
                await this.resetAllSettings();
                break;
            case 'refresh':
                this.updateWebviewContent();
                break;
            case 'setPoolConfig':
                await this.setPoolConfig(message.key, message.value);
                break;
        }
    }
    
    /**
     * Set pool configuration value
     */
    private async setPoolConfig(key: string, value: unknown): Promise<void> {
        try {
            if (this.vsCodeClient) {
                // Convert value to proper type
                let typedValue: unknown = value;
                if (key === 'agentPoolSize') {
                    typedValue = parseInt(value as string, 10);
                } else if (key === 'autoOpenTerminals') {
                    typedValue = value === 'true' || value === true;
                }
                
                const result = await this.vsCodeClient.setConfig(key, typedValue);
                if (result.success) {
                    vscode.window.showInformationMessage(`Setting "${key}" updated`);
                    this.updateWebviewContent();
                } else {
                    vscode.window.showErrorMessage(`Failed to update: ${result.error}`);
                }
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Error updating setting: ${err.message}`);
        }
    }

    /**
     * Save role changes
     */
    private async saveRole(roleData: any): Promise<void> {
        try {
            if (this.vsCodeClient) {
                // Daemon mode: update via API
                const result = await this.vsCodeClient.updateRole(roleData.id, roleData);
                if (result.success) {
                    vscode.window.showInformationMessage(`Role "${roleData.name}" saved successfully`);
                    this.updateWebviewContent();
                } else {
                    vscode.window.showErrorMessage(`Failed to save role: ${result.error}`);
                }
            } else if (this.registry) {
                // Local registry mode
                const errors = this.registry.validateRole(roleData);
                if (errors.length > 0) {
                    vscode.window.showErrorMessage(`Invalid role: ${errors.join(', ')}`);
                    return;
                }

                const role = AgentRole.fromJSON(roleData);
                this.registry.updateRole(role);
                vscode.window.showInformationMessage(`Role "${role.name}" saved successfully`);
                this.updateWebviewContent();
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to save role: ${e.message}`);
        }
    }

    /**
     * Reset a built-in role to defaults
     */
    private async resetRole(roleId: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Reset "${roleId}" role to default settings? Your customizations will be lost.`,
            { modal: true },
            'Reset'
        );

        if (confirm === 'Reset') {
            if (this.vsCodeClient) {
                // Daemon mode
                const result = await this.vsCodeClient.resetRole(roleId);
                if (result.success) {
                    vscode.window.showInformationMessage(`Role reset to defaults`);
                    this.updateWebviewContent();
                } else {
                    vscode.window.showErrorMessage(`Failed to reset: ${result.error}`);
                }
            } else if (this.registry) {
                // Local registry mode
                const role = this.registry.resetToDefault(roleId);
                if (role) {
                    vscode.window.showInformationMessage(`Role "${role.name}" reset to defaults`);
                    this.updateWebviewContent();
                }
            }
        }
    }

    /**
     * Delete a custom role
     */
    private async deleteRole(roleId: string): Promise<void> {
        const role = this.registry?.getRole(roleId) || this.cachedRoles.find(r => r.id === roleId);
        if (!role) return;

        const confirm = await vscode.window.showWarningMessage(
            `Delete custom role "${role.name}"? This cannot be undone.`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            if (this.vsCodeClient) {
                // Daemon mode - use API to delete
                try {
                    await this.vsCodeClient.send('roles.delete', { roleId });
                    vscode.window.showInformationMessage(`Role "${role.name}" deleted`);
                    this.updateWebviewContent();
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to delete: ${err}`);
                }
            } else if (this.registry) {
                // Local registry mode
                if (this.registry.deleteCustomRole(roleId)) {
                    vscode.window.showInformationMessage(`Role "${role.name}" deleted`);
                    this.updateWebviewContent();
                }
            }
        }
    }

    /**
     * Create a new custom role
     */
    private async createRole(roleData: any): Promise<void> {
        try {
            if (this.vsCodeClient) {
                // Daemon mode: create via API
                await this.vsCodeClient.send('roles.create', { role: roleData });
                vscode.window.showInformationMessage(`Role "${roleData.name}" created successfully`);
                this.updateWebviewContent();
            } else if (this.registry) {
                // Local registry mode
                const errors = this.registry.validateRole(roleData);
                if (errors.length > 0) {
                    vscode.window.showErrorMessage(`Invalid role: ${errors.join(', ')}`);
                    return;
                }

                const role = this.registry.createCustomRole(roleData);
                vscode.window.showInformationMessage(`Role "${role.name}" created successfully`);
                this.updateWebviewContent();
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to create role: ${e.message}`);
        }
    }

    /**
     * Export all config to clipboard
     */
    private async exportConfig(): Promise<void> {
        try {
            const exportData = {
                roles: this.cachedRoles.filter(r => !r.isBuiltIn) // Only custom roles
            };
            await vscode.env.clipboard.writeText(JSON.stringify(exportData, null, 2));
            vscode.window.showInformationMessage('Agent role settings copied to clipboard');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to export: ${e.message}`);
        }
    }

    /**
     * Import config from clipboard
     */
    private async importConfig(): Promise<void> {
        const clipboardText = await vscode.env.clipboard.readText();
        
        try {
            const importData = JSON.parse(clipboardText);
            
            const confirm = await vscode.window.showWarningMessage(
                'Import agent role settings from clipboard? This will merge with your current settings.',
                { modal: true },
                'Import'
            );

            if (confirm === 'Import') {
                // Import custom roles
                if (importData.roles && Array.isArray(importData.roles)) {
                    for (const role of importData.roles) {
                        if (!role.isBuiltIn) {
                            if (this.vsCodeClient) {
                                await this.vsCodeClient.send('roles.create', { role });
                            } else if (this.registry) {
                                this.registry.createCustomRole(role);
                            }
                        }
                    }
                }
                
                vscode.window.showInformationMessage('Agent role settings imported successfully');
                this.updateWebviewContent();
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Invalid config JSON: ${e.message}`);
        }
    }

    /**
     * Reset all settings to defaults
     */
    private async resetAllSettings(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Reset all agent settings to defaults? Custom roles will be deleted and all prompts will be reset.',
            { modal: true },
            'Reset All'
        );

        if (confirm === 'Reset All') {
            try {
                if (this.vsCodeClient) {
                    // Daemon mode - reset via API
                    await this.vsCodeClient.send('roles.resetAll', {});
                } else if (this.registry) {
                    // Local registry mode - reset all
                    this.registry.resetAllToDefaults();
                }
                
                vscode.window.showInformationMessage('All agent settings reset to defaults');
                this.updateWebviewContent();
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to reset: ${e.message}`);
            }
        }
    }

    /**
     * Update the webview content
     */
    private async updateWebviewContent(): Promise<void> {
        if (this.vsCodeClient) {
            // Fetch from daemon
            try {
                const response = await this.vsCodeClient.send<{ roles: any[] }>('roles.getAll', {});
                this.cachedRoles = response.roles || [];
                
                // Also fetch config for pool settings
                try {
                    const config = await this.vsCodeClient.getConfig();
                    this.cachedConfig = {
                        agentPoolSize: (config as any).agentPoolSize,
                        autoOpenTerminals: (config as any).autoOpenTerminals
                    };
                } catch {
                    this.cachedConfig = { agentPoolSize: 10, autoOpenTerminals: true };
                }
            } catch (err) {
                log.error('Failed to fetch roles from daemon:', err);
                // Don't mask errors with fallback - let UI show the error
                this.cachedRoles = [];
                this.cachedConfig = { agentPoolSize: 10, autoOpenTerminals: true };
            }
        }
        this.panel.webview.html = this.getWebviewContent();
    }

    /**
     * Generate the webview HTML content
     */
    private getWebviewContent(): string {
        // Detect daemon connection status
        let isDaemonConnected = false;
        if (this.vsCodeClient) {
            isDaemonConnected = this.vsCodeClient.isConnected();
        }
        
        // Get data from either daemon cache or local registry
        let roles: any[];
        let roleIds: string[];
        
        if (this.vsCodeClient) {
            // Daemon mode: use cached data - no fallback, show error if empty
            roles = this.cachedRoles;
            roleIds = roles.map(r => r.id).sort((a, b) => {
                const aBuiltIn = roles.find(r => r.id === a)?.isBuiltIn;
                const bBuiltIn = roles.find(r => r.id === b)?.isBuiltIn;
                if (aBuiltIn && !bBuiltIn) return -1;
                if (!aBuiltIn && bBuiltIn) return 1;
                return a.localeCompare(b);
            });
        } else if (this.registry) {
            // Local registry mode
            roles = this.registry.getAllRoles().map(r => r.toJSON());
            roleIds = this.registry.getRoleIdsSorted();
        } else {
            // No registry or daemon - use default role definitions for initial display
            // This is acceptable as it's just the initial UI state, not runtime data
            roles = Object.values(DefaultRoleConfigs).map(c => ({ ...c, isBuiltIn: true }));
            roleIds = Object.keys(DefaultRoleConfigs);
        }

        // Build sidebar tabs data
        const roleTabsData = roleIds.map(id => {
            const role = roles.find(r => r.id === id);
            if (!role) return null;
            return { type: 'role', id: role.id, name: role.name, isBuiltIn: role.isBuiltIn };
        }).filter(Boolean);

        // Generate data as JSON for JavaScript
        const rolesJson = JSON.stringify(roles.map(r => typeof r.toJSON === 'function' ? r.toJSON() : r));
        const defaultsJson = JSON.stringify(
            Object.fromEntries(
                Object.entries(DefaultRoleConfigs).map(([id, config]) => [id, config])
            )
        );
        const roleTabsDataJson = JSON.stringify(roleTabsData);
        const poolConfigJson = JSON.stringify(this.cachedConfig);
        const poolDefaultsJson = JSON.stringify({ agentPoolSize: 10, autoOpenTerminals: true });
        
        // Generate daemon status banner
        const daemonStatusBanner = isDaemonConnected 
            ? `<div class="info-banner success">
                    <div class="banner-icon">✓</div>
                    <div class="banner-content">
                        <div class="banner-title">Daemon Connected</div>
                        <div class="banner-text">Changes will be applied immediately</div>
                    </div>
                </div>`
            : `<div class="info-banner warning">
                    <div class="banner-icon">⚠</div>
                    <div class="banner-content">
                        <div class="banner-title">Daemon Not Connected</div>
                        <div class="banner-text">You can still edit settings. Changes will be loaded when daemon starts.</div>
                    </div>
                </div>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Agent Settings</title>
    <style>
${getSettingsCommonStyles()}
        
        /* Panel-specific styles */
        .sidebar-section {
            margin-bottom: 20px;
        }
        
        .sidebar-section-label {
            font-size: 0.75em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.6;
            margin-bottom: 8px;
            padding-left: 4px;
        }
        
        .role-id-display {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            opacity: 0.6;
            margin-top: 4px;
        }
        
        .subsection {
            margin-top: 20px;
            padding-top: 16px;
            border-top: 1px solid var(--border-color);
        }
        
        /* Daemon Status Banner */
        .info-banner {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            margin-bottom: 16px;
            border-radius: 6px;
            border: 1px solid;
        }
        
        .info-banner.success {
            background: rgba(34, 197, 94, 0.1);
            border-color: rgba(34, 197, 94, 0.3);
        }
        
        .info-banner.warning {
            background: rgba(251, 191, 36, 0.1);
            border-color: rgba(251, 191, 36, 0.3);
        }
        
        .banner-icon {
            font-size: 20px;
            flex-shrink: 0;
        }
        
        .banner-content {
            flex: 1;
        }
        
        .banner-title {
            font-weight: 600;
            margin-bottom: 4px;
        }
        
        .banner-text {
            font-size: 0.9em;
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <div class="header-row">
        <h1>🤖 Agent Role Settings</h1>
        <div class="header-actions">
            <button class="secondary" onclick="exportConfig()">Export</button>
            <button class="secondary" onclick="importConfig()">Import</button>
            <button class="danger" onclick="resetAll()">Reset All</button>
        </div>
    </div>
    
    ${daemonStatusBanner}
    
    <div class="layout">
        <div class="sidebar">
            <div class="sidebar-section">
                <div class="sidebar-section-label">Agent Pool</div>
                <div class="sidebar-tabs" id="pool-tabs">
                    <button class="sidebar-tab" data-type="pool" data-id="settings">
                        <div class="tab-name">🎛️ Pool Settings</div>
                    </button>
                </div>
            </div>
            <div class="sidebar-section">
                <div class="sidebar-section-label">Agent Roles</div>
                <div class="sidebar-tabs" id="role-tabs"></div>
            </div>
        </div>
        
        <div class="main-content" id="main-content"></div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        // Data
        const roles = ${rolesJson};
        const defaults = ${defaultsJson};
        const roleTabsData = ${roleTabsDataJson};
        const poolConfig = ${poolConfigJson};
        const poolDefaults = ${poolDefaultsJson};
        
        // Track active selection - start with pool settings
        let activeType = 'pool';
        let activeId = 'settings';
        
        function getRoleById(id) {
            return roles.find(r => r.id === id);
        }
        
        // Render sidebar tabs
        function renderSidebarTabs() {
            // Pool tabs
            const poolContainer = document.getElementById('pool-tabs');
            poolContainer.innerHTML = \`
                <button class="sidebar-tab \${activeType === 'pool' && activeId === 'settings' ? 'active' : ''}" 
                        data-type="pool" data-id="settings">
                    <div class="tab-name">🎛️ Pool Settings</div>
                </button>
            \`;
            
            // Role tabs
            const roleContainer = document.getElementById('role-tabs');
            roleContainer.innerHTML = roleTabsData.map(tab => \`
                <button class="sidebar-tab \${activeType === 'role' && activeId === tab.id ? 'active' : ''}" 
                        data-type="role" data-id="\${tab.id}">
                    <div class="tab-name">\${tab.isBuiltIn ? '🔧' : '✨'} \${tab.name}</div>
                    <div class="tab-type">\${tab.id}</div>
                </button>
            \`).join('') + \`
                <button class="sidebar-tab tab-add \${activeType === 'role' && activeId === '__new__' ? 'active' : ''}" 
                        data-type="role" data-id="__new__">
                    <div class="tab-name">+ Add Custom Role</div>
                </button>
            \`;
            
            // Attach click handlers
            document.querySelectorAll('.sidebar-tab').forEach(tab => {
                tab.onclick = () => {
                    activeType = tab.dataset.type;
                    activeId = tab.dataset.id;
                    renderSidebarTabs();
                    renderContent();
                };
            });
        }
        
        // Render main content
        function renderContent() {
            const container = document.getElementById('main-content');
            
            if (activeType === 'pool') {
                container.innerHTML = renderPoolSettingsForm();
            } else if (activeType === 'role') {
                if (activeId === '__new__') {
                    container.innerHTML = renderNewRoleForm();
                } else {
                    const role = getRoleById(activeId);
                    if (role) {
                        container.innerHTML = renderRoleForm(role);
                    }
                }
            }
            
            attachFormListeners();
        }
        
        function renderPoolSettingsForm() {
            const isPoolSizeDefault = poolConfig.agentPoolSize === undefined || poolConfig.agentPoolSize === poolDefaults.agentPoolSize;
            const isAutoOpenDefault = poolConfig.autoOpenTerminals === undefined || poolConfig.autoOpenTerminals === poolDefaults.autoOpenTerminals;
            
            return \`
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">
                            Agent Pool Settings
                            <span class="badge system">System</span>
                        </div>
                    </div>
                    <p style="opacity: 0.8; margin: 0;">Configure the agent pool size and terminal behavior.</p>
                </div>
                
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">Pool Size</div>
                    </div>
                    
                    <div class="form-group">
                        <label>
                            Number of Agents
                            <span class="badge \${isPoolSizeDefault ? 'builtin' : 'custom'}">\${isPoolSizeDefault ? 'Default' : 'Custom'}</span>
                        </label>
                        <input 
                            type="number" 
                            id="agentPoolSize" 
                            min="1" 
                            max="20"
                            value="\${poolConfig.agentPoolSize ?? poolDefaults.agentPoolSize}"
                            onchange="setPoolConfig('agentPoolSize', this.value)"
                        />
                        <div class="hint">Number of agents in the pool (1-20). More agents = more parallel tasks.</div>
                    </div>
                </div>
                
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">User Interface</div>
                    </div>
                    
                    <div class="form-group">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <input 
                                type="checkbox" 
                                id="autoOpenTerminals"
                                \${(poolConfig.autoOpenTerminals ?? poolDefaults.autoOpenTerminals) ? 'checked' : ''}
                                onchange="setPoolConfig('autoOpenTerminals', this.checked)"
                                style="width: auto;"
                            />
                            <label for="autoOpenTerminals" style="margin-bottom: 0;">
                                Auto-open agent terminals
                                <span class="badge \${isAutoOpenDefault ? 'builtin' : 'custom'}">\${isAutoOpenDefault ? 'Default' : 'Custom'}</span>
                            </label>
                        </div>
                        <div class="hint">Automatically open a terminal window for each agent when it starts working.</div>
                    </div>
                </div>
            \`;
        }
        
        function renderRoleForm(role) {
            const isBuiltIn = role.isBuiltIn;
            const hasDefault = defaults[role.id];
            
            return \`
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">
                            \${role.name}
                            \${isBuiltIn ? '<span class="badge builtin">Built-in</span>' : '<span class="badge custom">Custom</span>'}
                        </div>
                    </div>
                    <p style="opacity: 0.8; margin: 0;">\${role.description || 'No description provided'}</p>
                    <div class="role-id-display">ID: \${role.id}</div>
                </div>
                
                <form id="roleForm">
                    <input type="hidden" name="id" value="\${role.id}">
                    <input type="hidden" name="isBuiltIn" value="\${role.isBuiltIn}">
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Basic Settings</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="name">Name</label>
                            <input type="text" id="name" name="name" value="\${escapeHtml(role.name)}" \${isBuiltIn ? 'readonly' : ''}>
                        </div>
                        
                        <div class="form-group">
                            <label for="description">Description</label>
                            <input type="text" id="description" name="description" value="\${escapeHtml(role.description)}">
                        </div>
                        
                        <div class="form-group">
                            <label for="defaultModel">Default Model</label>
                            <select id="defaultModel" name="defaultModel">
                                <option value="sonnet-4.5" \${role.defaultModel === 'sonnet-4.5' ? 'selected' : ''}>Claude Sonnet 4.5</option>
                                <option value="opus-4.5" \${role.defaultModel === 'opus-4.5' ? 'selected' : ''}>Claude Opus 4.5</option>
                                <option value="gemini-3-pro" \${role.defaultModel === 'gemini-3-pro' ? 'selected' : ''}>Gemini 3 Pro</option>
                                <option value="gpt-5.1-codex-high" \${role.defaultModel === 'gpt-5.1-codex-high' ? 'selected' : ''}>GPT-5.1 Codex High</option>
                            </select>
                        </div>
                        
                        <div class="form-group">
                            <label for="timeoutMs">Timeout (ms)</label>
                            <input type="number" id="timeoutMs" name="timeoutMs" value="\${role.timeoutMs}" min="60000" step="60000">
                            <div class="hint">Current: \${Math.round(role.timeoutMs / 60000)} minutes</div>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Permissions</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="allowedMcpTools">Allowed MCP Tools</label>
                            <textarea id="allowedMcpTools" name="allowedMcpTools" placeholder="One tool per line, or leave empty for all tools">\${role.allowedMcpTools ? role.allowedMcpTools.join('\\n') : ''}</textarea>
                            <div class="hint">Leave empty to allow all MCP tools</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="allowedCliCommands">Allowed CLI Commands</label>
                            <textarea id="allowedCliCommands" name="allowedCliCommands" placeholder="One command per line, or leave empty for all commands">\${role.allowedCliCommands ? role.allowedCliCommands.join('\\n') : ''}</textarea>
                            <div class="hint">Leave empty to allow all CLI commands</div>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Context</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="rules">Rules</label>
                            <textarea id="rules" name="rules" placeholder="One rule per line">\${role.rules.join('\\n')}</textarea>
                            <div class="hint">Rules and best practices to include in agent prompts</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="documents">Documents</label>
                            <textarea id="documents" name="documents" placeholder="One document path per line">\${role.documents.join('\\n')}</textarea>
                            <div class="hint">Document paths to include as context</div>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Prompt Template</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="promptTemplate">System Prompt</label>
                            <textarea id="promptTemplate" name="promptTemplate" class="prompt-large" placeholder="Optional custom prompt template">\${escapeHtml(role.promptTemplate)}</textarea>
                            <div class="hint">Leave empty to use the default prompt for this role</div>
                        </div>
                        
                        <div class="button-row">
                            <button type="submit">Save Changes</button>
                            \${isBuiltIn && hasDefault ? '<button type="button" class="secondary" onclick="resetRole()">Reset to Default</button>' : ''}
                            \${!isBuiltIn ? '<button type="button" class="danger" onclick="deleteRole()">Delete Role</button>' : ''}
                        </div>
                    </div>
                </form>
            \`;
        }
        
        function renderNewRoleForm() {
            return \`
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">Create New Role</div>
                    </div>
                    <p style="opacity: 0.8; margin: 0;">Define a custom agent role with specific settings and permissions.</p>
                </div>
                
                <form id="roleForm">
                    <input type="hidden" name="isBuiltIn" value="false">
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Basic Settings</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="id">Role ID</label>
                            <input type="text" id="id" name="id" placeholder="e.g., security-reviewer" pattern="[a-z0-9_-]+" required>
                            <div class="hint">Lowercase letters, numbers, hyphens, and underscores only</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="name">Name</label>
                            <input type="text" id="name" name="name" placeholder="e.g., Security Reviewer" required>
                        </div>
                        
                        <div class="form-group">
                            <label for="description">Description</label>
                            <input type="text" id="description" name="description" placeholder="What this role does">
                        </div>
                        
                        <div class="form-group">
                            <label for="defaultModel">Default Model</label>
                            <select id="defaultModel" name="defaultModel">
                                <option value="sonnet-4.5">Claude Sonnet 4.5</option>
                                <option value="opus-4.5">Claude Opus 4.5</option>
                                <option value="gemini-3-pro">Gemini 3 Pro</option>
                                <option value="gpt-5.1-codex-high">GPT-5.1 Codex High</option>
                            </select>
                        </div>
                        
                        <div class="form-group">
                            <label for="timeoutMs">Timeout (ms)</label>
                            <input type="number" id="timeoutMs" name="timeoutMs" value="3600000" min="60000" step="60000">
                            <div class="hint">Default: 60 minutes (3600000ms)</div>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Permissions</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="allowedMcpTools">Allowed MCP Tools</label>
                            <textarea id="allowedMcpTools" name="allowedMcpTools" placeholder="One tool per line, or leave empty for all tools"></textarea>
                            <div class="hint">Leave empty to allow all MCP tools</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="allowedCliCommands">Allowed CLI Commands</label>
                            <textarea id="allowedCliCommands" name="allowedCliCommands" placeholder="One command per line"></textarea>
                            <div class="hint">Leave empty to allow all CLI commands</div>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Context</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="rules">Rules</label>
                            <textarea id="rules" name="rules" placeholder="One rule per line"></textarea>
                        </div>
                        
                        <div class="form-group">
                            <label for="documents">Documents</label>
                            <textarea id="documents" name="documents" placeholder="One document path per line"></textarea>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Prompt Template</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="promptTemplate">System Prompt</label>
                            <textarea id="promptTemplate" name="promptTemplate" class="prompt-large" placeholder="Optional custom prompt template"></textarea>
                        </div>
                        
                        <div class="button-row">
                            <button type="submit">Create Role</button>
                        </div>
                    </div>
                </form>
            \`;
        }
        
        // Utility functions
        function escapeHtml(str) {
            if (!str) return '';
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
        
        function parseArrayField(value) {
            if (!value || value.trim() === '') return null;
            return value.split('\\n').map(s => s.trim()).filter(s => s);
        }
        
        function attachFormListeners() {
            const roleForm = document.getElementById('roleForm');
            if (roleForm) {
                roleForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    saveRole();
                });
            }
        }
        
        function getRoleFormData() {
            const form = document.getElementById('roleForm');
            const formData = new FormData(form);
            
            return {
                id: formData.get('id'),
                name: formData.get('name'),
                description: formData.get('description') || '',
                isBuiltIn: formData.get('isBuiltIn') === 'true',
                defaultModel: formData.get('defaultModel'),
                timeoutMs: parseInt(formData.get('timeoutMs'), 10) || 3600000,
                promptTemplate: formData.get('promptTemplate') || '',
                allowedMcpTools: parseArrayField(formData.get('allowedMcpTools')),
                allowedCliCommands: parseArrayField(formData.get('allowedCliCommands')),
                rules: parseArrayField(formData.get('rules')) || [],
                documents: parseArrayField(formData.get('documents')) || []
            };
        }
        
        // Actions
        function saveRole() {
            const data = getRoleFormData();
            if (activeId === '__new__') {
                vscode.postMessage({ command: 'create', role: data });
            } else {
                vscode.postMessage({ command: 'save', role: data });
            }
        }
        
        function setPoolConfig(key, value) {
            vscode.postMessage({ command: 'setPoolConfig', key, value });
        }
        
        function resetRole() {
            vscode.postMessage({ command: 'reset', roleId: activeId });
        }
        
        function deleteRole() {
            vscode.postMessage({ command: 'delete', roleId: activeId });
        }
        
        function exportConfig() {
            vscode.postMessage({ command: 'exportConfig' });
        }
        
        function importConfig() {
            vscode.postMessage({ command: 'importConfig' });
        }
        
        function resetAll() {
            vscode.postMessage({ command: 'resetAll' });
        }
        
        // Initial render
        renderSidebarTabs();
        renderContent();
    </script>
</body>
</html>`;
    }

    /**
     * Dispose the panel
     */
    public dispose(): void {
        RoleSettingsPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}

