/**
 * WorkflowHistoryService - Persistent storage for completed workflows
 * 
 * Stores workflow history in JSON files per session to prevent memory bloat
 * while allowing full historical queries.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface WorkflowHistoryEntry {
    id: string;
    sessionId: string;
    type: string;
    status: 'completed' | 'failed' | 'cancelled';
    taskId?: string;
    startedAt: string;
    completedAt: string;
    duration: number;
    output?: any;
    error?: string;
}

export class WorkflowHistoryService {
    private historyDir: string;
    
    constructor(workspaceRoot: string) {
        this.historyDir = path.join(workspaceRoot, '_AiDevLog', 'History');
        if (!fs.existsSync(this.historyDir)) {
            fs.mkdirSync(this.historyDir, { recursive: true });
        }
    }
    
    /**
     * Save workflow to history
     */
    async saveWorkflow(entry: WorkflowHistoryEntry): Promise<void> {
        const sessionFile = path.join(this.historyDir, `${entry.sessionId}.json`);
        
        let history: WorkflowHistoryEntry[] = [];
        if (fs.existsSync(sessionFile)) {
            try {
                history = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
            } catch (e) {
                console.error(`[WorkflowHistoryService] Failed to parse history file: ${e}`);
                history = [];
            }
        }
        
        history.unshift(entry); // Add to beginning (newest first)
        
        // Keep only last 1000 entries per session
        if (history.length > 1000) {
            history = history.slice(0, 1000);
        }
        
        fs.writeFileSync(sessionFile, JSON.stringify(history, null, 2));
    }
    
    /**
     * Query workflow from history
     */
    async getWorkflow(sessionId: string, workflowId: string): Promise<WorkflowHistoryEntry | null> {
        const sessionFile = path.join(this.historyDir, `${sessionId}.json`);
        
        if (!fs.existsSync(sessionFile)) {
            return null;
        }
        
        try {
            const history: WorkflowHistoryEntry[] = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
            return history.find(e => e.id === workflowId) || null;
        } catch (e) {
            console.error(`[WorkflowHistoryService] Failed to read history: ${e}`);
            return null;
        }
    }
    
    /**
     * Get all workflows for a session
     */
    async getSessionHistory(sessionId: string, limit?: number): Promise<WorkflowHistoryEntry[]> {
        const sessionFile = path.join(this.historyDir, `${sessionId}.json`);
        
        if (!fs.existsSync(sessionFile)) {
            return [];
        }
        
        try {
            const history: WorkflowHistoryEntry[] = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
            return limit ? history.slice(0, limit) : history;
        } catch (e) {
            console.error(`[WorkflowHistoryService] Failed to read session history: ${e}`);
            return [];
        }
    }
}


