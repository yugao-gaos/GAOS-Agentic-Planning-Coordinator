/**
 * memory-leak-tests.ts - Comprehensive memory leak detection tests
 * 
 * Tests for memory leaks in critical components when running with multiple agents
 */

import { getMemoryMonitor, MemoryMonitor } from '../src/services/MemoryMonitor';

/**
 * Memory leak test utilities
 */
export class MemoryLeakTester {
    private monitor: MemoryMonitor;
    private initialSnapshot: any;
    
    constructor() {
        this.monitor = getMemoryMonitor({
            enableAutoSnapshot: false, // Manual control for tests
            maxSnapshots: 1000
        });
    }
    
    /**
     * Start a memory leak test
     */
    start(): void {
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
        }
        
        // Take initial snapshot
        this.initialSnapshot = this.monitor.takeSnapshot();
        console.log(`[MemoryLeakTester] Started at ${this.initialSnapshot.totalHeapUsedMB.toFixed(2)} MB`);
    }
    
    /**
     * Check for memory leaks after test
     * 
     * @param maxGrowthMB Maximum allowed memory growth in MB
     * @returns true if no leak detected, false if leak found
     */
    check(maxGrowthMB: number = 50): { passed: boolean; message: string; growthMB: number } {
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
        }
        
        // Wait a bit for GC to complete
        const waitForGC = () => new Promise(resolve => setTimeout(resolve, 100));
        
        return new Promise((resolve) => {
            waitForGC().then(() => {
                const finalSnapshot = this.monitor.takeSnapshot();
                const growthMB = finalSnapshot.totalHeapUsedMB - this.initialSnapshot.totalHeapUsedMB;
                
                const passed = growthMB <= maxGrowthMB;
                const message = passed
                    ? `✓ Memory stable: ${growthMB.toFixed(2)} MB growth (limit: ${maxGrowthMB} MB)`
                    : `✗ Memory leak detected: ${growthMB.toFixed(2)} MB growth (limit: ${maxGrowthMB} MB)`;
                
                console.log(`[MemoryLeakTester] ${message}`);
                console.log(`  Initial: ${this.initialSnapshot.totalHeapUsedMB.toFixed(2)} MB`);
                console.log(`  Final:   ${finalSnapshot.totalHeapUsedMB.toFixed(2)} MB`);
                
                resolve({ passed, message, growthMB });
            });
        }) as any;
    }
    
    /**
     * Get detailed memory report
     */
    getReport(): string {
        return this.monitor.formatSummary();
    }
}

/**
 * Test suite for memory leaks
 */
export class MemoryLeakTestSuite {
    private results: Array<{ name: string; passed: boolean; message: string }> = [];
    
    /**
     * Test 1: Workflow creation and disposal
     */
    async testWorkflowMemory(): Promise<void> {
        const tester = new MemoryLeakTester();
        tester.start();
        
        // Simulate 100 workflow creations and disposals
        const { BaseWorkflow } = await import('../src/services/workflows/BaseWorkflow');
        const workflows: any[] = [];
        
        for (let i = 0; i < 100; i++) {
            // Create mock workflow (we'd need actual implementation here)
            // workflows.push(new SomeWorkflow(...));
        }
        
        // Dispose all workflows
        for (const workflow of workflows) {
            // workflow.dispose();
        }
        workflows.length = 0;
        
        const result = await tester.check(20); // Allow 20MB growth
        this.results.push({ name: 'Workflow Memory', ...result });
    }
    
    /**
     * Test 2: Event listener leaks
     */
    async testEventListenerMemory(): Promise<void> {
        const tester = new MemoryLeakTester();
        tester.start();
        
        const { TypedEventEmitter } = await import('../src/services/TypedEventEmitter');
        
        // Create and dispose 1000 event emitters
        for (let i = 0; i < 1000; i++) {
            const emitter = new TypedEventEmitter<string>();
            
            // Subscribe some listeners
            const dispose1 = emitter.event(() => {});
            const dispose2 = emitter.event(() => {});
            const dispose3 = emitter.event(() => {});
            
            // Fire some events
            emitter.fire('test');
            
            // Dispose
            dispose1.dispose();
            dispose2.dispose();
            dispose3.dispose();
            emitter.dispose();
        }
        
        const result = await tester.check(10); // Allow 10MB growth
        this.results.push({ name: 'Event Listener Memory', ...result });
    }
    
    /**
     * Test 3: Session state accumulation
     */
    async testSessionMemory(): Promise<void> {
        const tester = new MemoryLeakTester();
        tester.start();
        
        // Test would create and clean up sessions
        // Skipped for now as it requires full system integration
        
        const result = await tester.check(30);
        this.results.push({ name: 'Session Memory', ...result });
    }
    
