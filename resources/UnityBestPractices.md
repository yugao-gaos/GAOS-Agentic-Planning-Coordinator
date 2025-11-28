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

After making changes to Unity assets, **delegate to UnityControlAgent**:
1. Request compilation via `CoordinatorService.requestCompilation()`
2. UnityControlAgent queues the request and manages Unity focus
3. Wait for compilation completion callback
4. Check errors via error registry

**For engineers**: Call the coordinator's compilation request - don't interact with Unity directly.

```typescript
// Engineers request compilation through coordinator
await coordinatorService.requestCompilation(coordinatorId, engineerName);
// UnityControlAgent handles: focus Unity → wait for compile → collect errors
```

**Direct MCP usage** (for debugging only):
```typescript
// Check Unity state
mcp_unityMCP_manage_editor({ action: 'get_state' })
// Check for errors
mcp_unityMCP_read_console({ types: ['error'] })
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

### ⚠️ Important: Don't Over-Test

Unity tests can become a **maintenance burden** in game projects. Be strategic about what you test:

- **Test critical logic**, not every method
- **Focus on bug-prone areas**, not obvious code
- **Keep tests fast** - slow test suites get ignored
- **Delete tests that don't catch bugs** - they're just overhead

### Test Types and When to Use Them

| Test Type | Use For | Skip For |
|-----------|---------|----------|
| **test_framework_editmode** | Pure C# logic, data structures, algorithms, state machines | Simple getters/setters, trivial code |
| **test_framework_playmode** | Scene setup, UI interactions, component lifecycle, animations | Pure logic (use EditMode instead) |
| **test_player_playmode** | Gameplay feel, visual polish, UX flow, "does it feel right?" | Automated verification |

### Per-Task Test Requirements

**NOT every task needs all test types.** Match testing to task type:

| Task Type | EditMode | PlayMode | Player Test |
|-----------|----------|----------|-------------|
| **Data/Logic** (algorithms, state, calculations) | ✅ Required | ❌ Skip | ❌ Skip |
| **Components** (MonoBehaviours, services) | ✅ If has logic | ⚠️ Maybe | ❌ Skip |
| **Scene/UI** (layouts, prefabs, canvas) | ❌ Skip | ✅ Required | ⚠️ Maybe |
| **Gameplay** (mechanics, feel, balance) | ⚠️ Maybe | ✅ Required | ✅ Required |

**Examples:**
```
✅ Cluster Detection (pure logic) → EditMode only
✅ UI Manager (scene/UI) → PlayMode only  
✅ Gem Physics (gameplay) → EditMode + PlayMode + Player test
❌ GemData class (simple data) → No tests needed
```

### EditMode Tests - Fast Logic Tests

Run without Play mode. Use for pure logic that doesn't need Unity lifecycle:

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

### PlayMode Tests - Scene/Component Tests

Run in Play mode. Use for MonoBehaviour, UI, and scene-dependent code:

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

### Player PlayMode Tests - Manual Gameplay Tests

For gameplay tasks, a human needs to play and verify "feel":
- Does the animation feel responsive?
- Is the difficulty right?
- Do the controls feel good?

These can't be automated - use `test_player_playmode` to have the player test.

### Running Tests via Unity MCP

```bash
# Run EditMode tests (fast, no Play mode)
mcp_unityMCP_run_tests({ mode: "EditMode" })

# Run PlayMode tests (requires Play mode)
mcp_unityMCP_run_tests({ mode: "PlayMode", timeout_seconds: 60 })
```

### Test Naming Convention

`[Method]_[Scenario]_[ExpectedResult]`

Example:
```
Task: Cluster Detection
├── ClusterDetectorTests.cs (EditMode)
│   ├── FindMatches_HorizontalThree_ReturnsMatch
│   ├── FindMatches_LShape_ReturnsTwoMatches
│   └── FindMatches_NoMatch_ReturnsEmpty
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

## 9. Project Structure and Asset Store Assets

### Folder Structure

Keep your game's assets in a dedicated subfolder under `Assets/`:

```
Assets/
├── _Game/                    # Your game's assets (underscore keeps it at top)
│   ├── Scenes/
│   ├── Scripts/
│   ├── Prefabs/
│   ├── Materials/
│   ├── Textures/
│   ├── Models/
│   ├── Audio/
│   ├── Animations/
│   ├── UI/
│   └── ScriptableObjects/
├── ThirdParty/               # Copied assets from Asset Store (optional organization)
├── [Asset Store Package 1]/  # Original Asset Store packages (don't modify)
├── [Asset Store Package 2]/
└── ...
```

### Why Use `_Game/` Folder?

Asset Store packages often contain many assets you don't need. Keeping your game isolated:
- **Clarity**: Easy to see what's actually used in your game
- **Clean exports**: Export only your game folder for backups or sharing
- **Safe updates**: Update Asset Store packages without breaking your game
- **Organized references**: All your game assets in one place

### Using Asset Store Assets

**NEVER use Asset Store assets directly in your game.** Always copy what you need:

```
✗ Wrong: Drag prefab directly from AssetStorePack/Prefabs/Enemy.prefab into scene
✓ Right: Copy Enemy.prefab to _Game/Prefabs/Enemy.prefab, use the copy
```

### Copying Assets with Dependencies

When copying an asset, you must also copy its dependencies and re-hook references:

```
Example: Copying a character prefab

1. Copy the prefab
   AssetStorePack/Prefabs/Knight.prefab → _Game/Prefabs/Characters/Knight.prefab

2. Copy the model/mesh
   AssetStorePack/Models/Knight.fbx → _Game/Models/Characters/Knight.fbx

3. Copy materials
   AssetStorePack/Materials/Knight_Mat.mat → _Game/Materials/Characters/Knight_Mat.mat

4. Copy textures
   AssetStorePack/Textures/Knight_Diffuse.png → _Game/Textures/Characters/Knight_Diffuse.png
   AssetStorePack/Textures/Knight_Normal.png → _Game/Textures/Characters/Knight_Normal.png

5. Re-hook references in your copies:
   - Knight.prefab → references your copied Knight.fbx
   - Knight_Mat.mat → references your copied textures
```

### Scripts from Asset Store

**Be cautious with scripts from Asset Store packages:**

| Script Type | Recommendation |
|-------------|----------------|
| Asset pack scripts (e.g., demo controllers, example code) | ❌ **Do NOT use** - Write your own |
| Standalone tools/systems (e.g., DOTween, TextMeshPro, input systems) | ✅ **OK to use** - Keep the entire package |
| Utility scripts bundled with art packs | ⚠️ **Avoid** - Often coupled to specific assets |

**Reasoning:**
- Asset pack scripts are often tightly coupled to their specific assets
- They may conflict with your architecture or coding standards
- Standalone tools are designed to be dependencies and stay as complete packages
- Mixing partial script imports creates maintenance nightmares

### Best Practices Summary

1. **Create `Assets/_Game/` folder** at project start
2. **Never modify** original Asset Store package folders
3. **Copy assets** you need into `_Game/` folders
4. **Copy all dependencies** (models, materials, textures, animations)
5. **Re-hook all references** in your copied assets
6. **Don't copy scripts** from asset packs - write your own
7. **Keep standalone tools** as complete packages (DOTween, etc.)

---

*This document is loaded during planning. Configure path in Extension Settings.*

