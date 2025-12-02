import * as vscode from 'vscode';
import { AgentRoleRegistry } from '../services/AgentRoleRegistry';
import { AgentRole, DefaultRoleConfigs, SystemPromptConfig, DefaultSystemPrompts, CoordinatorPromptConfig, DefaultCoordinatorPrompt } from '../types';
import { VsCodeClient } from '../vscode/VsCodeClient';

/**
 * Webview panel for configuring agent roles and system prompts.
 * Provides a tabbed interface with:
 * - Agent Roles: Built-in (engineer, reviewer, context) + custom roles
 * - System Prompts: Coordinator, Context Gatherer, Planning Analyst, etc.
 * 
 * Supports two modes:
 * - Legacy: Uses local AgentRoleRegistry (for backwards compatibility)
 * - Client: Uses VsCodeClient to communicate with daemon (preferred)
 */
export class RoleSettingsPanel {
    public static currentPanel: RoleSettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly registry: AgentRoleRegistry | null;
    private readonly vsCodeClient: VsCodeClient | null;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private cachedRoles: any[] = [];
    private cachedSystemPrompts: any[] = [];
    private cachedCoordinatorPrompt: any = null;

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
     * Show the role settings panel using local registry (legacy mode)
     */
    public static show(registry: AgentRoleRegistry, extensionUri: vscode.Uri): void {
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

        RoleSettingsPanel.currentPanel = new RoleSettingsPanel(panel, extensionUri, registry);
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
            case 'saveSystemPrompt':
                await this.saveSystemPrompt(message.prompt);
                break;
            case 'resetSystemPrompt':
                await this.resetSystemPrompt(message.promptId);
                break;
            case 'saveCoordinatorPrompt':
                await this.saveCoordinatorPrompt(message.config);
                break;
            case 'resetCoordinatorPrompt':
                await this.resetCoordinatorPrompt();
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
     * Save system prompt changes
     */
    private async saveSystemPrompt(promptData: any): Promise<void> {
        try {
            if (this.vsCodeClient) {
                // Daemon mode
                await this.vsCodeClient.send('prompts.update', { prompt: promptData });
                vscode.window.showInformationMessage(`System prompt "${promptData.name}" saved successfully`);
                this.updateWebviewContent();
            } else if (this.registry) {
                // Local registry mode
                const config = SystemPromptConfig.fromJSON(promptData);
                this.registry.updateSystemPrompt(config);
                vscode.window.showInformationMessage(`System prompt "${config.name}" saved successfully`);
                this.updateWebviewContent();
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to save system prompt: ${e.message}`);
        }
    }

    /**
     * Reset a system prompt to defaults
     */
    private async resetSystemPrompt(promptId: string): Promise<void> {
        const config = this.registry?.getSystemPrompt(promptId) || this.cachedSystemPrompts.find(p => p.id === promptId);
        if (!config) return;

        const confirm = await vscode.window.showWarningMessage(
            `Reset "${config.name}" to default prompt? Your customizations will be lost.`,
            { modal: true },
            'Reset'
        );

        if (confirm === 'Reset') {
            if (this.vsCodeClient) {
                // Daemon mode
                await this.vsCodeClient.send('prompts.reset', { promptId });
                vscode.window.showInformationMessage(`System prompt reset to defaults`);
                this.updateWebviewContent();
            } else if (this.registry) {
                // Local registry mode
                const resetConfig = this.registry.resetSystemPromptToDefault(promptId);
                if (resetConfig) {
                    vscode.window.showInformationMessage(`System prompt "${resetConfig.name}" reset to defaults`);
                    this.updateWebviewContent();
                }
            }
        }
    }

    /**
     * Save coordinator prompt changes
     */
    private async saveCoordinatorPrompt(configData: any): Promise<void> {
        try {
            if (this.vsCodeClient) {
                // Daemon mode
                await this.vsCodeClient.send('prompts.updateCoordinator', { config: configData });
                vscode.window.showInformationMessage('Coordinator prompt saved successfully');
                this.updateWebviewContent();
            } else if (this.registry) {
                // Local registry mode
                this.registry.updateCoordinatorPrompt(configData);
                vscode.window.showInformationMessage('Coordinator prompt saved successfully');
                this.updateWebviewContent();
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to save coordinator prompt: ${e.message}`);
        }
    }

    /**
     * Reset coordinator prompt to defaults
     */
    private async resetCoordinatorPrompt(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Reset Coordinator prompt to defaults? Your customizations will be lost.',
            { modal: true },
            'Reset'
        );

        if (confirm === 'Reset') {
            if (this.vsCodeClient) {
                // Daemon mode
                await this.vsCodeClient.send('prompts.resetCoordinator', {});
                vscode.window.showInformationMessage('Coordinator prompt reset to defaults');
                this.updateWebviewContent();
            } else if (this.registry) {
                // Local registry mode
                this.registry.resetCoordinatorPromptToDefault();
                vscode.window.showInformationMessage('Coordinator prompt reset to defaults');
                this.updateWebviewContent();
            }
        }
    }

