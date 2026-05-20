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

    const GLB_MAGIC = 0x46546C67;  // 'glTF'
    const GLB_VERSION = 2;
    const CHUNK_JSON = 0x4E4F534A; // 'JSON'
    const CHUNK_BIN  = 0x004E4942; // 'BIN\0'

    function isPhysicsMesh(mesh) {
        return !!(mesh && (mesh.physicsBody || mesh.aggregate));
    }

    function snapshot(scene) {
        scene.meshes.forEach(function (mesh) {
            if (!isPhysicsMesh(mesh)) {
                return;
            }
            mesh.metadata = mesh.metadata || {};
            mesh.metadata[SNAPSHOT_KEY] = {
                position: mesh.position.clone(),
                rotation: mesh.rotation.clone(),
                rotationQuaternion: mesh.rotationQuaternion ? mesh.rotationQuaternion.clone() : null
            };
        });
    }

    // --- capture loaded physics ---

    async function captureLoadedAsync(scene, glbUrl) {
        const response = await fetch(glbUrl);
        if (!response.ok) {
            throw new Error('captureLoadedAsync: fetch failed for ' + glbUrl + ': ' + response.status);
        }
        const arrayBuffer = await response.arrayBuffer();
        const { json } = parseGLB(arrayBuffer);

        const implicit = json.extensions && json.extensions.KHR_implicit_shapes;
        const rigid = json.extensions && json.extensions.KHR_physics_rigid_bodies;
        const nodes = json.nodes || [];
        const meshes = json.meshes || [];

        // Per-node physics blocks keyed by node name. Cross-references that
        // point at other resources by index (joint.connectedNode, and
        // mesh/node references inside collider/trigger geometry) are stored as
        // NAMES so the export step can rebind them to whatever indices the
        // re-serialized glTF assigns.
        const byName = new Map();
        nodes.forEach(function (node) {
            const ext = node && node.extensions && node.extensions.KHR_physics_rigid_bodies;
            if (!ext || !node.name) {
                return;
            }
            const cloned = JSON.parse(JSON.stringify(ext));
            indexRefsToNames(cloned, nodes, meshes);
            byName.set(node.name, cloned);
        });

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
            byName: byName
        };

        scene.metadata = scene.metadata || {};
        scene.metadata[CAPTURED_KEY] = captured;
        return captured;
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
                }
            };

            const gltfData = await BABYLON.GLTF2Export.GLBAsync(scene, baseName, exportOptions);
            const fileMap = gltfData.glTFFiles;
            const glbName = Object.keys(fileMap).find(function (k) { return k.endsWith('.glb'); });
            if (!glbName) {
                throw new Error('GLTF2Export did not produce a .glb');
            }

            const arrayBuffer = await fileMap[glbName].arrayBuffer();
            const { json, bin } = parseGLB(arrayBuffer);

            if (captured) {
                injectCapturedExtensions(json, captured);
            } else {
                injectPhysicsExtensions(json, derived);
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

    // --- physics data collection (programmatic scenes) ---

    function collectPhysicsData(scene) {
        const shapes = [];
        const materials = [];
        const bodies = new Map(); // mesh name -> node-level KHR_physics_rigid_bodies block

        scene.meshes.forEach(function (mesh) {
            if (!isPhysicsMesh(mesh)) {
                return;
            }
            const body = describeBody(mesh, shapes, materials);
            if (body) {
                bodies.set(mesh.name, body);
            }
        });

        return { shapes, materials, bodies };
    }

    function describeBody(mesh, shapes, materials) {
        const shapeSpec = describeShape(mesh);
        if (!shapeSpec) {
            console.warn('[GLTFPhysicsExport] Skipping mesh with unsupported physics shape:', mesh.name);
            return null;
        }
        const shapeIndex = pushUnique(shapes, shapeSpec);
        const matIndex = pushUnique(materials, describeMaterial(mesh));

        const body = {
            collider: { geometry: { shape: shapeIndex }, physicsMaterial: matIndex }
        };
        const mass = readMass(mesh);
        if (mass > 0) {
            body.motion = { mass: mass };
        }
        // mass === 0 → static, no motion block (matches the eoineoineoin convention)
        return body;
    }

    function describeShape(mesh) {
        const aggregate = mesh.aggregate;
        const shape = aggregate && aggregate.shape;
        if (!shape) {
            return null;
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
        if (aggregate) {
            if (aggregate.material) {
                if (typeof aggregate.material.friction === 'number') friction = aggregate.material.friction;
                if (typeof aggregate.material.restitution === 'number') restitution = aggregate.material.restitution;
            }
            if (aggregate.shape && aggregate.shape.material) {
                const m = aggregate.shape.material;
                if (typeof m.friction === 'number') friction = m.friction;
                if (typeof m.restitution === 'number') restitution = m.restitution;
            }
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

    function applySnapshots(scene) {
        const restore = [];
        scene.meshes.forEach(function (mesh) {
            if (!mesh || !mesh.metadata || !mesh.metadata[SNAPSHOT_KEY]) {
                return;
            }
            const snap = mesh.metadata[SNAPSHOT_KEY];
            restore.push({
                mesh,
                position: mesh.position.clone(),
                rotation: mesh.rotation.clone(),
                rotationQuaternion: mesh.rotationQuaternion ? mesh.rotationQuaternion.clone() : null
            });
            mesh.position.copyFrom(snap.position);
            if (snap.rotationQuaternion) {
                mesh.rotationQuaternion = snap.rotationQuaternion.clone();
            } else {
                mesh.rotationQuaternion = null;
                mesh.rotation.copyFrom(snap.rotation);
            }
            mesh.computeWorldMatrix(true);
        });
        return function () {
            restore.forEach(function (r) {
                r.mesh.position.copyFrom(r.position);
                if (r.rotationQuaternion) {
                    r.mesh.rotationQuaternion = r.rotationQuaternion;
                } else {
                    r.mesh.rotationQuaternion = null;
                    r.mesh.rotation.copyFrom(r.rotation);
                }
                r.mesh.computeWorldMatrix(true);
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
        json.extensions.KHR_physics_rigid_bodies = { physicsMaterials: data.materials };

        if (!Array.isArray(json.nodes)) {
            return;
        }
        json.nodes.forEach(function (node) {
            const body = data.bodies.get(node.name);
            if (!body) {
                return;
            }
            node.extensions = node.extensions || {};
            node.extensions.KHR_physics_rigid_bodies = body;
        });
    }

    // --- glTF JSON injection (captured / loaded scenes) ---

    function injectCapturedExtensions(json, captured) {
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
            return;
        }

        // Map name -> new index for nodes and meshes so captured references
        // can be remapped onto Babylon's renumbered output.
        const nameToNodeIndex = new Map();
        json.nodes.forEach(function (node, i) {
            if (node && node.name) {
                nameToNodeIndex.set(node.name, i);
            }
        });
        const nameToMeshIndex = new Map();
        (json.meshes || []).forEach(function (mesh, i) {
            if (mesh && mesh.name) {
                nameToMeshIndex.set(mesh.name, i);
            }
        });

        json.nodes.forEach(function (node) {
            if (!node || !node.name) {
                return;
            }
            const block = captured.byName.get(node.name);
            if (!block) {
                return;
            }
            const cloned = JSON.parse(JSON.stringify(block));
            namesToIndexRefs(cloned, nameToNodeIndex, nameToMeshIndex, json.nodes);
            node.extensions = node.extensions || {};
            node.extensions.KHR_physics_rigid_bodies = cloned;
        });
    }

    // Mapping for resource references inside a KHR_physics_rigid_bodies block.
    // Capture stores names; export resolves them back to whatever indices the
    // re-serialized glTF assigns (Babylon's GLTF2Export renumbers nodes /
    // meshes / accessors). This is what keeps the mesh-collision floor in
    // ShapeTypes pointing at the same Plane mesh after a round-trip instead of
    // dangling at the original index.

    function indexRefsToNames(block, nodes, meshes) {
        if (block.joint && typeof block.joint.connectedNode === 'number') {
            const connected = nodes[block.joint.connectedNode];
            block.joint.connectedNodeName = connected ? connected.name : null;
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
            geometry.meshName = mesh ? mesh.name : null;
            // Babylon's GLTF2Export drops mesh names but preserves node names, so
            // also stash the name of any node that owns this mesh — at export
            // time we can look that node up and read its renumbered mesh index.
            const owner = nodes.find(function (n) { return n && n.mesh === meshIdx; });
            geometry.meshOwnerNodeName = owner ? owner.name : null;
            delete geometry.mesh;
        }
        if (typeof geometry.node === 'number') {
            const node = nodes[geometry.node];
            geometry.nodeName = node ? node.name : null;
            delete geometry.node;
        }
    }

    function namesToIndexRefs(block, nameToNodeIndex, nameToMeshIndex, jsonNodes) {
        if (block.joint && block.joint.connectedNodeName != null) {
            const idx = nameToNodeIndex.get(block.joint.connectedNodeName);
            if (typeof idx === 'number') {
                block.joint.connectedNode = idx;
            }
            delete block.joint.connectedNodeName;
        }
        geometryNamesToIndexRefs(block.collider && block.collider.geometry, nameToNodeIndex, nameToMeshIndex, jsonNodes);
        geometryNamesToIndexRefs(block.trigger && block.trigger.geometry, nameToNodeIndex, nameToMeshIndex, jsonNodes);
    }

    function geometryNamesToIndexRefs(geometry, nameToNodeIndex, nameToMeshIndex, jsonNodes) {
        if (!geometry) return;
        if (geometry.meshName != null || geometry.meshOwnerNodeName != null) {
            let idx;
            if (geometry.meshName != null) {
                idx = nameToMeshIndex.get(geometry.meshName);
            }
            if (typeof idx !== 'number' && geometry.meshOwnerNodeName != null) {
                const ownerIdx = nameToNodeIndex.get(geometry.meshOwnerNodeName);
                if (typeof ownerIdx === 'number') {
                    const ownerNode = jsonNodes[ownerIdx];
                    if (ownerNode && typeof ownerNode.mesh === 'number') {
                        idx = ownerNode.mesh;
                    }
                }
            }
            if (typeof idx === 'number') {
                geometry.mesh = idx;
            } else {
                console.warn('[GLTFPhysicsExport] Could not resolve collider mesh ref:',
                    geometry.meshName, 'owner:', geometry.meshOwnerNodeName);
            }
            delete geometry.meshName;
            delete geometry.meshOwnerNodeName;
        }
        if (geometry.nodeName != null) {
            const idx = nameToNodeIndex.get(geometry.nodeName);
            if (typeof idx === 'number') {
                geometry.node = idx;
            } else {
                console.warn('[GLTFPhysicsExport] No exported node matches captured name:', geometry.nodeName);
            }
            delete geometry.nodeName;
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

    BABYLON.GLTFPhysicsExport = {
        snapshot: snapshot,
        captureLoadedAsync: captureLoadedAsync,
        GLBAsync: GLBAsync
    };
})(typeof window !== 'undefined' ? window.BABYLON : undefined);
