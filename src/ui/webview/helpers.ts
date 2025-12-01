/**
 * Helper functions for webview rendering.
 */

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(text: string): string {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Format elapsed time from ISO date string.
 */
export function formatElapsedTime(startedAt: string): string {
    if (!startedAt) return '';
    const start = new Date(startedAt).getTime();
    const now = Date.now();
    const elapsed = Math.floor((now - start) / 1000);
    
    if (elapsed < 60) {
        return `${elapsed}s`;
    } else if (elapsed < 3600) {
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        return `${mins}m ${secs}s`;
    } else {
        const hours = Math.floor(elapsed / 3600);
        const mins = Math.floor((elapsed % 3600) / 60);
        return `${hours}h ${mins}m`;
    }
}

/**
 * Truncate text to a maximum length with ellipsis.
 */
export function truncate(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

/**
 * Convert hex color to RGB values string for rgba() usage.
 */
export function hexToRgb(hex: string): string {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result 
        ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
        : '249, 115, 22'; // Default orange
}

