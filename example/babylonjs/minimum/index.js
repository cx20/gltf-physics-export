// Demo scene driving gltf-physics-exporter.js.
// Floor (static) + falling cube (dynamic). The Export .glb button is
// provided by the shared control panel (control-panel.js); the same panel
// exposes Scene/Ground and Scene/Cube folders so every value that drives
// the programmatic setup can be tweaked live and re-exported.

const HAVOK_WASM_URL = 'https://cx20.github.io/gltf-test/libs/babylonjs/dev/HavokPhysics.wasm';

const params = {
    ground: {
        width: 20,
        height: 0.1,
        depth: 20,
        posY: -2,
        friction: 0.1,
        restitution: 0.1
    },
    cube: {
        size: 5,
        posX: 0,
        posY: 10,
        posZ: 0,
        rotX: 10,  // degrees
        rotY: 0,
        rotZ: 10,
        mass: 1,
        friction: 0.2,
        restitution: 0.5
    }
};

const INITIAL_PARAMS = JSON.parse(JSON.stringify(params));

let engine;
let scene;
let canvas;
let material;
let ground = null;
let cube = null;
const sceneControllers = [];

async function init() {
    canvas = document.querySelector('#c');
    globalThis.HK = await HavokPhysics({
        locateFile: function (path) {
            if (path && path.endsWith('.wasm')) {
                return HAVOK_WASM_URL;
            }
            return path;
        }
    });
    engine = new BABYLON.Engine(canvas, true);
    scene = createScene();

    refreshCaptured();

    if (BABYLON.GLTFPhysicsControlPanel) {
        BABYLON.GLTFPhysicsControlPanel.init(scene, {
            exportName: 'minimum_physics',
            showCaptured: false,
            setupExtras: setupSceneFolder
        });
    }

    engine.runRenderLoop(function () {
        scene.render();
    });

    window.addEventListener('resize', function () {
        engine.resize();
    });
}

function createScene() {
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color3(1, 1, 1);

    const hk = new BABYLON.HavokPlugin();
    scene.enablePhysics(new BABYLON.Vector3(0, -9.8, 0), hk);
    scene.getPhysicsEngine().setTimeStep(scene.getAnimationRatio());

    const camera = new BABYLON.ArcRotateCamera('Camera', 0, 0, 10, new BABYLON.Vector3(0, 0, 0), scene);
    camera.setPosition(new BABYLON.Vector3(0, 2, -20));
    camera.attachControl(canvas, true);

    // Lights are only added for the preview canvas — the loader side supplies its own
    // lighting, so gltf-physics-exporter.js excludes them from the .glb.
    const hemiLight = new BABYLON.HemisphericLight('hemiLight', new BABYLON.Vector3(0, 1, 0), scene);
    hemiLight.intensity = 0.9;
    const dirLight = new BABYLON.DirectionalLight('dirLight', new BABYLON.Vector3(-0.4, -1.0, -0.3), scene);
    dirLight.position = new BABYLON.Vector3(12, 16, 10);
    dirLight.intensity = 0.6;

    material = new BABYLON.StandardMaterial('material', scene);
    material.diffuseTexture = new BABYLON.Texture('../../../assets/textures/frog.jpg', scene);

    rebuildGround();
    rebuildCube();

    scene.registerBeforeRender(function () {
        scene.activeCamera.alpha += Math.PI * 1.0 / 180.0 * scene.getAnimationRatio();
    });

    return scene;
}

function rebuildGround() {
    if (ground) {
        if (ground.aggregate) {
            try { ground.aggregate.dispose(); } catch (_e) { /* best effort */ }
            ground.aggregate = null;
        }
        ground.dispose();
    }
    ground = BABYLON.MeshBuilder.CreateBox('ground', {
        width: params.ground.width,
        height: params.ground.height,
        depth: params.ground.depth
    }, scene);
    ground.material = material;
    ground.position.y = params.ground.posY;
    ground.aggregate = new BABYLON.PhysicsAggregate(
        ground, BABYLON.PhysicsShapeType.BOX,
        { mass: 0, friction: params.ground.friction, restitution: params.ground.restitution }, scene);
}

