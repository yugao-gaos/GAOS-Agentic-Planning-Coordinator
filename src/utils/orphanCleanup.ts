/**
 * orphanCleanup.ts - Standalone utility for killing orphan cursor-agent processes
 * 
 * This is a dependency-free utility that can be called during:
 * - Extension activation (before services are initialized)
 * - Daemon startup (before services are initialized)
 * - Deactivation/shutdown
 * 
 * No ServiceLocator dependencies - uses console.log for output.
 */

import { execSync } from 'child_process';

/**
 * Kill orphan cursor-agent processes from previous sessions
 * 
 * @param excludePids Optional set of PIDs to exclude (e.g., currently tracked processes)
 * @param logPrefix Optional prefix for log messages (default: '[OrphanCleanup]')
 * @returns Number of processes killed
 */
export async function killOrphanCursorAgents(
    excludePids: Set<number> = new Set(),
    logPrefix: string = '[OrphanCleanup]'
): Promise<number> {
    let killedCount = 0;

    if (process.platform === 'win32') {
        // Windows implementation using WMIC or PowerShell
        try {
            // Use WMIC to find cursor-agent processes
            // WMIC returns: Handle  Name  CommandLine
            let result: string;
            try {
                // Try WMIC first (available on most Windows versions)
                result = execSync(
                    'wmic process where "commandline like \'%cursor%agent%\'" get processid,commandline /format:csv',
                    { encoding: 'utf-8', timeout: 10000, windowsHide: true }
                ).trim();
            } catch {
                // Fall back to PowerShell if WMIC is not available (Windows 11+)
                result = execSync(
                    'powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*cursor*agent*\' } | Select-Object ProcessId | ConvertTo-Csv -NoTypeInformation"',
                    { encoding: 'utf-8', timeout: 10000, windowsHide: true }
                ).trim();
            }
            
            if (!result) return 0;
            
            // Parse CSV output to extract PIDs
            const lines = result.split('\n').filter((line: string) => line.trim());
            for (const line of lines) {
                // Skip header lines
                if (line.includes('ProcessId') || line.includes('Node')) continue;
                
                // Extract PID from CSV (last number in line for WMIC, quoted for PowerShell)
                const pidMatch = line.match(/(\d+)\s*$/);
                if (pidMatch) {
                    const pidNum = parseInt(pidMatch[1], 10);
                    if (!isNaN(pidNum) && !excludePids.has(pidNum) && pidNum !== process.pid) {
                        try {
                            // Use taskkill to terminate the process tree
                            execSync(`taskkill /PID ${pidNum} /T /F`, { 
                                timeout: 5000,
                                windowsHide: true,
                                stdio: 'ignore'
                            });
                            console.log(`${logPrefix} 🗑️ Killed orphan cursor-agent process ${pidNum} (Windows)`);
                            killedCount++;
                        } catch {
                            // Process might already be dead or access denied
                        }
                    }
                }
            }
        } catch (e) {
            console.log(`${logPrefix} Error finding orphan processes on Windows: ${e}`);
        }
    } else {
        // Unix (macOS/Linux) implementation
        try {
            // Find cursor-agent processes
            const result = execSync(
                'ps aux | grep -E "cursor.*(agent|--model)" | grep -v grep | awk \'{print $2}\'',
                { encoding: 'utf-8', timeout: 5000 }
            ).trim();
            
            if (!result) return 0;
            
            const pids = result.split('\n').filter((p: string) => p.trim());
            
            for (const pid of pids) {
                const pidNum = parseInt(pid, 10);
                if (!isNaN(pidNum) && !excludePids.has(pidNum) && pidNum !== process.pid) {
                    try {
                        process.kill(pidNum, 'SIGKILL');
                        console.log(`${logPrefix} 🗑️ Killed orphan cursor-agent process ${pidNum}`);
                        killedCount++;
                    } catch {
                        // Process might already be dead
                    }
                }
            }
        } catch (e) {
            console.log(`${logPrefix} Error finding orphan processes: ${e}`);
        }
    }
    
    return killedCount;
}

