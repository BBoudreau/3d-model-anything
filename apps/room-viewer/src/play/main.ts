import { appURL } from '../asset-base';
import * as THREE from 'three';
import { ROOMS, roomById } from '../../../../demos/index';
import { configureRenderer } from '../../../../packages/room-runtime/lighting';
import { setMaxAnisotropy } from '../../../../packages/room-runtime/materials';
import { applyRoomRendering, createPipeline, precompileRoomRendering } from '../../../../packages/room-runtime/render';
import { loadRapier, Physics } from '../../../../packages/room-physics/physics';
import { Impacts } from '../../../../packages/room-physics/audio';
import { Slingshot } from './slingshot';
import { FirstPerson } from './first-person';
import { Hockey } from './hockey';
import { Glass } from './glass';
import { DynamicShadows } from '../../../../packages/room-runtime/dynamic-shadows';

const q = new URLSearchParams(location.search);
if (import.meta.hot && q.get('hmr') === '0') import.meta.hot.on('vite:beforeFullReload', () => new Promise(() => {}));
const roomModule = roomById(q.get('room'));
const roomId = roomModule.id;
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const loader = document.querySelector<HTMLElement>('#loader')!;
const menu = document.querySelector<HTMLElement>('#start')!;
const toolbar = document.querySelector<HTMLElement>('#play-toolbar')!;
const interaction = document.querySelector<HTMLElement>('#interaction')!;
const targetName = document.querySelector<HTMLElement>('#target-name')!;
const actionHint = document.querySelector<HTMLElement>('#action-hint')!;
const statsEl = document.querySelector<HTMLElement>('#stats')!;
const quality = document.querySelector<HTMLSelectElement>('#play-quality')!;
const roomSelect = document.querySelector<HTMLSelectElement>('#room-select')!;
for (const r of ROOMS) roomSelect.add(new Option(r.label, r.id, false, r.id === roomId));
roomSelect.addEventListener('change', () => { location.href = `?room=${roomSelect.value}&mode=${fpv.active ? 'fpv' : 'playground'}`; });
document.querySelector('#room-name')!.textContent = roomModule.label;
menu.querySelector<HTMLAnchorElement>('.back a')!.href = appURL(`?room=${roomId}`);
function progress(message: string, amount: number) {
  loader.querySelector('.msg')!.textContent = message;
  loader.querySelector<HTMLElement>('.fill')!.style.width = `${amount * 100}%`;
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
renderer.setSize(innerWidth, innerHeight);
setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());
const scene = new THREE.Scene();
scene.background = new THREE.Color('#141915');
configureRenderer(renderer, scene);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, .05, 100);
const pipeline = createPipeline(renderer, scene, camera);
progress('Loading your playground…', .1);
const [R, room] = await Promise.all([loadRapier(), roomModule.build()]).catch(error => {
  progress(error instanceof Error ? error.message : 'Could not load the room. Reload to retry.', 0);
  const back = document.createElement('a'); back.href = appURL(''); back.textContent = 'Back to viewer'; loader.append(back);
  throw error;
});
scene.add(room.group, room.lights);
if (roomId === 'office-v4') {
  const { makeOfficeContentsThrowable } = await import('../../../../demos/office-v4/play-physics');
  makeOfficeContentsThrowable(room);
}
// Room-specific play tags (which pieces move), applied before batching.
room.preparePlay?.();
if (!q.has('nobatch')) room.optimize?.();
progress('Preparing room lighting…', .45);
await precompileRoomRendering(renderer, scene, room, camera);
applyRoomRendering(renderer, scene, room, pipeline, { bloom: false });
pipeline.ao = false;
renderer.shadowMap.autoUpdate = false;
const physics = new Physics(R, scene);
await physics.buildFromRoom(room, roomId, message => progress(message, .7));

const shadows = new DynamicShadows(room.lights, physics.things.map(t => t.obj));

