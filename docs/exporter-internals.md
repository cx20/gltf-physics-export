# glTF Physics Exporter — Internals & Design Notes

[`example/babylonjs/gltf-physics-exporter.js`](../example/babylonjs/gltf-physics-exporter.js)
is a small library that takes a scene loaded into Babylon.js + Havok and
**re-exports it as a `.glb` carrying the glTF Physics extensions
(`KHR_physics_rigid_bodies` / `KHR_implicit_shapes`), so that physics is
restored when the file is opened in other viewers.**

This document records the *why* behind the implementation: why running
Babylon's `GLTF2Export` as-is does **not** round-trip physics, and the
techniques used to work around it.

> Related: the overall goal is in [`../README.md`](../README.md). The
> relationship with the consumer (the cx20/gltf-test viewer) is covered at
> the end under "Integration with the consumer".

---

## 1. The core problem — why a plain GLTF2Export does not round-trip

Babylon's `BABYLON.GLTF2Export.GLBAsync(scene, ...)` writes out geometry,
materials and the node hierarchy, but **emits none of the glTF Physics
extension data**. On the Babylon side, physics exists only as `PhysicsBody`
/ `PhysicsShape` (Havok) objects, which have no serializer mapping to the
extension JSON — so everything physics-related is lost on export.

The basic strategy is therefore:

1. **At load time, stash (capture) the source glTF's physics extension JSON.**
2. On export, parse the `.glb` that Babylon produced, and
3. **re-inject the captured physics blocks onto the correct nodes.**

The hard part is "onto the *correct* nodes", because the following
Babylon-specific behaviours get in the way.

| Obstacle | What happens | Impact |
| --- | --- | --- |
| **Node renumbering** | Node indices change across load → serialize | Re-attaching by the original index hits the wrong node |
| **Nameless nodes** | Some nodes have no `name` (e.g. the `RigidBodies_*` tests, joint anchors) | Can't match by name |
| **Duplicate node names** | `jointSpaceA` / `jointSpaceB` etc. appear multiple times | Using the name as a Map key collapses them |
| **`node.extras` not emitted** | `GLTF2Export` does not write `extras` by default | No way to stamp a marker on a node |
| **Mesh names dropped** | `GLTF2Export` tends to drop mesh `name`s | Can't resolve a mesh reference by name |
| **Collision-only meshes disposed** | The rigid-body loader disposes the temp mesh after building the shape | The mesh a shape references is absent from the output |
| **Multi-primitive meshes split** | Babylon splits a mesh with multiple primitives | A collider ends up with only the first primitive (e.g. WaterWheel's ramp, Robot's head) |
| **Declared-but-omitted blocks** | Some models list an extension in `extensionsUsed` but ship no top-level block | The loader dereferences `extensions.<name>` and breaks |

The rest of this document describes the solution to each of these.

---

## 2. Pipeline overview

```
[load]   appendTaggedAsync(scene, url)
            ├─ fetch the source glTF/glb
            ├─ if no physics, pass the original bytes straight through (fast path)
            ├─ stamp every node with extras.__gltfPhysicsSrcNodeIdx = <index>
            ├─ splice in placeholder blocks for declared-but-missing extensions
            └─ load as a File via SceneLoader.AppendAsync (.bin/textures resolve via rootUrl)
                  ↓ Babylon's loader copies node.extras into metadata.gltf.extras
[capture] captureLoadedAsync(scene, url)
            └─ stash the source physics JSON under scene.metadata.__gltfPhysicsCaptured
               (shapes / materials / filters / joints / perNode / srcMeshOwners / colliderMeshBundle)
[edit]    edit the scene via control-panel.js / Gizmo (optional)
[export]  GLBAsync(scene, name)
            ├─ GLTF2Export.GLBAsync (metadataSelector makes it emit extras)
            ├─ parseGLB splits the produced .glb into JSON + BIN
            ├─ injectCapturedExtensions re-injects physics (growing the BIN if needed)
            ├─ stripSrcNodeTags removes the internal tags
            └─ buildGLB repacks
[verify]  validateRoundTripAsync / reloadBodyCheck
```

Public API (`BABYLON.GLTFPhysicsExport`, at the
[end of the file](../example/babylonjs/gltf-physics-exporter.js)):
`snapshot` / `reset` / `appendTaggedAsync` / `captureLoadedAsync` /
`captureProgrammatic` / `captureProgrammaticJoints` / `disposeProgrammaticJoints` /
`GLBAsync` / `validateRoundTripAsync`.

---

## 3. Core techniques

### 3.1 Source-index node tag (the key idea)

