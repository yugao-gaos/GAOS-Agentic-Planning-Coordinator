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
    gap: 12px;
}

.status-info, .coordinator-info {
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

/* Coordinator status dot */
.coordinator-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.coordinator-dot.idle {
    background: var(--vscode-descriptionForeground, #6b7280);
}

.coordinator-dot.queuing {
    background: var(--vscode-list-warningForeground, #cca700);
    animation: pulse 1.5s infinite;
}

.coordinator-dot.evaluating {
    background: var(--vscode-charts-blue, #3b82f6);
    animation: pulse 0.5s infinite;
}

.coordinator-dot.cooldown {
    background: var(--vscode-testing-iconPassed, #73c991);
}

.coordinator-text {
    font-weight: 500;
    font-size: 12px;
}

.actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
}

/* Status bar wrapper for health warning */
.status-bar-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0;
}

/* Health warning banner */
.health-warning {
    padding: 4px 12px;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid var(--vscode-testing-iconFailed, #f14c4c);
    border-top: none;
    border-radius: 0 0 6px 6px;
    color: var(--vscode-testing-iconFailed, #f14c4c);
    font-size: 11px;
    font-weight: 500;
    text-align: center;
    animation: fadeIn 0.3s ease-in;
}

@keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}
`;

