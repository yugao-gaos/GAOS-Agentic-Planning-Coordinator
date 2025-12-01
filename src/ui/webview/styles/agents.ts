/**
 * Agent grid and agent card styles.
 */
export const agentStyles = `
/* Agent Grid - responsive columns */
.agent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 6px;
}

@media (min-width: 500px) {
    .agent-grid {
        grid-template-columns: repeat(4, 1fr);
    }
}

/* Agent Card */
.agent-card {
    display: flex;
    flex-direction: column;
    padding: 8px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
    gap: 4px;
    cursor: default;
    transition: border-color 0.15s, box-shadow 0.15s;
    min-width: 0;
    position: relative;
    overflow: hidden;
}

.agent-card:hover {
    border-color: var(--vscode-focusBorder);
}

.agent-card.available {
    border-top: 2px solid #73c991;
}

.agent-card.busy {
    border-top: 2px solid var(--role-color, #f97316);
}

/* Working agent animation - subtle glow pulse */
.agent-card.busy::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(135deg, var(--role-color, #f97316) 0%, transparent 60%);
    opacity: 0;
    animation: workingGlow 2s ease-in-out infinite;
    pointer-events: none;
}

/* Working agent border animation */
.agent-card.busy {
    animation: borderPulse 2s ease-in-out infinite;
}

/* Spinning indicator for busy agents */
.agent-card.busy::after {
    content: '';
    position: absolute;
    top: 6px;
    right: 6px;
    width: 12px;
    height: 12px;
    border: 2px solid transparent;
    border-top-color: var(--role-color, #f97316);
    border-radius: 50%;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.agent-header {
    display: flex;
    align-items: center;
    gap: 6px;
}

.agent-icon {
    width: 20px;
    height: 20px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 10px;
    flex-shrink: 0;
}

.agent-card.available .agent-icon {
    background: rgba(115, 201, 145, 0.2);
    color: #73c991;
}

.agent-card.busy .agent-icon {
    background: var(--role-color-bg, rgba(249, 115, 22, 0.2));
    color: var(--role-color, #f97316);
}

.agent-name {
    font-weight: 500;
    font-size: 11px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.agent-status-line {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.agent-status-line.available {
    color: #73c991;
}

.agent-task-line {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.8;
}

.agent-stop-btn {
    margin-top: 4px;
    padding: 3px 6px;
    border: 1px solid rgba(241, 76, 76, 0.3);
    border-radius: 3px;
    background: transparent;
    color: #f14c4c;
    font-size: 9px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
}

.agent-stop-btn:hover {
    background: rgba(241, 76, 76, 0.2);
}

.agent-stop-btn svg {
    width: 10px;
    height: 10px;
    fill: currentColor;
}
`;

