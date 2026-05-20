// Lightweight control panel for the captured KHR_physics_* data.
// Reads scene.metadata.__gltfPhysicsCaptured (produced by
// GLTFPhysicsExport.captureLoadedAsync) and renders sliders via lil-gui.
//
// Each edit writes back to the captured data (so the next export reflects
// the change) and also applies to the live Babylon physics body for
// immediate visual feedback. Currently exposes:
//   - per-body  motion.{type, mass, gravityFactor, linearVelocity, angularVelocity}
//   - per-material  friction (static = dynamic), restitution
//
// Joint / filter / trigger / shape-geometry editing is intentionally out of
// scope for Phase 1.

(function (BABYLON) {
    if (!BABYLON) {
        throw new Error('Babylon.js must be loaded before control-panel.js');
    }

    const CAPTURED_KEY = '__gltfPhysicsCaptured';
    const CHILDREN_KEY = '__gltfPhysicsCapturedChildren';

    // The rigid-body loader wraps every collider in a PhysicsShapeContainer
    // and attaches the friction/restitution material to each *child* shape,
    // not to the container. Once added, the container only holds the child
    // on the Havok C++ side — there's no JS-visible array, so live material
    // editing has no way to reach the actual contact material. Patch
    // addChild to also store the child reference on the container so the
    // control panel can walk back to it later.
    (function patchContainerAddChild() {
        const Container = BABYLON.PhysicsShapeContainer;
        if (!Container || !Container.prototype || Container.prototype.__gltfPhysicsAddChildPatched) return;
        const orig = Container.prototype.addChild;
        if (typeof orig !== 'function') return;
        Container.prototype.addChild = function (child) {
            if (!this[CHILDREN_KEY]) this[CHILDREN_KEY] = [];
            this[CHILDREN_KEY].push(child);
            return orig.apply(this, arguments);
        };
        Container.prototype.__gltfPhysicsAddChildPatched = true;
    })();

    function getGUIConstructor() {
        if (typeof lil !== 'undefined' && lil.GUI) return lil.GUI;
        if (typeof GUI !== 'undefined') return GUI;
        return null;
    }

    function init(scene, options) {
        options = options || {};
        const captured = scene.metadata && scene.metadata[CAPTURED_KEY];
        if (!captured) {
            console.warn('[GLTFPhysicsControlPanel] captureLoadedAsync must run first');
            return null;
        }
        const GUICtor = getGUIConstructor();
        if (!GUICtor) {
            console.warn('[GLTFPhysicsControlPanel] lil-gui not loaded');
            return null;
        }

        const gui = new GUICtor({
            container: options.container,
            title: options.title || 'Physics'
        });

        addResetButton(gui, scene);
        addWireframeToggle(gui, scene);
        addMaterialFolders(gui, scene, captured);
        addBodiesFolder(gui, scene, captured);
        addExportButton(gui, scene, options);
        return gui;
    }

    function addResetButton(gui, scene) {
        const actions = {
            reset: function () {
                if (BABYLON.GLTFPhysicsExport && BABYLON.GLTFPhysicsExport.reset) {
                    BABYLON.GLTFPhysicsExport.reset(scene);
                }
            }
        };
        gui.add(actions, 'reset').name('Reset positions');
    }

    function addWireframeToggle(gui, scene) {
        if (!BABYLON.Debug || !BABYLON.Debug.PhysicsViewer) return;
        let viewer = null;
        let observer = null;
        const state = { wireframe: false };
        const enable = function () {
            viewer = new BABYLON.Debug.PhysicsViewer(scene);
            const seen = new WeakSet();
            const showAll = function () {
                const visit = function (node) {
                    if (!node) return;
                    const body = node.physicsBody;
                    if (body && !seen.has(body) && viewer.showBody) {
                        viewer.showBody(body);
                        seen.add(body);
                    }
                };
                (scene.meshes || []).forEach(visit);
                (scene.transformNodes || []).forEach(visit);
            };
            showAll();
            observer = scene.onBeforeRenderObservable.add(showAll);
        };
        const disable = function () {
            if (observer) {
                scene.onBeforeRenderObservable.remove(observer);
                observer = null;
            }
            if (viewer) {
                try { viewer.dispose(); } catch (_err) { /* best effort */ }
                viewer = null;
            }
        };
        gui.add(state, 'wireframe').name('Wireframe').onChange(function (v) {
            if (v) enable(); else disable();
        });
    }

    function addExportButton(gui, scene, options) {
        const exportName = options && options.exportName;
        if (!exportName) return;
        const state = { status: '' };
        const statusCtrl = gui.add(state, 'status').name('Status').disable();
        const actions = {
            export: async function () {
                state.status = 'Exporting...';
                statusCtrl.updateDisplay();
                try {
                    await BABYLON.GLTFPhysicsExport.GLBAsync(scene, exportName);
                    state.status = 'Exported ' + exportName + '.glb';
                } catch (err) {
                    console.error(err);
                    state.status = 'Export failed: ' + err.message;
                }
                statusCtrl.updateDisplay();
            }
        };
        gui.add(actions, 'export').name('Export .glb');
    }

    function addMaterialFolders(gui, scene, captured) {
        if (!captured.physicsMaterials.length) return;
        const root = gui.addFolder('Materials');
        captured.physicsMaterials.forEach(function (mat, idx) {
            const label = labelForMaterial(captured, idx) || ('Material ' + idx);
            const folder = root.addFolder(label);
            const proxy = {
                friction: pickFriction(mat),
                restitution: typeof mat.restitution === 'number' ? mat.restitution : 0
            };
            folder.add(proxy, 'friction', 0, 2, 0.01).onChange(function (v) {
                mat.staticFriction = v;
                mat.dynamicFriction = v;
                applyMaterialLive(scene, captured, idx, proxy);
            });
            folder.add(proxy, 'restitution', 0, 1, 0.01).onChange(function (v) {
                mat.restitution = v;
                applyMaterialLive(scene, captured, idx, proxy);
            });
        });
    }

    function addBodiesFolder(gui, scene, captured) {
        const entries = [];
        captured.byName.forEach(function (block, name) {
            // Surface every node that carries a rigid-body extension, even
            // static colliders — the type dropdown lets the user promote them
            // to dynamic / kinematic.
            entries.push({ name: name, block: block });
        });
        if (!entries.length) return;
        const root = gui.addFolder('Bodies');
        root.close();
        entries.forEach(function (entry) {
            const bodyFolder = root.addFolder(entry.name);
            bodyFolder.close();
            addMotionFolder(bodyFolder, scene, entry);
        });
    }

    function addMotionFolder(parent, scene, entry) {
        const block = entry.block;
        const folder = parent.addFolder('Motion');
        folder.close();

        const proxy = {
            type: motionTypeOf(block),
            mass: block.motion && typeof block.motion.mass === 'number' ? block.motion.mass : 1,
            gravityFactor: block.motion && typeof block.motion.gravityFactor === 'number' ? block.motion.gravityFactor : 1
        };
        const linVel = readVec3(block.motion && block.motion.linearVelocity);
        const angVel = readVec3(block.motion && block.motion.angularVelocity);

        folder.add(proxy, 'type', ['static', 'kinematic', 'dynamic']).onChange(function (v) {
            applyMotionTypeWrite(block, v, proxy);
            applyMotionTypeLive(scene, entry.name, v);
        });
        folder.add(proxy, 'mass', 0, 50, 0.1).onChange(function (v) {
            ensureMotion(block);
            block.motion.mass = v;
            applyMassLive(scene, entry.name, v);
        });
        folder.add(proxy, 'gravityFactor', -2, 2, 0.05).onChange(function (v) {
            ensureMotion(block);
            block.motion.gravityFactor = v;
            applyGravityFactorLive(scene, entry.name, v);
        });

        const lv = folder.addFolder('Linear velocity');
        lv.close();
        ['x', 'y', 'z'].forEach(function (axis, i) {
            lv.add(linVel, axis, -20, 20, 0.1).onChange(function () {
                ensureMotion(block);
                block.motion.linearVelocity = [linVel.x, linVel.y, linVel.z];
                applyLinearVelocityLive(scene, entry.name, linVel);
            });
        });

        const av = folder.addFolder('Angular velocity');
        av.close();
        ['x', 'y', 'z'].forEach(function (axis, i) {
            av.add(angVel, axis, -20, 20, 0.1).onChange(function () {
                ensureMotion(block);
                block.motion.angularVelocity = [angVel.x, angVel.y, angVel.z];
                applyAngularVelocityLive(scene, entry.name, angVel);
            });
        });
    }

    function motionTypeOf(block) {
        if (!block.motion) return 'static';
        if (block.motion.isKinematic === true) return 'kinematic';
        return 'dynamic';
    }

    function ensureMotion(block) {
        if (!block.motion) {
            block.motion = { mass: 1 };
        }
        return block.motion;
    }

    function applyMotionTypeWrite(block, type, proxy) {
        if (type === 'static') {
            delete block.motion;
            return;
        }
        const motion = ensureMotion(block);
        if (type === 'kinematic') {
            motion.isKinematic = true;
        } else {
            delete motion.isKinematic;
        }
        // Re-sync proxy.mass since 'static' may have cleared the motion block
        // and the dropdown could bounce back; keep the panel internally
        // consistent.
        if (typeof motion.mass !== 'number') motion.mass = proxy.mass || 1;
    }

    function readVec3(arr) {
        if (Array.isArray(arr) && arr.length === 3) {
            return { x: arr[0] || 0, y: arr[1] || 0, z: arr[2] || 0 };
        }
        return { x: 0, y: 0, z: 0 };
    }

    function pickFriction(mat) {
        if (typeof mat.staticFriction === 'number') return mat.staticFriction;
        if (typeof mat.dynamicFriction === 'number') return mat.dynamicFriction;
        return 0.5;
    }

    function labelForMaterial(captured, idx) {
        // Name the material by the first body that references it.
        let label = null;
        captured.byName.forEach(function (block, name) {
            if (label) return;
            if (block.collider && block.collider.physicsMaterial === idx) {
                label = name;
            }
        });
        return label;
    }

    function applyMassLive(scene, nodeName, mass) {
        const target = findPhysicsCarrier(scene, nodeName);
        if (!target || !target.physicsBody) return;
        try {
            target.physicsBody.setMassProperties({ mass: mass });
        } catch (err) {
            console.warn('[GLTFPhysicsControlPanel] setMassProperties failed for', nodeName, err);
        }
    }

    function applyMotionTypeLive(scene, nodeName, type) {
        const target = findPhysicsCarrier(scene, nodeName);
        if (!target || !target.physicsBody) return;
        const PMT = BABYLON.PhysicsMotionType;
        if (!PMT) return;
        // Babylon names: STATIC, ANIMATED (kinematic), DYNAMIC.
        const map = { static: PMT.STATIC, kinematic: PMT.ANIMATED, dynamic: PMT.DYNAMIC };
        const mt = map[type];
        if (mt == null) return;
        try {
            target.physicsBody.setMotionType(mt);
        } catch (err) {
            console.warn('[GLTFPhysicsControlPanel] setMotionType failed for', nodeName, err);
        }
    }

    function applyGravityFactorLive(scene, nodeName, factor) {
        const target = findPhysicsCarrier(scene, nodeName);
        if (!target || !target.physicsBody) return;
        try {
            target.physicsBody.setGravityFactor(factor);
        } catch (err) {
            console.warn('[GLTFPhysicsControlPanel] setGravityFactor failed for', nodeName, err);
        }
    }

    function applyLinearVelocityLive(scene, nodeName, v) {
        const target = findPhysicsCarrier(scene, nodeName);
        if (!target || !target.physicsBody) return;
        try {
            target.physicsBody.setLinearVelocity(new BABYLON.Vector3(v.x, v.y, v.z));
        } catch (err) {
            console.warn('[GLTFPhysicsControlPanel] setLinearVelocity failed for', nodeName, err);
        }
    }

    function applyAngularVelocityLive(scene, nodeName, v) {
        const target = findPhysicsCarrier(scene, nodeName);
        if (!target || !target.physicsBody) return;
        try {
            target.physicsBody.setAngularVelocity(new BABYLON.Vector3(v.x, v.y, v.z));
        } catch (err) {
            console.warn('[GLTFPhysicsControlPanel] setAngularVelocity failed for', nodeName, err);
        }
    }

    function applyMaterialLive(scene, captured, materialIndex, values) {
        const targetNames = new Set();
        captured.byName.forEach(function (block, nodeName) {
            if (block.collider && block.collider.physicsMaterial === materialIndex) {
                targetNames.add(nodeName);
            }
        });
        const materialObj = {
            friction: values.friction,
            staticFriction: values.friction,
            dynamicFriction: values.friction,
            restitution: values.restitution
        };
        forEachPhysicsCarrier(scene, function (node) {
            if (!targetNames.has(node.name)) return;
            const body = node.physicsBody;
            if (!body || !body.shape) return;
            setShapeMaterialDeep(body.shape, materialObj);
            wakeBody(body);
        });
    }

    function setShapeMaterialDeep(shape, materialObj) {
        if (!shape) return;
        try {
            shape.material = materialObj;
        } catch (err) {
            console.warn('[GLTFPhysicsControlPanel] shape.material setter threw', err);
        }
        // Compound / container shapes hold the real per-collider shapes as
        // children; the rigid-body loader uses this pattern. The parent's
        // material setter doesn't reach them, so descend explicitly.
        let children = null;
        if (typeof shape.getChildShapes === 'function') {
            try { children = shape.getChildShapes(); } catch (_e) { children = null; }
        }
        if (!children && Array.isArray(shape._childShapes)) {
            children = shape._childShapes;
        }
        if (!children && Array.isArray(shape[CHILDREN_KEY])) {
            children = shape[CHILDREN_KEY];
        }
        if (!children) return;
        children.forEach(function (entry) {
            const child = entry && (entry.shape || entry.childShape || entry);
            if (child && child !== shape) setShapeMaterialDeep(child, materialObj);
        });
    }

    function wakeBody(body) {
        try {
            if (typeof body.getLinearVelocity === 'function' && typeof body.setLinearVelocity === 'function') {
                body.setLinearVelocity(body.getLinearVelocity());
            }
        } catch (_err) {
            // best effort
        }
    }

    function findPhysicsCarrier(scene, nodeName) {
        let found = null;
        forEachPhysicsCarrier(scene, function (node) {
            if (!found && node.name === nodeName) found = node;
        });
        if (found) return found;
        // Fallback: the body might live on a child of the named node.
        const parent = scene.getNodeByName ? scene.getNodeByName(nodeName) : null;
        if (parent && parent.getChildren) {
            const kids = parent.getChildren(undefined, false);
            for (let i = 0; i < kids.length; i++) {
                if (kids[i].physicsBody) return kids[i];
            }
        }
        return null;
    }

    function forEachPhysicsCarrier(scene, fn) {
        const seen = new Set();
        const visit = function (n) {
            if (!n || seen.has(n)) return;
            if (n.physicsBody) {
                seen.add(n);
                fn(n);
            }
        };
        (scene.meshes || []).forEach(visit);
        (scene.transformNodes || []).forEach(visit);
    }

    BABYLON.GLTFPhysicsControlPanel = { init: init };
})(typeof window !== 'undefined' ? window.BABYLON : undefined);