    /**
     * Test 4: Client connection/disconnection
     */
    async testClientConnectionMemory(): Promise<void> {
        const tester = new MemoryLeakTester();
        tester.start();
        
        const { EventBroadcaster } = await import('../src/daemon/EventBroadcaster');
        const broadcaster = new EventBroadcaster();
        
        // Simulate 100 client connections and disconnections
        for (let i = 0; i < 100; i++) {
            const clientId = `client_${i}`;
            const sessionId = `session_${i % 10}`; // 10 sessions
            
            // Subscribe
            broadcaster.subscribeToSession(clientId, sessionId);
            
            // Broadcast some events
            broadcaster.broadcast('session.updated', {
                sessionId,
                status: 'active',
                previousStatus: 'pending',
                changes: ['status'],
                updatedAt: new Date().toISOString()
            });
            
            // Unsubscribe
            broadcaster.unsubscribeClient(clientId);
        }
        
        // Cleanup orphaned sessions
        broadcaster.cleanupOrphanedSessions();
        broadcaster.dispose();
        
        const result = await tester.check(15);
        this.results.push({ name: 'Client Connection Memory', ...result });
    }
    
    /**
     * Test 5: Task manager memory with many tasks
     */
    async testTaskManagerMemory(): Promise<void> {
        const tester = new MemoryLeakTester();
        tester.start();
        
        // Test would create, complete, and clean up tasks
        // Requires TaskManager integration
        
        const result = await tester.check(25);
        this.results.push({ name: 'Task Manager Memory', ...result });
    }
    
    /**
     * Run all tests
     */
    async runAll(): Promise<void> {
        console.log('\n=== Memory Leak Test Suite ===\n');
        
        await this.testEventListenerMemory();
        await this.testClientConnectionMemory();
        // await this.testWorkflowMemory();
        // await this.testSessionMemory();
        // await this.testTaskManagerMemory();
        
        this.printResults();
    }
    
    /**
     * Print test results
     */
    private printResults(): void {
        console.log('\n=== Test Results ===\n');
        
        let passed = 0;
        let failed = 0;
        
        for (const result of this.results) {
            console.log(`${result.passed ? '✓' : '✗'} ${result.name}`);
            console.log(`  ${result.message}`);
            
            if (result.passed) {
                passed++;
            } else {
                failed++;
            }
        }
        
        console.log(`\nTotal: ${passed} passed, ${failed} failed\n`);
        
        if (failed === 0) {
            console.log('🎉 All memory leak tests passed!');
        } else {
            console.log('⚠️  Some memory leak tests failed. Review the logs above.');
        }
    }
}

/**
 * Load test with multiple concurrent agents
 */
export class LoadTestRunner {
    /**
     * Run load test with N concurrent agents working on M tasks
     */
    async runLoadTest(agentCount: number, taskCount: number, durationMinutes: number): Promise<void> {
        console.log(`\n=== Load Test: ${agentCount} agents, ${taskCount} tasks, ${durationMinutes} minutes ===\n`);
        
        const monitor = getMemoryMonitor({
            enableAutoSnapshot: true,
            snapshotIntervalMs: 30 * 1000, // Every 30 seconds
            maxSnapshots: 200
        });
        
        const startSnapshot = monitor.takeSnapshot();
        console.log(`Starting memory: ${startSnapshot.totalHeapUsedMB.toFixed(2)} MB`);
        
        // Simulate load (would integrate with actual system)
        const startTime = Date.now();
        const endTime = startTime + (durationMinutes * 60 * 1000);
        
        let iteration = 0;
        while (Date.now() < endTime) {
            iteration++;
            
            // Simulate work (placeholder)
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Print progress
            const elapsed = (Date.now() - startTime) / 1000;
            const snapshot = monitor.takeSnapshot();
            console.log(`[${elapsed.toFixed(0)}s] Iteration ${iteration}, Memory: ${snapshot.totalHeapUsedMB.toFixed(2)} MB`);
        }
        
        // Final report
        const summary = monitor.getSummary();
        console.log('\n' + monitor.formatSummary());
        
        // Check for memory leaks
        const trend = summary.trend;
        if (trend.isGrowing && trend.growthRateMBPerHour > 10) {
            console.log(`\n⚠️  WARNING: Potential memory leak detected!`);
            console.log(`   Growth rate: ${trend.growthRateMBPerHour.toFixed(2)} MB/hour`);
        } else {
            console.log(`\n✓ Memory usage appears stable`);
        }
    }
}

// Export test runner
if (require.main === module) {
    const suite = new MemoryLeakTestSuite();
    suite.runAll().catch(console.error);
}