function rebuildCube() {
    if (cube) {
        if (cube.aggregate) {
            try { cube.aggregate.dispose(); } catch (_e) { /* best effort */ }
            cube.aggregate = null;
        }
        cube.dispose();
    }
    cube = BABYLON.MeshBuilder.CreateBox('cube', { size: params.cube.size }, scene);
    cube.material = material;
    cube.position.x = params.cube.posX;
    cube.position.y = params.cube.posY;
    cube.position.z = params.cube.posZ;
    cube.rotation.x = params.cube.rotX * Math.PI / 180;
    cube.rotation.y = params.cube.rotY * Math.PI / 180;
    cube.rotation.z = params.cube.rotZ * Math.PI / 180;
    cube.aggregate = new BABYLON.PhysicsAggregate(
        cube, BABYLON.PhysicsShapeType.BOX,
        { mass: params.cube.mass, friction: params.cube.friction, restitution: params.cube.restitution }, scene);
}

function refreshCaptured() {
    // Reset positions reads this snapshot; export reads the captured payload.
    // Both must be refreshed after every rebuild so they reflect the params.
    BABYLON.GLTFPhysicsExport.snapshot(scene);
    BABYLON.GLTFPhysicsExport.captureProgrammatic(scene);
}

function onGroundChanged() {
    rebuildGround();
    refreshCaptured();
}

function onCubeChanged() {
    rebuildCube();
    refreshCaptured();
}

function resetSceneParams() {
    Object.assign(params.ground, INITIAL_PARAMS.ground);
    Object.assign(params.cube, INITIAL_PARAMS.cube);
    rebuildGround();
    rebuildCube();
    refreshCaptured();
    sceneControllers.forEach(function (c) { c.updateDisplay(); });
}

function setupSceneFolder(gui) {
    const root = gui.addFolder('Scene');
    root.add({ reset: resetSceneParams }, 'reset').name('Reset parameters');

    const g = root.addFolder('Ground');
    sceneControllers.push(g.add(params.ground, 'width', 1, 50, 0.1).onFinishChange(onGroundChanged));
    sceneControllers.push(g.add(params.ground, 'height', 0.05, 5, 0.05).onFinishChange(onGroundChanged));
    sceneControllers.push(g.add(params.ground, 'depth', 1, 50, 0.1).onFinishChange(onGroundChanged));
    sceneControllers.push(g.add(params.ground, 'posY', -10, 5, 0.1).onFinishChange(onGroundChanged));
    sceneControllers.push(g.add(params.ground, 'friction', 0, 2, 0.01).onFinishChange(onGroundChanged));
    sceneControllers.push(g.add(params.ground, 'restitution', 0, 1, 0.01).onFinishChange(onGroundChanged));

    const c = root.addFolder('Cube');
    sceneControllers.push(c.add(params.cube, 'size', 0.5, 20, 0.1).onFinishChange(onCubeChanged));
    sceneControllers.push(c.add(params.cube, 'posX', -10, 10, 0.1).onFinishChange(onCubeChanged));
    sceneControllers.push(c.add(params.cube, 'posY', 1, 30, 0.1).onFinishChange(onCubeChanged));
    sceneControllers.push(c.add(params.cube, 'posZ', -10, 10, 0.1).onFinishChange(onCubeChanged));
    sceneControllers.push(c.add(params.cube, 'rotX', -180, 180, 1).onFinishChange(onCubeChanged));
    sceneControllers.push(c.add(params.cube, 'rotY', -180, 180, 1).onFinishChange(onCubeChanged));
    sceneControllers.push(c.add(params.cube, 'rotZ', -180, 180, 1).onFinishChange(onCubeChanged));
    sceneControllers.push(c.add(params.cube, 'mass', 0, 50, 0.1).onFinishChange(onCubeChanged));
    sceneControllers.push(c.add(params.cube, 'friction', 0, 2, 0.01).onFinishChange(onCubeChanged));
    sceneControllers.push(c.add(params.cube, 'restitution', 0, 1, 0.01).onFinishChange(onCubeChanged));
}

init();
