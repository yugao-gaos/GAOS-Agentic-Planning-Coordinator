using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;

namespace ApcBridge.Pipeline
{
    /// <summary>
    /// Log entry captured during a pipeline step
    /// </summary>
    public class LogEntry
    {
        public string Timestamp { get; set; }
        public string Type { get; set; }
        public string Message { get; set; }
        public string StackTrace { get; set; }
        public List<string> Screenshots { get; set; }
    }
    
    /// <summary>
    /// Captures Unity logs during pipeline step execution.
    /// Uses Application.logMessageReceived for accurate capture.
    /// </summary>
    public class CaptureSession : IDisposable
    {
        private readonly string _pipelineId;
        private readonly string _stepName;
        private readonly CaptureMode _mode;
        private readonly string _stepFolder;
        
        private readonly List<LogEntry> _logs = new List<LogEntry>();
        private ScreenshotBuffer _screenshotBuffer;
        private bool _isCapturing;
        private DateTime _startTime;
        private int _errorCount;
        private int _warningCount;
        
        // For screenshot capture on error
        private readonly List<PendingErrorScreenshot> _pendingScreenshots = new List<PendingErrorScreenshot>();
        private int _errorIndex;
        
        private class PendingErrorScreenshot
        {
            public DateTime ErrorTime { get; set; }
            public int ErrorIndex { get; set; }
            public LogEntry LogEntry { get; set; }
        }
        
        public int ErrorCount => _errorCount;
        public int WarningCount => _warningCount;
        public string StepFolder => _stepFolder;
        
        /// <summary>
        /// Create a new capture session for a pipeline step
        /// </summary>
        public CaptureSession(string pipelineId, string stepName, CaptureMode mode, string projectPath)
        {
            _pipelineId = pipelineId;
            _stepName = stepName;
            _mode = mode;
            
            // Create folder structure: _AiDevLog/Logs/<pipelineId>/<stepName>/
            _stepFolder = Path.Combine(projectPath, "_AiDevLog", "Logs", pipelineId, stepName);
            Directory.CreateDirectory(_stepFolder);
            
            // Initialize screenshot buffer for play modes
            if (_mode == CaptureMode.LogAndScreenshot)
            {
                _screenshotBuffer = new ScreenshotBuffer(20); // 2 seconds at 10fps
            }
        }
        
        /// <summary>
        /// Start capturing logs
        /// </summary>
        public void Start()
        {
            if (_isCapturing) return;
            
            _isCapturing = true;
            _startTime = DateTime.Now;
            _logs.Clear();
            _errorCount = 0;
            _warningCount = 0;
            _errorIndex = 0;
            _pendingScreenshots.Clear();
            
            Application.logMessageReceived += OnLogReceived;
            
            Debug.Log($"[APC] CaptureSession started for {_stepName}");
        }
        
        /// <summary>
        /// Capture a screenshot frame (called 10x/sec during play modes)
        /// </summary>
        public void CaptureFrame()
        {
            if (!_isCapturing || _mode != CaptureMode.LogAndScreenshot) return;
            
            _screenshotBuffer?.CaptureFrame();
            
            // Check for pending screenshots that need to be saved (1 second after error)
            ProcessPendingScreenshots();
        }
        
        /// <summary>
        /// Stop capturing and persist logs
        /// </summary>
        public string Stop()
        {
            if (!_isCapturing) return null;
            
            _isCapturing = false;
            Application.logMessageReceived -= OnLogReceived;
            
            // Flush any pending screenshots immediately
            FlushPendingScreenshots();
            
            // Persist logs to file
            var logPath = PersistLogs();
            
            Debug.Log($"[APC] CaptureSession stopped for {_stepName}: {_logs.Count} logs, {_errorCount} errors");
            
            return logPath;
        }
        
