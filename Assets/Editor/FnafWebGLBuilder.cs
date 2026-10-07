// Menu: FNAF > ... . Converts the HDRP project to URP content and builds WebGL.
// Uses reflection for URP types so the project still compiles before URP is installed.
using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

public static class FnafWebGLBuilder
{
    const string UrpRuntime = "Unity.RenderPipelines.Universal.Runtime";

    [MenuItem("FNAF/1. Create URP asset and assign it")]
    public static void CreateUrpAsset()
    {
        var rendererType = Type.GetType("UnityEngine.Rendering.Universal.UniversalRendererData, " + UrpRuntime);
        var assetType = Type.GetType("UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset, " + UrpRuntime);
        if (rendererType == null || assetType == null)
        {
            EditorUtility.DisplayDialog("FNAF", "URP package is not installed. Follow docs/UNITY_WEBGL.md step 1 first.", "OK");
            return;
        }
        Directory.CreateDirectory("Assets/Settings");
        var renderer = ScriptableObject.CreateInstance(rendererType);
        AssetDatabase.CreateAsset(renderer, "Assets/Settings/URP-Renderer.asset");
        var create = assetType.GetMethod("Create", new[] { rendererType.BaseType });
        var asset = (RenderPipelineAsset)create.Invoke(null, new object[] { renderer });
        AssetDatabase.CreateAsset(asset, "Assets/Settings/URP-Asset.asset");
        GraphicsSettings.renderPipelineAsset = asset;
        for (int i = 0; i < QualitySettings.names.Length; i++)
        {
            QualitySettings.SetQualityLevel(i, false);
            QualitySettings.renderPipeline = asset;
        }
        AssetDatabase.SaveAssets();
        Debug.Log("URP asset created and assigned.");
    }