// Throwing leaves the camera still; explicit pan and orbit gestures move the framing.
const target = new THREE.Vector3(...room.camera.target);
const panOffset = new THREE.Vector3();
const homeOffset = new THREE.Vector3(...room.camera.orbit).sub(target);
const offset = homeOffset.clone();
function frameRoom() {
  camera.aspect = innerWidth / innerHeight;
  if (document.body.dataset.playView === 'fpv') { camera.updateProjectionMatrix(); return; }
  camera.position.copy(target).add(panOffset).addScaledVector(offset, Math.max(1, 1.15 / camera.aspect));
  camera.lookAt(target.clone().add(panOffset));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  let cutawayChanged = false;
  for (const { def, group } of room.walls) {
    const midpoint = def.origin.clone().addScaledVector(def.u, def.length / 2);
    const visible = camera.position.clone().sub(midpoint).dot(def.n) > 0;
    cutawayChanged ||= group.visible !== visible;
    group.visible = visible;
  }
  for (const ceiling of room.ceiling) {
    const visible = camera.position.y < room.wallTop;
    cutawayChanged ||= ceiling.visible !== visible;
    ceiling.visible = visible;
  }
  if (cutawayChanged) shadows.invalidateAll();
}
frameRoom();
const sling = new Slingshot(physics, camera, room.group);
const sound = new Impacts();
physics.onImpact = (thing, force) => sound.hit(String(thing.body.handle), thing.surface, (force / thing.mass - 22) / 250, thing.size);
let playing = true;
let dirty = true;
let pendingAim: { clientX: number; clientY: number } | undefined;
let tool: 'throw' | 'orbit' | 'pan' = 'throw';
let multiTouch = false;
let touchGesture: { x: number; y: number; distance: number } | undefined;
let cameraPointer: { id: number; x: number; y: number; mode: 'pan' | 'orbit' } | undefined;
let throws = 0;
const launched = new Set<number>();
const knocked = new Set<number>();
let roundStarted = false;
// The authored orbit-view walk point overlaps the v4 cabinet and plant colliders.
const walkStart = new THREE.Vector3(...room.camera.walk);
if (roomId === 'office-v4') walkStart.set(2.5, 1.6, 1.5);
const fpv = new FirstPerson(canvas, physics, camera, walkStart, new THREE.Vector3(...room.camera.walkLook), {
  start: startPlaying,
  pause,
  change: () => { dirty = true; },
  thrown: thing => { throws++; launched.add(thing.body.handle); roundStarted = true; score(); },
  error: message => { pause(); document.querySelector('#lock-error')!.textContent = message; },
});
const hockey = new Hockey(physics, camera, scene, room, () => fpv.active ? 'fpv' : 'playground', () => fpv.player.collider);
hockey.onShot = puck => { throws++; launched.add(puck.body.handle); roundStarted = true; score(); };
// Breakable panes (rooms tag them in preparePlay); a shattered pane scores once, its shards don't.
const glass = new Glass(physics, scene, room, hockey);
glass.onShatter = (pane, shards) => {
  knocked.add(-1 - pane.id);
  for (const s of shards) launched.add(s.body.handle);
  roundStarted = true;
  score();
  sound.hit(`pane-${pane.id}`, 'glass', 1, .6);
  dirty = true;
};
// Room extras that need the running play scene (the room module supplies them, if any).
const fun = await room.playExtras?.({ physics, scene, hockey, glass });
const hockeyButton = document.querySelector<HTMLButtonElement>('#hockey-toggle')!;
function setHockey(on: boolean) {
  cancelAim();
  hockey.setEnabled(on);
  hockeyButton.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('hockey', on);
  const url = new URL(location.href);
  if (on) url.searchParams.set('hockey', '1'); else url.searchParams.delete('hockey');
  history.replaceState(null, '', url);
  dirty = true;
}
hockeyButton.addEventListener('click', () => { setHockey(!hockey.enabled); canvas.focus({ preventScroll: true }); });
window.addEventListener('keydown', event => {
  if (event.code !== 'KeyH' || event.repeat || event.metaKey || event.ctrlKey || event.altKey || !playing) return;
  if (event.target instanceof HTMLElement && event.target.matches('select, input, textarea')) return;
  setHockey(!hockey.enabled);
});
function setHockeyCursor(event: { clientX: number; clientY: number }) {
  const rect = canvas.getBoundingClientRect();
  hockey.cursor.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
}
// First person: with the stick out, left click shoots instead of grabbing (runs before FirstPerson's handler).
window.addEventListener('mousedown', event => {
  if (!fpv.active || !fpv.running || !hockey.enabled || event.button !== 0 || fpv.hands.held) return;
  event.preventDefault(); event.stopPropagation();
  hockey.windup();
}, true);
window.addEventListener('mouseup', event => {
  if (!fpv.active || !hockey.winding || event.button !== 0) return;
  let ndc: THREE.Vector2 | undefined;
  if (fpv.freeCursor) { setHockeyCursor(event); ndc = hockey.cursor; }
  hockey.shoot(ndc);
  dirty = true;
}, true);
function setView(firstPerson: boolean) {
  cancelCameraDrag(); cancelAim();
  fpv.setActive(firstPerson);
  document.body.dataset.playView = firstPerson ? 'fpv' : 'playground';
  document.querySelectorAll<HTMLButtonElement>('button[data-play-view]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.playView === 'fpv') === firstPerson)));
  document.querySelector('#menu-title')!.textContent = firstPerson ? 'Step inside your office.' : 'Click. Throw.';
  document.querySelector('#go')!.textContent = firstPerson ? 'Enter office' : 'Back to throwing';

  document.querySelector('#lock-error')!.textContent = '';
  camera.fov = firstPerson ? 75 : 55;
  camera.updateProjectionMatrix();
  if (firstPerson) {
    room.walls.forEach(w => { w.group.visible = true; });
    room.ceiling.forEach(c => { c.visible = true; });
    shadows.invalidateAll();
    pause();
  } else { frameRoom(); startPlaying(); }
  const url = new URL(location.href); url.searchParams.set('mode', firstPerson ? 'fpv' : 'playground'); history.replaceState(null, '', url);
  dirty = true;
}
document.querySelectorAll<HTMLButtonElement>('button[data-play-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.playView === 'fpv')));
const throwsEl = document.querySelector('#throws')!;
const knockedEl = document.querySelector('#knocked')!;
function score() {
  throwsEl.textContent = String(throws);
  knockedEl.textContent = String(knocked.size);
}
function cancelCameraDrag() {
  const id = cameraPointer?.id;
  cameraPointer = undefined;
  if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  canvas.classList.remove('panning');
}
function pan(dx: number, dy: number) {
  const distance = camera.position.distanceTo(target.clone().add(panOffset));
  const scale = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / canvas.clientHeight;
  panOffset.addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), -dx * scale);
  panOffset.addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), dy * scale);
  frameRoom();
  dirty = true;
}
function orbit(dx: number, dy: number) {
  const spherical = new THREE.Spherical().setFromVector3(offset);
  const speed = 2 * Math.PI / canvas.clientHeight;
  spherical.theta -= dx * speed;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi - dy * speed, .12, Math.PI / 2 - .05);
  offset.setFromSpherical(spherical);
  frameRoom();
  dirty = true;
}
function zoom(factor: number) {
  const distance = THREE.MathUtils.clamp(offset.length() * factor, .35, Math.max(40, homeOffset.length() * 4));
  offset.setLength(distance);
  frameRoom();
  dirty = true;
}
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => {
  button.addEventListener('click', () => {
    cancelCameraDrag(); cancelAim();
    tool = button.dataset.tool as typeof tool;
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  });
});
document.querySelector('#zoom-in')!.addEventListener('click', () => { cancelAim(); zoom(.8); });
document.querySelector('#zoom-out')!.addEventListener('click', () => { cancelAim(); zoom(1.25); });
function centerView() {
  cancelCameraDrag();
  cancelAim();
  panOffset.set(0, 0, 0);
  offset.copy(homeOffset);
  frameRoom();
  dirty = true;
}
document.querySelector('#center-view')!.addEventListener('click', centerView);
function cancelAim() {
  pendingAim = undefined;
  sling.cancel();
  canvas.classList.remove('aiming');
  dirty = true;
}
function pause() {
  fpv.stop();
  document.querySelector<HTMLElement>('#crosshair')!.hidden = true;
  multiTouch = false; touchGesture = undefined;
  cancelCameraDrag();
  cancelAim();
  playing = false;
  menu.hidden = false;
  toolbar.hidden = interaction.hidden = true;
  document.querySelector<HTMLButtonElement>('#go')!.focus();
}
function resume() {
  document.querySelector('#lock-error')!.textContent = '';
  if (fpv.active) { sound.unlock(); fpv.lock(); }
  else startPlaying();
}
function startPlaying() {
  playing = true;
  document.querySelector<HTMLElement>('#crosshair')!.hidden = !fpv.active || fpv.freeCursor;
  menu.hidden = true;
  toolbar.hidden = interaction.hidden = false;
  canvas.focus({ preventScroll: true });
  dirty = true;
  sound.unlock();
}
function reset() {
  cancelCameraDrag();
  cancelAim();
  fpv.hands.clear();
  hockey.clear();
  glass.reset();
  fun?.reset();
  physics.resetAll();
  if (fpv.active) fpv.respawn();
  throws = 0;
  knocked.clear();
  launched.clear();
  roundStarted = false;
  score();
  shadows.invalidateAll();
  dirty = true;
}
document.querySelector('#pause')!.addEventListener('click', pause);
document.querySelector('#go')!.addEventListener('click', resume);
document.querySelectorAll('[data-reset]').forEach(button => button.addEventListener('click', reset));
const muteButton = document.querySelector<HTMLButtonElement>('#mute')!;
function updateMute() {
  muteButton.textContent = sound.muted ? 'Sound off' : 'Sound on';
  muteButton.setAttribute('aria-pressed', String(sound.muted));
}
updateMute();
muteButton.addEventListener('click', () => { sound.toggleMute(); updateMute(); });
function aim(event: { clientX: number; clientY: number }) {
  pendingAim = undefined;
  dirty = true;
  const rect = canvas.getBoundingClientRect();
  sling.aim(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
}
canvas.addEventListener('pointerdown', event => {
  if (fpv.active) return;
  if (!playing || multiTouch || cameraPointer) return;
  if (event.button === 2 || event.button === 1 || (event.button === 0 && (event.shiftKey || event.altKey || tool !== 'throw'))) {
    event.preventDefault();
    cancelAim();
    canvas.focus({ preventScroll: true });
    cameraPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, mode: event.button === 0 && (event.altKey || (!event.shiftKey && tool === 'orbit')) ? 'orbit' : 'pan' };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('panning');
    return;
  }
  if (event.button !== 0) return;
  event.preventDefault();
  canvas.focus({ preventScroll: true });
  sound.unlock();
  if (hockey.enabled) {
    setHockeyCursor(event);
    canvas.setPointerCapture(event.pointerId);
    hockey.windup();
    dirty = true;
    return;
  }
  aim(event);
  if (sling.begin()) {
    const thing = sling.release();
    cancelAim();
    if (thing) { throws++; launched.add(thing.body.handle); roundStarted = true; score(); }
  }
});
canvas.addEventListener('pointermove', event => {
  if (fpv.active) return;
  if (multiTouch) return;
  if (cameraPointer) {
    if (event.pointerId === cameraPointer.id) {
      const move = cameraPointer.mode === 'orbit' ? orbit : pan;
      move(event.clientX - cameraPointer.x, event.clientY - cameraPointer.y);
      cameraPointer.x = event.clientX; cameraPointer.y = event.clientY;
    }
    return;
  }
  if (!playing) return;
  if (hockey.enabled && tool === 'throw') { setHockeyCursor(event); dirty = true; return; }
  if (tool === 'throw') {
    pendingAim = { clientX: event.clientX, clientY: event.clientY };
    dirty = true;
  } else canvas.classList.add('grabbable');
});
canvas.addEventListener('pointerup', event => {
  if (fpv.active) return;
  if (event.pointerId === cameraPointer?.id) { cancelCameraDrag(); return; }
  if (hockey.winding && event.button === 0) {
    setHockeyCursor(event);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    hockey.shoot();
    dirty = true;
  }
});
canvas.addEventListener('pointercancel', event => { cancelAim(); if (event.pointerId === cameraPointer?.id) cancelCameraDrag(); });
canvas.addEventListener('lostpointercapture', event => { if (event.pointerId === cameraPointer?.id) cancelCameraDrag(); });
canvas.addEventListener('pointerleave', () => { if (!sling.selected) cancelAim(); });
canvas.addEventListener('contextmenu', event => event.preventDefault());
function touchPosition(touches: TouchList) {
  const a = touches[0], b = touches[1];
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) };
}
canvas.addEventListener('touchstart', event => {
  if (fpv.active) return;
  if (!playing || event.touches.length < 2) return;
  event.preventDefault();
  cancelAim(); cancelCameraDrag();
  multiTouch = true;
  touchGesture = touchPosition(event.touches);
}, { passive: false });
canvas.addEventListener('touchmove', event => {
  if (fpv.active) return;
  if (!playing || !multiTouch || event.touches.length < 2 || !touchGesture) return;
  event.preventDefault();
  const next = touchPosition(event.touches);
  pan(next.x - touchGesture.x, next.y - touchGesture.y);
  zoom(touchGesture.distance / next.distance);
  touchGesture = next;
}, { passive: false });
for (const name of ['touchend', 'touchcancel'] as const) canvas.addEventListener(name, event => {
  if (event.touches.length === 0) { multiTouch = false; touchGesture = undefined; }
});

