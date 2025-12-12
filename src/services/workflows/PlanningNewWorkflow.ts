// ============================================================================
// PlanningNewWorkflow - Full planning loop: (Planner → Analysts)* → Finalize
// Note: Context phase removed - coordinator provides context via task metadata
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
import { AgentRole, getDefaultRole, AnalystVerdict } from '../../types';
import { ServiceLocator } from '../ServiceLocator';
import { TaskManager } from '../TaskManager';
import { PlanParser, PlanFormatValidationResult } from '../PlanParser';

/**
 * Planning workflow for creating new plans
 * 
 * Phases:
 * 1. planner - Initial plan creation
 * 2. analysts - Parallel analyst reviews
 * 3. (iteration) - Repeat planner → analysts if critical issues
 * 4. finalize - Finalize the plan
 * 
 * Note: Context phase removed - coordinator provides context via task metadata.
 * 
 * Max iterations: 3
 */
export class PlanningNewWorkflow extends BaseWorkflow {
    private static readonly PHASES = [
        'planner',
        'analysts',
        'finalize'
    ];
    
    private static readonly MAX_ITERATIONS = 3;
    
    // Planning state
    private planPath: string = '';
    private contextPath: string = '';
    private requirement: string = '';
    private docs: string[] = [];
    private complexity?: string;  // User-confirmed complexity level
    private iteration: number = 0;
    private analystOutputs: Record<string, string> = {};
    private analystResults: Record<string, AnalystVerdict> = {};
    private criticalIssues: string[] = [];
    private minorSuggestions: string[] = [];
    private forcedFinalize: boolean = false;
    
    // Track critical issues per analyst for fix-verification prompts
    // Key: roleId, Value: array of critical issues from that analyst
    private criticalIssuesByAnalyst: Record<string, string[]> = {};
    
