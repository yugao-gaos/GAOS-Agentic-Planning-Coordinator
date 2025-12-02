/**
 * Webview panel for displaying workflow history for a session.
 */
import * as vscode from 'vscode';
import { VsCodeClient } from '../vscode/VsCodeClient';
import { WorkflowInfo } from './webview/types';

export class HistoryViewPanel {
    public static currentPanel: HistoryViewPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _sessionId: string;
    private _vsCodeClient?: VsCodeClient;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        sessionId: string,
        vsCodeClient?: VsCodeClient
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._sessionId = sessionId;
        this._vsCodeClient = vsCodeClient;

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

    public static show(sessionId: string, extensionUri: vscode.Uri, vsCodeClient?: VsCodeClient): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it in the target column
        if (HistoryViewPanel.currentPanel) {
            HistoryViewPanel.currentPanel._panel.reveal(column);
            HistoryViewPanel.currentPanel._sessionId = sessionId;
            HistoryViewPanel.currentPanel.updateWebviewContent();
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'historyView',
            'Workflow History',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        HistoryViewPanel.currentPanel = new HistoryViewPanel(panel, extensionUri, sessionId, vsCodeClient);
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                this.updateWebviewContent();
                break;
            case 'openWorkflowLog':
                if (message.logPath) {
                    const uri = vscode.Uri.file(message.logPath);
                    vscode.window.showTextDocument(uri);
                }
                break;
        }
    }

    private async getHistoryData(): Promise<{ sessionId: string; requirement: string; history: WorkflowInfo[] } | null> {
        if (!this._vsCodeClient) {
            return null;
        }

        try {
            // Get session info using the session.get API
            const sessionResponse = await this._vsCodeClient.send<any>('session.get', { id: this._sessionId });
            
            if (!sessionResponse) {
                return null;
            }

            // Transform workflow history from daemon state
            const workflowHistory: WorkflowInfo[] = [];
            if (sessionResponse.state?.workflowHistory) {
                for (const hist of sessionResponse.state.workflowHistory) {
                    workflowHistory.push({
                        id: hist.id,
                        type: hist.type,
                        status: hist.status,
                        phase: hist.phase || hist.status,
                        phaseIndex: 0,
                        totalPhases: 1,
                        percentage: hist.status === 'completed' ? 100 : 0,
                        startedAt: hist.startedAt || '',
                        taskId: hist.taskId,
                        logPath: hist.logPath
                    });
                }
            }

            return {
                sessionId: sessionResponse.id,
                requirement: sessionResponse.requirement || 'Unknown',
                history: workflowHistory
            };
        } catch (error) {
            console.error('Error fetching history data:', error);
            return null;
        }
    }

    private async updateWebviewContent(): Promise<void> {
        const data = await this.getHistoryData();

        if (!data) {
            this._panel.webview.html = this.getErrorHtml();
            return;
        }

        this._panel.title = `History: ${data.requirement.substring(0, 30)}${data.requirement.length > 30 ? '...' : ''}`;
        this._panel.webview.html = this.getWebviewContent(data);
    }

    private getErrorHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workflow History</title>
    <style>
        body {
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
        }
        .error {
            color: var(--vscode-errorForeground);
        }
    </style>
</head>
<body>
    <h2>Error</h2>
    <p class="error">Unable to load workflow history. The session may no longer exist.</p>
