# gltf-physics-export

An authoring sandbox for the [glTF Physics extensions](https://github.com/eoineoineoin/glTF_Physics)
(`KHR_physics_rigid_bodies`, `KHR_implicit_shapes`, …) built on Babylon.js + Havok.

The goal is to **load** the official sample assets from
[eoineoineoin/glTF_Physics](https://github.com/eoineoineoin/glTF_Physics/tree/master/samples),
**edit** them interactively via a control panel and Gizmo, and **re-export** the
configured scene back to `.glb` with the physics extensions preserved — i.e. a
round-trip editor for glTF Physics scenes.

## Live demos

Each page loads an upstream `.glb` from
[eoineoineoin/glTF_Physics/samples](https://github.com/eoineoineoin/glTF_Physics/tree/master/samples),
runs it under Havok, and exposes an **Export .glb** button driven by the
in-repo [`gltf-physics-exporter.js`](example/babylonjs/gltf-physics-exporter.js).

| Sample | Source `.glb` | Live demo |
| --- | --- | --- |
| Minimum scene (programmatic) | — (built in code) | <https://cx20.github.io/gltf-physics-export/example/babylonjs/minimum/index.html> |
| Shape Types | `ShapeTypes.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf_physics_ShapeTypes/index.html> |
| Materials — Friction | `Materials_Friction.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf_physics_Materials_Friction/index.html> |
| Materials — Restitution | `Materials_Restitution.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf_physics_Materials_Restitution/index.html> |
| Motion Properties | `MotionProperties.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf_physics_Motion_Properties/index.html> |
| Filtering | `Filtering.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf_physics_Filtering/index.html> |
| Triggers | `Triggers.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf_physics_Triggers/index.html> |
| Joint Types | `JointTypes.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf_physics_JointTypes/index.html> |
| Robot (skinned) | `Robot_skinned.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf_physics_Robot_skinned/index.html> |
| Water Wheel | `WaterWheel.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/gltf_physics_WaterWheel/index.html> |
| Round-trip validation | (all of the above) | <https://cx20.github.io/gltf-physics-export/example/babylonjs/validation.html> |

**Export pipeline.** Each loaded sample now round-trips its full physics
payload: on load, the exporter fetches the source `.glb`, parses its JSON
chunk, and stashes the original `KHR_implicit_shapes` and
`KHR_physics_rigid_bodies` blocks (shapes, materials, collision filters,
joints, and every per-node body / collider / trigger / joint entry) under
`scene.metadata`. On export, Babylon's `GLTF2Export` writes the geometry
and the exporter re-injects the captured extensions into the resulting
`.glb`, remapping joint references through node names so they survive
Babylon's node renumbering. The programmatic minimum scene still uses the
older `mesh.aggregate` path.

> **Exporter internals & design notes:** why a plain `GLTF2Export` can't
> round-trip glTF Physics, and the techniques used to work around it
> (source-index node tags, `metadataSelector`, collider-mesh re-injection,
> GLB repacking, validation pitfalls) are documented in
> [`docs/exporter-internals.md`](docs/exporter-internals.md).

## Roadmap

1. **Loader coverage** — done.
2. **Export from loaded scenes** — done in this PR (`KHR_physics_rigid_bodies`
   + `KHR_implicit_shapes` round-trip end-to-end, including joints).
3. **Control panel UI** — in progress. A lil-gui panel
   ([`control-panel.js`](example/babylonjs/control-panel.js)) is wired into
   every sample page. Edits write back to the captured extension data so
   they survive export, and are applied live to the running Havok body.
   Coverage so far:

   | Parameter | Source field | Status |
   | --- | --- | --- |
   | Body mass | `motion.mass` | ✅ slider, live |
   | Material friction (static = dynamic) | `physicsMaterials[i].staticFriction` / `dynamicFriction` | ✅ slider, live |
   | Material restitution | `physicsMaterials[i].restitution` | ✅ slider, live |
   | Reset positions | snapshot taken at load | ✅ button |
   | Motion type (static/kinematic/dynamic) | presence of `motion` + `motion.isKinematic` | ✅ dropdown, live |
   | Gravity factor | `motion.gravityFactor` | ✅ slider, live |
   | Linear / angular velocity | `motion.linearVelocity` / `angularVelocity` | ✅ XYZ sliders, live |
   | Inertia / center of mass | `motion.inertiaDiagonal` etc. | ⏳ not yet |
   | Collision filter groups / masks | `collider.collisionFilter` | ⏳ not yet |
   | Trigger flags | `trigger.*` | ⏳ not yet |
   | Joint parameters (limits, drives) | `physicsJoints[i].*` | ⏳ not yet |
   | Shape geometry (sphere radius, box size, …) | `shapes[i].*` | ⏳ not yet |

   The body-scoped parameters (mass / motion type / gravity / velocity) are
   grouped under `Bodies/<node name>/Motion` in the panel; materials remain
   under a top-level `Materials` folder.
4. **Gizmo editing** — interactive transform handles for repositioning
   bodies and joint anchors.
5. **Round-trip validation** — done. The
   [`validation.html`](example/babylonjs/validation.html) page loads each
   sample, exports it via `GLTFPhysicsExport`, and checks the result two
   ways: a **round-trip** check diffs the resulting physics extension blocks
   against the source for semantic equivalence (then re-loads the export to
   confirm the physics bodies rebuild), and a **glTF Validator** check runs
   the exported `.glb` through the official
   [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator)
   so the downloadable file is verified structurally valid (a row fails on
   any validator error; warnings are listed but do not fail).

## Programmatic-export coverage & limitations

The **programmatic export path** (`collectPhysicsData` →
`injectPhysicsExtensions`, used for scenes built with `PhysicsAggregate`
rather than loaded from a `.glb`) now covers:

- **Mesh / convex-hull colliders** — a `PhysicsShapeType.MESH` / `CONVEX_HULL`
  body exports as `collider.geometry.mesh`, referencing the node's own glTF
  mesh (so e.g. a `MeshBuilder.CreateGround` floor keeps its collider instead
  of letting everything fall through). Box / sphere / capsule / cylinder still
  export as `KHR_implicit_shapes`.
- **Constraint / joint export with motors** — Babylon exposes no API to
  enumerate a scene's constraints, so the app registers each joint it wants
  exported via `GLTFPhysicsExport.registerJoint(scene, spec)`. Each becomes a
  `KHR_physics_rigid_bodies.physicsJoints` entry (limits + drives) plus a pair
  of `jointSpaceA` / `jointSpaceB` anchor nodes. A `motor` (target velocity /
  position, max force, damping) exports as a joint `drive`, so motor-driven
  mechanisms (a wheel, a wheg walker, the upstream WaterWheel / Robot) keep
  moving on re-import. `spec`:

  ```js
  BABYLON.GLTFPhysicsExport.registerJoint(scene, {
      bodyA: chassisMesh, bodyB: wheelMesh,        // the two rigid-body meshes
      pivotA: new BABYLON.Vector3(1.2, -0.7, 1.1), // attach point in each body's local space
      pivotB: BABYLON.Vector3.Zero(),
      axisA: new BABYLON.Vector3(1, 0, 0),         // hinge axis in each body's local space
      axisB: new BABYLON.Vector3(1, 0, 0),
      type: "hinge",                               // free rotation about the axis
      motor: { targetVelocity: -6, maxForce: 1e6, damping: 100 }
  });
  ```

> Note: runtime control logic is application code and cannot round-trip
> through glTF. A scene whose motion comes from per-frame script (e.g.
> `applyAngularImpulse` in `onBeforeRenderObservable`, animation callbacks)
> exports only the physics *data* (bodies, shapes, joints + drives,
> materials) — the driving script is not part of the file. Encode motion as a
> joint **drive** (a motor, as above), not a per-frame impulse, for it to
> round-trip.

## Repository layout

```
example/babylonjs/
  gltf-physics-exporter.js          Shared exporter module (BABYLON.GLTFPhysicsExport)
  control-panel.js                  Shared lil-gui control panel module
  validation.html, validation.js    Round-trip validation page
  minimum/                          Programmatic minimum scene that drives the exporter
    index.html, index.js, style.css
  gltf_physics_ShapeTypes/          Ports of cx20/webgl-physics-examples
  gltf_physics_Filtering/             (Babylon.js + Havok), one per eoin sample.
  gltf_physics_JointTypes/            Each page loads the corresponding upstream
  gltf_physics_Materials_Friction/    .glb and exposes an Export .glb button.
  gltf_physics_Materials_Restitution/
  gltf_physics_Motion_Properties/
  gltf_physics_Robot_skinned/
  gltf_physics_Triggers/
  gltf_physics_WaterWheel/
assets/textures/                    Shared textures used by the samples
```

## Acknowledgments

- glTF Physics extension and reference samples: [eoineoineoin/glTF_Physics](https://github.com/eoineoineoin/glTF_Physics)
- Babylon.js sample scenes ported from: [cx20/webgl-physics-examples](https://github.com/cx20/webgl-physics-examples/tree/master/examples/babylonjs/havok)
