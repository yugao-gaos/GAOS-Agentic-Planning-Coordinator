import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    UnityError,
    ErrorRegistryEntry,
    ErrorAssignment,
    ErrorRoutingResult,
    ErrorStatus
} from '../types/unity';
import { CoordinatorState } from '../types';
import { OutputChannelManager } from './OutputChannelManager';
import { AgentRunner } from './AgentBackend';

// ============================================================================
// Error Router - AI-Based Error Assignment
// ============================================================================

/**
 * Coordinator info for routing context
 */
interface CoordinatorInfo {
    id: string;
    planPath: string;
    planSummary: string;
    engineers: Array<{
        name: string;
        currentTask?: string;
        recentFiles: string[];
    }>;
}

/**
 * Error Router Service
 * 
 * Uses AI to intelligently route errors to the appropriate coordinators and engineers.
 * Maintains a centralized error registry to prevent duplicate work.
 */
export class ErrorRouter {
    private workspaceRoot: string;
    private errorRegistryPath: string;
    private outputManager: OutputChannelManager;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.errorRegistryPath = path.join(workspaceRoot, '_AiDevLog/Errors/error_registry.md');
        this.outputManager = OutputChannelManager.getInstance();
    }

    /**
     * Route errors to coordinators using AI
     */
    async routeErrors(
        errors: UnityError[],
        activeCoordinators: CoordinatorInfo[]
    ): Promise<ErrorRoutingResult> {
        if (errors.length === 0) {
            return { assignments: [], duplicatesSkipped: [] };
        }

        this.log(`Routing ${errors.length} errors to ${activeCoordinators.length} coordinators`);

        // Read existing error registry
        const existingErrors = this.readErrorRegistry();

        // Filter out errors that are already being handled
        const newErrors = errors.filter(e => !this.isErrorAlreadyTracked(e, existingErrors));

        if (newErrors.length === 0) {
            this.log('All errors are already being tracked');
            return {
                assignments: [],
                duplicatesSkipped: errors.map(e => ({
                    error: e.message,
                    duplicateOf: 'existing'
                }))
            };
        }

        // Build context for AI
        const context = this.buildRoutingContext(newErrors, activeCoordinators, existingErrors);

        // Call AI router
        const result = await this.callAIRouter(context);

        // Update error registry with assignments
        this.updateErrorRegistry(result.assignments);

        return result;
    }

    /**
     * Check if an error is already tracked in the registry
     */
    private isErrorAlreadyTracked(error: UnityError, existingErrors: ErrorRegistryEntry[]): boolean {
        return existingErrors.some(existing =>
            existing.code === error.code &&
            existing.file === error.file &&
            existing.line === error.line &&
            (existing.status === 'pending' || existing.status === 'fixing')
        );
    }

    /**
     * Build routing context for AI
     */
    private buildRoutingContext(
        errors: UnityError[],
        coordinators: CoordinatorInfo[],
        existingErrors: ErrorRegistryEntry[]
    ): string {
        const errorsJson = JSON.stringify(errors.map(e => ({
            code: e.code,
            message: e.message,
            file: e.file,
            line: e.line,
            type: e.type
        })), null, 2);

        const coordinatorsJson = coordinators.map(c => `
### Coordinator: ${c.id}
- Plan: ${c.planSummary}
- Engineers:
${c.engineers.map(e => `  - ${e.name}: ${e.currentTask || 'idle'}
    Recent files: ${e.recentFiles.slice(0, 5).join(', ')}`).join('\n')}
`).join('\n');

        const existingJson = existingErrors
            .filter(e => e.status === 'pending' || e.status === 'fixing')
            .map(e => `- ${e.id}: ${e.summary} (${e.status}, assigned to ${e.assignedTo?.engineerName || 'none'})`)
            .join('\n');

        return `## Current Errors to Route:
${errorsJson}

## Active Coordinators:
${coordinatorsJson}

## Already Tracked Errors (do not duplicate):
${existingJson || '(none)'}`;
    }

    /**
     * Call AI to route errors
     */
    private async callAIRouter(context: string): Promise<ErrorRoutingResult> {
        const prompt = `You are the Error Router for a multi-coordinator Unity development system.
Your job is to assign errors to the right coordinator and suggest which engineer should fix them.

${context}

## Instructions:
1. For each error, determine which coordinator should own it based on:
   - Which engineers are working on related files
   - Which engineers have tasks related to the error
   - File paths and namespaces

2. Suggest an engineer based on:
   - Who modified the file recently
   - Whose current task is most related
   - Who has capacity

3. Check for duplicates against already tracked errors

4. Reply ONLY with valid JSON (no markdown, no explanation):
{
  "assignments": [
    {
      "errorId": "unique_id_you_generate",
      "errorSummary": "CS0103 at GemSystem.cs:42",
      "coordinatorId": "coord_xxx",
      "suggestedEngineer": "Alex",
      "reason": "Alex is working on gem system",
      "isDuplicate": false
    }
  ],
  "duplicatesSkipped": []
}`;

        try {
            const result = await this.runCursorAgent(prompt);

            // Parse JSON response
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }

            this.log(`Failed to parse AI response: ${result}`);
            return { assignments: [], duplicatesSkipped: [] };
        } catch (error) {
            this.log(`AI routing failed: ${error}`);
            return { assignments: [], duplicatesSkipped: [] };
        }
    }

    /**
     * Update error registry with new assignments
     */
    private updateErrorRegistry(assignments: ErrorAssignment[]): void {
        if (assignments.length === 0) return;

        let content = '';

        if (fs.existsSync(this.errorRegistryPath)) {
            content = fs.readFileSync(this.errorRegistryPath, 'utf-8');
        }

        // Update last updated timestamp
        const now = new Date().toISOString();
        content = content.replace(
            /Last Updated:.*$/m,
            `Last Updated: ${now}`
        );

        // Add new errors to appropriate sections
        for (const assignment of assignments) {
            if (assignment.isDuplicate) continue;

            const errorEntry = `
### ${assignment.errorId}: ${assignment.errorSummary}
- **Status**: ⏳ PENDING
- **Assigned To**: ${assignment.suggestedEngineer} (Coordinator: ${assignment.coordinatorId})
- **Assigned At**: ${now}
- **Reason**: ${assignment.reason}
`;

            // Find the right section and add the error
            const sectionMarker = '## 🔴 Compilation Errors';
            const sectionIndex = content.indexOf(sectionMarker);

            if (sectionIndex !== -1) {
                // Find the next section
                const nextSectionMatch = content.substring(sectionIndex + sectionMarker.length).match(/\n## /);
                const insertPoint = nextSectionMatch
                    ? sectionIndex + sectionMarker.length + (nextSectionMatch.index || 0)
                    : content.length;

                content = content.slice(0, insertPoint) + errorEntry + content.slice(insertPoint);
            }
        }

        fs.writeFileSync(this.errorRegistryPath, content, 'utf-8');
        this.log(`Updated error registry with ${assignments.length} new entries`);
    }

    /**
     * Read error registry and parse entries
     */
    readErrorRegistry(): ErrorRegistryEntry[] {
        if (!fs.existsSync(this.errorRegistryPath)) {
            return [];
        }

        const content = fs.readFileSync(this.errorRegistryPath, 'utf-8');
        const entries: ErrorRegistryEntry[] = [];

        // Parse error entries
        // Pattern: ### ERR-XXX: Summary
        const errorPattern = /### ([\w-]+): (.+?)\n([\s\S]*?)(?=\n### |$)/g;

        let match;
        while ((match = errorPattern.exec(content)) !== null) {
            const id = match[1];
            const summary = match[2];
            const details = match[3];

            // Parse details
            const statusMatch = details.match(/\*\*Status\*\*:\s*([^\n]+)/);
            const assignedMatch = details.match(/\*\*Assigned To\*\*:\s*(\w+)\s*\(Coordinator:\s*([\w_]+)\)/);
            const fileMatch = details.match(/\*\*File\*\*:\s*`([^`]+)`/);
            const lineMatch = fileMatch ? fileMatch[1].match(/:(\d+)/) : null;
            const codeMatch = summary.match(/^(CS\d+)/);

            let status: ErrorStatus = 'pending';
            if (statusMatch) {
                const statusStr = statusMatch[1].toLowerCase();
                if (statusStr.includes('fixing')) status = 'fixing';
                else if (statusStr.includes('fixed')) status = 'fixed';
                else if (statusStr.includes('verified')) status = 'verified';
                else if (statusStr.includes('wontfix')) status = 'wontfix';
            }

            entries.push({
                id,
                type: codeMatch ? 'compilation' : 'runtime',
                summary,
                code: codeMatch?.[1],
                file: fileMatch?.[1]?.split(':')[0],
                line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
                status,
                assignedTo: assignedMatch ? {
                    coordinatorId: assignedMatch[2],
                    engineerName: assignedMatch[1]
                } : undefined,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
        }

        return entries;
    }

    /**
     * Mark an error as being fixed
     */
    markErrorFixing(errorId: string, engineerName: string): void {
        this.updateErrorStatus(errorId, 'fixing', engineerName);
    }

    /**
     * Mark an error as fixed
     */
    markErrorFixed(errorId: string, engineerName: string, fixSummary: string): void {
        this.updateErrorStatus(errorId, 'fixed', engineerName, fixSummary);
    }

    /**
     * Mark an error as verified
     */
    markErrorVerified(errorId: string): void {
        this.updateErrorStatus(errorId, 'verified');
    }

    /**
     * Update error status in registry
     */
    private updateErrorStatus(
        errorId: string,
        newStatus: ErrorStatus,
        engineerName?: string,
        fixSummary?: string
    ): void {
        if (!fs.existsSync(this.errorRegistryPath)) return;

        let content = fs.readFileSync(this.errorRegistryPath, 'utf-8');
        const now = new Date().toISOString();

        // Find the error section
        const errorPattern = new RegExp(`(### ${errorId}:[\\s\\S]*?)(?=\\n### |$)`);
        const match = content.match(errorPattern);

        if (!match) {
            this.log(`Error ${errorId} not found in registry`);
            return;
        }

        let errorSection = match[1];

        // Update status
        const statusIcon = {
            pending: '⏳ PENDING',
            fixing: '🔧 FIXING',
            fixed: '✅ FIXED',
            verified: '✔️ VERIFIED',
            wontfix: '❌ WONTFIX'
        }[newStatus];

        errorSection = errorSection.replace(
            /\*\*Status\*\*:\s*[^\n]+/,
            `**Status**: ${statusIcon}`
        );

        // Add timestamps based on status
        if (newStatus === 'fixing' && engineerName) {
            errorSection += `- **Started By**: ${engineerName}\n`;
            errorSection += `- **Started At**: ${now}\n`;
        } else if (newStatus === 'fixed') {
            if (engineerName) {
                errorSection += `- **Fixed By**: ${engineerName}\n`;
            }
            errorSection += `- **Fixed At**: ${now}\n`;
            if (fixSummary) {
                errorSection += `- **Fix Summary**: ${fixSummary}\n`;
            }
        } else if (newStatus === 'verified') {
            errorSection += `- **Verified At**: ${now}\n`;
        }

        content = content.replace(errorPattern, errorSection);

        // Update last modified
        content = content.replace(
            /Last Updated:.*$/m,
            `Last Updated: ${now}`
        );

        fs.writeFileSync(this.errorRegistryPath, content, 'utf-8');
        this.log(`Updated error ${errorId} status to ${newStatus}`);
    }

    /**
     * Get errors assigned to a coordinator
     */
    getErrorsForCoordinator(coordinatorId: string): ErrorRegistryEntry[] {
        const allErrors = this.readErrorRegistry();
        return allErrors.filter(e =>
            e.assignedTo?.coordinatorId === coordinatorId &&
            (e.status === 'pending' || e.status === 'fixing')
        );
    }

    /**
     * Get errors assigned to an engineer
     */
    getErrorsForEngineer(engineerName: string): ErrorRegistryEntry[] {
        const allErrors = this.readErrorRegistry();
        return allErrors.filter(e =>
            e.assignedTo?.engineerName === engineerName &&
            (e.status === 'pending' || e.status === 'fixing')
        );
    }

    /**
     * Run cursor agent command using AgentRunner
     * Provides consistent timeout handling and retry support
     */
    private async runCursorAgent(prompt: string, retries: number = 2): Promise<string> {
        const agentRunner = AgentRunner.getInstance();
        const processId = `error_router_${Date.now()}`;
        
        let lastError: Error | null = null;
        
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                if (attempt > 0) {
                    this.log(`Retrying error routing (attempt ${attempt + 1}/${retries + 1})...`);
                }
                
                let output = '';
                
                const result = await agentRunner.run({
                    id: `${processId}_${attempt}`,
                    prompt,
                    cwd: this.workspaceRoot,
                    model: 'gpt-4o-mini',
                    timeoutMs: 120000, // 2 minute timeout for error routing
                    metadata: { type: 'error_routing', attempt },
                    onOutput: (text) => {
                        output += text;
                    }
                });
                
                if (result.success) {
                    return output || result.output || '';
                } else {
                    lastError = new Error(result.error || `Error routing failed (exit code: ${result.exitCode})`);
                }
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                this.log(`Error routing attempt ${attempt + 1} failed: ${lastError.message}`);
            }
        }
        
        throw lastError || new Error('Error routing failed after all retries');
    }

    /**
     * Log to unified output channel
     */
    private log(message: string): void {
        this.outputManager.log('ERROR', message);
    }

    /**
     * Show output channel
     */
    showOutput(): void {
        this.outputManager.show();
    }
    
    /**
     * Dispose resources
     */
    dispose(): void {
        // No resources to dispose currently, but method exists for consistency
        this.log('ErrorRouter disposed');
    }
}