canvas.addEventListener('wheel', event => {
  if (fpv.active) return;
  if (!playing || event.metaKey) return;
  event.preventDefault();
  if (cameraPointer) return;
  cancelAim();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
  if (event.shiftKey && !event.ctrlKey) {
    pan(-Math.max(-150, Math.min(150, event.deltaX * unit)), -Math.max(-150, Math.min(150, event.deltaY * unit)));
  } else {
    // Trackpad pinches arrive as Ctrl+wheel; ordinary wheels and scrolls zoom too.
    zoom(Math.exp(THREE.MathUtils.clamp(event.deltaY * unit, -150, 150) * (event.ctrlKey ? .01 : .003)));
  }
}, { passive: false });
window.addEventListener('keydown', event => {
  if (fpv.active) return;
  if (event.code === 'Escape') {
    event.preventDefault();
    if (cameraPointer) cancelCameraDrag();
    else if (sling.selected) cancelAim();
    else if (playing) pause();
    return;
  }
  if (!playing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target instanceof HTMLElement && event.target.matches('select, input, textarea')) return;
  const pans: Record<string, [number, number]> = { ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35] };
  if (pans[event.code]) { event.preventDefault(); cancelAim(); pan(...pans[event.code]); return; }
  if (['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract'].includes(event.code)) {
    event.preventDefault(); cancelAim(); zoom(['Equal', 'NumpadAdd'].includes(event.code) ? .9 : 1 / .9); return;
  }
  if (event.repeat) return;
  if (event.code === 'Home') { event.preventDefault(); centerView(); }
  if (event.code === 'KeyR') reset();
  if (event.code === 'Backquote') statsEl.hidden = !statsEl.hidden;
});
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

