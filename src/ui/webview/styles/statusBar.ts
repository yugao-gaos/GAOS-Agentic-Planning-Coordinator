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
    animation: coordinator-pulse-subtle 2s infinite;
    box-shadow: 0 0 4px rgba(204, 167, 0, 0.4);
}

.coordinator-dot.evaluating {
    background: var(--vscode-charts-purple, #a855f7);
    animation: coordinator-pulse-active 1s infinite;
    box-shadow: 0 0 6px rgba(168, 85, 247, 0.6);
}

.coordinator-dot.cooldown {
    background: var(--vscode-charts-orange, #f97316);
    animation: coordinator-pulse-slow 3s infinite;
    box-shadow: 0 0 4px rgba(249, 115, 22, 0.4);
}

.coordinator-text {
    font-weight: 500;
    font-size: 12px;
}

/* Coordinator pulse animations */
@keyframes coordinator-pulse-subtle {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 4px rgba(204, 167, 0, 0.4);
    }
    50% {
        opacity: 0.7;
        transform: scale(1.1);
        box-shadow: 0 0 8px rgba(204, 167, 0, 0.6);
    }
}

@keyframes coordinator-pulse-active {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 6px rgba(168, 85, 247, 0.6);
    }
    50% {
        opacity: 0.8;
        transform: scale(1.15);
        box-shadow: 0 0 12px rgba(168, 85, 247, 0.8);
    }
}

@keyframes coordinator-pulse-slow {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 4px rgba(249, 115, 22, 0.4);
    }
    50% {
        opacity: 0.8;
        transform: scale(1.05);
        box-shadow: 0 0 6px rgba(249, 115, 22, 0.5);
    }
}

.actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
}

/* Status bar wrapper for health warning and Unity compact box */
.status-bar-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0;
}

/* Unity Compact Box */
.unity-compact-box {
    padding: 6px 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-top: none;
    border-radius: 0 0 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
}

.unity-compact-status {
    display: flex;
    align-items: center;
    gap: 8px;
}

.unity-compact-badge {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 500;
    color: var(--vscode-badge-foreground);
}

.unity-compact-queue {
    font-weight: 500;
    color: var(--vscode-foreground);
}

.unity-compact-task {
    display: flex;
    align-items: center;
}

.unity-compact-current {
    color: var(--vscode-charts-blue, #3b82f6);
    font-weight: 600;
    font-size: 11px;
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

