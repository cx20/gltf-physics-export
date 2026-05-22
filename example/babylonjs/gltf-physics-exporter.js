// Babylon.js + Havok glTF Physics exporter module.
// Exposes BABYLON.GLTFPhysicsExport with:
//   - snapshot(scene)                              capture initial transforms (optional)
//   - captureLoadedAsync(scene, glbUrl)            capture KHR_physics_* extensions from a .glb
//                                                  that has just been appended to the scene, so
//                                                  the same data can be re-emitted on export.
//   - GLBAsync(scene, fileName, options)           export the scene as a .glb with
//                                                  KHR_physics_rigid_bodies + KHR_implicit_shapes
//
// Two export paths:
//   1. Programmatic scenes (Babylon PhysicsAggregate) — shapes + materials are
//      derived from each mesh's aggregate / boundingInfo.
//   2. Loaded scenes (captureLoadedAsync was called) — the original
//      KHR_implicit_shapes / KHR_physics_rigid_bodies blocks are preserved
//      verbatim. Per-node joint.connectedNode references are resolved to node
//      names at capture time and remapped to indices at export time so they
//      survive Babylon's re-numbering.

(function (BABYLON) {
    if (!BABYLON) {
        throw new Error('Babylon.js must be loaded before gltf-physics-exporter.js');
    }

    const SNAPSHOT_KEY = '__gltfPhysicsExportSnapshot';
    const CAPTURED_KEY = '__gltfPhysicsCaptured';
    // Joints registered by the app via registerJoint(scene, spec); Babylon has
    // no API to enumerate a scene's constraints, so the programmatic export
    // path reads them from here.
    const JOINT_REG_KEY = '__gltfPhysicsJointRegs';

    const GLB_MAGIC = 0x46546C67;  // 'glTF'
    const GLB_VERSION = 2;
    const CHUNK_JSON = 0x4E4F534A; // 'JSON'
    const CHUNK_BIN  = 0x004E4942; // 'BIN\0'

    function isPhysicsMesh(mesh) {
        return !!(mesh && (mesh.physicsBody || mesh.aggregate));
    }

    // True when an ancestor also carries physics. The rigid-body loader folds
    // a parented collider into the ancestor's compound shape (a node with
    // `motion` plus descendants with `collider`), so such a descendant must
    // export its collider WITHOUT a motion block. If it kept motion, the
    // loader would build a SECOND, shapeless dynamic body on the child node
    // (its shape having gone into the parent's compound) that falls away under
    // gravity, dragging the child's visual mesh down while the compound
    // collider stays correctly placed.
    function hasPhysicsAncestor(mesh) {
        let p = mesh && mesh.parent;
        while (p) {
            if (isPhysicsMesh(p)) return true;
            p = p.parent;
        }
        return false;
    }

    function forEachPhysicsNode(scene, fn) {
        const seen = new Set();
        const visit = function (n) {
            if (!n || seen.has(n)) return;
            if (n.physicsBody || n.aggregate) {
                seen.add(n);
                fn(n);
            }
        };
        (scene.meshes || []).forEach(visit);
        (scene.transformNodes || []).forEach(visit);
    }

    function snapshot(scene) {
        forEachPhysicsNode(scene, function (node) {
            node.metadata = node.metadata || {};
            node.metadata[SNAPSHOT_KEY] = {
                position: node.position.clone(),
                rotation: node.rotation ? node.rotation.clone() : null,
                rotationQuaternion: node.rotationQuaternion ? node.rotationQuaternion.clone() : null
            };
        });
    }

    // --- capture loaded physics ---

    // Fetch and parse a glTF source. Accepts both binary `.glb` and the
    // JSON `.gltf` variant (the upstream test suites at
    // https://github.com/eoineoineoin/glTF_Physics/tree/master/tests ship the
    // latter alongside `.bin` buffers). We only need the JSON chunk here, so
    // we never have to materialize the `.bin` payloads — they are pulled in
    // by Babylon's SceneLoader independently.
    async function fetchSourceJson(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('fetch failed for ' + url + ': ' + response.status);
        }
        if (/\.gltf(\?.*)?$/i.test(url)) {
            return await response.json();
        }
        const arrayBuffer = await response.arrayBuffer();
        return parseGLB(arrayBuffer).json;
    }

    // Resolve every glTF buffer to a Uint8Array. For .glb the single
    // buffer is the embedded BIN chunk; for .gltf the buffers reference
    // external .bin files (or inline data: URIs). Only called when a
    // collider/trigger references a mesh, so most loads never fetch
    // binary at all.
    async function fetchSourceBinaries(sourceUrl, json) {
        const slash = sourceUrl.lastIndexOf('/');
        const rootUrl = sourceUrl.substring(0, slash + 1);
        const isGltf = /\.gltf(\?.*)?$/i.test(sourceUrl);
        let glbBin = null;
        if (!isGltf) {
            const resp = await fetch(sourceUrl);
            if (!resp.ok) throw new Error('fetchSourceBinaries: fetch failed: ' + resp.status);
            glbBin = parseGLB(await resp.arrayBuffer()).bin;
        }
        const buffers = json.buffers || [];
        const binaries = [];
        for (let i = 0; i < buffers.length; i++) {
            const buf = buffers[i];
            if (!buf.uri) {
                binaries[i] = glbBin || new Uint8Array(0);
            } else if (/^data:/i.test(buf.uri)) {
                binaries[i] = dataUriToUint8(buf.uri);
            } else {
                const binResp = await fetch(rootUrl + buf.uri);
                if (!binResp.ok) throw new Error('fetchSourceBinaries: bin fetch failed: ' + binResp.status);
                binaries[i] = new Uint8Array(await binResp.arrayBuffer());
            }
        }
        return binaries;
    }

    function dataUriToUint8(uri) {
        const comma = uri.indexOf(',');
        const meta = uri.substring(0, comma);
        const data = uri.substring(comma + 1);
        if (/;base64/i.test(meta)) {
            const bin = atob(data);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        return new TextEncoder().encode(decodeURIComponent(data));
    }

    // glTF accessor component sizes / counts.
    const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

    // Decode an accessor to a flat JS number array (handles byteStride and
    // all component types). Used to merge collider primitives.
    function readAccessorNumbers(json, binaries, accIdx) {
        const acc = (json.accessors || [])[accIdx];
        if (!acc || typeof acc.bufferView !== 'number') return [];
        const bv = json.bufferViews[acc.bufferView];
        const buffer = binaries[bv.buffer];
        if (!buffer) return [];
        const numComp = TYPE_COMPONENTS[acc.type] || 1;
        const compSize = COMP_SIZE[acc.componentType] || 4;
        const elemSize = numComp * compSize;
        const stride = bv.byteStride || elemSize;
        const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const out = [];
        for (let i = 0; i < acc.count; i++) {
            const elemOff = base + i * stride;
            for (let c = 0; c < numComp; c++) {
                const off = elemOff + c * compSize;
                let v;
                switch (acc.componentType) {
                    case 5126: v = dv.getFloat32(off, true); break;
                    case 5125: v = dv.getUint32(off, true); break;
                    case 5123: v = dv.getUint16(off, true); break;
                    case 5122: v = dv.getInt16(off, true); break;
                    case 5121: v = dv.getUint8(off); break;
                    case 5120: v = dv.getInt8(off); break;
                    default: v = 0;
                }
                out.push(v);
            }
        }
        return out;
    }

    // Build a self-contained bundle of geometry for every mesh referenced by
    // a collider/trigger. Each source mesh is MERGED into a single primitive
    // holding only POSITION + indices: physics doesn't need materials,
    // normals or UVs, and a single primitive sidesteps the rigid-body
    // loader's trouble building a shape from a multi-primitive orphan mesh
    // (e.g. WaterWheel's 2-primitive track ramp). The inject step appends the
    // freshly-encoded binary to the exported BIN. This re-adds collider
    // meshes Babylon drops on export (collision-only meshes are disposed
    // after shape construction; multi-primitive owners get split).
    function captureColliderMeshGeometry(json, binaries, colliderMeshIdx) {
        const bundle = { bySrcMesh: {}, meshes: [], accessors: [], bufferViews: [], binaryParts: [] };

        colliderMeshIdx.forEach(function (srcMeshIdx) {
            const srcMesh = (json.meshes || [])[srcMeshIdx];
            if (!srcMesh) return;

            const mergedPos = [];
            const mergedIdx = [];
            let vertBase = 0;
            (srcMesh.primitives || []).forEach(function (prim) {
                if (!prim.attributes || prim.attributes.POSITION == null) return;
                const pos = readAccessorNumbers(json, binaries, prim.attributes.POSITION);
                const vcount = pos.length / 3;
                let idx;
                if (typeof prim.indices === 'number') {
                    idx = readAccessorNumbers(json, binaries, prim.indices);
                } else {
                    idx = [];
                    for (let i = 0; i < vcount; i++) idx.push(i);
                }
                for (let i = 0; i < pos.length; i++) mergedPos.push(pos[i]);
                for (let i = 0; i < idx.length; i++) mergedIdx.push(idx[i] + vertBase);
                vertBase += vcount;
            });
            if (mergedPos.length === 0) return;

            // Encode POSITION (float32, VEC3) and indices (uint32, SCALAR).
            const posBytes = new Uint8Array(new Float32Array(mergedPos).buffer);
            const idxBytes = new Uint8Array(new Uint32Array(mergedIdx).buffer);
            const min = [Infinity, Infinity, Infinity];
            const max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < mergedPos.length; i += 3) {
                for (let c = 0; c < 3; c++) {
                    const v = mergedPos[i + c];
                    if (v < min[c]) min[c] = v;
                    if (v > max[c]) max[c] = v;
                }
            }

            const posBvIdx = bundle.bufferViews.length;
            bundle.bufferViews.push({ byteLength: posBytes.byteLength, target: 34962 });
            bundle.binaryParts.push(posBytes);
            const posAccIdx = bundle.accessors.length;
            bundle.accessors.push({
                bufferView: posBvIdx, componentType: 5126, count: mergedPos.length / 3,
                type: 'VEC3', min: min, max: max
            });

            const idxBvIdx = bundle.bufferViews.length;
            bundle.bufferViews.push({ byteLength: idxBytes.byteLength, target: 34963 });
            bundle.binaryParts.push(idxBytes);
            const idxAccIdx = bundle.accessors.length;
            bundle.accessors.push({
                bufferView: idxBvIdx, componentType: 5125, count: mergedIdx.length, type: 'SCALAR'
            });

            const localMesh = { primitives: [{ attributes: { POSITION: posAccIdx }, indices: idxAccIdx }] };
            if (srcMesh.name) localMesh.name = srcMesh.name;
            bundle.bySrcMesh[srcMeshIdx] = bundle.meshes.length;
            bundle.meshes.push(localMesh);
        });
        return bundle;
    }

    // Stable per-node identity tag. We plant `node.extras[SRC_NODE_TAG] =
    // <source index>` in the source glTF before Babylon loads it (see
    // appendTaggedAsync). Babylon's glTF loader copies node.extras into
    // `babylonNode.metadata.gltf.extras`, and GLTF2Export's default
    // metadataSelector copies it back to `node.extras` on the way out, so
    // the source index round-trips even for nameless / duplicate-named
    // nodes and survives Babylon's node renumbering. The inject step keys
    // off this tag to relink captured blocks onto the renumbered output.
    const SRC_NODE_TAG = '__gltfPhysicsSrcNodeIdx';

    // Load a glTF/glb but first stamp every node with its source index
    // (and patch missing top-level extension placeholders that crash the
    // rigid-body loader). Use this in place of SceneLoader.AppendAsync so
    // captureLoadedAsync/GLBAsync can round-trip physics reliably.
    async function appendTaggedAsync(scene, sourceUrl) {
        const slash = sourceUrl.lastIndexOf('/');
        const rootUrl = sourceUrl.substring(0, slash + 1);
        const fileName = sourceUrl.substring(slash + 1);
        const isGltf = /\.gltf(\?.*)?$/i.test(fileName);

        const response = await fetch(sourceUrl);
        if (!response.ok) {
            throw new Error('appendTaggedAsync: fetch failed for ' + sourceUrl + ': ' + response.status);
        }

        let json;
        let bin = null;
        let rawText = null;
        let rawBuffer = null;
        if (isGltf) {
            rawText = await response.text();
            json = JSON.parse(rawText);
        } else {
            rawBuffer = await response.arrayBuffer();
            const parsed = parseGLB(rawBuffer);
            json = parsed.json;
            bin = parsed.bin;
        }

        // Fast path: a model that declares no physics extensions has nothing
        // to round-trip, so append its ORIGINAL bytes untouched. This lets a
        // generic viewer route every model through appendTaggedAsync without
        // re-encoding (or even tagging) arbitrary non-physics content.
        const declared = json.extensionsUsed || [];
        const hasPhysics = declared.indexOf('KHR_physics_rigid_bodies') >= 0
            || declared.indexOf('KHR_implicit_shapes') >= 0
            || declared.indexOf('MSFT_rigid_bodies') >= 0
            || declared.indexOf('MSFT_collision_primitives') >= 0;
        if (!hasPhysics) {
            const passBlob = isGltf
                ? new Blob([rawText], { type: 'model/gltf+json' })
                : new Blob([rawBuffer], { type: 'model/gltf-binary' });
            const passFile = new File([passBlob], fileName, { type: passBlob.type });
            await BABYLON.SceneLoader.AppendAsync(rootUrl, passFile, scene, null, isGltf ? '.gltf' : '.glb');
            return;
        }

        (json.nodes || []).forEach(function (node, i) {
            node.extras = node.extras || {};
            node.extras[SRC_NODE_TAG] = i;
        });

        // The cx20 rigid-body loader dereferences gltf.extensions.<name>
        // whenever <name> appears in extensionsUsed; some tests list it
        // without a top-level block, so splice empty placeholders in.
        const used = json.extensionsUsed || [];
        if (used.indexOf('KHR_implicit_shapes') >= 0 || used.indexOf('KHR_physics_rigid_bodies') >= 0) {
            json.extensions = json.extensions || {};
            if (used.indexOf('KHR_implicit_shapes') >= 0 && !json.extensions.KHR_implicit_shapes) {
                json.extensions.KHR_implicit_shapes = { shapes: [] };
            }
            if (used.indexOf('KHR_physics_rigid_bodies') >= 0 && !json.extensions.KHR_physics_rigid_bodies) {
                json.extensions.KHR_physics_rigid_bodies = {};
            }
        }

        if (isGltf) {
            const blob = new Blob([JSON.stringify(json)], { type: 'model/gltf+json' });
            const file = new File([blob], fileName, { type: 'model/gltf+json' });
            await BABYLON.SceneLoader.AppendAsync(rootUrl, file, scene, null, '.gltf');
        } else {
            const outBuf = buildGLB(json, bin);
            const blob = new Blob([outBuf], { type: 'model/gltf-binary' });
            const file = new File([blob], fileName, { type: 'model/gltf-binary' });
            await BABYLON.SceneLoader.AppendAsync(rootUrl, file, scene, null, '.glb');
        }
    }

    async function captureLoadedAsync(scene, sourceUrl) {
        const json = await fetchSourceJson(sourceUrl);

        const implicit = json.extensions && json.extensions.KHR_implicit_shapes;
        const rigid = json.extensions && json.extensions.KHR_physics_rigid_bodies;
        const nodes = json.nodes || [];
        const meshes = json.meshes || [];

        // Per-node physics blocks. Cross-references that point at other
        // resources by index (joint.connectedNode, and mesh/node references
        // inside collider/trigger geometry) are stored alongside the
        // SOURCE INDEX so the export step can rebind them through the
        // extras-tagged output. Name + occurrence are kept as a fallback
        // for cases where the tag does not survive (Babylon dropping
        // extras on certain nodes).
        const byName = new Map();
        const perNode = [];
        const nameSeen = new Map();
        nodes.forEach(function (node, i) {
            const ext = node && node.extensions && node.extensions.KHR_physics_rigid_bodies;
            if (!ext) return;
            const cloned = JSON.parse(JSON.stringify(ext));
            indexRefsToNames(cloned, nodes, meshes);
            const entry = { srcIdx: i, name: node.name || null, block: cloned };
            if (node.name) {
                byName.set(node.name, cloned);
                const occ = nameSeen.get(node.name) || 0;
                nameSeen.set(node.name, occ + 1);
                entry.occurrence = occ;
            }
            perNode.push(entry);
        });

        // Pre-compute which source node owns which source mesh. The
        // inject step uses this together with the extras-tagged exported
        // nodes to remap collision-mesh references — Babylon's
        // GLTF2Export tends to drop mesh names, so we cannot rely on
        // them alone.
        const srcMeshOwners = [];
        nodes.forEach(function (node, i) {
            if (node && typeof node.mesh === 'number') {
                srcMeshOwners.push({ srcNodeIdx: i, srcMeshIdx: node.mesh });
            }
        });

        // Capture geometry for every mesh referenced by a collider/trigger
        // so the inject step can re-add the ones Babylon drops. Only fetch
        // the binary buffers when such references actually exist.
        const colliderMeshIdx = new Set();
        nodes.forEach(function (node) {
            const ext = node && node.extensions && node.extensions.KHR_physics_rigid_bodies;
            if (!ext) return;
            [ext.collider, ext.trigger].forEach(function (c) {
                if (c && c.geometry && typeof c.geometry.mesh === 'number') {
                    colliderMeshIdx.add(c.geometry.mesh);
                }
            });
        });
        let colliderMeshBundle = null;
        if (colliderMeshIdx.size > 0) {
            const binaries = await fetchSourceBinaries(sourceUrl, json);
            colliderMeshBundle = captureColliderMeshGeometry(json, binaries, colliderMeshIdx);
        }

        const captured = {
            shapes: implicit && Array.isArray(implicit.shapes)
                ? JSON.parse(JSON.stringify(implicit.shapes))
                : [],
            physicsMaterials: rigid && Array.isArray(rigid.physicsMaterials)
                ? JSON.parse(JSON.stringify(rigid.physicsMaterials))
                : [],
            collisionFilters: rigid && Array.isArray(rigid.collisionFilters)
                ? JSON.parse(JSON.stringify(rigid.collisionFilters))
                : [],
            physicsJoints: rigid && Array.isArray(rigid.physicsJoints)
                ? JSON.parse(JSON.stringify(rigid.physicsJoints))
                : [],
            byName: byName,
            perNode: perNode,
            srcMeshOwners: srcMeshOwners,
            colliderMeshBundle: colliderMeshBundle
        };

        scene.metadata = scene.metadata || {};
        scene.metadata[CAPTURED_KEY] = captured;
        return captured;
    }

    // --- capture programmatic (PhysicsAggregate) scenes ---
    //
    // Synthesize a captured-shaped payload from a scene that was built with
    // PhysicsAggregate (no upstream .glb to capture from). With this in
    // place the control panel renders its Materials / Bodies folders for
    // programmatic scenes too, and edits round-trip through the export.

    function captureProgrammatic(scene) {
        const data = collectPhysicsData(scene);
        const byName = new Map();
        data.bodies.forEach(function (block, name) {
            byName.set(name, JSON.parse(JSON.stringify(block)));
        });
        const captured = {
            shapes: data.shapes,
            physicsMaterials: data.materials,
            collisionFilters: data.collisionFilters || [],
            physicsJoints: [],
            byName: byName
        };
        scene.metadata = scene.metadata || {};
        scene.metadata[CAPTURED_KEY] = captured;
        return captured;
    }

    // --- programmatic joint capture (anchor-node form) ---
    //
    // glTF Physics joints describe the connection through two attachment
    // frames, each defined by a node's transform. Babylon's HingeConstraint
    // and Physics6DoFConstraint carry the pivot points internally — there is
    // no equivalent pivot offset in the glTF spec. To bridge that, this
    // builds a pair of TransformNode anchors per constraint (one parented
    // to each body, positioned at that body's pivot) and writes the joint
    // entry onto the first anchor. The result matches the form the upstream
    // JointTypes.glb samples use (`jointSpaceA` / `jointSpaceB`), so the
    // existing rigid-body loader picks the constraints back up at load
    // time.
    //
    // pendingPhysicsJoints entries (set by sample code via
    // scene.metadata.__pendingPhysicsJoints) have the shape:
    //   { meshA, meshB, type: 'hinge' | '6dof',
    //     pivotA: Vector3, pivotB: Vector3,    // in each body's local space
    //     limits?: [...]                        // for '6dof', the Babylon API limits
    //     enableCollision?: boolean }
    //
    // Returns a bundle the caller passes to disposeProgrammaticJoints() to
    // undo the captured-state mutation and dispose the anchors.

    const ANCHOR_PREFIX = '__jointAnchor_';

    function captureProgrammaticJoints(scene) {
        const pending = scene.metadata && scene.metadata.__pendingPhysicsJoints;
        if (!Array.isArray(pending) || pending.length === 0) return null;
        const captured = scene.metadata && scene.metadata[CAPTURED_KEY];
        if (!captured) {
            console.warn('[GLTFPhysicsExport] captureProgrammaticJoints: call captureProgrammatic first');
            return null;
        }

        const anchors = [];
        const addedNames = [];
        const startJointIdx = captured.physicsJoints.length;

        pending.forEach(function (j, idx) {
            if (!j || !j.meshA || !j.meshB) return;

            const anchorAName = ANCHOR_PREFIX + idx + '_A';
            const anchorBName = ANCHOR_PREFIX + idx + '_B';
            // Use a tiny invisible mesh rather than a bare TransformNode so
            // GLTF2Export reliably emits the node (some versions skip empty
            // TransformNodes), giving the rigid-body loader something to
            // resolve joint.connectedNode against on load.
            const anchorA = BABYLON.MeshBuilder.CreateBox(anchorAName, { size: 0.001 }, scene);
            anchorA.isVisible = false;
            anchorA.parent = j.meshA;
            if (j.pivotA) anchorA.position.copyFrom(j.pivotA);
            const anchorB = BABYLON.MeshBuilder.CreateBox(anchorBName, { size: 0.001 }, scene);
            anchorB.isVisible = false;
            anchorB.parent = j.meshB;
            if (j.pivotB) anchorB.position.copyFrom(j.pivotB);

            const limits = describeJointLimits(j);
            const jointIdx = captured.physicsJoints.length;
            captured.physicsJoints.push({ limits: limits });

            captured.byName.set(anchorAName, {
                joint: {
                    connectedNodeName: anchorBName,
                    joint: jointIdx,
                    enableCollision: !!j.enableCollision
                }
            });

            anchors.push(anchorA, anchorB);
            addedNames.push(anchorAName);
        });

        return {
            anchors: anchors,
            addedNames: addedNames,
            startJointIdx: startJointIdx
        };
    }

    function disposeProgrammaticJoints(scene, bundle) {
        if (!bundle) return;
        const captured = scene.metadata && scene.metadata[CAPTURED_KEY];
        if (captured) {
            bundle.addedNames.forEach(function (n) { captured.byName.delete(n); });
            // Trim the joints we appended so a re-export does not stack them.
            captured.physicsJoints.length = bundle.startJointIdx;
        }
        bundle.anchors.forEach(function (a) {
            try { a.dispose(); } catch (_e) { /* best effort */ }
        });
    }

    function describeJointLimits(j) {
        if (j.type === 'hinge') {
            // Lock all linear axes plus angular X and Y; leave angular Z free
            // so the joint behaves as a hinge around the anchor's local Z
            // axis. The robot constructs every hinge with axisA/axisB =
            // (0, 0, 1), so the body-local Z and the anchor-local Z coincide.
            return [
                { linearAxes: [0], min: 0, max: 0 },
                { linearAxes: [1], min: 0, max: 0 },
                { linearAxes: [2], min: 0, max: 0 },
                { angularAxes: [0], min: 0, max: 0 },
                { angularAxes: [1], min: 0, max: 0 }
            ];
        }
        if (j.type === '6dof') {
            const limits = (j.limits || []).map(function (lim) {
                const out = limitAxisToGltf(lim.axis);
                out.min = typeof lim.minLimit === 'number' ? lim.minLimit : 0;
                out.max = typeof lim.maxLimit === 'number' ? lim.maxLimit : 0;
                return out;
            });
            return limits;
        }
        return [];
    }

    function limitAxisToGltf(axis) {
        // BABYLON.PhysicsConstraintAxis enum (Babylon 6+):
        //   LINEAR_X=0, LINEAR_Y=1, LINEAR_Z=2,
        //   ANGULAR_X=3, ANGULAR_Y=4, ANGULAR_Z=5,
        //   LINEAR_DISTANCE=6
        switch (axis) {
            case 0: return { linearAxes: [0] };
            case 1: return { linearAxes: [1] };
            case 2: return { linearAxes: [2] };
            case 3: return { angularAxes: [0] };
            case 4: return { angularAxes: [1] };
            case 5: return { angularAxes: [2] };
            case 6: return { linearAxes: [0, 1, 2] };
            default:
                console.warn('[GLTFPhysicsExport] unknown PhysicsConstraintAxis:', axis);
                return { linearAxes: [0] };
        }
    }

    // --- main export entry ---

    async function GLBAsync(scene, baseName, options) {
        options = options || {};
        const captured = scene.metadata && scene.metadata[CAPTURED_KEY];
        const derived = captured ? null : collectPhysicsData(scene);
        const restore = applySnapshots(scene);
        try {
            const exportOptions = {
                shouldExportNode: function (node) {
                    if (options.shouldExportNode && !options.shouldExportNode(node)) {
                        return false;
                    }
                    if (captured) {
                        // Loaded scenes own their lights — keep them so the exported
                        // .glb stays visually identical.
                        return true;
                    }
                    return !(node instanceof BABYLON.Light);
                },
                // GLTF2Export only writes node.extras when a metadataSelector is
                // supplied; without this our __gltfPhysicsSrcNodeIdx tags never
                // reach the output and the inject step can't relink nameless /
                // duplicate-named nodes. Return only the gltf.extras sub-object
                // so we don't accidentally dump the whole captured payload
                // (which lives on scene.metadata) into the scene's extras.
                metadataSelector: function (metadata) {
                    if (metadata && metadata.gltf && metadata.gltf.extras) {
                        return metadata.gltf.extras;
                    }
                    return undefined;
                }
            };

            const gltfData = await BABYLON.GLTF2Export.GLBAsync(scene, baseName, exportOptions);
            const fileMap = gltfData.glTFFiles;
            const glbName = Object.keys(fileMap).find(function (k) { return k.endsWith('.glb'); });
            if (!glbName) {
                throw new Error('GLTF2Export did not produce a .glb');
            }

            const arrayBuffer = await fileMap[glbName].arrayBuffer();
            const parsed = parseGLB(arrayBuffer);
            const json = parsed.json;
            let bin = parsed.bin;

            if (captured) {
                // May grow the BIN (re-injected collider meshes), so take
                // the returned buffer.
                bin = injectCapturedExtensions(json, captured, bin) || bin;
            } else {
                injectPhysicsExtensions(json, derived);
            }

            // The __gltfPhysicsSrcNodeIdx tags are an internal staging aid
            // for relinking; strip them from the user's downloaded file.
            // validateRoundTripAsync passes keepSrcNodeTags so the diff can
            // match nodes by source index.
            if (!options.keepSrcNodeTags) {
                stripSrcNodeTags(json);
            }

            const outBuffer = buildGLB(json, bin);
            if (options.download !== false) {
                triggerDownload(outBuffer, baseName + '.glb');
            }
            return outBuffer;
        } finally {
            restore();
        }
    }

    function stripSrcNodeTags(json) {
        (json.nodes || []).forEach(function (node) {
            if (node && node.extras && SRC_NODE_TAG in node.extras) {
                delete node.extras[SRC_NODE_TAG];
                if (Object.keys(node.extras).length === 0) delete node.extras;
            }
        });
    }

    // --- physics data collection (programmatic scenes) ---

    function collectPhysicsData(scene) {
        const shapes = [];
        const materials = [];
        const collisionFilters = [];
        const bodies = new Map(); // mesh name -> node-level KHR_physics_rigid_bodies block

        scene.meshes.forEach(function (mesh) {
            if (!isPhysicsMesh(mesh)) {
                return;
            }
            const body = describeBody(mesh, shapes, materials, collisionFilters, hasPhysicsAncestor(mesh));
            if (body) {
                bodies.set(mesh.name, body);
            }
        });

        const joints = (scene.metadata && scene.metadata[JOINT_REG_KEY]) || [];
        return { shapes, materials, collisionFilters, bodies, joints: joints };
    }

    function describeBody(mesh, shapes, materials, collisionFilters, isCompoundChild) {
        const shapeSpec = describeShape(mesh);
        if (!shapeSpec) {
            console.warn('[GLTFPhysicsExport] Skipping mesh with unsupported physics shape:', mesh.name);
            return null;
        }
        const matIndex = pushUnique(materials, describeMaterial(mesh));

        const geometry = {};
        if (shapeSpec.meshGeometry) {
            // `useMesh` is an internal marker; inject resolves it to the
            // exported node's mesh index (collider.geometry.mesh).
            geometry.useMesh = true;
            if (shapeSpec.convexHull) geometry.convexHull = true;
        } else {
            geometry.shape = pushUnique(shapes, shapeSpec);
        }

        const body = {
            collider: { geometry: geometry, physicsMaterial: matIndex }
        };
        const filterSpec = describeCollisionFilter(mesh);
        if (filterSpec) {
            body.collider.collisionFilter = pushUnique(collisionFilters, filterSpec);
        }
        // A node with a physics ancestor contributes only its collider to the
        // ancestor's compound; emitting motion here would make the loader build
        // a separate, shapeless dynamic body on the child that falls away.
        const mass = readMass(mesh);
        if (mass > 0 && !isCompoundChild) {
            body.motion = { mass: mass };
        }
        // mass === 0 → static, no motion block (matches the eoineoineoin convention)
        return body;
    }

    // Babylon stores collision filters as 32-bit bitmasks on the physics
    // shape. The glTF Physics extension expresses them as named "collision
    // systems" (string layer names) collected in a top-level
    // collisionFilters[] array. Encode each set bit as "System_<bit>" so the
    // exported filters round-trip through the rigid-body loader, which
    // remaps the same names back to bitmasks at load time.
    function describeCollisionFilter(mesh) {
        const shape = getPhysicsShape(mesh);
        if (!shape) return null;
        const membership = shape.filterMembershipMask;
        const collide = shape.filterCollideMask;
        const DEFAULT_ALL = 0xFFFFFFFF;
        const membershipDefault = membership == null || membership === DEFAULT_ALL;
        const collideDefault = collide == null || collide === DEFAULT_ALL;
        if (membershipDefault && collideDefault) return null;
        const filter = {};
        if (!membershipDefault) {
            filter.collisionSystems = bitmaskToSystemNames(membership);
        }
        if (!collideDefault) {
            filter.collideWithSystems = bitmaskToSystemNames(collide);
        }
        return filter;
    }

    function bitmaskToSystemNames(mask) {
        const names = [];
        if (mask == null) return names;
        for (let i = 0; i < 32; i++) {
            if ((mask & (1 << i)) !== 0) {
                names.push('System_' + i);
            }
        }
        return names;
    }

    // Resolve the physics shape from either a PhysicsAggregate stored on the
    // mesh (mesh.aggregate) or directly from its PhysicsBody, so scenes that
    // don't keep an `aggregate` back-reference still export — e.g. a
    // CreateGround floor whose aggregate lives only in a local variable.
    function getPhysicsShape(mesh) {
        return (mesh && mesh.aggregate && mesh.aggregate.shape)
            || (mesh && mesh.physicsBody && mesh.physicsBody.shape)
            || null;
    }

    function describeShape(mesh) {
        const shape = getPhysicsShape(mesh);
        if (!shape) {
            return null;
        }

        // Mesh / convex-hull colliders reference the node's own glTF mesh
        // (collider.geometry.mesh) rather than an implicit shape. The actual
        // mesh index is resolved at inject time from the exported node, so
        // here we only flag the intent.
        if (shape.type === BABYLON.PhysicsShapeType.MESH) {
            return { meshGeometry: true, convexHull: false };
        }
        if (shape.type === BABYLON.PhysicsShapeType.CONVEX_HULL) {
            return { meshGeometry: true, convexHull: true };
        }

        const bb = mesh.getBoundingInfo().boundingBox;
        const extents = bb.extendSize; // half-extents in local space

        switch (shape.type) {
            case BABYLON.PhysicsShapeType.BOX:
                return { type: 'box', box: { size: [extents.x * 2, extents.y * 2, extents.z * 2] } };

            case BABYLON.PhysicsShapeType.SPHERE: {
                const radius = Math.max(extents.x, extents.y, extents.z);
                return { type: 'sphere', sphere: { radius: radius } };
            }

            case BABYLON.PhysicsShapeType.CAPSULE: {
                const radius = Math.max(extents.x, extents.z);
                const height = Math.max(0, extents.y * 2 - radius * 2);
                return { type: 'capsule', capsule: { height: height, radiusBottom: radius, radiusTop: radius } };
            }

            case BABYLON.PhysicsShapeType.CYLINDER: {
                const radius = Math.max(extents.x, extents.z);
                const height = extents.y * 2;
                return { type: 'cylinder', cylinder: { height: height, radiusBottom: radius, radiusTop: radius } };
            }

            default:
                return null;
        }
    }

    function describeMaterial(mesh) {
        const aggregate = mesh.aggregate;
        let friction = 0.5;
        let restitution = 0.0;
        if (aggregate && aggregate.material) {
            if (typeof aggregate.material.friction === 'number') friction = aggregate.material.friction;
            if (typeof aggregate.material.restitution === 'number') restitution = aggregate.material.restitution;
        }
        // The shape's material (reachable via aggregate or PhysicsBody) takes
        // precedence and also covers aggregate-less bodies.
        const shape = getPhysicsShape(mesh);
        if (shape && shape.material) {
            const m = shape.material;
            if (typeof m.friction === 'number') friction = m.friction;
            if (typeof m.restitution === 'number') restitution = m.restitution;
        }
        return {
            staticFriction: friction,
            dynamicFriction: friction,
            restitution: restitution
        };
    }

    function readMass(mesh) {
        const body = mesh.physicsBody;
        if (body && typeof body.getMassProperties === 'function') {
            const mp = body.getMassProperties();
            if (mp && typeof mp.mass === 'number') {
                return mp.mass;
            }
        }
        const aggregate = mesh.aggregate;
        if (aggregate && aggregate._options && typeof aggregate._options.mass === 'number') {
            return aggregate._options.mass;
        }
        return 0;
    }

    function pushUnique(arr, item) {
        const key = JSON.stringify(item);
        for (let i = 0; i < arr.length; i++) {
            if (JSON.stringify(arr[i]) === key) {
                return i;
            }
        }
        arr.push(item);
        return arr.length - 1;
    }

    // --- snapshot apply / restore ---

    function reset(scene) {
        const zero = BABYLON.Vector3.Zero();
        forEachPhysicsNode(scene, function (node) {
            const snap = node.metadata && node.metadata[SNAPSHOT_KEY];
            if (!snap) return;
            const body = node.physicsBody;
            const hadDisablePreStep = body ? body.disablePreStep : null;
            if (body) {
                body.disablePreStep = false;
            }
            node.position.copyFrom(snap.position);
            if (snap.rotationQuaternion) {
                node.rotationQuaternion = snap.rotationQuaternion.clone();
            } else if (snap.rotation) {
                node.rotationQuaternion = null;
                node.rotation.copyFrom(snap.rotation);
            }
            if (node.computeWorldMatrix) node.computeWorldMatrix(true);
            if (body) {
                try {
                    if (typeof body.setLinearVelocity === 'function') body.setLinearVelocity(zero);
                    if (typeof body.setAngularVelocity === 'function') body.setAngularVelocity(zero);
                } catch (err) {
                    console.warn('[GLTFPhysicsExport] reset velocity failed for', node.name, err);
                }
                scene.onAfterRenderObservable.addOnce(function () {
                    body.disablePreStep = hadDisablePreStep == null ? true : hadDisablePreStep;
                });
            }
        });
    }

    function applySnapshots(scene) {
        const restore = [];
        forEachPhysicsNode(scene, function (node) {
            const snap = node.metadata && node.metadata[SNAPSHOT_KEY];
            if (!snap) return;
            restore.push({
                node: node,
                position: node.position.clone(),
                rotation: node.rotation ? node.rotation.clone() : null,
                rotationQuaternion: node.rotationQuaternion ? node.rotationQuaternion.clone() : null
            });
            node.position.copyFrom(snap.position);
            if (snap.rotationQuaternion) {
                node.rotationQuaternion = snap.rotationQuaternion.clone();
            } else if (snap.rotation) {
                node.rotationQuaternion = null;
                node.rotation.copyFrom(snap.rotation);
            }
            if (node.computeWorldMatrix) node.computeWorldMatrix(true);
        });
        return function () {
            restore.forEach(function (r) {
                r.node.position.copyFrom(r.position);
                if (r.rotationQuaternion) {
                    r.node.rotationQuaternion = r.rotationQuaternion;
                } else if (r.rotation) {
                    r.node.rotationQuaternion = null;
                    r.node.rotation.copyFrom(r.rotation);
                }
                if (r.node.computeWorldMatrix) r.node.computeWorldMatrix(true);
            });
        };
    }

    // --- glTF JSON injection (programmatic scenes) ---

    function injectPhysicsExtensions(json, data) {
        const used = new Set(json.extensionsUsed || []);
        used.add('KHR_implicit_shapes');
        used.add('KHR_physics_rigid_bodies');
        json.extensionsUsed = Array.from(used);

        json.extensions = json.extensions || {};
        json.extensions.KHR_implicit_shapes = { shapes: data.shapes };

        // Emit the top-level reference arrays. collisionFilters MUST be
        // written whenever any collider carries a collisionFilter index:
        // the rigid-body loader does `collisionFilters[collider.collisionFilter]`
        // and a collisionFilter of 0 (a valid index) still passes its
        // `!= null` guard, so a missing array throws
        // "Cannot read properties of undefined (reading '0')" on load.
        const rigid = {};
        if (data.materials && data.materials.length) {
            rigid.physicsMaterials = data.materials;
        }
        if (data.collisionFilters && data.collisionFilters.length) {
            rigid.collisionFilters = data.collisionFilters;
        }
        json.extensions.KHR_physics_rigid_bodies = rigid;

        if (!Array.isArray(json.nodes)) {
            return;
        }
        json.nodes.forEach(function (node) {
            const body = data.bodies.get(node.name);
            if (!body) {
                return;
            }
            // Clone so a second export doesn't see a mesh-resolved body.
            const cloned = JSON.parse(JSON.stringify(body));
            const geo = cloned.collider && cloned.collider.geometry;
            if (geo && geo.useMesh) {
                // A mesh / convex-hull collider references the node's own glTF
                // mesh. The exported node carries its render mesh index here.
                if (typeof node.mesh === 'number') {
                    geo.mesh = node.mesh;
                } else {
                    console.warn('[GLTFPhysicsExport] mesh-shape collider on a node without a mesh:', node.name);
                }
                delete geo.useMesh;
            }
            node.extensions = node.extensions || {};
            node.extensions.KHR_physics_rigid_bodies = cloned;
        });

        injectJoints(json, data.joints);
    }

    // --- programmatic joint export (registered via registerJoint) ---
    //
    // Babylon exposes no API to enumerate a scene's constraints, so the app
    // registers each joint it wants exported with
    // GLTFPhysicsExport.registerJoint(scene, spec). At export time each
    // registration becomes a glTF physics joint: a top-level physicsJoints[]
    // entry (limits + drives) plus a pair of anchor frame nodes
    // (jointSpaceA / jointSpaceB) parented under the two bodies, with the
    // `joint` block on the first anchor — the same shape the upstream
    // JointTypes samples use, so the rigid-body loader rebuilds the
    // constraint AND its motor on load.
    //
    // spec = {
    //   bodyA, bodyB,                 // the two rigid-body meshes (matched by name)
    //   pivotA, pivotB,               // Vector3 attach points in each body's local space
    //   axisA, axisB,                 // Vector3 hinge axis in each body's local space (default +X)
    //   type: 'hinge' | '6dof',       // default 'hinge'
    //   motor: {                      // optional, drives the free axis
    //     targetVelocity, targetPosition, maxForce, damping, stiffness, mode
    //   },
    //   limits, drives,               // advanced: glTF-form arrays for type '6dof'
    //   enableCollision               // default false
    // }
    function registerJoint(scene, spec) {
        if (!scene || !spec || !spec.bodyA || !spec.bodyB) {
            console.warn('[GLTFPhysicsExport] registerJoint: spec needs bodyA and bodyB');
            return;
        }
        scene.metadata = scene.metadata || {};
        const list = scene.metadata[JOINT_REG_KEY] || (scene.metadata[JOINT_REG_KEY] = []);
        list.push(spec);
    }

    // Rotation mapping local +X onto the given axis, so an anchor's local X
    // becomes the joint's primary (free / motorised) axis. Null = no rotation.
    function quatFromXAxis(axisVec) {
        const X = new BABYLON.Vector3(1, 0, 0);
        const t = (axisVec || X).clone();
        if (t.lengthSquared() < 1e-12) return null;
        t.normalize();
        const d = BABYLON.Vector3.Dot(X, t);
        if (d > 0.999999) return null;                       // already aligned with +X
        if (d < -0.999999) return BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(0, 1, 0), Math.PI);
        const axis = BABYLON.Vector3.Cross(X, t);
        axis.normalize();
        return BABYLON.Quaternion.RotationAxis(axis, Math.acos(d));
    }

    function appendAnchorNode(json, name, pivot, axisVec, parentNode) {
        const node = { name: name };
        if (pivot) node.translation = [pivot.x, pivot.y, pivot.z];
        const q = quatFromXAxis(axisVec);
        if (q) node.rotation = [q.x, q.y, q.z, q.w];
        const index = json.nodes.length;
        json.nodes.push(node);
        parentNode.children = parentNode.children || [];
        parentNode.children.push(index);
        return index;
    }

    function buildJointDefinition(reg) {
        // Advanced: caller supplied glTF-form limits / drives directly.
        if (reg.limits || reg.drives) {
            const def = { limits: reg.limits || [] };
            if (reg.drives) def.drives = reg.drives;
            return def;
        }
        // Default 'hinge': the free axis is angular X (index 0) — the anchor's
        // local X, which appendAnchorNode aligns to axisA/axisB. Lock all
        // linear axes plus angular Y/Z.
        const def = {
            limits: [
                { linearAxes: [0], min: 0, max: 0 },
                { linearAxes: [1], min: 0, max: 0 },
                { linearAxes: [2], min: 0, max: 0 },
                { angularAxes: [1], min: 0, max: 0 },
                { angularAxes: [2], min: 0, max: 0 }
            ]
        };
        if (reg.motor) {
            const m = reg.motor;
            // The loader applies drives as spring motors: velocityTarget+damping
            // gives a velocity motor, positionTarget+stiffness a position motor.
            const drive = {
                type: 'angular',
                mode: m.mode === 'force' ? 'force' : 'acceleration',
                axis: 0,
                positionTarget: typeof m.targetPosition === 'number' ? m.targetPosition : 0,
                velocityTarget: typeof m.targetVelocity === 'number' ? m.targetVelocity : 0,
                stiffness: typeof m.stiffness === 'number' ? m.stiffness : 0,
                damping: typeof m.damping === 'number' ? m.damping : 100
            };
            if (typeof m.maxForce === 'number') drive.maxForce = m.maxForce;
            def.drives = [drive];
        }
        return def;
    }

    function injectJoints(json, jointRegs) {
        if (!Array.isArray(jointRegs) || jointRegs.length === 0) return;
        if (!Array.isArray(json.nodes)) return;

        json.extensions = json.extensions || {};
        const rigid = json.extensions.KHR_physics_rigid_bodies =
            json.extensions.KHR_physics_rigid_bodies || {};
        const physicsJoints = rigid.physicsJoints || (rigid.physicsJoints = []);

        const nodeByName = new Map();
        json.nodes.forEach(function (n, i) {
            if (n && n.name && !nodeByName.has(n.name)) nodeByName.set(n.name, i);
        });

        jointRegs.forEach(function (reg) {
            const nameA = reg.bodyA && reg.bodyA.name;
            const nameB = reg.bodyB && reg.bodyB.name;
            const aIdx = nodeByName.get(nameA);
            const bIdx = nodeByName.get(nameB);
            if (typeof aIdx !== 'number' || typeof bIdx !== 'number') {
                console.warn('[GLTFPhysicsExport] registerJoint: could not resolve bodies', nameA, nameB);
                return;
            }
            const jointIdx = physicsJoints.length;
            physicsJoints.push(buildJointDefinition(reg));

            const anchorAIdx = appendAnchorNode(json, '__jointSpaceA_' + jointIdx, reg.pivotA, reg.axisA, json.nodes[aIdx]);
            const anchorBIdx = appendAnchorNode(json, '__jointSpaceB_' + jointIdx, reg.pivotB, reg.axisB, json.nodes[bIdx]);

            json.nodes[anchorAIdx].extensions = {
                KHR_physics_rigid_bodies: {
                    joint: {
                        connectedNode: anchorBIdx,
                        joint: jointIdx,
                        enableCollision: !!reg.enableCollision
                    }
                }
            };
        });
    }

    // --- glTF JSON injection (captured / loaded scenes) ---

    function injectCapturedExtensions(json, captured, bin) {
        let workingBin = bin;
        const used = new Set(json.extensionsUsed || []);
        used.add('KHR_implicit_shapes');
        used.add('KHR_physics_rigid_bodies');
        json.extensionsUsed = Array.from(used);

        json.extensions = json.extensions || {};
        json.extensions.KHR_implicit_shapes = {
            shapes: JSON.parse(JSON.stringify(captured.shapes))
        };

        const rigid = {};
        if (captured.physicsMaterials.length) {
            rigid.physicsMaterials = JSON.parse(JSON.stringify(captured.physicsMaterials));
        }
        if (captured.collisionFilters.length) {
            rigid.collisionFilters = JSON.parse(JSON.stringify(captured.collisionFilters));
        }
        if (captured.physicsJoints.length) {
            rigid.physicsJoints = JSON.parse(JSON.stringify(captured.physicsJoints));
        }
        json.extensions.KHR_physics_rigid_bodies = rigid;

        if (!Array.isArray(json.nodes)) {
            return workingBin;
        }

        // PRIMARY mapping: source node index -> exported node index, read
        // from the `__gltfPhysicsSrcNodeIdx` extras we planted on every
        // Babylon node during capture. This survives nameless or
        // duplicate-named nodes that name-based lookup can't disambiguate.
        const srcNodeToExportedIdx = new Map();
        json.nodes.forEach(function (node, i) {
            const srcIdx = node && node.extras && node.extras[SRC_NODE_TAG];
            if (typeof srcIdx === 'number') srcNodeToExportedIdx.set(srcIdx, i);
        });

        // FALLBACK mapping: `name#occurrence` -> exported index. Used
        // when the extras tag is missing (e.g. nodes Babylon added
        // during serialization).
        const nodeKeyToIndex = new Map();
        const nodeOccCounts = new Map();
        json.nodes.forEach(function (node, i) {
            if (!node || !node.name) return;
            const occ = nodeOccCounts.get(node.name) || 0;
            nodeOccCounts.set(node.name, occ + 1);
            nodeKeyToIndex.set(node.name + '#' + occ, i);
        });
        const meshKeyToIndex = new Map();
        const meshOccCounts = new Map();
        (json.meshes || []).forEach(function (mesh, i) {
            if (!mesh || !mesh.name) return;
            const occ = meshOccCounts.get(mesh.name) || 0;
            meshOccCounts.set(mesh.name, occ + 1);
            meshKeyToIndex.set(mesh.name + '#' + occ, i);
        });

        // Source-mesh -> exported-mesh, derived from owner-node mapping.
        // For each source node that carried a mesh, look up the matching
        // exported node by srcNodeIdx and read its `mesh` field — that
        // gives us a reliable srcMeshIdx -> exportedMeshIdx without
        // depending on mesh names (Babylon usually drops them).
        const srcMeshToExportedIdx = new Map();
        (captured.srcMeshOwners || []).forEach(function (owner) {
            const expIdx = srcNodeToExportedIdx.get(owner.srcNodeIdx);
            if (typeof expIdx !== 'number') return;
            const expNode = json.nodes[expIdx];
            if (expNode && typeof expNode.mesh === 'number') {
                srcMeshToExportedIdx.set(owner.srcMeshIdx, expNode.mesh);
            }
        });

        // Re-inject collider/trigger meshes that Babylon dropped. Collect
        // every source mesh referenced by a captured collider/trigger, and
        // for those the owner-node mapping above could NOT resolve (the
        // mesh isn't present on any exported node — collision-only meshes,
        // or skinned-mesh owners whose mesh ref Babylon moved), append the
        // captured geometry to the exported glTF + BIN and map srcMesh ->
        // the new mesh index.
        if (captured.colliderMeshBundle) {
            // Always re-inject the exact source geometry for EVERY collider /
            // trigger mesh rather than reusing Babylon's exported render
            // meshes. Babylon splits multi-primitive meshes (so owner-node
            // resolution would hand the collider only the first primitive —
            // e.g. WaterWheel's 2-primitive track ramp, Robot's 2-primitive
            // head) and disposes collision-only meshes entirely. Re-injecting
            // guarantees complete, exact collision shapes; the cost is a
            // little duplicated geometry, which is invisible (physics only).
            const allColliderMeshes = new Set();
            (captured.perNode || []).forEach(function (entry) {
                [entry.block.collider, entry.block.trigger].forEach(function (c) {
                    if (c && c.geometry && typeof c.geometry.meshSrcIdx === 'number') {
                        allColliderMeshes.add(c.geometry.meshSrcIdx);
                    }
                });
            });
            if (allColliderMeshes.size > 0) {
                const res = injectColliderMeshes(json, workingBin, captured.colliderMeshBundle, allColliderMeshes);
                workingBin = res.bin;
                res.srcMeshToExportedMesh.forEach(function (expIdx, srcIdx) {
                    srcMeshToExportedIdx.set(srcIdx, expIdx);
                });
            }
        }

        const resolveCtx = {
            srcNodeToExportedIdx: srcNodeToExportedIdx,
            srcMeshToExportedIdx: srcMeshToExportedIdx,
            nodeKeyToIndex: nodeKeyToIndex,
            meshKeyToIndex: meshKeyToIndex,
            jsonNodes: json.nodes
        };

        // Emit each captured per-node block onto the matching exported
        // node. PRIMARY lookup uses srcIdx via the extras tag (handles
        // nameless / duplicate-named nodes); FALLBACK uses name +
        // occurrence.
        const perNode = Array.isArray(captured.perNode) ? captured.perNode : null;
        if (perNode) {
            perNode.forEach(function (entry) {
                let exportedIdx;
                if (typeof entry.srcIdx === 'number') {
                    exportedIdx = srcNodeToExportedIdx.get(entry.srcIdx);
                }
                if (typeof exportedIdx !== 'number' && entry.name) {
                    exportedIdx = nodeKeyToIndex.get(entry.name + '#' + (entry.occurrence || 0));
                }
                if (typeof exportedIdx !== 'number') return;
                const targetNode = json.nodes[exportedIdx];
                if (!targetNode) return;
                const cloned = JSON.parse(JSON.stringify(entry.block));
                namesToIndexRefs(cloned, resolveCtx);
                targetNode.extensions = targetNode.extensions || {};
                targetNode.extensions.KHR_physics_rigid_bodies = cloned;
            });
        } else {
            // Fallback for captured payloads built before perNode existed.
            json.nodes.forEach(function (node) {
                if (!node || !node.name) return;
                const block = captured.byName && captured.byName.get(node.name);
                if (!block) return;
                const cloned = JSON.parse(JSON.stringify(block));
                namesToIndexRefs(cloned, resolveCtx);
                node.extensions = node.extensions || {};
                node.extensions.KHR_physics_rigid_bodies = cloned;
            });
        }

        return workingBin;
    }

    // Append the geometry for the requested source meshes (from the
    // capture-time bundle) to the exported glTF and its BIN. Returns the
    // grown BIN plus a srcMeshIdx -> exported mesh index map. Only the
    // bufferViews / accessors actually used by the requested meshes are
    // emitted, each appended to the buffer at a 4-byte aligned offset.
    function injectColliderMeshes(json, bin, bundle, neededSrcMeshSet) {
        json.buffers = json.buffers || [];
        if (json.buffers.length === 0) json.buffers.push({ byteLength: 0 });
        json.bufferViews = json.bufferViews || [];
        json.accessors = json.accessors || [];
        json.meshes = json.meshes || [];

        let curBin = bin || new Uint8Array(0);
        const appended = [];
        let writeOffset = curBin.byteLength;

        const bvLocalToExported = new Map();
        const accLocalToExported = new Map();
        const srcMeshToExportedMesh = new Map();

        function ensureBufferView(localIdx) {
            if (bvLocalToExported.has(localIdx)) return bvLocalToExported.get(localIdx);
            const localBv = bundle.bufferViews[localIdx];
            const slice = bundle.binaryParts[localIdx];
            const pad = (4 - (writeOffset % 4)) % 4;
            if (pad) { appended.push(new Uint8Array(pad)); writeOffset += pad; }
            const byteOffset = writeOffset;
            appended.push(slice);
            writeOffset += slice.byteLength;
            const expBv = { buffer: 0, byteOffset: byteOffset, byteLength: localBv.byteLength };
            if (localBv.byteStride != null) expBv.byteStride = localBv.byteStride;
            if (localBv.target != null) expBv.target = localBv.target;
            const expIdx = json.bufferViews.length;
            json.bufferViews.push(expBv);
            bvLocalToExported.set(localIdx, expIdx);
            return expIdx;
        }
        function ensureAccessor(localIdx) {
            if (accLocalToExported.has(localIdx)) return accLocalToExported.get(localIdx);
            const localAcc = bundle.accessors[localIdx];
            const expAcc = JSON.parse(JSON.stringify(localAcc));
            if (typeof localAcc.bufferView === 'number') {
                expAcc.bufferView = ensureBufferView(localAcc.bufferView);
            }
            const expIdx = json.accessors.length;
            json.accessors.push(expAcc);
            accLocalToExported.set(localIdx, expIdx);
            return expIdx;
        }

        neededSrcMeshSet.forEach(function (srcMeshIdx) {
            const localMeshIdx = bundle.bySrcMesh[srcMeshIdx];
            if (localMeshIdx == null) return;
            const localMesh = bundle.meshes[localMeshIdx];
            const expMesh = { primitives: [] };
            if (localMesh.name) expMesh.name = localMesh.name;
            (localMesh.primitives || []).forEach(function (prim) {
                const expPrim = {};
                if (prim.attributes) {
                    expPrim.attributes = {};
                    Object.keys(prim.attributes).forEach(function (attr) {
                        expPrim.attributes[attr] = ensureAccessor(prim.attributes[attr]);
                    });
                }
                if (typeof prim.indices === 'number') {
                    expPrim.indices = ensureAccessor(prim.indices);
                }
                if (prim.mode != null) expPrim.mode = prim.mode;
                expMesh.primitives.push(expPrim);
            });
            const expMeshIdx = json.meshes.length;
            json.meshes.push(expMesh);
            srcMeshToExportedMesh.set(srcMeshIdx, expMeshIdx);
        });

        if (appended.length > 0) {
            const newBin = new Uint8Array(writeOffset);
            newBin.set(curBin, 0);
            let p = curBin.byteLength;
            appended.forEach(function (part) {
                newBin.set(part, p);
                p += part.byteLength;
            });
            curBin = newBin;
        }
        json.buffers[0].byteLength = curBin.byteLength;

        return { bin: curBin, srcMeshToExportedMesh: srcMeshToExportedMesh };
    }

    // Mapping for resource references inside a KHR_physics_rigid_bodies block.
    // Capture stores names; export resolves them back to whatever indices the
    // re-serialized glTF assigns (Babylon's GLTF2Export renumbers nodes /
    // meshes / accessors). This is what keeps the mesh-collision floor in
    // ShapeTypes pointing at the same Plane mesh after a round-trip instead of
    // dangling at the original index.

    // Count how many times `name` has appeared in `nodes[0..targetIdx-1]`.
    // Used to identify which "Nth occurrence" of a duplicate name we mean,
    // so cross-references survive samples that reuse `jointSpaceA` /
    // `jointSpaceB` for every anchor.
    function occurrenceOfNameAt(nodes, targetIdx, name) {
        let occ = 0;
        for (let k = 0; k < targetIdx; k++) {
            if (nodes[k] && nodes[k].name === name) occ++;
        }
        return occ;
    }

    function indexRefsToNames(block, nodes, meshes) {
        if (block.joint && typeof block.joint.connectedNode === 'number') {
            const connectedIdx = block.joint.connectedNode;
            const connected = nodes[connectedIdx];
            block.joint.connectedNodeSrcIdx = connectedIdx;
            if (connected) {
                block.joint.connectedNodeName = connected.name || null;
                if (connected.name) {
                    block.joint.connectedNodeOccurrence = occurrenceOfNameAt(nodes, connectedIdx, connected.name);
                }
            } else {
                block.joint.connectedNodeName = null;
            }
            delete block.joint.connectedNode;
        }
        geometryIndexRefsToNames(block.collider && block.collider.geometry, nodes, meshes);
        geometryIndexRefsToNames(block.trigger && block.trigger.geometry, nodes, meshes);
    }

    function geometryIndexRefsToNames(geometry, nodes, meshes) {
        if (!geometry) return;
        if (typeof geometry.mesh === 'number') {
            const meshIdx = geometry.mesh;
            const mesh = meshes[meshIdx];
            geometry.meshSrcIdx = meshIdx;
            geometry.meshName = mesh ? (mesh.name || null) : null;
            // Babylon's GLTF2Export drops mesh names but preserves node names, so
            // also stash the source index AND name of any node that owns this
            // mesh — at export time we look the node up (via extras-tag or name
            // fallback) and read its renumbered mesh index.
            const ownerIdx = nodes.findIndex(function (n) { return n && n.mesh === meshIdx; });
            if (ownerIdx >= 0) {
                const owner = nodes[ownerIdx];
                geometry.meshOwnerSrcNodeIdx = ownerIdx;
                geometry.meshOwnerNodeName = owner.name || null;
                if (owner.name) {
                    geometry.meshOwnerNodeOccurrence = occurrenceOfNameAt(nodes, ownerIdx, owner.name);
                }
            } else {
                geometry.meshOwnerNodeName = null;
            }
            delete geometry.mesh;
        }
        if (typeof geometry.node === 'number') {
            const nodeIdx = geometry.node;
            const node = nodes[nodeIdx];
            geometry.nodeSrcIdx = nodeIdx;
            if (node) {
                geometry.nodeName = node.name || null;
                if (node.name) {
                    geometry.nodeOccurrence = occurrenceOfNameAt(nodes, nodeIdx, node.name);
                }
            } else {
                geometry.nodeName = null;
            }
            delete geometry.node;
        }
    }

    function nodeIndexFromNameOcc(nodeKeyToIndex, name, occurrence) {
        if (name == null) return undefined;
        const occ = typeof occurrence === 'number' ? occurrence : 0;
        const idx = nodeKeyToIndex.get(name + '#' + occ);
        if (typeof idx === 'number') return idx;
        // Fall back to first occurrence in case the upstream payload was
        // captured before occurrence tracking landed.
        return nodeKeyToIndex.get(name + '#0');
    }

    function meshIndexFromNameOcc(meshKeyToIndex, name, occurrence) {
        if (name == null) return undefined;
        const occ = typeof occurrence === 'number' ? occurrence : 0;
        const idx = meshKeyToIndex.get(name + '#' + occ);
        if (typeof idx === 'number') return idx;
        return meshKeyToIndex.get(name + '#0');
    }

    function namesToIndexRefs(block, ctx) {
        if (block.joint && (block.joint.connectedNodeSrcIdx != null || block.joint.connectedNodeName != null)) {
            let idx;
            if (typeof block.joint.connectedNodeSrcIdx === 'number') {
                idx = ctx.srcNodeToExportedIdx.get(block.joint.connectedNodeSrcIdx);
            }
            if (typeof idx !== 'number' && block.joint.connectedNodeName != null) {
                idx = nodeIndexFromNameOcc(ctx.nodeKeyToIndex, block.joint.connectedNodeName, block.joint.connectedNodeOccurrence);
            }
            if (typeof idx === 'number') block.joint.connectedNode = idx;
            delete block.joint.connectedNodeSrcIdx;
            delete block.joint.connectedNodeName;
            delete block.joint.connectedNodeOccurrence;
        }
        geometryNamesToIndexRefs(block.collider && block.collider.geometry, ctx);
        geometryNamesToIndexRefs(block.trigger && block.trigger.geometry, ctx);
    }

    function geometryNamesToIndexRefs(geometry, ctx) {
        if (!geometry) return;
        if (geometry.meshSrcIdx != null || geometry.meshName != null || geometry.meshOwnerSrcNodeIdx != null || geometry.meshOwnerNodeName != null) {
            let idx;
            // 1) srcMeshIdx via owner-node extras tag.
            if (typeof geometry.meshSrcIdx === 'number') {
                idx = ctx.srcMeshToExportedIdx.get(geometry.meshSrcIdx);
            }
            // 2) Owner srcNodeIdx -> exported node -> its mesh field.
            if (typeof idx !== 'number' && typeof geometry.meshOwnerSrcNodeIdx === 'number') {
                const ownerExportedIdx = ctx.srcNodeToExportedIdx.get(geometry.meshOwnerSrcNodeIdx);
                if (typeof ownerExportedIdx === 'number') {
                    const ownerNode = ctx.jsonNodes[ownerExportedIdx];
                    if (ownerNode && typeof ownerNode.mesh === 'number') idx = ownerNode.mesh;
                }
            }
            // 3) Mesh name fallback (Babylon often drops these but try anyway).
            if (typeof idx !== 'number' && geometry.meshName != null) {
                idx = meshIndexFromNameOcc(ctx.meshKeyToIndex, geometry.meshName, 0);
            }
            // 4) Owner name fallback.
            if (typeof idx !== 'number' && geometry.meshOwnerNodeName != null) {
                const ownerIdx = nodeIndexFromNameOcc(ctx.nodeKeyToIndex, geometry.meshOwnerNodeName, geometry.meshOwnerNodeOccurrence);
                if (typeof ownerIdx === 'number') {
                    const ownerNode = ctx.jsonNodes[ownerIdx];
                    if (ownerNode && typeof ownerNode.mesh === 'number') idx = ownerNode.mesh;
                }
            }
            if (typeof idx === 'number') {
                geometry.mesh = idx;
            } else {
                console.warn('[GLTFPhysicsExport] Could not resolve collider mesh ref:',
                    'srcMeshIdx=', geometry.meshSrcIdx,
                    'meshName=', geometry.meshName,
                    'ownerSrcIdx=', geometry.meshOwnerSrcNodeIdx,
                    'ownerName=', geometry.meshOwnerNodeName);
            }
            delete geometry.meshSrcIdx;
            delete geometry.meshName;
            delete geometry.meshOwnerSrcNodeIdx;
            delete geometry.meshOwnerNodeName;
            delete geometry.meshOwnerNodeOccurrence;
        }
        if (geometry.nodeSrcIdx != null || geometry.nodeName != null) {
            let idx;
            if (typeof geometry.nodeSrcIdx === 'number') {
                idx = ctx.srcNodeToExportedIdx.get(geometry.nodeSrcIdx);
            }
            if (typeof idx !== 'number' && geometry.nodeName != null) {
                idx = nodeIndexFromNameOcc(ctx.nodeKeyToIndex, geometry.nodeName, geometry.nodeOccurrence);
            }
            if (typeof idx === 'number') {
                geometry.node = idx;
            } else {
                console.warn('[GLTFPhysicsExport] No exported node matches captured ref:', geometry.nodeName, geometry.nodeSrcIdx);
            }
            delete geometry.nodeSrcIdx;
            delete geometry.nodeName;
            delete geometry.nodeOccurrence;
        }
    }

    // --- GLB pack / unpack ---

    function parseGLB(arrayBuffer) {
        const dv = new DataView(arrayBuffer);
        if (dv.getUint32(0, true) !== GLB_MAGIC) {
            throw new Error('Not a GLB');
        }
        const totalLength = dv.getUint32(8, true);

        let cursor = 12;
        let json = null;
        let bin = null;

        while (cursor < totalLength) {
            const chunkLength = dv.getUint32(cursor, true);
            const chunkType   = dv.getUint32(cursor + 4, true);
            const dataStart   = cursor + 8;

            if (chunkType === CHUNK_JSON) {
                const bytes = new Uint8Array(arrayBuffer, dataStart, chunkLength);
                json = JSON.parse(new TextDecoder().decode(bytes));
            } else if (chunkType === CHUNK_BIN) {
                // Copy so we don't depend on the source ArrayBuffer staying alive.
                bin = new Uint8Array(arrayBuffer, dataStart, chunkLength).slice();
            }
            cursor = dataStart + chunkLength;
        }

        if (!json) {
            throw new Error('GLB has no JSON chunk');
        }
        return { json, bin };
    }

    function buildGLB(json, bin) {
        const jsonText = JSON.stringify(json);
        const jsonBytes = new TextEncoder().encode(jsonText);
        const jsonPadded = padTo4(jsonBytes, 0x20); // ASCII space

        let binPadded = null;
        if (bin && bin.byteLength > 0) {
            binPadded = padTo4(bin, 0x00);
        }

        const headerSize = 12;
        const jsonChunkSize = 8 + jsonPadded.byteLength;
        const binChunkSize = binPadded ? 8 + binPadded.byteLength : 0;
        const totalSize = headerSize + jsonChunkSize + binChunkSize;

        const out = new ArrayBuffer(totalSize);
        const dv = new DataView(out);
        const u8 = new Uint8Array(out);

        dv.setUint32(0, GLB_MAGIC, true);
        dv.setUint32(4, GLB_VERSION, true);
        dv.setUint32(8, totalSize, true);

        dv.setUint32(12, jsonPadded.byteLength, true);
        dv.setUint32(16, CHUNK_JSON, true);
        u8.set(jsonPadded, 20);

        if (binPadded) {
            const binStart = 20 + jsonPadded.byteLength;
            dv.setUint32(binStart, binPadded.byteLength, true);
            dv.setUint32(binStart + 4, CHUNK_BIN, true);
            u8.set(binPadded, binStart + 8);
        }

        return out;
    }

    function padTo4(bytes, fill) {
        const remainder = bytes.byteLength % 4;
        if (remainder === 0) {
            return bytes;
        }
        const pad = 4 - remainder;
        const padded = new Uint8Array(bytes.byteLength + pad);
        padded.set(bytes, 0);
        padded.fill(fill, bytes.byteLength);
        return padded;
    }

    function triggerDownload(arrayBuffer, filename) {
        const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    // --- round-trip validation ---

    async function validateRoundTripAsync(scene, sourceUrl) {
        const sourceJson = await fetchSourceJson(sourceUrl);

        const outBuffer = await GLBAsync(scene, 'roundtrip-validation', { download: false, keepSrcNodeTags: true });
        const exportedJson = parseGLB(outBuffer).json;

        const sourceNorm = normalizePhysicsJson(sourceJson);
        const exportedNorm = normalizePhysicsJson(exportedJson);

        const diffs = [];
        diffArray('shapes', sourceNorm.shapes, exportedNorm.shapes, diffs);
        diffArray('physicsMaterials', sourceNorm.physicsMaterials, exportedNorm.physicsMaterials, diffs);
        diffArray('collisionFilters', sourceNorm.collisionFilters, exportedNorm.collisionFilters, diffs);
        diffArray('physicsJoints', sourceNorm.physicsJoints, exportedNorm.physicsJoints, diffs);
        diffPerNode(sourceNorm.perNode, exportedNorm.perNode, diffs);

        return { pass: diffs.length === 0, diffs: diffs };
    }

    function normalizePhysicsJson(json) {
        const implicit = (json.extensions && json.extensions.KHR_implicit_shapes) || {};
        const rigid = (json.extensions && json.extensions.KHR_physics_rigid_bodies) || {};
        const nodes = json.nodes || [];
        const meshes = json.meshes || [];

        // Key per-node entries by `srcIdx:<n>` so nameless and
        // duplicate-named nodes survive the diff. On the source side
        // we use the node's own position in `json.nodes`; on the
        // exported side we read `node.extras.__gltfPhysicsSrcNodeIdx`
        // planted during capture, which equals that source position —
        // so source and export end up with the same key.
        const perNode = new Map();
        nodes.forEach(function (n, i) {
            const ext = n && n.extensions && n.extensions.KHR_physics_rigid_bodies;
            if (!ext) return;
            const cloned = JSON.parse(JSON.stringify(ext));
            canonicalizeRefsForDiff(cloned, nodes, meshes);
            const tagged = n.extras && n.extras[SRC_NODE_TAG];
            const srcIdx = typeof tagged === 'number' ? tagged : i;
            perNode.set('srcIdx:' + srcIdx, cloned);
        });

        return {
            shapes: implicit.shapes || [],
            physicsMaterials: rigid.physicsMaterials || [],
            collisionFilters: rigid.collisionFilters || [],
            physicsJoints: rigid.physicsJoints || [],
            perNode: perNode
        };
    }

    // Resolve every cross-reference inside a per-node block to a CANONICAL
    // source-node index so source and exported compare equal regardless of
    // Babylon renumbering nodes, reordering same-named siblings, or
    // auto-naming previously-nameless nodes. Source nodes use their own
    // position; exported nodes carry the original position in
    // node.extras.__gltfPhysicsSrcNodeIdx. Mesh references are canonicalized
    // through the owning node's source index (a collision-only mesh with no
    // owner stays null on the source side and is simply absent on the
    // exported side, surfacing the real "mesh dropped on export"
    // limitation).
    function canonicalizeRefsForDiff(block, nodes, meshes) {
        if (block.joint && typeof block.joint.connectedNode === 'number') {
            block.joint.connectedNodeCanonical = canonicalNodeId(nodes, block.joint.connectedNode);
            delete block.joint.connectedNode;
        }
        canonicalizeGeometryRefsForDiff(block.collider && block.collider.geometry, nodes);
        canonicalizeGeometryRefsForDiff(block.trigger && block.trigger.geometry, nodes);
    }

    function canonicalNodeId(nodes, idx) {
        const node = nodes[idx];
        if (!node) return null;
        if (node.extras && typeof node.extras[SRC_NODE_TAG] === 'number') {
            return node.extras[SRC_NODE_TAG];
        }
        return idx;
    }

    function canonicalizeGeometryRefsForDiff(geometry, nodes) {
        if (!geometry) return;
        if (typeof geometry.node === 'number') {
            geometry.nodeCanonical = canonicalNodeId(nodes, geometry.node);
            delete geometry.node;
        }
        if (typeof geometry.mesh === 'number') {
            // Compare mesh references by PRESENCE, not identity. The exact
            // mesh geometry is preserved by the exporter (owner-node
            // resolution or re-injection of the captured geometry), but the
            // mesh INDEX and its owning node differ between source and
            // export — and a re-injected collision mesh has no owner at all.
            // Presence keeps a dropped collider (no mesh on export) failing
            // while a correctly round-tripped one passes.
            geometry.meshPresent = true;
            delete geometry.mesh;
        }
    }

    function diffArray(label, a, b, diffs) {
        if (a.length !== b.length) {
            diffs.push({ path: label, reason: 'length ' + a.length + ' vs ' + b.length });
            return;
        }
        for (let i = 0; i < a.length; i++) {
            const r = deepDiff(a[i], b[i], '');
            if (r) diffs.push({ path: label + '[' + i + ']', reason: r });
        }
    }

    function diffPerNode(srcMap, expMap, diffs) {
        const names = new Set();
        srcMap.forEach(function (_v, k) { names.add(k); });
        expMap.forEach(function (_v, k) { names.add(k); });
        names.forEach(function (name) {
            const s = srcMap.get(name);
            const e = expMap.get(name);
            if (!s) { diffs.push({ path: 'nodes["' + name + '"]', reason: 'extra in export' }); return; }
            if (!e) { diffs.push({ path: 'nodes["' + name + '"]', reason: 'missing in export' }); return; }
            const r = deepDiff(s, e, '');
            if (r) diffs.push({ path: 'nodes["' + name + '"]', reason: r });
        });
    }

    const FLOAT_EPS = 1e-4;

    function deepDiff(a, b, path) {
        if (typeof a === 'number' && typeof b === 'number') {
            if (Math.abs(a - b) > FLOAT_EPS) return path + ': ' + a + ' vs ' + b;
            return null;
        }
        if (a === null || b === null || a === undefined || b === undefined) {
            if (a !== b) return path + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
            return null;
        }
        if (typeof a !== typeof b) {
            return path + ': ' + typeof a + ' vs ' + typeof b;
        }
        if (Array.isArray(a) || Array.isArray(b)) {
            if (!Array.isArray(a) || !Array.isArray(b)) return path + ': array vs non-array';
            if (a.length !== b.length) return path + ': array length ' + a.length + ' vs ' + b.length;
            for (let i = 0; i < a.length; i++) {
                const r = deepDiff(a[i], b[i], path + '[' + i + ']');
                if (r) return r;
            }
            return null;
        }
        if (typeof a === 'object') {
            const keys = new Set();
            Object.keys(a).forEach(function (k) { keys.add(k); });
            Object.keys(b).forEach(function (k) { keys.add(k); });
            for (const k of keys) {
                const r = deepDiff(a[k], b[k], path ? path + '.' + k : k);
                if (r) return r;
            }
            return null;
        }
        if (a !== b) return path + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
        return null;
    }

    BABYLON.GLTFPhysicsExport = {
        snapshot: snapshot,
        reset: reset,
        appendTaggedAsync: appendTaggedAsync,
        captureLoadedAsync: captureLoadedAsync,
        captureProgrammatic: captureProgrammatic,
        captureProgrammaticJoints: captureProgrammaticJoints,
        disposeProgrammaticJoints: disposeProgrammaticJoints,
        registerJoint: registerJoint,
        GLBAsync: GLBAsync,
        validateRoundTripAsync: validateRoundTripAsync
    };
})(typeof window !== 'undefined' ? window.BABYLON : undefined);
