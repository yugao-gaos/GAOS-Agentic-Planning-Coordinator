// ============================================================================
// ErrorResolutionWorkflow - Fix compilation/test errors (Fire and Forget)
// ============================================================================

import { BaseWorkflow } from './BaseWorkflow';
import { WorkflowServices } from './IWorkflow';
import { 
    WorkflowConfig, 
    ErrorResolutionInput 
} from '../../types/workflow';
import { AgentRole } from '../../types';
import { PipelineTaskContext } from '../../types/unity';

/**
 * Error resolution workflow - fixes compilation or test errors
 * 
 * Single phase: fix (analyze + fix in one AI session, fire and forget)
 * 
 * The workflow:
 * 1. Analyzes errors and applies fixes in a single AI session
 * 2. Requests Unity recompile (async, does not wait)
 * 3. Completes immediately
 * 
 * When Unity recompile finishes:
 * - If success: Coordinator resumes paused tasks
 * - If errors remain: Coordinator creates new error task with attempt context
 */
export class ErrorResolutionWorkflow extends BaseWorkflow {
    private static readonly PHASES = ['fix'];
    
    /** This workflow works with or without Unity */
    static readonly requiresUnity = false;
    
    // Error state from input
    private errors: Array<{
        id: string;
        message: string;
        file?: string;
        line?: number;
        relatedTaskId?: string;
    }>;
    private coordinatorId: string;
    private sourceWorkflowId?: string;
    
    // Context from previous attempts (passed by Coordinator)
    private previousAttempts: number;
    private previousFixSummary?: string;
    
    // Fix state
    private fixerAgentName?: string;
    private fixApplied: boolean = false;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        
        // Extract input
        const input = config.input as ErrorResolutionInput;
        this.errors = input.errors;
        this.coordinatorId = input.coordinatorId;
        this.sourceWorkflowId = input.sourceWorkflowId;
        this.previousAttempts = input.previousAttempts || 0;
        this.previousFixSummary = input.previousFixSummary;
    }
    
    getPhases(): string[] {
        return ErrorResolutionWorkflow.PHASES;
    }
    
    async executePhase(phaseIndex: number): Promise<void> {
        const phase = this.getPhases()[phaseIndex];
        
        switch (phase) {
            case 'fix':
                await this.executeFixPhase();
                break;
        }
    }
    
    getState(): object {
        return {
            errors: this.errors,
            coordinatorId: this.coordinatorId,
            previousAttempts: this.previousAttempts,
            previousFixSummary: this.previousFixSummary,
            fixApplied: this.fixApplied
        };
    }
    
    protected getProgressMessage(): string {
        const attemptStr = this.previousAttempts > 0 
            ? ` (attempt ${this.previousAttempts + 1})` 
            : '';
        return `Fixing ${this.errors.length} error(s)${attemptStr}...`;
    }
    
    protected getOutput(): any {
        return {
            errors: this.errors,
            fixApplied: this.fixApplied,
            attempt: this.previousAttempts + 1,
            success: this.fixApplied
        };
    }
    
    // =========================================================================
    // FIX PHASE - Analyze and fix in single AI session, fire and forget
    // =========================================================================
    
    private async executeFixPhase(): Promise<void> {
        const attemptNum = this.previousAttempts + 1;
        this.log(`🔧 PHASE: FIX (attempt ${attemptNum}, ${this.errors.length} errors)`);
        
        // Request a fixer agent
        this.fixerAgentName = await this.requestAgent('engineer');
        
        const role = this.getRole('engineer');
        const prompt = this.buildFixPrompt(role);
        
        this.log(`Running fixer (${role?.defaultModel || 'sonnet-4.5'})...`);
        
        // Use CLI callback for structured completion
        const result = await this.runAgentTaskWithCallback(
            'error_fix',
            prompt,
            'engineer',
            {
                expectedStage: 'implementation',
                timeout: role?.timeoutMs || 600000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot()
            }
        );
        
        if (result.fromCallback) {
            // CLI callback - use result directly
            if (this.isAgentSuccess(result)) {
                this.fixApplied = true;
                this.log(`✓ Fix applied via CLI callback`);
            } else {
                this.log(`❌ Fix failed via CLI callback`);
                throw new Error('Error fix failed');
            }
        } else {
            // No callback received - agent must use CLI callback
            throw new Error(
                'Fixer did not use CLI callback (`apc agent complete`). ' +
                'All agents must report results via CLI callback for structured data. ' +
                'Legacy output parsing is no longer supported.'
            );
        }
        
        // Release fixer
        if (this.fixerAgentName) {
            this.releaseAgent(this.fixerAgentName);
        }
        
        // Fire and forget: request Unity recompile but DON'T wait
        // Coordinator will handle the result when it comes back
        if (this.isUnityAvailable() && this.unityManager) {
            this.log(`📤 Requesting Unity recompile (async)...`);
            
            const taskContext: PipelineTaskContext = {
                taskId: `error_fix_${this.id}`,
                stage: 'verification',
                agentName: this.fixerAgentName || 'error_fixer',
                filesModified: []
            };
            
            // Queue pipeline without waiting - Coordinator handles result
            this.unityManager.queuePipeline(
                this.coordinatorId,
                ['prep'],
                [taskContext],
                true  // Allow merge with other pending compiles
            );
            
            this.log(`✓ Recompile queued - workflow completing (Coordinator handles result)`);
        } else {
            this.log(`⚠️ Unity not available - fix applied, manual verification needed`);
        }
        
        // Clear agent name after release
        this.fixerAgentName = undefined;
    }
    
    // =========================================================================
    // PROMPT BUILDER
    // =========================================================================
    
    private buildFixPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for engineer role');
        }
        const basePrompt = role.promptTemplate;
        
        // Format error list
        const errorList = this.errors.map(e => {
            let errorStr = `- ${e.message}`;
            if (e.file) errorStr += `\n  File: ${e.file}`;
            if (e.line) errorStr += `, Line: ${e.line}`;
            if (e.relatedTaskId) errorStr += `\n  Related Task: ${e.relatedTaskId}`;
            return errorStr;
        }).join('\n\n');
        
        // Build previous attempts context
        let previousAttemptsSection = '';
        if (this.previousAttempts > 0) {
            previousAttemptsSection = `
## Previous Attempts
This is attempt ${this.previousAttempts + 1} to fix these errors.
${this.previousFixSummary ? `\nPrevious fix tried:\n${this.previousFixSummary}\n\nThe errors still exist - try a DIFFERENT approach.` : ''}
`;
        }
        
        return `${basePrompt}

## Errors to Fix
${errorList}
${previousAttemptsSection}
## Your Task
1. **Analyze** the errors to understand the root cause
2. **Fix** the errors with minimal, focused changes
3. Do NOT introduce new issues

## Instructions
- Read error messages and affected files carefully
- Understand WHY the errors occurred before fixing
- Keep changes minimal - don't refactor unrelated code
- Fix all related errors together
${this.previousAttempts > 0 ? '- Previous fix did not work - try something different!' : ''}`;
    }
    
}
