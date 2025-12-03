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
    
    // Reserved planner agent - kept for the entire workflow (not released between phases)
    private plannerAgentName: string | undefined;
    
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
        
        // Stream revised plan directly to plan file (commentary goes to log)
        const result = await this.runAgentTask('planner_revise', prompt, role, true);
        
        if (result.success) {
            // Plan was streamed to file; verify it exists
            if (!fs.existsSync(this.planPath)) {
                // Fallback: extract from output if streaming didn't produce plan
                const planContent = this.extractPlanFromOutput(result.output);
                fs.writeFileSync(this.planPath, planContent);
            }
            this.log('✓ Plan revised');
        } else {
            throw new Error('Planner revision task failed');
        }
    }
    
    private async executeReviewPhase(): Promise<void> {
        this.log('');
        this.log('🔍 PHASE: CODEX REVIEW');
        
        const role = this.getRole('analyst_architect');
        const prompt = this.buildReviewPrompt(role);
        
        this.log(`Running analyst_architect (${role?.defaultModel || 'gpt-5.1-codex-high'})...`);
        
        // Use CLI callback for structured completion
        const result = await this.runAgentTaskWithCallback(
            'analyst_architect_review',
            prompt,
            'analyst_architect',
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
                // Analyst failed - DON'T silently pass, mark as critical
                this.log('❌ Codex review FAILED - marking as CRITICAL (requires investigation)');
                this.analystVerdict = 'critical';
                this.analystOutput = `### Review Result: CRITICAL\n\n#### Critical Issues\n- Codex analyst failed to complete review\n- Error: ${result.payload?.error || 'Unknown error'}\n\n#### Minor Suggestions\n- None\n`;
            }
        }
    }
    
    private async executeFinalizePhase(): Promise<void> {
        this.log('');
        this.log('📋 PHASE: FINALIZATION');
        
        const role = this.getRole('planner');
        const prompt = this.buildFinalizationPrompt(role);
        
        this.log('Running planner finalization...');
        
        // Stream finalized plan directly to plan file
        const result = await this.runAgentTask('planner_finalize', prompt, role, true);
        
        if (result.success) {
            // Plan was streamed to file; verify it exists
            if (!fs.existsSync(this.planPath)) {
                // Fallback: extract from output if streaming didn't produce plan
                const planContent = this.extractPlanFromOutput(result.output);
                fs.writeFileSync(this.planPath, planContent);
            }
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
            throw new Error('Missing prompt template for analyst_architect role');
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

## REQUIRED Output Format
\`\`\`
### Review Result: [PASS|CRITICAL|MINOR]

#### Critical Issues
- [List blocking issues, or "None"]

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
        return `You are finalizing the revised execution plan.

## Plan File
Read and modify: ${this.planPath}

## Codex Review
${this.analystOutput || 'No review available'}

## Instructions
1. Read the plan file using read_file
2. Ensure all tasks use checkbox format: - [ ] **T{N}**: Description | Deps: X | Engineer: TBD
3. Address any minor suggestions from the review
4. Update status to "READY FOR REVIEW (Revised)"
5. Write the finalized plan back using write tool`;
    }
    
    // =========================================================================
    // HELPER METHODS
    // =========================================================================
    
    private async runAgentTask(
        taskId: string,
        prompt: string,
        role: AgentRole | undefined,
        streamToPlanFile: boolean = false
    ): Promise<{ success: boolean; output: string }> {
        const roleId = role?.id || 'planner';
        const isPlannerRole = roleId === 'planner';
        
        // For planner role, reuse the same agent across phases (don't release between phases)
        let agentName: string;
        if (isPlannerRole && this.plannerAgentName) {
            // Reuse existing planner agent (already in allocatedAgents)
            agentName = this.plannerAgentName;
            this.log(`Reusing reserved planner agent: ${agentName}`);
        } else {
            // Request a new agent from the pool
            agentName = await this.requestAgent(roleId);
            
            // Remember the planner agent for reuse across phases
            if (isPlannerRole) {
                this.plannerAgentName = agentName;
            }
        }
        
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs', 'agents');
        
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        // Use workflow ID + agent name for unique temp log file
        const logFile = path.join(logDir, `${this.id}_${agentName}.log`);
        
        try {
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
                planFile: streamToPlanFile ? this.planPath : undefined,
                timeoutMs: role?.timeoutMs || 600000,
                onProgress: (msg) => this.log(`  ${msg}`)
            };
            
            // Track agent run ID for pause handling
            this.currentAgentRunId = options.id;
            
            const agentRunId = options.id;
            const result = await this.agentRunner.run(options);
            
            this.currentAgentRunId = undefined;
            
            return {
                success: result.success,
                output: result.output
            };
        } finally {
            // Release analyst agents immediately - they're done
            // Demote planner agent to bench - it will wait for analyst feedback and potential revision loop
            if (!isPlannerRole) {
                this.releaseAgent(agentName);
            } else {
                this.demoteAgentToBench(agentName);
                this.log(`Planner agent ${agentName} moved to bench (waiting for analyst feedback)`);
            }
            
            // Don't delete log file - terminal may still be tailing it
            // Log files are cleaned up when session ends
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
    
    /**
     * Extract the actual plan content from agent output.
     * Agents often include reasoning/commentary before the plan - this extracts just the plan.
     */
    private extractPlanFromOutput(output: string): string {
        // Look for the start of actual plan content using common patterns
        const planStartPatterns = [
            // Plan title headers
            /^(#\s+[^\n]*(?:Plan|Migration|Implementation|Execution)[^\n]*)/mi,
            // Metadata line at start of plan
            /^(\*\*Project:\*\*)/mi,
            // Horizontal rule followed by header (common wrapper)
            /^(---\s*\n+#)/m,
            // Overview section
            /^(##\s+Overview)/mi,
            // Document metadata block
            /^(>\s*\*\*[A-Z])/m,
        ];
        
        for (const pattern of planStartPatterns) {
            const match = output.match(pattern);
            if (match && match.index !== undefined) {
                const extracted = output.substring(match.index);
                // Verify we extracted something substantial (at least 100 chars)
                if (extracted.length > 100) {
                    return extracted;
                }
            }
        }
        
        // Fallback: If output starts with commentary (lowercase sentence), 
        // try to find where the plan actually starts
        if (/^[a-z]/.test(output.trim())) {
            // Look for first markdown header
            const headerMatch = output.match(/^(#+ .+)/m);
            if (headerMatch && headerMatch.index !== undefined && headerMatch.index > 0) {
                const extracted = output.substring(headerMatch.index);
                if (extracted.length > 100) {
                    return extracted;
                }
            }
        }
        
        // Last resort: return as-is
        return output;
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

