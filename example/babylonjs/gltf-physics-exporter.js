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

    async function captureLoadedAsync(scene, sourceUrl) {
        const json = await fetchSourceJson(sourceUrl);

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
        const collisionFilters = [];
        const bodies = new Map(); // mesh name -> node-level KHR_physics_rigid_bodies block

        scene.meshes.forEach(function (mesh) {
            if (!isPhysicsMesh(mesh)) {
                return;
            }
            const body = describeBody(mesh, shapes, materials, collisionFilters);
            if (body) {
                bodies.set(mesh.name, body);
            }
        });

        return { shapes, materials, collisionFilters, bodies };
    }

    function describeBody(mesh, shapes, materials, collisionFilters) {
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
        const filterSpec = describeCollisionFilter(mesh);
        if (filterSpec) {
            body.collider.collisionFilter = pushUnique(collisionFilters, filterSpec);
        }
        const mass = readMass(mesh);
        if (mass > 0) {
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
        const shape = mesh.aggregate && mesh.aggregate.shape;
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

    // --- round-trip validation ---

    async function validateRoundTripAsync(scene, sourceUrl) {
        const sourceJson = await fetchSourceJson(sourceUrl);

        const outBuffer = await GLBAsync(scene, 'roundtrip-validation', { download: false });
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

        const perNode = new Map();
        nodes.forEach(function (n) {
            const ext = n && n.extensions && n.extensions.KHR_physics_rigid_bodies;
            if (!ext || !n.name) return;
            const cloned = JSON.parse(JSON.stringify(ext));
            indexRefsToNames(cloned, nodes, meshes);
            // Babylon's GLTF2Export drops mesh names but preserves node names,
            // so meshName diverges between source and export. Drop it and
            // compare only via the owning-node name, which survives.
            stripMeshName(cloned.collider && cloned.collider.geometry);
            stripMeshName(cloned.trigger && cloned.trigger.geometry);
            perNode.set(n.name, cloned);
        });

        return {
            shapes: implicit.shapes || [],
            physicsMaterials: rigid.physicsMaterials || [],
            collisionFilters: rigid.collisionFilters || [],
            physicsJoints: rigid.physicsJoints || [],
            perNode: perNode
        };
    }

    function stripMeshName(geometry) {
        if (geometry) delete geometry.meshName;
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
        captureLoadedAsync: captureLoadedAsync,
        captureProgrammatic: captureProgrammatic,
        captureProgrammaticJoints: captureProgrammaticJoints,
        disposeProgrammaticJoints: disposeProgrammaticJoints,
        GLBAsync: GLBAsync,
        validateRoundTripAsync: validateRoundTripAsync
    };
})(typeof window !== 'undefined' ? window.BABYLON : undefined);