    // Reserved planner agent - kept for the entire workflow (not released between phases)
    private plannerAgentName: string | undefined;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        
        // Extract input
        const input = config.input as PlanningWorkflowInput;
        this.requirement = input.requirement;
        this.docs = input.docs || [];
        this.complexity = input.complexity;
    }
    
    getPhases(): string[] {
        return PlanningNewWorkflow.PHASES;
    }
    
    async executePhase(phaseIndex: number): Promise<void> {
        const phase = this.getPhases()[phaseIndex];
        
        switch (phase) {
            case 'planner':
                await this.executePlannerPhase();
                break;
                
            case 'analysts':
                await this.executeAnalystsPhase();
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
            requirement: this.requirement,
            docs: this.docs,
            iteration: this.iteration,
            analystResults: this.analystResults,
            criticalIssues: this.criticalIssues,
            forcedFinalize: this.forcedFinalize
        };
    }
    
    protected getProgressMessage(): string {
        const phase = this.getPhases()[this.phaseIndex] || 'unknown';
        switch (phase) {
            case 'context':
                return 'Gathering project context...';
            case 'planner':
                return this.iteration === 0 
                    ? 'Creating initial plan...'
                    : `Updating plan (iteration ${this.iteration})...`;
            case 'analysts':
                return `Analyst reviews (iteration ${this.iteration})...`;
            case 'finalize':
                return this.forcedFinalize 
                    ? 'Finalizing plan (with warnings)...'
                    : 'Finalizing plan...';
            default:
                return 'Processing...';
        }
    }
    
    protected getOutput(): any {
        return {
            planPath: this.planPath,
            contextPath: this.contextPath,
            iterations: this.iteration,
            forcedFinalize: this.forcedFinalize,
            warnings: this.forcedFinalize ? this.criticalIssues : undefined
        };
    }
    
    // =========================================================================
    // PHASE IMPLEMENTATIONS
    // =========================================================================
    
    // Note: Context phase removed - coordinator provides context via task metadata
    // Context is now gathered separately via ContextGatheringWorkflow if needed
    
    private async executePlannerPhase(): Promise<void> {
        // Initialize paths on first iteration
        if (this.iteration === 0) {
            this.stateManager.ensurePlanDirectories(this.sessionId);
            this.planPath = this.stateManager.getPlanFilePath(this.sessionId);
            this.contextPath = path.join(
                this.stateManager.getPlanFolder(this.sessionId), 
                'context.md'
            );
            
            // Create initial plan file with header so users can see progressive output
            // Note: No Status field - session status is managed by PlanningSession.status in code
            const initialContent = `# Execution Plan

**Session ID:** ${this.sessionId}

**Requirement:** ${this.requirement.substring(0, 200)}${this.requirement.length > 200 ? '...' : ''}

---

*Plan content will appear below as the planner works...*

`;
            fs.writeFileSync(this.planPath, initialContent);
            
            // Update session's currentPlanPath immediately so GUI can show the file
            const session = this.stateManager.getPlanningSession(this.sessionId);
            if (session) {
                session.currentPlanPath = this.planPath;
                session.updatedAt = new Date().toISOString();
                this.stateManager.savePlanningSession(session);
            }
            
            this.log(`📄 Plan file created: ${this.planPath}`);
        }
        
        this.iteration++;
        
        this.log('');
        this.log(`📝 PHASE: PLANNER (iteration ${this.iteration}/${PlanningNewWorkflow.MAX_ITERATIONS})`);
        
        const role = this.getRole('planner');
        const mode = this.iteration === 1 ? 'create' : 'update';
        const prompt = this.buildPlannerPrompt(mode, role);
        
        this.log(`Running planner - ${mode.toUpperCase()} mode (tier: ${role?.defaultModel || 'high'})...`);
        
        // Reuse planner agent across iterations, or request new one
        if (!this.plannerAgentName) {
            this.plannerAgentName = await this.requestAgent('planner');
        }
        
        // Stream plan content directly to plan file (commentary goes to log)
        // Use CLI callback for structured completion
        const result = await this.runAgentTaskWithCallback(
            `planner_${mode}`,
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
            this.log(`✓ Plan ${mode === 'create' ? 'created' : 'updated'}`);
        } else {
            const error = result.payload?.error || result.payload?.message || 'Unknown error';
            throw new Error(`Planner ${mode} task failed: ${error}`);
        }
        
        // Demote planner to bench (may be needed for next iteration)
        this.demoteAgentToBench(this.plannerAgentName);
    }
    
    private async executeAnalystsPhase(): Promise<void> {
        this.log('');
        this.log('🔍 PHASE: ANALYST REVIEWS (parallel)');
        
        const allAnalystRoles = ['analyst_implementation', 'analyst_quality', 'analyst_architecture'];
        
        // In iteration 1, run all analysts with full review
        // In iteration 2+, only re-run analysts who had CRITICAL results
        const analystRolesToRun = this.iteration === 1
            ? allAnalystRoles
            : allAnalystRoles.filter(roleId => this.analystResults[roleId] === 'critical');
        
        if (analystRolesToRun.length === 0) {
            // All analysts passed or had minor issues - no need to re-run
            this.log('All analysts previously passed or had only minor issues - skipping re-review');
            this.log('✅ No critical issues - proceeding to finalization');
            return;
        }
        
        // Log which analysts are running
        if (this.iteration === 1) {
            this.log(`Starting ${analystRolesToRun.length} analysts: ${analystRolesToRun.join(', ')}`);
        } else {
            const skippedAnalysts = allAnalystRoles.filter(r => !analystRolesToRun.includes(r));
            this.log(`Re-running ${analystRolesToRun.length} analysts with critical issues: ${analystRolesToRun.join(', ')}`);
            if (skippedAnalysts.length > 0) {
                this.log(`Skipping ${skippedAnalysts.length} analysts who passed: ${skippedAnalysts.join(', ')}`);
            }
        }
        
        // Clear outputs only for analysts being re-run (preserve passed analysts' outputs)
        for (const roleId of analystRolesToRun) {
            delete this.analystOutputs[roleId];
        }
        
        // Run selected analysts in parallel
        const startTime = Date.now();
        await Promise.all(
            analystRolesToRun.map(roleId => this.runAnalystTask(roleId))
        );
        this.log(`Analysts completed in ${Date.now() - startTime}ms`);
        
        // Log summary (include all analysts, not just those who ran)
        this.log('Review Summary:');
        for (const roleId of allAnalystRoles) {
            const verdict = this.analystResults[roleId];
            const icon = verdict === 'pass' ? '✅' : verdict === 'critical' ? '❌' : '⚠️';
            const reRan = analystRolesToRun.includes(roleId);
            this.log(`  ${icon} ${roleId}: ${verdict.toUpperCase()}${!reRan && this.iteration > 1 ? ' (from previous iteration)' : ''}`);
        }
        
        // Check if we need to loop back to planner
        if (this.hasCriticalIssues() && this.iteration < PlanningNewWorkflow.MAX_ITERATIONS) {
            this.log('');
            this.log(`⚠️ Critical issues found - looping back to planner (iteration ${this.iteration + 1})`);
            // Move phase index back so it becomes 0 (planner) after runPhases increments
            this.phaseIndex = -1; // Will be incremented to 0 (planner) by runPhases
        } else if (this.hasCriticalIssues()) {
            // Max iterations reached - have analysts attempt to fix their own issues
            this.log('');
            this.log('⚠️ Max iterations reached - analysts will attempt to fix remaining issues directly');
            await this.runAnalystFixMode();
            this.forcedFinalize = true;
        } else {
            this.log('');
            this.log('✅ No critical issues - proceeding to finalization');
        }
    }
    
    /**
     * Run analysts in fix mode - they directly edit the plan to resolve their critical issues.
     * Only called when max iterations reached and critical issues remain.
     */
    private async runAnalystFixMode(): Promise<void> {
        const allAnalystRoles = ['analyst_implementation', 'analyst_quality', 'analyst_architecture'];
        
        // Only run fix mode for analysts who still have critical issues
        const analystsWithCritical = allAnalystRoles.filter(
            roleId => this.analystResults[roleId] === 'critical'
        );
        
        if (analystsWithCritical.length === 0) {
            return;
        }
        
        this.log('');
        this.log('🔧 ANALYST FIX MODE (parallel)');
        this.log(`${analystsWithCritical.length} analysts will attempt to fix their issues: ${analystsWithCritical.join(', ')}`);
        
        const startTime = Date.now();
        await Promise.all(
            analystsWithCritical.map(roleId => this.runAnalystFixTask(roleId))
        );
        this.log(`Analyst fixes completed in ${Date.now() - startTime}ms`);
    }
    
    /**
     * Run a single analyst in fix mode - they directly edit the plan.
     */
    private async runAnalystFixTask(roleId: string): Promise<void> {
        const role = this.getRole(roleId);
        
        if (!role) {
            this.log(`❌ ${roleId} - role not found for fix mode`);
            return;
        }
        
        const prompt = this.buildAnalystFixPrompt(roleId, role);
        
        this.log(`🔧 ${roleId} attempting fixes (tier: ${role?.defaultModel || 'high'})...`);
        
        const agentName = await this.requestAgent(roleId);
        
        try {
            const result = await this.runAgentTaskWithCallback(
                `${roleId}_fix`,
                prompt,
                roleId,
                {
                    expectedStage: 'fixing',
                    timeout: role?.timeoutMs || 300000,
                    model: role?.defaultModel,
                    cwd: this.stateManager.getWorkspaceRoot(),
                    agentName
                }
            );
            
            const fixResult = result.result || 'unknown';
            this.log(`✓ ${roleId} fix attempt complete: ${fixResult}`);
        } finally {
            this.releaseAgent(agentName);
        }
    }
    
    private static readonly MAX_FORMAT_ITERATIONS = 3;
    
    private async executeFinalizePhase(): Promise<void> {
        this.log('');
        this.log(`📋 PHASE: FINALIZATION${this.forcedFinalize ? ' (FORCED)' : ''}`);
        
        const role = this.getRole('text_clerk');
        let formatValidation: PlanFormatValidationResult | null = null;
        
        // Format validation loop - run text clerk, validate, repeat if errors (max 3 iterations)
        for (let formatIteration = 1; formatIteration <= PlanningNewWorkflow.MAX_FORMAT_ITERATIONS; formatIteration++) {
            const isRetry = formatIteration > 1;
            
            if (isRetry) {
                this.log(`🔄 Format fix iteration ${formatIteration}/${PlanningNewWorkflow.MAX_FORMAT_ITERATIONS}`);
            }
            
            // Build prompt - inject format errors if this is a retry
            const prompt = isRetry && formatValidation
                ? this.buildFormatFixPrompt(formatValidation, role)
                : this.buildFinalizationPrompt(this.forcedFinalize, role);
            
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
                
                if (formatIteration >= PlanningNewWorkflow.MAX_FORMAT_ITERATIONS) {
                    this.log(`⚠️ Max format fix iterations (${PlanningNewWorkflow.MAX_FORMAT_ITERATIONS}) reached. Proceeding with warnings.`);
                    // Don't throw - continue with the plan but log warnings
                }
            }
        }
        
        // Update session state (status is managed by session, not plan file)
        const session = this.stateManager.getPlanningSession(this.sessionId);
        if (session) {
            session.status = 'reviewing';
            session.currentPlanPath = this.planPath;
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
        }
    }
    
    // =========================================================================
    // PROMPT BUILDERS
    // =========================================================================
    
    private buildPlannerPrompt(mode: string, role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for planner role');
        }
        const basePrompt = role.promptTemplate;
        
        // Load the plan template path
        const templatePath = path.join(this.stateManager.getWorkspaceRoot(), 'resources/templates/skeleton_plan.md');
        const hasTemplate = fs.existsSync(templatePath);
        
        // Get existing plans context for cross-plan awareness
        const existingPlansContext = this.getExistingPlansContext();

        let modeInstructions = '';
        
        // Build complexity guidance
        const complexityRanges: Record<string, string> = {
            tiny: '1-3 tasks',
            small: '4-12 tasks',
            medium: '13-25 tasks',
            large: '26-50 tasks',
            huge: '51+ tasks'
        };
        const complexitySection = this.complexity
            ? `### Complexity Classification (USER CONFIRMED)
**Level:** ${this.complexity.toUpperCase()}
**Expected Task Range:** ${complexityRanges[this.complexity] || 'unknown'}

⚠️ IMPORTANT: You MUST create a plan with ${complexityRanges[this.complexity]}. This was confirmed by the user.`
            : `### Complexity Classification
No complexity level was specified. Analyze the requirement and determine the appropriate level:
- TINY (1-3 tasks): Single feature, minimal scope
- SMALL (4-12 tasks): Multi-feature but single system
- MEDIUM (13-25 tasks): Cross-system integration
- LARGE (26-50 tasks): Multi-system full product feature
- HUGE (51+ tasks): Complex full product, major initiative`;

        if (mode === 'create') {
            modeInstructions = `## Mode: CREATE
You are creating the initial plan.

### Requirement
${this.requirement}

${complexitySection}

### Files to Read
- Context (if exists): ${this.contextPath}
${hasTemplate ? `- Plan Template: ${templatePath}` : ''}

${existingPlansContext}

### Instructions
1. Read the context file if it exists
${hasTemplate ? '2. Read and follow the plan template structure' : '2. Create a detailed task breakdown'}
3. **CROSS-PLAN AWARENESS**: Check the existing plans above. If your tasks will modify files that existing tasks are also modifying, add cross-plan dependencies using the format: \`Deps: ps_XXXXXX_TN\`
4. **RESPECT COMPLEXITY**: Ensure task count matches the complexity level${this.complexity ? ` (${this.complexity.toUpperCase()}: ${complexityRanges[this.complexity]})` : ''}
5. Write the plan to: ${this.planPath}`;
        } else {
            modeInstructions = `## Mode: UPDATE
You are updating the plan based on analyst feedback.

### Files
- Current Plan: ${this.planPath}

### Analyst Feedback
${this.formatAnalystFeedback()}

### Instructions
1. Read the current plan
2. Address ALL Critical Issues raised by analysts
3. Consider Minor Suggestions  
4. Write the updated plan back to the same file`;
        }
        
        return `${basePrompt}

${modeInstructions}

## Plan Format
**Session ID:** ${this.sessionId}
**Complexity:** ${this.complexity ? this.complexity.toUpperCase() : 'To be determined'}${this.complexity ? ` (${complexityRanges[this.complexity]} expected)` : ''}

Use checkbox format with GLOBAL task IDs and Unity field:
- [ ] **${this.sessionId}_T1**: Description | Deps: None | Engineer: TBD | Unity: none
- [ ] **${this.sessionId}_T2**: Description | Deps: ${this.sessionId}_T1 | Engineer: TBD | Unity: full

Task ID format: ${this.sessionId}_T{N} (e.g., ${this.sessionId}_T1, ${this.sessionId}_T2, ${this.sessionId}_T3)
Unity pipeline options: none (skip), prep (compile only), prep_editmode (compile + EditMode tests), prep_playmode (compile + PlayMode tests), prep_playtest (compile + manual play), full (all tests)

Include sections: Overview, Task Breakdown (with complexity header), Dependencies, Risk Assessment`;
    }
    
    private buildFinalizationPrompt(forced: boolean, role: AgentRole | undefined): string {
        const basePrompt = role?.promptTemplate || 'You are a Text Clerk agent for document formatting.';
        
        const warnings = forced 
            ? `\n\n## WARNINGS (Max iterations reached)
Analysts attempted direct fixes for remaining critical issues.
Review the following areas that had unresolved issues:
${this.criticalIssues.map(i => `- ${i}`).join('\n') || '- None recorded'}` 
            : '';
        
        return `${basePrompt}

## Plan File
Read and modify: ${this.planPath}

## Analyst Feedback Summary
${this.formatAnalystFeedback()}
${warnings}

## Instructions
1. Read the plan file using read_file
2. Ensure all tasks use checkbox format with GLOBAL IDs: - [ ] **${this.sessionId}_T{N}**: Description | Deps: ${this.sessionId}_TX | Engineer: TBD
3. Address any MINOR suggestions (ignore CRITICAL - those need human review)
${forced ? '4. Add a WARNINGS section noting unresolved critical issues' : ''}
4. Write the finalized plan back using write tool

## Important
- Do NOT change the plan content or strategy
- Only fix formatting and apply minor suggestions
- Be fast and efficient
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
    
    private buildAnalystPrompt(roleId: string, role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error(`Missing prompt template for ${roleId} role`);
        }
        const basePrompt = role.promptTemplate;
        
        return `${basePrompt}

## Files to Review
- Plan: ${this.planPath}
- Context: ${this.contextPath}

Read these files using read_file tool, then provide your review.

## Verdict Options
- \`pass\` - Plan is solid, no significant issues
- \`critical\` - Blocking issues that must be fixed before proceeding
- \`minor\` - Has suggestions, but plan can proceed

Run the completion command when done with your verdict.`;
    }
    
    /**
     * Build a focused fix-verification prompt for subsequent iterations.
     * Only used for analysts who had critical issues - they verify if their specific issues were addressed.
     */
    private buildAnalystFixVerificationPrompt(roleId: string, role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error(`Missing prompt template for ${roleId} role`);
        }
        
        // Get the critical issues this analyst raised in the previous iteration
        const previousIssues = this.criticalIssuesByAnalyst[roleId] || [];
        
        return `You are ${role.name} performing a FOCUSED FIX VERIFICATION.

## Context
In the previous iteration, you reviewed this plan and found CRITICAL issues.
The planner has now updated the plan to address your concerns.

## Your Previous Critical Issues
${previousIssues.length > 0 
    ? previousIssues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')
    : '(No specific issues recorded - do a brief targeted review)'}

## Files to Review
- Updated Plan: ${this.planPath}

Read the plan using read_file tool.

## Your Task (FOCUSED VERIFICATION)
1. Check if EACH of your previous critical issues has been addressed
2. For each issue, determine: FIXED, PARTIALLY FIXED, or NOT FIXED
3. Only raise NEW critical issues if you find something seriously wrong that wasn't there before

## Verdict Options
- **pass** - All your previous critical issues are adequately addressed
- **minor** - Issues are mostly addressed, remaining concerns are non-blocking
- **critical** - One or more critical issues remain unaddressed

Run the completion command when done with your verdict.`;
    }
    
    /**
     * Build a fix prompt for analysts to directly edit the plan.
     * Used when max iterations reached and critical issues remain - analysts fix their own issues.
     */
    private buildAnalystFixPrompt(roleId: string, role: AgentRole | undefined): string {
        // Get the critical issues this analyst raised
        const myIssues = this.criticalIssuesByAnalyst[roleId] || [];
        
        return `You are ${role?.name || roleId} in DIRECT FIX MODE.

## Context
The planning loop has reached max iterations, but YOUR critical issues remain unresolved.
The planner was unable to fully address your concerns.
You are now authorized to DIRECTLY EDIT the plan to fix these issues.

## Your Unresolved Critical Issues
${myIssues.length > 0 
    ? myIssues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')
    : '(No specific issues recorded - review and fix any critical problems you find)'}

## Plan File
${this.planPath}

## Your Task (DIRECT FIX)
1. Read the plan using read_file
2. For EACH of your critical issues above:
   - Locate the relevant section in the plan
   - Make the minimal necessary changes to resolve the issue
   - Add a comment noting the fix: \`[Fixed by ${roleId}]: description\`
3. Write the updated plan back using the write tool

## Guidelines
- Make MINIMAL changes - only fix your specific issues
- Do NOT rewrite the entire plan or change unrelated sections
- Preserve existing task IDs and structure
- If you cannot fix an issue, add a note: \`[Cannot fix - ${roleId}]: reason\`
- Focus on correctness over perfection

## Result Options
- \`success\` - Made fixes to the plan
- \`partial\` - Fixed some issues, others could not be addressed
- \`failed\` - Could not make any fixes

Run the completion command when done.`;
    }
    
    /**
     * Format analyst output from callback payload for human-readable display
     */
    private formatAnalystOutput(roleId: string, verdict: string, issues: string[], suggestions: string[]): string {
        let output = `### Review Result: ${verdict.toUpperCase()}\n\n`;
        
        if (issues.length > 0) {
            output += '#### Issues\n';
            output += issues.map(i => `- ${i}`).join('\n') + '\n\n';
        }
        
        if (suggestions.length > 0) {
            output += '#### Suggestions\n';
            output += suggestions.map(s => `- ${s}`).join('\n') + '\n';
        }
        
        return output;
    }
    
    /**
     * Get context about existing plans and their tasks for cross-plan awareness
     * This helps the planner understand what other work is in progress and avoid conflicts
     */
    private getExistingPlansContext(): string {
        try {
            // Get all approved sessions
            const sessions = this.stateManager.getAllPlanningSessions()
                .filter(s => s.status === 'approved' && s.id !== this.sessionId);
            
            if (sessions.length === 0) {
                return '### Existing Plans\nNo other approved plans currently active.';
            }
            
            // Get TaskManager for task details
            const taskManager = ServiceLocator.resolve(TaskManager);
            
            let context = '### Existing Plans (CROSS-PLAN AWARENESS)\n\n';
            context += '**IMPORTANT**: If your tasks will modify files that existing tasks are also modifying,\n';
            context += 'you SHOULD add cross-plan dependencies using format: `Deps: ps_XXXXXX_TN`\n\n';
            
            for (const session of sessions) {
                context += `#### ${session.id}: ${session.requirement.substring(0, 100)}...\n`;
                
                // Get tasks for this session
                const tasks = taskManager.getTasksForSession(session.id);
                
                if (tasks.length === 0) {
                    context += '- No tasks created yet\n';
                } else {
                    // Show task summary with target files
                    const incompleteTasks = tasks.filter(t => 
                        t.status !== 'succeeded'  // Tasks are never 'failed' anymore
                    );
                    
                    for (const task of incompleteTasks.slice(0, 10)) {  // Limit to first 10
                        const files = task.targetFiles?.length 
                            ? `Files: ${task.targetFiles.join(', ')}`
                            : '';
                        context += `- **${task.id}** [${task.status}]: ${task.description.substring(0, 60)}... ${files}\n`;
                    }
                    
                    if (incompleteTasks.length > 10) {
                        context += `  ... and ${incompleteTasks.length - 10} more tasks\n`;
                    }
                }
                context += '\n';
            }
            
            return context;
        } catch (e) {
            // Don't fail planning if we can't get existing plans
            this.log(`Warning: Could not get existing plans context: ${e}`);
            return '### Existing Plans\nCould not retrieve existing plans context.';
        }
    }
    
    // =========================================================================
    // HELPER METHODS
    // =========================================================================
    
    private async runAnalystTask(roleId: string): Promise<void> {
        const role = this.getRole(roleId);
        
        if (!role) {
            this.log(`❌ ${roleId} - role not found in registry!`);
            this.analystResults[roleId] = 'critical';
            this.analystOutputs[roleId] = `### Review Result: CRITICAL\n\n#### Critical Issues\n- Role ${roleId} not found in registry\n`;
            this.criticalIssues.push(`[${roleId}] Role configuration missing from registry`);
            this.criticalIssuesByAnalyst[roleId] = ['Role configuration missing from registry'];
            return;
        }
        
        // Select prompt based on iteration:
        // - Iteration 1: Full review prompt
        // - Iteration 2+: Focused fix-verification prompt (only for analysts with previous critical issues)
        const isVerificationMode = this.iteration > 1 && this.analystResults[roleId] === 'critical';
        const prompt = isVerificationMode
            ? this.buildAnalystFixVerificationPrompt(roleId, role)
            : this.buildAnalystPrompt(roleId, role);
        
        const modeLabel = isVerificationMode ? 'fix-verification' : 'full review';
        this.log(`🚀 Starting ${roleId} (${modeLabel}, tier: ${role?.defaultModel || 'high'})...`);
        
        // Request agent BEFORE running task so we can release it after
        const agentName = await this.requestAgent(roleId);
        
        try {
            // Use CLI callback for structured completion
            // Note: roleId is already unique (e.g., 'analyst_implementation'), no need to add prefix
            const result = await this.runAgentTaskWithCallback(
                roleId,
                prompt,
                roleId,
                {
                    expectedStage: 'analysis',
                    timeout: role?.timeoutMs || 300000,
                    model: role?.defaultModel,
                    cwd: this.stateManager.getWorkspaceRoot(),
                    agentName  // Pass pre-allocated agent
                }
            );
            
            // Process agent result from output parsing
            const verdict = (result.result as AnalystVerdict) || 'pass';
            this.analystResults[roleId] = verdict;
            
            // Extract issues/suggestions from parsed payload
            const issues = result.payload?.issues || [];
            const suggestions = result.payload?.suggestions || [];
            
            if (verdict === 'critical' && issues.length > 0) {
                this.criticalIssues.push(...issues.map(i => `[${roleId}] ${i}`));
                // Track issues per analyst for fix-verification prompt in next iteration
                this.criticalIssuesByAnalyst[roleId] = issues;
            } else if (verdict !== 'critical') {
                // Clear tracked issues if analyst now passes or has only minor issues
                delete this.criticalIssuesByAnalyst[roleId];
            }
            
            if (suggestions.length > 0) {
                this.minorSuggestions.push(...suggestions.map(s => `[${roleId}] ${s}`));
            }
            
            // Build formatted output from payload
            const formattedOutput = this.formatAnalystOutput(roleId, verdict, issues, suggestions);
            this.analystOutputs[roleId] = formattedOutput;
            
            this.log(`✓ ${roleId} complete: ${verdict.toUpperCase()}`);
        } finally {
            // Release analyst agent immediately - analysts are one-shot tasks
            this.releaseAgent(agentName);
            this.log(`  Released analyst agent ${agentName}`);
        }
    }
    
    private hasCriticalIssues(): boolean {
        return Object.values(this.analystResults).includes('critical');
    }
    
    private formatAnalystFeedback(): string {
        const lines: string[] = [];
        
        for (const [roleId, output] of Object.entries(this.analystOutputs)) {
            const verdict = this.analystResults[roleId] || 'unknown';
            lines.push(`### ${roleId} (${verdict.toUpperCase()})`);
            lines.push(output.substring(0, 2000));
            lines.push('');
        }
        
        return lines.join('\n');
    }
    
}