Constant `SRC_NODE_TAG = '__gltfPhysicsSrcNodeIdx'`.

**Before loading, stamp every source node with its original array index as
`extras`** (`appendTaggedAsync`). This is the one stable handle on node
identity.

```js
(json.nodes || []).forEach(function (node, i) {
    node.extras = node.extras || {};
    node.extras[SRC_NODE_TAG] = i;
});
```

Why an index:
- **Names are unreliable** (nameless / duplicated). An index is always
  unique within the source glTF.
- This index becomes the **shared key** between the capture side
  (`perNode[].srcIdx`) and the inject side (`srcNodeToExportedIdx`), so the
  source and the output can be matched even after Babylon renumbers nodes.

How the tag survives the round-trip:

```
source node.extras.__gltfPhysicsSrcNodeIdx
  → (Babylon glTF loader) babylonNode.metadata.gltf.extras.__gltfPhysicsSrcNodeIdx
  → (GLTF2Export + metadataSelector) output node.extras.__gltfPhysicsSrcNodeIdx
  → (injectCapturedExtensions) mapping to the output index
  → (stripSrcNodeTags) removed from the final file
```

### 3.2 No `metadataSelector` ⇒ no `extras` in the output

`GLTF2Export` **does not emit `node.extras` by default**. Only when you
pass a `metadataSelector` is its return value written out as `node.extras`
(in `GLBAsync`):

```js
metadataSelector: function (metadata) {
    if (metadata && metadata.gltf && metadata.gltf.extras) {
        return metadata.gltf.extras;   // ← return only the gltf.extras sub-object
    }
    return undefined;
}
```

Notes:
- Returning the whole `metadata` would dump things like the captured
  payload under `scene.metadata` into `extras`. **Always return only the
  `metadata.gltf.extras` sub-object.**
- Babylon's glTF loader copies the source `node.extras` into
  `babylonNode.metadata.gltf.extras`. The selector above is what sends that
  original `extras` (i.e. our tag) back out, completing the round-trip.

### 3.3 Placeholders for declared-but-missing top-level blocks

The cx20 rigid-body loader unconditionally dereferences
`gltf.extensions.<name>` whenever the name appears in `extensionsUsed`. But
some models (e.g. `RigidBodies_ColliderTypeMatrix_03.gltf`) list
`KHR_physics_rigid_bodies` in `extensionsUsed` yet ship **no top-level
block**. Left alone the loader breaks/misbehaves, so we splice in an empty
block before loading (`appendTaggedAsync`):

```js
if (used.indexOf('KHR_implicit_shapes') >= 0 && !json.extensions.KHR_implicit_shapes) {
    json.extensions.KHR_implicit_shapes = { shapes: [] };
}
if (used.indexOf('KHR_physics_rigid_bodies') >= 0 && !json.extensions.KHR_physics_rigid_bodies) {
    json.extensions.KHR_physics_rigid_bodies = {};
}
```

### 3.4 Fast path for non-physics models

So that `appendTaggedAsync` can be used as a *general* loader, a model that
declares no physics extension is **appended as its original bytes and
returns immediately** (no tagging, no re-encoding). This lets a catalog
viewer route every model through this helper without imposing needless risk
(e.g. a GLB re-encode) on non-physics content.

```js
const declared = json.extensionsUsed || [];
const hasPhysics = declared.indexOf('KHR_physics_rigid_bodies') >= 0
    || declared.indexOf('KHR_implicit_shapes') >= 0
    || declared.indexOf('MSFT_rigid_bodies') >= 0
    || declared.indexOf('MSFT_collision_primitives') >= 0;
if (!hasPhysics) {
    // reuse the already-fetched rawText / rawBuffer (no second fetch)
    ...
    await BABYLON.SceneLoader.AppendAsync(rootUrl, passFile, scene, null, isGltf ? '.gltf' : '.glb');
    return;
}
```

Because it loads via a `File` with `rootUrl`, a `.gltf`'s external `.bin`
and textures still resolve from their original location.

### 3.5 Multi-fallback resolution of node/mesh references

A joint's `connectedNode`, and a collider/trigger geometry's `node` /
`mesh`, are **index references** inside the glTF. These break under
renumbering, so at capture time each index is expanded into *several
handles* and stashed (`indexRefsToNames` / `geometryIndexRefsToNames`):

- `*SrcIdx` (source node/mesh index) — **primary key**
- `*Name` + `*Occurrence` (the name, and "which of the same-named ones") —
  name fallback
