/**
 * Unity control section component.
 */
import { UnityInfo, formatTaskTypeDetailed } from '../types';

/**
 * Render the Unity control section content.
 */
export function renderUnityContent(unity: UnityInfo): string {
    let statusRow = '';
    
    // Show current task if one is running
    if (unity.currentTask) {
        const taskType = formatTaskTypeDetailed(unity.currentTask.type);
        const phase = unity.currentTask.phase ? ` (${unity.currentTask.phase})` : '';
        statusRow = `
            <div class="unity-row">
                <span class="unity-label">Current</span>
                <span class="unity-value current-task">${taskType}${phase}</span>
            </div>
        `;
    }
    
    return `
        ${statusRow}
        <div class="unity-row">
            <span class="unity-label">Queue</span>
            <span class="unity-value${unity.queueLength > 0 ? ' warning' : ''}" id="unityQueue">
                ${unity.queueLength} task${unity.queueLength !== 1 ? 's' : ''}
            </span>
        </div>
    `;
}

/**
 * Get Unity status badge text and background color.
 */
export function getUnityBadgeInfo(unity: UnityInfo): { text: string; background: string; className?: string } {
    if (!unity.connected) {
        return {
            text: 'Not Running',
            background: 'rgba(107, 114, 128, 0.3)',
            className: 'disconnected'
        };
    }
    
    if (unity.hasErrors) {
        return {
            text: `${unity.errorCount} Error${unity.errorCount > 1 ? 's' : ''}`,
            background: 'rgba(241, 76, 76, 0.3)',
            className: 'error'
        };
    }
    
    if (unity.isCompiling) {
        return {
            text: 'Compiling',
            background: 'rgba(0, 122, 204, 0.3)',
            className: 'compiling'
        };
    }
    
    // Show current task with details
    if (unity.currentTask) {
        const taskName = formatTaskTypeDetailed(unity.currentTask.type);
        return {
            text: taskName,
            background: 'rgba(234, 179, 8, 0.3)',
            className: 'testing'
        };
    }
    
    if (unity.status === 'testing') {
        return {
            text: 'Testing',
            background: 'rgba(234, 179, 8, 0.3)',
            className: 'testing'
        };
    }
    
    // Show queued state when there are pipelines waiting
    if (unity.queueLength > 0) {
        return {
            text: `Queued (${unity.queueLength})`,
            background: 'rgba(168, 85, 247, 0.3)',
            className: 'running'
        };
    }
    
    if (unity.isPlaying) {
        return {
            text: 'Playing',
            background: 'rgba(115, 201, 145, 0.3)',
            className: 'playing'
        };
    }
    
    return {
        text: 'Idle',
        background: 'rgba(115, 201, 145, 0.3)',
        className: 'idle'
    };
}

