using System;
using UnityEditor;
using UnityEngine;

namespace ApcBridge.UI
{
    /// <summary>
    /// Settings window for APC Unity Bridge.
    /// Shows connection status, current operation, and configuration options.
    /// </summary>
    public class ApcSettingsWindow : EditorWindow
    {
        #region Window Management
        
        [MenuItem("Window/APC Unity Bridge")]
        public static void ShowWindow()
        {
            var window = GetWindow<ApcSettingsWindow>("APC Bridge");
            window.minSize = new Vector2(300, 400);
            window.Show();
        }
        
        #endregion
        
        #region Styles
        
        private GUIStyle _headerStyle;
        private GUIStyle _statusStyle;
        private GUIStyle _sectionStyle;
        private bool _stylesInitialized = false;
        
        private void InitStyles()
        {
            if (_stylesInitialized) return;
            
            _headerStyle = new GUIStyle(EditorStyles.boldLabel)
            {
                fontSize = 14,
                margin = new RectOffset(0, 0, 10, 10)
            };
            
            _statusStyle = new GUIStyle(EditorStyles.label)
            {
                fontSize = 12,
                richText = true
            };
            
            _sectionStyle = new GUIStyle(EditorStyles.helpBox)
            {
                padding = new RectOffset(10, 10, 10, 10),
                margin = new RectOffset(0, 0, 5, 5)
            };
            
            _stylesInitialized = true;
        }
        
        #endregion
        
        #region GUI
        
        private Vector2 _scrollPosition;
        private int _port;
        
        private void OnEnable()
        {
            _port = ApcSettings.Port;
            
            // Subscribe to state changes for auto-refresh
            StateManager.Instance.OnStateChanged += Repaint;
        }
        
        private void OnDisable()
        {
            StateManager.Instance.OnStateChanged -= Repaint;
        }
        
        private void OnGUI()
        {
            InitStyles();
            
            _scrollPosition = EditorGUILayout.BeginScrollView(_scrollPosition);
            
            DrawHeader();
            DrawConnectionStatus();
            DrawCurrentOperation();
            DrawSettings();
            DrawActions();
            DrawRecentOperations();
            
            EditorGUILayout.EndScrollView();
        }
        
        private void DrawHeader()
        {
            EditorGUILayout.LabelField("APC Unity Bridge", _headerStyle);
            EditorGUILayout.Space(5);
        }
        
        private void DrawConnectionStatus()
        {
            EditorGUILayout.BeginVertical(_sectionStyle);
            
            EditorGUILayout.LabelField("Connection", EditorStyles.boldLabel);
            
            var bridge = ApcUnityBridge.Instance;
            var status = bridge?.ConnectionStatus ?? ConnectionStatus.Disconnected;
            
            // Status with color
            string statusText;
            Color statusColor;
            
            switch (status)
            {
                case ConnectionStatus.Connected:
                    statusText = "● Connected";
                    statusColor = new Color(0.2f, 0.8f, 0.2f);
                    break;
                case ConnectionStatus.Connecting:
                    statusText = "● Connecting...";
                    statusColor = new Color(0.9f, 0.7f, 0.1f);
                    break;
                case ConnectionStatus.Busy:
                    statusText = "● Busy";
                    statusColor = new Color(0.9f, 0.7f, 0.1f);
                    break;
                case ConnectionStatus.Error:
                    statusText = "● Error";
                    statusColor = new Color(0.8f, 0.2f, 0.2f);
                    break;
                default:
                    statusText = "● Disconnected";
                    statusColor = new Color(0.5f, 0.5f, 0.5f);
                    break;
            }
            
            var prevColor = GUI.color;
            GUI.color = statusColor;
            EditorGUILayout.LabelField("Status:", statusText, _statusStyle);
            GUI.color = prevColor;
            
            if (status == ConnectionStatus.Connected)
            {
                EditorGUILayout.LabelField("Daemon:", $"ws://127.0.0.1:{ApcSettings.Port}");
                EditorGUILayout.LabelField("Registered:", bridge?.IsRegistered == true ? "Yes" : "No");
            }
            
            string projectPath = System.IO.Path.GetDirectoryName(Application.dataPath);
            EditorGUILayout.LabelField("Project:", projectPath);
            
            EditorGUILayout.EndVertical();
        }
        
