// Lightweight control panel for the captured KHR_physics_* data.
// Reads scene.metadata.__gltfPhysicsCaptured (produced by
// GLTFPhysicsExport.captureLoadedAsync) and renders sliders via lil-gui.
//
// Each edit writes back to the captured data (so the next export reflects
// the change) and also applies to the live Babylon physics body for
// immediate visual feedback. Currently exposes:
//   - per-body  motion.mass
//   - per-material  friction (static = dynamic), restitution
//
// Joint / filter / trigger editing is intentionally out of scope for now.

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
        addMassFolder(gui, scene, captured);
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

    function addMassFolder(gui, scene, captured) {
        const entries = [];
        captured.byName.forEach(function (block, name) {
            if (block.motion && typeof block.motion.mass === 'number') {
                entries.push({ name: name, block: block });
            }
        });
        if (!entries.length) return;
        const folder = gui.addFolder('Mass');
        entries.forEach(function (entry) {
            const proxy = { mass: entry.block.motion.mass };
            folder.add(proxy, 'mass', 0, 50, 0.1).name(entry.name).onChange(function (v) {
                entry.block.motion.mass = v;
                applyMassLive(scene, entry.name, v);
            });
        });
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
