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
    private needsCoordinatorReview: boolean = false;  // Set when agent output was truncated
    
    // Agent names for bench management
    private engineerName?: string;
    private reviewerName?: string;
    private contextGathererName?: string;
    
    // Cached project overview (extracted from plan header)
    private projectOverview?: string;
    
    // Cached Unity pipeline config (fetched from TaskManager)
    private pipelineConfig?: UnityPipelineConfig;
    
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
        const success = this.status === 'succeeded' && this.reviewResult === 'approved';
        
        return {
            taskId: this.taskId,
            success,
            filesModified: this.filesModified,
            reviewIterations: this.reviewIterations,
            unityVerificationQueued: this.unityEnabled,
            unityEnabled: this.unityEnabled,
            // Flag to indicate coordinator should verify work (agent output was truncated)
            needsCoordinatorReview: this.needsCoordinatorReview || undefined
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
        
        this.log(`Running engineer ${this.engineerName} (tier: ${role?.defaultModel || 'mid'})...`);
        
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
        
        // Process agent result from output parsing
        if (this.isAgentSuccess(result)) {
            this.filesModified = result.payload?.files || [];
            this.log(`✓ Implementation complete (${this.filesModified.length} files)`);
        } else if (result.result === 'needs_review' || result.payload?.needsCoordinatorDecision) {
            // Work may be complete - mark for coordinator review instead of failing
            this.filesModified = result.payload?.files || [];
            this.needsCoordinatorReview = true;
            this.log(`⚠️ Implementation needs review - agent output was truncated`);
            this.log(`  → Files found in summary: ${this.filesModified.length > 0 ? this.filesModified.join(', ') : 'none'}`);
            this.log(`  → Task will be marked 'awaiting_decision' for coordinator to verify`);
            // Don't throw - let the workflow complete with needs_review status
            // The coordinator can then verify the files and decide to complete or retry
        } else {
            const error = result.payload?.error || result.payload?.message || 'Unknown error';
            throw new Error(`Engineer implementation failed for ${this.taskId}: ${error}`);
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
        
        this.log(`Running code reviewer ${this.reviewerName} (tier: ${role?.defaultModel || 'high'})...`);
        
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
        
        // Process agent result from output parsing
        const resultType = result.result?.toLowerCase();
        
        if (resultType === 'approved') {
            this.reviewResult = 'approved';
            this.log(`✓ Review approved`);
        } else if (resultType === 'changes_requested') {
            this.reviewResult = 'changes_requested';
            this.reviewFeedback = result.payload?.feedback || (Array.isArray(result.payload?.issues) ? result.payload.issues.join('\n') : '') || 'See review comments';
            this.log(`⚠️ Changes requested`);
        } else {
            // Unexpected result - treat as changes_requested
            this.reviewResult = 'changes_requested';
            this.reviewFeedback = result.payload?.message || 'Review result unclear';
            this.log(`⚠️ Review result unclear, treating as changes_requested`);
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
        
        this.log(`Running context gatherer ${this.contextGathererName} in delta mode (tier: ${role?.defaultModel || 'mid'})...`);
        
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
        
        if (this.isAgentSuccess(result)) {
            this.log(`✓ Delta context updated`);
        } else {
            this.log(`⚠️ Delta context update failed: ${result.payload?.error || 'unknown'}, continuing`);
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
        const pipelineConfig = task?.unityPipeline || 'none'; // Default: no Unity pipeline
        
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
        
        // Get project overview (cached, extracted from plan header)
        const projectOverview = this.getProjectOverview();
        
        // Build test requirements based on Unity pipeline config
        const testRequirements = this.buildTestRequirements();
        
        const prompt = `${basePrompt}

## Project Overview
${projectOverview}

## Your Task
${this.taskId}: ${this.taskDescription}

## Context Brief
${contextContent}
${revisionContext}
${errorContext}

${testRequirements}

## Instructions
0. Read documentation and context files referenced above
1. Implement the task as described
2. Follow existing code patterns
3. Follow the Testing Requirements section above
4. Track all files you create or modify
5. Run the completion command when done`;
        
        return this.appendExtraInstruction(prompt);
    }
    
    private buildReviewPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for code_reviewer role');
        }
        const basePrompt = role.promptTemplate;
        
        const prompt = `${basePrompt}

## Task Being Reviewed
${this.taskId}: ${this.taskDescription}

## Files Modified
${this.filesModified.map(f => `- ${f}`).join('\n')}

## Review Checklist
1. Does the implementation match the task description?
2. Are code patterns consistent with the project?
3. Are there any bugs or issues?
4. Is the code well-organized and readable?
5. Run the completion command when done`;
        
        return this.appendExtraInstruction(prompt);
    }
    
    private buildDeltaContextPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for context_gatherer role');
        }
        const basePrompt = role.promptTemplate;
        
        const prompt = `${basePrompt}

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
        
        return this.appendExtraInstruction(prompt);
    }
    
    // =========================================================================
    // HELPER METHODS
    // =========================================================================
    
    /**
     * Get the Unity pipeline config for this task (cached).
     * Fetches from TaskManager on first call.
     */
    private getPipelineConfig(): UnityPipelineConfig {
        if (this.pipelineConfig !== undefined) {
            return this.pipelineConfig;
        }
        
        try {
            const taskManager = ServiceLocator.resolve(TaskManager);
            const task = taskManager.getTask(this.taskId);
            this.pipelineConfig = task?.unityPipeline || 'none';
        } catch {
            // TaskManager not available - use default
            this.pipelineConfig = 'none';
        }
        
        return this.pipelineConfig;
    }
    
    /**
     * Build test requirements section based on Unity pipeline config.
     * Tells engineer what tests to write (or not write) based on pipeline flag.
     */
    private buildTestRequirements(): string {
        const config = this.getPipelineConfig();
        
        switch (config) {
            case 'none':
                return `## Testing Requirements
