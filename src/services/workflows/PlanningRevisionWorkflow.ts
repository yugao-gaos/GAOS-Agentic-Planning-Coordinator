// ============================================================================
// PlanningRevisionWorkflow - Impact Analysis → Planner → Review → Finalize
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { BaseWorkflow } from './BaseWorkflow';
import { WorkflowServices } from './IWorkflow';
import { 
    WorkflowConfig, 
    WorkflowResult, 
    PlanningWorkflowInput 
} from '../../types/workflow';
import { RevisionImpactAnalyzer, RevisionImpactResult } from '../RevisionImpactAnalyzer';
import { AgentRole, getDefaultRole, AnalystVerdict } from '../../types';

/**
 * Planning revision workflow for updating existing plans
 * 
 * Flow with impact analysis:
 * 1. analyze_impact - Determine which tasks are affected by the revision
 * 2. planner - Revise based on user feedback
 * 3. review - Codex reviews the changes
 * 4. finalize - Apply final touches
 * 
 * This workflow uses the generic conflict system:
 * - Analyzes impact to determine affected tasks
 * - Declares conflicts (pauses affected task workflows)
 * - Clears conflicts on completion (resumes paused workflows)
 */
export class PlanningRevisionWorkflow extends BaseWorkflow {
    private static readonly PHASES = [
        'analyze_impact',
        'planner',
        'review',
        'finalize'
    ];
    
    // Planning state
    private planPath: string = '';
    private contextPath: string = '';
    private userFeedback: string = '';
    private analystOutput: string = '';
    private analystVerdict: AnalystVerdict = 'pass';
    
    // Impact analysis state
    private impactResult: RevisionImpactResult | null = null;
    private affectedTaskIds: string[] = [];
    private isGlobalRevision: boolean = false;
    
