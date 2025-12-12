// ============================================================================
// WorkflowSettingsManager - Shared workflow settings utilities
// ============================================================================
//
// This module provides workflow settings loading/saving without VS Code dependencies.
// Used by both the UI (WorkflowSettingsPanel) and services (CoordinatorAgent).

import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';

const log = Logger.create('Daemon', 'WorkflowSettingsManager');
import { 
    WorkflowType,
    WorkflowUserSettings,
    DEFAULT_WORKFLOW_USER_SETTINGS
} from '../types/workflow';
import { WorkflowMetadata } from './workflows/IWorkflow';
import { getFolderStructureManager } from './FolderStructureManager';

// ============================================================================
// Default Workflow Metadata (Single Source of Truth)
// ============================================================================

/**
 * Default workflow metadata including descriptions and coordinator prompts.
 * This is THE source of truth for built-in workflow configurations.
 * 
 * Used by:
 * - WorkflowRegistry (for registering workflows with prompts)
 * - WorkflowSettingsPanel (for displaying defaults and detecting overrides)
 * - CoordinatorAgent (for building prompts with user overrides)
 */
export const DEFAULT_WORKFLOW_METADATA: Record<WorkflowType, WorkflowMetadata> = {
    planning_new: {
        type: 'planning_new',
        name: 'New Planning',
        requiresUnity: false,
        requiresCompleteDependencies: false, // Planning can start independently
        coordinatorPrompt: `- 'planning_new' - Create a new execution plan from scratch
   Use when: Starting a new feature, major refactoring, or first-time setup`
    },
    planning_revision: {
        type: 'planning_revision',
        name: 'Plan Revision',
        requiresUnity: false,
        requiresCompleteDependencies: false, // Revision can start independently
        coordinatorPrompt: `- 'planning_revision' - Revise an existing plan based on feedback
   Use when: User requests changes to the plan, or plan needs adjustment after errors`
    },
    task_implementation: {
        type: 'task_implementation',
        name: 'Task Implementation',
        requiresUnity: false,
        requiresCompleteDependencies: true, // Implementation MUST wait for dependencies
        coordinatorPrompt: `- 'task_implementation' - Implement a task from the plan
   Use when: Task dependencies are complete and agent is available
   Input: taskId, taskDescription, dependencies, planPath
   Note: This workflow requires all task dependencies to be COMPLETED before it can start`
    },
    error_resolution: {
        type: 'error_resolution',
        name: 'Error Resolution',
        requiresUnity: false,
        requiresCompleteDependencies: false, // Error fixing can happen independently
        coordinatorPrompt: `- 'error_resolution' - Fix compilation or test errors (fire and forget)
   Use when: Unity errors occur or previous fix attempt failed
   Input: errors array, previousAttempts (for retries), previousFixSummary (what was tried)
   Note: Workflow fixes code, requests recompile, then completes. Coordinator handles result.`
    },
    context_gathering: {
        type: 'context_gathering',
        name: 'Context Gathering',
        requiresUnity: false,
        requiresCompleteDependencies: false, // Context gathering is preparatory, doesn't need deps complete
        coordinatorPrompt: `- 'context_gathering' - Gather and analyze context from folders/files
   Use when: Task has needsContext=true and contextWorkflowStatus !== 'succeeded'
   Input: targets (folders/files), focusAreas (optional), depth ('shallow'|'deep'), taskId (required)
   Output: Context summary written to _AiDevLog/Context/
   
   **IMPORTANT**: Run this workflow BEFORE task_implementation for tasks with needsContext=true.
   Check contextWorkflowStatus field - if 'none', run context_gathering first.`
    },
    implementation_review: {
        type: 'implementation_review',
        name: 'Implementation Review',
        requiresUnity: false,
        requiresCompleteDependencies: false, // Review is manually triggered, no deps needed
        coordinatorPrompt: `- 'implementation_review' - Review completed task implementations (MANUAL ONLY)
   Note: This workflow is triggered MANUALLY by user from Dependency Map UI.
   Do NOT dispatch this workflow automatically - it requires user interaction.`
    }
};

/**
 * Helper descriptions for each workflow (shown in UI)
 */
