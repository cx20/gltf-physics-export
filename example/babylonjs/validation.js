const SAMPLES_ROOT = 'https://raw.githubusercontent.com/eoineoineoin/glTF_Physics/master/samples/';
const TESTS_ROOT = 'https://raw.githubusercontent.com/eoineoineoin/glTF_Physics/master/tests/';
const HAVOK_WASM_URL = 'https://cx20.github.io/gltf-test/libs/babylonjs/dev/HavokPhysics.wasm';
const RIGID_BODY_LOADER_URL = 'https://cx20.github.io/gltf-test/libs/babylonjs/dev/babylon-gltf-rigid-body-loader.js';

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

const tbody = document.querySelector('#results tbody');
const rowFor = new Map();

function appendSectionHeader(title) {
    const tr = document.createElement('tr');
    tr.className = 'section';
    const th = document.createElement('th');
    th.colSpan = 3;
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
    const tdDetails = document.createElement('td');
    tr.appendChild(tdName);
    tr.appendChild(tdStatus);
    tr.appendChild(tdDetails);
    tbody.appendChild(tr);
    rowFor.set(entry.name, { status: tdStatus, details: tdDetails });
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

function setDetails(name, diffs, errorMessage) {
    const row = rowFor.get(name);
    row.details.innerHTML = '';
    if (errorMessage) {
        const pre = document.createElement('pre');
        pre.textContent = errorMessage;
        row.details.appendChild(pre);
        return;
    }
    if (!diffs || diffs.length === 0) return;
    const pre = document.createElement('pre');
    pre.textContent = diffs.map(function (d) {
        return d.path + (d.reason ? '  —  ' + d.reason : '');
    }).join('\n');
    row.details.appendChild(pre);
}

// The cx20 rigid-body loader dereferences `gltf.extensions.KHR_implicit_shapes`
// and `gltf.extensions.KHR_physics_rigid_bodies` whenever those names appear
// in `extensionsUsed`. Some upstream tests (mesh-only colliders, no shared
// materials/filters/joints) skip the top-level block entirely, which crashes
// the loader. Pre-fetch the .gltf, splice in empty placeholders, and hand the
// patched JSON to SceneLoader as a File so the .bin URIs still resolve
// against the original rootUrl.
async function appendSceneAsync(entry, scene) {
    const slash = entry.url.lastIndexOf('/');
    const rootUrl = entry.url.substring(0, slash + 1);
    const fileName = entry.url.substring(slash + 1);

    if (/\.glb(\?.*)?$/i.test(fileName)) {
        await BABYLON.SceneLoader.AppendAsync(rootUrl, fileName, scene);
        return;
    }

    const resp = await fetch(entry.url);
    if (!resp.ok) throw new Error('fetch ' + entry.url + ' failed: ' + resp.status);
    const json = await resp.json();
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
    const blob = new Blob([JSON.stringify(json)], { type: 'model/gltf+json' });
    const file = new File([blob], fileName, { type: 'model/gltf+json' });
    await BABYLON.SceneLoader.AppendAsync(rootUrl, file, scene, null, '.gltf');
}

async function runOne(entry, engine) {
    const scene = new BABYLON.Scene(engine);
    try {
        const hk = new BABYLON.HavokPlugin();
        scene.enablePhysics(new BABYLON.Vector3(0, -9.8, 0), hk);
        await appendSceneAsync(entry, scene);
        await BABYLON.GLTFPhysicsExport.captureLoadedAsync(scene, entry.url);
        const result = await BABYLON.GLTFPhysicsExport.validateRoundTripAsync(scene, entry.url);
        if (result.pass) {
            setStatus(entry.name, 'pass', 'PASS');
            setDetails(entry.name, null);
        } else {
            setStatus(entry.name, 'fail', 'FAIL (' + result.diffs.length + ')');
            setDetails(entry.name, result.diffs);
        }
    } finally {
        scene.dispose();
    }
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
                setDetails(entry.name, null);
                try {
                    await runOne(entry, engine);
                } catch (err) {
                    console.error(entry.name, err);
                    setStatus(entry.name, 'fail', 'ERROR');
                    setDetails(entry.name, null, err && err.message ? err.message : String(err));
                }
            }
        } finally {
            engine.dispose();
        }
    } finally {
        btn.disabled = false;
    }
});
