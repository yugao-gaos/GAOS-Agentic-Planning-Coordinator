import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';
import { VsCodeClient } from '../vscode/VsCodeClient';
import { getSettingsCommonStyles } from './webview/styles/settingsCommon';

const log = Logger.create('Client', 'WorkflowSettings');
import { 
    WorkflowType,
    ContextGatheringPresetConfig, 
    ContextPresetUserConfig,
    WorkflowUserSettings,
    DEFAULT_WORKFLOW_USER_SETTINGS
} from '../types/workflow';
import {
    DEFAULT_WORKFLOW_METADATA,
    WORKFLOW_DESCRIPTIONS,
    getWorkflowSettingsPath,
    loadWorkflowSettings,
    saveWorkflowSettings,
    hasCustomCoordinatorPrompt
} from '../services/WorkflowSettingsManager';
import {
    BUILTIN_PRESETS,
    DEFAULT_EXTENSION_MAP,
    loadUserConfig as loadContextConfig,
    saveUserConfig as saveContextConfig,
    getConfigPath as getContextConfigPath
} from '../services/workflows/ContextGatheringPresets';

/**
 * Custom workflow info from daemon
 */
interface CustomWorkflowInfo {
    type: string;
    name: string;
    version: string;
    description: string;
    parameters: Array<{ name: string; type: string; required: boolean; default?: any; description?: string }>;
    variables: Array<{ id: string; type: string; default?: any }>;
    nodeCount: number;
    filePath: string;
    requiresUnity: boolean;
}

// ============================================================================
// WorkflowSettingsPanel
// ============================================================================

/**
 * Webview panel for configuring workflow settings.
 * 
 * Provides a tabbed interface with one tab per workflow type:
 * - Workflow metadata (name, description, Unity requirement)
 * - Coordinator prompt (how the workflow is presented to the coordinator AI)
 * - Workflow-specific settings (e.g., context gathering presets)
 */
export class WorkflowSettingsPanel {
    public static currentPanel: WorkflowSettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly workspaceRoot: string;
    private readonly vsCodeClient: VsCodeClient;
    private disposables: vscode.Disposable[] = [];
    
    // Cached data
    private workflowSettings: WorkflowUserSettings;
    private contextConfig: ContextPresetUserConfig;

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
        
        // Load settings
        this.workflowSettings = loadWorkflowSettings(workspaceRoot);
        this.contextConfig = loadContextConfig(workspaceRoot) || {
            customPresets: [],
            extensionOverrides: {}
        };