This task does not require Unity tests (documentation or non-Unity changes).`;
            
            case 'prep':
                return `## Testing Requirements
This task does NOT require writing tests. Focus on implementation only.
The Unity pipeline will only run compilation - no test runner will be invoked.`;
            
            case 'prep_editmode':
                return `## Testing Requirements
You MUST write Unity TestFramework **EditMode** tests for this task.
- Use \`[Test]\` attribute for test methods
- Tests run in editor without entering Play mode
- Test file should be under an Editor folder or EditMode test assembly
- Example: \`Tests/EditMode/YourFeatureTests.cs\``;
            
            case 'prep_playmode':
                return `## Testing Requirements
You MUST write Unity TestFramework **PlayMode** tests for this task.
- Use \`[UnityTest]\` attribute for coroutine tests, \`[Test]\` for sync tests
- Tests run in Play mode with full Unity lifecycle
- Test file should be in a PlayMode test assembly
- Example: \`Tests/PlayMode/YourFeatureTests.cs\``;
            
            case 'prep_playtest':
                return `## Testing Requirements
This task does NOT require writing automated tests.
The Unity pipeline includes manual player playtesting (not your concern).
Focus on implementation only.`;
            
            case 'full':
                return `## Testing Requirements
You MUST write BOTH Unity TestFramework **EditMode** AND **PlayMode** tests.
- EditMode tests: \`[Test]\` in Editor folder or EditMode assembly
- PlayMode tests: \`[UnityTest]\` or \`[Test]\` in PlayMode assembly
This is a milestone task requiring comprehensive test coverage.`;
            
            default:
                return `## Testing Requirements
Write tests if appropriate for the task type.`;
        }
    }
    
    /**
     * Extract project overview from plan file header.
     * Extracts content from start to just before "## Task Breakdown" or similar task section.
     * This gives the agent project context without the full 300+ line plan.
     * 
     * Filters out session metadata (Status, Created) that is managed by code, not relevant to agent.
     */
    private getProjectOverview(): string {
        // Return cached if available
        if (this.projectOverview !== undefined) {
            return this.projectOverview;
        }
        
        // Try to extract from plan file
        if (!fs.existsSync(this.planPath)) {
            this.projectOverview = '(Plan file not found)';
            return this.projectOverview;
        }
        
        try {
            const content = fs.readFileSync(this.planPath, 'utf-8');
            const lines = content.split('\n');
            
            // Find where the task breakdown starts (## Task Breakdown, ## Tasks, etc.)
            const taskSectionPatterns = [
                /^##\s*Task\s*Breakdown/i,
                /^##\s*Tasks/i,
                /^##\s*Implementation\s*Tasks/i,
                /^##\s*Phase\s*\d/i  // "## Phase 1: ..."
            ];
            
            // Lines to filter out (session metadata managed by code, not relevant to agent)
            const filterPatterns = [
                /^\*\*Status:\*\*/i,
                /^\*\*Created:\*\*/i
            ];
            
            let endIndex = lines.length;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (taskSectionPatterns.some(pattern => pattern.test(line))) {
                    endIndex = i;
                    break;
                }
            }
            
            // Extract overview (header to task section), filter out metadata, limit to reasonable size
            const overviewLines = lines
                .slice(0, Math.min(endIndex, 50))
                .filter(line => !filterPatterns.some(pattern => pattern.test(line)));
            this.projectOverview = overviewLines.join('\n').trim();
            
            // If overview is too short, something might be wrong - use first 30 lines
            if (this.projectOverview.length < 50) {
                this.projectOverview = lines
                    .slice(0, 30)
                    .filter(line => !filterPatterns.some(pattern => pattern.test(line)))
                    .join('\n').trim();
            }
            
            return this.projectOverview;
        } catch (error) {
            this.log(`Warning: Failed to extract project overview: ${error}`);
            this.projectOverview = '(Failed to read plan overview)';
            return this.projectOverview;
        }
    }
    
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

