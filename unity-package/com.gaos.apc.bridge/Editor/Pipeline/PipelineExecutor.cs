using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace ApcBridge.Pipeline
{
    /// <summary>
    /// Executes a full pipeline with log and screenshot capture.
    /// Runs all steps sequentially, fails early on error.
    /// </summary>
    public class PipelineExecutor
    {
        private readonly string _pipelineId;
        private readonly string[] _operations;
        private readonly string _testScene;
        private readonly string _projectPath;
        private readonly string _logFolder;
        
        private CaptureSession _currentSession;
        private float _lastCaptureTime;
        private const float CAPTURE_INTERVAL = 0.1f; // 10fps
        
        public PipelineExecutor(string pipelineId, string[] operations, string testScene)
        {
            _pipelineId = pipelineId;
            _operations = operations;
            _testScene = testScene ?? "Assets/Scenes/Main.unity";
            _projectPath = Path.GetDirectoryName(Application.dataPath);
            _logFolder = Path.Combine("_AiDevLog", "Logs", pipelineId);
        }
        
        /// <summary>
        /// Execute the entire pipeline
        /// </summary>
        public async Task<PipelineResult> ExecuteAsync()
        {
            var stepResults = new List<StepResult>();
            string failedAtStep = null;
            bool success = true;
            
            Debug.Log($"[APC] Pipeline {_pipelineId} starting: {string.Join(", ", _operations)}");
            
            // Notify daemon of pipeline start
            ApcUnityBridge.Instance?.SendEvent(UnityEvents.PipelineStarted, new
            {
                pipelineId = _pipelineId,
                operations = _operations,
                timestamp = DateTime.UtcNow.ToString("o")
            });
            
            for (int i = 0; i < _operations.Length; i++)
            {
                var operation = _operations[i];
                
                Debug.Log($"[APC] Pipeline step {i + 1}/{_operations.Length}: {operation}");
                
                // Notify daemon of step start
                ApcUnityBridge.Instance?.SendEvent(UnityEvents.PipelineProgress, new
                {
                    pipelineId = _pipelineId,
                    step = i + 1,
                    totalSteps = _operations.Length,
                    operation,
                    status = "started"
                });
                
                var result = await ExecuteStepAsync(operation);
                stepResults.Add(result);
                
                // Notify daemon of step complete
                ApcUnityBridge.Instance?.SendEvent(UnityEvents.PipelineProgress, new
                {
                    pipelineId = _pipelineId,
                    step = i + 1,
                    totalSteps = _operations.Length,
                    operation,
                    status = result.Success ? "completed" : "failed",
                    logPath = result.LogPath,
                    errorCount = result.ErrorCount
                });
                
                // Fail early
                if (!result.Success)
                {
                    failedAtStep = operation;
                    success = false;
                    Debug.LogWarning($"[APC] Pipeline failed at step: {operation}");
                    break;
                }
            }
            
            var pipelineResult = new PipelineResult
            {
                Success = success,
                FailedAtStep = failedAtStep,
                LogFolder = _logFolder,
                StepResults = stepResults.ToArray()
            };
            
            // Notify daemon of pipeline complete
            ApcUnityBridge.Instance?.SendEvent(UnityEvents.PipelineCompleted, new
            {
                pipelineId = _pipelineId,
                success,
                failedAtStep,
                logFolder = _logFolder,
                stepCount = stepResults.Count
            });
            
            Debug.Log($"[APC] Pipeline {_pipelineId} {(success ? "completed" : "failed")}");
            
            return pipelineResult;
        }
        
        private async Task<StepResult> ExecuteStepAsync(string operation)
        {
            var captureMode = GetCaptureMode(operation);
            _currentSession = new CaptureSession(_pipelineId, operation, captureMode, _projectPath);
            
            try
            {
                _currentSession.Start();
                
                bool stepSuccess;
                string error = null;
                
                switch (operation.ToLower())
                {
                    case "prep":
                        stepSuccess = await ExecutePrepAsync();
                        break;
                        
                    case "test_editmode":
                        stepSuccess = await ExecuteTestEditModeAsync();
                        break;
                        
                    case "test_playmode":
                        stepSuccess = await ExecuteTestPlayModeAsync();
                        break;
                        
                    case "test_player":
                        stepSuccess = await ExecuteTestPlayerAsync();
                        break;
                        
                    default:
                        stepSuccess = false;
                        error = $"Unknown operation: {operation}";
                        break;
                }
                
                var logPath = _currentSession.Stop();
                
                return new StepResult
                {
                    Operation = operation,
                    Success = stepSuccess && _currentSession.ErrorCount == 0,
                    LogPath = logPath,
                    ErrorCount = _currentSession.ErrorCount,
                    WarningCount = _currentSession.WarningCount,
                    Error = error
                };
            }
            catch (Exception ex)
            {
                var logPath = _currentSession?.Stop();
                
                return new StepResult
                {
                    Operation = operation,
                    Success = false,
                    LogPath = logPath,
                    ErrorCount = _currentSession?.ErrorCount ?? 0,
                    WarningCount = _currentSession?.WarningCount ?? 0,
                    Error = ex.Message
                };
            }
            finally
            {
                _currentSession?.Dispose();
                _currentSession = null;
            }
        }
        
        private CaptureMode GetCaptureMode(string operation)
        {
            switch (operation.ToLower())
            {
                case "prep":
                    return CaptureMode.LogAtEnd;
                case "test_editmode":
                    return CaptureMode.LogContinuous;
                case "test_playmode":
                case "test_player":
                    return CaptureMode.LogAndScreenshot;
                default:
                    return CaptureMode.LogContinuous;
            }
        }
        
        #region Step Implementations
        
        private async Task<bool> ExecutePrepAsync()
        {
            // Load temp scene if exists, otherwise current scene is fine
            var tempScenePath = "Assets/Scenes/_TempCompileCheck.unity";
            if (File.Exists(Path.Combine(_projectPath, tempScenePath)))
            {
                await EditorController.LoadSceneAsync(tempScenePath);
            }
            
            // Trigger compile
            var compileResult = await EditorController.TriggerCompileAsync();
            if (!compileResult.success)
            {
                return false;
            }
            
            // Wait for compilation if needed
            var isCompiling = compileResult.data != null && 
                              compileResult.data.GetType().GetProperty("compiling")?.GetValue(compileResult.data) is bool c && c;
            
            if (isCompiling)
            {
                await WaitForCompilationAsync(120);
            }
            
            return true;
        }
        
        private async Task<bool> ExecuteTestEditModeAsync()
        {
            var result = await TestController.RunTestsAsync("EditMode", null);
            return result.success;
        }
        
        private async Task<bool> ExecuteTestPlayModeAsync()
        {
            // Start frame capture for screenshots
            StartFrameCapture();
            
            try
            {
                var result = await TestController.RunTestsAsync("PlayMode", null);
                return result.success;
            }
            finally
            {
                StopFrameCapture();
            }
        }
        
        private async Task<bool> ExecuteTestPlayerAsync()
        {
            // Load test scene
            await EditorController.LoadSceneAsync(_testScene);
            
            // Show player test popup in Unity
            var action = await UI.PlayerTestPopup.ShowAndWaitAsync(_pipelineId, _testScene);
            
            if (action == "cancel")
            {
                return false;
            }
            
            // Enter play mode
            await EditorController.EnterPlayModeAsync();
            
            // Start frame capture
            StartFrameCapture();
            
            try
            {
                // Transition popup to playing state
                UI.PlayerTestPopup.TransitionToPlaying();
                
                // Wait for user to finish
                var finishAction = await UI.PlayerTestPopup.ShowAndWaitAsync(_pipelineId, _testScene);
                
                return finishAction == "finish";
            }
            finally
            {
                StopFrameCapture();
                
                // Exit play mode
                if (EditorApplication.isPlaying)
                {
                    await EditorController.ExitPlayModeAsync();
                }
            }
        }
        
        #endregion
        
        #region Helpers
        
        private async Task WaitForCompilationAsync(int timeoutSeconds)
        {
            var startTime = DateTime.Now;
            
            while (EditorApplication.isCompiling)
            {
                if ((DateTime.Now - startTime).TotalSeconds > timeoutSeconds)
                {
                    Debug.LogWarning("[APC] Compilation timeout");
                    break;
                }
                await Task.Delay(100);
            }
        }
        
        private void StartFrameCapture()
        {
            _lastCaptureTime = Time.realtimeSinceStartup;
            EditorApplication.update += OnEditorUpdate;
        }
        
        private void StopFrameCapture()
        {
            EditorApplication.update -= OnEditorUpdate;
        }
        
        private void OnEditorUpdate()
        {
            if (_currentSession == null) return;
            
            var now = Time.realtimeSinceStartup;
            if (now - _lastCaptureTime >= CAPTURE_INTERVAL)
            {
                _lastCaptureTime = now;
                _currentSession.CaptureFrame();
            }
        }
        
        #endregion
    }
}