    [MenuItem("FNAF/2. Convert HDRP/Lit materials to URP/Lit")]
    public static void ConvertMaterials()
    {
        var urp = Shader.Find("Universal Render Pipeline/Lit");
        if (urp == null) { Debug.LogError("URP/Lit shader not found. Install URP first."); return; }
        int n = 0;
        foreach (var guid in AssetDatabase.FindAssets("t:Material", new[] { "Assets" }))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null) continue;
            // HDRP/Lit materials lose their shader when the HDRP package is removed (shows as the error shader);
            // their serialized properties are still there.
            bool hdrp = m.shader == null || m.shader.name.StartsWith("Hidden/InternalErrorShader") || m.shader.name.StartsWith("HDRP/");
            if (!hdrp) continue;
            Texture baseMap = Get(m, "_BaseColorMap") ?? Get(m, "_MainTex");
            Color baseCol = m.HasProperty("_BaseColor") ? m.GetColor("_BaseColor") : Color.white;
            Texture emiMap = Get(m, "_EmissiveColorMap");
            Color emi = m.HasProperty("_EmissiveColor") ? m.GetColor("_EmissiveColor") : Color.black;
            float metal = m.HasProperty("_Metallic") ? m.GetFloat("_Metallic") : 0f;
            float smooth = m.HasProperty("_Smoothness") ? m.GetFloat("_Smoothness") : 0.3f;
            bool transparent = m.HasProperty("_SurfaceType") && m.GetFloat("_SurfaceType") > 0.5f;
            bool clip = m.HasProperty("_AlphaCutoffEnable") && m.GetFloat("_AlphaCutoffEnable") > 0.5f;
            float cutoff = m.HasProperty("_AlphaCutoff") ? m.GetFloat("_AlphaCutoff") : 0.5f;
            bool doubleSided = m.HasProperty("_DoubleSidedEnable") && m.GetFloat("_DoubleSidedEnable") > 0.5f;
            m.shader = urp;
            if (baseCol.maxColorComponent < 0.01f && baseMap != null) baseCol = Color.white;
            m.SetColor("_BaseColor", baseCol);
            if (baseMap != null) m.SetTexture("_BaseMap", baseMap);
            m.SetFloat("_Metallic", metal); m.SetFloat("_Smoothness", smooth);
            if (emi.maxColorComponent > 0.001f)
            {
                m.EnableKeyword("_EMISSION");
                var e = emi; float mx = e.maxColorComponent; if (mx > 1f) e /= mx;
                m.SetColor("_EmissionColor", e);
                if (emiMap != null) m.SetTexture("_EmissionMap", emiMap);
            }
            if (transparent) { m.SetFloat("_Surface", 1); m.SetFloat("_Blend", 0); m.renderQueue = 3000; m.SetOverrideTag("RenderType", "Transparent"); m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT"); }
            if (clip) { m.SetFloat("_AlphaClip", 1); m.SetFloat("_Cutoff", cutoff); m.EnableKeyword("_ALPHATEST_ON"); }
            if (doubleSided || transparent || clip) m.SetFloat("_Cull", 0);
            EditorUtility.SetDirty(m); n++;
        }
        AssetDatabase.SaveAssets();
        Debug.Log("Converted " + n + " materials.");
    }
    static Texture Get(Material m, string p) => m.HasProperty(p) ? m.GetTexture(p) : null;

    [MenuItem("FNAF/3. Clean scenes (HDRP leftovers, light intensities)")]
    public static void CleanScenes()
    {
        foreach (var guid in AssetDatabase.FindAssets("t:Scene", new[] { "Assets/Scenes" }))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            var scene = EditorSceneManager.OpenScene(path, OpenSceneMode.Single);
            int removed = 0;
            foreach (var root in scene.GetRootGameObjects())
                foreach (var t in root.GetComponentsInChildren<Transform>(true))
                    removed += GameObjectUtility.RemoveMonoBehavioursWithMissingScript(t.gameObject);
            foreach (var l in UnityEngine.Object.FindObjectsOfType<Light>(true))
            {
                // HDRP stored photometric values (lumen/lux). Map to URP's unitless intensity.
                switch (l.type)
                {
                    case LightType.Directional: l.intensity = 0.25f; break;
                    case LightType.Spot: l.intensity = Mathf.Clamp(l.intensity / 700f, 0.3f, 6f); break;
                    default: l.intensity = Mathf.Clamp(l.intensity / 70f, 0.3f, 3f); break;
                }
                l.shadows = LightShadows.None;
            }
            RenderSettings.ambientMode = AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.22f, 0.24f, 0.30f);
            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene);
            Debug.Log(path + ": removed " + removed + " missing scripts.");
        }
        // prefabs
        foreach (var guid in AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" }))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            var root = PrefabUtility.LoadPrefabContents(path);
            int r = 0;
            foreach (var t in root.GetComponentsInChildren<Transform>(true)) r += GameObjectUtility.RemoveMonoBehavioursWithMissingScript(t.gameObject);
            foreach (var l in root.GetComponentsInChildren<Light>(true))
                l.intensity = l.type == LightType.Spot ? Mathf.Clamp(l.intensity / 700f, 0.3f, 6f) : Mathf.Clamp(l.intensity / 70f, 0.3f, 3f);
            if (r > 0) PrefabUtility.SaveAsPrefabAsset(root, path);
            PrefabUtility.UnloadPrefabContents(root);
        }
        AssetDatabase.SaveAssets();
    }

    [MenuItem("FNAF/4. Build WebGL (Build/WebGL)")]
    public static void BuildWebGL()
    {
        var scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
        if (scenes.Length == 0) scenes = new[] { "Assets/Scenes/MainMenu.unity", "Assets/Scenes/Game.unity" };
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Brotli;
        PlayerSettings.WebGL.decompressionFallback = true;   // works on hosts that cannot set Content-Encoding (Render static)
        PlayerSettings.WebGL.dataCaching = true;
        PlayerSettings.WebGL.memorySize = 512;
        PlayerSettings.colorSpace = ColorSpace.Linear;
        var opts = new BuildPlayerOptions { scenes = scenes, locationPathName = "Build/WebGL", target = BuildTarget.WebGL, options = BuildOptions.None };
        var report = BuildPipeline.BuildPlayer(opts);
        Debug.Log("WebGL build: " + report.summary.result + " (" + report.summary.totalSize / (1024 * 1024) + " MB)");
    }

    [MenuItem("FNAF/Run all steps (after URP is installed)")]
    public static void All() { CreateUrpAsset(); ConvertMaterials(); CleanScenes(); BuildWebGL(); }
}