        private void OnLogReceived(string condition, string stackTrace, LogType type)
        {
            if (!_isCapturing) return;
            
            var entry = new LogEntry
            {
                Timestamp = DateTime.Now.ToString("HH:mm:ss.fff"),
                Type = type.ToString(),
                Message = condition,
                StackTrace = type == LogType.Error || type == LogType.Exception ? stackTrace : null
            };
            
            _logs.Add(entry);
            
            // Track counts
            if (type == LogType.Error || type == LogType.Exception)
            {
                _errorCount++;
                
                // Queue screenshot save for play modes
                if (_mode == CaptureMode.LogAndScreenshot && _screenshotBuffer != null)
                {
                    _errorIndex++;
                    entry.Screenshots = new List<string>();
                    
                    _pendingScreenshots.Add(new PendingErrorScreenshot
                    {
                        ErrorTime = DateTime.Now,
                        ErrorIndex = _errorIndex,
                        LogEntry = entry
                    });
                }
            }
            else if (type == LogType.Warning)
            {
                _warningCount++;
            }
        }
        
        private void ProcessPendingScreenshots()
        {
            if (_screenshotBuffer == null) return;
            
            var now = DateTime.Now;
            var toRemove = new List<PendingErrorScreenshot>();
            
            foreach (var pending in _pendingScreenshots)
            {
                // Wait 1 second after error to capture +1s screenshots
                if ((now - pending.ErrorTime).TotalSeconds >= 1.0)
                {
                    SaveErrorScreenshots(pending);
                    toRemove.Add(pending);
                }
            }
            
            foreach (var item in toRemove)
            {
                _pendingScreenshots.Remove(item);
            }
        }
        
        private void FlushPendingScreenshots()
        {
            if (_screenshotBuffer == null) return;
            
            // Save all pending screenshots immediately with whatever we have
            foreach (var pending in _pendingScreenshots)
            {
                SaveErrorScreenshots(pending);
            }
            _pendingScreenshots.Clear();
        }
        
        private void SaveErrorScreenshots(PendingErrorScreenshot pending)
        {
            if (_screenshotBuffer == null) return;
            
            var errorTime = pending.ErrorTime;
            var prefix = $"err_{pending.ErrorIndex:D3}";
            
            // Get screenshots from -1s to +1s around error
            var screenshots = _screenshotBuffer.GetScreenshotsAround(errorTime, 1.0f);
            
            foreach (var (texture, offsetMs) in screenshots)
            {
                var filename = $"{prefix}_{(offsetMs >= 0 ? "+" : "")}{offsetMs}ms.png";
                var filePath = Path.Combine(_stepFolder, filename);
                
                try
                {
                    var bytes = texture.EncodeToPNG();
                    File.WriteAllBytes(filePath, bytes);
                    pending.LogEntry.Screenshots.Add(filename);
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[APC] Failed to save screenshot: {ex.Message}");
                }
            }
        }
        
        private string PersistLogs()
        {
            var logPath = Path.Combine(_stepFolder, "log.jsonl");
            var sb = new StringBuilder();
            
            // Header line
            sb.AppendLine($"# Pipeline: {_pipelineId} | Step: {_stepName} | Started: {_startTime:yyyy-MM-ddTHH:mm:ssZ}");
            
            // Log entries as JSON lines
            foreach (var entry in _logs)
            {
                sb.Append("{");
                sb.Append($"\"t\":\"{entry.Timestamp}\"");
                sb.Append($",\"type\":\"{entry.Type}\"");
                sb.Append($",\"msg\":{EscapeJson(entry.Message)}");
                
                if (!string.IsNullOrEmpty(entry.StackTrace))
                {
                    sb.Append($",\"stack\":{EscapeJson(entry.StackTrace)}");
                }
                
                if (entry.Screenshots != null && entry.Screenshots.Count > 0)
                {
                    sb.Append(",\"screenshots\":[");
                    for (int i = 0; i < entry.Screenshots.Count; i++)
                    {
                        if (i > 0) sb.Append(",");
                        sb.Append($"\"{entry.Screenshots[i]}\"");
                    }
                    sb.Append("]");
                }
                
                sb.AppendLine("}");
            }
            
            File.WriteAllText(logPath, sb.ToString());
            return $"{_stepName}/log.jsonl";
        }
        
        private string EscapeJson(string s)
        {
            if (s == null) return "null";
            
            var sb = new StringBuilder("\"");
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default: sb.Append(c); break;
                }
            }
            sb.Append("\"");
            return sb.ToString();
        }
        
        public void Dispose()
        {
            if (_isCapturing)
            {
                Stop();
            }
            _screenshotBuffer?.Dispose();
        }
    }
}

