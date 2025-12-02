/**
 * DaemonSettingsPanel.ts - Webview panel for daemon settings
 * 
 * Provides a tabbed interface for managing daemon configuration:
 * - General: Pool size, state interval, log level
 * - Unity: Enable/disable Unity features
 * - Folders: Customize folder structure
 * - Advanced: Port, backend, cache settings
 */

import * as vscode from 'vscode';
import { VsCodeClient } from '../vscode/VsCodeClient';

export class DaemonSettingsPanel {
    public static currentPanel: DaemonSettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly vsCodeClient: VsCodeClient;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    
    // Cached data
    private daemonConfig: Record<string, unknown> = {};
    private folderStructure: Record<string, string> = {};

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        vsCodeClient: VsCodeClient
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.vsCodeClient = vsCodeClient;
        
        // Set panel icon and title
        this.panel.title = 'Daemon Settings';
        
        // Set initial HTML
        this.update();
        
        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'refresh':
                        this.update();
                        break;
                    case 'setConfig':
                        this.setConfig(message.key, message.value);
                        break;
                    case 'resetConfig':
                        this.resetConfig(message.key);
                        break;
                    case 'setFolder':
                        this.setFolder(message.folder, message.name);
                        break;
                    case 'resetFolders':
                        this.resetFolders(message.folder);
                        break;
                }
            },
            null,
            this.disposables
        );
        
        // Clean up on close
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }
    
    public static show(extensionUri: vscode.Uri, vsCodeClient: VsCodeClient) {
        const column = vscode.ViewColumn.One;
        
        // If panel already exists, reveal it
        if (DaemonSettingsPanel.currentPanel) {
            DaemonSettingsPanel.currentPanel.panel.reveal(column);
            DaemonSettingsPanel.currentPanel.update();
            return;
        }
        
        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'apcDaemonSettings',
            'Daemon Settings',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        
        DaemonSettingsPanel.currentPanel = new DaemonSettingsPanel(
            panel,
            extensionUri,
            vsCodeClient
        );
    }
    
    public dispose() {
        DaemonSettingsPanel.currentPanel = undefined;
        
        this.panel.dispose();
        
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
    
    private async update() {
        this.panel.webview.html = await this.getWebviewContent();
    }
    
    private async setConfig(key: string, value: unknown) {
        try {
            // Convert value to proper type
            let typedValue: unknown = value;
            if (key === 'agentPoolSize' || key === 'stateUpdateInterval' || key === 'port') {
                typedValue = parseInt(value as string, 10);
            } else if (key === 'enableUnityFeatures') {
                typedValue = value === 'true' || value === true;
            }
            
            const result = await this.vsCodeClient.setConfig(key, typedValue);
            if (result.success) {
                vscode.window.showInformationMessage(`✓ ${key} updated to ${typedValue}`);
                this.update();
            } else {
                vscode.window.showErrorMessage(`Failed to update ${key}: ${result.error}`);
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error updating ${key}: ${err}`);
        }
    }
    
    private async resetConfig(key?: string) {
        try {
            const result = await this.vsCodeClient.resetConfig(key);
            if (result.success) {
                vscode.window.showInformationMessage(key ? `✓ ${key} reset to default` : '✓ All settings reset to defaults');
                this.update();
            } else {
                vscode.window.showErrorMessage(`Failed to reset: ${result.error}`);
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error resetting: ${err}`);
        }
    }
    
    private async setFolder(folder: string, name: string) {
        try {
            const result = await this.vsCodeClient.setFolder(folder, name);
            if (result.success) {
                vscode.window.showInformationMessage(`✓ Folder ${folder} set to ${name}`);
                this.update();
            } else {
                vscode.window.showErrorMessage(`Failed to set folder: ${result.error}`);
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error setting folder: ${err}`);
        }
    }
    
    private async resetFolders(folder?: string) {
        try {
            const result = await this.vsCodeClient.resetFolders(folder);
            if (result.success) {
                vscode.window.showInformationMessage(folder ? `✓ Folder ${folder} reset` : '✓ All folders reset to defaults');
                this.update();
            } else {
                vscode.window.showErrorMessage(`Failed to reset folders: ${result.error}`);
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error resetting folders: ${err}`);
        }
    }
    
    private async getWebviewContent(): Promise<string> {
        // Load current config and folders
        try {
            this.daemonConfig = await this.vsCodeClient.getConfig() as Record<string, unknown>;
            this.folderStructure = await this.vsCodeClient.getFolders() as Record<string, string>;
        } catch (err) {
            vscode.window.showErrorMessage('Failed to load daemon settings. Is the daemon running?');
            this.daemonConfig = {};
            this.folderStructure = {};
        }
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Daemon Settings</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        
        .header {
            margin-bottom: 30px;
        }
        
        h1 {
            margin: 0 0 10px 0;
            font-size: 24px;
            font-weight: 600;
        }
        
        .subtitle {
            opacity: 0.8;
            font-size: 14px;
        }
        
        .tabs {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 20px;
            gap: 5px;
        }
        
        .tab {
            padding: 10px 20px;
            cursor: pointer;
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            opacity: 0.7;
            transition: all 0.2s;
            border-bottom: 2px solid transparent;
        }
        
        .tab:hover {
            opacity: 1;
            background: var(--vscode-list-hoverBackground);
        }
        
        .tab.active {
            opacity: 1;
            border-bottom-color: var(--vscode-focusBorder);
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .section {
            margin-bottom: 30px;
            padding: 20px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 6px;
        }
        
        .section-title {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
            font-size: 14px;
        }
        
        input[type="number"],
        input[type="text"],
        select {
            width: 100%;
            padding: 8px 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: var(--vscode-font-family);
            font-size: 13px;
        }
        
        input[type="checkbox"] {
            margin-right: 8px;
        }
        
        .hint {
            font-size: 12px;
            opacity: 0.7;
            margin-top: 5px;
        }
        
        button {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 13px;
        }
        
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .button-row {
            display: flex;
            gap: 10px;
            margin-top: 15px;
        }
        
        .badge {
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 600;
        }
        
        .badge.default {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        
        .badge.custom {
            background: var(--vscode-statusBarItem-warningBackground);
            color: var(--vscode-statusBarItem-warningForeground);
        }
        
        .folder-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 15px;
        }
        
        .folder-item {
            padding: 15px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        
        .folder-key {
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-symbolIcon-variableForeground);
        }
        
        .config-value {
            font-family: var(--vscode-editor-font-family);
            background: var(--vscode-textCodeBlock-background);
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>⚙️ Daemon Settings</h1>
        <div class="subtitle">Configure APC daemon behavior, pool size, folders, and features</div>
    </div>
    
    <div class="tabs">
        <button class="tab active" onclick="showTab('general')">General</button>
        <button class="tab" onclick="showTab('unity')">Unity</button>
        <button class="tab" onclick="showTab('folders')">Folders</button>
        <button class="tab" onclick="showTab('advanced')">Advanced</button>
    </div>
    
    <!-- General Tab -->
    <div id="general" class="tab-content active">
        <div class="section">
            <div class="section-title">
                Agent Pool
            </div>
            
            <div class="form-group">
                <label for="agentPoolSize">
                    Pool Size
                    ${isDefault('agentPoolSize', 10) ? '<span class="badge default">Default</span>' : '<span class="badge custom">Custom</span>'}
                </label>
                <input 
                    type="number" 
                    id="agentPoolSize" 
                    value="${this.daemonConfig.agentPoolSize || 10}"
                    min="1"
                    max="20"
                    onchange="setConfig('agentPoolSize', this.value)"
                />
                <div class="hint">Number of agents available in the pool (1-20)</div>
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">
                Performance
            </div>
            
            <div class="form-group">
                <label for="stateUpdateInterval">
                    State Update Interval
                    ${isDefault('stateUpdateInterval', 5000) ? '<span class="badge default">Default</span>' : '<span class="badge custom">Custom</span>'}
                </label>
                <input 
                    type="number" 
                    id="stateUpdateInterval" 
                    value="${this.daemonConfig.stateUpdateInterval || 5000}"
                    min="1000"
                    step="1000"
                    onchange="setConfig('stateUpdateInterval', this.value)"
                />
                <div class="hint">Interval in milliseconds to update state files (minimum 1000ms)</div>
            </div>
            
            <div class="form-group">
                <label for="logLevel">
                    Log Level
                    ${isDefault('logLevel', 'info') ? '<span class="badge default">Default</span>' : '<span class="badge custom">Custom</span>'}
                </label>
                <select id="logLevel" onchange="setConfig('logLevel', this.value)">
                    <option value="debug" ${this.daemonConfig.logLevel === 'debug' ? 'selected' : ''}>Debug</option>
                    <option value="info" ${this.daemonConfig.logLevel === 'info' || !this.daemonConfig.logLevel ? 'selected' : ''}>Info</option>
                    <option value="warn" ${this.daemonConfig.logLevel === 'warn' ? 'selected' : ''}>Warning</option>
                    <option value="error" ${this.daemonConfig.logLevel === 'error' ? 'selected' : ''}>Error</option>
                </select>
                <div class="hint">Daemon log verbosity level</div>
            </div>
        </div>
        
        <div class="button-row">
            <button onclick="resetAllConfig()">Reset All to Defaults</button>
        </div>
    </div>
    
    <!-- Unity Tab -->
    <div id="unity" class="tab-content">
        <div class="section">
            <div class="section-title">
                Unity Features
            </div>
            
            <div class="form-group">
                <label>
                    <input 
                        type="checkbox" 
                        id="enableUnityFeatures" 
                        ${this.daemonConfig.enableUnityFeatures !== false ? 'checked' : ''}
                        onchange="setConfig('enableUnityFeatures', this.checked)"
                    />
                    Enable Unity Features
                    ${isDefault('enableUnityFeatures', true) ? '<span class="badge default">Default</span>' : '<span class="badge custom">Custom</span>'}
                </label>
                <div class="hint">
                    Enable Unity-specific features: MCP integration, Unity Control Manager, 
                    compilation/testing pipelines. Disable for non-Unity projects.
                </div>
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">
                Unity Documentation
            </div>
            
            <p style="opacity: 0.8; margin-bottom: 15px;">
                Unity best practices are loaded from:
            </p>
            <ul style="opacity: 0.8; margin: 0; padding-left: 20px;">
                <li><strong>Built-in:</strong> <code>resources/UnityBestPractices.md</code></li>
                <li><strong>Custom docs:</strong> <code>_AiDevLog/Docs/</code> (add your own Unity guides here)</li>
            </ul>
        </div>
    </div>
    
    <!-- Folders Tab -->
    <div id="folders" class="tab-content">
        <div class="section">
            <div class="section-title">
                Folder Structure
            </div>
            
            <p style="opacity: 0.8; margin-bottom: 20px;">
                Customize the names of subdirectories within the working directory.
                Changes apply immediately.
            </p>
            
            <div class="folder-grid">
                ${this.renderFolderItems()}
            </div>
        </div>
        
        <div class="button-row">
            <button onclick="resetAllFolders()">Reset All Folders to Defaults</button>
        </div>
    </div>
    
    <!-- Advanced Tab -->
    <div id="advanced" class="tab-content">
        <div class="section">
            <div class="section-title">
                Daemon Configuration
            </div>
            
            <div class="form-group">
                <label for="port">
                    Port
                    ${isDefault('port', 19840) ? '<span class="badge default">Default</span>' : '<span class="badge custom">Custom</span>'}
                </label>
                <input 
                    type="number" 
                    id="port" 
                    value="${this.daemonConfig.port || 19840}"
                    min="1024"
                    max="65535"
                    onchange="setConfig('port', this.value)"
                />
                <div class="hint">WebSocket port for daemon (requires daemon restart)</div>
            </div>
            
            <div class="form-group">
                <label>Current Configuration</label>
                <pre class="config-value">${JSON.stringify(this.daemonConfig, null, 2)}</pre>
            </div>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function showTab(tabName) {
            // Hide all tabs
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            // Show selected tab
            document.getElementById(tabName).classList.add('active');
            event.target.classList.add('active');
        }
        
        function setConfig(key, value) {
            vscode.postMessage({
                command: 'setConfig',
                key: key,
                value: value
            });
        }
        
        function resetConfig(key) {
            vscode.postMessage({
                command: 'resetConfig',
                key: key
            });
        }
        
        function resetAllConfig() {
            if (confirm('Reset all settings to defaults?')) {
                vscode.postMessage({
                    command: 'resetConfig'
                });
            }
        }
        
        function setFolder(folder, name) {
            vscode.postMessage({
                command: 'setFolder',
                folder: folder,
                name: name
            });
        }
        
        function resetAllFolders() {
            if (confirm('Reset all folders to defaults?')) {
                vscode.postMessage({
                    command: 'resetFolders'
                });
            }
        }
        
        function isDefault(key, defaultValue) {
            const value = ${JSON.stringify(this.daemonConfig)}[key];
            return value === undefined || value === defaultValue;
        }
    </script>
</body>
</html>`;
    }
    
    private renderFolderItems(): string {
        const defaults: Record<string, string> = {
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
        
        const items: string[] = [];
        
        for (const [key, value] of Object.entries(this.folderStructure)) {
            // Skip .config and .cache (not customizable)
            if (key === 'config' || key === 'cache') {
                continue;
            }
            
            const isDefault = value === defaults[key];
            const badge = isDefault 
                ? '<span class="badge default">Default</span>' 
                : '<span class="badge custom">Custom</span>';
            
            items.push(`
                <div class="folder-item">
                    <div class="folder-key">${key} ${badge}</div>
                    <input 
                        type="text" 
                        value="${value}"
                        onchange="setFolder('${key}', this.value)"
                    />
                    ${!isDefault ? `<div class="button-row"><button class="secondary" onclick="vscode.postMessage({command: 'resetFolders', folder: '${key}'})">Reset</button></div>` : ''}
                </div>
            `);
        }
        
        return items.join('');
    }
}

