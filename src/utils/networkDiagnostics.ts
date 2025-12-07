/**
 * networkDiagnostics.ts - Network connectivity diagnostics for troubleshooting
 * 
 * Helps diagnose network issues that may cause fetch failures in Cursor agents.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import * as http from 'http';

const execAsync = promisify(exec);

export interface NetworkDiagnosticResult {
    check: string;
    success: boolean;
    details: string;
    latencyMs?: number;
}

export interface NetworkDiagnosticsReport {
    timestamp: string;
    platform: string;
    results: NetworkDiagnosticResult[];
    summary: {
        passed: number;
        failed: number;
        recommendations: string[];
    };
}

/**
 * Check if a URL is reachable via HTTPS
 */
async function checkHttpsEndpoint(url: string, timeoutMs: number = 10000): Promise<NetworkDiagnosticResult> {
    const startTime = Date.now();
    
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname || '/',
            method: 'HEAD',
            timeout: timeoutMs,
        };
        
        const req = https.request(options, (res) => {
            const latency = Date.now() - startTime;
            resolve({
                check: `HTTPS: ${urlObj.hostname}`,
                success: res.statusCode !== undefined && res.statusCode < 500,
                details: `Status: ${res.statusCode}, Latency: ${latency}ms`,
                latencyMs: latency
            });
        });
        
        req.on('error', (err) => {
            resolve({
                check: `HTTPS: ${urlObj.hostname}`,
                success: false,
                details: `Error: ${err.message}`
            });
        });
        
        req.on('timeout', () => {
            req.destroy();
            resolve({
                check: `HTTPS: ${urlObj.hostname}`,
                success: false,
                details: `Timeout after ${timeoutMs}ms`
            });
        });
        
        req.end();
    });
}

/**
 * Check DNS resolution
 */
async function checkDns(hostname: string): Promise<NetworkDiagnosticResult> {
    const dns = await import('dns').then(m => m.promises);
    const startTime = Date.now();
    
    try {
        const addresses = await dns.resolve4(hostname);
        const latency = Date.now() - startTime;
        return {
            check: `DNS: ${hostname}`,
            success: true,
            details: `Resolved to: ${addresses.join(', ')} (${latency}ms)`,
            latencyMs: latency
        };
    } catch (err: any) {
        return {
            check: `DNS: ${hostname}`,
            success: false,
            details: `Failed: ${err.message}`
        };
    }
}

/**
 * Check proxy settings
 */
function checkProxySettings(): NetworkDiagnosticResult {
    const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
    const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const noProxy = process.env.NO_PROXY || process.env.no_proxy;
    
    const details: string[] = [];
    if (httpProxy) details.push(`HTTP_PROXY: ${httpProxy}`);
    if (httpsProxy) details.push(`HTTPS_PROXY: ${httpsProxy}`);
    if (noProxy) details.push(`NO_PROXY: ${noProxy}`);
    
    return {
        check: 'Proxy Settings',
        success: true,  // Not a failure, just informational
        details: details.length > 0 ? details.join(', ') : 'No proxy configured'
    };
}

/**
 * Run all network diagnostics
 */
export async function runNetworkDiagnostics(): Promise<NetworkDiagnosticsReport> {
    const results: NetworkDiagnosticResult[] = [];
    
    // Check proxy settings first (informational)
    results.push(checkProxySettings());
    
    // DNS checks for important hosts
    const dnsHosts = [
        'api.anthropic.com',
        'api.cursor.com',
        'api.openai.com'
    ];
    
    for (const host of dnsHosts) {
        results.push(await checkDns(host));
    }
    
    // HTTPS endpoint checks
    const endpoints = [
        'https://api.anthropic.com',
        'https://api.cursor.com',
        'https://api.openai.com'
    ];
    
    for (const endpoint of endpoints) {
        results.push(await checkHttpsEndpoint(endpoint));
    }
    
    // Generate recommendations based on failures
    const recommendations: string[] = [];
    const failedChecks = results.filter(r => !r.success);
    
    if (failedChecks.some(r => r.check.startsWith('DNS:'))) {
        recommendations.push('DNS resolution failing - check your network connection or DNS settings');
        if (process.platform === 'win32') {
            recommendations.push('Try: ipconfig /flushdns');
        } else {
            recommendations.push('Try: sudo dscacheutil -flushcache (macOS) or systemd-resolve --flush-caches (Linux)');
        }
    }
    
    if (failedChecks.some(r => r.check.startsWith('HTTPS:'))) {
        recommendations.push('HTTPS connections failing - check firewall/VPN settings');
        
        const proxyResult = results.find(r => r.check === 'Proxy Settings');
        if (proxyResult?.details === 'No proxy configured') {
            recommendations.push('If behind a corporate proxy, set HTTP_PROXY and HTTPS_PROXY environment variables');
        }
    }
    
    if (failedChecks.some(r => r.details.includes('ETIMEDOUT'))) {
        recommendations.push('Connection timeouts detected - network may be slow or blocked');
    }
    
    if (failedChecks.length === 0) {
        recommendations.push('All network checks passed - if you still see fetch errors, the issue may be temporary or rate-limiting');
    }
    
    return {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        results,
        summary: {
            passed: results.filter(r => r.success).length,
            failed: failedChecks.length,
            recommendations
        }
    };
}

/**
 * Format network diagnostics report for display
 */
export function formatDiagnosticsReport(report: NetworkDiagnosticsReport): string {
    const lines: string[] = [
        '═══════════════════════════════════════════════════════════',
        '                  Network Diagnostics Report',
        '═══════════════════════════════════════════════════════════',
        `Timestamp: ${report.timestamp}`,
        `Platform:  ${report.platform}`,
        '',
        '─────────────────────────────────────────────────────────────',
        'Results:',
        ''
    ];
    
    for (const result of report.results) {
        const icon = result.success ? '✅' : '❌';
        lines.push(`${icon} ${result.check}`);
        lines.push(`   ${result.details}`);
    }
    
    lines.push('');
    lines.push('─────────────────────────────────────────────────────────────');
    lines.push(`Summary: ${report.summary.passed} passed, ${report.summary.failed} failed`);
    lines.push('');
    
    if (report.summary.recommendations.length > 0) {
        lines.push('Recommendations:');
        for (const rec of report.summary.recommendations) {
            lines.push(`  • ${rec}`);
        }
    }
    
    lines.push('═══════════════════════════════════════════════════════════');
    
    return lines.join('\n');
}





