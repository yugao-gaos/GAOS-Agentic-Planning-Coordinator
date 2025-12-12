using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace ApcBridge
{
    /// <summary>
    /// Tracks Unity Editor state and current operation status.
    /// Provides a single source of truth for whether Unity is busy.
    /// </summary>
    public class StateManager
    {
        #region Singleton
        
        private static StateManager _instance;
        public static StateManager Instance => _instance ??= new StateManager();
        
        #endregion
        
        #region Events
        
        public event Action<bool> OnBusyChanged;
        public event Action<string> OnOperationChanged;
        public event Action OnStateChanged;
        
        #endregion
        
        #region State
        
        private bool _isBusy = false;
        private string _currentOperation = null;
        private string _currentOperationId = null;
        private DateTime _operationStartTime;
        private readonly Queue<string> _recentOperations = new Queue<string>();
        private const int MAX_RECENT_OPERATIONS = 10;
        
        // Cached Unity state
        private bool _lastIsCompiling = false;
        private bool _lastIsPlaying = false;
        private bool _lastIsPaused = false;
        
        #endregion
        
        #region Properties
        
        public bool IsBusy => _isBusy;
        public string CurrentOperation => _currentOperation;
        public string CurrentOperationId => _currentOperationId;
        
        public bool IsCompiling => EditorApplication.isCompiling;
        public bool IsPlaying => EditorApplication.isPlaying;
        public bool IsPaused => EditorApplication.isPaused;
        public bool IsUpdating => EditorApplication.isUpdating;
        
        /// <summary>
        /// Is Unity ready to execute an operation?
        /// </summary>
        public bool IsReady => !_isBusy && !IsCompiling && !IsUpdating;
        
        /// <summary>
        /// Get the current operation duration in milliseconds
        /// </summary>
        public double OperationDurationMs => _isBusy 
            ? (DateTime.Now - _operationStartTime).TotalMilliseconds 
            : 0;
        
        #endregion
        
        #region Constructor
        
        private StateManager()
        {
            // Subscribe to Unity events
            EditorApplication.update += OnEditorUpdate;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            
            // Initial state capture
            _lastIsCompiling = EditorApplication.isCompiling;
            _lastIsPlaying = EditorApplication.isPlaying;
            _lastIsPaused = EditorApplication.isPaused;
        }
        
        #endregion
        
        #region Public Methods
        
        /// <summary>
        /// Start an operation (marks Unity as busy)
        /// </summary>
        /// <param name="operationName">Name of the operation (e.g., "compile", "runTests")</param>
        /// <returns>Operation ID for tracking</returns>
        public string StartOperation(string operationName)
        {
            if (_isBusy)
            {
                Debug.LogWarning($"[APC] Cannot start operation '{operationName}' - already busy with '{_currentOperation}'");
                return null;
            }
            
            _currentOperationId = $"op_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
            _currentOperation = operationName;
            _operationStartTime = DateTime.Now;
            _isBusy = true;
            
            Debug.Log($"[APC] Operation started: {operationName} (ID: {_currentOperationId})");
            
            OnBusyChanged?.Invoke(true);
            OnOperationChanged?.Invoke(operationName);
            OnStateChanged?.Invoke();
            
            return _currentOperationId;
        }
        
        /// <summary>
        /// Complete the current operation
        /// </summary>
        /// <param name="operationId">The operation ID to complete (must match current)</param>
        /// <param name="success">Whether the operation succeeded</param>
        public void CompleteOperation(string operationId, bool success = true)
        {
            if (operationId != _currentOperationId)
            {
                Debug.LogWarning($"[APC] Cannot complete operation '{operationId}' - current is '{_currentOperationId}'");
                return;
            }
            
            var duration = (DateTime.Now - _operationStartTime).TotalMilliseconds;
            var opName = _currentOperation;
            
            // Add to recent operations
            _recentOperations.Enqueue($"{opName} ({duration:F0}ms) - {(success ? "OK" : "FAIL")}");
            while (_recentOperations.Count > MAX_RECENT_OPERATIONS)
            {
                _recentOperations.Dequeue();
            }
            
            Debug.Log($"[APC] Operation completed: {opName} ({duration:F0}ms) - {(success ? "success" : "failed")}");
            
            _currentOperationId = null;
            _currentOperation = null;
            _isBusy = false;
            
            OnBusyChanged?.Invoke(false);
            OnOperationChanged?.Invoke(null);
            OnStateChanged?.Invoke();
        }
        
        /// <summary>
        /// Cancel the current operation
        /// </summary>
        public void CancelOperation()
        {
            if (!_isBusy) return;
            
            Debug.Log($"[APC] Operation cancelled: {_currentOperation}");
            
            _currentOperationId = null;
            _currentOperation = null;
            _isBusy = false;
            
            OnBusyChanged?.Invoke(false);
            OnOperationChanged?.Invoke(null);
            OnStateChanged?.Invoke();
        }
        
        /// <summary>
        /// Get current Unity state as a response object
        /// </summary>
        public UnityStateResponse GetStateResponse()
        {
            return new UnityStateResponse
            {
                isCompiling = IsCompiling,
                isPlaying = IsPlaying,
                isPaused = IsPaused,
                isBusy = IsBusy,
                currentOperation = CurrentOperation,
                editorReady = IsReady,
                projectPath = System.IO.Path.GetDirectoryName(Application.dataPath),
                unityVersion = Application.unityVersion
            };
        }
        
        /// <summary>
        /// Get list of recent operations
        /// </summary>
        public string[] GetRecentOperations()
        {
            return _recentOperations.ToArray();
        }
        
        #endregion
        
        #region Private Methods
        
        private void OnEditorUpdate()
        {
            // Detect state changes
            bool stateChanged = false;
            
            if (_lastIsCompiling != EditorApplication.isCompiling)
            {
                _lastIsCompiling = EditorApplication.isCompiling;
                stateChanged = true;
                
                // Notify daemon about compile state changes
                if (ApcUnityBridge.Instance?.IsConnected == true)
                {
                    if (_lastIsCompiling)
                    {
                        ApcUnityBridge.Instance.SendEvent(UnityEvents.CompileStarted, new { timestamp = DateTime.UtcNow.ToString("o") });
                    }
                    else
                    {
                        ApcUnityBridge.Instance.SendEvent(UnityEvents.CompileComplete, new { timestamp = DateTime.UtcNow.ToString("o") });
                    }
                }
            }
            
            if (_lastIsPlaying != EditorApplication.isPlaying)
            {
                _lastIsPlaying = EditorApplication.isPlaying;
                stateChanged = true;
            }
            
            if (_lastIsPaused != EditorApplication.isPaused)
            {
                _lastIsPaused = EditorApplication.isPaused;
                stateChanged = true;
            }
            
            if (stateChanged)
            {
                OnStateChanged?.Invoke();
                
                // Push state to daemon
                if (ApcUnityBridge.Instance?.IsConnected == true)
                {
                    ApcUnityBridge.Instance.SendEvent(UnityEvents.StateChanged, GetStateResponse());
                }
            }
        }
        
        private void OnPlayModeChanged(PlayModeStateChange state)
        {
            // Notify daemon about play mode changes
            if (ApcUnityBridge.Instance?.IsConnected == true)
            {
                ApcUnityBridge.Instance.SendEvent(UnityEvents.PlayModeChanged, new
                {
                    state = state.ToString(),
                    isPlaying = EditorApplication.isPlaying,
                    isPaused = EditorApplication.isPaused,
                    timestamp = DateTime.UtcNow.ToString("o")
                });
            }
            
            OnStateChanged?.Invoke();
        }
        
        #endregion
        
        #region Cleanup
        
        public void Dispose()
        {
            EditorApplication.update -= OnEditorUpdate;
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
        }
        
        #endregion
    }
}

