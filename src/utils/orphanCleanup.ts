/**
 * orphanCleanup.ts - Standalone utility for managing cursor-agent processes
 * 
 * This is a dependency-free utility that can be called during:
 * - Extension activation (before services are initialized)
 * - Daemon startup (before services are initialized)
 * - Deactivation/shutdown
 * - Capacity checks during evaluation
 * 
 * No ServiceLocator dependencies - uses console.log for output.
 */

import { execSync } from 'child_process';

/**
 * Count cursor-agent processes currently running
 * Cross-platform: works on Windows, macOS, and Linux
 * 
 * @returns Number of cursor-agent processes found
 */
export function countCursorAgentProcesses(): number {
    try {
        if (process.platform === 'win32') {
            let totalCount = 0;
            
            // Count Windows-native cursor-agent processes (including WSL wrappers)
            try {
                let result: string;
                try {
                    result = execSync(
                        'wmic process where "commandline like \'%cursor%agent%\'" get processid /format:csv',
                        { encoding: 'utf-8', timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
                    ).trim();
                } catch {
                    result = execSync(
                        'powershell -Command "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*cursor*agent*\' }).Count"',
                        { encoding: 'utf-8', timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
                    ).trim();
                    const count = parseInt(result, 10);
                    return isNaN(count) ? 0 : count;
                }
                
                if (result) {
                    const lines = result.split('\n').filter((line: string) => {
                        const trimmed = line.trim();
                        return trimmed && !trimmed.includes('ProcessId') && !trimmed.includes('Node') && /\d+/.test(trimmed);
                    });
                    totalCount = lines.length;
                }
            } catch {
                // Ignore Windows count errors
            }
            
            // Also count cursor-agent processes running inside WSL
            // Skip WSL if environment variable is set (avoids hangs on misconfigured WSL)
            if (!process.env.APC_SKIP_WSL_CHECK) {
                try {
                    // Use ps + grep instead of pgrep (more reliable in WSL, avoids self-matching issues)
                    // Exclude worker-server (Cursor IDE's built-in background process)
                    // Note: timeout is reduced to 3s to avoid blocking startup on slow/misconfigured WSL
                    const wslResult = execSync(
                        'wsl -d Ubuntu -- bash -c "ps aux 2>/dev/null | grep cursor-agent | grep -v grep | grep -v worker-server | wc -l || echo 0"',
                        { encoding: 'utf-8', timeout: 3000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
                    ).trim();
                    
                    const wslCount = parseInt(wslResult, 10);
                    if (!isNaN(wslCount) && wslCount > 0) {
                        // Use WSL count as the authoritative count since that's where cursor-agent actually runs
                        return wslCount;
                    }
                } catch {
                    // WSL not available or timed out - use Windows count
                }
            }
            
            return totalCount;
        } else {
            // Unix (macOS/Linux): Use ps + grep
            const result = execSync(
                'ps aux | grep -E "cursor.*(agent|--model)" | grep -v grep | wc -l',
                { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
            
            const count = parseInt(result, 10);
            return isNaN(count) ? 0 : count;
        }
    } catch {
        // If process counting fails, return 0 (don't block the workflow)
        return 0;
    }
}

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
        // Windows implementation - handles both native Windows and WSL processes
        
        // Step 1: Try to kill Windows-native cursor-agent processes
        try {
            let result: string;
            try {
                result = execSync(
                    'wmic process where "commandline like \'%cursor%agent%\'" get processid,commandline /format:csv',
                    { encoding: 'utf-8', timeout: 10000, windowsHide: true }
                ).trim();
            } catch {
                result = execSync(
                    'powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*cursor*agent*\' } | Select-Object ProcessId | ConvertTo-Csv -NoTypeInformation"',
                    { encoding: 'utf-8', timeout: 10000, windowsHide: true }
                ).trim();
            }
            
            if (result) {
                const lines = result.split('\n').filter((line: string) => line.trim());
                
                for (const line of lines) {
                    // Skip header lines and WMIC's own process
                    if (line.includes('ProcessId') || line.toLowerCase().includes('wmic.exe')) continue;
                    
                    // Extract PID from the END of the line (after last comma)
                    const lastCommaIdx = line.lastIndexOf(',');
                    if (lastCommaIdx === -1) continue;
                    
                    const pidStr = line.substring(lastCommaIdx + 1).replace(/\r/g, '').trim();
                    const pidNum = parseInt(pidStr, 10);
                    
                    if (!isNaN(pidNum) && pidNum > 0 && !excludePids.has(pidNum) && pidNum !== process.pid) {
                        try {
                            execSync(`taskkill /PID ${pidNum} /T /F`, { 
                                timeout: 5000,
                                windowsHide: true,
                                stdio: 'ignore'
                            });
                            console.log(`${logPrefix} 🗑️ Killed orphan cursor-agent process ${pidNum} (Windows)`);
                            killedCount++;
                        } catch {
                            // Process might already be dead, running in WSL, or access denied
                            // Will be handled by WSL cleanup below
                        }
                    }
                }
            }
        } catch (e) {
            console.log(`${logPrefix} Error finding orphan processes on Windows: ${e}`);
        }
        
        // Step 2: Kill cursor-agent processes running inside WSL
        // This handles cases where cursor-agent is invoked via WSL
        // Skip WSL if environment variable is set (avoids hangs on misconfigured WSL)
        if (!process.env.APC_SKIP_WSL_CHECK) {
            try {
                // Check if WSL is available and has cursor-agent processes
                // Use ps + grep + awk instead of pgrep (more reliable in WSL, avoids self-matching issues)
                // Exclude worker-server (Cursor IDE's built-in background process - should not be killed)
                // Note: timeout reduced to 5s to avoid blocking startup on slow/misconfigured WSL
                const wslCheck = execSync(
                    'wsl -d Ubuntu -- bash -c "ps aux 2>/dev/null | grep cursor-agent | grep -v grep | grep -v worker-server | awk \'{print \\$2}\' || true"',
                    { encoding: 'utf-8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
                ).trim();
                
                if (wslCheck) {
                    const wslPids = wslCheck.split('\n').filter((p: string) => p.trim() && /^\d+$/.test(p.trim()));
                    if (wslPids.length > 0) {
                        console.log(`${logPrefix} Found ${wslPids.length} cursor-agent processes in WSL (PIDs: ${wslPids.join(', ')}), killing...`);
                        
                        // Kill each process by PID individually for more reliable cleanup
                        let wslKilled = 0;
                        for (const pid of wslPids) {
                            try {
                                execSync(
                                    `wsl -d Ubuntu -- bash -c "kill -9 ${pid} 2>/dev/null; exit 0"`,
                                    { encoding: 'utf-8', timeout: 3000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
                                );
                                wslKilled++;
                            } catch {
                                // Process might already be dead or WSL timed out
                            }
                        }
                        
                        if (wslKilled > 0) {
                            console.log(`${logPrefix} 🗑️ Sent SIGKILL to ${wslKilled} cursor-agent processes in WSL`);
                            killedCount += wslKilled;
                        }
                    }
                }
            } catch {
                // WSL not available, timed out, or not configured - that's fine, skip WSL cleanup
            }
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

