/**
 * Webview panel for displaying all completed sessions.
 * Allows viewing summaries and reopening sessions.
 */
import * as vscode from 'vscode';
import { VsCodeClient } from '../vscode/VsCodeClient';
import { CompletedSessionInfo } from '../client/Protocol';
import { DaemonStateProxy } from '../services/DaemonStateProxy';
import { Logger } from '../utils/Logger';

const log = Logger.create('Client', 'CompletedSessionsPanel');

export class CompletedSessionsPanel {
    public static currentPanel: CompletedSessionsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _stateProxy?: DaemonStateProxy;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        stateProxy?: DaemonStateProxy
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._stateProxy = stateProxy;

        // Update content
        this.updateWebviewContent();

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this._disposables
        );

        // Handle panel closing
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public static show(extensionUri: vscode.Uri, stateProxy?: DaemonStateProxy): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it in the target column
        if (CompletedSessionsPanel.currentPanel) {
            CompletedSessionsPanel.currentPanel._panel.reveal(column);
            CompletedSessionsPanel.currentPanel.updateWebviewContent();
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'completedSessionsView',
            'Completed Sessions',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        CompletedSessionsPanel.currentPanel = new CompletedSessionsPanel(panel, extensionUri, stateProxy);
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                this.updateWebviewContent();
                break;
            case 'reopenSession':
                if (message.sessionId && this._stateProxy) {
                    const success = await this._stateProxy.reopenSession(message.sessionId);
                    if (success) {
                        vscode.window.showInformationMessage(`Session ${message.sessionId} reopened for review`);
                        this.updateWebviewContent();
                    } else {
                        vscode.window.showErrorMessage(`Failed to reopen session ${message.sessionId}`);
                    }
                }
                break;
            case 'openPlan':
                if (message.planPath) {
                    const uri = vscode.Uri.file(message.planPath);
                    vscode.window.showTextDocument(uri);
                } else {
                    vscode.window.showWarningMessage('No plan file available for this session');
                }
                break;
        }
    }

    private async getCompletedSessionsData(): Promise<{ sessions: CompletedSessionInfo[]; total: number } | null> {
        if (!this._stateProxy) {
            return null;
        }

        try {
            // Get all completed sessions (no limit)
            const result = await this._stateProxy.getCompletedSessions();
            return result;
        } catch (error) {
            log.error('Error fetching completed sessions:', error);
            return null;
        }
    }

    private async updateWebviewContent(): Promise<void> {
        const data = await this.getCompletedSessionsData();

        if (!data) {
            this._panel.webview.html = this.getErrorHtml();
            return;
        }

        this._panel.webview.html = this.getWebviewContent(data);
    }

    private getErrorHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Completed Sessions</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .error {
            color: var(--vscode-errorForeground);
            padding: 20px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="error">
        <h2>Unable to load completed sessions</h2>
        <p>Make sure the daemon is running and try again.</p>
        <button onclick="refresh()">Retry</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
    </script>
</body>
</html>`;
    }

    private getWebviewContent(data: { sessions: CompletedSessionInfo[]; total: number }): string {
        const sessionRows = data.sessions.map(session => {
            const completedDate = new Date(session.completedAt).toLocaleString();
            const createdDate = new Date(session.createdAt).toLocaleString();
            const progressText = session.taskProgress 
                ? `${session.taskProgress.completed}/${session.taskProgress.total} (${session.taskProgress.percentage}%)`
                : 'N/A';
            
            return `
                <tr class="session-row" data-session-id="${session.id}">
                    <td class="session-id">${session.id}</td>
                    <td class="session-requirement" title="${this.escapeHtml(session.requirement)}">
                        ${this.escapeHtml(session.requirement)}
                    </td>
                    <td class="session-progress">${progressText}</td>
                    <td class="session-created">${createdDate}</td>
                    <td class="session-completed">${completedDate}</td>
                    <td class="session-actions">
                        <button class="btn btn-secondary" onclick="openPlan('${session.currentPlanPath || ''}')">
                            📄 View Plan
                        </button>
                        <button class="btn btn-primary" onclick="reopenSession('${session.id}')">
                            🔄 Reopen
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Completed Sessions</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        
        .header h1 {
            margin: 0;
            font-size: 18px;
            font-weight: 500;
        }
        
        .header .count {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
        }
        
        .refresh-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .refresh-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        
        th, td {
            padding: 10px 12px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        
        th {
            background: var(--vscode-editor-selectionBackground);
            font-weight: 500;
            position: sticky;
            top: 0;
        }
        
        .session-row:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .session-id {
            font-family: monospace;
            color: var(--vscode-textLink-foreground);
            white-space: nowrap;
        }
        
        .session-requirement {
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .session-progress {
            white-space: nowrap;
            color: var(--vscode-testing-iconPassed);
        }
        
        .session-created,
        .session-completed {
            white-space: nowrap;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        
        .session-actions {
            white-space: nowrap;
        }
        
        .btn {
            padding: 4px 10px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            margin-right: 4px;
        }
        
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-state .icon {
            font-size: 48px;
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>Completed Sessions</h1>
            <span class="count">${data.total} session${data.total !== 1 ? 's' : ''}</span>
        </div>
        <button class="refresh-btn" onclick="refresh()">🔄 Refresh</button>
    </div>
    
    ${data.sessions.length === 0 ? `
        <div class="empty-state">
            <div class="icon">📋</div>
            <div>No completed sessions found</div>
        </div>
    ` : `
        <table>
            <thead>
                <tr>
                    <th>Session ID</th>
                    <th>Requirement</th>
                    <th>Progress</th>
                    <th>Created</th>
                    <th>Completed</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${sessionRows}
            </tbody>
        </table>
    `}
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function reopenSession(sessionId) {
            vscode.postMessage({ command: 'reopenSession', sessionId });
        }
        
        function openPlan(planPath) {
            if (planPath) {
                vscode.postMessage({ command: 'openPlan', planPath });
            } else {
                vscode.postMessage({ command: 'openPlan', planPath: null });
            }
        }
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public dispose(): void {
        CompletedSessionsPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }
}