    /**
     * Export all config to clipboard
     */
    private async exportConfig(): Promise<void> {
        try {
            const exportData = {
                roles: this.cachedRoles.filter(r => !r.isBuiltIn), // Only custom roles
                systemPrompts: this.cachedSystemPrompts,
                coordinatorPrompt: this.cachedCoordinatorPrompt
            };
            await vscode.env.clipboard.writeText(JSON.stringify(exportData, null, 2));
            vscode.window.showInformationMessage('Agent settings copied to clipboard');
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
                'Import agent settings from clipboard? This will merge with your current settings.',
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
                
                // Import system prompts
                if (importData.systemPrompts && Array.isArray(importData.systemPrompts)) {
                    for (const prompt of importData.systemPrompts) {
                        if (this.vsCodeClient) {
                            await this.vsCodeClient.send('prompts.update', { prompt });
                        } else if (this.registry) {
                            const config = SystemPromptConfig.fromJSON(prompt);
                            this.registry.updateSystemPrompt(config);
                        }
                    }
                }
                
                // Import coordinator prompt
                if (importData.coordinatorPrompt) {
                    if (this.vsCodeClient) {
                        await this.vsCodeClient.send('prompts.updateCoordinator', { config: importData.coordinatorPrompt });
                    } else if (this.registry) {
                        this.registry.updateCoordinatorPrompt(importData.coordinatorPrompt);
                    }
                }
                
                vscode.window.showInformationMessage('Agent settings imported successfully');
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
                const response = await this.vsCodeClient.send<{ roles: any[]; systemPrompts: any[]; coordinatorPrompt: any }>('roles.getAll', {});
                this.cachedRoles = response.roles || [];
                this.cachedSystemPrompts = response.systemPrompts || [];
                this.cachedCoordinatorPrompt = response.coordinatorPrompt || DefaultCoordinatorPrompt;
            } catch (err) {
                console.error('[RoleSettingsPanel] Failed to fetch roles from daemon:', err);
                // Use defaults if daemon fetch fails
                this.cachedRoles = Object.values(DefaultRoleConfigs).map(c => ({ ...c, isBuiltIn: true }));
                this.cachedSystemPrompts = Object.values(DefaultSystemPrompts);
                this.cachedCoordinatorPrompt = DefaultCoordinatorPrompt;
            }
        }
        this.panel.webview.html = this.getWebviewContent();
    }

    /**
     * Generate the webview HTML content
     */
    private getWebviewContent(): string {
        // Get data from either daemon cache or local registry
        let roles: any[];
        let roleIds: string[];
        let systemPrompts: any[];
        let systemPromptIds: string[];
        let coordinatorPrompt: any;
        
        if (this.vsCodeClient) {
            // Daemon mode: use cached data
            roles = this.cachedRoles;
            roleIds = roles.map(r => r.id).sort((a, b) => {
                const aBuiltIn = roles.find(r => r.id === a)?.isBuiltIn;
                const bBuiltIn = roles.find(r => r.id === b)?.isBuiltIn;
                if (aBuiltIn && !bBuiltIn) return -1;
                if (!aBuiltIn && bBuiltIn) return 1;
                return a.localeCompare(b);
            });
            systemPrompts = this.cachedSystemPrompts;
            systemPromptIds = systemPrompts.map(p => p.id).sort();
            coordinatorPrompt = this.cachedCoordinatorPrompt;
        } else if (this.registry) {
            // Local registry mode
            roles = this.registry.getAllRoles().map(r => r.toJSON());
            roleIds = this.registry.getRoleIdsSorted();
            systemPrompts = this.registry.getAllSystemPrompts().map(p => p.toJSON());
            systemPromptIds = this.registry.getSystemPromptIdsSorted();
            coordinatorPrompt = this.registry.getCoordinatorPrompt();
        } else {
            // Fallback to defaults
            roles = Object.values(DefaultRoleConfigs).map(c => ({ ...c, isBuiltIn: true }));
            roleIds = Object.keys(DefaultRoleConfigs);
            systemPrompts = Object.values(DefaultSystemPrompts);
            systemPromptIds = Object.keys(DefaultSystemPrompts);
            coordinatorPrompt = DefaultCoordinatorPrompt;
        }

        // Build sidebar tabs data
        const roleTabsData = roleIds.map(id => {
            const role = roles.find(r => r.id === id);
            if (!role) return null;
            return { type: 'role', id: role.id, name: role.name, isBuiltIn: role.isBuiltIn };
        }).filter(Boolean);
        
        const systemTabsData = [
            { type: 'coordinator', id: 'coordinator', name: 'Coordinator Agent', category: 'system' },
            ...systemPromptIds.map(id => {
                const prompt = systemPrompts.find(p => p.id === id);
                if (!prompt) return null;
                return { type: 'system', id: prompt.id, name: prompt.name, category: prompt.category };
            }).filter(Boolean)
        ];

        // Generate data as JSON for JavaScript
        const rolesJson = JSON.stringify(roles.map(r => typeof r.toJSON === 'function' ? r.toJSON() : r));
        const systemPromptsJson = JSON.stringify(systemPrompts.map(p => typeof p.toJSON === 'function' ? p.toJSON() : p));
        const coordinatorPromptJson = JSON.stringify(coordinatorPrompt);
        const defaultsJson = JSON.stringify(
            Object.fromEntries(
                Object.entries(DefaultRoleConfigs).map(([id, config]) => [id, config])
            )
        );
        const defaultSystemPromptsJson = JSON.stringify(
            Object.fromEntries(
                Object.entries(DefaultSystemPrompts).map(([id, config]) => [id, config])
            )
        );
        const defaultCoordinatorPromptJson = JSON.stringify(DefaultCoordinatorPrompt);
        const roleTabsDataJson = JSON.stringify(roleTabsData);
        const systemTabsDataJson = JSON.stringify(systemTabsData);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Agent Settings</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --fg-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --input-bg: var(--vscode-input-background);
            --input-fg: var(--vscode-input-foreground);
            --input-border: var(--vscode-input-border);
            --button-bg: var(--vscode-button-background);
            --button-fg: var(--vscode-button-foreground);
            --button-hover: var(--vscode-button-hoverBackground);
            --tab-active: var(--vscode-tab-activeBackground);
            --tab-inactive: var(--vscode-tab-inactiveBackground);
            --success-color: var(--vscode-terminal-ansiGreen);
            --warning-color: var(--vscode-editorWarning-foreground);
        }
        
        * { box-sizing: border-box; }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg-color);
            background: var(--bg-color);
            margin: 0;
            padding: 20px;
        }
        
        h1 { margin: 0 0 20px 0; font-size: 1.5em; font-weight: 500; }
        h2 { margin: 24px 0 12px 0; font-size: 1.1em; font-weight: 500; opacity: 0.8; }
        h3 { margin: 16px 0 8px 0; font-size: 1em; font-weight: 500; }
        
        .header-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        
        .header-actions {
            display: flex;
            gap: 8px;
        }
        
        /* Vertical sidebar layout */
        .layout {
            display: flex;
            gap: 20px;
        }
        
        .sidebar {
            width: 220px;
            flex-shrink: 0;
        }
        
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
        
        .sidebar-tabs {
            display: flex;
            flex-direction: column;
            gap: 2px;
            border-right: 1px solid var(--border-color);
            padding-right: 12px;
        }
        
        .sidebar-tab {
            padding: 10px 14px;
            background: transparent;
            border: none;
            border-left: 3px solid transparent;
            color: var(--fg-color);
            cursor: pointer;
            font-size: inherit;
            font-family: inherit;
            text-align: left;
            opacity: 0.7;
            border-radius: 0 4px 4px 0;
        }
        
        .sidebar-tab:hover {
            opacity: 1;
            background: var(--input-bg);
        }
        
        .sidebar-tab.active {
            opacity: 1;
            background: var(--tab-active);
            border-left-color: var(--button-bg);
        }
        
        .sidebar-tab .tab-name {
            font-weight: 500;
        }
        
        .sidebar-tab .tab-type {
            font-size: 0.8em;
            opacity: 0.6;
            margin-top: 2px;
        }
        
        .sidebar-tab.tab-add {
            opacity: 0.5;
            font-style: italic;
        }
        
        .main-content {
            flex: 1;
            min-width: 0;
        }
        
        .section {
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 16px;
            margin-bottom: 16px;
        }
        
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        
        .section-title {
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .badge {
            font-size: 0.75em;
            padding: 2px 6px;
            border-radius: 3px;
            background: var(--border-color);
        }
        
        .badge.builtin { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
        .badge.custom { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
        .badge.execution { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
        .badge.planning { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
        .badge.utility { background: rgba(100, 100, 100, 0.2); opacity: 0.7; }
        .badge.system { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
        
        .form-group {
            margin-bottom: 12px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 4px;
            font-size: 0.9em;
            opacity: 0.8;
        }
        
        .form-group .hint {
            font-size: 0.85em;
            opacity: 0.6;
            margin-top: 4px;
        }
        
        input, textarea, select {
            width: 100%;
            padding: 8px;
            background: var(--bg-color);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
        }
        
        textarea {
            min-height: 80px;
            resize: vertical;
        }
        
        textarea.prompt-large {
            min-height: 200px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
        }
        
        textarea.prompt-xlarge {
            min-height: 350px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
        }
        
        button {
            padding: 8px 16px;
            background: var(--button-bg);
            color: var(--button-fg);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: inherit;
            font-family: inherit;
        }
        
        button:hover { background: var(--button-hover); }
        button.secondary {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--fg-color);
        }
        button.danger {
            background: rgba(239, 68, 68, 0.2);
            color: #f87171;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .button-row {
            display: flex;
            gap: 8px;
            margin-top: 12px;
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
    
    <div class="layout">
        <div class="sidebar">
            <div class="sidebar-section">
                <div class="sidebar-section-label">Agent Roles</div>
                <div class="sidebar-tabs" id="role-tabs"></div>
            </div>
            <div class="sidebar-section">
                <div class="sidebar-section-label">System Prompts</div>
                <div class="sidebar-tabs" id="system-tabs"></div>
            </div>
        </div>
        
        <div class="main-content" id="main-content"></div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        // Data
        const roles = ${rolesJson};
        const systemPrompts = ${systemPromptsJson};
        const coordinatorPrompt = ${coordinatorPromptJson};
        const defaults = ${defaultsJson};
        const defaultSystemPrompts = ${defaultSystemPromptsJson};
        const defaultCoordinatorPrompt = ${defaultCoordinatorPromptJson};
        const roleTabsData = ${roleTabsDataJson};
        const systemTabsData = ${systemTabsDataJson};
        
        // Track active selection
        let activeType = 'role';
        let activeId = roles.length > 0 ? roles[0].id : '__new__';
        
        function getRoleById(id) {
            return roles.find(r => r.id === id);
        }
        
        function getSystemPromptById(id) {
            return systemPrompts.find(p => p.id === id);
        }
        
        // Render sidebar tabs
        function renderSidebarTabs() {
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
            
            // System prompt tabs
            const systemContainer = document.getElementById('system-tabs');
            systemContainer.innerHTML = systemTabsData.map(tab => {
                const icons = { coordinator: '🎯', system: '🎯', execution: '🎯', planning: '📋', utility: '⚙️' };
                const icon = icons[tab.category] || '📝';
                return \`
                    <button class="sidebar-tab \${activeType === tab.type && activeId === tab.id ? 'active' : ''}" 
                            data-type="\${tab.type}" data-id="\${tab.id}">
                        <div class="tab-name">\${icon} \${tab.name}</div>
                        <div class="tab-type">\${tab.id}</div>
                    </button>
                \`;
            }).join('');
            
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
            
            if (activeType === 'role') {
                if (activeId === '__new__') {
                    container.innerHTML = renderNewRoleForm();
                } else {
                    const role = getRoleById(activeId);
                    if (role) {
                        container.innerHTML = renderRoleForm(role);
                    }
                }
            } else if (activeType === 'coordinator') {
                container.innerHTML = renderCoordinatorForm();
            } else if (activeType === 'system') {
                const prompt = getSystemPromptById(activeId);
                if (prompt) {
                    container.innerHTML = renderSystemPromptForm(prompt);
                }
            }
            
            attachFormListeners();
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
        
        function renderSystemPromptForm(prompt) {
            const categoryLabels = { execution: 'Execution', planning: 'Planning', utility: 'Utility' };
            const hasDefault = defaultSystemPrompts[prompt.id];
            
            return \`
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">
                            \${prompt.name}
                            <span class="badge \${prompt.category}">\${categoryLabels[prompt.category] || prompt.category}</span>
                        </div>
                    </div>
                    <p style="opacity: 0.8; margin: 0;">\${prompt.description}</p>
                    <div class="role-id-display">ID: \${prompt.id}</div>
                </div>
                
                <form id="systemPromptForm">
                    <input type="hidden" name="id" value="\${prompt.id}">
                    <input type="hidden" name="category" value="\${prompt.category}">
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Settings</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="name">Display Name</label>
                            <input type="text" id="name" name="name" value="\${escapeHtml(prompt.name)}">
                        </div>
                        
                        <div class="form-group">
                            <label for="description">Description</label>
                            <input type="text" id="description" name="description" value="\${escapeHtml(prompt.description)}">
                        </div>
                        
                        <div class="form-group">
                            <label for="defaultModel">Default Model</label>
                            <select id="defaultModel" name="defaultModel">
                                <option value="sonnet-4.5" \${prompt.defaultModel === 'sonnet-4.5' ? 'selected' : ''}>Claude Sonnet 4.5</option>
                                <option value="opus-4.5" \${prompt.defaultModel === 'opus-4.5' ? 'selected' : ''}>Claude Opus 4.5</option>
                                <option value="gemini-3-pro" \${prompt.defaultModel === 'gemini-3-pro' ? 'selected' : ''}>Gemini 3 Pro</option>
                                <option value="haiku-3.5" \${prompt.defaultModel === 'haiku-3.5' ? 'selected' : ''}>Claude Haiku 3.5</option>
                                <option value="gpt-5.1-codex-high" \${prompt.defaultModel === 'gpt-5.1-codex-high' ? 'selected' : ''}>GPT-5.1 Codex High</option>
                            </select>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">System Prompt</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="promptTemplate">Prompt Template</label>
                            <textarea id="promptTemplate" name="promptTemplate" class="prompt-xlarge">\${escapeHtml(prompt.promptTemplate)}</textarea>
                            <div class="hint">This is the base system prompt for this agent. Scenario-specific context will be added at runtime.</div>
                        </div>
                        
                        <div class="button-row">
                            <button type="submit">Save Changes</button>
                            \${hasDefault ? '<button type="button" class="secondary" onclick="resetSystemPrompt()">Reset to Default</button>' : ''}
                        </div>
                    </div>
                </form>
            \`;
        }
        
        function renderCoordinatorForm() {
            const config = coordinatorPrompt;
            
            return \`
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">
                            Coordinator Agent
                            <span class="badge system">System</span>
                        </div>
                    </div>
                    <p style="opacity: 0.8; margin: 0;">\${config.description}</p>
                    <div class="role-id-display">ID: \${config.id}</div>
                    <p class="hint" style="margin-top: 8px;">
                        <strong>Note:</strong> The Coordinator Agent makes high-level decisions about task dispatch, 
                        workflow selection, and user interaction. Its prompt has two configurable parts (roleIntro and 
                        decisionInstructions), while runtime context (current tasks, events, history) is injected dynamically.
                    </p>
                </div>
                
                <form id="coordinatorForm">
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Settings</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="coordinatorName">Display Name</label>
                            <input type="text" id="coordinatorName" name="name" value="\${escapeHtml(config.name)}">
                        </div>
                        
                        <div class="form-group">
                            <label for="coordinatorDescription">Description</label>
                            <input type="text" id="coordinatorDescription" name="description" value="\${escapeHtml(config.description)}">
                        </div>
                        
                        <div class="form-group">
                            <label for="coordinatorModel">Default Model</label>
                            <select id="coordinatorModel" name="defaultModel">
                                <option value="sonnet-4.5" \${config.defaultModel === 'sonnet-4.5' ? 'selected' : ''}>Claude Sonnet 4.5</option>
                                <option value="opus-4.5" \${config.defaultModel === 'opus-4.5' ? 'selected' : ''}>Claude Opus 4.5</option>
                                <option value="gemini-3-pro" \${config.defaultModel === 'gemini-3-pro' ? 'selected' : ''}>Gemini 3 Pro</option>
                                <option value="haiku-3.5" \${config.defaultModel === 'haiku-3.5' ? 'selected' : ''}>Claude Haiku 3.5</option>
                                <option value="gpt-5.1-codex-high" \${config.defaultModel === 'gpt-5.1-codex-high' ? 'selected' : ''}>GPT-5.1 Codex High</option>
                            </select>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Role Introduction</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="roleIntro">Introduction Prompt</label>
                            <textarea id="roleIntro" name="roleIntro" class="prompt-large">\${escapeHtml(config.roleIntro)}</textarea>
                            <div class="hint">This sets the context and identity for the Coordinator Agent. It appears at the start of the prompt.</div>
                        </div>
                    </div>
                    
                    <div class="section">
                        <div class="section-header">
                            <div class="section-title">Decision Instructions</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="decisionInstructions">Decision Making Instructions</label>
                            <textarea id="decisionInstructions" name="decisionInstructions" class="prompt-xlarge">\${escapeHtml(config.decisionInstructions)}</textarea>
                            <div class="hint">These instructions guide how the Coordinator makes decisions. Runtime context (tasks, events, agents) is injected between the introduction and these instructions.</div>
                        </div>
                        
                        <div class="button-row">
                            <button type="submit">Save Changes</button>
                            <button type="button" class="secondary" onclick="resetCoordinatorPrompt()">Reset to Default</button>
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
            
            const systemForm = document.getElementById('systemPromptForm');
            if (systemForm) {
                systemForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    saveSystemPrompt();
                });
            }
            
            const coordinatorForm = document.getElementById('coordinatorForm');
            if (coordinatorForm) {
                coordinatorForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    saveCoordinatorPrompt();
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
        
        function getSystemPromptFormData() {
            const form = document.getElementById('systemPromptForm');
            const formData = new FormData(form);
            
            return {
                id: formData.get('id'),
                name: formData.get('name'),
                description: formData.get('description') || '',
                category: formData.get('category'),
                defaultModel: formData.get('defaultModel'),
                promptTemplate: formData.get('promptTemplate') || ''
            };
        }
        
        function getCoordinatorFormData() {
            const form = document.getElementById('coordinatorForm');
            const formData = new FormData(form);
            
            return {
                id: 'coordinator',
                name: formData.get('name'),
                description: formData.get('description') || '',
                defaultModel: formData.get('defaultModel'),
                roleIntro: formData.get('roleIntro') || '',
                decisionInstructions: formData.get('decisionInstructions') || ''
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
        
        function saveSystemPrompt() {
            const data = getSystemPromptFormData();
            vscode.postMessage({ command: 'saveSystemPrompt', prompt: data });
        }
        
        function saveCoordinatorPrompt() {
            const data = getCoordinatorFormData();
            vscode.postMessage({ command: 'saveCoordinatorPrompt', config: data });
        }
        
        function resetRole() {
            vscode.postMessage({ command: 'reset', roleId: activeId });
        }
        
        function resetSystemPrompt() {
            vscode.postMessage({ command: 'resetSystemPrompt', promptId: activeId });
        }
        
        function resetCoordinatorPrompt() {
            vscode.postMessage({ command: 'resetCoordinatorPrompt' });
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

