/**
 * Unity control section styles.
 */
export const unityStyles = `
/* Unity Status Section */
.unity-content {
    padding: 10px;
}

.unity-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    padding: 4px 0;
}

.unity-row:first-child {
    padding-top: 0;
}

.unity-row:last-child {
    padding-bottom: 0;
}

.unity-label {
    color: var(--vscode-descriptionForeground);
}

.unity-value {
    font-weight: 500;
}

.unity-value.current-task {
    color: var(--vscode-charts-blue, #3b82f6);
    font-weight: 600;
}

.unity-value.error { color: #f14c4c; }
.unity-value.warning { color: #cca700; }
.unity-value.success { color: #73c991; }
.unity-value.info { color: #007acc; }

/* Unity badge animations */
.unity-badge.compiling {
    animation: unity-pulse-compiling 2s infinite;
}

.unity-badge.testing {
    animation: unity-pulse-testing 1.5s infinite;
}

.unity-badge.executing {
    animation: unity-pulse-executing 1.5s infinite;
}

.unity-badge.playing {
    animation: unity-pulse-playing 2s infinite;
}

@keyframes unity-pulse-compiling {
    0%, 100% {
        opacity: 1;
        box-shadow: 0 0 4px rgba(0, 122, 204, 0.4);
    }
    50% {
        opacity: 0.8;
        box-shadow: 0 0 8px rgba(0, 122, 204, 0.6);
    }
}

@keyframes unity-pulse-testing {
    0%, 100% {
        opacity: 1;
        box-shadow: 0 0 4px rgba(234, 179, 8, 0.4);
    }
    50% {
        opacity: 0.8;
        box-shadow: 0 0 8px rgba(234, 179, 8, 0.6);
    }
}

@keyframes unity-pulse-executing {
    0%, 100% {
        opacity: 1;
        box-shadow: 0 0 4px rgba(115, 201, 145, 0.4);
    }
    50% {
        opacity: 0.8;
        box-shadow: 0 0 8px rgba(115, 201, 145, 0.6);
    }
}

@keyframes unity-pulse-playing {
    0%, 100% {
        opacity: 1;
        box-shadow: 0 0 4px rgba(115, 201, 145, 0.4);
    }
    50% {
        opacity: 0.8;
        box-shadow: 0 0 8px rgba(115, 201, 145, 0.6);
    }
}
`;

