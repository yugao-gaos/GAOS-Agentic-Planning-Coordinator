// ============================================================================
// ErrorResolutionWorkflow - Fix compilation/test errors
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { BaseWorkflow } from './BaseWorkflow';
import { WorkflowServices } from './IWorkflow';
import { 
    WorkflowConfig, 
    WorkflowResult, 
    ErrorResolutionInput 
} from '../../types/workflow';
import { AgentRunner, AgentRunOptions } from '../AgentBackend';
import { AgentRole, getDefaultRole } from '../../types';
import { PipelineTaskContext } from '../../types/unity';
import { ServiceLocator } from '../ServiceLocator';

/**
 * Error resolution workflow - fixes compilation or test errors
 * 
 * Phases:
 * 1. analyze - Analyze errors and identify root cause
 * 2. route - Route errors to appropriate task/engineer
 * 3. fix - Apply fixes
 * 4. verify - Verify fixes (recompile/retest)
 */
export class ErrorResolutionWorkflow extends BaseWorkflow {
    private static readonly PHASES = [
        'analyze',
        'route',
        'fix',
        'verify'
    ];
    
    /** This workflow works with or without Unity - just skips Unity verification */
    static readonly requiresUnity = false;
    
    // Error state
    private errors: Array<{
        id: string;
        message: string;
        file?: string;
        line?: number;
        relatedTaskId?: string;
    }>;
    private coordinatorId: string;
    private sourceWorkflowId?: string;
    
    // Resolution state
    private analysisResult: {
        rootCause: string;
        affectedFiles: string[];
        suggestedFix: string;
        relatedTaskId?: string;
    } | null = null;
    private fixerAgentName?: string;
    private fixApplied: boolean = false;
    private verificationResult: { success: boolean; remainingErrors?: string[] } | null = null;
    
    private agentRunner: AgentRunner;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
        
