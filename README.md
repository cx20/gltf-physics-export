# gltf-physics-export

An authoring sandbox for the [glTF Physics extensions](https://github.com/eoineoineoin/glTF_Physics)
(`KHR_physics_rigid_bodies`, `KHR_implicit_shapes`, …) built on Babylon.js + Havok.

The goal is to **load** the official sample assets from
[eoineoineoin/glTF_Physics](https://github.com/eoineoineoin/glTF_Physics/tree/master/samples),
**edit** them interactively via a control panel and Gizmo, and **re-export** the
configured scene back to `.glb` with the physics extensions preserved — i.e. a
round-trip editor for glTF Physics scenes.

## Live demo

- **Babylon.js + Havok exporter (minimum scene):**
  <https://cx20.github.io/gltf-physics-export/example/babylonjs/index.html>

This first sample is the export-side prototype: a floor + falling cube driven by
Havok. Clicking **Export .glb** downloads `minimum_physics.glb` carrying
`KHR_physics_rigid_bodies` + `KHR_implicit_shapes`.

## Target samples to support

Loader + editor coverage is planned for the following samples from
[eoineoineoin/glTF_Physics/samples](https://github.com/eoineoineoin/glTF_Physics/tree/master/samples):

- Basic Shapes
- Materials Friction
- Materials Restitution
- Motion Properties
- Filtering
- Triggers
- JointTypes

Each sample should round-trip: load the authored `.gltf`, edit properties
(mass, friction, restitution, motion type, joint params, …) and transforms via
the UI, then export the result as a new `.glb` whose physics extensions reflect
the edits.

## Repository layout

```
example/babylonjs/      Babylon.js + Havok exporter sample (live demo above)
assets/textures/        Shared textures used by the samples
```

## Acknowledgments

- glTF Physics extension and reference samples: [eoineoineoin/glTF_Physics](https://github.com/eoineoineoin/glTF_Physics)
- Babylon.js exporter sample ported from: [cx20/webgl-physics-examples](https://github.com/cx20/webgl-physics-examples/tree/master/examples/babylonjs/havok/gltf_physics_Exporter)