export const WORKFLOW_DESCRIPTIONS: Record<WorkflowType, string> = {
    planning_new: 'Creates a new execution plan through iterative refinement. Runs Planner → Analysts → Review cycles until the plan is approved.',
    planning_revision: 'Quickly revises an existing plan based on user feedback or discovered issues. Lighter weight than full planning.',
    task_implementation: 'Implements a single task from the plan. Runs Engineer → Code Review → Approval → Delta Context → Unity Pipeline.',
    error_resolution: 'Fixes compilation or test errors. Single AI session analyzes and fixes, then requests recompile (fire and forget). Coordinator handles retry with context.',
    context_gathering: 'Gathers and analyzes project context from folders/files. Supports different presets for code, Unity assets, and custom patterns.',
    implementation_review: 'Reviews completed task implementations using 3 analysts. Manually triggered from Dependency Map UI after tasks complete.'
};

// ============================================================================
// Settings File Management
// ============================================================================

const WORKFLOW_SETTINGS_FILENAME = 'workflow_settings.json';

/**
 * Get path to workflow settings config file
 * Uses FolderStructureManager for customizable path
 */
export function getWorkflowSettingsPath(workspaceRoot: string): string {
    const folderStructure = getFolderStructureManager();
    return path.join(folderStructure.getFolderPath('config'), WORKFLOW_SETTINGS_FILENAME);
}

/**
 * Load workflow settings from config file
 */
export function loadWorkflowSettings(workspaceRoot: string): WorkflowUserSettings {
    const configPath = getWorkflowSettingsPath(workspaceRoot);
    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf8');
            return { ...DEFAULT_WORKFLOW_USER_SETTINGS, ...JSON.parse(content) };
        }
    } catch (e) {
        log.error('Failed to load config:', e);
    }
    return { ...DEFAULT_WORKFLOW_USER_SETTINGS };
}

/**
 * Save workflow settings to config file
 */
export function saveWorkflowSettings(workspaceRoot: string, settings: WorkflowUserSettings): boolean {
    const configPath = getWorkflowSettingsPath(workspaceRoot);
    try {
        const configDir = path.dirname(configPath);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
        return true;
    } catch (e) {
        log.error('Failed to save config:', e);
        return false;
    }
}

// ============================================================================
// Prompt Resolution
// ============================================================================

/**
 * Get effective coordinator prompt for a single workflow
 * Returns user override if set, otherwise default
 */
export function getEffectiveCoordinatorPrompt(
    workspaceRoot: string, 
    type: WorkflowType
): string {
    const settings = loadWorkflowSettings(workspaceRoot);
    return settings.coordinatorPrompts[type] || DEFAULT_WORKFLOW_METADATA[type].coordinatorPrompt;
}

/**
 * Load effective coordinator prompts for ALL workflows.
 * Returns user overrides where set, defaults otherwise.
 * 
 * Used by CoordinatorAgent to build its prompt.
 */
export function getEffectiveCoordinatorPrompts(workspaceRoot: string): Record<WorkflowType, string> {
    const settings = loadWorkflowSettings(workspaceRoot);
    const result: Record<string, string> = {};
    
    for (const type of Object.keys(DEFAULT_WORKFLOW_METADATA) as WorkflowType[]) {
        result[type] = settings.coordinatorPrompts[type] || DEFAULT_WORKFLOW_METADATA[type].coordinatorPrompt;
    }
    
    return result as Record<WorkflowType, string>;
}

/**
 * Check if a workflow has a custom (non-default) coordinator prompt
 */
export function hasCustomCoordinatorPrompt(workspaceRoot: string, type: WorkflowType): boolean {
    const settings = loadWorkflowSettings(workspaceRoot);
    return !!settings.coordinatorPrompts[type];
}

/**
 * Get the default coordinator prompt for a workflow (ignoring user overrides)
 */
export function getDefaultCoordinatorPrompt(type: WorkflowType): string {
    return DEFAULT_WORKFLOW_METADATA[type].coordinatorPrompt;
}

/**
 * Get all workflow types
 */
export function getAllWorkflowTypes(): WorkflowType[] {
    return Object.keys(DEFAULT_WORKFLOW_METADATA) as WorkflowType[];
}

