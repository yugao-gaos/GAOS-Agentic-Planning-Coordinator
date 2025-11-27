# Unity Development Best Practices

This document is referenced during task planning. Relevant tips are included in task specifications.

---

## 1. MonoBehaviour vs Pure C# Scripts

**IMPORTANT**: Be mindful of what scripts need to be attached to GameObjects.
- Scripts that need Unity lifecycle (Start, Update, OnDestroy) → **MonoBehaviour**
- Scripts that need Inspector serialization → **MonoBehaviour** or **ScriptableObject**
- Pure logic with no Unity dependencies → **Plain C# class**

Example:
```csharp
// ✓ Needs to be attached to GameObject
public class PlayerController : MonoBehaviour { }

// ✓ Pure logic, no Unity dependencies
public class ScoreCalculator { }
```

---

## 2. Unity Asset Management

**NEVER create .meta files manually** - Let Unity handle it.

After making changes to Unity assets:
1. Use `check_unity_compilation.sh` to focus Unity and trigger reimport
2. Wait and monitor Unity status using Unity MCP
3. Loop until reimport finishes
4. Check console for any errors

```bash
# Correct workflow after file changes
./check_unity_compilation.sh
# Then via MCP: mcp_unityMCP_manage_editor({ action: 'get_state' })
# Wait for compilation to complete
# Then: mcp_unityMCP_read_console({ types: ['error'] })
```

---

## 3. Scene and UI Building

### Canvas and Prefabs
- UI Canvas should be built **separately in prefabs**
- Identify **reusable widgets** and build them as prefabs first
- Compose scenes from prefabs, not raw GameObjects

### AI Agent Guidelines
**DO NOT generate scenes/UI elements directly with AI agents.**

Instead:
1. Ask for **mockups** first
2. Ask about **sizing and layout** of elements
3. Write **Editor ScriptableObject code** that creates structures
4. Build with **responsiveness** in mind

This approach:
- Produces better results
- Allows users to modify settings and rebuild
- Separates data from generation logic

---

## 4. Data Objects and ScriptableObjects

### Best Practice
Build data objects as **ScriptableObjects** that can serialize to/from JSON:

```csharp
[CreateAssetMenu(fileName = "NewLevelData", menuName = "Game/Level Data")]
public class LevelData : ScriptableObject
{
    public int width;
    public int height;
    public List<CellConfig> cells;
    
    // Serialize to JSON
    public string ToJson() => JsonUtility.ToJson(this);
    
    // Load from JSON
    public void FromJson(string json) => JsonUtility.FromJsonOverwrite(json, this);
}
```

### Editor Panels
Build custom editor panels for ScriptableObjects to improve designer workflow:

```csharp
[CustomEditor(typeof(LevelData))]
public class LevelDataEditor : Editor
{
    public override void OnInspectorGUI()
    {
        // Custom UI for level editing
    }
}
```

---

## 5. Scene/UI Generation Pattern

### The ScriptableObject Builder Pattern

Instead of directly generating scene content, create a **ScriptableObject with builder logic**:

```csharp
[CreateAssetMenu(menuName = "Builders/UI Layout Builder")]
public class UILayoutBuilder : ScriptableObject
{
    [Header("Resources")]
    public Sprite backgroundSprite;
    public Font titleFont;
    public Material buttonMaterial;
    
    [Header("Layout Settings")]
    public Color primaryColor = Color.blue;
    public float buttonHeight = 60f;
    public float padding = 20f;
    
    [Header("Output")]
    public GameObject targetParent;
    
    /// <summary>
    /// Build UI based on configuration. Call from Editor or runtime.
    /// </summary>
    public GameObject Build()
    {
        // Generate UI based on settings
        // References sprites, colors, materials from this SO
        // User can modify settings in Inspector and rebuild
        return GenerateLayout();
    }
    
    private GameObject GenerateLayout()
    {
        // Implementation here
        return null;
    }
}
```

**Key Benefits:**
- Single SO contains both config AND builder logic
- User modifies settings in Inspector, clicks Build
- References resources from context (sprites, models, colors, materials, animations)
- Can rebuild anytime without code changes
- Swap resources by dragging new assets into Inspector

---

## 6. Testing with Unity Test Framework

### Test Types

**EditMode Tests** - Run without Play mode, fast, for pure logic:
```csharp
[TestFixture]
public class ClusterDetectorTests
{
    [Test]
    public void DetectsHorizontalMatch()
    {
        var detector = new ClusterDetector();
        var board = CreateTestBoard();
        var matches = detector.FindMatches(board);
        Assert.AreEqual(1, matches.Count);
    }
}
```

