import * as THREE from 'three/webgpu';
import { SunShadowNode, addSunOcclusion } from './sky/SunShadow';
import { Engine, grade } from './core/Engine';
import { params, TOD_PRESETS } from './core/params';
import { Q, preset, gpuName } from './core/quality';
import { initAssets, progress as assetProgress, loadGLTF } from './core/Assets';
import { Heightfield } from './world/Heightfield';
import { Terrain } from './world/Terrain';
import { createTerrainMaterial, terrainU } from './world/TerrainMaterial';
import { Sky, cloudRT, cloudShadow } from './sky/Sky';
import { TimeOfDay } from './sky/TimeOfDay';
import { aerialFogNode, atmo, transmittanceRT, skyViewRT } from './sky/Atmosphere';
import { Loading } from './ui/Loading';
import { installHarness, type Ctx } from './debug/harness';
import { SPOTS, LIGHTHOUSE, HALF_WORLD, WORLD_SIZE } from './world/layout';
import { wetness } from './world/weatherUniforms';
import { Ocean, oceanU } from './water/Ocean';
import { Spray, sprayU } from './water/Spray';
import { toFloatGeometry, setPlantSkyMaps } from './veg/glb';
import { setSunLight } from './core/lighting';
import { Colliders } from './world/Colliders';
import { Input } from './player/Input';
import { CameraRig } from './player/CameraRig';
import { Player } from './player/Player';
import { Vegetation, vegU } from './veg/Vegetation';
import { buildCanopy } from './veg/Canopy';
import { Hud } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { River } from './water/River';
import { Village } from './world/Village';
import { Lighthouse } from './world/Lighthouse';
import { RockKit, planRocks } from './world/RockKit';
import { Weather } from './sky/Weather';
import { AudioSystem } from './audio/Audio';
import { mark, timeline } from './core/timeline';

/** diagnostics: ?skip=terrain,ocean,oceansim,river,village,lighthouse,veg,canopy leaves those systems out */
const skip = new Set((new URLSearchParams(location.search).get('skip') ?? '').split(','));

