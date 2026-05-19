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
| Minimum scene (programmatic) | — (built in code) | <https://cx20.github.io/gltf-physics-export/example/babylonjs/index.html> |
| Shape Types | `ShapeTypes.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/ShapeTypes/index.html> |
| Materials — Friction | `Materials_Friction.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/Materials_Friction/index.html> |
| Materials — Restitution | `Materials_Restitution.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/Materials_Restitution/index.html> |
| Motion Properties | `MotionProperties.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/MotionProperties/index.html> |
| Filtering | `Filtering.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/Filtering/index.html> |
| Triggers | `Triggers.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/Triggers/index.html> |
| Joint Types | `JointTypes.glb` | <https://cx20.github.io/gltf-physics-export/example/babylonjs/JointTypes/index.html> |

> ⚠️ **Status of export for loaded samples:** the **Export .glb** button is
> wired up on every page, but the current exporter only inspects scenes built
> programmatically through `BABYLON.PhysicsAggregate` (the "Minimum scene"
> case). When invoked on a loaded sample it still produces a valid `.glb`, but
> the `KHR_physics_rigid_bodies` / `KHR_implicit_shapes` blocks come out empty.
> Teaching the exporter to read physics data back from `mesh.physicsBody`
> (and from the rigid-body loader's metadata) is the focus of the next PR.

## Roadmap

1. **Loader coverage** — done in this PR for the seven samples listed above.
2. **Export from loaded scenes** — extend the exporter to round-trip
   `KHR_physics_rigid_bodies` / `KHR_implicit_shapes` data from `physicsBody`.
3. **Control panel UI** — edit mass, friction, restitution, motion type,
   joint parameters, filter groups, trigger flags at runtime.
4. **Gizmo editing** — interactive transform handles for repositioning
   bodies and joint anchors.
5. **Round-trip validation** — confirm an exported `.glb` re-imports identical
   to the edited scene.

## Repository layout

```
example/babylonjs/
  index.html, index.js              Minimum scene that drives the exporter
  gltf-physics-exporter.js          Shared exporter module (BABYLON.GLTFPhysicsExport)
  style.css
  ShapeTypes/                       Ports of cx20/webgl-physics-examples
  Filtering/                          (Babylon.js + Havok), one per eoin sample.
  JointTypes/                         Each page loads the corresponding upstream
  Materials_Friction/                 .glb and exposes an Export .glb button.
  Materials_Restitution/
  MotionProperties/
  Triggers/
assets/textures/                    Shared textures used by the samples
```

## Acknowledgments

- glTF Physics extension and reference samples: [eoineoineoin/glTF_Physics](https://github.com/eoineoineoin/glTF_Physics)
- Babylon.js sample scenes ported from: [cx20/webgl-physics-examples](https://github.com/cx20/webgl-physics-examples/tree/master/examples/babylonjs/havok)
