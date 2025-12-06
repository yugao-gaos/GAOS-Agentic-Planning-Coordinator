/**
 * DependencyGraphUtils.ts - Utilities for analyzing task dependency graphs
 * 
 * Provides:
 * - Cycle detection (prevents deadlocks)
 * - Topological sorting (execution order)
 * - Critical path analysis (optimization)
 */

import { Logger } from '../utils/Logger';

const log = Logger.create('Daemon', 'DependencyGraph');

/**
 * Result of cycle detection
 */
export interface CycleDetectionResult {
    hasCycle: boolean;
    cycles: string[][];  // Array of cycles (each cycle is an array of task IDs)
    description?: string;
}

/**
 * Task node for graph traversal
 */
export interface TaskNode {
    id: string;
    dependencies: string[];
}

/**
 * DependencyGraphUtils - Static utility class for graph operations
 */
export class DependencyGraphUtils {
    
    /**
     * Detect cycles in a dependency graph
     * 
     * Uses DFS (Depth-First Search) with three states:
     * - WHITE: Unvisited
     * - GRAY: Currently visiting (on recursion stack)
     * - BLACK: Finished visiting
     * 
     * A cycle exists if we encounter a GRAY node during DFS.
     * 
     * @param tasks Array of tasks with dependencies
     * @returns Detection result with all cycles found
     */
    static detectCycles(tasks: TaskNode[]): CycleDetectionResult {
        const graph = new Map<string, string[]>();
        const allTaskIds = new Set<string>();
        
        // Build adjacency list
        for (const task of tasks) {
            allTaskIds.add(task.id);
            graph.set(task.id, task.dependencies || []);
        }
        
        // Validate dependencies exist (prevent phantom cycles)
        const missingDeps: string[] = [];
        for (const task of tasks) {
            for (const dep of task.dependencies || []) {
                if (!allTaskIds.has(dep)) {
                    missingDeps.push(`${task.id} → ${dep}`);
                }
            }
        }
        
        if (missingDeps.length > 0) {
            log.warn(`Dependency graph has missing dependencies: ${missingDeps.join(', ')}`);
        }
        
        // State tracking for DFS
        const WHITE = 0;
        const GRAY = 1;
        const BLACK = 2;
        
        const colors = new Map<string, number>();
        const parent = new Map<string, string | null>();
        const cycles: string[][] = [];
        
        // Initialize all nodes as white
        for (const taskId of allTaskIds) {
            colors.set(taskId, WHITE);
            parent.set(taskId, null);
        }
        
        /**
         * DFS visit - returns true if cycle detected
         */
        const dfsVisit = (nodeId: string, path: string[]): boolean => {
            colors.set(nodeId, GRAY);
            path.push(nodeId);
            
            const dependencies = graph.get(nodeId) || [];
            
            for (const depId of dependencies) {
                // Skip non-existent dependencies
                if (!allTaskIds.has(depId)) {
                    continue;
                }
                
                const depColor = colors.get(depId);
                
                if (depColor === GRAY) {
                    // Found a cycle! Extract the cycle from path
                    const cycleStartIndex = path.indexOf(depId);
                    const cycle = [...path.slice(cycleStartIndex), depId];
                    cycles.push(cycle);
                    log.warn(`Cycle detected: ${cycle.join(' → ')}`);
                    return true;
                }
                
                if (depColor === WHITE) {
                    parent.set(depId, nodeId);
                    if (dfsVisit(depId, [...path])) {
                        // Cycle found in subtree
                    }
                }
            }
            
            colors.set(nodeId, BLACK);
            return false;
        };
        
        // Run DFS from all white nodes
        for (const taskId of allTaskIds) {
            if (colors.get(taskId) === WHITE) {
                dfsVisit(taskId, []);
            }
        }
        
        // Generate description
        let description = '';
        if (cycles.length > 0) {
            description = `Found ${cycles.length} circular ${cycles.length === 1 ? 'dependency' : 'dependencies'}:\n`;
            for (const cycle of cycles) {
                description += `  • ${cycle.join(' → ')}\n`;
            }
        }
        
        return {
            hasCycle: cycles.length > 0,
            cycles,
            description
        };
    }
    
    /**
     * Topological sort - returns tasks in execution order
     * 
     * Uses Kahn's algorithm:
     * 1. Find nodes with no dependencies
     * 2. Process them and remove their edges
     * 3. Repeat until done or cycle detected
     * 
     * @param tasks Array of tasks with dependencies
     * @returns Sorted array or null if cycle detected
     */
    static topologicalSort(tasks: TaskNode[]): string[] | null {
        // First check for cycles
        const cycleCheck = this.detectCycles(tasks);
        if (cycleCheck.hasCycle) {
            log.error('Cannot perform topological sort - graph has cycles');
            return null;
        }
        
        // Build in-degree map
        const inDegree = new Map<string, number>();
        const graph = new Map<string, string[]>();
        const allTaskIds = new Set<string>();
        
        for (const task of tasks) {
            allTaskIds.add(task.id);
            inDegree.set(task.id, 0);
            graph.set(task.id, []);
        }
        
        // Count in-degrees (how many tasks depend on each task)
        for (const task of tasks) {
            for (const dep of task.dependencies || []) {
                if (allTaskIds.has(dep)) {
                    inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
                    const dependents = graph.get(dep) || [];
                    dependents.push(task.id);
                    graph.set(dep, dependents);
                }
            }
        }
        
        // Find nodes with no dependencies (in-degree = 0)
        const queue: string[] = [];
        for (const [taskId, degree] of inDegree) {
            if (degree === 0) {
                queue.push(taskId);
            }
        }
        
        // Process queue
        const sorted: string[] = [];
        while (queue.length > 0) {
            const taskId = queue.shift()!;
            sorted.push(taskId);
            
            // Reduce in-degree for dependents
            const dependents = graph.get(taskId) || [];
            for (const depId of dependents) {
                const newDegree = (inDegree.get(depId) || 0) - 1;
                inDegree.set(depId, newDegree);
                
                if (newDegree === 0) {
                    queue.push(depId);
                }
            }
        }
        
        // If not all tasks processed, there's a cycle (should not happen after cycle check)
        if (sorted.length !== tasks.length) {
            log.error(`Topological sort incomplete: ${sorted.length}/${tasks.length} tasks processed`);
            return null;
        }
        
        return sorted;
    }
    