- For meshes, also stash the **owning node's** srcIdx/name (`meshOwner*`).
  Babylon drops mesh names but usually **keeps node names**, so on the
  output side we can look up the owner node and read its `mesh` field to
  recover the mesh index.

At inject time (`namesToIndexRefs` / `geometryNamesToIndexRefs`), resolution
is attempted in this order:

1. `srcMeshIdx` → output mesh index (`srcMeshToExportedIdx`)
2. owner `srcNodeIdx` → output node → its `mesh`
3. mesh-name fallback
4. owner-name fallback

Node references resolve similarly: `srcIdx` first, then name + occurrence.
If everything fails, a `console.warn` makes it visible (no silent breakage).

### 3.6 Always re-inject collider meshes

A mesh-based collider/trigger references a glTF mesh by index, but Babylon:

- **disposes a collision-only mesh** (one not used for rendering) after
  building its shape → it is absent from the output, and
- **splits a multi-primitive mesh** → owner-node resolution would only
  recover the first primitive.

So instead of relying on owner-node resolution, we **always re-inject the
geometry for every mesh referenced by a captured collider/trigger from the
capture-time data** (`injectCapturedExtensions` → `injectColliderMeshes`).
This duplicates a little geometry (invisible — physics only) in exchange for
complete, exact collision shapes.

Capture is done by `captureColliderMeshGeometry`:
- **Merge all primitives of each source mesh into a single primitive
  (POSITION + indices only).** Materials/normals/UVs are irrelevant to
  physics, and a single primitive sidesteps the loader's inability to build
  a shape from a multi-primitive orphan mesh (e.g. WaterWheel's 2-primitive
  ramp).
- POSITION is re-encoded as float32 / VEC3 (with min/max); indices as
  uint32 / SCALAR.

### 3.7 Manual GLB pack/unpack and 4-byte alignment

We **split and rebuild** the `.glb` Babylon produced ourselves
(`parseGLB` / `buildGLB`), because re-injection grows the BIN and Babylon's
`.glb` can't simply be reused.

What the GLB spec requires:

- Magic `0x46546C67` (`glTF`), version 2, little-endian.
- Chunks in order: JSON (type `0x4E4F534A`) then BIN (type `0x004E4942`).
- **Pad the JSON chunk with spaces `0x20` and the BIN chunk with `0x00` to a
  4-byte boundary** (`padTo4`).
- Each re-injected bufferView is appended at a **4-byte aligned offset** at
  the end of the BIN (`injectColliderMeshes`). Skipping alignment makes
  accessor reads misalign in other viewers.

---

## 4. Validation, and its pitfall

[`validation.html`](../example/babylonjs/validation.html) /
[`validation.js`](../example/babylonjs/validation.js) round-trip-check every
sample plus the upstream tests. There are **two layers** of checking.

### 4.1 JSON diff (`validateRoundTripAsync`)

Normalizes the source glTF's physics JSON and the exported physics JSON, and
compares them (`normalizePhysicsJson` + `deepDiff`). To absorb renumbering
etc., **every reference is folded to a canonical source-node index**
(`canonicalizeRefsForDiff`):

- Per-node entries are keyed by `srcIdx:<n>` (nameless / duplicate nodes
  survive).
- A joint's `connectedNode` and a geometry's `node` become canonical node ids.
- Mesh references are compared by **presence**, not index. The geometry is
  preserved, but the mesh index and owner change across the round-trip, and
  a re-injected collision mesh has no owner. Presence comparison keeps a
  genuinely dropped collider (no mesh on export) failing while a correctly
  round-tripped one passes.
- Floats compare with a tolerance of `FLOAT_EPS = 1e-4`.

**Pitfall (important):** this JSON diff is close to comparing "the source
JSON" against "a re-injected clone of the source", so for the physics blocks
it is **partly tautological**. It catches reference-resolution failures, but
does *not* guarantee that the exported `.glb` actually rebuilds physics when
loaded again. This once caused a false PASS — "all green, yet no physics
shapes appear in the viewer".

### 4.2 Reload check (`reloadBodyCheck` — the real test)

So a **stronger check** was added on the validation.js side:

1. Export the captured scene in the user-facing format via `GLBAsync`,
2. **load that `.glb` back into a fresh scene with the rigid-body loader**, and
3. **compare the physics-body count against the source** (FAIL on mismatch).

Because it actually runs the output through the loader, it catches colliders
whose shape can't be rebuilt — the safety net for what the JSON diff misses.

---

## 5. Programmatic (PhysicsAggregate) scenes

