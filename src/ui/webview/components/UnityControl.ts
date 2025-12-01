/**
 * Unity control section component.
 */
import { UnityInfo } from '../types';

/**
 * Render the Unity control section content.
 */
export function renderUnityContent(unity: UnityInfo): string {
    return `
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
export function getUnityBadgeInfo(unity: UnityInfo): { text: string; background: string } {
    if (!unity.connected) {
        return {
            text: 'Not Running',
            background: 'rgba(107, 114, 128, 0.3)'
        };
    }
    
    if (unity.hasErrors) {
        return {
            text: `${unity.errorCount} Error${unity.errorCount > 1 ? 's' : ''}`,
            background: 'rgba(241, 76, 76, 0.3)'
        };
    }
    
    if (unity.isCompiling) {
        return {
            text: 'Compiling',
            background: 'rgba(0, 122, 204, 0.3)'
        };
    }
    
    if (unity.isPlaying) {
        return {
            text: 'Playing',
            background: 'rgba(115, 201, 145, 0.3)'
        };
    }
    
    return {
        text: 'Idle',
        background: 'rgba(115, 201, 145, 0.3)'
    };
}

