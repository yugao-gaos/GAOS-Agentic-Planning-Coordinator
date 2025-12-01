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

.unity-value.error { color: #f14c4c; }
.unity-value.warning { color: #cca700; }
.unity-value.success { color: #73c991; }
.unity-value.info { color: #007acc; }
`;