        // Set initial content
        this.updateWebviewContent();

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
    }

    /**
     * Show the workflow settings panel (create if doesn't exist, or reveal)
     */
    public static show(extensionUri: vscode.Uri, vsCodeClient: VsCodeClient, workspaceRoot: string): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists, reveal it
        if (WorkflowSettingsPanel.currentPanel) {
            WorkflowSettingsPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'apcWorkflowSettings',
            'Workflow Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        WorkflowSettingsPanel.currentPanel = new WorkflowSettingsPanel(panel, extensionUri, vsCodeClient, workspaceRoot);
    }

    /**
     * Handle messages from the webview
     */
    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            // Coordinator prompt management
            case 'saveCoordinatorPrompt':
                await this.saveCoordinatorPrompt(message.workflowType, message.prompt);
                break;
            case 'resetCoordinatorPrompt':
                await this.resetCoordinatorPrompt(message.workflowType);
                break;
            
            // Context gathering presets
            case 'savePreset':
                await this.savePreset(message.preset);
                break;
            case 'deletePreset':
                await this.deletePreset(message.presetId);
                break;
            case 'saveExtensionMapping':
                await this.saveExtensionMapping(message.extension, message.presetId);
                break;
            case 'deleteExtensionMapping':
                await this.deleteExtensionMapping(message.extension);
                break;
            
            // Global actions
            case 'resetAll':
                await this.resetAll();
                break;
            case 'exportConfig':
                await this.exportConfig();
                break;
            case 'importConfig':
                await this.importConfig();
                break;
            case 'refresh':
                this.reloadConfig();
                this.updateWebviewContent();
                break;
            case 'openConfigFile':
                await this.openConfigFile(message.configType);
                break;
            
            // Custom workflow management
            case 'getCustomWorkflows':
                await this.sendCustomWorkflows();
                break;
            case 'createNewWorkflow':
                await this.createNewWorkflow();
                break;
            case 'openNodeGraphEditor':
                await vscode.commands.executeCommand('apc.openNodeGraphEditor', 
                    message.filePath ? vscode.Uri.file(message.filePath) : undefined
                );
                break;
            case 'openYamlFile':
                if (message.filePath) {
                    const uri = vscode.Uri.file(message.filePath);
                    await vscode.window.showTextDocument(uri);
                }
                break;
            case 'deleteCustomWorkflow':
                await this.deleteCustomWorkflow(message.type);
                break;
        }
    }

    /**
     * Reload config from disk
     */
    private reloadConfig(): void {
        this.workflowSettings = loadWorkflowSettings(this.workspaceRoot);
        this.contextConfig = loadContextConfig(this.workspaceRoot) || {
            customPresets: [],
            extensionOverrides: {}
        };
    }

    // =========================================================================
    // Coordinator Prompt Management
    // =========================================================================

    /**
     * Save coordinator prompt for a workflow
     */
    private async saveCoordinatorPrompt(workflowType: WorkflowType, prompt: string): Promise<void> {
        try {
            this.workflowSettings.coordinatorPrompts[workflowType] = prompt;
            
            if (saveWorkflowSettings(this.workspaceRoot, this.workflowSettings)) {
                vscode.window.showInformationMessage(`Coordinator prompt for "${workflowType}" saved`);
                this.updateWebviewContent();
            } else {
                vscode.window.showErrorMessage('Failed to save workflow settings');
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to save: ${e.message}`);
        }
    }

    /**
     * Reset coordinator prompt to default
     */
    private async resetCoordinatorPrompt(workflowType: WorkflowType): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Reset coordinator prompt for "${workflowType}" to default?`,
            { modal: true },
            'Reset'
        );

        if (confirm === 'Reset') {
            delete this.workflowSettings.coordinatorPrompts[workflowType];
            
            if (saveWorkflowSettings(this.workspaceRoot, this.workflowSettings)) {
                vscode.window.showInformationMessage(`Coordinator prompt for "${workflowType}" reset to default`);
                this.updateWebviewContent();
            }
        }
    }

    // =========================================================================
    // Context Gathering Preset Management
    // =========================================================================

    /**
     * Save a custom preset (create or update)
     */
    private async savePreset(preset: ContextGatheringPresetConfig): Promise<void> {
        try {
            if (!preset.id || !preset.name) {
                vscode.window.showErrorMessage('Preset must have an ID and name');
                return;
            }
            
            if (BUILTIN_PRESETS[preset.id]) {
                vscode.window.showErrorMessage(`Cannot overwrite built-in preset "${preset.id}"`);
                return;
            }
            
            const customPresets = this.contextConfig.customPresets || [];
            const existingIndex = customPresets.findIndex(p => p.id === preset.id);
            
            if (existingIndex >= 0) {
                customPresets[existingIndex] = preset;
            } else {
                customPresets.push(preset);
            }
            
            this.contextConfig.customPresets = customPresets;
            
            if (saveContextConfig(this.workspaceRoot, this.contextConfig)) {
                vscode.window.showInformationMessage(`Preset "${preset.name}" saved successfully`);
                this.updateWebviewContent();
            } else {
                vscode.window.showErrorMessage('Failed to save config file');
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to save preset: ${e.message}`);
        }
    }

    /**
     * Delete a custom preset
     */
    private async deletePreset(presetId: string): Promise<void> {
        if (BUILTIN_PRESETS[presetId]) {
            vscode.window.showErrorMessage('Cannot delete built-in presets');
            return;
        }
        
        const confirm = await vscode.window.showWarningMessage(
            `Delete preset "${presetId}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            const customPresets = this.contextConfig.customPresets || [];
            this.contextConfig.customPresets = customPresets.filter(p => p.id !== presetId);
            
            if (saveContextConfig(this.workspaceRoot, this.contextConfig)) {
                vscode.window.showInformationMessage(`Preset "${presetId}" deleted`);
                this.updateWebviewContent();
            }
        }
    }

    /**
     * Save an extension mapping override
     */
    private async saveExtensionMapping(extension: string, presetId: string): Promise<void> {
        try {
            if (!extension.startsWith('.')) {
                extension = '.' + extension;
            }
            
            const overrides = this.contextConfig.extensionOverrides || {};
            overrides[extension] = presetId;
            this.contextConfig.extensionOverrides = overrides;
            
            if (saveContextConfig(this.workspaceRoot, this.contextConfig)) {
                vscode.window.showInformationMessage(`Extension "${extension}" mapped to "${presetId}"`);
                this.updateWebviewContent();
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to save mapping: ${e.message}`);
        }
    }

    /**
     * Delete an extension mapping override
     */
    private async deleteExtensionMapping(extension: string): Promise<void> {
        const overrides = this.contextConfig.extensionOverrides || {};
        delete overrides[extension];
        this.contextConfig.extensionOverrides = overrides;
        
        if (saveContextConfig(this.workspaceRoot, this.contextConfig)) {
            vscode.window.showInformationMessage(`Extension mapping "${extension}" removed`);
            this.updateWebviewContent();
        }
    }

    // =========================================================================
    // Global Actions
    // =========================================================================

    /**
     * Reset all workflow settings
     */
    private async resetAll(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Reset all workflow settings to defaults? Custom prompts and presets will be deleted.',
            { modal: true },
            'Reset All'
        );

        if (confirm === 'Reset All') {
            this.workflowSettings = { ...DEFAULT_WORKFLOW_USER_SETTINGS };
            this.contextConfig = { customPresets: [], extensionOverrides: {} };
            
            // Delete config files
            const workflowPath = getWorkflowSettingsPath(this.workspaceRoot);
            const contextPath = getContextConfigPath(this.workspaceRoot);
            
            try {
                if (fs.existsSync(workflowPath)) fs.unlinkSync(workflowPath);
                if (fs.existsSync(contextPath)) fs.unlinkSync(contextPath);
            } catch (e) {
                log.error('Failed to delete config files:', e);
            }
            
            vscode.window.showInformationMessage('Workflow settings reset to defaults');
            this.updateWebviewContent();
        }
    }

    /**
     * Export all config to clipboard
     */
    private async exportConfig(): Promise<void> {
        const exportData = {
            workflowSettings: this.workflowSettings,
            contextGathering: this.contextConfig
        };
        await vscode.env.clipboard.writeText(JSON.stringify(exportData, null, 2));
        vscode.window.showInformationMessage('Config copied to clipboard');
    }

    /**
     * Import config from clipboard
     */
    private async importConfig(): Promise<void> {
        const clipboardText = await vscode.env.clipboard.readText();
        
        try {
            const importData = JSON.parse(clipboardText);
            
            // Validate custom presets don't conflict with built-ins
            if (importData.contextGathering?.customPresets) {
                const conflictingIds = importData.contextGathering.customPresets
                    .filter((p: any) => BUILTIN_PRESETS[p.id])
                    .map((p: any) => p.id);
                
                if (conflictingIds.length > 0) {
                    throw new Error(`Cannot import presets with built-in IDs: ${conflictingIds.join(', ')}`);
                }
            }
            
            const confirm = await vscode.window.showWarningMessage(
                'Import config from clipboard? This will replace your current settings.',
                { modal: true },
                'Import'
            );

            if (confirm === 'Import') {
                if (importData.workflowSettings) {
                    this.workflowSettings = importData.workflowSettings;
                    saveWorkflowSettings(this.workspaceRoot, this.workflowSettings);
                }
                if (importData.contextGathering) {
                    this.contextConfig = importData.contextGathering;
                    saveContextConfig(this.workspaceRoot, this.contextConfig);
                }
                vscode.window.showInformationMessage('Config imported successfully');
                this.updateWebviewContent();
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Invalid config JSON: ${e.message}`);
        }
    }

    /**
     * Open config file in editor
     */
    private async openConfigFile(configType: 'workflow' | 'context'): Promise<void> {
        const configPath = configType === 'workflow' 
            ? getWorkflowSettingsPath(this.workspaceRoot)
            : getContextConfigPath(this.workspaceRoot);
        
        // Create if doesn't exist
        if (!fs.existsSync(configPath)) {
            const dir = path.dirname(configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            if (configType === 'workflow') {
                saveWorkflowSettings(this.workspaceRoot, this.workflowSettings);
            } else {
                saveContextConfig(this.workspaceRoot, this.contextConfig);
            }
        }
        
        const uri = vscode.Uri.file(configPath);
        await vscode.window.showTextDocument(uri);
    }

    // =========================================================================
    // Custom Workflow Management
    // =========================================================================

    /**
     * Fetch and send custom workflows to the webview
     */
    private async sendCustomWorkflows(): Promise<void> {
        try {
            if (!this.vsCodeClient.isConnected()) {
                this.panel.webview.postMessage({ 
                    command: 'setCustomWorkflows', 
                    workflows: [],
                    error: 'Daemon not connected'
                });
                return;
            }
            
            const response = await this.vsCodeClient.send('workflow.custom.list', {});
            const workflows = (response as any)?.data || [];
            
            this.panel.webview.postMessage({ 
                command: 'setCustomWorkflows', 
                workflows 
            });
        } catch (e: any) {
            log.error('Failed to fetch custom workflows:', e);
            this.panel.webview.postMessage({ 
                command: 'setCustomWorkflows', 
                workflows: [],
                error: e.message
            });
        }
    }

    /**
     * Create a new custom workflow
     */
    private async createNewWorkflow(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter workflow name',
            placeHolder: 'my_custom_workflow',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Name is required';
                }
                if (!/^[a-zA-Z][a-zA-Z0-9_\- ]*$/.test(value)) {
                    return 'Name must start with a letter and contain only letters, numbers, underscores, hyphens, and spaces';
                }
                return null;
            }
        });

        if (!name) return;

        try {
            if (!this.vsCodeClient.isConnected()) {
                throw new Error('Daemon not connected');
            }
            
            log.info(`Creating workflow: ${name}`);
            const response = await this.vsCodeClient.send('workflow.custom.create', { name });
            log.info(`Response received:`, response);
            
            const filePath = (response as any)?.data?.filePath;
            
            if (filePath) {
                log.info(`Workflow created at: ${filePath}`);
                vscode.window.showInformationMessage(`Custom workflow "${name}" created at ${filePath}`);
                
                // Open in editor
                await vscode.commands.executeCommand('apc.openNodeGraphEditor', vscode.Uri.file(filePath));
                
                // Refresh the list
                await this.sendCustomWorkflows();
            } else {
                log.warn(`No filePath in response:`, response);
                vscode.window.showWarningMessage(`Workflow may have been created but no file path returned`);
            }
        } catch (e: any) {
            log.error(`Failed to create workflow:`, e);
            vscode.window.showErrorMessage(`Failed to create workflow: ${e.message}`);
        }
    }

    /**
     * Delete a custom workflow
     */
    private async deleteCustomWorkflow(workflowType: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete custom workflow "${workflowType}"? This action cannot be undone.`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') return;

        try {
            if (!this.vsCodeClient.isConnected()) {
                throw new Error('Daemon not connected');
            }
            
            await this.vsCodeClient.send('workflow.custom.delete', { type: workflowType });
            vscode.window.showInformationMessage(`Custom workflow "${workflowType}" deleted`);
            
            // Refresh the list
            await this.sendCustomWorkflows();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to delete workflow: ${e.message}`);
        }
    }

    /**
     * Update the webview content
     */
    private updateWebviewContent(): void {
        this.panel.webview.html = this.getWebviewContent();
    }

    /**
     * Get effective coordinator prompt for a workflow (user override or default)
     */
    private getEffectiveCoordinatorPrompt(type: WorkflowType): string {
        return this.workflowSettings.coordinatorPrompts[type] || DEFAULT_WORKFLOW_METADATA[type].coordinatorPrompt;
    }


    /**
     * Generate the webview HTML content
     */
    private getWebviewContent(): string {
        const workflowTypes: WorkflowType[] = [
            'planning_new',
            'planning_revision', 
            'task_implementation',
            'error_resolution',
            'context_gathering'
        ];

        // Build workflow data for JavaScript
        const workflowData = workflowTypes.map(type => ({
            type,
            name: DEFAULT_WORKFLOW_METADATA[type].name,
            description: WORKFLOW_DESCRIPTIONS[type],
            requiresUnity: DEFAULT_WORKFLOW_METADATA[type].requiresUnity,
            defaultPrompt: DEFAULT_WORKFLOW_METADATA[type].coordinatorPrompt,
            customPrompt: this.workflowSettings.coordinatorPrompts[type] || '',
            hasCustomPrompt: hasCustomCoordinatorPrompt(this.workspaceRoot, type)
        }));

        // Context gathering data
        const builtInPresets = Object.values(BUILTIN_PRESETS);
        const customPresets = this.contextConfig.customPresets || [];
        const overrideMappings = this.contextConfig.extensionOverrides || {};

        // Escape for JavaScript embedding
        const workflowDataJson = JSON.stringify(workflowData);
        const builtInPresetsJson = JSON.stringify(builtInPresets);
        const customPresetsJson = JSON.stringify(customPresets);
        const defaultMappingsJson = JSON.stringify(DEFAULT_EXTENSION_MAP);
        const overrideMappingsJson = JSON.stringify(overrideMappings);
        
        // Debug logging
        log.debug('Workflow data being embedded:', workflowDataJson);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Workflow Settings</title>
    <style>
${getSettingsCommonStyles()}
        
        /* Panel-specific styles */
        .sidebar {
            width: 200px;
        }
        
        /* Normalize workflow tabs to use sidebar-tab classes */
        .workflow-tabs {
            display: flex;
            flex-direction: column;
            gap: 2px;
            border-right: 1px solid var(--border-color);
            padding-right: 12px;
        }
        
        .workflow-tab {
            padding: 10px 14px;
            background: transparent;
            border: none;
            border-left: 3px solid transparent;
            color: var(--fg-color);
            cursor: pointer;
            font-size: inherit;
            text-align: left;
            opacity: 0.7;
            border-radius: 0 4px 4px 0;
        }
        
        .workflow-tab:hover {
            opacity: 1;
            background: var(--input-bg);
        }
        
        .workflow-tab.active {
            opacity: 1;
            background: var(--tab-active);
            border-left-color: var(--button-bg);
        }
        
        .workflow-tab .tab-name {
            font-weight: 500;
        }
        
        .workflow-tab .tab-type {
            font-size: 0.8em;
            opacity: 0.6;
            margin-top: 2px;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        /* Workflow-specific badges */
        .badge.modified { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
        .badge.default { background: rgba(100, 100, 100, 0.2); opacity: 0.6; }
        .badge.unity { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
        
        /* Workflow-specific styles */
        .workflow-meta {
            display: grid;
            grid-template-columns: 100px 1fr;
            gap: 8px;
            font-size: 0.9em;
        }
        
        .workflow-meta dt {
            opacity: 0.6;
        }
        
        textarea {
            min-height: 150px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
        }
        
        /* Context gathering specific */
        .card {
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 8px;
        }
        
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        
        .card-title {
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .mapping-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9em;
        }
        
        .mapping-table th, .mapping-table td {
            padding: 8px;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }
        
        .mapping-table th {
            font-weight: 500;
            opacity: 0.7;
        }
        
        .add-form {
            display: flex;
            gap: 8px;
            align-items: flex-end;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
        }
        
        .add-form .form-group {
            flex: 1;
            margin-bottom: 0;
        }
        
        .preset-list {
            max-height: 300px;
            overflow-y: auto;
        }
        
        .empty-state {
            text-align: center;
            padding: 30px;
            opacity: 0.6;
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
        <h1>⚙️ Workflow Settings</h1>
        <div class="header-actions">
            <button class="secondary" onclick="exportConfig()">Export</button>
            <button class="secondary" onclick="importConfig()">Import</button>
            <button class="danger" onclick="resetAll()">Reset All</button>
        </div>
    </div>
    
    <div class="layout">
        <div class="sidebar">
            <div style="margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border-color);">
                <span style="font-size: 0.75em; text-transform: uppercase; opacity: 0.5; letter-spacing: 0.5px;">Built-in Workflows</span>
            </div>
            <div class="workflow-tabs" id="workflow-tabs"></div>
            
            <div style="margin: 16px 0 12px 0; padding-top: 12px; border-top: 1px solid var(--border-color);">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 0.75em; text-transform: uppercase; opacity: 0.5; letter-spacing: 0.5px;">Custom Workflows</span>
                    <button class="secondary" style="padding: 4px 8px; font-size: 0.8em;" 
                            onclick="createNewWorkflow()">+ New</button>
                </div>
            </div>
            <div class="workflow-tabs" id="custom-workflow-tabs">
                <div class="empty-state" style="padding: 12px; font-size: 0.9em;">Loading...</div>
            </div>
        </div>
        
        <div class="main-content" id="main-content"></div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        console.log('=== Workflow Settings Script Starting ===');
        console.log('VS Code API acquired:', !!vscode);
        
        // Data
        const workflows = ${workflowDataJson};
        const builtInPresets = ${builtInPresetsJson};
        const customPresets = ${customPresetsJson};
        const defaultMappings = ${defaultMappingsJson};
        const overrideMappings = ${overrideMappingsJson};
        
        console.log('Data loaded - workflows:', workflows.length, 'builtInPresets:', builtInPresets.length);
        
        // Safety check: If workflows is empty or undefined, show error immediately
        if (!workflows || workflows.length === 0) {
            console.error('CRITICAL: No workflows loaded!');
            const mainContent = document.getElementById('main-content');
            if (mainContent) {
                mainContent.innerHTML = '<div class="section"><h2 style="color: var(--warning-color);">No Workflows Available</h2><p>The workflow data failed to load. This indicates a configuration issue.</p><p>workflows data: ' + JSON.stringify(workflows) + '</p></div>';
            }
        }
        
        let activeWorkflow = workflows.length > 0 ? workflows[0].type : 'task_implementation';
        let customWorkflows = [];
        let isCustomWorkflowActive = false;
        
        // Debug logging
        console.log('Workflow Settings Panel initialized');
        console.log('Available workflows:', workflows);
        console.log('Active workflow:', activeWorkflow);
        
        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'setCustomWorkflows') {
                customWorkflows = message.workflows || [];
                renderCustomWorkflowTabs();
                // Re-render content if a custom workflow is active
                if (isCustomWorkflowActive) {
                    const cw = customWorkflows.find(x => x.type === activeWorkflow);
                    if (cw) {
                        renderCustomWorkflowContent(cw);
                    }
                }
            }
        });
        
        // Request custom workflows on load
        vscode.postMessage({ command: 'getCustomWorkflows' });
        
        // Render tabs
        function renderTabs() {
            const container = document.getElementById('workflow-tabs');
            container.innerHTML = workflows.map(w => \`
                <button class="workflow-tab \${w.type === activeWorkflow ? 'active' : ''}" 
                        data-type="\${w.type}">
                    <div class="tab-name">\${w.name}</div>
                    <div class="tab-type">\${w.type}</div>
                </button>
            \`).join('');
            
            // Add click handlers
            container.querySelectorAll('.workflow-tab').forEach(tab => {
                tab.onclick = () => {
                    activeWorkflow = tab.dataset.type;
                    isCustomWorkflowActive = false;
                    renderTabs();
                    renderCustomWorkflowTabs();
                    renderContent();
                };
            });
        }
        
        // Render custom workflow tabs
        function renderCustomWorkflowTabs() {
            const container = document.getElementById('custom-workflow-tabs');
            if (customWorkflows.length === 0) {
                container.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 0.85em;">No custom workflows<br><span style="opacity: 0.6; font-size: 0.9em;">Click + New to create one</span></div>';
                return;
            }
            
            container.innerHTML = customWorkflows.map(w => \`
                <button class="workflow-tab \${w.type === activeWorkflow && isCustomWorkflowActive ? 'active' : ''}" 
                        data-type="\${w.type}" data-custom="true">
                    <div class="tab-name">\${w.name}</div>
                    <div class="tab-type">\${w.type}</div>
                </button>
            \`).join('');
            
            container.querySelectorAll('.workflow-tab').forEach(tab => {
                tab.onclick = () => {
                    activeWorkflow = tab.dataset.type;
                    isCustomWorkflowActive = true;
                    renderTabs();
                    renderCustomWorkflowTabs();
                    const cw = customWorkflows.find(x => x.type === activeWorkflow);
                    if (cw) renderCustomWorkflowContent(cw);
                };
            });
        }
        
        // Render custom workflow content
        function renderCustomWorkflowContent(w) {
            const container = document.getElementById('main-content');
            container.innerHTML = \`
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">
                            \${w.name}
                            <span class="badge custom">Custom</span>
                            \${w.requiresUnity ? '<span class="badge unity">Requires Unity</span>' : ''}
                        </div>
                        <button onclick="openEditor('\${escapeHtml(w.filePath)}')">📝 Open Editor</button>
                    </div>
                    <p style="opacity: 0.8; margin: 0 0 16px 0;">\${w.description || 'No description'}</p>
                    
                    <dl class="workflow-meta">
                        <dt>Type:</dt><dd><code>\${w.type}</code></dd>
                        <dt>Version:</dt><dd>\${w.version || '1.0'}</dd>
                        <dt>Nodes:</dt><dd>\${w.nodeCount || 0}</dd>
                        <dt>File:</dt><dd style="word-break: break-all;"><code>\${w.filePath}</code></dd>
                    </dl>
                </div>
                
                \${w.parameters && w.parameters.length > 0 ? \`
                <div class="section">
                    <div class="section-title">Parameters</div>
                    <p class="hint" style="margin-bottom: 12px;">
                        These parameters can be passed when dispatching this workflow.
                    </p>
                    <table class="mapping-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Type</th>
                                <th>Required</th>
                                <th>Default</th>
                                <th>Description</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${w.parameters.map(p => \`
                                <tr>
                                    <td><code>\${p.name}</code></td>
                                    <td>\${p.type}</td>
                                    <td>\${p.required ? '✓' : ''}</td>
                                    <td>\${p.default !== undefined ? JSON.stringify(p.default) : '-'}</td>
                                    <td style="opacity: 0.7;">\${p.description || ''}</td>
                                </tr>
                            \`).join('')}
                        </tbody>
                    </table>
                </div>
                \` : ''}
                
                \${w.variables && w.variables.length > 0 ? \`
                <div class="section">
                    <div class="section-title">Variables</div>
                    <p class="hint" style="margin-bottom: 12px;">
                        Internal variables used during workflow execution.
                    </p>
                    <table class="mapping-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Type</th>
                                <th>Default</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${w.variables.map(v => \`
                                <tr>
                                    <td><code>\${v.id}</code></td>
                                    <td>\${v.type}</td>
                                    <td>\${v.default !== undefined ? JSON.stringify(v.default) : '-'}</td>
                                </tr>
                            \`).join('')}
                        </tbody>
                    </table>
                </div>
                \` : ''}
                
                <div class="section">
                    <div class="section-title">Actions</div>
                    <div class="button-row">
                        <button onclick="openEditor('\${escapeHtml(w.filePath)}')">Open in Node Graph Editor</button>
                        <button class="secondary" onclick="openYamlFile('\${escapeHtml(w.filePath)}')">Edit YAML Directly</button>
                        <button class="danger" onclick="deleteWorkflow('\${w.type}')">Delete Workflow</button>
                    </div>
                </div>
            \`;
        }
        
        // Render main content
        function renderContent() {
            const w = workflows.find(x => x.type === activeWorkflow);
            if (!w) {
                console.error('No workflow found for type:', activeWorkflow, 'Available workflows:', workflows);
                const container = document.getElementById('main-content');
                container.innerHTML = '<div class="section"><p style="color: var(--warning-color);">Error: Could not load workflow data. Please check the console.</p></div>';
                return;
            }
            
            const container = document.getElementById('main-content');
            
            // Base content for all workflows
            let html = \`
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">
                            \${w.name}
                            \${w.requiresUnity ? '<span class="badge unity">Requires Unity</span>' : ''}
                        </div>
                    </div>
                    <p style="opacity: 0.8; margin: 0;">\${w.description}</p>
                </div>
                
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">
                            Coordinator Prompt
                            \${w.hasCustomPrompt ? '<span class="badge modified">Modified</span>' : '<span class="badge default">Default</span>'}
                        </div>
                        <div>
                            <button class="secondary" onclick="openConfigFile('workflow')">Open File</button>
                        </div>
                    </div>
                    <p class="hint" style="margin-bottom: 12px;">
                        This text is injected into the AI Coordinator's prompt to describe when and how to use this workflow.
                    </p>
                    <div class="form-group">
                        <textarea id="prompt-\${w.type}" class="prompt-large">\${escapeHtml(w.customPrompt || w.defaultPrompt)}</textarea>
                    </div>
                    <div class="button-row">
                        <button onclick="saveCoordinatorPrompt('\${w.type}')">Save Prompt</button>
                        <button class="secondary" onclick="resetCoordinatorPrompt('\${w.type}')" \${!w.hasCustomPrompt ? 'disabled' : ''}>
                            Reset to Default
                        </button>
                    </div>
                </div>
            \`;
            
            // Add context gathering specific UI
            if (w.type === 'context_gathering') {
                html += renderContextGatheringSettings();
            }
            
            container.innerHTML = html;
        }
        
        // Context gathering settings
        function renderContextGatheringSettings() {
            return \`
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">Context Presets</div>
                        <button class="secondary" onclick="openConfigFile('context')">Open File</button>
                    </div>
                    <p class="hint" style="margin-bottom: 12px;">
                        Presets define specialized prompts for different file types. Built-in presets cannot be modified.
                    </p>
                    
                    <h3>Built-in Presets</h3>
                    <div class="preset-list">
                        \${builtInPresets.map(p => \`
                            <div class="card">
                                <div class="card-header">
                                    <div class="card-title">
                                        \${p.name}
                                        <span class="badge builtin">Built-in</span>
                                        \${p.requiresUnity ? '<span class="badge unity">Unity</span>' : ''}
                                    </div>
                                </div>
                                <div style="opacity: 0.7; font-size: 0.9em;">\${p.description}</div>
                                <div style="margin-top: 6px; font-size: 0.85em; opacity: 0.5;">
                                    Patterns: \${p.filePatterns.join(', ')}
                                </div>
                            </div>
                        \`).join('')}
                    </div>
                    
                    <div class="subsection">
                        <h3>Custom Presets</h3>
                        <div class="preset-list">
                            \${customPresets.length === 0 
                                ? '<div class="empty-state">No custom presets</div>'
                                : customPresets.map(p => \`
                                    <div class="card">
                                        <div class="card-header">
                                            <div class="card-title">
                                                \${p.name}
                                                <span class="badge custom">Custom</span>
                                            </div>
                                            <div>
                                                <button class="secondary" onclick="editPreset('\${p.id}')">Edit</button>
                                                <button class="danger" onclick="deletePreset('\${p.id}')">Delete</button>
                                            </div>
                                        </div>
                                        <div style="opacity: 0.7; font-size: 0.9em;">\${p.description || 'No description'}</div>
                                        <div style="margin-top: 6px; font-size: 0.85em; opacity: 0.5;">
                                            Patterns: \${(p.filePatterns || []).join(', ') || 'None'}
                                        </div>
                                    </div>
                                \`).join('')
                            }
                        </div>
                        <div class="button-row">
                            <button onclick="showNewPresetForm()">+ Add Custom Preset</button>
                        </div>
                    </div>
                </div>
                
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">Extension Mappings</div>
                    </div>
                    <p class="hint" style="margin-bottom: 12px;">
                        Map file extensions to presets. Overrides (green) take precedence over defaults.
                    </p>
                    
                    <table class="mapping-table">
                        <thead>
                            <tr>
                                <th>Extension</th>
                                <th>Preset</th>
                                <th>Source</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody id="mappings-body">
                            \${renderMappingsRows()}
                        </tbody>
                    </table>
                    
                    <div class="add-form">
                        <div class="form-group">
                            <label>Extension</label>
                            <input type="text" id="new-mapping-ext" placeholder=".vue">
                        </div>
                        <div class="form-group">
                            <label>Preset</label>
                            <select id="new-mapping-preset">
                                \${[...builtInPresets, ...customPresets].map(p => 
                                    \`<option value="\${p.id}">\${p.name}</option>\`
                                ).join('')}
                            </select>
                        </div>
                        <button onclick="addMapping()">Add</button>
                    </div>
                </div>
                
                <!-- New Preset Form Modal -->
                <div id="preset-form-modal" class="section" style="display: none;">
                    <h3 id="preset-form-title">New Custom Preset</h3>
                    <div class="form-group">
                        <label>ID (unique identifier)</label>
                        <input type="text" id="preset-id" placeholder="e.g., vue_components">
                    </div>
                    <div class="form-group">
                        <label>Name</label>
                        <input type="text" id="preset-name" placeholder="e.g., Vue Components">
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <input type="text" id="preset-description" placeholder="Brief description">
                    </div>
                    <div class="form-group">
                        <label>File Patterns (comma-separated)</label>
                        <input type="text" id="preset-patterns" placeholder="e.g., .vue, .svelte">
                    </div>
                    <div class="form-group">
                        <label>Gather Prompt</label>
                        <textarea id="preset-gather" placeholder="Instructions for gathering context..."></textarea>
                    </div>
                    <div class="form-group">
                        <label>Summarize Prompt</label>
                        <textarea id="preset-summarize" placeholder="Instructions for summarizing..."></textarea>
                    </div>
                    <div class="button-row">
                        <button onclick="savePreset()">Save Preset</button>
                        <button class="secondary" onclick="hidePresetForm()">Cancel</button>
                    </div>
                </div>
            \`;
        }
        
        function renderMappingsRows() {
            const all = { ...defaultMappings, ...overrideMappings };
            return Object.entries(all)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([ext, presetId]) => {
                    const isOverride = overrideMappings.hasOwnProperty(ext);
                    return \`
                        <tr>
                            <td><code>\${ext}</code></td>
                            <td>\${presetId}</td>
                            <td style="\${isOverride ? 'color: var(--success-color)' : ''}">\${isOverride ? 'Override' : 'Default'}</td>
                            <td>
                                \${isOverride ? \`<button class="danger" onclick="deleteMapping('\${ext}')">Remove</button>\` : ''}
                            </td>
                        </tr>
                    \`;
                }).join('');
        }
        
        // Escape HTML
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Coordinator prompt actions
        function saveCoordinatorPrompt(type) {
            const textarea = document.getElementById('prompt-' + type);
            if (!textarea) return;
            vscode.postMessage({ command: 'saveCoordinatorPrompt', workflowType: type, prompt: textarea.value });
        }
        
        function resetCoordinatorPrompt(type) {
            vscode.postMessage({ command: 'resetCoordinatorPrompt', workflowType: type });
        }
        
        // Preset actions
        function showNewPresetForm() {
            document.getElementById('preset-form-modal').style.display = 'block';
            document.getElementById('preset-form-title').textContent = 'New Custom Preset';
            document.getElementById('preset-id').value = '';
            document.getElementById('preset-id').disabled = false;
            document.getElementById('preset-name').value = '';
            document.getElementById('preset-description').value = '';
            document.getElementById('preset-patterns').value = '';
            document.getElementById('preset-gather').value = '';
            document.getElementById('preset-summarize').value = '';
        }
        
        function hidePresetForm() {
            document.getElementById('preset-form-modal').style.display = 'none';
        }
        
        function editPreset(presetId) {
            const preset = customPresets.find(p => p.id === presetId);
            if (!preset) return;
            
            document.getElementById('preset-form-modal').style.display = 'block';
            document.getElementById('preset-form-title').textContent = 'Edit Preset';
            document.getElementById('preset-id').value = preset.id;
            document.getElementById('preset-id').disabled = true;
            document.getElementById('preset-name').value = preset.name;
            document.getElementById('preset-description').value = preset.description || '';
            document.getElementById('preset-patterns').value = (preset.filePatterns || []).join(', ');
            document.getElementById('preset-gather').value = preset.gatherPrompt || '';
            document.getElementById('preset-summarize').value = preset.summarizePrompt || '';
        }
        
        function savePreset() {
            const preset = {
                id: document.getElementById('preset-id').value.trim(),
                name: document.getElementById('preset-name').value.trim(),
                description: document.getElementById('preset-description').value.trim(),
                filePatterns: document.getElementById('preset-patterns').value
                    .split(',')
                    .map(p => p.trim())
                    .filter(p => p),
                gatherPrompt: document.getElementById('preset-gather').value,
                summarizePrompt: document.getElementById('preset-summarize').value,
                isBuiltIn: false
            };
            
            if (!preset.id || !preset.name) {
                alert('ID and Name are required');
                return;
            }
            
            vscode.postMessage({ command: 'savePreset', preset });
            hidePresetForm();
        }
        
        function deletePreset(presetId) {
            vscode.postMessage({ command: 'deletePreset', presetId });
        }
        
        // Extension mapping actions
        function addMapping() {
            const ext = document.getElementById('new-mapping-ext').value.trim();
            const presetId = document.getElementById('new-mapping-preset').value;
            
            if (!ext) {
                alert('Extension is required');
                return;
            }
            
            vscode.postMessage({ command: 'saveExtensionMapping', extension: ext, presetId });
            document.getElementById('new-mapping-ext').value = '';
        }
        
        function deleteMapping(ext) {
            vscode.postMessage({ command: 'deleteExtensionMapping', extension: ext });
        }
        
        // Global actions
        function resetAll() {
            vscode.postMessage({ command: 'resetAll' });
        }
        
        function exportConfig() {
            vscode.postMessage({ command: 'exportConfig' });
        }
        
        function importConfig() {
            vscode.postMessage({ command: 'importConfig' });
        }
        
        function openConfigFile(type) {
            vscode.postMessage({ command: 'openConfigFile', configType: type });
        }
        
        // Custom workflow actions
        function createNewWorkflow() {
            vscode.postMessage({ command: 'createNewWorkflow' });
        }
        
        function openEditor(filePath) {
            vscode.postMessage({ command: 'openNodeGraphEditor', filePath: filePath });
        }
        
        function openYamlFile(filePath) {
            vscode.postMessage({ command: 'openYamlFile', filePath: filePath });
        }
        
        function deleteWorkflow(type) {
            if (confirm('Delete this custom workflow? This action cannot be undone.')) {
                vscode.postMessage({ command: 'deleteCustomWorkflow', type: type });
            }
        }
        
        // Initial render
        try {
            console.log('Starting initial render...');
            renderTabs();
            console.log('Tabs rendered');
            renderContent();
            console.log('Content rendered');
            renderCustomWorkflowTabs();
            console.log('Custom workflow tabs rendered');
        } catch (error) {
            console.error('Error during initial render:', error);
            const mainContent = document.getElementById('main-content');
            if (mainContent) {
                mainContent.innerHTML = '<div class="section"><h2 style="color: var(--warning-color);">Error Initializing Workflow Settings</h2><p>Check the console for details: ' + error.message + '</p></div>';
            }
        }
    </script>
</body>
</html>`;
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        WorkflowSettingsPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
