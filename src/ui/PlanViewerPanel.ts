/**
 * Webview panel for displaying plan.md files with structured view and markdown tabs.
 * Features:
 * - Floating title bar with Revise/Approve buttons
 * - Tab navigation: Structured (parsed) vs Markdown (raw)
 * - Graceful degradation when parsing fails
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { getPlanViewerStyles } from './webview/styles/planViewer';
import { Logger } from '../utils/Logger';
import { PlanParser } from '../services/PlanParser';

const log = Logger.create('Client', 'PlanViewer');

// ============================================================================
// Types
// ============================================================================

interface ParsedMetadata {
    title: string;
    session: string;
    created: string;
    updated: string;
}

interface ParsedTask {
    id: string;
    description: string;
    completed: boolean;
    dependencies: string[];
    engineer: string;
    unity?: string;  // Unity pipeline: none, prep, prep_editmode, prep_playmode, prep_playtest, full
}

interface ParsedSection {
    title: string;
    level: number;
    tasks?: ParsedTask[];
    content: string;
    children?: ParsedSection[];  // Nested subsections (### under ##)
}

interface ParsedPlanData {
    metadata: ParsedMetadata | null;
    sections: ParsedSection[];
    parseSuccess: boolean;
    parseWarnings: string[];
    rawContent: string;
}

// ============================================================================
// PlanViewerPanel
// ============================================================================

export class PlanViewerPanel {
    public static currentPanel: PlanViewerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _planPath: string;
    private _sessionId: string;
    private _sessionStatus: string;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        planPath: string,
        sessionId: string,
        sessionStatus: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._planPath = planPath;
        this._sessionId = sessionId;
        this._sessionStatus = sessionStatus;

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

        // Watch for file changes
        const watcher = vscode.workspace.createFileSystemWatcher(planPath);
        watcher.onDidChange(() => this.updateWebviewContent());
        this._disposables.push(watcher);
    }

    public static show(planPath: string, sessionId: string, extensionUri: vscode.Uri, sessionStatus?: string): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, update it and show
        if (PlanViewerPanel.currentPanel) {
            PlanViewerPanel.currentPanel._panel.reveal(column);
            PlanViewerPanel.currentPanel._planPath = planPath;
            PlanViewerPanel.currentPanel._sessionId = sessionId;
            PlanViewerPanel.currentPanel._sessionStatus = sessionStatus || '';
            PlanViewerPanel.currentPanel.updateWebviewContent();
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'planViewer',
            'Plan Viewer',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        PlanViewerPanel.currentPanel = new PlanViewerPanel(panel, extensionUri, planPath, sessionId, sessionStatus || '');
    }

    /**
     * Update the session status and refresh the panel (called when session.updated event received)
     */
    public static updateSessionStatus(sessionId: string, newStatus: string): void {
        if (PlanViewerPanel.currentPanel && PlanViewerPanel.currentPanel._sessionId === sessionId) {
            PlanViewerPanel.currentPanel._sessionStatus = newStatus;
            PlanViewerPanel.currentPanel.updateWebviewContent();
        }
    }

    /**
     * Show daemon unavailable message
     */
    public static showDaemonUnavailable(): void {
        if (PlanViewerPanel.currentPanel) {
            PlanViewerPanel.currentPanel.showDaemonUnavailableContent();
        }
    }

    /**
     * Get the current session ID (if panel is open)
     */
    public static getCurrentSessionId(): string | undefined {
        return PlanViewerPanel.currentPanel?._sessionId;
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                this.updateWebviewContent();
                break;
            case 'revisePlan':
                vscode.commands.executeCommand('agenticPlanning.revisePlan', { 
                    session: { id: this._sessionId } 
                });
                break;
            case 'addTaskToPlan':
                vscode.commands.executeCommand('agenticPlanning.addTaskToPlan', { 
                    session: { id: this._sessionId } 
                });
                break;
            case 'approvePlan':
                vscode.commands.executeCommand('agenticPlanning.approvePlan', { 
                    session: { id: this._sessionId } 
                });
                break;
            case 'completePlan':
                vscode.commands.executeCommand('agenticPlanning.completeSession', { 
                    session: { id: this._sessionId } 
                });
                break;
            case 'openRawFile':
                if (this._planPath) {
                    const uri = vscode.Uri.file(this._planPath);
                    vscode.window.showTextDocument(uri);
                }
                break;
        }
    }

    private parsePlanFile(): ParsedPlanData {
        const result: ParsedPlanData = {
            metadata: null,
            sections: [],
            parseSuccess: true,
            parseWarnings: [],
            rawContent: ''
        };

        try {
            if (!fs.existsSync(this._planPath)) {
                result.parseSuccess = false;
                result.parseWarnings.push('Plan file not found');
                return result;
            }

            const content = fs.readFileSync(this._planPath, 'utf-8');
            result.rawContent = content;

            // Parse metadata
            result.metadata = this.parseMetadata(content);
            if (!result.metadata) {
                result.parseWarnings.push('Could not parse metadata header');
            }

            // Parse sections
            result.sections = this.parseSections(content);
            if (result.sections.length === 0) {
                result.parseWarnings.push('No sections found');
            }

            // Check if we got meaningful content
            if (!result.metadata && result.sections.length === 0) {
                result.parseSuccess = false;
            }

        } catch (error) {
            log.error('Error parsing plan file:', error);
            result.parseSuccess = false;
            result.parseWarnings.push(`Parse error: ${error instanceof Error ? error.message : String(error)}`);
        }

        return result;
    }

    private parseMetadata(content: string): ParsedMetadata | null {
        try {
            // Extract title from first # heading
            const titleMatch = content.match(/^#\s+(?:Execution Plan:|Plan:)?\s*(.+?)$/m);
            const title = titleMatch ? titleMatch[1].trim() : 'Untitled Plan';

            // Extract metadata fields (status is managed by session, not stored in plan)
            const sessionMatch = content.match(/\*\*Session(?:\s*ID)?:\*\*\s*(.+?)$/m);
            const createdMatch = content.match(/\*\*Created:\*\*\s*(.+?)$/m);
            const updatedMatch = content.match(/\*\*Updated:\*\*\s*(.+?)$/m);

            return {
                title,
                session: sessionMatch ? sessionMatch[1].trim() : this._sessionId,
                created: createdMatch ? createdMatch[1].trim() : 'Unknown',
                updated: updatedMatch ? updatedMatch[1].trim() : 'Unknown'
            };
        } catch {
            return null;
        }
    }

    private parseSections(content: string): ParsedSection[] {
        const sections: ParsedSection[] = [];

        // Split by ## and ### headings
        const sectionPattern = /^(#{2,3})\s+(.+?)$/gm;
        let match: RegExpExecArray | null;
        const matches: { level: number; title: string; start: number; headingEnd: number }[] = [];

        while ((match = sectionPattern.exec(content)) !== null) {
            matches.push({
                level: match[1].length,
                title: match[2].trim(),
                start: match.index,
                headingEnd: match.index + match[0].length
            });
        }

        // Build hierarchical structure: ## sections contain ### children
        let currentLevel2: ParsedSection | null = null;

        for (let i = 0; i < matches.length; i++) {
            const current = matches[i];
            const nextStart = i < matches.length - 1 ? matches[i + 1].start : content.length;
            
            // Get content between this heading and the next (or end of file)
            let sectionContent = content.substring(current.headingEnd, nextStart).trim();
            
            // For level 2 sections, only get content up to the first level 3 subsection
            if (current.level === 2) {
                // Find first ### in this section's content
                const firstSubsection = sectionContent.match(/^###\s+/m);
                if (firstSubsection && firstSubsection.index !== undefined) {
                    sectionContent = sectionContent.substring(0, firstSubsection.index).trim();
                }
            }

            const section: ParsedSection = {
                title: current.title,
                level: current.level,
                content: sectionContent,
                children: []
            };

            // Check if this section contains tasks
            const tasks = this.parseTasksFromContent(sectionContent);
            if (tasks.length > 0) {
                section.tasks = tasks;
            }

            if (current.level === 2) {
                // This is a top-level section (##)
                currentLevel2 = section;
                sections.push(section);
            } else if (current.level === 3 && currentLevel2) {
                // This is a subsection (###) - add to parent's children
                currentLevel2.children!.push(section);
            } else {
                // Orphan ### section (no parent ##) - add as top-level
                sections.push(section);
            }
        }

        return sections;
    }

    private parseTasksFromContent(content: string): ParsedTask[] {
        // Use PlanParser for consistency with daemon
        return PlanParser.parseInlineCheckboxTasks(content);
    }

    private updateWebviewContent(): void {
        const data = this.parsePlanFile();
        
        // Update panel title
        const shortTitle = data.metadata?.title 
            ? data.metadata.title.substring(0, 40) + (data.metadata.title.length > 40 ? '...' : '')
            : 'Plan';
        this._panel.title = shortTitle;

        this._panel.webview.html = this.getWebviewContent(data);
    }

    private showDaemonUnavailableContent(): void {
        this._panel.title = 'Plan Viewer';
        this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Plan Viewer</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
        .message-box {
            text-align: center;
            padding: 40px;
            border-radius: 8px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
        }
        .icon {
            font-size: 48px;
            margin-bottom: 16px;
        }
        .title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 8px;
        }
        .subtitle {
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class="message-box">
        <div class="icon">🔌</div>
        <div class="title">Daemon Unavailable</div>
        <div class="subtitle">The daemon is not connected. Session status cannot be retrieved.</div>
    </div>
</body>
</html>`;
    }

    private getWebviewContent(data: ParsedPlanData): string {
        const nonce = this.getNonce();
        const defaultTab = data.parseSuccess ? 'structured' : 'markdown';
        
        // Determine which action buttons to show based on session status (authoritative source)
        const sessionStatus = this._sessionStatus.toLowerCase();
        // Show Revise/Approve buttons when plan exists (not during active planning)
        const isActivelyPlanning = sessionStatus === 'planning';
        const isActivelyRevising = sessionStatus === 'revising';
        // Use session status (which is authoritative) to determine if plan is already approved
        const isApproved = sessionStatus === 'approved';
        const isCompleted = sessionStatus === 'completed';
        const isExecuting = sessionStatus === 'executing';
        const isApprovedOrCompleted = isApproved || isCompleted || isExecuting;
        // Show buttons unless actively planning (buttons are disabled during revising)
        const showButtons = data.rawContent && !isActivelyPlanning;
        // Disable buttons during revision
        const buttonsDisabled = isActivelyRevising;
        // Show Complete button when session is approved (user can manually complete anytime)
        const showCompleteButton = isApproved;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this._panel.webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>Plan Viewer</title>
    <style>${getPlanViewerStyles()}</style>
</head>
<body>
    <!-- Floating Title Bar -->
    <div class="title-bar">
        <div class="title-bar-left">
            <span class="plan-title">${this.escapeHtml(data.metadata?.title || 'Plan')}</span>
            <span class="plan-session">${this.escapeHtml(data.metadata?.session || this._sessionId)}</span>
        </div>
        <div class="title-bar-right">
            <span class="status-badge ${this.getStatusClass(sessionStatus)}">${this.escapeHtml(this.formatSessionStatus(sessionStatus) || 'Unknown')}</span>
            ${showButtons ? `
                <button class="action-btn secondary" data-command="addTaskToPlan" ${buttonsDisabled ? 'disabled title="Revision in progress..."' : ''} title="Add specific tasks to the plan">+ Task</button>
                <button class="action-btn secondary" data-command="revisePlan" ${buttonsDisabled ? 'disabled title="Revision in progress..."' : ''}>Revise</button>
                ${!isApprovedOrCompleted ? `<button class="action-btn primary" data-command="approvePlan" ${buttonsDisabled ? 'disabled title="Revision in progress..."' : ''}>Approve</button>` : ''}
                ${showCompleteButton ? `<button class="action-btn primary" data-command="completePlan" title="Mark session as complete">Complete</button>` : ''}
            ` : ''}
            <button class="action-btn secondary" data-command="refresh" title="Refresh">↻</button>
        </div>
    </div>

    <!-- Tab Bar -->
    <div class="tab-bar">
        <button class="tab-btn ${defaultTab === 'structured' ? 'active' : ''}" data-tab="structured">Structured</button>
        <button class="tab-btn ${defaultTab === 'markdown' ? 'active' : ''}" data-tab="markdown">Markdown</button>
    </div>

    <!-- Content Area -->
    <div class="content-area">
        <!-- Structured Tab -->
        <div class="tab-content ${defaultTab === 'structured' ? 'active' : ''}" id="tab-structured">
            ${this.renderStructuredView(data)}
        </div>

        <!-- Markdown Tab -->
        <div class="tab-content ${defaultTab === 'markdown' ? 'active' : ''}" id="tab-markdown">
            ${this.renderMarkdownView(data)}
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        function sendCommand(cmd) {
            vscode.postMessage({ command: cmd });
        }

        // Action buttons (Revise, Approve, Refresh)
        document.querySelectorAll('[data-command]').forEach(btn => {
            btn.addEventListener('click', () => {
                sendCommand(btn.dataset.command);
            });
        });

        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabId = btn.dataset.tab;
                
                // Update tab buttons
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                // Update tab content
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                document.getElementById('tab-' + tabId).classList.add('active');
            });
        });
    </script>
</body>
</html>`;
    }

    private renderStructuredView(data: ParsedPlanData): string {
        let html = '';

        // Show warning banner if parsing had issues
        if (data.parseWarnings.length > 0 && data.parseSuccess) {
            html += `
                <div class="banner warning">
                    <span class="banner-icon">⚠️</span>
                    <span class="banner-text">Some content could not be parsed: ${data.parseWarnings.join(', ')}</span>
                </div>
            `;
        }

        if (!data.parseSuccess) {
            html += `
                <div class="banner error">
                    <span class="banner-icon">❌</span>
                    <span class="banner-text">Failed to parse plan structure. Viewing raw markdown instead.</span>
                </div>
            `;
            return html + this.renderMarkdownView(data);
        }

        // Metadata card
        if (data.metadata) {
            html += `
                <div class="card">
                    <div class="card-header">
                        <span class="card-title">
                            <span class="card-title-icon">📋</span>
                            Plan Information
                        </span>
                    </div>
                    <div class="card-content">
                        <div class="metadata-grid">
                            <div class="metadata-item">
                                <span class="metadata-label">Session</span>
                                <span class="metadata-value">${this.escapeHtml(data.metadata.session)}</span>
                            </div>
                            <div class="metadata-item">
                                <span class="metadata-label">Created</span>
                                <span class="metadata-value">${this.escapeHtml(data.metadata.created)}</span>
                            </div>
                            <div class="metadata-item">
                                <span class="metadata-label">Updated</span>
                                <span class="metadata-value">${this.escapeHtml(data.metadata.updated)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        // Sections
        for (const section of data.sections) {
            html += this.renderSection(section);
        }

        if (data.sections.length === 0 && data.metadata) {
            html += `
                <div class="empty-state">
                    <div class="empty-state-icon">📄</div>
                    <div class="empty-state-text">No sections found in the plan.</div>
                </div>
            `;
        }

        return html;
    }

    private renderSection(section: ParsedSection): string {
        const icon = this.getSectionIcon(section.title);
        const hasChildren = section.children && section.children.length > 0;
        const hasContent = section.content.trim().length > 0;
        const hasTasks = section.tasks && section.tasks.length > 0;
        
        // Count all tasks including in children
        const allTasks = this.collectAllTasks(section);
        const taskBadge = allTasks.length > 0 
            ? `<span class="card-badge">${allTasks.filter(t => t.completed).length}/${allTasks.length} tasks</span>` 
            : '';

        let html = `
            <div class="card">
                <div class="card-header">
                    <span class="card-title">
                        <span class="card-title-icon">${icon}</span>
                        ${this.escapeHtml(section.title)}
                    </span>
                    ${taskBadge}
                </div>
                <div class="card-content">
        `;

        // Render section's own content/tasks first
        if (hasTasks) {
            html += this.renderTaskList(section.tasks!);
        } else if (hasContent) {
            html += this.renderSectionContent(section.content);
        }

        // Render nested children (### under ##)
        if (hasChildren) {
            for (const child of section.children!) {
                const childIcon = this.getSectionIcon(child.title);
                const childHasTasks = child.tasks && child.tasks.length > 0;
                
                html += `
                    <div class="subsection">
                        <div class="subsection-header">
                            <span class="subsection-icon">${childIcon}</span>
                            <span class="subsection-title">${this.escapeHtml(child.title)}</span>
                            ${childHasTasks ? `<span class="card-badge">${child.tasks!.filter(t => t.completed).length}/${child.tasks!.length}</span>` : ''}
                        </div>
                        <div class="subsection-content">
                            ${childHasTasks ? this.renderTaskList(child.tasks!) : this.renderSectionContent(child.content)}
                        </div>
                    </div>
                `;
            }
        }

        // Show empty state if no content at all
        if (!hasContent && !hasTasks && !hasChildren) {
            html += '<div class="empty-state"><div class="empty-state-text">No content in this section.</div></div>';
        }

        html += `
                </div>
            </div>
        `;

        return html;
    }

    private collectAllTasks(section: ParsedSection): ParsedTask[] {
        const tasks: ParsedTask[] = [];
        if (section.tasks) {
            tasks.push(...section.tasks);
        }
        if (section.children) {
            for (const child of section.children) {
                if (child.tasks) {
                    tasks.push(...child.tasks);
                }
            }
        }
        return tasks;
    }

    private renderTaskList(tasks: ParsedTask[]): string {
        if (tasks.length === 0) {
            return '<div class="empty-state"><div class="empty-state-text">No tasks in this section.</div></div>';
        }

        let html = '<div class="task-list">';
        for (const task of tasks) {
            const checkIcon = task.completed 
                ? '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 111.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>'
                : '';

            html += `
                <div class="task-item ${task.completed ? 'completed' : ''}">
                    <div class="task-checkbox ${task.completed ? 'checked' : ''}">
                        ${checkIcon}
                    </div>
                    <div class="task-body">
                        <div>
                            <span class="task-id">${this.escapeHtml(task.id)}</span>
                            <span class="task-description">${this.escapeHtml(task.description)}</span>
                        </div>
                        <div class="task-meta">
                            <span class="task-meta-item">
                                <span class="task-meta-label">Deps:</span>
                                ${task.dependencies.length > 0 ? task.dependencies.map(d => this.escapeHtml(d)).join(', ') : 'None'}
                            </span>
                            <span class="task-meta-item">
                                <span class="task-meta-label">Engineer:</span>
                                ${this.escapeHtml(task.engineer)}
                            </span>
                            ${task.unity && task.unity !== 'none' ? `
                            <span class="task-meta-item unity-${task.unity.replace('-', '')}">
                                <span class="task-meta-label">Unity:</span>
                                ${this.escapeHtml(task.unity)}
                            </span>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `;
        }
        html += '</div>';
        return html;
    }

    private renderSectionContent(content: string): string {
        if (!content.trim()) {
            return '<div class="empty-state"><div class="empty-state-text">No content in this section.</div></div>';
        }

        // Simple markdown-like rendering
        let html = content
            // Convert bullet lists
            .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
            // Convert numbered lists
            .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
            // Convert inline code
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            // Convert bold
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            // Convert line breaks to paragraphs
            .split(/\n\n+/)
            .map(p => {
                p = p.trim();
                if (p.startsWith('<li>')) {
                    return '<ul>' + p + '</ul>';
                }
                if (p) {
                    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
                }
                return '';
            })
            .join('');

        return `<div class="section-content">${html}</div>`;
    }

    private renderMarkdownView(data: ParsedPlanData): string {
        if (!data.rawContent) {
            return `
                <div class="error-state">
                    <div class="error-state-icon">❌</div>
                    <div class="error-state-text">Could not load plan file.</div>
                    <button class="action-btn secondary" data-command="openRawFile">Open Raw File</button>
                </div>
            `;
        }

        return `<pre class="markdown-view">${this.escapeHtml(data.rawContent)}</pre>`;
    }

    private getStatusClass(status: string): string {
        const s = status.toLowerCase();
        if (s.includes('planning')) return 'planning';
        if (s.includes('review')) return 'reviewing';
        if (s.includes('revis')) return 'revising';
        if (s.includes('approved')) return 'approved';
        if (s.includes('execut')) return 'executing';
        if (s.includes('complet')) return 'completed';
        if (s.includes('fail')) return 'failed';
        return '';
    }

    /**
     * Format session status for display (authoritative status from daemon)
     */
    private formatSessionStatus(status: string): string {
        if (!status) return '';
        const s = status.toLowerCase();
        switch (s) {
            case 'planning': return '🔄 Planning';
            case 'debating': return '💭 Debating';
            case 'reviewing': return '📋 Ready for Review';
            case 'revising': return '✏️ Revising';
            case 'approved': return '✅ Approved';
            case 'executing': return '⚡ Executing';
            case 'completed': return '🎉 Completed';
            case 'failed': return '❌ Failed';
            case 'cancelled': return '🚫 Cancelled';
            default: return status.charAt(0).toUpperCase() + status.slice(1);
        }
    }

    private getSectionIcon(title: string): string {
        const t = title.toLowerCase();
        if (t.includes('overview') || t.includes('summary')) return '📝';
        if (t.includes('context')) return '🔍';
        if (t.includes('task') || t.includes('checklist')) return '✅';
        if (t.includes('phase')) return '📦';
        if (t.includes('depend')) return '🔗';
        if (t.includes('risk')) return '⚠️';
        if (t.includes('success') || t.includes('criteria')) return '🎯';
        if (t.includes('analyst') || t.includes('discussion')) return '💬';
        if (t.includes('consensus')) return '🤝';
        if (t.includes('deliverable')) return '📋';
        return '📄';
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
        PlanViewerPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}