    /**
     * Find all tasks that transitively depend on a given task
     * Used for impact analysis when a task fails or changes
     * 
     * @param taskId The task to check
     * @param tasks All tasks
     * @returns Set of task IDs that depend on this task (directly or indirectly)
     */
    static findTransitiveDependents(taskId: string, tasks: TaskNode[]): Set<string> {
        const graph = new Map<string, string[]>();
        
        // Build reverse dependency graph (task -> tasks that depend on it)
        for (const task of tasks) {
            for (const dep of task.dependencies || []) {
                if (!graph.has(dep)) {
                    graph.set(dep, []);
                }
                graph.get(dep)!.push(task.id);
            }
        }
        
        // BFS to find all transitive dependents
        const dependents = new Set<string>();
        const queue = [taskId];
        const visited = new Set<string>([taskId]);
        
        while (queue.length > 0) {
            const currentId = queue.shift()!;
            const directDependents = graph.get(currentId) || [];
            
            for (const dependent of directDependents) {
                if (!visited.has(dependent)) {
                    visited.add(dependent);
                    dependents.add(dependent);
                    queue.push(dependent);
                }
            }
        }
        
        return dependents;
    }
    
    /**
     * Find critical path (longest path) through the dependency graph
     * Used for optimization and scheduling
     * 
     * @param tasks All tasks
     * @returns Array of task IDs on the critical path
     */
    static findCriticalPath(tasks: TaskNode[]): string[] {
        // First, get topological order
        const sorted = this.topologicalSort(tasks);
        if (!sorted) {
            log.error('Cannot find critical path - graph has cycles');
            return [];
        }
        
        // Calculate longest path to each node
        const longestPath = new Map<string, number>();
        const predecessor = new Map<string, string | null>();
        
        // Build dependency map
        const graph = new Map<string, string[]>();
        for (const task of tasks) {
            graph.set(task.id, task.dependencies || []);
        }
        
        // Initialize
        for (const taskId of sorted) {
            longestPath.set(taskId, 0);
            predecessor.set(taskId, null);
        }
        
        // Dynamic programming - process in topological order
        for (const taskId of sorted) {
            const deps = graph.get(taskId) || [];
            
            for (const dep of deps) {
                const pathLength = (longestPath.get(dep) || 0) + 1;
                
                if (pathLength > (longestPath.get(taskId) || 0)) {
                    longestPath.set(taskId, pathLength);
                    predecessor.set(taskId, dep);
                }
            }
        }
        
        // Find the end node (node with longest path)
        let endNode: string | null = null;
        let maxLength = -1;
        
        for (const [taskId, length] of longestPath) {
            if (length > maxLength) {
                maxLength = length;
                endNode = taskId;
            }
        }
        
        if (!endNode) {
            return [];
        }
        
        // Backtrack to build critical path
        const criticalPath: string[] = [];
        let current: string | null = endNode;
        
        while (current) {
            criticalPath.unshift(current);
            current = predecessor.get(current) || null;
        }
        
        return criticalPath;
    }
    
    /**
     * Validate that a dependency graph is acyclic and well-formed
     * 
     * @param tasks Array of tasks with dependencies
     * @returns Validation result with detailed errors
     */
    static validateGraph(tasks: TaskNode[]): {
        valid: boolean;
        errors: string[];
        warnings: string[];
    } {
        const errors: string[] = [];
        const warnings: string[] = [];
        const taskIds = new Set(tasks.map(t => t.id));
        
        // Check 1: Duplicate task IDs
        const idCounts = new Map<string, number>();
        for (const task of tasks) {
            idCounts.set(task.id, (idCounts.get(task.id) || 0) + 1);
        }
        
        for (const [id, count] of idCounts) {
            if (count > 1) {
                errors.push(`Duplicate task ID: ${id} (appears ${count} times)`);
            }
        }
        
        // Check 2: Missing dependencies
        for (const task of tasks) {
            for (const dep of task.dependencies || []) {
                if (!taskIds.has(dep)) {
                    errors.push(`Task ${task.id} depends on non-existent task: ${dep}`);
                }
            }
        }
        
        // Check 3: Self-dependencies
        for (const task of tasks) {
            if (task.dependencies?.includes(task.id)) {
                errors.push(`Task ${task.id} depends on itself (direct cycle)`);
            }
        }
        
        // Check 4: Circular dependencies (transitive)
        const cycleCheck = this.detectCycles(tasks);
        if (cycleCheck.hasCycle) {
            errors.push(`Circular dependencies detected:\n${cycleCheck.description}`);
        }
        
        // Warning 1: Tasks with no dependencies (potential parallelization)
        const noDeps = tasks.filter(t => !t.dependencies || t.dependencies.length === 0);
        if (noDeps.length > 1) {
            warnings.push(`${noDeps.length} tasks have no dependencies - can run in parallel`);
        }
        
        // Warning 2: Long dependency chains
        const criticalPath = this.findCriticalPath(tasks);
        if (criticalPath.length > 10) {
            warnings.push(`Critical path is long (${criticalPath.length} tasks) - consider parallelization`);
        }
        
        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }
}

