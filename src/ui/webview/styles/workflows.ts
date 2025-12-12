/**
 * Workflow item styles with animated progress background.
 */
export const workflowStyles = `
/* Workflow items with progress as background */
.workflow-item {
    position: relative;
    display: flex;
    align-items: stretch;
    padding: 0;
    padding-left: 56px;  /* Level 3 indentation */
    font-size: 10px;
    border-left: 2px solid rgba(0, 122, 204, 0.3);
    margin-left: 0;
    overflow: hidden;
    min-height: 28px;
}

/* Progress background layer */
.workflow-progress-bg {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--progress, 0%);
    background: linear-gradient(90deg, 
        rgba(0, 122, 204, 0.15) 0%, 
        rgba(0, 122, 204, 0.08) 100%);
    transition: width 0.5s ease;
    z-index: 0;
}

/* Content layer above progress */
.workflow-content {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px 6px 0;
    width: 100%;
}

/* Active workflow shine animation */
.workflow-item.active .workflow-progress-bg {
    background: linear-gradient(90deg, 
        rgba(0, 122, 204, 0.2) 0%, 
        rgba(0, 122, 204, 0.1) 100%);
}

.workflow-item.active .workflow-progress-bg::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(
        90deg,
        transparent 0%,
        rgba(255, 255, 255, 0.15) 50%,
        transparent 100%
    );
    animation: workflowShine 2s ease-in-out infinite;
}

@keyframes workflowShine {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(200%); }
}

/* Status-specific styles */
.workflow-item.running {
    border-left-color: rgba(0, 122, 204, 0.7);
}

.workflow-item.completed {
    border-left-color: rgba(115, 201, 145, 0.6);
}

.workflow-item.completed .workflow-progress-bg {
    background: linear-gradient(90deg, 
        rgba(115, 201, 145, 0.12) 0%, 
        rgba(115, 201, 145, 0.05) 100%);
}

/* Icon styles */
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

/* Info section */
.workflow-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex-shrink: 0;
}

.workflow-type-label {
    font-weight: 600;
    white-space: nowrap;
    font-size: 10px;
}

.workflow-phase {
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    font-size: 9px;
    opacity: 0.8;
}

/* Multiple agents container */
.workflow-agents {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-left: auto;
    justify-content: flex-end;
    max-width: 50%;
}

/* Agent badge with role color */
.workflow-agent {
    font-size: 9px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    white-space: nowrap;
}

/* Busy agents - colored with role color */
.workflow-agent.busy {
    background: color-mix(in srgb, var(--agent-color, #f97316) 15%, transparent);
    color: var(--agent-color, #f97316);
    border: 1px solid color-mix(in srgb, var(--agent-color, #f97316) 30%, transparent);
}

/* Benched agents - grey, subdued */
.workflow-agent.benched {
    background: rgba(128, 128, 128, 0.1);
    color: rgba(128, 128, 128, 0.8);
    border: 1px solid rgba(128, 128, 128, 0.25);
    opacity: 0.7;
}

.workflow-agent.benched::before {
    content: '⏸ ';
    opacity: 0.6;
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

/* Time display */
.workflow-time {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
    white-space: nowrap;
}

/* Workflow action buttons container */
.workflow-actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
    align-items: center;
}

/* Workflow control buttons (cancel) */
.workflow-action-btn {
    padding: 2px 8px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-foreground);
    font-size: 12px;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity 0.2s, background 0.2s, border-color 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    min-width: 20px;
}

.workflow-action-btn:hover {
    opacity: 1;
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
}

.workflow-action-btn.danger {
    color: #f14c4c;
    border-color: rgba(241, 76, 76, 0.3);
}

.workflow-action-btn.danger:hover {
    background: rgba(241, 76, 76, 0.15);
    border-color: rgba(241, 76, 76, 0.5);
}
`;
