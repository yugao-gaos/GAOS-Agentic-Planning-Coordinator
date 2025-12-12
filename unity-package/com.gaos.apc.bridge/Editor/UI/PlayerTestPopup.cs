using System;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace ApcBridge.UI
{
    /// <summary>
    /// Popup window for player testing flow.
    /// Shown in Unity Editor to start/finish manual play testing.
    /// </summary>
    public class PlayerTestPopup : EditorWindow
    {
        private static PlayerTestPopup _instance;
        private static TaskCompletionSource<string> _actionTcs;
        
        private string _pipelineId;
        private string _sceneName;
        private PlayerTestPhase _phase = PlayerTestPhase.WaitingToStart;
        private DateTime _startTime;
        private bool _isPlaying;
        
        private enum PlayerTestPhase
        {
            WaitingToStart,
            Playing,
            Finished
        }
        
        /// <summary>
        /// Show the player test popup and wait for user action.
        /// Returns "start", "finish", or "cancel".
        /// </summary>
        public static async Task<string> ShowAndWaitAsync(string pipelineId, string sceneName)
        {
            // Close existing instance
            if (_instance != null)
            {
                _instance.Close();
                _instance = null;
            }
            
            _actionTcs = new TaskCompletionSource<string>();
            
            // Create and show window
            _instance = GetWindow<PlayerTestPopup>(true, "Player Test", true);
            _instance._pipelineId = pipelineId;
            _instance._sceneName = sceneName;
            _instance._phase = PlayerTestPhase.WaitingToStart;
            _instance.minSize = new Vector2(350, 200);
            _instance.maxSize = new Vector2(350, 200);
            _instance.ShowUtility();
            _instance.CenterOnScreen();
            
            try
            {
                return await _actionTcs.Task;
            }
            finally
            {
                if (_instance != null)
                {
                    _instance.Close();
                    _instance = null;
                }
            }
        }
        
        /// <summary>
        /// Transition to playing phase (called after entering play mode)
        /// </summary>
        public static void TransitionToPlaying()
        {
            if (_instance != null)
            {
                _instance._phase = PlayerTestPhase.Playing;
                _instance._startTime = DateTime.Now;
                _instance._isPlaying = true;
                _instance.Repaint();
            }
        }
        
        private void CenterOnScreen()
        {
            var mainWindow = EditorGUIUtility.GetMainWindowPosition();
            var pos = position;
            pos.x = mainWindow.x + (mainWindow.width - pos.width) / 2;
            pos.y = mainWindow.y + (mainWindow.height - pos.height) / 2;
            position = pos;
        }
        
        private void OnGUI()
        {
            EditorGUILayout.Space(10);
            
            switch (_phase)
            {
                case PlayerTestPhase.WaitingToStart:
                    DrawWaitingToStart();
                    break;
                case PlayerTestPhase.Playing:
                    DrawPlaying();
                    break;
            }
        }
        
        private void DrawWaitingToStart()
        {
            // Header
            var headerStyle = new GUIStyle(EditorStyles.boldLabel)
            {
                fontSize = 16,
                alignment = TextAnchor.MiddleCenter
            };
            GUILayout.Label("🎮 Player Test", headerStyle);
            
            EditorGUILayout.Space(10);
            
            // Info
            EditorGUILayout.LabelField("Scene:", _sceneName ?? "Default Scene");
            EditorGUILayout.LabelField("Pipeline:", _pipelineId ?? "Unknown");
            
            EditorGUILayout.Space(20);
            
            // Instructions
            EditorGUILayout.HelpBox(
                "Click 'Start Testing' to enter Play Mode and begin manual testing.\n\n" +
                "When finished, click 'Finish Testing' to continue the pipeline.",
                MessageType.Info);
            
            EditorGUILayout.Space(10);
            
            // Buttons
            EditorGUILayout.BeginHorizontal();
            GUILayout.FlexibleSpace();
            
            if (GUILayout.Button("Cancel", GUILayout.Width(100), GUILayout.Height(30)))
            {
                _actionTcs?.TrySetResult("cancel");
            }
            
            GUILayout.Space(10);
            
            GUI.backgroundColor = new Color(0.3f, 0.8f, 0.3f);
            if (GUILayout.Button("Start Testing", GUILayout.Width(120), GUILayout.Height(30)))
            {
                _actionTcs?.TrySetResult("start");
            }
            GUI.backgroundColor = Color.white;
            
            GUILayout.FlexibleSpace();
            EditorGUILayout.EndHorizontal();
        }
        
        private void DrawPlaying()
        {
            // Header
            var headerStyle = new GUIStyle(EditorStyles.boldLabel)
            {
                fontSize = 16,
                alignment = TextAnchor.MiddleCenter
            };
            GUILayout.Label("🎮 Testing in Progress", headerStyle);
            
            EditorGUILayout.Space(10);
            
            // Timer
            var elapsed = DateTime.Now - _startTime;
            EditorGUILayout.LabelField("Duration:", $"{elapsed:mm\\:ss}");
            EditorGUILayout.LabelField("Scene:", _sceneName ?? "Default Scene");
            
            EditorGUILayout.Space(15);
            
            // Instructions
            EditorGUILayout.HelpBox(
                "Play and test your game.\n\n" +
                "When finished, click 'Finish Testing' to exit Play Mode and continue.",
                MessageType.Info);
            
            EditorGUILayout.Space(10);
            
            // Buttons
            EditorGUILayout.BeginHorizontal();
            GUILayout.FlexibleSpace();
            
            if (GUILayout.Button("Cancel", GUILayout.Width(100), GUILayout.Height(30)))
            {
                _actionTcs?.TrySetResult("cancel");
            }
            
            GUILayout.Space(10);
            
            GUI.backgroundColor = new Color(0.3f, 0.6f, 1f);
            if (GUILayout.Button("Finish Testing", GUILayout.Width(120), GUILayout.Height(30)))
            {
                _actionTcs?.TrySetResult("finish");
            }
            GUI.backgroundColor = Color.white;
            
            GUILayout.FlexibleSpace();
            EditorGUILayout.EndHorizontal();
            
            // Auto-repaint for timer
            Repaint();
        }
        
        private void Update()
        {
            // Check if play mode was exited externally
            if (_phase == PlayerTestPhase.Playing && !EditorApplication.isPlaying)
            {
                _actionTcs?.TrySetResult("finish");
            }
        }
        
        private void OnDestroy()
        {
            // Handle window being closed
            _actionTcs?.TrySetResult("cancel");
            _instance = null;
        }
    }
}

