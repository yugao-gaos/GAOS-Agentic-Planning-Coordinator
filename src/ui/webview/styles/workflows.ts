/**
 * Workflow item styles.
 */
export const workflowStyles = `
/* Workflow items under coordinator */
.workflow-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px 5px 48px;
    font-size: 10px;
    border-left: 2px solid rgba(0, 122, 204, 0.3);
    margin-left: 32px;
}

.workflow-item.running {
    border-left-color: rgba(0, 122, 204, 0.6);
    background: rgba(0, 122, 204, 0.05);
}

.workflow-item.paused {
    border-left-color: rgba(249, 115, 22, 0.6);
}

.workflow-item.completed {
    border-left-color: rgba(115, 201, 145, 0.6);
}

.workflow-type-icon {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.workflow-type-icon svg {
    width: 12px;
    height: 12px;
    fill: currentColor;
    opacity: 0.8;
}

.workflow-type-icon.planning { color: #a855f7; }
.workflow-type-icon.task { color: #007acc; }
.workflow-type-icon.error { color: #f14c4c; }

.workflow-info {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.workflow-type-label {
    font-weight: 500;
    white-space: nowrap;
}

.workflow-phase {
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
}

.workflow-progress {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.workflow-progress-bar {
    width: 50px;
    height: 4px;
    background: var(--vscode-widget-border);
    border-radius: 2px;
    overflow: hidden;
}

.workflow-progress-fill {
    height: 100%;
    background: #007acc;
    transition: width 0.3s ease;
    border-radius: 2px;
}

.workflow-progress-fill.running {
    animation: progressPulse 1.5s ease-in-out infinite;
}

.workflow-percentage {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    min-width: 28px;
    text-align: right;
}

.workflow-time {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
    white-space: nowrap;
}

/* Agent badge in workflow item */
.workflow-agent {
    font-size: 9px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.05);
    white-space: nowrap;
    flex-shrink: 0;
}

/* Execution progress text in header */
.execution-progress-text {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(0, 122, 204, 0.15);
    margin-right: 4px;
}
`;

