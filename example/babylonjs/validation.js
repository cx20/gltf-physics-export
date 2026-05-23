const SAMPLES_ROOT = 'https://raw.githubusercontent.com/eoineoineoin/glTF_Physics/master/samples/';
const TESTS_ROOT = 'https://raw.githubusercontent.com/eoineoineoin/glTF_Physics/master/tests/';
const HAVOK_WASM_URL = 'https://cx20.github.io/gltf-test/libs/babylonjs/dev/HavokPhysics.wasm';
const RIGID_BODY_LOADER_URL = 'https://cx20.github.io/gltf-test/libs/babylonjs/dev/babylon-gltf-rigid-body-loader.js';
// Official Khronos glTF Validator (Dart->JS), loaded as a browser ESM bundle.
const GLTF_VALIDATOR_URL = 'https://cdn.jsdelivr.net/npm/gltf-validator@2.0.0-dev.3.10/+esm';

// Existing "showroom" samples — one .glb per top-level demo page.
const SAMPLES = [
    { name: 'ShapeTypes',           url: SAMPLES_ROOT + 'ShapeTypes/ShapeTypes.glb' },
    { name: 'Materials_Friction',   url: SAMPLES_ROOT + 'Materials_Friction/Materials_Friction.glb' },
    { name: 'Materials_Restitution',url: SAMPLES_ROOT + 'Materials_Restitution/Materials_Restitution.glb' },
    { name: 'MotionProperties',     url: SAMPLES_ROOT + 'MotionProperties/MotionProperties.glb' },
    { name: 'Filtering',            url: SAMPLES_ROOT + 'Filtering/Filtering.glb' },
    { name: 'Triggers',             url: SAMPLES_ROOT + 'Triggers/Triggers.glb' },
    { name: 'JointTypes',           url: SAMPLES_ROOT + 'JointTypes/JointTypes.glb' },
    { name: 'Robot_skinned',        url: SAMPLES_ROOT + 'Robot_skinned/Robot_skinned.glb' },
    { name: 'WaterWheel',           url: SAMPLES_ROOT + 'WaterWheel/WaterWheel.glb' }
];

// Upstream test suites at glTF_Physics/tests/. Each test ships as a
// `.gltf` + `.bin` pair (not a single `.glb`) and exercises one specific
// extension feature in isolation. The counts are hard-coded so we don't
// need to hit the GitHub API at runtime — extend when upstream adds tests.
const TEST_GROUPS = [
    { dir: 'RigidBodies_ColliderTypeMatrix',  count: 36 },
    { dir: 'RigidBodies_CollisionFilter',     count: 4  },
    { dir: 'RigidBodies_Joint',               count: 11 },
    { dir: 'RigidBodies_Materials',           count: 3  },
    { dir: 'RigidBodies_MotionProperties',    count: 8  }
];

const TESTS = TEST_GROUPS.flatMap(function (g) {
    const out = [];
    for (let i = 0; i < g.count; i++) {
        const num = String(i).padStart(2, '0');
        const file = g.dir + '_' + num + '.gltf';
        out.push({
            name: g.dir + '_' + num,
            url: TESTS_ROOT + g.dir + '/' + file,
            group: g.dir
        });
    }
    return out;
});

let rigidBodyLoaderPromise;
let physicsExtensionsRegistered = false;

function ensureRigidBodyLoader() {
    if (window.GLTFRigidBodyLoader) return Promise.resolve();
    if (!rigidBodyLoaderPromise) {
        rigidBodyLoaderPromise = new Promise(function (resolve, reject) {
            const s = document.createElement('script');
            s.src = RIGID_BODY_LOADER_URL;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('Failed to load babylon-gltf-rigid-body-loader.')); };
            document.head.appendChild(s);
        });
    }
    return rigidBodyLoaderPromise;
}

function registerPhysicsExtensions() {
    if (physicsExtensionsRegistered) return;
    BABYLON.GLTF2.GLTFLoader.RegisterExtension('KHR_implicit_shapes', function (loader) {
        return new GLTFRigidBodyLoader.KHR_ImplicitShapes_Plugin(loader);
    });
    BABYLON.GLTF2.GLTFLoader.RegisterExtension('KHR_physics_rigid_bodies', function (loader) {
        return new GLTFRigidBodyLoader.KHR_PhysicsRigidBodies_Plugin(loader);
    });
    physicsExtensionsRegistered = true;
}

