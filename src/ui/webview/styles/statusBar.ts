/**
 * Status bar component styles.
 */
export const statusBarStyles = `
/* Status Bar */
.status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
    flex-shrink: 0;
}

.status-info {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.status-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
}

.status-value {
    display: flex;
    align-items: center;
    gap: 6px;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.status-dot.ready {
    background: var(--vscode-testing-iconPassed, #73c991);
}

.status-dot.missing {
    background: var(--vscode-list-warningForeground, #cca700);
}

.status-dot.daemon_missing {
    background: var(--vscode-testing-iconFailed, #f14c4c);
    animation: pulse 2s infinite;
}

.status-dot.checking {
    background: var(--vscode-foreground);
    animation: pulse 1s infinite;
}

.status-text {
    font-weight: 500;
}

.actions {
    display: flex;
    gap: 4px;
}
`;