    // Reserved planner agent - kept for the entire workflow (not released between phases)
    private plannerAgentName: string | undefined;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        
        // Extract input
        const input = config.input as PlanningWorkflowInput;
        this.userFeedback = input.userFeedback || '';
        this.planPath = input.existingPlanPath || '';
    }
    
    getPhases(): string[] {
        return PlanningRevisionWorkflow.PHASES;
    }
    
    /**
     * Revision workflow blocks other workflows from starting
     * This ensures the plan is stable during revision
     */
    isBlocking(): boolean {
        return true;
    }
    
    async executePhase(phaseIndex: number): Promise<void> {
        const phase = this.getPhases()[phaseIndex];
        
        switch (phase) {
            case 'analyze_impact':
                await this.executeAnalyzeImpactPhase();
                break;
                
            case 'planner':
                await this.executePlannerPhase();
                break;
                
            case 'review':
                await this.executeReviewPhase();
                break;
                
            case 'finalize':
                await this.executeFinalizePhase();
                break;
        }
    }
    
    getState(): object {
        return {
            planPath: this.planPath,
            contextPath: this.contextPath,
            userFeedback: this.userFeedback,
            analystVerdict: this.analystVerdict,
            affectedTaskIds: this.affectedTaskIds,
            isGlobalRevision: this.isGlobalRevision
        };
    }
    
    protected getProgressMessage(): string {
        const phase = this.getPhases()[this.phaseIndex] || 'unknown';
        switch (phase) {
            case 'analyze_impact':
                return 'Analyzing revision impact...';
            case 'planner':
                return 'Revising plan based on feedback...';
            case 'review':
                return 'Codex reviewing changes...';
            case 'finalize':
                return 'Finalizing revision...';
            default:
                return 'Processing...';
        }
    }
    
    protected getOutput(): any {
        return {
            planPath: this.planPath,
            contextPath: this.contextPath,
            reviewVerdict: this.analystVerdict,
            affectedTaskIds: this.affectedTaskIds,
            isGlobalRevision: this.isGlobalRevision
        };
    }
    
    /**
     * Override: Return task IDs that conflict with this revision
     * Called by coordinator after conflict is declared
     */
    getConflictingTaskIds(): string[] {
        return this.affectedTaskIds;
    }
    
    // =========================================================================
    // PHASE IMPLEMENTATIONS
    // =========================================================================
    
    /**
     * Phase 1: Analyze Impact
     * 
     * Uses RevisionImpactAnalyzer to determine which tasks are affected.
     * Then declares conflicts with those tasks - the coordinator will pause
     * any workflows working on affected tasks.
     */
    private async executeAnalyzeImpactPhase(): Promise<void> {
        // Initialize paths if not set
        if (!this.planPath) {
            this.planPath = this.stateManager.getPlanFilePath(this.sessionId);
        }
        
        this.log(`\n${'═'.repeat(60)}`);
        this.log('📊 PHASE: ANALYZE IMPACT');
        this.log(`${'═'.repeat(60)}`);
        this.log(`Feedback: "${this.userFeedback.substring(0, 100)}${this.userFeedback.length > 100 ? '...' : ''}"`);
        
        // Check for global revision
        this.isGlobalRevision = RevisionImpactAnalyzer.isGlobalRevision(this.userFeedback);
        
        if (this.isGlobalRevision) {
            this.log('⚠️  Global revision detected - ALL tasks will be affected');
        }
        
        // Run impact analysis
        this.impactResult = RevisionImpactAnalyzer.analyze(
            this.userFeedback,
            this.planPath,
            undefined, // Could get current task states from coordinator
            { includeTransitive: true }
        );
        
        // Collect all affected task IDs
        this.affectedTaskIds = [
            ...this.impactResult.directlyAffected.map(t => t.taskId),
            ...this.impactResult.transitivelyAffected.map(t => t.taskId)
        ];
        
        // Log the impact summary
        this.log(RevisionImpactAnalyzer.formatImpactSummary(this.impactResult));
        
        // Declare conflicts with affected tasks
        // The coordinator will pause any workflows working on these tasks
        if (this.affectedTaskIds.length > 0 || this.isGlobalRevision) {
            const conflictTaskIds = this.isGlobalRevision 
                ? ['*'] // Special marker for global revision
                : this.affectedTaskIds;
            
            this.declareTaskConflicts(
                conflictTaskIds,
                'pause_others',
                `Revision: ${this.userFeedback.substring(0, 50)}...`
            );
            
            this.log(`✓ Declared conflicts with ${this.affectedTaskIds.length} tasks`);
        } else {
            this.log('✓ No task conflicts detected - no workflows need to pause');
        }
        
        this.log(`${'─'.repeat(60)}\n`);
    }
    
    private async executePlannerPhase(): Promise<void> {
        // Initialize paths if not set
        if (!this.planPath) {
            this.planPath = this.stateManager.getPlanFilePath(this.sessionId);
        }
        this.contextPath = path.join(
            this.stateManager.getPlanFolder(this.sessionId), 
            'context.md'
        );
        
        // Verify plan exists
        if (!fs.existsSync(this.planPath)) {
            throw new Error('No existing plan to revise');
        }
        
        this.log('📝 PHASE: PLANNER REVISION');
        this.log(`Feedback: ${this.userFeedback.substring(0, 100)}...`);
        
        const role = this.getRole('planner');
        const prompt = this.buildRevisionPrompt(role);
        
        this.log(`Running planner revision (${role?.defaultModel || 'opus-4.5'})...`);
        
        // Backup current plan BEFORE streaming starts (streaming will overwrite)
        // Store backups in dedicated backups folder to keep plan folder clean
        const backupsFolder = this.stateManager.getBackupsFolder(this.sessionId);
        if (!fs.existsSync(backupsFolder)) {
            fs.mkdirSync(backupsFolder, { recursive: true });
        }
        const backupFilename = `plan_backup_${Date.now()}.md`;
        const backupPath = path.join(backupsFolder, backupFilename);
        fs.copyFileSync(this.planPath, backupPath);
        this.log(`Created backup: backups/${backupFilename}`);
        
        // Reuse planner agent across phases, or request new one
        if (!this.plannerAgentName) {
            this.plannerAgentName = await this.requestAgent('planner');
        }
        
        // Stream revised plan directly to plan file (commentary goes to log)
        // Use CLI callback for structured completion
        const result = await this.runAgentTaskWithCallback(
            'planner_revise',
            prompt,
            'planner',
            {
                expectedStage: 'planning',
                timeout: role?.timeoutMs || 900000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot(),
                agentName: this.plannerAgentName,
                planFile: this.planPath
            }
        );
        
        if (result.fromCallback && this.isAgentSuccess(result)) {
            // Plan was streamed to file; verify it exists
            if (!fs.existsSync(this.planPath)) {
                throw new Error(
                    `Plan streaming failed: expected plan file at '${this.planPath}' not created. ` +
                    `This indicates the agent did not properly stream the plan to the file. ` +
                    `Check agent logs for streaming errors.`
                );
            }
            this.log('✓ Plan revised via CLI callback');
        } else if (!result.fromCallback) {
            throw new Error(
                `Planner did not use CLI callback (\`apc agent complete\`). ` +
                'All agents must report results via CLI callback.'
            );
        } else {
            const error = result.payload?.error || result.payload?.message || 'Unknown error';
            throw new Error(`Planner revision task failed: ${error}`);
        }
        
        // Demote planner to bench (may be needed for analyst feedback loop)
        this.demoteAgentToBench(this.plannerAgentName);
    }
    
    private async executeReviewPhase(): Promise<void> {
        this.log('');
        this.log('🔍 PHASE: CODEX REVIEW');
        
        const role = this.getRole('analyst_implementation');
        const prompt = this.buildReviewPrompt(role);
        
        this.log(`Running analyst_implementation (${role?.defaultModel || 'gpt-5.1-codex-high'})...`);
        
        // Request agent BEFORE running task so we can release it after
        const agentName = await this.requestAgent('analyst_implementation');
        
        try {
            // Use CLI callback for structured completion
            const result = await this.runAgentTaskWithCallback(
                'analyst_implementation_review',
                prompt,
                'analyst_implementation',
                {
                    expectedStage: 'analysis',
                    timeout: role?.timeoutMs || 300000,
                    model: role?.defaultModel,
                    cwd: this.stateManager.getWorkspaceRoot(),
                    agentName  // Pass pre-allocated agent
                }
            );
            
            if (result.fromCallback) {
                // CLI callback - use verdict directly
                const verdictMap: Record<string, AnalystVerdict> = {
                    'pass': 'pass',
                    'critical': 'critical',
                    'minor': 'minor'
                };
                this.analystVerdict = verdictMap[result.result] || 'pass';
                
                // Build output from payload
                const issues = result.payload?.issues || [];
                const suggestions = result.payload?.suggestions || [];
                let output = `### Review Result: ${this.analystVerdict.toUpperCase()}\n\n`;
                if (issues.length > 0) {
                    output += '#### Issues\n' + issues.map((i: string) => `- ${i}`).join('\n') + '\n\n';
                }
                if (suggestions.length > 0) {
                    output += '#### Suggestions\n' + suggestions.map((s: string) => `- ${s}`).join('\n') + '\n';
                }
                this.analystOutput = output;
                
                const icon = this.analystVerdict === 'pass' ? '✅' 
                    : this.analystVerdict === 'critical' ? '❌' : '⚠️';
                this.log(`${icon} Codex verdict via CLI callback: ${this.analystVerdict.toUpperCase()}`);
            } else {
                // No callback received - agent must use CLI callback
                throw new Error(
                    'Analyst did not use CLI callback (`apc agent complete`). ' +
                    'All agents must report results via CLI callback for structured data. ' +
                    'Legacy output parsing is no longer supported.'
                );
            }
        } finally {
            // Release analyst agent immediately - review is a one-shot task
            this.releaseAgent(agentName);
            this.log(`  Released analyst agent ${agentName}`);
        }
    }
    
    private async executeFinalizePhase(): Promise<void> {
        this.log('');
        this.log('📋 PHASE: FINALIZATION');
        
        const role = this.getRole('text_clerk');
        const prompt = this.buildFinalizationPrompt(role);
        
        this.log(`Running text_clerk finalization (${role?.defaultModel || 'auto'})...`);
        
        // Use runAgentTaskWithCallback for proper completion signaling
        const result = await this.runAgentTaskWithCallback(
            'plan_finalize',
            prompt,
            'text_clerk',
            {
                expectedStage: 'finalization',
                timeout: role?.timeoutMs || 120000,  // 2 minutes
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot()
            }
        );
        
        if (!result.fromCallback) {
            // Agent failed to use CLI callback - this is an error
            throw new Error(
                `Text clerk did not use CLI callback (\`apc agent complete\`). ` +
                `Result: ${result.result}, Error: ${result.payload?.error || 'unknown'}`
            );
        }
        
        this.log(`✓ Finalization completed via CLI callback: ${result.result}`);
        
        // Verify plan file exists
        if (!fs.existsSync(this.planPath)) {
            throw new Error(
                `Plan finalization failed: expected plan file at '${this.planPath}' not found. ` +
                `Check agent logs for errors.`
            );
        }
        
        // Update plan status
        this.updatePlanStatus();
        
        // Update session state
        const session = this.stateManager.getPlanningSession(this.sessionId);
        if (session) {
            session.status = 'reviewing';
            session.currentPlanPath = this.planPath;
            session.updatedAt = new Date().toISOString();
            
            // Increment plan version
            session.planHistory.push({
                version: session.planHistory.length + 1,
                path: this.planPath,
                timestamp: new Date().toISOString()
            });
            
            this.stateManager.savePlanningSession(session);
        }
        
        // Clear conflicts - paused workflows can resume
        // The coordinator will handle this via the onComplete event,
        // but we also clear our local state
        this.clearTaskConflicts();
        
        this.log(`\n${'═'.repeat(60)}`);
        this.log('✅ REVISION COMPLETE');
        this.log(`   Affected tasks: ${this.affectedTaskIds.length}`);
        this.log(`   Plan updated: ${path.basename(this.planPath)}`);
        this.log(`${'═'.repeat(60)}\n`);
    }
    
    // =========================================================================
    // PROMPT BUILDERS
    // =========================================================================
    
    private buildRevisionPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for planner role');
        }
        const basePrompt = role.promptTemplate;
        
        return `${basePrompt}

## Mode: REVISE
You are revising the plan based on user feedback.

### Plan File
Read and modify: ${this.planPath}

### User Feedback
${this.userFeedback}

### Instructions
1. Read the current plan using read_file
2. Make targeted changes to address the feedback
3. Preserve structure where possible
4. Update affected tasks and dependencies
5. Write the revised plan back to the same file`;
    }
    
    private buildReviewPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for analyst_implementation role');
        }
        const basePrompt = role.promptTemplate;
        
        return `${basePrompt}

## Files to Review
- Plan: ${this.planPath}
- Context: ${this.contextPath}

Read these files using read_file tool.

## User Feedback That Prompted This Revision
${this.userFeedback}

## Your Task
Review the revised plan and verify it addresses the user's feedback.

## How to Complete This Review
After reviewing, signal your verdict via CLI callback (see end of prompt):
- \`--result pass\` - Revision adequately addresses the feedback
- \`--result critical\` - Revision missed key points or introduced problems  
- \`--result minor\` - Has suggestions, but revision is acceptable

Include any issues or suggestions in the callback payload.`;
    }
    
    private buildFinalizationPrompt(role: AgentRole | undefined): string {
        const basePrompt = role?.promptTemplate || 'You are a Text Clerk agent for document formatting.';
        
        return `${basePrompt}

## Plan File
Read and modify: ${this.planPath}

## Codex Review Feedback
${this.analystOutput || 'No review feedback - just ensure formatting is correct.'}

## Instructions
1. Read the plan file using read_file
2. Ensure all tasks use checkbox format with GLOBAL IDs: - [ ] **${this.sessionId}_T{N}**: Description | Deps: ${this.sessionId}_TX | Engineer: TBD
3. Address any MINOR suggestions from the review (ignore CRITICAL - those need human review)
4. Update status to "📋 READY FOR REVIEW (Revised)"
5. Write the finalized plan back using write tool

## Important
- Do NOT change the plan content or strategy
- Only fix formatting and apply minor suggestions
- Be quick - this is a cleanup task

Note: CLI completion instructions with real session/workflow IDs are injected at runtime.`;
    }
    
    // =========================================================================
    // HELPER METHODS
    // =========================================================================
    
    private updatePlanStatus(): void {
        if (!fs.existsSync(this.planPath)) return;
        
        let content = fs.readFileSync(this.planPath, 'utf-8');
        
        content = content.replace(
            /\*\*Status:\*\*\s*.+/i,
            `**Status:** 📋 READY FOR REVIEW (Revised)`
        );
        
        fs.writeFileSync(this.planPath, content);
    }
}

