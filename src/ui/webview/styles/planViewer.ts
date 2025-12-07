/**
 * Styles for the Plan Viewer Panel.
 * Includes floating title bar, tabs, structured cards, and task checklists.
 */

export function getPlanViewerStyles(): string {
    return `
        :root {
            --bg-color: var(--vscode-editor-background);
            --fg-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --input-bg: var(--vscode-input-background);
            --button-bg: var(--vscode-button-background);
            --button-fg: var(--vscode-button-foreground);
            --button-hover: var(--vscode-button-hoverBackground);
            --header-bg: var(--vscode-sideBarSectionHeader-background);
            --tab-active: var(--vscode-tab-activeBackground);
            --tab-inactive: var(--vscode-tab-inactiveBackground);
            --success-color: #10b981;
            --warning-color: #f59e0b;
            --error-color: #ef4444;
            --info-color: #3b82f6;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg-color);
            background: var(--bg-color);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        /* ========================================
           Floating Title Bar (Always Visible)
           ======================================== */
        .title-bar {
            position: sticky;
            top: 0;
            z-index: 100;
            background: var(--header-bg);
            border-bottom: 1px solid var(--border-color);
            padding: 12px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
        }
        
        .title-bar-left {
            display: flex;
            align-items: center;
            gap: 12px;
            min-width: 0;
            flex: 1;
        }
        
        .plan-title {
            font-size: 1.1em;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .plan-session {
            font-size: 0.85em;
            opacity: 0.6;
            white-space: nowrap;
        }
        
        .title-bar-right {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }
        
        .status-badge {
            font-size: 0.8em;
            padding: 4px 10px;
            border-radius: 12px;
            font-weight: 500;
            white-space: nowrap;
        }
        
        .status-badge.planning { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
        .status-badge.reviewing { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
        .status-badge.revising { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
        .status-badge.approved { background: rgba(16, 185, 129, 0.2); color: #34d399; }
        .status-badge.executing { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
        .status-badge.completed { background: rgba(16, 185, 129, 0.2); color: #34d399; }
        .status-badge.failed { background: rgba(239, 68, 68, 0.2); color: #f87171; }
        
        .action-btn {
            padding: 6px 14px;
            border-radius: 4px;
            font-size: 0.9em;
            cursor: pointer;
            border: none;
            font-family: inherit;
            transition: opacity 0.15s;
        }
        
        .action-btn:hover { opacity: 0.9; }
        .action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        
        .action-btn.primary {
            background: var(--button-bg);
            color: var(--button-fg);
        }
        
        .action-btn.secondary {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--fg-color);
        }
        
        /* ========================================
           Tab Navigation
           ======================================== */
        .tab-bar {
            position: sticky;
            top: 0;
            z-index: 99;
            background: var(--bg-color);
            border-bottom: 1px solid var(--border-color);
            display: flex;
            gap: 0;
            padding: 0 16px;
            flex-shrink: 0;
        }
        
        .tab-btn {
            padding: 10px 20px;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--fg-color);
            cursor: pointer;
            font-size: 0.9em;
            font-family: inherit;
            opacity: 0.6;
            transition: all 0.15s;
        }
        
        .tab-btn:hover {
            opacity: 0.9;
            background: var(--input-bg);
        }
        
        .tab-btn.active {
            opacity: 1;
            border-bottom-color: var(--button-bg);
            background: var(--tab-active);
        }
        
        /* ========================================
           Content Area
           ======================================== */
        .content-area {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        /* ========================================
           Warning/Info Banners
           ======================================== */
        .banner {
            padding: 10px 14px;
            border-radius: 6px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 0.9em;
        }
        
        .banner.warning {
            background: rgba(251, 191, 36, 0.15);
            border: 1px solid rgba(251, 191, 36, 0.3);
            color: #fbbf24;
        }
        
        .banner.error {
            background: rgba(239, 68, 68, 0.15);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: #f87171;
        }
        
        .banner.info {
            background: rgba(59, 130, 246, 0.15);
            border: 1px solid rgba(59, 130, 246, 0.3);
            color: #60a5fa;
        }
        
        .banner-icon { font-size: 1.1em; }
        .banner-text { flex: 1; }
        
        /* ========================================
           Structured View - Cards
           ======================================== */
        .card {
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            margin-bottom: 16px;
            overflow: hidden;
        }
        
        .card-header {
            background: var(--header-bg);
            padding: 10px 14px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .card-title {
            font-weight: 600;
            font-size: 0.95em;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .card-title-icon {
            opacity: 0.7;
        }
        
        .card-badge {
            font-size: 0.75em;
            padding: 2px 8px;
            border-radius: 10px;
            background: var(--border-color);
        }
        
        .card-content {
            padding: 14px;
        }
        
        /* ========================================
           Subsections (### nested under ##)
           ======================================== */
        .subsection {
            margin-top: 16px;
            padding-top: 16px;
            border-top: 1px solid var(--border-color);
        }
        
        .subsection:first-child {
            margin-top: 0;
            padding-top: 0;
            border-top: none;
        }
        
        .subsection-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 10px;
        }
        
        .subsection-icon {
            opacity: 0.7;
            font-size: 0.9em;
        }
        
        .subsection-title {
            font-weight: 600;
            font-size: 0.9em;
            color: var(--fg-color);
        }
        
        .subsection-content {
            padding-left: 4px;
        }
        
        /* ========================================
           Metadata Grid
           ======================================== */
        .metadata-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 12px;
        }
        
        .metadata-item {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        
        .metadata-label {
            font-size: 0.8em;
            opacity: 0.6;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .metadata-value {
            font-size: 0.95em;
        }
        
        /* ========================================
           Section Content (Markdown-like)
           ======================================== */
        .section-content {
            line-height: 1.6;
        }
        
        .section-content p {
            margin-bottom: 12px;
        }
        
        .section-content ul, .section-content ol {
            margin-left: 20px;
            margin-bottom: 12px;
        }
        
        .section-content li {
            margin-bottom: 4px;
        }
        
        .section-content code {
            background: var(--bg-color);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
        }
        
        /* ========================================
           Task Checklist
           ======================================== */
        .task-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .task-item {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 10px 12px;
            background: var(--bg-color);
            border-radius: 6px;
            border: 1px solid transparent;
            transition: border-color 0.15s;
        }
        
        .task-item:hover {
            border-color: var(--border-color);
        }
        
        .task-item.completed {
            opacity: 0.6;
        }
        
        .task-checkbox {
            width: 18px;
            height: 18px;
            border: 2px solid var(--border-color);
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            margin-top: 2px;
        }
        
        .task-checkbox.checked {
            background: var(--success-color);
            border-color: var(--success-color);
            color: #fff;
        }
        
        .task-checkbox svg {
            width: 12px;
            height: 12px;
        }
        
        .task-body {
            flex: 1;
            min-width: 0;
        }
        
        .task-id {
            font-weight: 600;
            color: var(--info-color);
            margin-right: 6px;
        }
        
        .task-description {
            word-wrap: break-word;
        }
        
        .task-meta {
            display: flex;
            gap: 16px;
            margin-top: 6px;
            font-size: 0.85em;
            opacity: 0.7;
        }
        
        .task-meta-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .task-meta-label {
            opacity: 0.7;
        }
        
        /* ========================================
           Markdown View
           ======================================== */
        .markdown-view {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
            line-height: 1.7;
            white-space: pre-wrap;
            word-wrap: break-word;
            background: var(--input-bg);
            padding: 16px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
        }
        
        /* ========================================
           Empty/Error States
           ======================================== */
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            opacity: 0.6;
        }
        
        .empty-state-icon {
            font-size: 2em;
            margin-bottom: 12px;
        }
        
        .empty-state-text {
            font-size: 0.95em;
        }
        
        .error-state {
            text-align: center;
            padding: 40px 20px;
        }
        
        .error-state-icon {
            font-size: 2em;
            margin-bottom: 12px;
            color: var(--error-color);
        }
        
        .error-state-text {
            margin-bottom: 16px;
        }
        
        /* ========================================
           Scrollbar Styling
           ======================================== */
        .content-area::-webkit-scrollbar {
            width: 8px;
        }
        
        .content-area::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
        }
        
        .content-area::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }
    `;
}