</body>
</html>`;
    }

    private getWebviewContent(data: { sessionId: string; requirement: string; history: WorkflowInfo[] }): string {
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this._panel.webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>Workflow History</title>
    <style>
        body {
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: 13px;
        }

        h2 {
            margin-top: 0;
            margin-bottom: 8px;
        }

        .subtitle {
            opacity: 0.7;
            margin-bottom: 20px;
            font-size: 12px;
        }

        .toolbar {
            margin-bottom: 16px;
        }

        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            border-radius: 2px;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .history-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .history-item {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            padding: 12px;
            border-radius: 4px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .history-item.completed {
            border-left: 3px solid #10b981;
        }

        .history-item.failed {
            border-left: 3px solid #f14c4c;
        }

        .history-header {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .workflow-icon {
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .workflow-icon svg {
            width: 16px;
            height: 16px;
            fill: currentColor;
        }

        .workflow-label {
            flex: 1;
            font-weight: 500;
        }

        .workflow-status {
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 2px;
        }

        .workflow-status.completed {
            background: rgba(16, 185, 129, 0.2);
            color: #10b981;
        }

        .workflow-status.failed {
            background: rgba(241, 76, 76, 0.2);
            color: #f14c4c;
        }

        .history-details {
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 11px;
            opacity: 0.8;
        }

        .detail-row {
            display: flex;
            gap: 8px;
        }

        .detail-label {
            font-weight: 500;
            min-width: 80px;
        }

        .detail-value {
            flex: 1;
        }

        .log-link {
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            text-decoration: underline;
        }

        .log-link:hover {
            color: var(--vscode-textLink-activeForeground);
        }

        .no-history {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }

        .workflow-icon.implementation {
            color: #007acc;
        }

        .workflow-icon.revision {
            color: #f97316;
        }

        .workflow-icon.planning {
            color: #8b5cf6;
        }

        .workflow-icon.review {
            color: #eab308;
        }
    </style>
</head>
<body>
    <h2>Workflow History</h2>
    <div class="subtitle">Session: ${this.escapeHtml(data.requirement)}</div>

    <div class="toolbar">
        <button id="refreshBtn">Refresh</button>
    </div>

    <div class="history-list" id="historyList">
        ${data.history.length > 0 ? data.history.map(wf => this.renderHistoryItem(wf)).join('') : '<div class="no-history">No workflow history yet.</div>'}
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'refresh' });
        });

        document.querySelectorAll('.log-link').forEach(link => {
            link.addEventListener('click', () => {
                const logPath = link.dataset.logPath;
                if (logPath) {
                    vscode.postMessage({ command: 'openWorkflowLog', logPath });
                }
            });
        });
    </script>
</body>
</html>`;
    }

    private renderHistoryItem(wf: WorkflowInfo): string {
        const typeInfo = this.getWorkflowTypeInfo(wf.type);
        const statusClass = wf.status === 'completed' ? 'completed' : 'failed';
        const statusText = wf.status === 'completed' ? 'Completed' : 'Failed';
        
        const label = wf.taskId 
            ? `${wf.taskId} ${typeInfo.label}`
            : typeInfo.label;

        const startTime = wf.startedAt ? new Date(wf.startedAt).toLocaleString() : 'Unknown';

        return `
            <div class="history-item ${statusClass}">
                <div class="history-header">
                    <div class="workflow-icon ${typeInfo.class}">
                        ${typeInfo.icon}
                    </div>
                    <div class="workflow-label">${this.escapeHtml(label)}</div>
                    <div class="workflow-status ${statusClass}">
                        ${wf.status === 'completed' ? '✓' : '✗'} ${statusText}
                    </div>
                </div>
                <div class="history-details">
                    <div class="detail-row">
                        <div class="detail-label">Phase:</div>
                        <div class="detail-value">${this.escapeHtml(wf.phase)}</div>
                    </div>
                    <div class="detail-row">
                        <div class="detail-label">Started:</div>
                        <div class="detail-value">${startTime}</div>
                    </div>
                    ${wf.logPath ? `
                    <div class="detail-row">
                        <div class="detail-label">Log:</div>
                        <div class="detail-value">
                            <span class="log-link" data-log-path="${this.escapeHtml(wf.logPath)}">Open workflow log</span>
                        </div>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    private getWorkflowTypeInfo(type: string): { icon: string; class: string; label: string } {
        const icons: { [key: string]: { icon: string; class: string; label: string } } = {
            implementation: {
                icon: '<svg viewBox="0 0 16 16"><path d="M14 1H2c-.55 0-1 .45-1 1v12c0 .55.45 1 1 1h12c.55 0 1-.45 1-1V2c0-.55-.45-1-1-1zM8 12H4v-1h4v1zm4-3H4V8h8v1zm0-3H4V5h8v1z"/></svg>',
                class: 'implementation',
                label: 'Implementation'
            },
            revision: {
                icon: '<svg viewBox="0 0 16 16"><path d="M8.5 1.5A6.5 6.5 0 0 0 2 8a6.5 6.5 0 0 0 6.5 6.5A6.5 6.5 0 0 0 15 8a6.5 6.5 0 0 0-6.5-6.5zm0 12A5.5 5.5 0 0 1 3 8a5.5 5.5 0 0 1 5.5-5.5A5.5 5.5 0 0 1 14 8a5.5 5.5 0 0 1-5.5 5.5z"/><path d="M9 6l-2 2 2 2v-4z"/></svg>',
                class: 'revision',
                label: 'Revision'
            },
            planning: {
                icon: '<svg viewBox="0 0 16 16"><path d="M14 2H2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1V3c0-.55-.45-1-1-1zm-1 10H3V4h10v8z"/><path d="M5 6h6v1H5zm0 2h6v1H5z"/></svg>',
                class: 'planning',
                label: 'Planning'
            },
            review: {
                icon: '<svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 13A6 6 0 1 1 8 2a6 6 0 0 1 0 12z"/><path d="M7 5h2v5H7zm0 6h2v2H7z"/></svg>',
                class: 'review',
                label: 'Review'
            }
        };

        return icons[type] || {
            icon: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>',
            class: '',
            label: type
        };
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    public dispose(): void {
        HistoryViewPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}


