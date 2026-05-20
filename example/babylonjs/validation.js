const SAMPLES_ROOT = 'https://raw.githubusercontent.com/eoineoineoin/glTF_Physics/master/samples/';
const HAVOK_WASM_URL = 'https://cx20.github.io/gltf-test/libs/babylonjs/dev/HavokPhysics.wasm';
const RIGID_BODY_LOADER_URL = 'https://cx20.github.io/gltf-test/libs/babylonjs/dev/babylon-gltf-rigid-body-loader.js';

const SAMPLES = [
    { name: 'ShapeTypes',          file: 'ShapeTypes.glb' },
    { name: 'Materials_Friction',  file: 'Materials_Friction.glb' },
    { name: 'Materials_Restitution', file: 'Materials_Restitution.glb' },
    { name: 'MotionProperties',    file: 'MotionProperties.glb' },
    { name: 'Filtering',           file: 'Filtering.glb' },
    { name: 'Triggers',            file: 'Triggers.glb' },
    { name: 'JointTypes',          file: 'JointTypes.glb' }
];

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

SAMPLES.forEach(function (s) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = s.name;
    const tdStatus = document.createElement('td');
    tdStatus.className = 'status pending';
    tdStatus.textContent = 'pending';
    const tdDetails = document.createElement('td');
    tr.appendChild(tdName);
    tr.appendChild(tdStatus);
    tr.appendChild(tdDetails);
    tbody.appendChild(tr);
    rowFor.set(s.name, { status: tdStatus, details: tdDetails });
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

async function runOne(sample, engine) {
    const url = SAMPLES_ROOT + sample.name + '/' + sample.file;
    const scene = new BABYLON.Scene(engine);
    try {
        const hk = new BABYLON.HavokPlugin();
        scene.enablePhysics(new BABYLON.Vector3(0, -9.8, 0), hk);
        await BABYLON.SceneLoader.AppendAsync(SAMPLES_ROOT + sample.name + '/', sample.file, scene);
        await BABYLON.GLTFPhysicsExport.captureLoadedAsync(scene, url);
        const result = await BABYLON.GLTFPhysicsExport.validateRoundTripAsync(scene, url);
        if (result.pass) {
            setStatus(sample.name, 'pass', 'PASS');
            setDetails(sample.name, null);
        } else {
            setStatus(sample.name, 'fail', 'FAIL (' + result.diffs.length + ')');
            setDetails(sample.name, result.diffs);
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
            for (const sample of SAMPLES) {
                setStatus(sample.name, 'pending', 'running...');
                setDetails(sample.name, null);
                try {
                    await runOne(sample, engine);
                } catch (err) {
                    console.error(sample.name, err);
                    setStatus(sample.name, 'fail', 'ERROR');
                    setDetails(sample.name, null, err && err.message ? err.message : String(err));
                }
            }
        } finally {
            engine.dispose();
        }
    } finally {
        btn.disabled = false;
    }
});
