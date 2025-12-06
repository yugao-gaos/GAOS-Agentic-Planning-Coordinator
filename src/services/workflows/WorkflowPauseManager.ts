// ============================================================================
// WorkflowPauseManager - Handles killing agents and saving state for resume
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentRunner } from '../AgentBackend';
import { ProcessManager } from '../ProcessManager';
import { StateManager } from '../StateManager';
import { ServiceLocator } from '../ServiceLocator';
import { Logger } from '../../utils/Logger';

const log = Logger.create('Daemon', 'PauseManager');

/**
 * Saved workflow state for resumption
 */
export interface SavedWorkflowState {
    workflowId: string;
    workflowType: string;
    sessionId: string;
    
    // Phase progress
    phaseIndex: number;
    phaseName: string;
    phaseProgress: 'not_started' | 'in_progress' | 'completed';
    
    // Task context
    taskId?: string;
    filesModified: string[];
    
    // Agent state (if agent was running)
    agentRunId?: string;
    agentPartialOutput?: string;
    
    // Continuation context
    continuationPrompt?: string;
    whatWasDone: string;
    whatRemains: string;
    
    // Metadata
    pausedAt: string;
    pauseReason: 'user_request' | 'conflict' | 'error' | 'timeout';
    conflictingWorkflowId?: string;
}

/**
 * Options for pausing a workflow
 */
export interface PauseOptions {
    reason: SavedWorkflowState['pauseReason'];
    conflictingWorkflowId?: string;
    /** Wait for current phase to complete before pausing (softer pause) */
    waitForPhase?: boolean;
    /** Force kill immediately (harder pause) */
    forceKill?: boolean;
}

/**
 * WorkflowPauseManager
 * 
 * Handles the messy reality of pausing AI agents:
 * - Agents can't truly pause - they must be killed
 * - We save state so the next agent can continue where we left off
 * - On resume, a new agent gets a "continuation prompt" with context
 * 
 * State is persisted via StateManager to:
 * - _AiDevLog/Plans/{sessionId}/paused_workflows/{workflowId}.json
 * 
 * This is a utility service used by BaseWorkflow.
 * 
 * Obtain via ServiceLocator:
 *   const pauseManager = ServiceLocator.resolve(WorkflowPauseManager);
 */
export class WorkflowPauseManager {
    private processManager: ProcessManager;
    private agentRunner: AgentRunner;
    private stateManager: StateManager | null = null;
    private savedStates: Map<string, SavedWorkflowState> = new Map();
    
    constructor() {
        this.processManager = ServiceLocator.resolve(ProcessManager);
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
    }
    
    /**
     * Set the StateManager for persistent storage
     * Should be called during extension activation
     */
    setStateManager(stateManager: StateManager): void {
        this.stateManager = stateManager;
    }
    
    /**
     * Pause a workflow by killing its agent and saving state
     * 
     * @returns The saved state for later resume
     */
    async pauseWorkflow(
        workflowId: string,
        currentState: {
            workflowType: string;
            sessionId: string;
            phaseIndex: number;
            phaseName: string;
            taskId?: string;
            filesModified: string[];
            agentRunId?: string;
        },
        options: PauseOptions
    ): Promise<SavedWorkflowState> {
        log.info(`Pausing workflow ${workflowId} (reason: ${options.reason})`);
        
        // Get agent partial output before killing
        let agentPartialOutput: string | undefined;
        
        if (currentState.agentRunId) {
            // Try to get what the agent has output so far
            agentPartialOutput = this.agentRunner.getPartialOutput(currentState.agentRunId);
            
            // Kill the agent process
            if (options.forceKill) {
                await this.agentRunner.stop(currentState.agentRunId);
                log.debug(`Killed agent ${currentState.agentRunId}`);
            }
        }
        
        // Build continuation context
        const { whatWasDone, whatRemains } = this.analyzeProgress(
            currentState.phaseName,
            agentPartialOutput
        );
        
        // Build continuation prompt for resume
        const continuationPrompt = this.buildContinuationPrompt(
            currentState.phaseName,
            whatWasDone,
            whatRemains,
            currentState.filesModified,
            agentPartialOutput
        );
        
        // Create saved state
        const savedState: SavedWorkflowState = {
            workflowId,
            workflowType: currentState.workflowType,
            sessionId: currentState.sessionId,
            phaseIndex: currentState.phaseIndex,
            phaseName: currentState.phaseName,
            phaseProgress: agentPartialOutput ? 'in_progress' : 'not_started',
            taskId: currentState.taskId,
            filesModified: currentState.filesModified,
            agentRunId: currentState.agentRunId,
            agentPartialOutput,
            continuationPrompt,
            whatWasDone,
            whatRemains,
            pausedAt: new Date().toISOString(),
            pauseReason: options.reason,
            conflictingWorkflowId: options.conflictingWorkflowId
        };
        
        // Store in memory and persist to disk
        this.savedStates.set(workflowId, savedState);
        await this.persistState(savedState);
        
        log.debug(`State saved for ${workflowId}`);
        return savedState;
    }
    
    /**
     * Get saved state for a workflow
     */
    getSavedState(workflowId: string): SavedWorkflowState | undefined {
        return this.savedStates.get(workflowId);
    }
    