async function boot() {
  mark('boot');
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
  // the rock kit's layout reshapes the sea rocks and moves the waterline, so it comes before anything reads them
  const rockPlan = planRocks(hf);
  mark('heightfield');

  // ---- light and sky
  loading.status('Lighting the sky');
  const sunLight = new THREE.DirectionalLight(0xffffff, 10);
  sunLight.castShadow = !new URLSearchParams(location.search).has('noshadow');
  sunLight.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  sunLight.shadow.camera.near = 1;
  // the cascades sit lightMargin (400 m) toward the sun from their receivers and need their own depth beyond that;
  // a longer box only adds casters behind the receivers (with a low sun: whole strips of the island, the village)
  sunLight.shadow.camera.far = 1100;
  sunLight.shadow.bias = -0.0003;
  sunLight.shadow.normalBias = 0.5;
  // the sun's shadow: the cascades near the camera, times the clouds' shadows everywhere
  addSunOcclusion((p) => cloudShadow(p));
  const csm = new SunShadowNode(sunLight, { cascades: Q.cascades, maxFar: Q.shadowFar, mode: 'practical', lightMargin: 400 });
  csm.fade = true;
  sunLight.shadow.shadowNode = csm;
  scene.add(sunLight, sunLight.target);
  setSunLight(sunLight);

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
  if (!skip.has('terrain')) scene.add(terrain.mesh);
  loading.status('Filling the sea');
  const ocean = new Ocean(hf);
  if (!new URLSearchParams(location.search).has('noocean') && !skip.has('ocean')) scene.add(ocean.mesh);
  const spray = new Spray(hf);
  if (!skip.has('spray')) scene.add(spray.sprite);

  // ---- fresh water
  const river = new River(hf);
  if (!skip.has('river')) scene.add(river.group);

  // ---- the village and the lighthouse
  loading.status('Building the village');
  const village = new Village(hf, colliders);
  village.build();
  if (!skip.has('village')) scene.add(village.group);
  const lighthouse = new Lighthouse(hf, colliders);
  if (!skip.has('lighthouse')) scene.add(lighthouse.group);

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
  setPlantSkyMaps(hf.mask0Tex, hf.heightTex, HALF_WORLD, WORLD_SIZE);
  const veg = new Vegetation(hf, colliders);
  const tv = performance.now();
  veg.build();
  // the plants (helpers' GLBs) load and scatter while the rest of the island comes up
  const plantsReady = veg.buildGlb().then(() => {
    console.log(`plants in ${(performance.now() - tv).toFixed(0)} ms`);
    mark('plants');
  }, (e) => console.warn('plants', e));
  mark('vegetation built');
  if (!skip.has('veg')) scene.add(veg.group);
  if (!skip.has('canopy')) scene.add(buildCanopy(hf, renderer));
  // rocks stream in with the props
  const rocksReady = (async () => {
    const out: { geometry: THREE.BufferGeometry; material: THREE.Material; radius: number; big: boolean }[] = [];
    const tinted = new Set<THREE.Material>();
    // tints take each scan's mean albedo (namaqualand 0.37/0.26/0.15, moss 0.05/0.03/0.015 linear) to the island's
    // dark grey basalt (~0.07) so they match the cliff rock; the moss keeps some of its green
    for (const [name, big, tint] of [['rock_moss_set_01', false, [1.0, 1.15, 1.4]], ['namaqualand_boulder_05', true, [0.19, 0.26, 0.44]]] as [string, boolean, [number, number, number]][]) {
      const g = await loadGLTF(`assets/props/${name}.glb`);
      g.scene.updateMatrixWorld(true);
      let kept = 0;
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // three of the moss set's six rocks: each kept rock is its own species (draw calls in every pass)
        if (!big && kept++ % 2 === 1) return;
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
    mark('rocks');
  })().catch((e) => console.warn('rocks', e));
  // cliff faces, sea stacks and the gorge of the falls
  const kit = new RockKit(rockPlan, colliders);
  if (!skip.has('rockkit')) scene.add(kit.group);
  const kitReady = kit.load().then(() => mark('rock kit'), (e) => console.warn('rock kit', e));

  // ---- player and camera
  loading.status('Waking the traveller');
  const input = new Input(renderer.domElement);
  const player = new Player(hf, colliders);
  const playerLoad = player.load();
  scene.add(player.root, player.shadows);
  const rig = new CameraRig(camera, {
    // walkable surfaces count only below the camera (a gallery deck overhead is not ground)
    groundAt: (x, z, y = 1e9) => Math.max(hf.height(x, z), colliders.surfaceAt(x, z, y + 0.3)?.y ?? -1e9),
    raycast: (f, d, m) => colliders.raycast(f, d, m),
    interior: (p, pos, target) => lighthouse.interiorCamera(p, pos, target),
  });
  player.seaAt = (x, z) => ocean.surfaceAt(x, z, 0);
  player.onStep = (e) => audio.step(e);
  player.onSplash = (s, p) => audio.splash(s, p);
  const spot = SPOTS.find((s) => s.name === (params.spot ?? 'beach')) ?? SPOTS[0];
  await playerLoad;
  mark('character');
  loading.progress(0.6);
  player.place(spot.player[0], spot.player[1], spot.yaw, spot.player[2] ?? 1e9);
  rig.snapBehind(spot.yaw);

  // ---- camera override from the URL: cam=orbit | free | x,y,z,tx,ty,tz
  if (params.cam) {
    const parts = params.cam.split(',').map(Number);
    if (parts.length === 6 && parts.every(Number.isFinite)) rig.set({ pos: parts.slice(0, 3), target: parts.slice(3) });
    else rig.set(params.cam);
  }

  engine.setupPost();
  const hud = new Hud(params.hud);
  const dbg = new DebugOverlay({
    adapter: gpuName || engine.adapterInfo.description || engine.adapterInfo.vendor || 'unknown GPU',
    backend: engine.backendName,
    preset,
    stats: () => engine.stats(),
    extra: () => ({
      pos: player.pos.toArray().map((v) => v.toFixed(1)).join(' '),
      player: `${player.state_().state} · ${player.surface} · ${player.speed.toFixed(1)} m/s`,
      time: `${tod.hour.toFixed(2)} h${tod.frozen ? ' (frozen)' : ''}`,
      weather: `${weather.kind} · rain ${weather.rain.toFixed(2)} · wind ${weather.wind.toFixed(2)}`,
      veg: `${veg.visible} instances`,
    }),
  }, params.debug);
  let photo = false;
  const setPhoto = (on: boolean) => {
    photo = on;
    hud.photo(on);
    rig.set(on ? 'free' : 'follow');
  };
  if (params.photo) setPhoto(true);

  // ---- frame
  let canopyK = 0, glareK = 0;
  const fwd = new THREE.Vector3();
  engine.addUpdater((dt, t) => {
    const intent = input.read(dt);
    if (input.hit('KeyP') || input.hit('KeyF')) setPhoto(!photo);
    if (input.hit('KeyM')) audio.mute(!audio.muted);
    if (photo && input.hit('BracketLeft')) { rig.baseFov = Math.max(15, rig.baseFov - 5); camera.fov = rig.baseFov; camera.updateProjectionMatrix(); }
    if (photo && input.hit('BracketRight')) { rig.baseFov = Math.min(90, rig.baseFov + 5); camera.fov = rig.baseFov; camera.updateProjectionMatrix(); }
    // the near cascade renders every frame, the middle and far ones take turns (a frame of lag there is invisible
    // and it saves a third of the shadow cost; a cascade's lookup matrix only changes when its map is redrawn)
    const cascades = (csm as unknown as { lights: THREE.DirectionalLight[] }).lights;
    if (cascades && cascades.length >= 3) {
      for (let i = 1; i < cascades.length; i++) cascades[i].shadow.autoUpdate = false;
      cascades[1 + (engine.frame % (cascades.length - 1))].shadow.needsUpdate = true;
    }
    // normal offset in proportion to each cascade's texel size: a few centimetres near the camera, so shadows stay
    // attached to feet and trunks, half a metre in the far cascade where the texels are ~30 cm
    if (cascades) cascades.forEach((l, i) => (l.shadow.normalBias = [0.035, 0.14, 0.5][Math.min(i, 2)]));
    weather.update(dt);
    tod.overcast = weather.cover * 0.9;
    player.rainWet = weather.wet * 0.85;
    tod.update(dt);
    // in the free camera WASD flies the camera; scripted actions (harness) always drive the player
    const playerIntent = rig.mode === 'free' && !input.scripted ? { ...intent, moveX: 0, moveY: 0, jump: false } : intent;
    player.update(dt, playerIntent, rig.yaw);
    rig.update(dt, rig.mode === 'follow' || rig.mode === 'free' ? intent : { ...intent, lookX: 0, lookY: 0 }, player.pos, player.speed, player.heading);
    ocean.sim.setProbe(0, player.pos.x, player.pos.z);
    for (const b of village.boats) if (b.probe > 0) ocean.sim.setProbe(b.probe, b.x, b.z);
    atmo.camHeight.value = Math.max(1, camera.position.y);
    atmo.time.value = t;
    terrainU.time.value = t;
    wetness.time.value = t;
    oceanU.time.value = t;
    // exposure is metered for open ground: under the canopy at night the eye opens up further; looking into a low
    // sun (sunrise, sunset) the bright half of the view sets it, as a centre-weighted camera meter would
    const under = camera.position.y < hf.height(camera.position.x, camera.position.z) + 18 ? hf.forest(camera.position.x, camera.position.z) : 0;
    canopyK += (under - canopyK) * (1 - Math.exp(-dt * 2.0));
    camera.getWorldDirection(fwd);
    const sd = atmo.sunDir.value as THREE.Vector3;
    const facing = (fwd.x * sd.x + fwd.z * sd.z) / ((Math.hypot(fwd.x, fwd.z) || 1) * (Math.hypot(sd.x, sd.z) || 1));
    const glare = THREE.MathUtils.smoothstep(facing, 0.2, 0.92) * (1 - THREE.MathUtils.smoothstep(sd.y, 0.12, 0.45)) * (sd.y > -0.04 ? 1 : 0) * (1 - weather.cover);
    glareK += (glare - glareK) * (1 - Math.exp(-dt * 2.0));
    grade.exposure.value = tod.exposure * (1 + weather.flash * 2.5) * (1 + canopyK * 2.0 * tod.night) * (1 - 0.6 * glareK);
    audio.update(dt, camera, { night: tod.night, rain: weather.rain, wind: weather.wind, underwater: camera.position.y < player.waterLevel - 0.05 });
    camera.updateMatrixWorld();
    terrain.update(camera, Q.shadowFar);
    veg.update(camera, 60);
    kit.update(camera);
    vegU.time.value = t;
    river.update(t);
    village.update(t, (i) => ocean.sim.probe(i), tod.night);
    lighthouse.update(dt, tod.night);
    hud.update(dt, player.pos.x, player.pos.z, tod.hour, weather.kind);
    dbg.update(dt);
    vegU.sunColor.value.copy(sunLight.color).multiplyScalar(sunLight.intensity);
    // the farthest shadow cascade (texels of tens of cm, moving cm per frame) renders every other frame
    const farCascade = (csm as unknown as { lights?: THREE.DirectionalLight[] }).lights?.[Q.cascades - 1];
    if (farCascade && Q.cascades > 1) {
      farCascade.shadow.autoUpdate = false;
      if (engine.frame % 2 === 0) farCascade.shadow.needsUpdate = true;
    }
    const wdir = wetness.windDir.value as THREE.Vector2;
    sky.setDrift(wdir.x, wdir.y, t, tod.hour);
    sky.update(dt, scene);
    if (!skip.has('oceansim')) ocean.update(renderer, camera, t, dt);
    spray.update(dt, camera);
    (sprayU.sun.value as THREE.Color).copy(sunLight.color).multiplyScalar(sunLight.intensity);
  });

  // stream the terrain layer textures after the first frames
  let streaming = 3;
  rocksReady.then(() => streaming--);
  const done = () => streaming--;
  terrainM.loadLayers().then(() => { mark('terrain layers'); done(); }, (e) => {
    console.warn('terrain layers', e);
    done();
  });
  veg.loadTextures().then(() => { mark('foliage textures'); done(); }, (e) => {
    console.warn('foliage textures', e);
    done();
  });

  loading.status('Growing the jungle');
  await Promise.all([plantsReady, kitReady]);
  await veg.addLedges(kit.ledges).catch((e) => console.warn('ledge plants', e));
  loading.status('Compiling shaders');
  loading.progress(0.85);
  await engine.measureRefresh();
  sky.update(0, scene, true);
  if (sky.envRT) river.setEnvironment(sky.envRT.texture);
  terrain.update(camera, Q.shadowFar);
  veg.update(camera, 60, true);
  // No compileAsync: in three r186 the pipelines it builds do not match the ones the post pipeline's MRT pass uses
  // on the first frame (their uniform grouping differs), so it doubled the start-up. The first frame compiles the
  // shaders once, behind the loading screen, which stays up until that frame has been presented.
  mark('scene ready');
  // the priming frames draw everything once, out of view or not (frustum culling off), so every pipeline compiles
  // behind the loading screen instead of stalling the first time the falls, the village or the lighthouse come into
  // view. A batch at a time: every mesh starts on the layer of its batch (by material) and the camera and the sun's
  // shadow cameras see one more layer each frame, so a frame compiles only the pipelines its batch adds; no frame
  // stalls for long, and the bar moves with the real progress between them.
  const unculled: THREE.Object3D[] = [];
  const parts: { o: THREE.Object3D; mask: number }[] = [];
  const byMaterial = new Map<string, THREE.Object3D[]>();
  // (not compileAsync: in three r186 its pipelines do not match the ones the post chain's scene pass uses, even with
  // that pass's render target and MRT bound, so every one compiled twice and the start-up doubled)
  scene.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh && !(o as THREE.Sprite).isSprite) return;
    if (o.frustumCulled) {
      o.frustumCulled = false;
      unculled.push(o);
    }
    parts.push({ o, mask: o.layers.mask });
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    const key = Array.isArray(mat) ? mat.map((x) => x.uuid).join() : mat?.uuid ?? o.uuid;
    (byMaterial.get(key) ?? byMaterial.set(key, []).get(key)!).push(o);
  });
  const groups = [...byMaterial.values()];
  const batches = Math.max(1, Math.min(30, groups.length));
  groups.forEach((g, i) => {
    for (const o of g) o.layers.set(1 + Math.floor((i * batches) / groups.length));
  });
  const viewers = () => [camera, sunLight.shadow.camera, ...((csm as unknown as { lights?: THREE.DirectionalLight[] }).lights ?? []).map((l) => l.shadow.camera)];
  const viewMasks = viewers().map((c) => c.layers.mask);
  const seeUpTo = (b: number) => {
    for (const c of viewers()) c.layers.mask = 2 ** (b + 2) - 1;
  };
  seeUpTo(0);
  veg.prime = weather.prime = lighthouse.prime = kit.prime = batches + 3;
  rocksReady.then(() => (veg.prime = 3));
  engine.start();
  Object.assign(ctx, {
    hf, terrain, sky, csm, ocean, spray, player, playerObj: player, cameraRig: rig, input, colliders, veg, kit, village, lighthouse, weather, audio, hud, dbg,
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
    // from the end of the main jetty back along its planks, past the moored canoes, to the huts and the palms
    village: { pos: [-447.5, 3.35, 390], target: [-466, 3.2, 300], fov: 58 },
    // from a boat off the north coast, along the 50-80 m sea cliffs
    cliffs: { pos: [-90, 5, -660], target: [-330, 35, -600], fov: 55 },
    // standing on the gallery inside the railing, looking out over the island to the beach and the sea
    lighthouse: { pos: [LIGHTHOUSE.p[0] + Math.cos(0.9) * 2.45, gy + 1.62, LIGHTHOUSE.p[1] + Math.sin(0.9) * 2.45], target: [40, 30, 120], fov: 62 },
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
  ctx.timeline = timeline;
  // the first frames compile every pipeline, a batch per frame: the loading screen stays up until they are presented
  const frame = async () => {
    const f = engine.frame;
    while (engine.frame <= f) await new Promise((r) => setTimeout(r, 4));
  };
  const slow: string[] = [];
  for (let b = 0; b < batches; b++) {
    seeUpTo(b);
    const t = performance.now();
    await frame();
    const ms = performance.now() - t;
    if (params.test && ms > 300) {
      const names = new Set<string>();
      groups.forEach((g, i) => {
        if (1 + Math.floor((i * batches) / groups.length) !== b + 1) return;
        for (const o of g) names.add(((o as THREE.Mesh).material as THREE.Material)?.name || o.name);
      });
      slow.push(`${(ms / 1000).toFixed(1)}s ${b === 0 ? '(first frame: post, sky, sea) ' : ''}${[...names].slice(0, 6).join(' ')}`);
    }
    loading.status(`Preparing shaders ${b + 1} / ${batches}`);
    loading.progress(0.86 + (0.12 * (b + 1)) / batches);
  }
  if (slow.length) console.info(`[island] slow shader batches: ${slow.join(' | ')}`);
  for (const { o, mask } of parts) o.layers.mask = mask;
  viewers().forEach((c, i) => (c.layers.mask = viewMasks[i] ?? 1));
  await frame();
  await frame();
  for (const o of unculled) o.frustumCulled = true;
  loading.progress(1);
  mark('first frame');
  setTimeout(() => loading.done(), 250);
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('load-status');
  if (el) el.textContent = `Error: ${e?.message ?? e}`;
  (window as unknown as { __island?: { error?: string } }).__island = { error: String(e?.stack ?? e) };
});
