/**
 * constants.ts - Shared constants for the APC extension
 * 
 * Centralizes constants used across UI components to avoid duplication
 * and ensure consistency.
 */

// ============================================================================
// Supported AI Models
// ============================================================================

/**
 * Supported AI model configurations for dropdowns and selection UIs
 */
export interface ModelOption {
    value: string;
    label: string;
    description?: string;
}

export const SUPPORTED_MODELS: ModelOption[] = [
    { value: 'sonnet-4.5', label: 'Claude Sonnet 4.5', description: 'Balanced performance and speed' },
    { value: 'sonnet-4.5-thinking', label: 'Claude Sonnet 4.5 Thinking', description: 'Extended reasoning' },
    { value: 'opus-4.5', label: 'Claude Opus 4.5', description: 'Maximum capability' },
    { value: 'opus-4.5-thinking', label: 'Claude Opus 4.5 Thinking', description: 'Max capability + reasoning' },
    { value: 'opus-4.1', label: 'Claude Opus 4.1', description: 'Previous gen Opus' },
    { value: 'gemini-3-pro', label: 'Gemini 3 Pro', description: 'Google multimodal model' },
    { value: 'gpt-5', label: 'GPT-5', description: 'OpenAI latest' },
    { value: 'gpt-5.1', label: 'GPT-5.1', description: 'OpenAI enhanced' },
    { value: 'gpt-5-codex', label: 'GPT-5 Codex', description: 'OpenAI code specialist' },
    { value: 'gpt-5.1-codex-high', label: 'GPT-5.1 Codex High', description: 'OpenAI code specialist high' },
    { value: 'grok', label: 'Grok', description: 'xAI model' },
    { value: 'auto', label: 'Auto', description: 'Let Cursor choose' }
];

/**
 * Get model label by value
 */
export function getModelLabel(value: string): string {
    const model = SUPPORTED_MODELS.find(m => m.value === value);
    return model?.label || value;
}

// ============================================================================
// Role-to-Workflow Mapping
// ============================================================================

/**
 * Maps agent role IDs to the workflow types they can participate in.
 * Used to match agents to workflows in the UI.
 */
export const ROLE_WORKFLOW_MAP: Record<string, string[]> = {
    // Planning phase roles
    'context_gatherer': ['planning_new', 'task_implementation', 'context_gathering'],
    'planner': ['planning_new', 'planning_revision'],
    'analyst_implementation': ['planning_new', 'planning_revision'],
    'analyst_quality': ['planning_new'],
    'analyst_architecture': ['planning_new'],
    
    // Execution phase roles
    'engineer': ['task_implementation', 'error_resolution'],
    'code_reviewer': ['task_implementation']
    // Note: error_analyst removed - ErrorResolutionWorkflow uses engineer role
};

/**
 * Get workflow types for a role
 */
export function getWorkflowTypesForRole(roleId: string): string[] {
    return ROLE_WORKFLOW_MAP[roleId] || [];
}

/**
 * Check if a role can participate in a workflow type
 */
export function canRoleParticipateIn(roleId: string, workflowType: string): boolean {
    const workflows = ROLE_WORKFLOW_MAP[roleId];
    return workflows ? workflows.includes(workflowType) : false;
}

// ============================================================================
// Status Colors
// ============================================================================

/**
 * Status color mapping for consistent UI styling
 */
export const STATUS_COLORS: Record<string, string> = {
    // Session statuses
    'debating': '#007acc',      // Blue
    'reviewing': '#a855f7',     // Purple
    'revising': '#f97316',      // Orange
    'approved': '#73c991',      // Green
    'cancelled': '#6b7280',     // Gray
    'stopped': '#6b7280',       // Gray
    'executing': '#007acc',     // Blue
    'paused': '#f97316',        // Orange
    'completed': '#73c991',     // Green
    'failed': '#f14c4c',        // Red
    
    // Agent statuses
    'available': '#73c991',     // Green
    'busy': '#f97316',          // Orange (default, overridden by role color)
    'error': '#f14c4c',         // Red
    'idle': '#6b7280'           // Gray
};

// ============================================================================
// Workflow Type Labels
// ============================================================================

/**
 * Human-readable labels for workflow types
 */
export const WORKFLOW_TYPE_LABELS: Record<string, string> = {
    'planning_new': 'Planning',
    'planning_revision': 'Revision',
    'task_implementation': 'Task',
    'error_resolution': 'Error Fix',
    'context_gathering': 'Context'
};

/**
 * Get label for workflow type
 */
export function getWorkflowTypeLabel(type: string): string {
    return WORKFLOW_TYPE_LABELS[type] || type;
}

