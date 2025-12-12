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
import { PlanParser, PlanFormatValidationResult } from '../PlanParser';
import { ServiceLocator } from '../ServiceLocator';
import { UnifiedCoordinatorService } from '../UnifiedCoordinatorService';

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
 * - Declares conflicts (cancels affected task workflows)
 * - Clears conflicts on completion
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
    
    // Analyst state - populated after review phase
    private analystOutputs: Record<string, string> = {};
    private analystResults: Record<string, AnalystVerdict> = {};
    
    // Impact analysis state
    private impactResult: RevisionImpactResult | null = null;
    private affectedTaskIds: string[] = [];
    private isGlobalRevision: boolean = false;
    
    // Analyst selection - determined by impact analysis in phase 1
    private requiredAnalysts: string[] = [];
    
    // Complexity handling
    private existingComplexity?: string;
    private newComplexity?: string;
    
    // Backup path - stores the path to the backup of the previous plan version
    private backupPath: string = '';
    
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
            analystResults: this.analystResults,
            affectedTaskIds: this.affectedTaskIds,
            isGlobalRevision: this.isGlobalRevision,
            requiredAnalysts: this.requiredAnalysts,
            existingComplexity: this.existingComplexity,
            newComplexity: this.newComplexity,
            backupPath: this.backupPath
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
        // Determine overall verdict from all analysts
        const verdicts = Object.values(this.analystResults);
        const overallVerdict: AnalystVerdict = verdicts.includes('critical') ? 'critical' 
            : verdicts.includes('minor') ? 'minor' : 'pass';
        
        return {
            planPath: this.planPath,
            contextPath: this.contextPath,
            reviewVerdict: overallVerdict,
            analystResults: this.analystResults,
            affectedTaskIds: this.affectedTaskIds,
            isGlobalRevision: this.isGlobalRevision,
            requiredAnalysts: this.requiredAnalysts,
            existingComplexity: this.existingComplexity,
            newComplexity: this.newComplexity,
            backupPath: this.backupPath
            // Note: Task reconciliation happens during plan approval, not here
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
     * Then declares conflicts with those tasks - the coordinator will cancel
     * any workflows working on affected tasks.
     * 
     * Also determines:
     * - Existing complexity from plan
     * - New complexity from feedback (if specified)
     * - Which analysts are needed for review
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
        
        // Extract existing complexity from plan
        this.existingComplexity = this.extractComplexityFromPlan();
        if (this.existingComplexity) {
            this.log(`📏 Existing complexity: ${this.existingComplexity.toUpperCase()}`);
        }
        
        // Check if feedback specifies a new complexity
        this.newComplexity = this.extractComplexityFromFeedback();
        if (this.newComplexity && this.newComplexity !== this.existingComplexity) {
            this.log(`📏 New complexity requested: ${this.newComplexity.toUpperCase()}`);
        }
        
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
        
        // Determine which analysts are needed based on impact
        this.requiredAnalysts = this.determineRequiredAnalysts();
        this.log(`🔍 Required analysts: ${this.requiredAnalysts.length > 0 ? this.requiredAnalysts.join(', ') : 'None (minor change)'}`);
        
        // Declare conflicts with affected tasks
        // The coordinator will cancel any workflows working on these tasks
        if (this.affectedTaskIds.length > 0 || this.isGlobalRevision) {
            const conflictTaskIds = this.isGlobalRevision 
                ? ['*'] // Special marker for global revision
                : this.affectedTaskIds;
            
            this.declareTaskConflicts(
                conflictTaskIds,
                'cancel_others',
                `Revision: ${this.userFeedback.substring(0, 50)}...`
            );
            
            this.log(`✓ Declared conflicts with ${this.affectedTaskIds.length} tasks`);
        } else {
            this.log('✓ No task conflicts detected - no workflows need to be cancelled');
        }
        
        this.log(`${'─'.repeat(60)}\n`);
    }
    
    /**
     * Extract complexity from existing plan file
     */
    private extractComplexityFromPlan(): string | undefined {
        if (!fs.existsSync(this.planPath)) {
            return undefined;
        }
        
        try {
            const content = fs.readFileSync(this.planPath, 'utf-8');
            // Look for **Complexity:** LEVEL pattern
            const match = content.match(/\*\*Complexity:\*\*\s*(\w+)/i);
            if (match) {
                const level = match[1].toLowerCase();
                const validLevels = ['tiny', 'small', 'medium', 'large', 'huge'];
                if (validLevels.includes(level)) {
                    return level;
                }
            }
        } catch (e) {
            // Ignore read errors
        }
        return undefined;
    }
    
    /**
     * Extract new complexity from user feedback
     */
    private extractComplexityFromFeedback(): string | undefined {
        const feedback = this.userFeedback.toLowerCase();
        
        // Look for explicit complexity change requests
        const complexityPatterns = [
            /change\s+complexity\s+to\s+(\w+)/i,
            /complexity[:\s]+(\w+)/i,
            /make\s+it\s+(tiny|small|medium|large|huge)/i,
            /--complexity\s+(\w+)/i
        ];
        
        for (const pattern of complexityPatterns) {
            const match = this.userFeedback.match(pattern);
            if (match) {
                const level = match[1].toLowerCase();
                const validLevels = ['tiny', 'small', 'medium', 'large', 'huge'];
                if (validLevels.includes(level)) {
                    return level;
                }
            }
        }
        
        return undefined;
    }
    
    /**
     * Determine which analysts are needed based on impact analysis
     * 
     * Logic:
     * - Global revision or complexity change → All 3 analysts
     * - Architecture-related keywords → Architecture analyst
     * - Implementation/code keywords → Implementation analyst
     * - Testing/quality keywords → Quality analyst
     * - Many tasks affected (>30%) → All 3 analysts
     * - Few tasks affected → Only implementation analyst
     */
    private determineRequiredAnalysts(): string[] {
        const analysts: Set<string> = new Set();
        const feedback = this.userFeedback.toLowerCase();
        
        // Global revision or complexity change → All analysts
        if (this.isGlobalRevision || (this.newComplexity && this.newComplexity !== this.existingComplexity)) {
            return ['analyst_architecture', 'analyst_implementation', 'analyst_quality'];
        }
        
        // Check for architecture-related keywords
        const architectureKeywords = [
            'architecture', 'structure', 'design', 'pattern', 'refactor',
            'dependency', 'dependencies', 'integration', 'system', 'module',
            'component', 'layer', 'interface', 'abstract', 'reorganize'
        ];
        if (architectureKeywords.some(kw => feedback.includes(kw))) {
            analysts.add('analyst_architecture');
        }
        
        // Check for implementation-related keywords
        const implementationKeywords = [
            'implement', 'code', 'function', 'method', 'class', 'logic',
            'algorithm', 'performance', 'optimize', 'bug', 'fix', 'add',
            'remove', 'change', 'update', 'modify'
        ];
        if (implementationKeywords.some(kw => feedback.includes(kw))) {
            analysts.add('analyst_implementation');
        }
        
        // Check for quality/testing keywords
        const qualityKeywords = [
            'test', 'testing', 'quality', 'validation', 'edge case',
            'error handling', 'coverage', 'unit test', 'integration test',
            'playmode', 'editmode'
        ];
        if (qualityKeywords.some(kw => feedback.includes(kw))) {
            analysts.add('analyst_quality');
        }
        
        // If many tasks affected (>30%), involve all analysts
        if (this.impactResult) {
            const totalTasks = this.impactResult.directlyAffected.length + 
                              this.impactResult.transitivelyAffected.length + 
                              this.impactResult.unaffected.length;
            const affectedRatio = this.affectedTaskIds.length / Math.max(totalTasks, 1);
            
            if (affectedRatio > 0.3) {
                return ['analyst_architecture', 'analyst_implementation', 'analyst_quality'];
            }
        }
        
        // If no specific analysts identified, default to implementation analyst
        if (analysts.size === 0) {
            analysts.add('analyst_implementation');
        }
        
        return Array.from(analysts);
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
        
        this.log(`Running planner revision (tier: ${role?.defaultModel || 'high'})...`);
        
        // Backup current plan BEFORE streaming starts (streaming will overwrite)
        // Store backups in dedicated backups folder to keep plan folder clean
        const backupsFolder = this.stateManager.getBackupsFolder(this.sessionId);
        if (!fs.existsSync(backupsFolder)) {
            fs.mkdirSync(backupsFolder, { recursive: true });
        }
        const backupFilename = `plan_backup_${Date.now()}.md`;
        this.backupPath = path.join(backupsFolder, backupFilename);
        fs.copyFileSync(this.planPath, this.backupPath);
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
        
        if (this.isAgentSuccess(result)) {
            // Plan was streamed to file; verify it exists
            if (!fs.existsSync(this.planPath)) {
                throw new Error(
                    `Plan streaming failed: expected plan file at '${this.planPath}' not created. ` +
                    `This indicates the agent did not properly stream the plan to the file. ` +
                    `Check agent logs for streaming errors.`
                );
            }
            this.log('✓ Plan revised');
        } else {
            const error = result.payload?.error || result.payload?.message || 'Unknown error';
            throw new Error(`Planner revision task failed: ${error}`);
        }
        
        // Demote planner to bench (may be needed for analyst feedback loop)
        this.demoteAgentToBench(this.plannerAgentName);
    }
    
    private async executeReviewPhase(): Promise<void> {
        this.log('');
        this.log('🔍 PHASE: ANALYST REVIEW');
        
        // If no analysts required (minor change), skip review
        if (this.requiredAnalysts.length === 0) {
            this.log('✓ No analyst review required (minor change)');
            return;
        }
        
        this.log(`Running ${this.requiredAnalysts.length} analyst(s): ${this.requiredAnalysts.join(', ')}`);
        
        // Run selected analysts in parallel
        const startTime = Date.now();
        await Promise.all(
            this.requiredAnalysts.map(roleId => this.runAnalystTask(roleId))
        );
        this.log(`Analysts completed in ${Date.now() - startTime}ms`);
        
        // Log summary
        this.log('Review Summary:');
        for (const roleId of this.requiredAnalysts) {
            const verdict = this.analystResults[roleId] || 'pass';
            const icon = verdict === 'pass' ? '✅' : verdict === 'critical' ? '❌' : '⚠️';
            this.log(`  ${icon} ${roleId}: ${verdict.toUpperCase()}`);
        }
    }
    
    /**
     * Run a single analyst review task
     */
    private async runAnalystTask(roleId: string): Promise<void> {
        const role = this.getRole(roleId);
        
        if (!role) {
            this.log(`❌ ${roleId} - role not found in registry!`);
            this.analystResults[roleId] = 'critical';
            this.analystOutputs[roleId] = `### Review Result: CRITICAL\n\n#### Critical Issues\n- Role ${roleId} not found in registry\n`;
            return;
        }
        
        const prompt = this.buildAnalystReviewPrompt(roleId, role);
        
        this.log(`🚀 Starting ${roleId} (tier: ${role?.defaultModel || 'high'})...`);
        
        // Request agent BEFORE running task so we can release it after
        const agentName = await this.requestAgent(roleId);
        
        try {
            // Use CLI callback for structured completion
            const result = await this.runAgentTaskWithCallback(
                `${roleId}_review`,
                prompt,
                roleId,
                {
                    expectedStage: 'analysis',
                    timeout: role?.timeoutMs || 300000,
                    model: role?.defaultModel,
                    cwd: this.stateManager.getWorkspaceRoot(),
                    agentName
                }
            );
            
            // Process agent result from output parsing
            const verdictMap: Record<string, AnalystVerdict> = {
                'pass': 'pass',
                'critical': 'critical',
                'minor': 'minor'
            };
            const verdict = verdictMap[result.result] || 'pass';
            this.analystResults[roleId] = verdict;
            
            // Build output from payload
            const issues = result.payload?.issues || [];
            const suggestions = result.payload?.suggestions || [];
            let output = `### Review Result: ${verdict.toUpperCase()}\n\n`;
            if (issues.length > 0) {
                output += '#### Issues\n' + issues.map((i: string) => `- ${i}`).join('\n') + '\n\n';
            }
            if (suggestions.length > 0) {
                output += '#### Suggestions\n' + suggestions.map((s: string) => `- ${s}`).join('\n') + '\n';
            }
            this.analystOutputs[roleId] = output;
            
            const icon = verdict === 'pass' ? '✅' : verdict === 'critical' ? '❌' : '⚠️';
            this.log(`${icon} ${roleId}: ${verdict.toUpperCase()}`);
        } catch (e) {
            this.log(`❌ ${roleId} failed: ${e}`);
            this.analystResults[roleId] = 'critical';
            this.analystOutputs[roleId] = `### Review Result: CRITICAL\n\n#### Critical Issues\n- Analyst failed: ${e}\n`;
        } finally {
            // Release analyst agent immediately
            this.releaseAgent(agentName);
        }
    }
    
    /**
     * Build analyst-specific review prompt
     */
    private buildAnalystReviewPrompt(roleId: string, role: AgentRole): string {
        const basePrompt = role?.promptTemplate || `You are the ${roleId} reviewing changes to a plan.`;
        
        return `${basePrompt}

## Context: REVISION REVIEW
You are reviewing a REVISED plan based on user feedback.

## Files to Review
- Plan: ${this.planPath}
- Context: ${this.contextPath}

Read these files using read_file tool.

## User Feedback That Prompted This Revision
${this.userFeedback}

## Impact Summary
- Affected tasks: ${this.affectedTaskIds.length}
- Global revision: ${this.isGlobalRevision ? 'Yes' : 'No'}
${this.newComplexity && this.newComplexity !== this.existingComplexity 
    ? `- Complexity change: ${this.existingComplexity?.toUpperCase() || 'unknown'} → ${this.newComplexity.toUpperCase()}`
    : `- Complexity: ${this.existingComplexity?.toUpperCase() || 'unchanged'}`}

## Your Task
Review the revised plan and verify it properly addresses the user's feedback.
Focus on your area of expertise as defined in your role.

## Verdict Options
- \`pass\` - Revision adequately addresses the feedback in your area
- \`critical\` - Revision has critical issues in your area that must be fixed
- \`minor\` - Has suggestions, but revision is acceptable

Run the completion command when done with your verdict.`;
    }
    
    private static readonly MAX_FORMAT_ITERATIONS = 3;
    
    private async executeFinalizePhase(): Promise<void> {
        this.log('');
        this.log('📋 PHASE: FINALIZATION');
        
        const role = this.getRole('text_clerk');
        let formatValidation: PlanFormatValidationResult | null = null;
        
        // Format validation loop - run text clerk, validate, repeat if errors (max 3 iterations)
        for (let formatIteration = 1; formatIteration <= PlanningRevisionWorkflow.MAX_FORMAT_ITERATIONS; formatIteration++) {
            const isRetry = formatIteration > 1;
            
            if (isRetry) {
                this.log(`🔄 Format fix iteration ${formatIteration}/${PlanningRevisionWorkflow.MAX_FORMAT_ITERATIONS}`);
            }
            
            // Build prompt - inject format errors if this is a retry
            const prompt = isRetry && formatValidation
                ? this.buildFormatFixPrompt(formatValidation, role)
                : this.buildFinalizationPrompt(role);
            
            this.log(`Running text_clerk ${isRetry ? 'format fix' : 'finalization'} (${role?.defaultModel || 'auto'})...`);
            
            // Use runAgentTaskWithCallback for proper completion signaling
            const result = await this.runAgentTaskWithCallback(
                isRetry ? `plan_format_fix_${formatIteration}` : 'plan_finalize',
                prompt,
                'text_clerk',
                {
                    expectedStage: 'finalization',
                    timeout: role?.timeoutMs || 120000,  // 2 minutes
                    model: role?.defaultModel,
                    cwd: this.stateManager.getWorkspaceRoot()
                }
            );
            
            this.log(`✓ ${isRetry ? 'Format fix' : 'Finalization'} completed: ${result.result}`);
            
            // Verify plan file exists
            if (!fs.existsSync(this.planPath)) {
                throw new Error(
                    `Plan finalization failed: expected plan file at '${this.planPath}' not found. ` +
                    `Check agent logs for errors.`
                );
            }
            
            // Run format validation
            this.log('📝 Validating plan format...');
            formatValidation = PlanParser.validatePlanFormatFromFile(this.planPath, this.sessionId);
            
            if (formatValidation.valid) {
                this.log(`✓ Plan format valid: ${formatValidation.validTaskCount} tasks parsed successfully`);
                break;  // Exit loop - format is valid
            } else {
                this.log(`⚠️ Format validation found ${formatValidation.errors.length} errors`);
                for (const error of formatValidation.errors.slice(0, 5)) {  // Show first 5
                    this.log(`  - Line ${error.line}: ${error.message}`);
                }
                if (formatValidation.errors.length > 5) {
                    this.log(`  ... and ${formatValidation.errors.length - 5} more errors`);
                }
                
                if (formatIteration >= PlanningRevisionWorkflow.MAX_FORMAT_ITERATIONS) {
                    this.log(`⚠️ Max format fix iterations (${PlanningRevisionWorkflow.MAX_FORMAT_ITERATIONS}) reached. Proceeding with warnings.`);
                }
            }
        }
        
        // Update session state - revision goes to 'reviewing' status
        // Task reconciliation happens during approval (via TaskAgent)
        const session = this.stateManager.getPlanningSession(this.sessionId);
        if (session) {
            session.status = 'reviewing';
            session.currentPlanPath = this.planPath;
            session.updatedAt = new Date().toISOString();
            
            // Update the previous version's path to point to the backup
            // This preserves the previous plan content in the backup file
            if (session.planHistory.length > 0 && this.backupPath) {
                const previousVersion = session.planHistory[session.planHistory.length - 1];
                previousVersion.path = this.backupPath;
                this.log(`Updated previous version ${previousVersion.version} path to backup: ${path.basename(this.backupPath)}`);
            }
            
            // Add the new version pointing to the current plan file
            session.planHistory.push({
                version: session.planHistory.length + 1,
                path: this.planPath,
                timestamp: new Date().toISOString()
            });
            
            this.stateManager.savePlanningSession(session);
        }
        
        // Clear conflicts - the coordinator will handle this via the onComplete event,
        // but we also clear our local state
        this.clearTaskConflicts();
        
        // Resume coordinator evaluations now that plan modification is complete
        try {
            const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
            coordinator.resumeEvaluations(this.sessionId);
        } catch (e) {
            this.log(`Warning: Failed to resume coordinator evaluations: ${e}`);
        }
        
        this.log(`\n${'═'.repeat(60)}`);
        this.log('✅ REVISION COMPLETE');
        this.log(`   Status: reviewing (requires approval)`);
        this.log(`   Affected tasks: ${this.affectedTaskIds.length}`);
        this.log(`   Plan updated: ${path.basename(this.planPath)}`);
        this.log(`   Next step: User must approve plan to trigger task reconciliation`);
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
        
        // Build complexity guidance
        const complexityRanges: Record<string, string> = {
            tiny: '1-3 tasks',
            small: '4-12 tasks',
            medium: '13-25 tasks',
            large: '26-50 tasks',
            huge: '51+ tasks'
        };
        
        let complexitySection = '';
        if (this.newComplexity && this.newComplexity !== this.existingComplexity) {
            // Complexity is changing
            complexitySection = `### Complexity Change
**Previous:** ${this.existingComplexity?.toUpperCase() || 'Not specified'} (${this.existingComplexity ? complexityRanges[this.existingComplexity] : 'unknown'})
**New:** ${this.newComplexity.toUpperCase()} (${complexityRanges[this.newComplexity]})

⚠️ IMPORTANT: Adjust task count to match new complexity level.
- Add tasks if moving to higher complexity
- Consolidate/remove tasks if moving to lower complexity`;
        } else if (this.existingComplexity) {
            // Keep existing complexity
            complexitySection = `### Complexity (Unchanged)
**Level:** ${this.existingComplexity.toUpperCase()} (${complexityRanges[this.existingComplexity]})

Maintain task count within the existing complexity bounds.`;
        }
        
        return `${basePrompt}

## Mode: REVISE
You are revising the plan based on user feedback.

### Plan File
Read and modify: ${this.planPath}

### User Feedback
${this.userFeedback}

${complexitySection}

### Impact Summary
- Tasks directly affected: ${this.impactResult?.directlyAffected.length || 0}
- Tasks transitively affected: ${this.impactResult?.transitivelyAffected.length || 0}
- Global revision: ${this.isGlobalRevision ? 'Yes (all tasks affected)' : 'No'}

### Instructions
1. Read the current plan using read_file
2. Make targeted changes to address the feedback
3. ${this.newComplexity && this.newComplexity !== this.existingComplexity 
    ? 'Adjust task count to match new complexity level' 
    : 'Preserve structure and task count where possible'}
4. Update affected tasks and dependencies
5. Use subtask naming for task breakdown: T3 → T3A, T3B, T3C
6. Write the revised plan back to the same file`;
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

## Verdict Options
- \`pass\` - Revision adequately addresses the feedback
- \`critical\` - Revision missed key points or introduced problems  
- \`minor\` - Has suggestions, but revision is acceptable

Run the completion command when done with your verdict.`;
    }
    
    /**
     * Format analyst feedback for finalization prompt
     */
    private formatAnalystFeedback(): string {
        if (Object.keys(this.analystOutputs).length === 0) {
            return 'No analyst review was required for this revision.';
        }
        
        let feedback = '';
        for (const [roleId, output] of Object.entries(this.analystOutputs)) {
            const verdict = this.analystResults[roleId] || 'pass';
            const icon = verdict === 'pass' ? '✅' : verdict === 'critical' ? '❌' : '⚠️';
            feedback += `\n### ${icon} ${roleId}\n${output}\n`;
        }
        return feedback;
    }
    
    private buildFinalizationPrompt(role: AgentRole | undefined): string {
        const basePrompt = role?.promptTemplate || 'You are a Text Clerk agent for document formatting.';
        
        return `${basePrompt}

## Plan File
Read and modify: ${this.planPath}

## Analyst Review Feedback
${this.formatAnalystFeedback()}

## Instructions
1. Read the plan file using read_file
2. Ensure all tasks use checkbox format with GLOBAL IDs: - [ ] **${this.sessionId}_T{N}**: Description | Deps: ${this.sessionId}_TX | Engineer: TBD | Unity: none|prep|prep_editmode|prep_playmode|full
3. Subtask IDs use letter suffix: ${this.sessionId}_T3A, ${this.sessionId}_T3B, etc.
4. Address any MINOR suggestions from the review (ignore CRITICAL - those need human review)
5. Update status to "📋 READY FOR REVIEW (Revised)"
6. Write the finalized plan back using write tool

## Important
- Do NOT change the plan content or strategy
- Only fix formatting and apply minor suggestions
- Be quick - this is a cleanup task
- Run the completion command when done`;
    }
    
    /**
     * Build a prompt specifically for fixing format errors.
     * Used when format validation fails after initial finalization.
     */
    private buildFormatFixPrompt(validation: PlanFormatValidationResult, role: AgentRole | undefined): string {
        const basePrompt = role?.promptTemplate || 'You are a Text Clerk agent for document formatting.';
        const formattedErrors = PlanParser.formatValidationErrorsForPrompt(validation);
        
        return `${basePrompt}

## 🚨 FORMAT FIX REQUIRED

The plan file has **${validation.errors.length} format errors** that MUST be fixed before the plan can be processed.

## Plan File
Read and modify: ${this.planPath}

${formattedErrors}

## Required Task ID Format
All task IDs MUST follow this format:
- **Simple**: \`${this.sessionId}_T1\`, \`${this.sessionId}_T2\`, etc.
- **Sub-task**: \`${this.sessionId}_T7A\`, \`${this.sessionId}_T7B\` (single letter suffix)
- **With suffix**: \`${this.sessionId}_T24_EVENTS\`, \`${this.sessionId}_T15_TEST\` (underscore before suffix!)

❌ **INVALID**: \`${this.sessionId}_T24EVENTS\` (missing underscore before suffix)
✅ **VALID**: \`${this.sessionId}_T24_EVENTS\` (underscore separates number from suffix)

## Full Task Line Format
\`\`\`
- [ ] **${this.sessionId}_T1**: Task description | Deps: None | Engineer: TBD | Unity: none
- [ ] **${this.sessionId}_T2**: Another task | Deps: ${this.sessionId}_T1 | Engineer: TBD | Unity: prep_editmode
\`\`\`

## Instructions
1. Read the plan file
2. Fix ALL the format errors listed above
3. Ensure every task ID follows the correct format
4. Write the fixed plan back to the same file

## Critical Rules
- FIX ONLY FORMAT ERRORS - do not change task content or descriptions
- Every task must have the session prefix: \`${this.sessionId}_\`
- Suffixes like EVENTS, TEST, PLAYMODE need underscore: \`_EVENTS\` not \`EVENTS\`
- Be thorough - fix ALL errors, not just some
- Run the completion command when done`;
    }
    
}

