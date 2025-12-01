// ============================================================================
// CoordinatorContext - Builds context for AI Coordinator evaluations
// ============================================================================
//
// This class is responsible for gathering and formatting all the context
// needed by the AI Coordinator Agent to make decisions. It consolidates
// data from multiple sources (TaskManager, AgentPoolService, StateManager)
// into a unified CoordinatorInput structure.
//
// Used by UnifiedCoordinatorService when triggering AI evaluations.

import * as fs from 'fs';
import { StateManager } from './StateManager';
import { ServiceLocator } from './ServiceLocator';
import { AgentPoolService } from './AgentPoolService';
import { TaskManager } from './TaskManager';
import { PlanningSession } from '../types';
import {
    CoordinatorEvent,
    CoordinatorInput,
    CoordinatorHistoryEntry,
    TaskSummary,
    ActiveWorkflowSummary
} from '../types/coordinator';
import { IWorkflow } from './workflows';

/**
 * Minimal session state interface - what we need from UnifiedCoordinatorService
 */
export interface SessionStateSnapshot {
    sessionId: string;
    workflows: Map<string, IWorkflow>;
    workflowToTaskMap: Map<string, string>;
    coordinatorHistory: CoordinatorHistoryEntry[];
    pendingQuestions: Array<{
        id: string;
        question: string;
        context: string;
        askedAt: string;
        relatedTaskId?: string;
    }>;
}

/**
 * CoordinatorContext - Builds context for AI Coordinator evaluations
 * 
 * Responsibilities:
 * - Gather task state from TaskManager
 * - Gather agent state from AgentPoolService
 * - Gather session/plan info from StateManager
 * - Format workflow summaries from session state
 * - Assemble everything into CoordinatorInput
 */
export class CoordinatorContext {
    private stateManager: StateManager;
    private agentPoolService: AgentPoolService;

    constructor(stateManager: StateManager, agentPoolService: AgentPoolService) {
        this.stateManager = stateManager;
        this.agentPoolService = agentPoolService;
    }

    /**
     * Build the full input context for the AI Coordinator
     * 
     * @param sessionId - The session to build context for
     * @param event - The triggering event
     * @param sessionState - Snapshot of session state from UnifiedCoordinatorService
     * @returns Complete context for AI evaluation
     */
    async buildInput(
        sessionId: string,
        event: CoordinatorEvent,
        sessionState: SessionStateSnapshot | undefined
    ): Promise<CoordinatorInput> {
        const session = this.stateManager.getPlanningSession(sessionId);
        
        // Get plan content
        const { planPath, planContent } = this.getPlanContent(session);
        
        // Build task summaries from TaskManager
        const tasks = this.buildTaskSummaries(sessionId);
        
        // Build workflow summaries from session state
        const activeWorkflows = sessionState 
            ? this.buildWorkflowSummaries(sessionState)
            : [];
        
        // Get agent statuses from AgentPoolService
        const agentStatuses = this.buildAgentStatuses();
        const availableAgents = this.agentPoolService.getAvailableAgents();
        
        return {
            event,
            sessionId,
            planPath,
            planContent,
            planRequirement: session?.requirement || '',
            history: sessionState?.coordinatorHistory || [],
            availableAgents,
            agentStatuses,
            tasks,
            activeWorkflows,
            sessionStatus: session?.status || 'unknown',
            pendingQuestions: sessionState?.pendingQuestions || []
        };
    }

    /**
     * Get plan content from disk
     */
    private getPlanContent(session: PlanningSession | undefined): { planPath: string; planContent: string } {
        let planContent = '';
        let planPath = '';
        
        if (session?.currentPlanPath) {
            planPath = session.currentPlanPath;
            try {
                planContent = fs.readFileSync(planPath, 'utf-8');
            } catch (e) {
                planContent = `[Error reading plan: ${e}]`;
            }
        }
        
        return { planPath, planContent };
    }

    /**
     * Build task summaries for coordinator input
     * Transforms ManagedTask from TaskManager into TaskSummary for AI
     */
    buildTaskSummaries(sessionId: string): TaskSummary[] {
        const taskManager = ServiceLocator.resolve(TaskManager);
        const tasks = taskManager.getTasksForSession(sessionId);
        
        return tasks.map(task => {
            // Determine dependency status
            let dependencyStatus: 'all_complete' | 'some_pending' | 'some_failed' = 'all_complete';
            if (task.dependencies && task.dependencies.length > 0) {
                const depTasks = task.dependencies.map(depId => {
                    const globalDepId = `${sessionId}_${depId}`;
                    return taskManager.getTask(globalDepId);
                });
                
                if (depTasks.some(t => t?.status === 'failed')) {
                    dependencyStatus = 'some_failed';
                } else if (depTasks.some(t => t?.status !== 'completed')) {
                    dependencyStatus = 'some_pending';
                }
            }
            
            // Determine task type from taskType field
            const taskType = task.taskType === 'error_fix' 
                ? 'error_fix' as const
                : 'implementation' as const;
            
            return {
                id: task.id,
                description: task.description,
                status: task.status as TaskSummary['status'],
                type: taskType,
                dependencies: task.dependencies || [],
                dependencyStatus,
                assignedAgent: task.actualAgent,
                errors: [],  // Errors are now stored in errorText field
                attempts: 0,
                priority: task.priority || 10
            };
        });
    }

    /**
     * Build workflow summaries for coordinator input
     * Transforms active workflows into summaries for AI
     */
    buildWorkflowSummaries(sessionState: SessionStateSnapshot): ActiveWorkflowSummary[] {
        const summaries: ActiveWorkflowSummary[] = [];
        
        for (const [workflowId, workflow] of sessionState.workflows) {
            const status = workflow.getStatus();
            if (status === 'completed' || status === 'cancelled' || status === 'failed') {
                continue;
            }
            
            const progress = workflow.getProgress();
            summaries.push({
                id: workflowId,
                type: progress.type,
                status: progress.status,
                taskId: sessionState.workflowToTaskMap.get(workflowId),
                phase: progress.phase,
                phaseProgress: progress.percentage,
                agentName: undefined, // Would need to track from workflow
                startedAt: progress.startedAt,
                lastUpdate: progress.updatedAt
            });
        }
        
        return summaries;
    }

    /**
     * Build agent statuses for coordinator input
     * Gathers agent state from AgentPoolService
     */
    buildAgentStatuses(): CoordinatorInput['agentStatuses'] {
        const poolStatus = this.agentPoolService.getPoolStatus();
        const busyAgents = this.agentPoolService.getBusyAgents();
        
        const statuses: CoordinatorInput['agentStatuses'] = [];
        
        // Add available agents
        for (const name of poolStatus.available) {
            statuses.push({
                name,
                status: 'available',
                currentTask: undefined,
                roles: []
            });
        }
        
        // Add busy agents
        for (const agent of busyAgents) {
            statuses.push({
                name: agent.name,
                status: 'busy',
                currentTask: agent.task,
                roles: agent.roleId ? [agent.roleId] : []
            });
        }
        
        return statuses;
    }
}

