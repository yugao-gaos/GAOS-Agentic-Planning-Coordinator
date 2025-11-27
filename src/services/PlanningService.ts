import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './StateManager';
import { PlanningSession, PlanningStatus, PlanVersion, RevisionEntry } from '../types';

export class PlanningService {
    private stateManager: StateManager;

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
    }

    /**
     * Start a new planning session
     */
    async startPlanning(requirement: string): Promise<{ sessionId: string; status: PlanningStatus }> {
        const sessionId = this.stateManager.generatePlanningSessionId();
        
        const session: PlanningSession = {
            id: sessionId,
            status: 'debating',
            requirement: requirement,
            planHistory: [],
            revisionHistory: [{
                version: 0,
                feedback: 'Initial requirement',
                timestamp: new Date().toISOString()
            }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        this.stateManager.savePlanningSession(session);

        // In a full implementation, this would spawn analyst agents
        // For now, we'll simulate the planning process
        this.simulatePlanningDebate(session);

        return {
            sessionId,
            status: 'debating'
        };
    }

    /**
     * Simulate the multi-model planning debate
     * In production, this would spawn actual analyst agents
     */
    private async simulatePlanningDebate(session: PlanningSession): Promise<void> {
        // Simulate debate time
        setTimeout(async () => {
            // Generate a simple plan file
            const planPath = await this.generatePlan(session);
            
            session.status = 'reviewing';
            session.currentPlanPath = planPath;
            session.planHistory.push({
                version: 1,
                path: planPath,
                timestamp: new Date().toISOString()
            });
            session.recommendedEngineers = {
                count: this.estimateEngineerCount(session.requirement),
                justification: 'Based on task complexity and parallelization opportunities'
            };
            session.updatedAt = new Date().toISOString();
            
            this.stateManager.savePlanningSession(session);
            
            vscode.window.showInformationMessage(
                `Planning session ${session.id} ready for review`,
                'View Plan'
            ).then(selection => {
                if (selection === 'View Plan' && session.currentPlanPath) {
                    vscode.workspace.openTextDocument(session.currentPlanPath)
                        .then(doc => vscode.window.showTextDocument(doc));
                }
            });
        }, 2000); // Simulate 2 second debate
    }

    /**
     * Generate a plan file from the requirement
     */
    private async generatePlan(session: PlanningSession): Promise<string> {
        const plansDir = path.join(this.stateManager.getWorkingDir(), 'Plans');
        const planFileName = `Plan_${session.id}_v1.md`;
        const planPath = path.join(plansDir, planFileName);

        // Generate a template plan
        const planContent = `# Plan: ${session.requirement}

## Session: ${session.id}
## Created: ${new Date().toISOString()}
## Status: Pending Review

---

## Overview
${session.requirement}

---

## Tasks

### Wave 1 (Parallel)
- [ ] Task 1.1: Initial setup and scaffolding
- [ ] Task 1.2: Core data structures
- [ ] Task 1.3: Basic UI components

### Wave 2 (Parallel, depends on Wave 1)
- [ ] Task 2.1: Business logic implementation
- [ ] Task 2.2: Integration with existing systems
- [ ] Task 2.3: Unit tests

### Wave 3 (Sequential)
- [ ] Task 3.1: Integration testing
- [ ] Task 3.2: Documentation
- [ ] Task 3.3: Final review

---

## Engineer Allocation
Recommended: ${this.estimateEngineerCount(session.requirement)} engineers

### Suggested Assignment
- **Engineer 1**: Wave 1 tasks (setup, scaffolding)
- **Engineer 2**: Wave 1 tasks (data structures)
- **Engineer 3**: Wave 1 tasks (UI components)

---

## Dependencies
- None identified

## Risks
- None identified

## Notes
This is an auto-generated plan template. Review and modify as needed.
`;

        fs.writeFileSync(planPath, planContent);
        return planPath;
    }

    /**
     * Estimate engineer count based on requirement
     */
    private estimateEngineerCount(requirement: string): number {
        // Simple heuristic based on requirement length/complexity
        const words = requirement.split(/\s+/).length;
        if (words < 10) {return 2;}
        if (words < 30) {return 3;}
        if (words < 50) {return 4;}
        return 5;
    }

    /**
     * Revise an existing plan
     */
    async revisePlan(sessionId: string, feedback: string): Promise<{ sessionId: string; status: PlanningStatus }> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        session.status = 'revising';
        session.revisionHistory.push({
            version: session.planHistory.length + 1,
            feedback: feedback,
            timestamp: new Date().toISOString()
        });
        session.updatedAt = new Date().toISOString();
        
        this.stateManager.savePlanningSession(session);

        // Simulate revision process
        this.simulatePlanRevision(session, feedback);

        return {
            sessionId,
            status: 'revising'
        };
    }

    /**
     * Simulate plan revision
     */
    private async simulatePlanRevision(session: PlanningSession, feedback: string): Promise<void> {
        setTimeout(async () => {
            // Generate revised plan
            const newVersion = session.planHistory.length + 1;
            const planFileName = `Plan_${session.id}_v${newVersion}.md`;
            const planPath = path.join(this.stateManager.getWorkingDir(), 'Plans', planFileName);

            // Read existing plan and append revision notes
            let existingContent = '';
            if (session.currentPlanPath && fs.existsSync(session.currentPlanPath)) {
                existingContent = fs.readFileSync(session.currentPlanPath, 'utf-8');
            }

            const revisedContent = existingContent + `

---

## Revision ${newVersion}
### Feedback: ${feedback}
### Applied: ${new Date().toISOString()}

[Revision changes would be applied here based on feedback]
`;

            fs.writeFileSync(planPath, revisedContent);

            session.status = 'reviewing';
            session.currentPlanPath = planPath;
            session.planHistory.push({
                version: newVersion,
                path: planPath,
                timestamp: new Date().toISOString()
            });
            session.updatedAt = new Date().toISOString();

            this.stateManager.savePlanningSession(session);

            vscode.window.showInformationMessage(
                `Plan revision ${newVersion} ready for review`,
                'View Plan'
            ).then(selection => {
                if (selection === 'View Plan') {
                    vscode.workspace.openTextDocument(planPath)
                        .then(doc => vscode.window.showTextDocument(doc));
                }
            });
        }, 1500);
    }

    /**
     * Approve a plan for execution
     */
    async approvePlan(sessionId: string): Promise<void> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        if (session.status !== 'reviewing') {
            throw new Error(`Plan is not ready for approval (status: ${session.status})`);
        }

        session.status = 'approved';
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);

        vscode.window.showInformationMessage(`Plan ${sessionId} approved and ready for execution`);
    }

    /**
     * Cancel a planning session
     */
    async cancelPlan(sessionId: string): Promise<void> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        session.status = 'cancelled';
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
    }

    /**
     * Get planning session status
     */
    getPlanningStatus(sessionId: string): PlanningSession | undefined {
        return this.stateManager.getPlanningSession(sessionId);
    }

    /**
     * List all planning sessions
     */
    listPlanningSessions(): PlanningSession[] {
        return this.stateManager.getAllPlanningSessions();
    }
}

