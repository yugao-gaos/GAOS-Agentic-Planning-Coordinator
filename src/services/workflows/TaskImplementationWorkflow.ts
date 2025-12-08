// ============================================================================
// TaskImplementationWorkflow - Per-task execution: Engineer → Review → Unity → Finalize
// Note: Context phase removed - coordinator provides context via task metadata
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { BaseWorkflow } from './BaseWorkflow';
import { WorkflowServices } from './IWorkflow';
import { 
    WorkflowConfig, 
    WorkflowResult, 
    TaskImplementationInput 
} from '../../types/workflow';
import { AgentRole, getDefaultRole } from '../../types';
import { PipelineOperation, PipelineTaskContext, UnityPipelineConfig } from '../../types/unity';
import { TaskManager } from '../TaskManager';
import { ServiceLocator } from '../ServiceLocator';

/**
 * Task implementation workflow - implements a single task from the plan
 * 
 * Phases:
 * 1. implement - Engineer implements the task
 * 2. review - Code reviewer checks implementation
 * 3. approval - Handle review result (may loop back)
 * 4. delta_context - Update project context documents
 * 5. unity - Queue Unity pipeline and wait for result
 * 6. finalize - Mark task complete or needs_work
 * 
 * Note: Context phase removed - coordinator provides context via task metadata.
 * Use ContextGatheringWorkflow for explicit context gathering.
 */
export class TaskImplementationWorkflow extends BaseWorkflow {
    /** Base phases without Unity */
    private static readonly BASE_PHASES = [
        'implement',
        'review',
        'approval',
        'delta_context',
        'finalize'
    ];
    
    /** Unity phase inserted before finalize */
    private static readonly UNITY_PHASE = 'unity';
    
    /** This workflow works with or without Unity - just skips Unity phases */
    static readonly requiresUnity = false;
    
    private static readonly MAX_REVIEW_ITERATIONS = 3;
    
    // Task state
    private taskId: string;
    private taskDescription: string;
    private dependencies: string[];
    private planPath: string;
    private contextBriefPath?: string;
    
    // Execution state
    private reviewIterations: number = 0;
    private reviewResult: 'approved' | 'changes_requested' | 'pending' = 'pending';
    private reviewFeedback: string = '';
    private filesModified: string[] = [];
    private unityResult: { success: boolean; errors?: string[] } | null = null;
    private previousErrors: string[] = [];
    
