# Unity WebGL build (original game, no re-implementation)

Project: Unity 2021.3.4f1, HDRP 12.1.7. HDRP does not run on WebGL, so the content is converted to URP first.

1. Install **Unity 2021.3.4f1** with the **WebGL Build Support** module (free Personal licence is enough). Run `git lfs pull` in this repo.
2. Open the project. When asked about errors/safe mode choose *Ignore* / *Enter Safe Mode*.
3. In `Packages/manifest.json` replace
   `"com.unity.render-pipelines.high-definition": "12.1.7"` with `"com.unity.render-pipelines.universal": "12.1.7"` and reopen the project.
4. Menu **FNAF → Run all steps**. This creates and assigns a URP asset, converts the HDRP/Lit materials (base map, colour, emission, alpha clip, double sided), removes HDRP leftovers (volumes, HD light/camera data) from the scenes and prefabs, maps the photometric light intensities, and builds WebGL with Brotli into `Build/WebGL`. The steps are also available one by one under the same menu.
5. Open the scenes and look: URP lighting differs from HDRP, so tune light intensities / ambient light by eye. Re-run **4. Build WebGL** after changes.
6. Deploy: upload `Build/WebGL` as a Render **Static Site** (publish directory `Build/WebGL`). `decompressionFallback` is on so it works without custom `Content-Encoding` headers (the first load is a bit slower).

The editor script is untested (written without access to the Unity editor); fix compile errors in the Console if URP API names differ.