**PlayMode Tests** - Run in Play mode, for MonoBehaviour/Scene tests:
```csharp
[UnityTest]
public IEnumerator GameLoop_WinCondition_TriggersEvent()
{
    yield return LoadTestScene();
    var gameManager = Object.FindObjectOfType<GameStateManager>();
    // ... test gameplay loop
    yield return new WaitForSeconds(1f);
    Assert.IsTrue(gameWon);
}
```

### Running Tests via Unity MCP

**IMPORTANT**: Always run tests using Unity MCP to verify code works:

```bash
# Run EditMode tests (fast, no Play mode)
mcp_unityMCP_run_tests({ mode: "EditMode" })

# Run PlayMode tests (requires Play mode)
mcp_unityMCP_run_tests({ mode: "PlayMode", timeout_seconds: 60 })
```

### Per-Task Test Requirements

Every task should include:
1. **Unit tests** for pure logic (EditMode)
2. **Integration tests** if task involves scene/components (PlayMode)
3. **Test naming convention**: `[Method]_[Scenario]_[ExpectedResult]`

Example test list per task:
```
Task: Cluster Detection
├── ClusterDetectorTests.cs (EditMode)
│   ├── FindMatches_HorizontalThree_ReturnsMatch
│   ├── FindMatches_VerticalThree_ReturnsMatch
│   ├── FindMatches_LShape_ReturnsTwoMatches
│   ├── FindMatches_NoMatch_ReturnsEmpty
│   └── FindMatches_LargeBoard_CompletesUnder1ms
```

### Assembly Definition Setup

```
Assets/
├── Scripts/
│   └── Assembly-CSharp.asmdef
├── Tests/
│   ├── EditMode/
│   │   └── Tests.EditMode.asmdef  (references: Assembly-CSharp)
│   └── PlayMode/
│       └── Tests.PlayMode.asmdef  (references: Assembly-CSharp)
```

### Mocking with ServiceLocator

Use GAOS-ServiceLocator for test mocking:
```csharp
[SetUp]
public void Setup()
{
    // Register mock instead of real service
    ServiceLocator.Register<IBoardService>(new MockBoardService());
}

[TearDown]
public void TearDown()
{
    ServiceLocator.Clear();
}
```

---

## 7. Prototyping and Placeholder Guidelines

**IMPORTANT**: When building prototypes or placeholders, **don't prematurely optimize for performance**.

### Core Principle
Placeholders must match the **final product's structure and tech stack**. The goal is to enable **asset swapping**, not rebuilding.

### ❌ Wrong Approach
```
Final product: 3D gem with MeshRenderer
Placeholder:   2D sprite (wrong tech stack!)
Result:        Must rebuild when real assets arrive
```

### ✅ Correct Approach
```
Final product: 3D gem with MeshRenderer + custom material
Placeholder:   Unity primitive Sphere + colored material
Result:        Just swap the mesh and material later
```

### Guidelines

1. **Match the rendering pipeline**
   - 3D game → Use 3D primitives (Cube, Sphere, Capsule)
   - 2D game → Use SpriteRenderer with placeholder sprites
   - UI → Use correct UI components (Image, not RawImage for sprites)

2. **Match the component structure**
   - If final needs Rigidbody → Add Rigidbody to placeholder
   - If final needs Animator → Add Animator with empty controller
   - If final needs AudioSource → Add AudioSource (can be silent)

3. **Use Unity primitives wisely**
   ```csharp
   // Good: Structurally correct 3D placeholder
   var gem = GameObject.CreatePrimitive(PrimitiveType.Sphere);
   gem.GetComponent<MeshRenderer>().material = gemMaterial;
   
   // Bad: Wrong tech stack
   var gem = new GameObject();
   gem.AddComponent<SpriteRenderer>().sprite = gemSprite;  // 2D for 3D game!
   ```

4. **Placeholder materials over placeholder meshes**
   - Easier to swap materials than rebuild entire prefab hierarchy
   - Use distinct colors per type for debugging

5. **Document what needs swapping**
   ```csharp
   // TODO: Replace with actual gem mesh from artist
   // Current: Unity Sphere primitive
   // Expected: Low-poly gem model with 200-500 tris
   ```

---

## 8. Performance Guidelines

- Use **Object Pooling** for frequently spawned objects
- Avoid allocations in Update loops
- Use **struct** for small, frequently-created data
- Cache component references in Awake/Start
- Use **async/await** instead of coroutines for complex async operations

**Note:** These optimizations apply to **production code**, not prototypes. See Section 7 for prototyping guidelines.

---

*This document is loaded during planning. Configure path in Extension Settings.*