let renderRatio = Math.min(devicePixelRatio, 1);
function setRatio(ratio: number) {
  renderRatio = ratio;
  renderer.setPixelRatio(ratio);
  pipeline.setPixelRatio(ratio);
  dirty = true;
}
quality.addEventListener('change', () => {
  pipeline.ao = quality.value === 'detail';
  setRatio(Math.min(devicePixelRatio, pipeline.ao ? 1.5 : 1));
});
window.addEventListener('resize', () => {
  cancelCameraDrag();
  cancelAim();
  frameRoom();
  renderer.setSize(innerWidth, innerHeight);
  pipeline.setSize(innerWidth, innerHeight);
  dirty = true;
});

let frames = 0, fpsFrames = 0, fps = 0, fpsT0 = performance.now();
let physMs = 0, renderMs = 0, slowFrames = 0, fastFrames = 0;
let lastHint = '';
let wasMoving = false;
let lastRenderedAt = -Infinity;
THREE.DefaultLoadingManager.onLoad = () => { dirty = true; shadows.invalidateAll(); };
const timer = new THREE.Timer();
loader.classList.add('done');
toolbar.hidden = interaction.hidden = false;
setView(q.get('mode') !== 'playground');
if (q.get('hockey') === '1') setHockey(true);
statsEl.hidden = q.get('stats') !== '1';
renderer.setAnimationLoop(time => {
  timer.update(time);
  const dt = timer.getDelta();
  if (document.hidden || (!playing && !dirty)) return;
  const before = performance.now();
  const simulating = playing && (fpv.running || wasMoving || physics.things.some(t => !t.frozen && !t.body.isSleeping()));
  const moving = simulating ? physics.update(dt) : 0;
  physMs += (performance.now() - before - physMs) * .05;
  wasMoving = moving > 0;
  if (fpv.active && fpv.update()) dirty = true;
  if (hockey.update(dt)) dirty = true;
  if (fun?.update(dt)) dirty = true;
  if (pendingAim && playing) {
    aim(pendingAim);
    canvas.classList.toggle('grabbable', !!sling.hovered);
  }
  if (simulating || dirty) shadows.track();
  const refreshedShadows = shadows.flush(renderer, time, moving === 0);
  if (!dirty && !moving && !refreshedShadows) return;
  const consecutive = time - lastRenderedAt < 200;
  if (!consecutive) { slowFrames = fastFrames = 0; fpsT0 = time; fpsFrames = 0; }
  lastRenderedAt = time;
  dirty = false;
  if (roundStarted && playing && moving) {
    const beforeScore = knocked.size;
    for (const thing of physics.things) {
      if (launched.has(thing.body.handle) || knocked.has(thing.body.handle) || thing.obj.userData.noScore) continue;
      // A meaningful displacement or tip counts once per round; selected projectiles don't.
      if (thing.curr.p.distanceTo(thing.home.p) > .25 || thing.curr.q.angleTo(thing.home.q) > .6) knocked.add(thing.body.handle);
    }
    if (knocked.size !== beforeScore) score();
  }
  const hockeyHint = fpv.active ? 'Click: shoot a puck · Hold: wind up a slap shot · WASD: move · H: put the stick away · R: respawn · Esc: pause'
    : 'Click: shoot a puck at the cursor · Hold: wind up a slap shot · H: put the stick away · R: reset · Alt-drag: orbit · Right-drag: pan';
  const hint = hockey.enabled && (!fpv.active || (fpv.running && !fpv.hands.held)) ? hockeyHint : fpv.active ? fpv.freeCursor ? (fpv.hands.held ? 'Click: throw · E: drop · Right-drag: look · Scroll: hold distance' : 'Click an object nearby: throw · E: carry / drop · Right-drag: look · WASD: move · Esc: pause') : (fpv.hands.held ? 'Left click: throw · E / right click: drop · Scroll: hold distance' : 'WASD: move · Shift: sprint · Space: jump · C: crouch · Click: throw · E: carry / drop · Esc: pause') : sling.selected ? 'Click to throw'
    : sling.hovered ? 'Click to throw this object' : tool === 'throw' ? 'Click an object to throw · Alt-drag to orbit · Right-drag to pan · Scroll to zoom' : `Drag to ${tool} · Scroll / pinch to zoom · Home to reset view`;
  if (lastHint !== hint) { actionHint.textContent = hint; lastHint = hint; }
  const name = (fpv.active ? fpv.hands.held ?? fpv.hands.hovered : sling.selected ?? sling.hovered)?.name.replaceAll('-', ' ') ?? '';
  if (targetName.textContent !== name) targetName.textContent = name;

  if (quality.value === 'auto' && playing && consecutive && dt > 0 && dt < .2) {
    slowFrames = dt > 1 / 45 ? slowFrames + 1 : 0;
    fastFrames = dt < 1 / 57 ? fastFrames + 1 : 0;
    if (slowFrames >= 45 && renderRatio > .65) { setRatio(Math.max(.65, renderRatio - .15)); slowFrames = fastFrames = 0; }
    else if (fastFrames >= 240 && renderRatio < Math.min(devicePixelRatio, 1)) { setRatio(Math.min(devicePixelRatio, 1, renderRatio + .1)); slowFrames = fastFrames = 0; }
  }
  const renderStart = performance.now();
  

  pipeline.render();
  renderMs += (performance.now() - renderStart - renderMs) * .05;
  frames++; fpsFrames++;
  if (time - fpsT0 > 500) {
    fps = fpsFrames * 1000 / (time - fpsT0); fpsT0 = time; fpsFrames = 0;
    if (!statsEl.hidden) statsEl.textContent = `${fps.toFixed(0)} fps · physics ${physMs.toFixed(1)} ms · render ${renderMs.toFixed(1)} ms`;
  }
});

// Inspection API for physics checks and repeatable input tests.
Object.assign(window, { __play: {
  ready: true, room: roomId, physics, sling, shadows, fpv, camera, renderer, scene, hockey, glass, fun,
  setView, setHockey,
  get input() { return playing ? 'play' : 'menu'; },
  get effects() { return pipeline.ao; },
  get score() { return { throws, knocked: knocked.size }; },
  stats: () => ({ ...physics.stats, fps, physMs, renderMs, frames }),
  reset, start: resume, pause,
  fps(ms = 2000): Promise<number> {
    const start = performance.now(), frame = frames;
    return new Promise(resolve => setTimeout(() => resolve((frames - frame) * 1000 / (performance.now() - start)), ms));
  },
} });