// Lazily import the glTF Validator's browser ESM bundle once. Returns its
// validateBytes(Uint8Array, options) -> Promise<report>.
let validatorPromise;
function ensureGltfValidator() {
    if (!validatorPromise) {
        validatorPromise = import(GLTF_VALIDATOR_URL).then(function (mod) {
            if (!mod || typeof mod.validateBytes !== 'function') {
                throw new Error('gltf-validator module has no validateBytes export');
            }
            return mod.validateBytes;
        });
    }
    return validatorPromise;
}

// Validate an exported GLB ArrayBuffer with the official glTF Validator.
// GLB is self-contained (geometry/textures live in the BIN chunk), so no
// externalResourceFunction is needed.
async function validateGltfBytes(outBuffer) {
    const validateBytes = await ensureGltfValidator();
    return validateBytes(new Uint8Array(outBuffer), { uri: 'export.glb', maxIssues: 0 });
}

const tbody = document.querySelector('#results tbody');
const rowFor = new Map();

function appendSectionHeader(title) {
    const tr = document.createElement('tr');
    tr.className = 'section';
    const th = document.createElement('th');
    th.colSpan = 4;
    th.textContent = title;
    tr.appendChild(th);
    tbody.appendChild(tr);
}

function appendRow(entry) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = entry.name;
    const tdStatus = document.createElement('td');
    tdStatus.className = 'status pending';
    tdStatus.textContent = 'pending';
    const tdValidator = document.createElement('td');
    tdValidator.className = 'status pending';
    tdValidator.textContent = 'pending';
    const tdDetails = document.createElement('td');
    tr.appendChild(tdName);
    tr.appendChild(tdStatus);
    tr.appendChild(tdValidator);
    tr.appendChild(tdDetails);
    tbody.appendChild(tr);
    rowFor.set(entry.name, { status: tdStatus, validator: tdValidator, details: tdDetails });
}

// Render: showroom samples first, then test groups (each with a header row).
appendSectionHeader('Showroom samples');
SAMPLES.forEach(appendRow);
TEST_GROUPS.forEach(function (g) {
    appendSectionHeader('Tests — ' + g.dir);
    TESTS.filter(function (t) { return t.group === g.dir; }).forEach(appendRow);
});

function setStatus(name, cls, text) {
    const row = rowFor.get(name);
    row.status.className = 'status ' + cls;
    row.status.textContent = text;
}

function setValidatorStatus(name, cls, text) {
    const row = rowFor.get(name);
    row.validator.className = 'status ' + cls;
    row.validator.textContent = text;
}

// Render the Details cell from a list of plain-text lines (round-trip diffs
// and/or validator messages). Pass an empty/omitted list to clear.
function setDetailLines(name, lines) {
    const row = rowFor.get(name);
    row.details.innerHTML = '';
    if (!lines || lines.length === 0) return;
    const pre = document.createElement('pre');
    pre.textContent = lines.join('\n');
    row.details.appendChild(pre);
}

function diffsToLines(diffs) {
    return (diffs || []).map(function (d) {
        return d.path + (d.reason ? '  —  ' + d.reason : '');
    });
}

// Count nodes that actually carry a Havok physics body in a scene.
function countPhysicsBodies(scene) {
    let n = 0;
    const seen = new Set();
    const visit = function (node) {
        if (!node || seen.has(node)) return;
        if (node.physicsBody) { seen.add(node); n++; }
    };
    (scene.meshes || []).forEach(visit);
    (scene.transformNodes || []).forEach(visit);
    return n;
}

// Strong check: export the captured scene, RE-LOAD the exported .glb with
// the same rigid-body loader, and confirm it produces the same number of
// physics bodies. The JSON diff in validateRoundTripAsync compares the
// source against a re-injected clone of itself, so it can't catch a glb
// that fails to rebuild physics on load (e.g. a collider whose shape the
// loader can't reconstruct). This re-load actually exercises the output.
async function reloadBodyCheck(sourceScene, engine, outBuffer) {
    const sourceCount = countPhysicsBodies(sourceScene);
    const reScene = new BABYLON.Scene(engine);
    try {
        reScene.enablePhysics(new BABYLON.Vector3(0, -9.8, 0), new BABYLON.HavokPlugin());
        const blob = new Blob([outBuffer], { type: 'model/gltf-binary' });
        const file = new File([blob], 'reload-check.glb', { type: 'model/gltf-binary' });
        await BABYLON.SceneLoader.AppendAsync('', file, reScene, null, '.glb');
        const reloadedCount = countPhysicsBodies(reScene);
        return { sourceCount: sourceCount, reloadedCount: reloadedCount };
    } finally {
        reScene.dispose();
    }
}