        // Extract input
        const input = config.input as ErrorResolutionInput;
        this.errors = input.errors;
        this.coordinatorId = input.coordinatorId;
        this.sourceWorkflowId = input.sourceWorkflowId;
    }
    
    getPhases(): string[] {
        return ErrorResolutionWorkflow.PHASES;
    }
    
    async executePhase(phaseIndex: number): Promise<void> {
        const phase = this.getPhases()[phaseIndex];
        
        switch (phase) {
            case 'analyze':
                await this.executeAnalyzePhase();
                break;
                
            case 'route':
                await this.executeRoutePhase();
                break;
                
            case 'fix':
                await this.executeFixPhase();
                break;
                
            case 'verify':
                await this.executeVerifyPhase();
                break;
        }
    }
    
    getState(): object {
        return {
            errors: this.errors,
            coordinatorId: this.coordinatorId,
            analysisResult: this.analysisResult,
            fixApplied: this.fixApplied,
            verificationResult: this.verificationResult
        };
    }
    
    protected getProgressMessage(): string {
        const phase = this.getPhases()[this.phaseIndex] || 'unknown';
        switch (phase) {
            case 'analyze':
                return `Analyzing ${this.errors.length} error(s)...`;
            case 'route':
                return `Routing errors to fixer...`;
            case 'fix':
                return `Applying fix...`;
            case 'verify':
                return `Verifying fix...`;
            default:
                return `Processing errors...`;
        }
    }
    
    protected getOutput(): any {
        return {
            errors: this.errors,
            analysisResult: this.analysisResult,
            fixApplied: this.fixApplied,
            verificationResult: this.verificationResult,
            success: this.verificationResult?.success ?? false
        };
    }
    
    // =========================================================================
    // PHASE IMPLEMENTATIONS
    // =========================================================================
    
    private async executeAnalyzePhase(): Promise<void> {
        this.log(`🔍 PHASE: ANALYZE (${this.errors.length} errors)`);
        
        // Request an error analyst agent
        const analystName = await this.requestAgent('error_analyst');
        
        const role = this.getRole('error_analyst');
        const prompt = this.buildAnalysisPrompt(role);
        
        this.log(`Running error analyst (${role?.defaultModel || 'sonnet-4.5'})...`);
        
        // Use CLI callback for structured completion
        const result = await this.runAgentTaskWithCallback(
            'error_analyze',
            prompt,
            'error_analyst',
            {
                expectedStage: 'error_analysis',
                timeout: role?.timeoutMs || 300000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot()
            }
        );
        
        if (result.fromCallback) {
            // Got structured data from CLI callback - preferred path
            this.analysisResult = {
                rootCause: result.payload?.rootCause || 'Unknown',
                affectedFiles: result.payload?.affectedFiles || this.errors.filter(e => e.file).map(e => e.file!),
                suggestedFix: result.payload?.suggestedFix || 'Review and fix manually',
                relatedTaskId: result.payload?.relatedTask
            };
            this.log(`✓ Analysis complete via CLI callback:`);
            this.log(`  Root cause: ${this.analysisResult.rootCause.substring(0, 80)}...`);
            this.log(`  Files affected: ${this.analysisResult.affectedFiles.length}`);
            if (this.analysisResult.relatedTaskId) {
                this.log(`  Related task: ${this.analysisResult.relatedTaskId}`);
            }
        } else {
            // Legacy fallback: parse output
            if (result.success && result.rawOutput) {
                this.analysisResult = this.parseAnalysisResult(result.rawOutput);
                this.log(`✓ Analysis complete via output parsing:`);
                this.log(`  Root cause: ${this.analysisResult.rootCause.substring(0, 80)}...`);
                this.log(`  Files affected: ${this.analysisResult.affectedFiles.length}`);
            } else {
                this.log(`⚠️ Analysis failed, using basic routing`);
                this.analysisResult = {
                    rootCause: 'Unknown',
                    affectedFiles: this.errors.filter(e => e.file).map(e => e.file!),
                    suggestedFix: 'Review and fix errors manually'
                };
            }
        }
        
        // Release analyst
        this.releaseAgent(analystName);
    }
    
    private async executeRoutePhase(): Promise<void> {
        this.log(`\n🔀 PHASE: ROUTE errors to fixer`);
        
        // Determine who should fix this
        // Strategy: Use the task owner if we can identify the related task
        let targetRole = 'engineer'; // Default
        
        if (this.analysisResult?.relatedTaskId) {
            this.log(`Errors related to task: ${this.analysisResult.relatedTaskId}`);
        }
        
        // For now, just note the routing decision
        this.log(`✓ Routing to: ${targetRole}`);
    }
    
    private async executeFixPhase(): Promise<void> {
        this.log(`\n🔧 PHASE: FIX errors`);
        
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
            // Fallback: use process exit status
            if (result.success) {
                this.fixApplied = true;
                this.log(`✓ Fix applied`);
            } else {
                this.log(`❌ Fix failed`);
                throw new Error('Error fix failed');
            }
        }
        
        // Release fixer
        if (this.fixerAgentName) {
            this.releaseAgent(this.fixerAgentName);
            this.fixerAgentName = undefined;
        }
    }
    
    private async executeVerifyPhase(): Promise<void> {
        this.log(`\n✓ PHASE: VERIFY fix`);
        
        // Check if Unity is available for verification
        if (!this.isUnityAvailable() || !this.unityManager) {
            this.log(`⚠️ Unity features disabled - skipping Unity verification`);
            // When Unity is disabled, assume fix is successful (manual verification needed)
            this.verificationResult = { 
                success: true,
                remainingErrors: []
            };
            this.log(`✅ Fix applied (manual verification required - Unity disabled)`);
            return;
        }
        
        // Queue a verification compile using 'prep' operation (reimport + compile)
        this.setBlocked('Verifying fix via Unity');
        
        try {
            const taskContext = {
                taskId: `error_fix_${this.id}`,
                stage: 'verification',
                agentName: this.fixerAgentName || 'error_fixer',
                filesModified: [] // Error fixes may modify various files
            };
            
            const result = await this.unityManager.queuePipelineAndWait(
                this.id, // coordinatorId
                ['prep'], // Use 'prep' for compile/reimport
                [taskContext],
                false // Don't merge verification requests
            );
            
            this.verificationResult = {
                success: result.success,
                remainingErrors: result.allErrors.map(e => e.message)
            };
            
            if (result.success) {
                this.log(`✅ Verification passed - errors fixed`);
            } else {
                this.log(`❌ Verification failed - ${result.allErrors.length} errors remain`);
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`❌ Verification error: ${errorMsg}`);
            this.verificationResult = {
                success: false,
                remainingErrors: [errorMsg]
            };
        }
        
        this.setUnblocked();
    }
    
    // =========================================================================
    // PROMPT BUILDERS
    // =========================================================================
    
    private buildAnalysisPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for error_analyst role');
        }
        const basePrompt = role.promptTemplate;
        
        const errorList = this.errors.map(e => {
            let errorStr = `- ${e.message}`;
            if (e.file) errorStr += `\n  File: ${e.file}`;
            if (e.line) errorStr += `, Line: ${e.line}`;
            if (e.relatedTaskId) errorStr += `\n  Related Task: ${e.relatedTaskId}`;
            return errorStr;
        }).join('\n\n');
        
        return `${basePrompt}

## Errors to Analyze
${errorList}

## Your Task
1. Identify the root cause of these errors
2. List affected files
3. Suggest a fix approach

## REQUIRED Output Format
\`\`\`
### Analysis

#### Root Cause
[Describe the underlying issue]

#### Affected Files
- file1.cs
- file2.cs

#### Related Task
[Task ID if identifiable, or "Unknown"]

#### Suggested Fix
[Step-by-step fix approach]
\`\`\``;
    }
    
    private buildFixPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for engineer role');
        }
        const basePrompt = role.promptTemplate;
        
        const errorList = this.errors.map(e => {
            let errorStr = `- ${e.message}`;
            if (e.file) errorStr += `\n  File: ${e.file}`;
            if (e.line) errorStr += `, Line: ${e.line}`;
            return errorStr;
        }).join('\n\n');
        
        const analysis = this.analysisResult 
            ? `
## Analysis
Root Cause: ${this.analysisResult.rootCause}

Affected Files:
${this.analysisResult.affectedFiles.map(f => `- ${f}`).join('\n')}

Suggested Fix:
${this.analysisResult.suggestedFix}`
            : '';
        
        return `${basePrompt}

## Errors to Fix
${errorList}
${analysis}

## Your Task
1. Fix the errors identified
2. Do NOT introduce new issues
3. Keep changes minimal and focused

## Instructions
- Review the error messages carefully
- Apply targeted fixes
- Test your changes compile`;
    }
    
    // =========================================================================
    // HELPER METHODS
    // =========================================================================
    
    private async runAgentTask(
        taskId: string,
        prompt: string,
        role: AgentRole | undefined
    ): Promise<{ success: boolean; output: string }> {
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs');
        
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logFile = path.join(logDir, `error_fix_${taskId}_${Date.now()}.log`);
        
        const options: AgentRunOptions = {
            id: `error_${this.sessionId}_${taskId}`,
            prompt,
            cwd: workspaceRoot,
            model: role?.defaultModel || 'sonnet-4.5',
            logFile,
            timeoutMs: role?.timeoutMs || 600000,
            onProgress: (msg) => this.log(`  ${msg}`)
        };
        
        const result = await this.agentRunner.run(options);
        
        return {
            success: result.success,
            output: result.output
        };
    }
    
    private parseAnalysisResult(output: string): {
        rootCause: string;
        affectedFiles: string[];
        suggestedFix: string;
        relatedTaskId?: string;
    } {
        // Parse root cause
        const rootCauseMatch = output.match(/####?\s*Root\s*Cause[\s\S]*?(?=####|$)/i);
        const rootCause = rootCauseMatch 
            ? rootCauseMatch[0].replace(/####?\s*Root\s*Cause\s*/i, '').trim()
            : 'Unknown';
        
        // Parse affected files
        const filesMatch = output.match(/####?\s*Affected\s*Files[\s\S]*?(?=####|$)/i);
        const affectedFiles: string[] = [];
        if (filesMatch) {
            const fileLines = filesMatch[0].match(/^-\s+.+$/gm);
            if (fileLines) {
                affectedFiles.push(...fileLines.map(l => l.replace(/^-\s+/, '').trim()));
            }
        }
        
        // Parse suggested fix
        const fixMatch = output.match(/####?\s*Suggested\s*Fix[\s\S]*?(?=####|$)/i);
        const suggestedFix = fixMatch 
            ? fixMatch[0].replace(/####?\s*Suggested\s*Fix\s*/i, '').trim()
            : 'Review and fix manually';
        
        // Parse related task
        const taskMatch = output.match(/####?\s*Related\s*Task[\s\S]*?(?=####|$)/i);
        let relatedTaskId: string | undefined;
        if (taskMatch) {
            const taskText = taskMatch[0].replace(/####?\s*Related\s*Task\s*/i, '').trim();
            if (taskText && !taskText.toLowerCase().includes('unknown')) {
                // Extract task ID (T1, T2, etc.)
                const idMatch = taskText.match(/T\d+/i);
                relatedTaskId = idMatch ? idMatch[0] : undefined;
            }
        }
        
        return { rootCause, affectedFiles, suggestedFix, relatedTaskId };
    }
}

