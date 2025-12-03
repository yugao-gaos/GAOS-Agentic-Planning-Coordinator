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
import { AgentRunner, AgentRunOptions } from '../AgentBackend';
import { AgentRole, getDefaultRole } from '../../types';
import { PipelineOperation, PipelineTaskContext } from '../../types/unity';
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
    private skipUnity: boolean = false; // Set true if max iterations reached with critical issues
    
    // Agent names for bench management
    private engineerName?: string;
    private reviewerName?: string;
    private contextGathererName?: string;
    
    private agentRunner: AgentRunner;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
        
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
                this.log(`🎭 Allocating engineer and reviewer for workflow...`);
                this.engineerName = await this.requestAgent('engineer');
                this.reviewerName = await this.requestAgent('code_reviewer');
                this.log(`✓ Agents allocated: ${this.engineerName} (engineer), ${this.reviewerName} (reviewer)`);
            } else {
                this.log(`✓ Using already allocated agents: ${this.engineerName} (engineer), ${this.reviewerName} (reviewer)`);
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
        
        // Release engineer and reviewer after finalize phase (or if skipping to delta_context)
        if (phase === 'finalize' || (phase === 'delta_context' && this.skipUnity)) {
            if (this.engineerName) {
                this.log(`Releasing engineer: ${this.engineerName}`);
                this.releaseAgent(this.engineerName);
                this.engineerName = undefined;
            }
            if (this.reviewerName) {
                this.log(`Releasing reviewer: ${this.reviewerName}`);
                this.releaseAgent(this.reviewerName);
                this.reviewerName = undefined;
            }
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
    
    /**
     * @deprecated Context phase removed from workflow - coordinator provides context via task metadata.
     * Use ContextGatheringWorkflow for explicit context gathering.
     */
    private async executeContextPhase(): Promise<void> {
        this.log(`📂 PHASE: CONTEXT for task ${this.taskId}`);
        
        const role = this.getRole('context_gatherer');
        const prompt = this.buildContextPrompt(role);
        
        this.log(`Running context gatherer (${role?.defaultModel || 'gemini-3-pro'})...`);
        
        // Agent is automatically allocated and released by runAgentTask
        const result = await this.runAgentTask('context', prompt, role, undefined);
        
        if (result.success && result.output) {
            // Save context brief
            const briefDir = path.join(
                this.stateManager.getPlanFolder(this.sessionId),
                'context'
            );
            if (!fs.existsSync(briefDir)) {
                fs.mkdirSync(briefDir, { recursive: true });
            }
            
            this.contextBriefPath = path.join(briefDir, `${this.taskId}_brief.md`);
            fs.writeFileSync(this.contextBriefPath, result.output);
            this.log(`✓ Context brief saved: ${this.taskId}_brief.md`);
        } else {
            this.log(`⚠️ Context gathering failed, continuing without brief`);
        }
        
        // Note: Agent is automatically released by runAgentTask/runAgentTaskWithCallback
    }
    
    private async executeImplementPhase(): Promise<void> {
        const iteration = this.reviewIterations > 0 
            ? ` (revision ${this.reviewIterations})` 
            : '';
        this.log(`\n🔧 PHASE: IMPLEMENT${iteration} for task ${this.taskId}`);
        
        if (!this.engineerName) {
            throw new Error('Engineer not allocated - workflow initialization failed');
        }
        
        // Demote reviewer to bench while engineer works
        if (this.reviewerName) {
            this.demoteAgentToBench(this.reviewerName);
        }
        
        const role = this.getRole('engineer');
        const prompt = this.buildImplementPrompt(role);
        
        this.log(`Running engineer ${this.engineerName} (${role?.defaultModel || 'sonnet-4.5'})...`);
        
        // Use pre-allocated engineer (don't request/release in runAgentTaskWithCallback)
        const result = await this.runAgentTaskWithCallback(
            `implement_${this.taskId}`,
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
            // Got structured data from CLI callback - preferred path
            if (this.isAgentSuccess(result)) {
                this.filesModified = result.payload?.files || [];
                this.log(`✓ Implementation complete via CLI callback (${this.filesModified.length} files)`);
            } else {
                const error = result.payload?.error || result.payload?.message || 'Unknown error';
                throw new Error(`Engineer implementation failed for ${this.taskId}: ${error}`);
            }
        } else {
            // Legacy fallback: parse output
            if (result.success) {
                this.filesModified = this.extractFilesFromOutput(result.rawOutput || '');
                this.log(`✓ Implementation complete via output parsing (${this.filesModified.length} files)`);
            } else {
                throw new Error(`Engineer implementation failed for ${this.taskId}`);
            }
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
        
        // Use pre-allocated reviewer (don't request/release in runAgentTaskWithCallback)
        const result = await this.runAgentTaskWithCallback(
            `review_${this.taskId}`,
            prompt,
            'code_reviewer',
            {
                expectedStage: 'review',
                timeout: role?.timeoutMs || 600000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot()
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
                // Fallback: treat non-approved as changes_requested
                this.reviewResult = 'changes_requested';
                this.reviewFeedback = result.payload?.message || 'Review feedback unavailable';
                this.log(`⚠️ Review result unclear, treating as changes_requested`);
            }
        } else {
            // Legacy fallback: treat success as approved
            if (result.success) {
                this.reviewResult = 'approved';
                this.log(`✓ Review approved (legacy fallback)`);
            } else {
                this.reviewResult = 'changes_requested';
                this.reviewFeedback = result.rawOutput || 'Review failed';
                this.log(`⚠️ Review failed, requesting changes`);
            }
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
                // Max iterations reached - check if there are critical issues in feedback
                const hasCriticalIssues = this.reviewFeedback && (
                    this.reviewFeedback.toLowerCase().includes('critical') ||
                    this.reviewFeedback.toLowerCase().includes('blocking') ||
                    this.reviewFeedback.toLowerCase().includes('must fix') ||
                    this.reviewFeedback.toLowerCase().includes('error') ||
                    this.reviewFeedback.toLowerCase().includes('crash') ||
                    this.reviewFeedback.toLowerCase().includes('broken')
                );
                
                if (hasCriticalIssues) {
                    this.log(`⚠️ Max review iterations reached WITH CRITICAL ISSUES`);
                    this.log(`⏩ Skipping Unity compilation - will go directly to context update`);
                    this.skipUnity = true;
                } else {
                    this.log(`⚠️ Max review iterations reached, proceeding despite non-critical changes`);
                }
                
                this.reviewResult = 'approved';
            }
        } else {
            this.log(`✓ Approved after ${this.reviewIterations} review(s)`);
        }
    }
    
    private async executeDeltaContextPhase(): Promise<void> {
        this.log(`\n📝 PHASE: DELTA CONTEXT for task ${this.taskId}`);
        
        // Request context gatherer from pool
        this.contextGathererName = await this.requestAgent('context_gatherer');
        this.log(`✓ Context gatherer allocated: ${this.contextGathererName}`);
        
        const role = this.getRole('context_gatherer');
        const prompt = this.buildDeltaContextPrompt(role);
        
        this.log(`Running context gatherer ${this.contextGathererName} in delta mode (${role?.defaultModel || 'gemini-3-pro'})...`);
        
        // Use allocated context gatherer
        const result = await this.runAgentTask(
            'delta_context', 
            prompt, 
            role, 
            undefined
        );
        
        if (result.success) {
            this.log(`✓ Delta context updated`);
        } else {
            this.log(`⚠️ Delta context update failed, continuing`);
        }
        
        // Context gatherer will be released in executePhase cleanup
    }
    
    private async executeUnityPhase(): Promise<void> {
        this.log(`\n🎮 PHASE: UNITY PIPELINE for task ${this.taskId}`);
        
        // Skip Unity if flagged (max iterations with critical issues)
        if (this.skipUnity) {
            this.log(`⏩ Skipping Unity pipeline due to critical review issues`);
            this.unityResult = { success: true }; // Treat as success to not block workflow
            return;
        }
        
        // Check if Unity is available
        if (!this.isUnityAvailable() || !this.unityManager) {
            this.log(`⚠️ Unity features disabled - skipping Unity pipeline`);
            this.unityResult = { success: true }; // Treat as success when Unity is disabled
            return;
        }
        
        // Define operations: 'prep' (reimport + compile) and 'test_editmode'
        const operations: PipelineOperation[] = ['prep', 'test_editmode'];
        
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
        this.log(`📤 Queueing Unity pipeline (fire-and-forget): ${operations.join(' → ')}`);
        
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
    
    /**
     * @deprecated Context phase removed - coordinator provides context via task metadata.
     * Use ContextGatheringWorkflow for explicit context gathering.
     */
    private buildContextPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for context_gatherer role');
        }
        const basePrompt = role.promptTemplate;
        
        return `${basePrompt}

## Task
${this.taskId}: ${this.taskDescription}

## Dependencies
${this.dependencies.length > 0 ? this.dependencies.join(', ') : 'None'}

## Plan File
Read the plan if you need more context: ${this.planPath}

## Your Task
Gather context relevant to implementing this task:
1. Find existing code patterns to follow
2. Identify integration points
3. Note any risks or constraints

## Output
Provide a focused context brief in markdown format.`;
    }
    
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
4. List all files you create or modify

## Output
Implement the task. At the end, list all files modified:
\`\`\`
FILES_MODIFIED:
- path/to/file1.cs
- path/to/file2.cs
\`\`\``;
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

## REQUIRED Output Format
\`\`\`
### Review Result: [APPROVED|CHANGES_REQUESTED]

#### Issues Found
- [List issues, or "None"]

#### Suggestions
- [List suggestions, or "None"]

#### Summary
[Brief summary of the review]
\`\`\``;
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
    
    /**
     * Legacy runAgentTask method for deprecated phases
     * @deprecated Use runAgentTaskWithCallback for better structured results
     */
    private async runAgentTask(
        taskId: string,
        prompt: string,
        role: AgentRole | undefined,
        _agentName?: string // Kept for API compatibility but unused
    ): Promise<{ success: boolean; output: string }> {
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs', 'agents');
        
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        // Request agent through normal allocation flow
        const agentName = await this.requestAgent(role?.id || 'engineer');
        
        // Use workflow ID + agent name for unique temp log file
        const logFile = path.join(logDir, `${this.id}_${agentName}.log`);
        
        // Prepend continuation context if we were force-paused mid-agent
        let finalPrompt = prompt;
        const continuationPrompt = this.getContinuationPrompt();
        if (continuationPrompt) {
            finalPrompt = continuationPrompt + prompt;
            this.log(`  📋 Using continuation context from paused session`);
            this.clearContinuationContext();
        }
        
        // Track the agent run ID for pause/resume
        const agentRunId = `task_${this.sessionId}_${this.taskId}_${taskId}`;
        this.currentAgentRunId = agentRunId;
        
        const options: AgentRunOptions = {
            id: agentRunId,
            prompt: finalPrompt,
            cwd: workspaceRoot,
            model: role?.defaultModel || 'sonnet-4.5',
            logFile,
            timeoutMs: role?.timeoutMs || 600000,
            onProgress: (msg) => this.log(`  ${msg}`)
        };
        
        try {
            const result = await this.agentRunner.run(options);
            return {
                success: result.success,
                output: result.output
            };
        } finally {
            // Clear the agent run ID when done
            this.currentAgentRunId = undefined;
            
            // Release agent back to pool
            this.releaseAgent(agentName);
            
            // Clean up temp log file (streaming was for real-time terminal viewing)
            try {
                if (fs.existsSync(logFile)) {
                    fs.unlinkSync(logFile);
                }
            } catch { /* ignore cleanup errors */ }
        }
    }
    
    private parseReviewResult(output: string): { approved: boolean; feedback: string } {
        const resultMatch = output.match(/###?\s*Review\s*Result:\s*(APPROVED|CHANGES_REQUESTED)/i);
        const approved = resultMatch 
            ? resultMatch[1].toUpperCase() === 'APPROVED'
            : true; // Default to approved if can't parse
        
        // Extract issues/feedback
        const issuesMatch = output.match(/####?\s*Issues\s*Found[\s\S]*?(?=####|$)/i);
        const feedback = issuesMatch 
            ? issuesMatch[0].replace(/####?\s*Issues\s*Found\s*/i, '').trim()
            : '';
        
        return { approved, feedback };
    }
    
    /**
     * Extract files modified from agent output
     * Uses multiple patterns to catch various agent output formats
     */
    private extractFilesFromOutput(output: string): string[] {
        const files = new Set<string>();
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        
        // Pattern 1: FILES_MODIFIED section (explicit listing)
        const filesModifiedMatch = output.match(/FILES_MODIFIED:[\s\S]*?(?=```|###|\n\n|$)/i);
        if (filesModifiedMatch) {
            const lines = filesModifiedMatch[0].split('\n')
                .filter(line => line.trim().startsWith('-'))
                .map(line => line.replace(/^-\s*/, '').trim())
                .filter(f => f.length > 0 && f.includes('.'));
            lines.forEach(f => files.add(f));
        }
        
        // Pattern 2: Tool call patterns (write_file, search_replace)
        // Matches: "file_path": "path/to/file.ts" or file_path="path/to/file.ts"
        const toolCallPatterns = [
            /"file_path"\s*:\s*"([^"]+\.\w+)"/gi,
            /file_path\s*=\s*"([^"]+\.\w+)"/gi,
            /"target_file"\s*:\s*"([^"]+\.\w+)"/gi,
            /target_file\s*=\s*"([^"]+\.\w+)"/gi
        ];
        
        for (const pattern of toolCallPatterns) {
            let match;
            while ((match = pattern.exec(output)) !== null) {
                files.add(match[1]);
            }
        }
        
        // Pattern 3: Common agent output patterns
        const agentPatterns = [
            /(?:Created|Creating|Wrote|Writing|Edited|Editing|Modified|Modifying)\s+[`'"]?([^\s`'"]+\.\w+)[`'"]?/gi,
            /(?:Updated|Updating)\s+[`'"]?([^\s`'"]+\.\w+)[`'"]?/gi,
            /(?:File|Saved to)\s*:\s*[`'"]?([^\s`'"]+\.\w+)[`'"]?/gi
        ];
        
        for (const pattern of agentPatterns) {
            let match;
            while ((match = pattern.exec(output)) !== null) {
                const file = match[1];
                // Skip common false positives
                if (!file.includes('http') && !file.startsWith('.') && file.includes('.')) {
                    files.add(file);
                }
            }
        }
        
        // Validate files exist (filter out non-existent files)
        const validFiles: string[] = [];
        for (const file of files) {
            // Try both relative and absolute paths
            const relativePath = path.join(workspaceRoot, file);
            if (fs.existsSync(file) || fs.existsSync(relativePath)) {
                validFiles.push(file);
            }
        }
        
        // Log if we found files vs validated files
        if (files.size > validFiles.length) {
            this.log(`  File tracking: found ${files.size} mentioned, ${validFiles.length} validated`);
        }
        
        return validFiles.length > 0 ? validFiles : Array.from(files);
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

