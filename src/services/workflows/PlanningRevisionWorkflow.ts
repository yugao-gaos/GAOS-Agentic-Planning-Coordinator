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
import { AgentRunner, AgentRunOptions } from '../AgentBackend';
import { RevisionImpactAnalyzer, RevisionImpactResult } from '../RevisionImpactAnalyzer';
import { AgentRole, getDefaultRole, AnalystVerdict } from '../../types';
import { ServiceLocator } from '../ServiceLocator';

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
    
    private agentRunner: AgentRunner;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
        
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
        
        const result = await this.runAgentTask('planner_revise', prompt, role);
        
        if (result.success && result.output) {
            // Backup current plan before overwriting
            const backupPath = this.planPath.replace('.md', `_backup_${Date.now()}.md`);
            fs.copyFileSync(this.planPath, backupPath);
            
            fs.writeFileSync(this.planPath, result.output);
            this.log('✓ Plan revised');
        } else {
            throw new Error('Planner revision task failed');
        }
    }
    
    private async executeReviewPhase(): Promise<void> {
        this.log('');
        this.log('🔍 PHASE: CODEX REVIEW');
        
        const role = this.getRole('analyst_codex');
        const prompt = this.buildReviewPrompt(role);
        
        this.log(`Running analyst_codex (${role?.defaultModel || 'sonnet-4.5'})...`);
        
        // Use CLI callback for structured completion
        const result = await this.runAgentTaskWithCallback(
            'analyst_codex_review',
            prompt,
            'analyst_codex',
            {
                expectedStage: 'analysis',
                timeout: role?.timeoutMs || 300000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot()
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
            this.analystOutput = result.rawOutput || `Review Result: ${this.analystVerdict.toUpperCase()}`;
            
            const icon = this.analystVerdict === 'pass' ? '✅' 
                : this.analystVerdict === 'critical' ? '❌' : '⚠️';
            this.log(`${icon} Codex verdict via CLI callback: ${this.analystVerdict.toUpperCase()}`);
        } else {
            // Fallback: parse output
            if (result.success && result.rawOutput) {
                this.analystOutput = result.rawOutput;
                this.parseAnalystResult();
                
                const icon = this.analystVerdict === 'pass' ? '✅' 
                    : this.analystVerdict === 'critical' ? '❌' : '⚠️';
                this.log(`${icon} Codex verdict via output parsing: ${this.analystVerdict.toUpperCase()}`);
            } else {
                this.log('⚠️ Codex review failed, treating as pass');
                this.analystVerdict = 'pass';
                this.analystOutput = '';
            }
        }
    }
    
    private async executeFinalizePhase(): Promise<void> {
        this.log('');
        this.log('📋 PHASE: FINALIZATION');
        
        const role = this.getRole('planner');
        const prompt = this.buildFinalizationPrompt(role);
        
        this.log('Running planner finalization...');
        
        const result = await this.runAgentTask('planner_finalize', prompt, role);
        
        if (result.success && result.output) {
            fs.writeFileSync(this.planPath, result.output);
            this.log('✓ Revision finalized');
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
        
        const existingContent = fs.readFileSync(this.planPath, 'utf-8');
        
        return `${basePrompt}

## Mode: REVISE
You are revising the plan based on user feedback.

### Current Plan
${existingContent}

### User Feedback
${this.userFeedback}

### Instructions
1. Make targeted changes to address the feedback
2. Preserve structure where possible
3. Update affected tasks and dependencies
4. Keep task IDs consistent where possible (only change if necessary)

## Output
Provide the COMPLETE revised plan in markdown format with proper task checkbox format.`;
    }
    
    private buildReviewPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for analyst_codex role');
        }
        const basePrompt = role.promptTemplate;
        
        const planContent = fs.readFileSync(this.planPath, 'utf-8');
        
        const contextContent = fs.existsSync(this.contextPath) 
            ? fs.readFileSync(this.contextPath, 'utf-8') 
            : '';
        
        return `${basePrompt}

## Revised Plan to Review
${planContent}

## Project Context
${contextContent}

## User Feedback That Prompted This Revision
${this.userFeedback}

## Your Task
Review the revised plan and verify it addresses the user's feedback.

## REQUIRED Output Format
You MUST output your review in this EXACT format:

\`\`\`
### Review Result: [PASS|CRITICAL|MINOR]

#### Critical Issues
- [List blocking issues that MUST be fixed, or "None"]

#### Minor Suggestions
- [List optional improvements, or "None"]

#### Feedback Addressed
[Verify the user's feedback was properly addressed]
\`\`\`

## Verdict Guidelines
- **PASS**: Revision adequately addresses the feedback
- **CRITICAL**: Revision missed key points or introduced problems
- **MINOR**: Suggestions only, revision is acceptable`;
    }
    
    private buildFinalizationPrompt(role: AgentRole | undefined): string {
        const existingContent = fs.readFileSync(this.planPath, 'utf-8');
        
        return `You are finalizing the revised execution plan.

## Current Plan
${existingContent}

## Codex Review
${this.analystOutput || 'No review available'}

## Instructions
1. Ensure all tasks use checkbox format: - [ ] **T{N}**: Description | Deps: X | Engineer: TBD
2. Address any minor suggestions from the review
3. Update the status to "READY FOR REVIEW (Revised)"
4. Clean up any formatting issues

## Output
Provide the FINAL revised plan in markdown format.`;
    }
    
    // =========================================================================
    // HELPER METHODS
    // =========================================================================
    
    private async runAgentTask(
        taskId: string,
        prompt: string,
        role: AgentRole | undefined
    ): Promise<{ success: boolean; output: string }> {
        // Request an agent from the pool
        const roleId = role?.id || 'planner';
        const agentName = await this.requestAgent(roleId);
        
        try {
            const workspaceRoot = this.stateManager.getWorkspaceRoot();
            const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs');
            
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            
            const logFile = path.join(logDir, `${taskId}_${Date.now()}.log`);
            
            // Prepend continuation context if we were paused mid-task
            const continuationPrompt = this.getContinuationPrompt();
            const fullPrompt = continuationPrompt 
                ? `${continuationPrompt}\n\n---\n\n${prompt}`
                : prompt;
            
            // Clear continuation context after using it
            if (continuationPrompt) {
                this.clearContinuationContext();
            }
            
            const options: AgentRunOptions = {
                id: `revision_${this.sessionId}_${taskId}`,
                prompt: fullPrompt,
                cwd: workspaceRoot,
                model: role?.defaultModel || 'sonnet-4.5',
                logFile,
                timeoutMs: role?.timeoutMs || 600000,
                onProgress: (msg) => this.log(`  ${msg}`)
            };
            
            // Track agent run ID for pause handling
            this.currentAgentRunId = options.id;
            
            const result = await this.agentRunner.run(options);
            
            this.currentAgentRunId = undefined;
            
            return {
                success: result.success,
                output: result.output
            };
        } finally {
            // Always release the agent back to the pool
            this.releaseAgent(agentName);
        }
    }
    
    private parseAnalystResult(): void {
        const verdictMatch = this.analystOutput.match(
            /###?\s*Review\s*Result:\s*(PASS|CRITICAL|MINOR)/i
        );
        this.analystVerdict = verdictMatch 
            ? verdictMatch[1].toLowerCase() as AnalystVerdict 
            : 'pass';
    }
    
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

