// ============================================================================
// WorkflowPauseManager - Workflow state persistence types and loading
// ============================================================================

import { StateManager } from '../StateManager';
import { Logger } from '../../utils/Logger';

const log = Logger.create('Daemon', 'PauseManager');

/**
 * Saved workflow state for resumption
 * 
 * This state is persisted to disk and can survive daemon restarts.
 * It contains everything needed to:
 * 1. Recreate the workflow object (workflowType, workflowInput, priority)
 * 2. Restore its execution position (phaseIndex, phaseProgress)
 * 3. Continue where it left off (continuationPrompt, whatWasDone, whatRemains)
 * 4. Restore agent allocations (allocatedAgents)
 * 
 * State is persisted by BaseWorkflow.persistState() to:
 * - _AiDevLog/Plans/{sessionId}/paused_workflows/{workflowId}.json
 */
export interface SavedWorkflowState {
    workflowId: string;
    workflowType: string;
    sessionId: string;
    
    // ========================================================================
    // Workflow Recreation (needed to recreate workflow object)
    // ========================================================================
    
    /** Original input parameters used to create the workflow */
    workflowInput: Record<string, any>;
    /** Workflow priority */
    priority: number;
    /** Agents allocated to this workflow (for restoring agent pool state) */
    allocatedAgents: string[];
    
    // ========================================================================
    // Phase Progress (state machine position)
    // ========================================================================
    
    phaseIndex: number;
    phaseName: string;
    phaseProgress: 'not_started' | 'in_progress' | 'completed';
    
    // ========================================================================
    // Task Context
    // ========================================================================
    
    taskId?: string;
    filesModified: string[];
    
    // ========================================================================
    // Agent State (if agent was running when paused)
    // ========================================================================
    
    agentRunId?: string;
    agentPartialOutput?: string;
    
    // ========================================================================
    // Continuation Context (for building continuation prompt)
    // ========================================================================
    
    continuationPrompt?: string;
    whatWasDone: string;
    whatRemains: string;
    
    // ========================================================================
    // Metadata
    // ========================================================================
    
    pausedAt: string;
    pauseReason: 'user_request' | 'conflict' | 'error' | 'timeout' | 'daemon_shutdown';
    conflictingWorkflowId?: string;
}

/**
 * WorkflowPauseManager
 * 
 * Handles loading of paused workflow states from disk for recovery.
 * 
 * Note: Persistence is now handled directly by BaseWorkflow.persistState().
 * This class primarily provides the interface/types and loading functionality.
 * 
 * Obtain via ServiceLocator:
 *   const pauseManager = ServiceLocator.resolve(WorkflowPauseManager);
 */
export class WorkflowPauseManager {
    private stateManager: StateManager | null = null;
    private savedStates: Map<string, SavedWorkflowState> = new Map();
    
    /**
     * Set the StateManager for loading persisted states
     * Should be called during daemon initialization
     */
    setStateManager(stateManager: StateManager): void {
        this.stateManager = stateManager;
    }
    
    /**
     * Load all saved states for a session from disk
     * Used during daemon startup to restore paused workflows
     */
    async loadAllSavedStates(sessionId: string, stateManager?: StateManager): Promise<Map<string, SavedWorkflowState>> {
        const sm = stateManager || this.stateManager;
        if (!sm) {
            log.error('No StateManager available');
            return new Map();
        }
        
        const states = sm.loadAllPausedWorkflows(sessionId);
        for (const [id, state] of states) {
            this.savedStates.set(id, state as SavedWorkflowState);
        }
        
        log.debug(`Loaded ${states.size} paused workflow state(s) for session ${sessionId}`);
        return this.savedStates;
    }
    
    /**
     * Get in-memory saved state (if previously loaded)
     */
    getSavedState(workflowId: string): SavedWorkflowState | undefined {
        return this.savedStates.get(workflowId);
    }
    
    /**
     * Clear in-memory state (called after workflow is restored or cleaned up)
     */
    clearMemoryState(workflowId: string): void {
        this.savedStates.delete(workflowId);
    }
}
