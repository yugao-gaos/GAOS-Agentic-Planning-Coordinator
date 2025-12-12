/**
 * Common styles shared across all settings panels (Role, System, Workflow).
 * This module extracts duplicated CSS to a single source of truth.
 */

export function getSettingsCommonStyles(): string {
    return `
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
        
        .sidebar-tab .tab-icon {
            margin-right: 8px;
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
        .badge.coordinator { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
        
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
        
        input[type="checkbox"] {
            width: auto;
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
    `;
}











