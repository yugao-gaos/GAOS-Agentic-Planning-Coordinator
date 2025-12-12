using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace ApcBridge.UI
{
    /// <summary>
    /// Adds APC status icon to Unity's main toolbar.
    /// Uses UIToolkit injection for Unity 6+ and reflection fallback for older versions.
    /// </summary>
    [InitializeOnLoad]
    public static class ToolbarExtension
    {
        #region Icons
        
        private static Texture2D _iconConnected;
        private static Texture2D _iconBusy;
        private static Texture2D _iconDisconnected;
        private static Texture2D _iconError;
        
        #endregion
        
        #region UIToolkit Elements
        
        private static VisualElement _toolbarButton;
        private static Image _statusIcon;
        private static bool _isInjected = false;
        
        #endregion
        
        static ToolbarExtension()
        {
            EditorApplication.delayCall += Initialize;
            
            // Handle domain reload - re-inject on assembly reload
            AssemblyReloadEvents.afterAssemblyReload += OnAfterAssemblyReload;
        }
        
        private static void OnAfterAssemblyReload()
        {
            // Reset injection state after domain reload
            _isInjected = false;
            _toolbarButton = null;
            _statusIcon = null;
            
            // Re-initialize
            EditorApplication.delayCall += Initialize;
        }
        
        private static void Initialize()
        {
            LoadIcons();
            
            // Try to inject into toolbar on update until successful
            EditorApplication.update += TryInjectToolbarElement;
            
            // Subscribe to connection status changes for icon updates
            if (StateManager.Instance != null)
            {
                StateManager.Instance.OnStateChanged += OnStateChanged;
            }
        }
        
        private static void OnStateChanged()
        {
            UpdateStatusIcon();
        }
        
        #region Icon Loading
        
        private static void LoadIcons()
        {
            // Create simple colored circle textures for status indicators
            _iconConnected = CreateCircleIcon(new Color(0.2f, 0.8f, 0.2f)); // Green
            _iconBusy = CreateCircleIcon(new Color(0.9f, 0.7f, 0.1f));      // Yellow
            _iconDisconnected = CreateCircleIcon(new Color(0.8f, 0.2f, 0.2f)); // Red
            _iconError = CreateCircleIcon(new Color(0.5f, 0.5f, 0.5f));     // Gray
        }
        
        private static Texture2D CreateCircleIcon(Color color)
        {
            int size = 16;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false);
            texture.filterMode = FilterMode.Bilinear;
            
            Color transparent = new Color(0, 0, 0, 0);
            float center = size / 2f;
            float radius = size / 2f - 1;
            
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float dist = Mathf.Sqrt((x - center) * (x - center) + (y - center) * (y - center));
                    
                    if (dist < radius - 0.5f)
                    {
                        // Inner circle with slight gradient for 3D effect
                        float t = dist / radius;
                        Color c = Color.Lerp(color * 1.2f, color * 0.8f, t);
                        c.a = 1;
                        texture.SetPixel(x, y, c);
                    }
                    else if (dist < radius + 0.5f)
                    {
                        // Anti-aliased edge
                        float alpha = 1 - (dist - (radius - 0.5f));
                        Color c = color;
                        c.a = alpha;
                        texture.SetPixel(x, y, c);
                    }
                    else
                    {
                        texture.SetPixel(x, y, transparent);
                    }
                }
            }
            
            texture.Apply();
            return texture;
        }
        
        #endregion
        
        #region Toolbar Injection
        
        private static void TryInjectToolbarElement()
        {
            if (_isInjected) return;
            
            try
            {
                // Find the toolbar
                var toolbarType = typeof(Editor).Assembly.GetType("UnityEditor.Toolbar");
                if (toolbarType == null) return;
                
                var toolbars = Resources.FindObjectsOfTypeAll(toolbarType);
                if (toolbars.Length == 0) return;
                
                var toolbar = toolbars[0];
                
                // Get the root VisualElement (Unity 6+ uses UIToolkit)
                var rootField = toolbarType.GetField("m_Root", BindingFlags.NonPublic | BindingFlags.Instance);
                if (rootField == null) return;
                
                var root = rootField.GetValue(toolbar) as VisualElement;
                if (root == null) return;
                
                // Find the right side of the toolbar (after play buttons)
                // In Unity 6, we look for the ToolbarZoneRightAlign container
                var rightZone = root.Q("ToolbarZoneRightAlign");
                if (rightZone == null)
                {
                    // Try alternative names
                    rightZone = root.Q(className: "unity-toolbar-zone-right-align");
                }
                
                if (rightZone == null)
                {
                    // Fallback: Try to find any suitable container on the right
                    rightZone = FindRightContainer(root);
                }
                
                if (rightZone != null)
                {
                    CreateAndInjectButton(rightZone);
                    _isInjected = true;
                    EditorApplication.update -= TryInjectToolbarElement;
                    Debug.Log("[APC] Toolbar status icon injected successfully");
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[APC] Failed to inject toolbar element: {ex.Message}");
            }
        }
        
        private static VisualElement FindRightContainer(VisualElement root)
        {
            // Try various known container names in Unity's toolbar hierarchy
            string[] possibleNames = { 
                "ToolbarZoneRightAlign", 
                "RightContainer", 
                "unity-editor-toolbar-container"
            };
            
            foreach (var name in possibleNames)
            {
                var element = root.Q(name);
                if (element != null) return element;
            }
            
            // Try to find by class
            var byClass = root.Q(className: "unity-toolbar__zone-right-align");
            if (byClass != null) return byClass;
            
            // Last resort: find container that has children and is positioned right
            return null;
        }
        
        private static void CreateAndInjectButton(VisualElement parent)
        {
            // Create the button container
            _toolbarButton = new VisualElement();
            _toolbarButton.name = "ApcStatusButton";
            _toolbarButton.style.flexDirection = FlexDirection.Row;
            _toolbarButton.style.alignItems = Align.Center;
            _toolbarButton.style.justifyContent = Justify.Center;
            _toolbarButton.style.minWidth = 48;
            _toolbarButton.style.height = 22;
            _toolbarButton.style.marginLeft = 6;
            _toolbarButton.style.marginRight = 2;
            _toolbarButton.style.paddingLeft = 6;
            _toolbarButton.style.paddingRight = 6;
            _toolbarButton.style.borderTopLeftRadius = 3;
            _toolbarButton.style.borderTopRightRadius = 3;
            _toolbarButton.style.borderBottomLeftRadius = 3;
            _toolbarButton.style.borderBottomRightRadius = 3;
            
            // Add hover effect
            _toolbarButton.RegisterCallback<MouseEnterEvent>(evt => 
            {
                _toolbarButton.style.backgroundColor = new Color(0.4f, 0.4f, 0.4f, 0.3f);
            });
            _toolbarButton.RegisterCallback<MouseLeaveEvent>(evt => 
            {
                _toolbarButton.style.backgroundColor = StyleKeyword.Null;
            });
            
            // Create the status icon
            _statusIcon = new Image();
            _statusIcon.style.width = 14;
            _statusIcon.style.height = 14;
            _statusIcon.scaleMode = ScaleMode.ScaleToFit;
            UpdateStatusIcon();
            
            _toolbarButton.Add(_statusIcon);
            
            // Add label
            var label = new Label("APC");
            label.style.fontSize = 10;
            label.style.marginLeft = 2;
            label.style.unityFontStyleAndWeight = FontStyle.Bold;
            label.style.color = new Color(0.8f, 0.8f, 0.8f);
            _toolbarButton.Add(label);
            
            // Add click handler
            _toolbarButton.RegisterCallback<ClickEvent>(evt => 
            {
                ApcSettingsWindow.ShowWindow();
            });
            
            // Update tooltip
            UpdateTooltip();
            
            // Insert at the beginning of the right zone
            parent.Insert(0, _toolbarButton);
        }
        
        private static void UpdateStatusIcon()
        {
            if (_statusIcon == null) return;
            
            var status = ApcUnityBridge.Instance?.ConnectionStatus ?? ConnectionStatus.Disconnected;
            _statusIcon.image = GetStatusIcon(status);
            UpdateTooltip();
        }
        
        private static void UpdateTooltip()
        {
            if (_toolbarButton == null) return;
            
            var status = ApcUnityBridge.Instance?.ConnectionStatus ?? ConnectionStatus.Disconnected;
            _toolbarButton.tooltip = GetStatusTooltip(status);
        }
        
        private static Texture2D GetStatusIcon(ConnectionStatus status)
        {
            switch (status)
            {
                case ConnectionStatus.Connected:
                    return StateManager.Instance?.IsBusy == true ? _iconBusy : _iconConnected;
                case ConnectionStatus.Connecting:
                    return _iconBusy;
                case ConnectionStatus.Busy:
                    return _iconBusy;
                case ConnectionStatus.Error:
                    return _iconError;
                case ConnectionStatus.Disconnected:
                default:
                    return _iconDisconnected;
            }
        }
        
        private static string GetStatusTooltip(ConnectionStatus status)
        {
            switch (status)
            {
                case ConnectionStatus.Connected:
                    if (StateManager.Instance?.IsBusy == true)
                    {
                        return $"APC: Busy ({StateManager.Instance.CurrentOperation})";
                    }
                    return "APC: Connected - Click to open settings";
                case ConnectionStatus.Connecting:
                    return "APC: Connecting...";
                case ConnectionStatus.Busy:
                    return $"APC: Busy ({StateManager.Instance?.CurrentOperation})";
                case ConnectionStatus.Error:
                    return "APC: Connection Error - Click to reconnect";
                case ConnectionStatus.Disconnected:
                default:
                    return "APC: Disconnected - Click to connect";
            }
        }
        
        #endregion
    }
}

