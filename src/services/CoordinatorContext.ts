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
    ActiveWorkflowSummary,
    FailedWorkflowSummary,
    PlanSummary,
    SessionCapacity,
    GlobalFileConflict
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
     * Coordinator is global - it sees ALL approved plans and ALL tasks.
     * 
     * @param sessionId - The primary session (triggering event)
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
        
        // Get ALL approved plans (not just the triggering session)
        const approvedPlans = this.getApprovedPlans();
        
        // Get plan content for backward compatibility
        const { planPath, planContent } = this.getPlanContent(session);
        
        // Build task summaries from TaskManager (ALL tasks, not just this session)
        const tasks = this.buildAllTaskSummaries();
        
        // Build workflow summaries from session state (active + failed)
        const { active: activeWorkflows, failed: recentlyFailedWorkflows } = sessionState 
            ? this.buildWorkflowSummaries(sessionState)
            : { active: [], failed: [] };
        
        // Get agent statuses from AgentPoolService
        const agentStatuses = this.buildAgentStatuses();
        const availableAgents = this.agentPoolService.getAvailableAgents();
        
        // Calculate per-session capacity analysis
        const sessionCapacities = this.calculateSessionCapacities(approvedPlans, sessionState);
        
        // Analyze cross-plan file conflicts
        const globalConflicts = this.buildGlobalConflictAnalysis(tasks);
        
        return {
            event,
            sessionId,
            approvedPlans,
            planPath,
            planContent,
            planRequirement: session?.requirement || '',
            history: sessionState?.coordinatorHistory || [],
            availableAgents,
            agentStatuses,
            tasks,
            activeWorkflows,
            recentlyFailedWorkflows,
            sessionStatus: session?.status || 'unknown',
            pendingQuestions: sessionState?.pendingQuestions || [],
            sessionCapacities,
            globalConflicts
        };
    }
    
    /**
     * Get all approved and uncompleted plans with recommended agent counts
     */
    private getApprovedPlans(): PlanSummary[] {
        const sessions = this.stateManager.getAllPlanningSessions();
        return sessions
            .filter(s => s.status === 'approved') // Only approved plans need tasks created
            .map(s => {
                // Priority order for getting recommended agent count:
                // 1. Stored session metadata (primary source)
                // 2. Lightweight regex extraction from plan file
                // 3. Default value (5)
                let recommendedAgents: number | undefined = s.recommendedAgents?.count;
                
                // If not stored, try lightweight extraction from plan content
                if (!recommendedAgents && s.currentPlanPath) {
                    try {
                        recommendedAgents = this.extractRecommendedAgentsFromPlan(s.currentPlanPath);
                    } catch (e) {
                        console.warn(`[CoordinatorContext] Failed to extract recommended agents for ${s.id}:`, e);
                    }
                }
                
                return {
                    sessionId: s.id,
                    planPath: s.currentPlanPath || '',
                    requirement: s.requirement || '',
                    status: s.status,
                    recommendedAgents: recommendedAgents || 5  // Default to 5 if not found
                };
            });
    }
    
    /**
     * Extract recommended agent count from plan file using lightweight regex (no full parsing)
     */
    private extractRecommendedAgentsFromPlan(planPath: string): number | undefined {
        try {
            if (!fs.existsSync(planPath)) {
                return undefined;
            }
            
            const content = fs.readFileSync(planPath, 'utf-8');
            
            // Try to find recommended engineer count from plan
            // Matches: "**Recommended:** 5 engineers" or "Use 5 engineers"
            const recommendedMatch = content.match(/\*\*Recommended:\*\*\s*(\d+)\s*engineers/i) ||
                                     content.match(/use\s+(\d+)\s+engineers/i);
            
            if (recommendedMatch) {
                return parseInt(recommendedMatch[1], 10);
            }
            
            return undefined;
        } catch (e) {
            return undefined;
        }
    }
    
    /**
     * Build task summaries for ALL sessions (global view)
     */
    private buildAllTaskSummaries(): TaskSummary[] {
        const taskManager = ServiceLocator.resolve(TaskManager);
        const allTasks = taskManager.getAllTasks();
        
        return allTasks.map(task => {
            // Determine dependency status
            let dependencyStatus: 'all_complete' | 'some_pending' | 'some_failed' = 'all_complete';
            if (task.dependencies && task.dependencies.length > 0) {
                const depTasks = task.dependencies.map(depId => {
                    // Try both local and global ID formats
                    return taskManager.getTask(depId) || taskManager.getTask(`${task.sessionId}_${depId}`);
                });
                
                if (depTasks.some(t => t?.status === 'failed')) {
                    dependencyStatus = 'some_failed';
                } else if (depTasks.some(t => t?.status !== 'completed')) {
                    dependencyStatus = 'some_pending';
                }
            }
            
            return {
                id: task.id,
                sessionId: task.sessionId,
                description: task.description,
                status: task.status,
                type: task.taskType as 'implementation' | 'error_fix' | 'context_gathering',
                priority: task.priority,
                dependencies: task.dependencies || [],
                dependencyStatus,
                assignedAgent: undefined, // TaskManager doesn't track this directly
                attempts: task.previousAttempts || 0,
                targetFiles: task.targetFiles  // For cross-plan conflict detection
            };
        });
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
     * Transforms workflows into summaries for AI (both active and failed)
     */
    buildWorkflowSummaries(sessionState: SessionStateSnapshot): {
        active: ActiveWorkflowSummary[];
        failed: FailedWorkflowSummary[];
    } {
        const active: ActiveWorkflowSummary[] = [];
        const failed: FailedWorkflowSummary[] = [];
        
        for (const [workflowId, workflow] of sessionState.workflows) {
            const status = workflow.getStatus();
            const progress = workflow.getProgress();
            
            if (status === 'failed') {
                // Include failed workflows so coordinator knows about failures
                failed.push({
                    id: workflowId,
                    type: progress.type,
                    taskId: sessionState.workflowToTaskMap.get(workflowId),
                    error: workflow.getError() || 'Unknown error',
                    failedAt: progress.updatedAt,
                    phase: progress.phase
                });
            } else if (status === 'completed' || status === 'cancelled') {
                // Skip completed/cancelled - coordinator doesn't need these
                continue;
            } else {
                // Active workflows (running, pending, blocked)
                active.push({
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
        }
        
        return { active, failed };
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
    
    /**
     * Calculate per-session capacity analysis
     * Helps coordinator respect recommended team sizes and avoid over-allocation
     * 
     * @param approvedPlans - All approved plans with their recommended agent counts
     * @param sessionState - Optional: current session workflow state (if available)
     * @returns Array of capacity info per session
     */
    private calculateSessionCapacities(
        approvedPlans: PlanSummary[],
        sessionState?: SessionStateSnapshot
    ): SessionCapacity[] {
        const capacities: SessionCapacity[] = [];
        const poolSummary = this.agentPoolService.getPoolSummary();
        
        for (const plan of approvedPlans) {
            const sessionId = plan.sessionId;
            const recommendedAgents = plan.recommendedAgents || 5;
            
            // Count agents currently allocated to this session (busy + bench)
            const busyAgents = poolSummary.byRole;  // Get busy agents
            const benchAgents = this.agentPoolService.getAgentsOnBench(sessionId);
            
            // Count busy agents for this session
            let busyCount = 0;
            const poolStatus = this.agentPoolService.getPoolStatus();
            for (const agent of poolStatus.busy) {
                // Check if this busy agent belongs to this session
                const agentStatus = this.agentPoolService.getAgentStatus(agent);
                if (agentStatus && agentStatus.status === 'busy' && agentStatus.sessionId === sessionId) {
                    busyCount++;
                }
            }
            
            const currentlyAllocated = busyCount + benchAgents.length;
            const availableCapacity = Math.max(0, recommendedAgents - currentlyAllocated);
            
            // Count active workflows for this session
            let activeWorkflows = 0;
            if (sessionState && sessionState.sessionId === sessionId) {
                for (const workflow of sessionState.workflows.values()) {
                    const status = workflow.getStatus();
                    if (status === 'running' || status === 'pending' || status === 'blocked') {
                        activeWorkflows++;
                    }
                }
            }
            
            capacities.push({
                sessionId,
                recommendedAgents,
                currentlyAllocated,
                availableCapacity,
                activeWorkflows
            });
        }
        
        return capacities;
    }
    
    /**
     * Build global conflict analysis - find files touched by tasks from multiple sessions
     * This helps the coordinator detect cross-plan dependencies that need sequencing
     */
    buildGlobalConflictAnalysis(tasks: TaskSummary[]): GlobalFileConflict[] {
        // Group tasks by their target files
        const fileToTasks = new Map<string, Array<{
            taskId: string;
            sessionId: string;
            status: string;
            description: string;
        }>>();
        
        for (const task of tasks) {
            if (!task.targetFiles || task.targetFiles.length === 0) {
                continue;
            }
            
            for (const file of task.targetFiles) {
                // Normalize file path (use basename for matching)
                const normalizedFile = file.split(/[/\\]/).pop() || file;
                
                if (!fileToTasks.has(normalizedFile)) {
                    fileToTasks.set(normalizedFile, []);
                }
                
                fileToTasks.get(normalizedFile)!.push({
                    taskId: task.id,
                    sessionId: task.sessionId || '',
                    status: task.status,
                    description: task.description
                });
            }
        }
        
        // Filter to only files with tasks from MULTIPLE sessions
        const conflicts: GlobalFileConflict[] = [];
        
        for (const [file, taskList] of fileToTasks) {
            // Get unique session IDs
            const sessionIds = new Set(taskList.map(t => t.sessionId));
            
            // Only report as conflict if multiple sessions touch this file
            if (sessionIds.size > 1) {
                conflicts.push({
                    file,
                    tasks: taskList
                });
            }
        }
        
        return conflicts;
    }
}

