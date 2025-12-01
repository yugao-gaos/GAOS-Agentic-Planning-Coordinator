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

        // Generate tabs HTML with sections
        // Note: Use local `roles` array instead of this.registry since registry may be null in daemon mode
        const roleTabsHtml = roleIds.map(id => {
            const role = roles.find(r => r.id === id);
            if (!role) return '';
            const icon = role.isBuiltIn ? '🔧' : '✨';
            return `<button class="tab" data-type="role" data-id="${role.id}">${icon} ${role.name}</button>`;
        }).filter(Boolean).join('') + '<button class="tab tab-add" data-type="role" data-id="__new__">+ Add Role</button>';

        // System prompts tab: Coordinator first, then other system prompts
        const coordinatorTabHtml = `<button class="tab" data-type="coordinator" data-id="coordinator">🎯 Coordinator Agent</button>`;
        const otherSystemTabsHtml = systemPromptIds.map(id => {
            const prompt = systemPrompts.find(p => p.id === id);
            if (!prompt) return '';
            const categoryIcons: Record<string, string> = { execution: '🎯', planning: '📋', utility: '⚙️' };
            const icon = categoryIcons[prompt.category] || '📝';
            return `<button class="tab" data-type="system" data-id="${prompt.id}">${icon} ${prompt.name}</button>`;
        }).filter(Boolean).join('');
        const systemTabsHtml = coordinatorTabHtml + otherSystemTabsHtml;

        // Generate data as JSON for JavaScript
        // In daemon mode, roles/systemPrompts are already plain objects; in local mode, they may be class instances
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
            --error-color: var(--vscode-errorForeground);
            --warning-color: var(--vscode-editorWarning-foreground);
        }
        
        * {
            box-sizing: border-box;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg-color);
            background: var(--bg-color);
            margin: 0;
            padding: 20px;
        }
        
        h1 {
            margin: 0 0 20px 0;
            font-size: 1.5em;
            font-weight: 500;
        }
        
        h2 {
            margin: 24px 0 12px 0;
            font-size: 1.1em;
            font-weight: 500;
            color: var(--fg-color);
            opacity: 0.8;
        }
        
        .tabs-section {
            margin-bottom: 8px;
        }
        
        .tabs-section-label {
            font-size: 0.75em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.6;
            margin-bottom: 4px;
            padding-left: 2px;
        }
        
        .tabs {
            display: flex;
            flex-wrap: wrap;
            gap: 2px;
            border-bottom: 1px solid var(--border-color);
            margin-bottom: 8px;
        }
        
        .tab {
            padding: 8px 16px;
            background: var(--tab-inactive);
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--fg-color);
            cursor: pointer;
            font-size: inherit;
            font-family: inherit;
            opacity: 0.7;
        }
        
        .tab:hover {
            opacity: 1;
        }
        
        .tab.active {
            background: var(--tab-active);
            border-bottom-color: var(--button-bg);
            opacity: 1;
        }
        
        .tab-add {
            opacity: 0.5;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .form-group {
            margin-bottom: 16px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 4px;
            font-weight: 500;
        }
        
        .form-group .hint {
            font-size: 0.85em;
            opacity: 0.7;
            margin-top: 2px;
        }
        
        input[type="text"],
        input[type="number"],
        select,
        textarea {
            width: 100%;
            padding: 8px;
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            font-family: inherit;
            font-size: inherit;
        }
        
        textarea {
            min-height: 80px;
            resize: vertical;
        }
        
        textarea.prompt-template {
            min-height: 300px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
        }
        
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .checkbox-group input {
            width: auto;
        }
        
        .button-row {
            display: flex;
            gap: 10px;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid var(--border-color);
        }
        
        button {
            padding: 8px 16px;
            background: var(--button-bg);
            color: var(--button-fg);
            border: none;
            cursor: pointer;
            font-family: inherit;
            font-size: inherit;
        }
        
        button:hover {
            background: var(--button-hover);
        }
        
        button.secondary {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--fg-color);
        }
        
        button.danger {
            background: var(--error-color);
        }
        
        .section {
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .section h3 {
            margin: 0 0 12px 0;
            font-size: 1.1em;
            font-weight: 500;
        }
        
        .array-input {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        
        .array-input textarea {
            min-height: 60px;
        }
        
        .role-id-display {
            font-family: var(--vscode-editor-font-family, monospace);
            background: var(--input-bg);
            padding: 4px 8px;
            border-radius: 4px;
            opacity: 0.7;
        }
        
        .builtin-badge {
            display: inline-block;
            background: var(--button-bg);
            color: var(--button-fg);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.8em;
            margin-left: 10px;
        }
        
        .category-badge {
            display: inline-block;
            background: var(--input-bg);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.8em;
            margin-left: 10px;
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <h1>🤖 Agent Settings</h1>
    
    <div class="tabs-section">
        <div class="tabs-section-label">Agent Roles</div>
        <div class="tabs">
            ${roleTabsHtml}
        </div>
    </div>
    
    <div class="tabs-section">
        <div class="tabs-section-label">System Prompts</div>
        <div class="tabs">
            ${systemTabsHtml}
        </div>
    </div>
    
    <div id="content"></div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const roles = ${rolesJson};
        const systemPrompts = ${systemPromptsJson};
        const coordinatorPrompt = ${coordinatorPromptJson};
        const defaults = ${defaultsJson};
        const defaultSystemPrompts = ${defaultSystemPromptsJson};
        const defaultCoordinatorPrompt = ${defaultCoordinatorPromptJson};
        
        // Track which type and id is active
        let activeType = 'role';
        let activeId = roles.length > 0 ? roles[0].id : '__new__';
        
        function getRoleById(id) {
            return roles.find(r => r.id === id);
        }
        
        function getSystemPromptById(id) {
            return systemPrompts.find(p => p.id === id);
        }
        
        function renderContent() {
            const content = document.getElementById('content');
            
            if (activeType === 'role') {
                if (activeId === '__new__') {
                    content.innerHTML = renderNewRoleForm();
                } else {
                    const role = getRoleById(activeId);
                    if (role) {
                        content.innerHTML = renderRoleForm(role);
                    }
                }
            } else if (activeType === 'coordinator') {
                content.innerHTML = renderCoordinatorForm();
            } else if (activeType === 'system') {
                const prompt = getSystemPromptById(activeId);
                if (prompt) {
                    content.innerHTML = renderSystemPromptForm(prompt);
                }
            }
            
            // Update active tab
            document.querySelectorAll('.tab').forEach(tab => {
                const tabType = tab.dataset.type;
                const tabId = tab.dataset.id;
                tab.classList.toggle('active', tabType === activeType && tabId === activeId);
            });
            
            // Attach event listeners
            attachFormListeners();
        }
        
        function renderRoleForm(role) {
            const isBuiltIn = role.isBuiltIn;
            const hasDefault = defaults[role.id];
            
            return \`
                <div class="section">
                    <h3>
                        \${role.name}
                        \${isBuiltIn ? '<span class="builtin-badge">Built-in</span>' : ''}
                    </h3>
                    <p class="role-id-display">ID: \${role.id}</p>
                </div>
                
                <form id="roleForm">
                    <input type="hidden" name="id" value="\${role.id}">
                    <input type="hidden" name="isBuiltIn" value="\${role.isBuiltIn}">
                    
                    <div class="section">
                        <h3>Basic Settings</h3>
                        
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
                        <h3>Permissions</h3>
                        
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
                        <h3>Context</h3>
                        
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
                        <h3>Prompt Template</h3>
                        
                        <div class="form-group">
                            <label for="promptTemplate">System Prompt</label>
                            <textarea id="promptTemplate" name="promptTemplate" class="prompt-template" placeholder="Optional custom prompt template">\${escapeHtml(role.promptTemplate)}</textarea>
                            <div class="hint">Leave empty to use the default prompt for this role</div>
                        </div>
                    </div>
                    
                    <div class="button-row">
                        <button type="submit">Save Changes</button>
                        \${isBuiltIn && hasDefault ? '<button type="button" class="secondary" onclick="resetRole()">Reset to Default</button>' : ''}
                        \${!isBuiltIn ? '<button type="button" class="danger" onclick="deleteRole()">Delete Role</button>' : ''}
                    </div>
                </form>
            \`;
        }
        
        function renderNewRoleForm() {
            return \`
                <div class="section">
                    <h3>Create New Role</h3>
                    <p>Define a custom agent role with specific settings and permissions.</p>
                </div>
                
                <form id="roleForm">
                    <input type="hidden" name="isBuiltIn" value="false">
                    
                    <div class="section">
                        <h3>Basic Settings</h3>
                        
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
                        <h3>Permissions</h3>
                        
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
                        <h3>Context</h3>
                        
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
                        <h3>Prompt Template</h3>
                        
                        <div class="form-group">
                            <label for="promptTemplate">System Prompt</label>
                            <textarea id="promptTemplate" name="promptTemplate" class="prompt-template" placeholder="Optional custom prompt template"></textarea>
                        </div>
                    </div>
                    
                    <div class="button-row">
                        <button type="submit">Create Role</button>
                    </div>
                </form>
            \`;
        }
        
        function renderSystemPromptForm(prompt) {
            const categoryLabels = { execution: 'Execution', planning: 'Planning', utility: 'Utility' };
            const hasDefault = defaultSystemPrompts[prompt.id];
            
            return \`
                <div class="section">
                    <h3>
                        \${prompt.name}
                        <span class="category-badge">\${categoryLabels[prompt.category] || prompt.category}</span>
                    </h3>
                    <p>\${prompt.description}</p>
                    <p class="role-id-display">ID: \${prompt.id}</p>
                </div>
                
                <form id="systemPromptForm">
                    <input type="hidden" name="id" value="\${prompt.id}">
                    <input type="hidden" name="category" value="\${prompt.category}">
                    
                    <div class="section">
                        <h3>Settings</h3>
                        
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
                        <h3>System Prompt</h3>
                        
                        <div class="form-group">
                            <label for="promptTemplate">Prompt Template</label>
                            <textarea id="promptTemplate" name="promptTemplate" class="prompt-template">\${escapeHtml(prompt.promptTemplate)}</textarea>
                            <div class="hint">This is the base system prompt for this agent. Scenario-specific context will be added at runtime.</div>
                        </div>
                    </div>
                    
                    <div class="button-row">
                        <button type="submit">Save Changes</button>
                        \${hasDefault ? '<button type="button" class="secondary" onclick="resetSystemPrompt()">Reset to Default</button>' : ''}
                    </div>
                </form>
            \`;
        }
        
        function renderCoordinatorForm() {
            const config = coordinatorPrompt;
            
            return \`
                <div class="section">
                    <h3>
                        🎯 Coordinator Agent
                        <span class="category-badge">System</span>
                    </h3>
                    <p>\${config.description}</p>
                    <p class="role-id-display">ID: \${config.id}</p>
                    <p class="hint" style="margin-top: 8px;">
                        <strong>Note:</strong> The Coordinator Agent makes high-level decisions about task dispatch, 
                        workflow selection, and user interaction. Its prompt has two configurable parts (roleIntro and 
                        decisionInstructions), while runtime context (current tasks, events, history) is injected dynamically.
                    </p>
                </div>
                
                <form id="coordinatorForm">
                    <div class="section">
                        <h3>Settings</h3>
                        
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
                        <h3>Role Introduction</h3>
                        <div class="form-group">
                            <label for="roleIntro">Introduction Prompt</label>
                            <textarea id="roleIntro" name="roleIntro" class="prompt-template">\${escapeHtml(config.roleIntro)}</textarea>
                            <div class="hint">This sets the context and identity for the Coordinator Agent. It appears at the start of the prompt.</div>
                        </div>
                    </div>
                    
                    <div class="section">
                        <h3>Decision Instructions</h3>
                        <div class="form-group">
                            <label for="decisionInstructions">Decision Making Instructions</label>
                            <textarea id="decisionInstructions" name="decisionInstructions" class="prompt-template" style="min-height: 400px;">\${escapeHtml(config.decisionInstructions)}</textarea>
                            <div class="hint">These instructions guide how the Coordinator makes decisions. Runtime context (tasks, events, agents) is injected between the introduction and these instructions.</div>
                        </div>
                    </div>
                    
                    <div class="button-row">
                        <button type="submit">Save Changes</button>
                        <button type="button" class="secondary" onclick="resetCoordinatorPrompt()">Reset to Default</button>
                    </div>
                </form>
            \`;
        }
        
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
        
        function resetRole() {
            vscode.postMessage({ command: 'reset', roleId: activeId });
        }
        
        function resetSystemPrompt() {
            vscode.postMessage({ command: 'resetSystemPrompt', promptId: activeId });
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
        
        function saveCoordinatorPrompt() {
            const data = getCoordinatorFormData();
            vscode.postMessage({ command: 'saveCoordinatorPrompt', config: data });
        }
        
        function resetCoordinatorPrompt() {
            vscode.postMessage({ command: 'resetCoordinatorPrompt' });
        }
        
        function deleteRole() {
            vscode.postMessage({ command: 'delete', roleId: activeId });
        }
        
        // Tab click handling
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                activeType = tab.dataset.type;
                activeId = tab.dataset.id;
                renderContent();
            });
        });
        
        // Initial render
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