async function runOne(entry, engine) {
    const scene = new BABYLON.Scene(engine);
    try {
        const hk = new BABYLON.HavokPlugin();
        scene.enablePhysics(new BABYLON.Vector3(0, -9.8, 0), hk);
        // appendTaggedAsync stamps every source node with its index and
        // patches missing top-level extension blocks before handing the
        // patched content to SceneLoader, so physics round-trips even for
        // nameless / duplicate-named nodes.
        await BABYLON.GLTFPhysicsExport.appendTaggedAsync(scene, entry.url);
        await BABYLON.GLTFPhysicsExport.captureLoadedAsync(scene, entry.url);
        const result = await BABYLON.GLTFPhysicsExport.validateRoundTripAsync(scene, entry.url);
        const diffs = (result.diffs || []).slice();

        // Export the user-facing format once (src-node tags stripped); reused
        // by both the reload check and the glTF Validator schema check.
        let outBuffer = null;
        try {
            outBuffer = await BABYLON.GLTFPhysicsExport.GLBAsync(scene, entry.name, { download: false });
        } catch (err) {
            diffs.push({ path: 'export', reason: 'export failed: ' + errText(err) });
        }

        // Re-load the exported glb and verify physics bodies are rebuilt.
        if (outBuffer) {
            try {
                const reload = await reloadBodyCheck(scene, engine, outBuffer);
                if (reload.sourceCount !== reload.reloadedCount) {
                    diffs.push({
                        path: 'reload',
                        reason: 'physics bodies ' + reload.sourceCount + ' (source) vs '
                            + reload.reloadedCount + ' (reloaded export)'
                    });
                }
            } catch (err) {
                diffs.push({ path: 'reload', reason: 'export failed to re-load: ' + errText(err) });
            }
        }

        // glTF Validator schema check on the exported .glb.
        const validatorLines = [];
        if (outBuffer) {
            try {
                const report = await validateGltfBytes(outBuffer);
                const issues = report.issues || {};
                const numErrors = issues.numErrors || 0;
                const numWarnings = issues.numWarnings || 0;
                (issues.messages || []).forEach(function (m) {
                    if (m.severity > 1) return; // skip info (2) / hint (3)
                    validatorLines.push((m.severity === 0 ? 'ERROR ' : 'WARN  ') + m.code
                        + (m.pointer ? ' @ ' + m.pointer : '') + ' — ' + m.message);
                });
                // The validator column is independent of the round-trip column:
                // a model can round-trip physics perfectly yet be schema-invalid
                // (and vice-versa), so a schema error is reported here only.
                if (numErrors > 0) {
                    setValidatorStatus(entry.name, 'fail', numErrors + ' error' + (numErrors > 1 ? 's' : ''));
                } else if (numWarnings > 0) {
                    setValidatorStatus(entry.name, 'warn', 'valid · ' + numWarnings + ' warn');
                } else {
                    setValidatorStatus(entry.name, 'pass', 'valid');
                }
            } catch (err) {
                setValidatorStatus(entry.name, 'pending', 'validator n/a');
                validatorLines.push('gltf-validator unavailable: ' + errText(err));
            }
        } else {
            setValidatorStatus(entry.name, 'pending', 'skipped');
        }

        if (diffs.length === 0) {
            setStatus(entry.name, 'pass', 'PASS');
        } else {
            setStatus(entry.name, 'fail', 'FAIL (' + diffs.length + ')');
        }
        setDetailLines(entry.name, diffsToLines(diffs).concat(validatorLines));
    } finally {
        scene.dispose();
    }
}

function errText(err) {
    return err && err.message ? err.message : String(err);
}

document.getElementById('runBtn').addEventListener('click', async function () {
    const btn = document.getElementById('runBtn');
    btn.disabled = true;
    try {
        globalThis.HK = await HavokPhysics({
            locateFile: function (path) {
                if (path && path.endsWith('.wasm')) return HAVOK_WASM_URL;
                return path;
            }
        });
        await ensureRigidBodyLoader();
        registerPhysicsExtensions();

        const canvas = document.getElementById('hiddenCanvas');
        const engine = new BABYLON.Engine(canvas, true);
        try {
            const all = SAMPLES.concat(TESTS);
            for (const entry of all) {
                setStatus(entry.name, 'pending', 'running...');
                setValidatorStatus(entry.name, 'pending', '...');
                setDetailLines(entry.name, null);
                try {
                    await runOne(entry, engine);
                } catch (err) {
                    console.error(entry.name, err);
                    setStatus(entry.name, 'fail', 'ERROR');
                    setDetailLines(entry.name, [errText(err)]);
                }
            }
        } finally {
            engine.dispose();
        }
    } finally {
        btn.disabled = false;
    }
});