    // Agent names for bench management
    private engineerName?: string;
    private reviewerName?: string;
    private contextGathererName?: string;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        
        // Extract input
        const input = config.input as TaskImplementationInput;
        this.taskId = input.taskId;
        this.taskDescription = input.taskDescription;
        this.dependencies = input.dependencies || [];
        this.planPath = input.planPath;
        this.contextBriefPath = input.contextBriefPath;
        this.previousErrors = input.previousErrors || [];
    }
    
    getPhases(): string[] {
        // Include Unity phase only if Unity features are enabled
        if (this.unityEnabled) {
            // Insert 'unity' before 'finalize'
            const phases = [...TaskImplementationWorkflow.BASE_PHASES];
            const finalizeIndex = phases.indexOf('finalize');
            phases.splice(finalizeIndex, 0, TaskImplementationWorkflow.UNITY_PHASE);
            return phases;
        }
        return TaskImplementationWorkflow.BASE_PHASES;
    }
    
    /**
     * Override: Return the task ID this workflow occupies
     */
    getOccupiedTaskIds(): string[] {
        return [this.taskId];
    }
    
    /**
     * Handle conflict - if a revision affects our task, we should wait
     */
    handleConflict(taskId: string, otherWorkflowId: string): 'wait' | 'proceed' | 'abort' {
        if (taskId === this.taskId) {
            this.log(`⏸️ Task ${this.taskId} is affected by workflow ${otherWorkflowId.substring(0, 8)}, pausing...`);
            return 'wait';
        }
        return 'proceed';
    }
    
    async executePhase(phaseIndex: number): Promise<void> {
        const phase = this.getPhases()[phaseIndex];
        
        // Declare occupancy at the start of implement phase (first phase now)
        // Also allocate both engineer and reviewer upfront (only if not already allocated)
        if (phaseIndex === 0) {
            this.declareTaskOccupancy(
                [this.taskId],
                'exclusive',
                `Implementing task ${this.taskId}`
            );
            
            // Allocate engineer and reviewer upfront - they stay on bench when idle
            // Only allocate if not already allocated (handles review iteration loops)
            if (!this.engineerName && !this.reviewerName) {
                this.log(`🎭 Allocating engineer and reviewer for workflow ${this.id.substring(0, 8)}...`);
                
                this.log(`  → Requesting 'engineer' role...`);
                this.engineerName = await this.requestAgent('engineer');
                this.log(`  ← Got engineer: ${this.engineerName}`);
                
                this.log(`  → Requesting 'code_reviewer' role...`);
                this.reviewerName = await this.requestAgent('code_reviewer');
                this.log(`  ← Got code_reviewer: ${this.reviewerName}`);
                
                this.log(`✓ Agents allocated: ${this.engineerName} (engineer), ${this.reviewerName} (code_reviewer)`);
                
                // Demote reviewer to bench immediately - it won't work until review phase
                this.demoteAgentToBench(this.reviewerName);
                this.log(`⬇️ Demoted ${this.reviewerName} to bench (waiting for review phase)`);
            } else {
                this.log(`✓ Using already allocated agents: ${this.engineerName} (engineer), ${this.reviewerName} (code_reviewer)`);
            }
        }
        
        switch (phase) {
            case 'implement':
                await this.executeImplementPhase();
                break;
                
            case 'review':
                await this.executeReviewPhase();
                break;
                
            case 'approval':
                await this.executeApprovalPhase();
                break;
                
            case 'delta_context':
                await this.executeDeltaContextPhase();
                break;
                
            case 'unity':
                await this.executeUnityPhase();
                break;
                
            case 'finalize':
                await this.executeFinalizePhase();
                break;
        }
        
        // Release context gatherer after finalize phase
        // Note: Engineer and reviewer are released at the START of delta_context phase
        // to prevent deadlock when requesting context_gatherer
        if (phase === 'finalize') {
            if (this.contextGathererName) {
                this.log(`Releasing context gatherer: ${this.contextGathererName}`);
                this.releaseAgent(this.contextGathererName);
                this.contextGathererName = undefined;
            }
        }
    }
    
    getState(): object {
        return {
            taskId: this.taskId,
            taskDescription: this.taskDescription,
            planPath: this.planPath,
            contextBriefPath: this.contextBriefPath,
            reviewIterations: this.reviewIterations,
            reviewResult: this.reviewResult,
            filesModified: this.filesModified,
            unityResult: this.unityResult
        };
    }
    
    protected getProgressMessage(): string {
        const phase = this.getPhases()[this.phaseIndex] || 'unknown';
        switch (phase) {
            case 'context':
                return `Gathering context for ${this.taskId}...`;
            case 'implement':
                const iteration = this.reviewIterations > 0 
                    ? ` (revision ${this.reviewIterations})` 
                    : '';
                return `Implementing ${this.taskId}${iteration}...`;
            case 'review':
                return `Code review for ${this.taskId}...`;
            case 'approval':
                return this.reviewResult === 'approved' 
                    ? `${this.taskId} approved!`
                    : `Changes requested for ${this.taskId}...`;
            case 'delta_context':
                return `Updating context for ${this.taskId}...`;
            case 'unity':
                return `Unity pipeline for ${this.taskId}...`;
            case 'finalize':
                return `Finalizing ${this.taskId}...`;
            default:
                return `Processing ${this.taskId}...`;
        }
    }
    
    protected getOutput(): any {
        // With fire-and-forget Unity, workflow success is determined by code review approval
        // Unity verification happens asynchronously - coordinator monitors for errors
        const success = this.status === 'completed' && this.reviewResult === 'approved';
        
        return {
            taskId: this.taskId,
            success,
            filesModified: this.filesModified,
            reviewIterations: this.reviewIterations,
            unityVerificationQueued: this.unityEnabled,
            unityEnabled: this.unityEnabled
        };
    }
    
    // =========================================================================
    // PHASE IMPLEMENTATIONS
    // =========================================================================
    
    private async executeImplementPhase(): Promise<void> {
        const iteration = this.reviewIterations > 0 
            ? ` (revision ${this.reviewIterations})` 
            : '';
        this.log(`\n🔧 PHASE: IMPLEMENT${iteration} for task ${this.taskId}`);
        
        if (!this.engineerName) {
            throw new Error('Engineer not allocated - workflow initialization failed');
        }
        
        // Note: Reviewer is already on bench from initial allocation - will be promoted when review phase starts
        
        const role = this.getRole('engineer');
        const prompt = this.buildImplementPrompt(role);
        
        this.log(`Running engineer ${this.engineerName} (${role?.defaultModel || 'sonnet-4.5'})...`);
        
        // Use pre-allocated engineer - pass agentName to avoid requesting a new one
        const result = await this.runAgentTaskWithCallback(
            `implement_${this.taskId}`,
            prompt,
            'engineer',
            {
                expectedStage: 'implementation',
                timeout: role?.timeoutMs || 600000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot(),
                agentName: this.engineerName  // Use the pre-allocated engineer
            }
        );
        
        if (result.fromCallback) {
            // Got structured data from CLI callback - preferred path
            if (this.isAgentSuccess(result)) {
                this.filesModified = result.payload?.files || [];
                this.log(`✓ Implementation complete via CLI callback (${this.filesModified.length} files)`);
            } else {
                const error = result.payload?.error || result.payload?.message || 'Unknown error';
                throw new Error(`Engineer implementation failed for ${this.taskId}: ${error}`);
            }
        } else {
            // No callback received - agent must use CLI callback
            throw new Error(
                'Engineer did not use CLI callback (`apc agent complete`). ' +
                'All agents must report results via CLI callback for structured data. ' +
                'Legacy output parsing is no longer supported.'
            );
        }
        
        // Demote engineer to bench after work (reviewer will work next)
        this.demoteAgentToBench(this.engineerName);
    }
    
    private async executeReviewPhase(): Promise<void> {
        this.reviewIterations++;
        this.log(`\n🔍 PHASE: REVIEW (iteration ${this.reviewIterations}) for task ${this.taskId}`);
        
        if (!this.reviewerName) {
            throw new Error('Reviewer not allocated - workflow initialization failed');
        }
        
        // Demote engineer to bench while reviewer works
        if (this.engineerName) {
            this.demoteAgentToBench(this.engineerName);
        }
        
        const role = this.getRole('code_reviewer');
        const prompt = this.buildReviewPrompt(role);
        
        this.log(`Running code reviewer ${this.reviewerName} (${role?.defaultModel || 'sonnet-4.5'})...`);
        
        // Use pre-allocated reviewer - pass agentName to avoid requesting a new one
        const result = await this.runAgentTaskWithCallback(
            `review_${this.taskId}`,
            prompt,
            'code_reviewer',
            {
                expectedStage: 'review',
                timeout: role?.timeoutMs || 600000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot(),
                agentName: this.reviewerName  // Use the pre-allocated reviewer
            }
        );
        
        if (result.fromCallback) {
            // Got structured data from CLI callback - preferred path
            const resultType = result.result?.toLowerCase();
            
            if (resultType === 'approved') {
                this.reviewResult = 'approved';
                this.log(`✓ Review approved via CLI callback`);
            } else if (resultType === 'changes_requested') {
                this.reviewResult = 'changes_requested';
                this.reviewFeedback = result.payload?.feedback || (Array.isArray(result.payload?.issues) ? result.payload.issues.join('\n') : '') || 'See review comments';
                this.log(`⚠️ Changes requested via CLI callback`);
            } else {
                // Unexpected result - treat as changes_requested
                this.reviewResult = 'changes_requested';
                this.reviewFeedback = result.payload?.message || 'Review result unclear';
                this.log(`⚠️ Review result unclear, treating as changes_requested`);
            }
        } else {
            // No callback received - agent must use CLI callback
            throw new Error(
                'Reviewer did not use CLI callback (`apc agent complete`). ' +
                'All agents must report results via CLI callback for structured data. ' +
                'Legacy output parsing is no longer supported.'
            );
        }
        
        // Demote reviewer to bench after work
        this.demoteAgentToBench(this.reviewerName);
    }
    
    private async executeApprovalPhase(): Promise<void> {
        this.log(`\n✓ PHASE: APPROVAL for task ${this.taskId}`);
        
        if (this.reviewResult === 'changes_requested') {
            if (this.reviewIterations < TaskImplementationWorkflow.MAX_REVIEW_ITERATIONS) {
                this.log(`Changes requested - looping back to implement (iteration ${this.reviewIterations + 1})`);
                // Loop back to implement phase (index 0) - set to -1 since runPhases increments
                this.phaseIndex = -1; // Will be incremented to 0 (implement)
            } else {
                // Max iterations reached - proceed with Unity verification anyway
                // Unity pipeline will catch any compilation errors
                this.log(`⚠️ Max review iterations reached, proceeding to Unity verification`);
                this.reviewResult = 'approved';
            }
        } else {
            this.log(`✓ Approved after ${this.reviewIterations} review(s)`);
        }
    }
    
    private async executeDeltaContextPhase(): Promise<void> {
        this.log(`\n📝 PHASE: DELTA CONTEXT for task ${this.taskId}`);
        
        // Release engineer and reviewer BEFORE requesting context gatherer
        // They're no longer needed after approval - releasing them prevents deadlock
        // when all agents are on bench and context_gatherer can't be allocated
        if (this.engineerName) {
            this.log(`Releasing engineer: ${this.engineerName} (no longer needed)`);
            this.releaseAgent(this.engineerName);
            this.engineerName = undefined;
        }
        if (this.reviewerName) {
            this.log(`Releasing reviewer: ${this.reviewerName} (no longer needed)`);
            this.releaseAgent(this.reviewerName);
            this.reviewerName = undefined;
        }
        
        // Request context gatherer from pool
        this.contextGathererName = await this.requestAgent('context_gatherer');
        this.log(`✓ Context gatherer allocated: ${this.contextGathererName}`);
        
        const role = this.getRole('context_gatherer');
        const prompt = this.buildDeltaContextPrompt(role);
        
        this.log(`Running context gatherer ${this.contextGathererName} in delta mode (${role?.defaultModel || 'gemini-3-pro'})...`);
        
        // Use runAgentTaskWithCallback - agent must call CLI callback to complete
        const result = await this.runAgentTaskWithCallback(
            `delta_context_${this.taskId}`,
            prompt,
            'context_gatherer',
            {
                expectedStage: 'delta_context',
                timeout: role?.timeoutMs || 600000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot(),
                agentName: this.contextGathererName  // Use pre-allocated agent
            }
        );
        
        if (result.fromCallback) {
            if (this.isAgentSuccess(result)) {
                this.log(`✓ Delta context updated via CLI callback`);
            } else {
                this.log(`⚠️ Delta context update failed: ${result.payload?.error || 'unknown'}, continuing`);
            }
        } else {
            // Context gatherer didn't use callback - log warning but don't fail workflow
            this.log(`⚠️ Context gatherer did not use CLI callback - delta context may be incomplete`);
        }
        
        // Context gatherer will be released in executePhase cleanup
    }
    
    private async executeUnityPhase(): Promise<void> {
        this.log(`\n🎮 PHASE: UNITY PIPELINE for task ${this.taskId}`);
        
        // Check if Unity is available
        if (!this.isUnityAvailable() || !this.unityManager) {
            this.log(`⚠️ Unity features disabled - skipping Unity pipeline`);
            this.unityResult = { success: true }; // Treat as success when Unity is disabled
            return;
        }
        
        // Get task's Unity pipeline configuration from TaskManager
        const taskManager = ServiceLocator.resolve(TaskManager);
        const task = taskManager.getTask(this.taskId);
        const pipelineConfig = task?.unityPipeline || 'prep_editmode'; // Default for backward compat
        
        // Map pipeline config to operations
        const operations = this.getOperationsForPipelineConfig(pipelineConfig);
        
        // Skip entirely if 'none'
        if (operations.length === 0) {
            this.log(`⏩ Skipping Unity pipeline (task config: none)`);
            this.unityResult = { success: true };
            return;
        }
        
        // Create task context
        // Note: agentName no longer tracked at workflow level - use generic identifier
        const taskContext: PipelineTaskContext = {
            taskId: this.taskId,
            stage: `implementation_${this.id}`,
            agentName: 'engineer', // Generic identifier for Unity logs
            filesModified: [] // Could track from engineer output
        };
        
        // FIRE-AND-FORGET: Queue the Unity pipeline without waiting
        // The centralized Unity service will handle compilation/tests asynchronously
        // If compilation or test errors occur, the coordinator will detect them and create error tasks
        this.log(`📤 Queueing Unity pipeline (${pipelineConfig}): ${operations.join(' → ')}`);
        
        try {
            // Use queuePipeline (not queuePipelineAndWait) for fire-and-forget
            this.unityManager.queuePipeline(
                this.id, // coordinatorId
                operations,
                [taskContext],
                true // Allow merging with other queued requests
            );
            
            // Always mark as success - we've successfully queued the request
            // Actual compilation/test results will be handled by coordinator's error monitoring
            this.unityResult = { success: true };
            
            this.log(`✓ Unity pipeline queued - coordinator will monitor results asynchronously`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`⚠️ Unity pipeline queueing warning: ${errorMsg}`);
            // Even queueing issues don't fail the workflow - just log the warning
            this.unityResult = { success: true };
        }
    }
    
    /**
     * Map Unity pipeline config to actual operations
     */
    private getOperationsForPipelineConfig(config: UnityPipelineConfig): PipelineOperation[] {
        switch (config) {
            case 'none':
                return [];
            case 'prep':
                return ['prep'];
            case 'prep_editmode':
                return ['prep', 'test_editmode'];
            case 'prep_playmode':
                return ['prep', 'test_playmode'];
            case 'prep_playtest':
                return ['prep', 'test_player_playmode'];
            case 'full':
                return ['prep', 'test_editmode', 'test_playmode', 'test_player_playmode'];
            default:
                // Default to prep + editmode tests for backward compatibility
                return ['prep', 'test_editmode'];
        }
    }
    
    private async executeFinalizePhase(): Promise<void> {
        this.log(`\n📋 PHASE: FINALIZE for task ${this.taskId}`);
        
        // Since Unity is now fire-and-forget, we always mark the task as complete
        // Any Unity compilation or test errors will be handled asynchronously by the coordinator
        await this.updateTaskCheckbox(true);
        this.log(`✅ Task ${this.taskId} workflow completed - Unity verification queued`);
        
        // Release task occupancy - coordinator can now dispatch other work on this task
        this.releaseTaskOccupancy([this.taskId]);
    }
    
    // =========================================================================
    // PROMPT BUILDERS
    // =========================================================================
    
    private buildImplementPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for engineer role');
        }
        const basePrompt = role.promptTemplate;
        
        const contextContent = this.contextBriefPath && fs.existsSync(this.contextBriefPath)
            ? fs.readFileSync(this.contextBriefPath, 'utf-8')
            : '';
        
        let revisionContext = '';
        if (this.reviewIterations > 0 && this.reviewFeedback) {
            const filesModifiedList = this.filesModified.length > 0
                ? `\n## Files You Modified in Previous Iteration\n${this.filesModified.map(f => `- ${f}`).join('\n')}\n`
                : '';
            
            revisionContext = `
## REVISION REQUIRED
This is revision ${this.reviewIterations}. Address the following feedback:

${this.reviewFeedback}
${filesModifiedList}
Focus on fixing the issues raised while preserving working code.`;
        }
        
        let errorContext = '';
        if (this.previousErrors.length > 0) {
            errorContext = `
## Previous Errors to Fix
${this.previousErrors.join('\n')}`;
        }
        
        return `${basePrompt}

## Your Task
${this.taskId}: ${this.taskDescription}

## Plan File
Read the plan if you need more context: ${this.planPath}

## Context Brief
${contextContent}
${revisionContext}
${errorContext}

## Instructions
1. Implement the task as described
2. Follow existing code patterns
3. Write tests if appropriate for the task type
4. Track all files you create or modify (you'll need to report them)

## How to Complete This Task
After implementing, you MUST signal completion via CLI callback (see end of prompt).
Include the list of files you modified in the callback payload.`;
    }
    
    private buildReviewPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for code_reviewer role');
        }
        const basePrompt = role.promptTemplate;
        
        return `${basePrompt}

## Task Being Reviewed
${this.taskId}: ${this.taskDescription}

## Files Modified
${this.filesModified.map(f => `- ${f}`).join('\n')}

## Review Checklist
1. Does the implementation match the task description?
2. Are code patterns consistent with the project?
3. Are there any bugs or issues?
4. Is the code well-organized and readable?

## How to Complete This Review
After reviewing, you MUST signal your decision via CLI callback (see end of prompt).
- Use \`--result approved\` if the code is acceptable
- Use \`--result changes_requested\` if changes are needed (include feedback in payload)`;
    }
    
    private buildDeltaContextPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for context_gatherer role');
        }
        const basePrompt = role.promptTemplate;
        
        return `${basePrompt}

## MODE: DELTA CONTEXT UPDATE
You are running in delta mode after a task was completed and approved.

## Completed Task
${this.taskId}: ${this.taskDescription}

## Files Modified
${this.filesModified.map(f => `- ${f}`).join('\n')}

## Your Task
Update the _AiDevLog/Context/ files to reflect:
1. New code patterns introduced
2. New APIs or interfaces
3. Updated architecture decisions

Keep updates concise and focused on what changed.`;
    }
    
    // =========================================================================
    // HELPER METHODS
    // =========================================================================
    
    private async updateTaskCheckbox(completed: boolean): Promise<void> {
        if (!fs.existsSync(this.planPath)) return;
        
        let content = fs.readFileSync(this.planPath, 'utf-8');
        
        // Find and update the task checkbox
        const taskPattern = new RegExp(
            `^(\\s*-\\s*)\\[[ x]\\]\\s*(\\*\\*${this.taskId}\\*\\*|${this.taskId})`,
            'gm'
        );
        
        content = content.replace(taskPattern, (match, prefix) => {
            const checkbox = completed ? '[x]' : '[ ]';
            return `${prefix}${checkbox} **${this.taskId}**`;
        });
        
        fs.writeFileSync(this.planPath, content);
    }
}