Scenes without an upstream `.glb` (e.g. the `minimum` sample) use
`captureProgrammatic` / `captureProgrammaticJoints` instead of
`captureLoadedAsync` to synthesize physics from the scene (the
`collectPhysicsData` family reads `PhysicsBody`/`PhysicsShape` and converts
them into glTF physics-block equivalents). Joints are represented
temporarily as anchor child nodes (`ANCHOR_PREFIX = '__jointAnchor_'`)
before injection. `GLBAsync` uses `injectCapturedExtensions` when a captured
payload (`CAPTURED_KEY`) exists on `scene.metadata`, otherwise
`injectPhysicsExtensions` (the programmatic path).

---

## 6. Integration with the consumer (cx20/gltf-test viewer)

This library is published on GitHub Pages and referenced live by the
separate generic viewer **cx20/gltf-test** via
`<script src="https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf-physics-exporter.js">`.
That means:

- An exporter change reaches the live viewer **only after it lands on this
  repo's `main`/Pages.**
- The viewer has **two variants — a WebGL build
  (`examples/babylonjs/index.js`) and a WebGPU build
  (`examples/babylonjs_webgpu/index.js`)** — and the physics-export
  integration must be kept in sync across both. Integration essentials:
  - Remote http(s) sources are loaded via `appendTaggedAsync` (falling back
    to `LoadAsync` on error).
  - `captureLoadedAsync` runs for **any remote source**, not just `.glb`
    (so `.gltf` + `.bin` tests are captured too).
  - Drag-and-drop / data-URI keep the plain loader, because their external
    buffers resolve through an in-memory file map that `appendTaggedAsync`
    can't see.

---

## 7. Pitfall checklist (recap)

- [ ] Did you pass a **`metadataSelector`** to `GLTF2Export`? (Without it,
      `extras` is not emitted.)
- [ ] Does the selector return **only `metadata.gltf.extras`**? (Returning
      the whole object pollutes the output.)
- [ ] Node matching uses **`SRC_NODE_TAG` (srcIdx) as primary, name +
      occurrence as fallback.**
- [ ] Did you **splice placeholders** for blocks listed in `extensionsUsed`
      but missing a top-level body?
- [ ] Collider/trigger meshes are **always re-injected** (don't depend on
      owner-node resolution).
- [ ] Re-injected meshes **merge all primitives into a single primitive.**
- [ ] GLB padding: **JSON = `0x20`, BIN = `0x00`, to 4 bytes**, and appended
      data is 4-byte aligned.
- [ ] Validation is backed not just by the JSON diff but by
      **`reloadBodyCheck` (reload)**.
- [ ] Did you **strip `SRC_NODE_TAG`** from the output file
      (`stripSrcNodeTags`)?

---

## 8. Function map ([gltf-physics-exporter.js](../example/babylonjs/gltf-physics-exporter.js))

| Area | Function | Role |
| --- | --- | --- |
| Load | `appendTaggedAsync` | Stamp tags + splice placeholders + non-physics fast path + load |
| Capture | `captureLoadedAsync` | Stash the source physics JSON onto `scene.metadata` |
| Capture | `captureColliderMeshGeometry` | Merge a collider mesh into a single primitive and stash it |
| Capture | `fetchSourceJson` / `fetchSourceBinaries` / `dataUriToUint8` / `readAccessorNumbers` | Fetch source data / decode accessors |
| Capture (programmatic) | `captureProgrammatic` / `captureProgrammaticJoints` / `collectPhysicsData` / `describe*` | Synthesize physics from an Aggregate scene |
| Export | `GLBAsync` | The entry point: GLTF2Export → parse → inject → strip → build |
| Inject | `injectCapturedExtensions` | Re-inject stashed blocks onto output nodes (srcIdx primary / name fallback) |
| Inject | `injectColliderMeshes` | Append dropped collider meshes into the BIN (4-byte aligned) |
| Inject | `injectPhysicsExtensions` | Injection for the programmatic path |
| Ref mapping | `indexRefsToNames` / `geometryIndexRefsToNames` | Expand index → multiple handles (capture side) |
| Ref mapping | `namesToIndexRefs` / `geometryNamesToIndexRefs` | Resolve handles → output index (inject side) |
| GLB | `parseGLB` / `buildGLB` / `padTo4` / `triggerDownload` | GLB split/rebuild, padding, download |
| Validation | `validateRoundTripAsync` / `normalizePhysicsJson` / `canonicalize*ForDiff` / `diffArray` / `diffPerNode` / `deepDiff` | Round-trip validation (JSON diff) |
| Snapshot | `snapshot` / `reset` / `applySnapshots` | Save/restore pre-edit state |
