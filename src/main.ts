import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { Engine, grade } from './core/Engine';
import { params, TOD_PRESETS } from './core/params';
import { Q, preset, gpuName } from './core/quality';
import { initAssets, progress as assetProgress } from './core/Assets';
import { Heightfield } from './world/Heightfield';
import { Terrain } from './world/Terrain';
import { createTerrainMaterial, terrainU } from './world/TerrainMaterial';
import { Sky, cloudRT } from './sky/Sky';
import { TimeOfDay } from './sky/TimeOfDay';
import { aerialFogNode, atmo, transmittanceRT, skyViewRT } from './sky/Atmosphere';
import { Loading } from './ui/Loading';
import { installHarness, type Ctx } from './debug/harness';
import { SPOTS } from './world/layout';
import { wetness } from './world/weatherUniforms';
import { Ocean, oceanU } from './water/Ocean';
import { Colliders } from './world/Colliders';
import { Input } from './player/Input';
import { CameraRig } from './player/CameraRig';
import { Player } from './player/Player';

async function boot() {
  const loading = new Loading();
  loading.gpu(gpuName ? `${gpuName} · ${preset}` : preset);
  loading.status('Starting the renderer');
  const engine = await Engine.create(document.getElementById('app')!);
  const { scene, camera, renderer } = engine;
  loading.gpu(`${gpuName || engine.adapterInfo.description || engine.adapterInfo.vendor || ''} · ${engine.backendName} · ${preset}`);
  initAssets(renderer);
  const ctx: Ctx = { engine, tod: null as unknown as TimeOfDay, spotNames: SPOTS.map((s) => s.name), quality: { preset, ...Q } };

  // ---- island data
  loading.status('Shaping the island');
  const hf = new Heightfield();
  let got = 0;
  await hf.load('./world/', (n) => {
    got += n;
    loading.progress(0.05 + 0.4 * Math.min(1, got / Heightfield.BYTES));
  });
  const colliders = new Colliders();

  // ---- light and sky
  loading.status('Lighting the sky');
  const sunLight = new THREE.DirectionalLight(0xffffff, 10);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 2400;
  sunLight.shadow.bias = -0.0003;
  sunLight.shadow.normalBias = 0.5;
  const csm = new CSMShadowNode(sunLight, { cascades: Q.cascades, maxFar: Q.shadowFar, mode: 'practical', lightMargin: 400 });
  csm.fade = true;
  sunLight.shadow.shadowNode = csm;
  scene.add(sunLight, sunLight.target);

  const tod = new TimeOfDay(sunLight);
  ctx.tod = tod;
  tod.dayMinutes = params.dayMinutes;
  tod.frozen = params.freeze;
  tod.setHour(params.tod ?? TOD_PRESETS.sunrise);
  const sky = new Sky(renderer, scene);
  scene.fogNode = aerialFogNode();

  // ---- terrain and sea
  loading.status('Raising the terrain');
  const terrainM = createTerrainMaterial(hf);
  const terrain = new Terrain(hf, terrainM.material);
  scene.add(terrain.mesh);
  loading.status('Filling the sea');
  const ocean = new Ocean(hf);
  scene.add(ocean.mesh);

  // ---- player and camera
  loading.status('Waking the traveller');
  const input = new Input(renderer.domElement);
  const player = new Player(hf, colliders);
  const playerLoad = player.load();
  scene.add(player.root);
  const rig = new CameraRig(camera, {
    groundAt: (x, z) => Math.max(hf.height(x, z), colliders.surfaceAt(x, z, 1e9)?.y ?? -1e9),
    raycast: (f, d, m) => colliders.raycast(f, d, m),
  });
  player.seaAt = (x, z) => ocean.surfaceAt(x, z, 0);
  const spot = SPOTS.find((s) => s.name === (params.spot ?? 'beach')) ?? SPOTS[0];
  await playerLoad;
  loading.progress(0.6);
  player.place(spot.player[0], spot.player[1], spot.yaw);
  rig.snapBehind(spot.yaw);

  // ---- camera override from the URL: cam=orbit | free | x,y,z,tx,ty,tz
  if (params.cam) {
    const parts = params.cam.split(',').map(Number);
    if (parts.length === 6 && parts.every(Number.isFinite)) rig.set({ pos: parts.slice(0, 3), target: parts.slice(3) });
    else rig.set(params.cam);
  }

  engine.setupPost();

  // ---- frame
  engine.addUpdater((dt, t) => {
    const intent = input.read(dt);
    if (input.hit('KeyF') || input.hit('KeyP')) rig.set(rig.mode === 'free' ? 'follow' : 'free');
    tod.update(dt);
    // in the free camera WASD flies the camera; scripted actions (harness) always drive the player
    const playerIntent = rig.mode === 'free' && !input.scripted ? { ...intent, moveX: 0, moveY: 0, jump: false } : intent;
    player.update(dt, playerIntent, rig.yaw);
    rig.update(dt, rig.mode === 'follow' || rig.mode === 'free' ? intent : { ...intent, lookX: 0, lookY: 0 }, player.pos, player.speed);
    ocean.sim.setProbe(0, player.pos.x, player.pos.z);
    atmo.camHeight.value = Math.max(1, camera.position.y);
    atmo.time.value = t;
    terrainU.time.value = t;
    wetness.time.value = t;
    oceanU.time.value = t;
    grade.exposure.value = tod.exposure;
    camera.updateMatrixWorld();
    terrain.update(camera, Q.shadowFar);
    sky.update(dt, scene);
    ocean.update(renderer, camera, t, dt);
  });

  // stream the terrain layer textures after the first frames
  let streaming = 1;
  terrainM.loadLayers().then(() => streaming--, (e) => {
    console.warn('terrain layers', e);
    streaming--;
  });

  loading.status('Compiling shaders');
  loading.progress(0.85);
  await engine.measureRefresh();
  sky.update(0, scene, true);
  terrain.update(camera, Q.shadowFar);
  await renderer.compileAsync(scene, camera);
  engine.start();
  Object.assign(ctx, {
    hf, terrain, sky, csm, ocean, player, cameraRig: rig, input, colliders,
    rts: { transmittance: transmittanceRT, skyView: skyViewRT, cloud: cloudRT },
    isBusy: () => streaming > 0 || assetProgress.pending > assetProgress.done,
  });
  ctx.player = {
    toSpot: (n: string) => {
      const r = player.toSpot(n);
      const s = SPOTS.find((p) => p.name === n);
      if (s) rig.snapBehind(s.yaw);
      return r;
    },
    act: (a: string, s: number, yaw?: number) => player.act(input, a, s, yaw, rig.yaw),
    state: () => player.state_(),
  };
  installHarness(ctx);
  loading.progress(1);
  setTimeout(() => loading.done(), 250);
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('load-status');
  if (el) el.textContent = `Error: ${e?.message ?? e}`;
  (window as unknown as { __island?: { error?: string } }).__island = { error: String(e?.stack ?? e) };
});