    /**
     * Load saved state from disk
     */
    async loadSavedState(workflowId: string, sessionId: string, stateManager?: StateManager): Promise<SavedWorkflowState | undefined> {
        const sm = stateManager || this.stateManager;
        if (!sm) {
            log.error('No StateManager available');
            return undefined;
        }
        
        const data = sm.loadPausedWorkflow(sessionId, workflowId) as SavedWorkflowState | null;
        if (data) {
            this.savedStates.set(workflowId, data);
            return data;
        }
        
        return undefined;
    }
    
    /**
     * Load all saved states for a session
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
        
        return this.savedStates;
    }
    
    /**
     * Clear saved state after successful resume
     */
    clearSavedState(workflowId: string, sessionId: string, stateManager?: StateManager): void {
        this.savedStates.delete(workflowId);
        
        const sm = stateManager || this.stateManager;
        if (sm) {
            sm.deletePausedWorkflow(sessionId, workflowId);
        }
    }
    
    /**
     * Clear all saved states for a session
     */
    clearAllSavedStates(sessionId: string, stateManager?: StateManager): void {
        // Remove in-memory states for this session
        for (const [id, state] of this.savedStates) {
            if (state.sessionId === sessionId) {
                this.savedStates.delete(id);
            }
        }
        
        const sm = stateManager || this.stateManager;
        if (sm) {
            sm.deleteAllPausedWorkflows(sessionId);
        }
    }
    
    /**
     * Build a continuation prompt for the next agent
     */
    buildContinuationPrompt(
        phaseName: string,
        whatWasDone: string,
        whatRemains: string,
        filesModified: string[],
        partialOutput?: string
    ): string {
        const lines: string[] = [
            '## ⚠️ SESSION CONTINUATION',
            '',
            'This task was paused mid-execution. You are continuing from where the previous agent left off.',
            '',
            `### Phase: ${phaseName}`,
            '',
            '### What Was Done',
            whatWasDone || 'Unknown - check files modified',
            '',
            '### Files Modified So Far',
            filesModified.length > 0 
                ? filesModified.map(f => `- ${f}`).join('\n')
                : '- None yet',
            '',
            '### What Remains',
            whatRemains || 'Complete the current phase',
            ''
        ];
        
        if (partialOutput) {
            lines.push(
                '### Previous Agent Output (Partial)',
                '```',
                partialOutput.substring(partialOutput.length - 2000), // Last 2000 chars
                '```',
                ''
            );
        }
        
        lines.push(
            '### Instructions',
            '1. Review what was already done (check the files)',
            '2. Continue from where it left off',
            '3. Do NOT redo work that is already complete',
            ''
        );
        
        return lines.join('\n');
    }
    
    /**
     * Analyze partial output to understand progress
     */
    private analyzeProgress(phaseName: string, partialOutput?: string): {
        whatWasDone: string;
        whatRemains: string;
    } {
        if (!partialOutput) {
            return {
                whatWasDone: 'Phase had not started yet',
                whatRemains: `Complete the entire ${phaseName} phase`
            };
        }
        
        // Try to extract progress indicators from output
        const lines = partialOutput.split('\n');
        const progressIndicators: string[] = [];
        
        // Look for common progress patterns
        for (const line of lines) {
            if (line.includes('✓') || line.includes('✅') || line.includes('done') || line.includes('completed')) {
                progressIndicators.push(line.trim());
            }
            if (line.includes('Creating') || line.includes('Writing') || line.includes('Implementing')) {
                progressIndicators.push(line.trim());
            }
        }
        
        // Look for FILES_MODIFIED section
        const filesMatch = partialOutput.match(/FILES_MODIFIED:[\s\S]*?(?=```|$)/i);
        if (filesMatch) {
            progressIndicators.push('Files were modified (see FILES_MODIFIED section)');
        }
        
        return {
            whatWasDone: progressIndicators.length > 0 
                ? progressIndicators.slice(-5).join('\n') // Last 5 indicators
                : 'Some progress made (review partial output)',
            whatRemains: `Continue ${phaseName} phase from where it stopped`
        };
    }
    
    /**
     * Persist saved state to disk using StateManager
     */
    private async persistState(state: SavedWorkflowState): Promise<void> {
        if (!this.stateManager) {
            throw new Error(
                'Cannot persist paused workflow: StateManager not available. ' +
                'Paused workflows require StateManager for proper persistence. ' +
                'Please ensure the system is properly initialized.'
            );
        }
        
        // Use StateManager for proper persistence
        this.stateManager.savePausedWorkflow(
            state.sessionId,
            state.workflowId,
            state
        );
    }
    
    /**
     * Get count of paused workflows for a session
     */
    getPausedCount(sessionId: string): number {
        let count = 0;
        for (const state of this.savedStates.values()) {
            if (state.sessionId === sessionId) {
                count++;
            }
        }
        return count;
    }
    
    /**
     * Get all paused workflow IDs for a session
     */
    getPausedWorkflowIds(sessionId: string): string[] {
        const ids: string[] = [];
        for (const [id, state] of this.savedStates) {
            if (state.sessionId === sessionId) {
                ids.push(id);
            }
        }
        return ids;
    }
}

