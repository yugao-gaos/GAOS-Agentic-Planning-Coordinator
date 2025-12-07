/**
 * Combined styles export for sidebar webview.
 */
import { baseStyles } from './base';
import { statusBarStyles } from './statusBar';
import { sessionStyles } from './sessions';
import { workflowStyles } from './workflows';
import { agentStyles } from './agents';
import { unityStyles } from './unity';
import { getPlanViewerStyles } from './planViewer';

/**
 * Get all combined styles for the sidebar webview.
 */
export function getSidebarStyles(): string {
    return [
        baseStyles,
        statusBarStyles,
        sessionStyles,
        workflowStyles,
        agentStyles,
        unityStyles,
    ].join('\n');
}

// Re-export individual styles for selective use
export {
    baseStyles,
    statusBarStyles,
    sessionStyles,
    workflowStyles,
    agentStyles,
    unityStyles,
    getPlanViewerStyles,
};