        private void DrawCurrentOperation()
        {
            EditorGUILayout.BeginVertical(_sectionStyle);
            
            EditorGUILayout.LabelField("Current State", EditorStyles.boldLabel);
            
            var state = StateManager.Instance;
            
            EditorGUILayout.LabelField("Compiling:", state.IsCompiling ? "Yes" : "No");
            EditorGUILayout.LabelField("Playing:", state.IsPlaying ? "Yes" : "No");
            EditorGUILayout.LabelField("Paused:", state.IsPaused ? "Yes" : "No");
            EditorGUILayout.LabelField("Busy:", state.IsBusy ? "Yes" : "No");
            
            if (state.IsBusy)
            {
                EditorGUILayout.LabelField("Operation:", state.CurrentOperation);
                EditorGUILayout.LabelField("Duration:", $"{state.OperationDurationMs:F0} ms");
                
                // Cancel button
                EditorGUILayout.Space(5);
                if (GUILayout.Button("Cancel Operation"))
                {
                    state.CancelOperation();
                }
            }
            
            EditorGUILayout.EndVertical();
        }
        
        private void DrawSettings()
        {
            EditorGUILayout.BeginVertical(_sectionStyle);
            
            EditorGUILayout.LabelField("Settings", EditorStyles.boldLabel);
            
            // Auto-connect
            bool autoConnect = EditorGUILayout.Toggle("Auto-connect on Start", ApcSettings.AutoConnect);
            if (autoConnect != ApcSettings.AutoConnect)
            {
                ApcSettings.AutoConnect = autoConnect;
            }
            
            // Show notifications
            bool showNotifications = EditorGUILayout.Toggle("Show Notifications", ApcSettings.ShowNotifications);
            if (showNotifications != ApcSettings.ShowNotifications)
            {
                ApcSettings.ShowNotifications = showNotifications;
            }
            
            // Port
            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Port:", GUILayout.Width(80));
            _port = EditorGUILayout.IntField(_port, GUILayout.Width(80));
            
            if (_port != ApcSettings.Port)
            {
                if (GUILayout.Button("Apply", GUILayout.Width(60)))
                {
                    ApcSettings.Port = _port;
                }
            }
            EditorGUILayout.EndHorizontal();
            
            EditorGUILayout.EndVertical();
        }
        
        private void DrawActions()
        {
            EditorGUILayout.BeginVertical(_sectionStyle);
            
            EditorGUILayout.LabelField("Actions", EditorStyles.boldLabel);
            
            EditorGUILayout.BeginHorizontal();
            
            var bridge = ApcUnityBridge.Instance;
            var isConnected = bridge?.IsConnected ?? false;
            
            GUI.enabled = !isConnected;
            if (GUILayout.Button("Connect"))
            {
                _ = bridge?.ConnectAsync();
            }
            
            GUI.enabled = isConnected;
            if (GUILayout.Button("Disconnect"))
            {
                _ = bridge?.DisconnectAsync();
            }
            
            GUI.enabled = true;
            
            EditorGUILayout.EndHorizontal();
            
            EditorGUILayout.Space(5);
            
            if (GUILayout.Button("Refresh State"))
            {
                if (isConnected)
                {
                    bridge?.SendEvent(UnityEvents.StateChanged, StateManager.Instance.GetStateResponse());
                }
                Repaint();
            }
            
            EditorGUILayout.EndVertical();
        }
        
        private void DrawRecentOperations()
        {
            EditorGUILayout.BeginVertical(_sectionStyle);
            
            EditorGUILayout.LabelField("Recent Operations", EditorStyles.boldLabel);
            
            var recentOps = StateManager.Instance.GetRecentOperations();
            
            if (recentOps.Length == 0)
            {
                EditorGUILayout.LabelField("No recent operations", EditorStyles.miniLabel);
            }
            else
            {
                foreach (var op in recentOps)
                {
                    EditorGUILayout.LabelField(op, EditorStyles.miniLabel);
                }
            }
            
            EditorGUILayout.EndVertical();
        }
        
        #endregion
        
        #region Update
        
        private void Update()
        {
            // Auto-repaint while connected or busy
            if (ApcUnityBridge.Instance?.IsConnected == true || StateManager.Instance?.IsBusy == true)
            {
                Repaint();
            }
        }
        
        #endregion
    }
}

