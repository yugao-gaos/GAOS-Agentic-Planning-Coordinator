import { spawn } from 'child_process';

/**
 * Focus Unity Editor window
 * Works on macOS, Windows, and Linux
 */
export async function focusUnityEditor(): Promise<void> {
    const platform = process.platform;

    if (platform === 'darwin') {
        // macOS - use AppleScript
        await new Promise<void>((resolve, reject) => {
            const proc = spawn('osascript', ['-e', 'tell application "Unity" to activate']);
            proc.on('close', () => resolve());
            proc.on('error', reject);
        });
    } else if (platform === 'win32') {
        // Windows - use PowerShell to focus Unity window
        await new Promise<void>((resolve) => {
            const psScript = `
                Add-Type @"
                using System;
                using System.Runtime.InteropServices;
                public class Win32 {
                    [DllImport("user32.dll")]
                    public static extern bool SetForegroundWindow(IntPtr hWnd);
                    [DllImport("user32.dll")]
                    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                }
"@
                $unity = Get-Process -Name "Unity" -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($unity) {
                    [Win32]::ShowWindow($unity.MainWindowHandle, 9)
                    [Win32]::SetForegroundWindow($unity.MainWindowHandle)
                }
            `.replace(/\n\s*/g, ' ');
            
            const proc = spawn('powershell', ['-Command', psScript], { 
                windowsHide: true,
                stdio: 'ignore'
            });
            proc.on('close', () => resolve());
            proc.on('error', () => resolve()); // Don't fail if PowerShell fails
        });
    } else {
        // Linux - use wmctrl or xdotool if available
        await new Promise<void>((resolve) => {
            const proc = spawn('wmctrl', ['-a', 'Unity'], { stdio: 'ignore' });
            proc.on('close', () => resolve());
            proc.on('error', () => {
                // Try xdotool as fallback
                const proc2 = spawn('xdotool', ['search', '--name', 'Unity', 'windowactivate'], { stdio: 'ignore' });
                proc2.on('close', () => resolve());
                proc2.on('error', () => resolve());
            });
        });
    }
}

