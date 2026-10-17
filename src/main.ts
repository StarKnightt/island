import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { Engine, grade } from './core/Engine';
import { params, TOD_PRESETS } from './core/params';
import { Q, preset, gpuName } from './core/quality';
import { initAssets, progress as assetProgress, loadGLTF } from './core/Assets';
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
import { Vegetation, vegU } from './veg/Vegetation';
import { buildCanopy } from './veg/Canopy';
import { Hud } from './ui/Hud';
import { River } from './water/River';
import { Village } from './world/Village';
import { Lighthouse } from './world/Lighthouse';
import { Weather } from './sky/Weather';
import { AudioSystem } from './audio/Audio';

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
  if (!new URLSearchParams(location.search).has('noocean')) scene.add(ocean.mesh);

  // ---- fresh water
  const river = new River(hf);
  scene.add(river.group);

  // ---- the village and the lighthouse
  loading.status('Building the village');
  const village = new Village(hf, colliders);
  village.build();
  scene.add(village.group);
  const lighthouse = new Lighthouse(hf, colliders);
  scene.add(lighthouse.group);

  // ---- weather and sound
  const weather = new Weather(hf);
  if (!new URLSearchParams(location.search).has('norain')) scene.add(weather.group);
  weather.set(params.weather, true);
  if (params.weather === 'auto') weather.set('auto');
  const audio = new AudioSystem(hf);
  audio.fallsPos.set(hf.meta.falls.lip[0], (hf.meta.falls.top + hf.meta.falls.bottom) / 2, hf.meta.falls.lip[1]);
  audio.mute(params.mute);
  weather.onThunder = (delay, strength) => audio.thunder(delay, strength);
  const startAudio = () => audio.start();
  window.addEventListener('pointerdown', startAudio, { once: true });
  window.addEventListener('keydown', startAudio, { once: true });
  if (params.test) audio.start();

  // ---- vegetation
  loading.status('Growing the jungle');
  const veg = new Vegetation(hf, colliders);
  const tv = performance.now();
  veg.build();
  console.log(`vegetation built in ${(performance.now() - tv).toFixed(0)} ms`);
  scene.add(veg.group);
  scene.add(buildCanopy(hf));
  // rocks stream in with the props
  const rocksReady = (async () => {
    const out: { geometry: THREE.BufferGeometry; material: THREE.Material; radius: number; big: boolean }[] = [];
    const tinted = new Set<THREE.Material>();
    // tints take each scan's mean albedo (namaqualand 0.37/0.26/0.15, boulder 0.16/0.11/0.07, moss 0.05/0.03/0.015
    // linear) to the island's dark grey basalt (~0.07) so they match the cliff rock; the moss keeps some of its green
    for (const [name, big, tint] of [['rock_moss_set_01', false, [1.0, 1.15, 1.4]], ['namaqualand_boulder_05', true, [0.19, 0.26, 0.44]], ['boulder_01', true, [0.46, 0.67, 1.0]]] as [string, boolean, [number, number, number]][]) {
      const g = await loadGLTF(`assets/props/${name}.glb`);
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // quantized (normalized int16, often interleaved) attributes would clamp to +-1 once transformed to metres
        const geo = toFloatGeometry(m.geometry);
        geo.applyMatrix4(m.matrixWorld);
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        // centre in plan, base at y = 0
        const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
        geo.translate(-cx, -bb.min.y, -cz);
        geo.computeBoundingSphere();
        const radius = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (!tinted.has(mat)) {
          tinted.add(mat);
          mat.color?.multiply(new THREE.Color(...tint));
        }
        out.push({ geometry: geo, material: mat, radius: Math.max(0.3, radius), big });
      });
    }
    veg.addRocks(out);
  })().catch((e) => console.warn('rocks', e));

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
  player.onStep = (e) => audio.step(e);
  player.onSplash = (s, p) => audio.splash(s, p);
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
  const hud = new Hud(params.hud);
  let photo = false;
  const setPhoto = (on: boolean) => {
    photo = on;
    hud.photo(on);
    rig.set(on ? 'free' : 'follow');
  };
  if (params.photo) setPhoto(true);

  // ---- frame
  engine.addUpdater((dt, t) => {
    const intent = input.read(dt);
    if (input.hit('KeyP') || input.hit('KeyF')) setPhoto(!photo);
    if (input.hit('KeyM')) audio.mute(!audio.muted);
    if (photo && input.hit('BracketLeft')) { rig.baseFov = Math.max(15, rig.baseFov - 5); camera.fov = rig.baseFov; camera.updateProjectionMatrix(); }
    if (photo && input.hit('BracketRight')) { rig.baseFov = Math.min(90, rig.baseFov + 5); camera.fov = rig.baseFov; camera.updateProjectionMatrix(); }
    weather.update(dt);
    tod.overcast = weather.cover * 0.9;
    player.rainWet = weather.wet * 0.85;
    tod.update(dt);
    // in the free camera WASD flies the camera; scripted actions (harness) always drive the player
    const playerIntent = rig.mode === 'free' && !input.scripted ? { ...intent, moveX: 0, moveY: 0, jump: false } : intent;
    player.update(dt, playerIntent, rig.yaw);
    rig.update(dt, rig.mode === 'follow' || rig.mode === 'free' ? intent : { ...intent, lookX: 0, lookY: 0 }, player.pos, player.speed);
    ocean.sim.setProbe(0, player.pos.x, player.pos.z);
    for (const b of village.boats) if (b.probe > 0) ocean.sim.setProbe(b.probe, b.x, b.z);
    atmo.camHeight.value = Math.max(1, camera.position.y);
    atmo.time.value = t;
    terrainU.time.value = t;
    wetness.time.value = t;
    oceanU.time.value = t;
    grade.exposure.value = tod.exposure * (1 + weather.flash * 2.5);
    audio.update(dt, camera, { night: tod.night, rain: weather.rain, wind: weather.wind, underwater: camera.position.y < player.waterLevel - 0.05 });
    camera.updateMatrixWorld();
    terrain.update(camera, Q.shadowFar);
    veg.update(camera, 60);
    vegU.time.value = t;
    river.update(t);
    village.update(t, (i) => ocean.sim.probe(i));
    lighthouse.update(dt, tod.night);
    hud.update(dt, player.pos.x, player.pos.z, tod.hour, weather.kind);
    vegU.sunColor.value.copy(sunLight.color).multiplyScalar(sunLight.intensity);
    sky.update(dt, scene);
    ocean.update(renderer, camera, t, dt);
  });

  // stream the terrain layer textures after the first frames
  let streaming = 3;
  rocksReady.then(() => streaming--);
  const done = () => streaming--;
  terrainM.loadLayers().then(done, (e) => {
    console.warn('terrain layers', e);
    done();
  });
  veg.loadTextures().then(done, (e) => {
    console.warn('foliage textures', e);
    done();
  });

  loading.status('Compiling shaders');
  loading.progress(0.85);
  await engine.measureRefresh();
  sky.update(0, scene, true);
  if (sky.envRT) river.setEnvironment(sky.envRT.texture);
  terrain.update(camera, Q.shadowFar);
  veg.update(camera, 60, true);
  await renderer.compileAsync(scene, camera);
  engine.start();
  Object.assign(ctx, {
    hf, terrain, sky, csm, ocean, player, cameraRig: rig, input, colliders, veg, village, lighthouse, weather, audio, hud,
    rts: { transmittance: transmittanceRT, skyView: skyViewRT, cloud: cloudRT },
    isBusy: () => streaming > 0 || assetProgress.pending > assetProgress.done,
  });
  // authored establishing cameras per spot (the harness's camera: 'shot')
  const H = (x: number, z: number) => Math.max(hf.height(x, z), 0);
  const gy = lighthouse.galleryY;
  ctx.shotPoses = {
    beach: { pos: [584, H(584, 64) + 2.4, 64], target: [652, 2.2, 18], fov: 55 },
    jungle: { pos: [358, H(358, 32) + 1.8, 32], target: [376, H(376, 4) + 4.5, 4], fov: 60 },
    waterfall: { pos: [186, H(186, -42) + 1.7, -42], target: [147, hf.meta.falls.bottom + (hf.meta.falls.top - hf.meta.falls.bottom) * 0.47, -55], fov: 58 },
    village: { pos: [-428, H(-428, 352) + 2.6, 352], target: [-470, 3.5, 306], fov: 55 },
    // from a boat off the north coast, along the 50-80 m sea cliffs
    cliffs: { pos: [-90, 5, -660], target: [-330, 35, -600], fov: 55 },
    lighthouse: { pos: [-294.5, gy + 1.75, -294.8], target: [40, 40, 120], fov: 60 },
  };
  ctx.forceRefresh = () => {
    veg.update(camera, 60, true);
    sky.update(0, scene, true);
  };
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

/** a copy of the geometry with every attribute as plain (de-normalized, de-interleaved) Float32 */
function toFloatGeometry(src: THREE.BufferGeometry) {
  const geo = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(src.attributes)) {
    const n = a.count, k = a.itemSize;
    const f = new Float32Array(n * k);
    const get = [a.getX, a.getY, a.getZ, a.getW];
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) f[i * k + c] = get[c].call(a, i);
    geo.setAttribute(name, new THREE.BufferAttribute(f, k));
  }
  if (src.index) geo.setIndex(src.index.clone());
  return geo;
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('load-status');
  if (el) el.textContent = `Error: ${e?.message ?? e}`;
  (window as unknown as { __island?: { error?: string } }).__island = { error: String(e?.stack ?? e) };
});
