import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { BuiltRoom } from '../room-runtime/types';
import { decomposeCached } from './hull-cache';
import {
  autoTagConfig,
  guessSurface,
  isNamedObject,
  physicsTag,
  SURFACES,
  type AutoTagConfig,
  type PhysicsTag,
  type ShapeKind,
  type SurfaceKind,
} from './tagging';

export type Rapier = typeof RAPIER_NS;
export type World = RAPIER_NS.World;
export type RigidBody = RAPIER_NS.RigidBody;
export type Collider = RAPIER_NS.Collider;

export const FIXED_DT = 1 / 60;
export const GRAVITY = -9.81;

/** Collision groups (membership << 16 | filter) */
export const GROUP = {
  world: 0x0001,
  player: 0x0002,
  held: 0x0004,
};
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);
/** held objects don't collide with the player's capsule (you'd shove yourself around) */
export const HELD_GROUPS = groups(GROUP.held, 0xffff & ~GROUP.player);
export const DEFAULT_GROUPS = groups(GROUP.world, 0xffff);

export async function loadRapier(): Promise<Rapier> {
  const mod = await import('@dimforge/rapier3d-compat');
  const R = mod.default;
  await R.init();
  return R;
}

/** One dynamic rigid body driving one Object3D */
export interface DynamicThing {
  name: string;
  obj: THREE.Object3D;
  body: RigidBody;
  colliders: Collider[];
  mass: number;
  shape: ShapeKind;
  surface: SurfaceKind;
  auto: boolean;
  /** largest bounding-box side (m) */
  size: number;
  home: { p: THREE.Vector3; q: THREE.Quaternion };
  prev: { p: THREE.Vector3; q: THREE.Quaternion };
  curr: { p: THREE.Vector3; q: THREE.Quaternion };
  asleep: boolean;
  /**
   * Frozen things are fixed bodies until something disturbs them (grab, shove, the player walking
   * into them, or a moving thing hitting them). Rapier wakes sleeping bodies on any new contact,
   * even with static geometry, so without this the whole room would jiggle and settle at load.
   */
  frozen: boolean;
  /** Objects resting directly on top at home; never a symmetric overlap graph. */
  supported: DynamicThing[];
  wakeOnImpact: boolean;
  /** home bounds (world) */
  bounds: THREE.Box3;
}

export interface PhysicsStats {
  staticChunks: number;
  staticTriangles: number;
  staticMeshes: number;
  skippedMeshes: number;
  dynamic: number;
  autoTagged: number;
  buildMs: number;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mi = new THREE.Matrix4();

/** Visit every vertex of a mesh (instanced meshes: every instance) transformed by `M` */
function forEachVertex(mesh: THREE.Mesh, M: THREE.Matrix4, cb: (v: THREE.Vector3) => void) {
  const pos = mesh.geometry.getAttribute('position');
  if (!pos) return;
  const inst = mesh instanceof THREE.InstancedMesh ? mesh : undefined;
  const count = inst ? inst.count : 1;
  for (let k = 0; k < count; k++) {
    if (inst) {
      inst.getMatrixAt(k, _mi);
      _m.multiplyMatrices(M, _mi);
    } else _m.copy(M);
    for (let i = 0; i < pos.count; i++) cb(_v.fromBufferAttribute(pos, i).applyMatrix4(_m));
  }
}

/** Append a mesh's triangles (transformed by M) to flat vertex/index arrays */
function appendTriangles(mesh: THREE.Mesh, M: THREE.Matrix4, verts: number[], idx: number[]) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  if (!pos) return;
  const inst = mesh instanceof THREE.InstancedMesh ? mesh : undefined;
  const count = inst ? inst.count : 1;
  const index = g.index;
  // respect draw range / groups loosely: whole index
  for (let k = 0; k < count; k++) {
    if (inst) {
      inst.getMatrixAt(k, _mi);
      _m.multiplyMatrices(M, _mi);
    } else _m.copy(M);
    const base = verts.length / 3;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(_m);
      verts.push(_v.x, _v.y, _v.z);
    }
    if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) idx.push(base + i);
  }
}

/** World-space bounds of the meshes under `root`, skipping subtrees rejected by `skip` */
function meshBounds(root: THREE.Object3D, skip?: (o: THREE.Object3D) => boolean) {
  const box = new THREE.Box3();
  const b = new THREE.Box3();
  const visit = (o: THREE.Object3D) => {
    if (o !== root && skip?.(o)) return;
    if (!o.visible) return;
    if (o instanceof THREE.Mesh) {
      const g = o.geometry;
      if (o instanceof THREE.InstancedMesh) {
        o.computeBoundingBox();
        b.copy(o.boundingBox!).applyMatrix4(o.matrixWorld);
      } else {
        if (!g.boundingBox) g.computeBoundingBox();
        b.copy(g.boundingBox!).applyMatrix4(o.matrixWorld);
      }
      box.union(b);
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return box;
}

const materialsOf = (m: THREE.Mesh) => (Array.isArray(m.material) ? m.material : [m.material]);

/** Glows, halos, light cones, cables and crumbs don't get colliders */
function skipStaticMesh(mesh: THREE.Mesh, bounds: THREE.Box3): boolean {
  const mats = materialsOf(mesh);
  if (mats.every((m) => !m || !m.visible)) return true;
  if (mats.every((m) => m.blending === THREE.AdditiveBlending)) return true;
  if (mats.every((m) => m.transparent && m.opacity < 0.35)) return true;
  if (mats.every((m) => m instanceof THREE.MeshBasicMaterial && m.transparent && !m.depthWrite)) return true;
  if (/glow|halo|beam|cone|bloom|sprite|shadow-catcher/i.test(mesh.name)) return true;
  if (/cable|cord|wire/i.test(mesh.name)) return true;
  const size = bounds.getSize(_v);
  if (Math.max(size.x, size.y, size.z) < 0.012) return true;
  const g = mesh.geometry as THREE.BufferGeometry & { parameters?: { radius?: number } };
  if (g.type === 'TubeGeometry' && (g.parameters?.radius ?? 1) * mesh.getWorldScale(_v).x < 0.012) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Classification: walk the room once, sort every mesh into static / dynamic / none

interface DynamicCandidate {
  obj: THREE.Object3D;
  tag: PhysicsTag;
  auto: boolean;
  bounds: THREE.Box3;
}

function classify(room: BuiltRoom, roomId: string, cfg: AutoTagConfig) {
  const root = room.group;
  root.updateMatrixWorld(true);
  const wallGroups = new Set(room.walls.map((w) => w.group));
  const shellParts = new Set<THREE.Object3D>([...wallGroups, ...room.ceiling]);
  root.children.forEach((c) => {
    if (/^(floor|ceiling)$/i.test(c.name)) shellParts.add(c);
  });

  const dynamics: DynamicCandidate[] = [];
  const candidates: { obj: THREE.Object3D; bounds: THREE.Box3; chunk: THREE.Object3D }[] = [];
  /** static meshes, grouped by top-level chunk (one trimesh each) */
  const statics = new Map<THREE.Object3D, THREE.Mesh[]>();
  const addStatic = (chunk: THREE.Object3D, m: THREE.Mesh) => {
    let list = statics.get(chunk);
    if (!list) statics.set(chunk, (list = []));
    list.push(m);
  };

  // meshes under an explicitly-tagged dynamic node belong to its body; nested dynamic tags
  // (a book on a cart) start their own body
  const visit = (o: THREE.Object3D, chunk: THREE.Object3D, underWall: boolean, noAuto: boolean) => {
    if (!o.visible) return;
    if (o.userData.physicsChunk) chunk = o;
    const tag = physicsTag(o);
    if (tag?.type === 'none') return;
    if (o !== root && tag?.type === 'dynamic') {
      dynamics.push({ obj: o, tag, auto: false, bounds: meshBounds(o, (c) => !!physicsTag(c) && physicsTag(c)!.type !== 'static') });
      // find nested dynamic things
      const nested = (c: THREE.Object3D) => {
        for (const cc of c.children) {
          const t = physicsTag(cc);
          if (t?.type === 'none') continue;
          if (t?.type === 'dynamic') visit(cc, chunk, underWall, true);
          else nested(cc);
        }
      };
      nested(o);
      return;
    }
    const isStaticTag = tag?.type === 'static';
    const wall = underWall || wallGroups.has(o as THREE.Group);
    const inShell = shellParts.has(o);
    if (cfg.enabled && !noAuto && !isStaticTag && !wall && !inShell && o !== root && (cfg.requireName ? isNamedObject(o) : !o.name.includes(':')) && !cfg.exclude.test(o.name)) {
      const b = meshBounds(o, (c) => !!physicsTag(c));
      if (!b.isEmpty()) {
        const s = b.getSize(new THREE.Vector3());
        const max = Math.max(s.x, s.y, s.z);
        const thin = [s.x, s.y, s.z].filter((d) => d < cfg.minThickness).length >= 2 || Math.min(s.x, s.y, s.z) < 0.002;
        if (max <= cfg.maxSize && max >= cfg.minSize && !thin && !hasTaggedDescendant(o)) {
          candidates.push({ obj: o, bounds: b, chunk });
          return;
        }
      }
    }
    if (o instanceof THREE.Mesh) addStatic(chunk, o);
    for (const c of o.children) visit(c, o === root ? c : chunk, wall, noAuto || isStaticTag);
  };
  visit(root, root, false, false);

  return { dynamics, candidates, statics, wallGroups };
}

function hasTaggedDescendant(o: THREE.Object3D) {
  let found = false;
  o.traverse((c) => {
    if (c !== o && physicsTag(c)?.type === 'dynamic') found = true;
  });
  return found;
}

/** Is a candidate free-standing on something (not mounted on a wall or hanging in the air)? */
function supportTest(
  cand: { obj: THREE.Object3D; bounds: THREE.Box3 },
  others: THREE.Mesh[],
  room: BuiltRoom,
  cfg: AutoTagConfig,
): { ok: boolean; why: string } {
  const b = cand.bounds;
  // wall-mounted: hugging a wall plane, off the floor
  if (b.min.y > cfg.wallMountMinY) {
    for (const { def } of room.walls) {
      const n = def.n as THREE.Vector3;
      const o = def.origin as THREE.Vector3;
      const u = def.u as THREE.Vector3;
      let minD = Infinity;
      let along0 = Infinity;
      let along1 = -Infinity;
      for (const x of [b.min.x, b.max.x]) {
        for (const z of [b.min.z, b.max.z]) {
          _v.set(x - o.x, 0, z - o.z);
          minD = Math.min(minD, _v.x * n.x + _v.z * n.z);
          const a = _v.x * u.x + _v.z * u.z;
          along0 = Math.min(along0, a);
          along1 = Math.max(along1, a);
        }
      }
      if (minD < cfg.wallGap && along1 > 0 && along0 < def.length) return { ok: false, why: 'wall-mounted' };
    }
  }
  if (b.min.y < 0.02) return { ok: true, why: 'on the floor' };
  // rays straight down from the bottom center + four inset corners
  const ray = new THREE.Raycaster();
  ray.far = cfg.supportGap + 0.03;
  const own = new Set<THREE.Object3D>();
  cand.obj.traverse((c) => own.add(c));
  const near = others.filter((m) => {
    if (own.has(m)) return false;
    const mb = meshBoundsCache.get(m)!;
    return mb.max.y > b.min.y - cfg.supportGap - 0.03 && mb.min.y < b.min.y + 0.03 && mb.min.x < b.max.x && mb.max.x > b.min.x && mb.min.z < b.max.z && mb.max.z > b.min.z;
  });
  if (!near.length) return { ok: false, why: 'nothing below (floating/mounted)' };
  const c = b.getCenter(new THREE.Vector3());
  const hx = (b.max.x - b.min.x) * 0.3;
  const hz = (b.max.z - b.min.z) * 0.3;
  for (const [dx, dz] of [[0, 0], [hx, hz], [-hx, hz], [hx, -hz], [-hx, -hz]]) {
    ray.set(new THREE.Vector3(c.x + dx, b.min.y + 0.03, c.z + dz), new THREE.Vector3(0, -1, 0));
    if (ray.intersectObjects(near, false).length) return { ok: true, why: 'resting on something' };
  }
  return { ok: false, why: 'nothing below (floating/mounted)' };
}

const meshBoundsCache = new WeakMap<THREE.Mesh, THREE.Box3>();

// ---------------------------------------------------------------------------------------------
// The physics scene

export class Physics {
  readonly world: World;
  readonly things: DynamicThing[] = [];
  readonly byCollider = new Map<number, DynamicThing>();
  readonly byBody = new Map<number, DynamicThing>();
  readonly events: RAPIER_NS.EventQueue;
  stats: PhysicsStats = { staticChunks: 0, staticTriangles: 0, staticMeshes: 0, skippedMeshes: 0, dynamic: 0, autoTagged: 0, buildMs: 0 };
  autoLog: { name: string; picked: boolean; why: string; size: string; mass?: number }[] = [];
  /** called before every fixed step (player movement, grabbing) */
  beforeStep: ((dt: number) => void)[] = [];
  /** contact force events: (thing, force N) */
  onImpact?: (thing: DynamicThing, force: number, other?: DynamicThing) => void;
  private acc = 0;
  alpha = 0;
  stepsTaken = 0;
  /** debug: slow motion / freeze-frame */
  timeScale = 1;
  paused = false;

  constructor(
    readonly R: Rapier,
    readonly scene: THREE.Scene,
  ) {
    this.world = new R.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = FIXED_DT;
    // a few extra iterations for stable stacks of boxes/books
    this.world.numSolverIterations = 6;
    this.events = new R.EventQueue(true);
  }

  async buildFromRoom(room: BuiltRoom, roomId: string, onProgress?: (msg: string) => void) {
    const t0 = performance.now();
    const R = this.R;
    const cfg = autoTagConfig(roomId);
    const { dynamics, candidates, statics } = classify(room, roomId, cfg);

    // support test for auto candidates: raycast against everything else
    const allMeshes: THREE.Mesh[] = [];
    room.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.visible) {
        allMeshes.push(o);
        meshBoundsCache.set(o, meshBounds(o));
      }
    });
    for (const cand of candidates) {
      const test = supportTest(cand, allMeshes, room, cfg);
      const s = cand.bounds.getSize(new THREE.Vector3());
      const size = `${s.x.toFixed(2)}×${s.y.toFixed(2)}×${s.z.toFixed(2)}`;
      if (test.ok) {
        const surface = guessSurface(cand.obj);
        const mass = THREE.MathUtils.clamp(s.x * s.y * s.z * cfg.fill * SURFACES[surface].density, cfg.minMass, cfg.maxMass);
        const tag: PhysicsTag = { type: 'dynamic', mass: +mass.toFixed(2), surface };
        dynamics.push({ obj: cand.obj, tag, auto: true, bounds: cand.bounds });
        this.autoLog.push({ name: cand.obj.name, picked: true, why: test.why, size, mass: tag.mass });
      } else {
        this.autoLog.push({ name: cand.obj.name, picked: false, why: test.why, size });
        cand.obj.traverse((o) => {
          if (o instanceof THREE.Mesh && o.visible && physicsTag(o)?.type !== 'none') {
            let list = statics.get(cand.chunk);
            if (!list) statics.set(cand.chunk, (list = []));
            list.push(o);
          }
        });
      }
    }

    // --- static geometry: one trimesh per top-level chunk
    onProgress?.('Building static colliders…');
    const floorBox = new THREE.Box3();
    for (const [chunk, meshes] of statics) {
      const verts: number[] = [];
      const idx: number[] = [];
      for (const m of meshes) {
        const b = meshBoundsCache.get(m) ?? meshBounds(m);
        if (skipStaticMesh(m, b)) {
          this.stats.skippedMeshes++;
          continue;
        }
        appendTriangles(m, m.matrixWorld, verts, idx);
        this.stats.staticMeshes++;
        floorBox.union(b);
      }
      if (!idx.length) continue;
      const desc = R.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx), roomId === 'house'
        ? R.TriMeshFlags.FIX_INTERNAL_EDGES | R.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES | R.TriMeshFlags.DELETE_DUPLICATE_TRIANGLES : undefined)
        .setFriction(0.7)
        .setRestitution(0.1)
        .setCollisionGroups(DEFAULT_GROUPS);
      const c = this.world.createCollider(desc);
      c.setActiveEvents(R.ActiveEvents.NONE);
      this.stats.staticChunks++;
      this.stats.staticTriangles += idx.length / 3;
      void chunk;
      await yieldFrame();
    }
    // a thick floor slab under everything, so fast throws never tunnel through a 2-triangle floor
    if (!floorBox.isEmpty()) {
      const c = floorBox.getCenter(new THREE.Vector3());
      const s = floorBox.getSize(new THREE.Vector3());
      this.world.createCollider(R.ColliderDesc.cuboid(s.x / 2 + 2, 0.5, s.z / 2 + 2).setTranslation(c.x, -0.5, c.z).setFriction(0.7).setRestitution(0.1));
    }

    // --- dynamic bodies
    onProgress?.(`Building ${dynamics.length} dynamic bodies…`);
    let n = 0;
    for (const d of dynamics) {
      try {
        await this.addDynamic(d);
      } catch (e) {
        console.warn(`[play] couldn't build a body for "${d.obj.name}"`, e);
      }
      if (++n % 8 === 0) {
        onProgress?.(`Building dynamic bodies… ${n}/${dynamics.length}`);
        await yieldFrame();
      }
    }
    // A supported object can fall when its support is moved. Side-by-side objects
    // and furniture enclosing loose props must not create a room-wide wake chain.
    for (const support of this.things) {
      for (const item of this.things) {
        if (item === support || !item.wakeOnImpact || physicsTag(item.obj)?.wakeOnSupportLoss === false) continue;
        const a = support.bounds, b = item.bounds;
        if (Math.abs(b.min.y - a.max.y) <= .025 && b.min.y > a.min.y + .01
          && Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) > .01
          && Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) > .01) support.supported.push(item);
      }
    }
    this.stats.dynamic = this.things.length;
    this.stats.autoTagged = this.things.filter((t) => t.auto).length;
    this.stats.buildMs = Math.round(performance.now() - t0);
  }

  private async addDynamic({ obj, tag, auto, bounds }: DynamicCandidate) {
    const R = this.R;
    obj.updateWorldMatrix(true, true);
    // the body frame: the object's world position/rotation (no scale)
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    obj.matrixWorld.decompose(p, q, s);
    const frameInv = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)).invert();

    // meshes that belong to this body (not nested dynamic/none subtrees)
    const meshes: THREE.Mesh[] = [];
    const collect = (o: THREE.Object3D) => {
      if (o !== obj) {
        const t = physicsTag(o);
        if (t?.type === 'dynamic' || t?.type === 'none') return;
      }
      if (!o.visible) return;
      if (o instanceof THREE.Mesh && !skipDynamicMesh(o)) meshes.push(o);
      for (const c of o.children) collect(c);
    };
    collect(obj);
    if (!meshes.length) return;

    const surface = tag.surface ?? guessSurface(obj);
    const surf = SURFACES[surface];
    const size = bounds.getSize(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z);
    const mass = tag.mass ?? THREE.MathUtils.clamp(size.x * size.y * size.z * 0.35 * surf.density, 0.05, 40);
    let shape: ShapeKind = tag.shape ?? autoShape(meshes, obj);

    // local-frame bounds of the body's meshes
    const local = new THREE.Box3();
    const M = new THREE.Matrix4();
    for (const m of meshes) {
      M.multiplyMatrices(frameInv, m.matrixWorld);
      forEachVertex(m, M, (v) => local.expandByPoint(v));
    }
    const lc = local.getCenter(new THREE.Vector3());
    const ls = local.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.004, 0.004, 0.004));

    const descs: { desc: RAPIER_NS.ColliderDesc; vol: number }[] = [];
    const hullOf = (points: Float32Array) => R.ColliderDesc.convexHull(points);
    const inset = tag.boxInset ?? [0, 0, 0];
    const boxDesc = () => ({ desc: R.ColliderDesc.cuboid(Math.max(.002, ls.x / 2 - inset[0]), Math.max(.002, ls.y / 2 - inset[1]), Math.max(.002, ls.z / 2 - inset[2])).setTranslation(lc.x, lc.y, lc.z), vol: ls.x * ls.y * ls.z });

    if (shape === 'box') descs.push(boxDesc());
    else if (shape === 'sphere') {
      const r = (ls.x + ls.y + ls.z) / 6;
      descs.push({ desc: R.ColliderDesc.ball(r).setTranslation(lc.x, lc.y, lc.z), vol: (4 / 3) * Math.PI * r ** 3 });
    } else if (shape === 'cylinder') {
      const r = Math.max(ls.x, ls.z) / 2;
      descs.push({ desc: R.ColliderDesc.cylinder(ls.y / 2, r).setTranslation(lc.x, lc.y, lc.z), vol: Math.PI * r * r * ls.y });
    } else if (shape === 'container') {
      descs.push(...containerDescs(R, local, !!tag.round));
    } else if (shape === 'compound') {
      for (const m of meshes) {
        M.multiplyMatrices(frameInv, m.matrixWorld);
        const pts = hullPoints([m], [M.clone()]);
        const d = pts.length >= 12 ? hullOf(pts) : null;
        if (d) descs.push({ desc: d, vol: boxVolume(pts) });
      }
    } else if (shape === 'decompose') {
      const verts: number[] = [];
      const idx: number[] = [];
      for (const m of meshes) appendTriangles(m, M.multiplyMatrices(frameInv, m.matrixWorld), verts, idx);
      const parts = await decomposeCached(R, `${obj.name}|${idx.length}|${ls.toArray().map((x) => x.toFixed(3)).join(',')}`, verts, idx);
      for (const pts of parts) {
        const d = hullOf(pts);
        if (d) descs.push({ desc: d, vol: boxVolume(pts) });
      }
    }
    if (!descs.length) {
      // default + fallback: one convex hull over everything
      const mats = meshes.map((m) => new THREE.Matrix4().multiplyMatrices(frameInv, m.matrixWorld));
      const pts = hullPoints(meshes, mats);
      const d = pts.length >= 12 ? hullOf(pts) : null;
      if (d) descs.push({ desc: d, vol: ls.x * ls.y * ls.z });
      else descs.push(boxDesc());
      if (shape !== 'hull' && shape !== 'box') shape = 'hull';
    }

    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setCcdEnabled(true)
      .setLinearDamping(surf.damping)
      // no rolling resistance in Rapier: balls and cylinders would roll across the whole room
      .setAngularDamping((shape === 'sphere' || shape === 'cylinder' ? 0.9 : 0.25) + surf.damping)
      .setSleeping(true);
    const body = this.world.createRigidBody(bodyDesc);
    const totalVol = descs.reduce((a, d) => a + d.vol, 0) || 1;
    const friction = tag.friction ?? surf.friction;
    const restitution = tag.restitution ?? surf.restitution;
    const colliders: Collider[] = [];
    for (const { desc, vol } of descs) {
      desc
        .setMass((mass * vol) / totalVol)
        .setFriction(friction)
        .setRestitution(restitution)
        .setRestitutionCombineRule(surface === 'rubber' ? R.CoefficientCombineRule.Max : R.CoefficientCombineRule.Average)
        .setCollisionGroups(DEFAULT_GROUPS)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS | R.ActiveEvents.COLLISION_EVENTS)
        .setContactForceEventThreshold(Math.max(1.5, mass * 22));
      colliders.push(this.world.createCollider(desc, body));
    }
    // frozen (fixed) until disturbed, so the room stays exactly as modeled
    body.setBodyType(R.RigidBodyType.Fixed, false);

    // the body drives the Object3D from now on: move it to the scene root, keep its world transform
    this.scene.attach(obj);
    obj.matrixAutoUpdate = true;

    if (!obj.name) obj.name = `${surface}-${shape}-${this.things.length}`;
    const thing: DynamicThing = {
      name: obj.name,
      obj,
      body,
      colliders,
      mass,
      shape,
      surface,
      auto,
      size: maxSize,
      home: { p: p.clone(), q: q.clone() },
      prev: { p: p.clone(), q: q.clone() },
      curr: { p: p.clone(), q: q.clone() },
      asleep: true,
      frozen: true,
      supported: [],
      wakeOnImpact: tag.wakeOnImpact !== false,
      bounds: bounds.clone(),
    };
    obj.userData.playThing = thing;
    this.things.push(thing);
    this.byBody.set(body.handle, thing);
    for (const c of colliders) this.byCollider.set(c.handle, thing);
  }

  /** Advance by real time `dt` in fixed 60 Hz steps, then interpolate the visuals */
  update(dt: number) {
    if (this.paused) return this.interpolate();
    this.acc += Math.min(dt, 0.1) * this.timeScale;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < 4) {
      for (const f of this.beforeStep) f(FIXED_DT);
      this.preStepVelocity.clear();
      for (const thing of this.things) if (!thing.frozen) this.preStepVelocity.set(thing.body.handle, thing.body.linvel());
      this.world.step(this.events);
      this.afterStep();
      this.acc -= FIXED_DT;
      steps++;
      this.stepsTaken++;
    }
    if (steps === 4) this.acc = 0; // way behind (tab was hidden): don't spiral
    this.alpha = this.acc / FIXED_DT;
    return this.interpolate();
  }

  private preStepVelocity = new Map<number, { x: number; y: number; z: number }>();
  private pendingImpacts = new Map<string, number>();
  private lastImpact = new Map<number, number>();
  private pairKey(a: number, b: number) { return a < b ? `${a}:${b}` : `${b}:${a}`; }
  private relativeSpeed(a?: DynamicThing, b?: DynamicThing) {
    const va = a && this.preStepVelocity.get(a.body.handle);
    const vb = b && this.preStepVelocity.get(b.body.handle);
    return Math.hypot((va?.x ?? 0) - (vb?.x ?? 0), (va?.y ?? 0) - (vb?.y ?? 0), (va?.z ?? 0) - (vb?.z ?? 0));
  }
  private afterStep() {
    for (const t of this.things) {
      const b = t.body;
      if (t.frozen) continue;
      const sleeping = b.isSleeping();
      if (sleeping && t.asleep) continue;
      t.asleep = sleeping;
      t.prev.p.copy(t.curr.p);
      t.prev.q.copy(t.curr.q);
      const tr = b.translation();
      const rot = b.rotation();
      t.curr.p.set(tr.x, tr.y, tr.z);
      t.curr.q.set(rot.x, rot.y, rot.z, rot.w);
      // fell out of the world (through an open door into the void): put it back
      if (tr.y < -5) this.resetThing(t);
    }
    this.events.drainCollisionEvents((h1, h2, started) => {
      const key = this.pairKey(h1, h2);
      if (!started) { this.pendingImpacts.delete(key); return; }
      const a = this.byCollider.get(h1), b = this.byCollider.get(h2);
      const speed = this.relativeSpeed(a, b);
      if (speed >= .6) this.pendingImpacts.set(key, this.stepsTaken + 3);
      // Overlapping home colliders and resting contact are not a new strike.
      if (speed < .35) return;
      const breaks = (t: DynamicThing) => speed >= (physicsTag(t.obj)?.breakSpeed ?? 0);
      if (a?.frozen && a.wakeOnImpact && b && !b.frozen && breaks(a)) this.unfreeze(a);
      else if (b?.frozen && b.wakeOnImpact && a && !a.frozen && breaks(b)) this.unfreeze(b);
    });
    this.events.drainContactForceEvents(e => {
      const key = this.pairKey(e.collider1(), e.collider2());
      if (!this.pendingImpacts.has(key)) return;
      this.pendingImpacts.delete(key); // One sound per fresh contact, never sustained force.
      const a = this.byCollider.get(e.collider1()), b = this.byCollider.get(e.collider2());
      const thing = a && this.preStepVelocity.has(a.body.handle) ? a : b;
      if (!thing) return;
      const last = this.lastImpact.get(thing.body.handle) ?? -Infinity;
      if (this.stepsTaken - last < 15) return;
      this.lastImpact.set(thing.body.handle, this.stepsTaken);
      this.onImpact?.(thing, e.totalForceMagnitude(), thing === a ? b : a);
    });
    for (const [key, expires] of this.pendingImpacts) if (this.stepsTaken >= expires) this.pendingImpacts.delete(key);
  }

  /** returns how many things are moving (for shadow map refresh) */
  private interpolate() {
    let moving = 0;
    for (const t of this.things) {
      if (t.asleep && t.prev.p.equals(t.curr.p) && t.prev.q.equals(t.curr.q)) continue;
      moving++;
      t.obj.position.lerpVectors(t.prev.p, t.curr.p, this.alpha);
      t.obj.quaternion.slerpQuaternions(t.prev.q, t.curr.q, this.alpha);
      if (t.asleep) {
        // settle the visual on the final pose once asleep
        t.prev.p.copy(t.curr.p);
        t.prev.q.copy(t.curr.q);
        t.obj.position.copy(t.curr.p);
        t.obj.quaternion.copy(t.curr.q);
      }
    }
    return moving;
  }

  /** Move this object and any loose items resting on top, never adjoining furniture. */
  unfreeze(t: DynamicThing | undefined) {
    if (!t?.frozen || this.isHeld(t)) return;
    t.frozen = false;
    t.body.setBodyType(this.R.RigidBodyType.Dynamic, true);
    const kick = physicsTag(t.obj)?.detachKick;
    if (kick) {
      // Clear the lip it hung on instead of sliding down the board face.
      const out = new THREE.Vector3(0, 0, 1).applyQuaternion(t.curr.q).multiplyScalar(kick * (0.7 + Math.random() * 0.6));
      t.body.setLinvel({ x: out.x, y: out.y + kick * 0.3, z: out.z }, true);
      t.body.setAngvel({ x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 12 }, true);
    }
    t.body.wakeUp();
    t.asleep = false;
    for (const n of t.supported) this.unfreeze(n);
  }

  /** Behind unbroken glass: nothing may move it yet. */
  isHeld(t: DynamicThing) {
    return !!physicsTag(t.obj)?.heldBy && !t.obj.userData.released;
  }

  /** Free everything `heldBy` this id, nudged along `push` (m/s, with some spread) so it leaves its shelf. */
  release(id: string, push?: THREE.Vector3) {
    const freed: DynamicThing[] = [];
    for (const t of this.things) {
      if (physicsTag(t.obj)?.heldBy !== id || t.obj.userData.released) continue;
      t.obj.userData.released = true;
      this.unfreeze(t);
      freed.push(t);
      // crowded shelves: settle instead of jostling neighbours for minutes
      t.body.setLinearDamping(0.3);
      t.body.setAngularDamping(1.2);
      t.body.enableCcd(true); // thin frames dropping off shelves past glass shelves and shards
      if (push) {
        const k = 0.5 + Math.random();
        t.body.setLinvel({ x: push.x * k, y: push.y * k - 0.2, z: push.z * k }, true);
        t.body.setAngvel({ x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 3, z: (Math.random() - 0.5) * 3 }, true);
      }
    }
    return freed;
  }

  resetThing(t: DynamicThing) {
    const b = t.body;
    t.obj.userData.released = false;
    if (!t.frozen) {
      b.setBodyType(this.R.RigidBodyType.Fixed, false);
      t.frozen = true;
    }
    b.setTranslation(t.home.p, false);
    b.setRotation(t.home.q, false);
    b.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.setAngvel({ x: 0, y: 0, z: 0 }, false);
    t.prev.p.copy(t.home.p);
    t.prev.q.copy(t.home.q);
    t.curr.p.copy(t.home.p);
    t.curr.q.copy(t.home.q);
    t.obj.position.copy(t.home.p);
    t.obj.quaternion.copy(t.home.q);
    t.asleep = true;
  }

  resetAll() {
    this.pendingImpacts.clear();
    this.lastImpact.clear();
    this.preStepVelocity.clear();
    for (const t of this.things) this.resetThing(t);
  }

  thingForCollider(c: Collider | null | undefined) {
    const t = c ? this.byCollider.get(c.handle) : undefined;
    return t && !this.isHeld(t) ? t : undefined;
  }

  find(name: string) {
    const exact = this.things.find((t) => t.name === name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    return this.things.find((t) => t.name.toLowerCase().includes(lower));
  }
}

function skipDynamicMesh(m: THREE.Mesh) {
  const mats = materialsOf(m);
  return mats.every((x) => x.blending === THREE.AdditiveBlending || (x.transparent && x.opacity < 0.2));
}

/** A lone sphere mesh gets a real ball collider (so balls roll) */
function autoShape(meshes: THREE.Mesh[], obj: THREE.Object3D): ShapeKind {
  if (meshes.length === 1 && meshes[0].geometry.type === 'SphereGeometry') {
    // a real ball: round in world space (pillows and sacks are deformed spheres)
    const size = meshBounds(meshes[0]).getSize(new THREE.Vector3());
    const [lo, hi] = [Math.min(size.x, size.y, size.z), Math.max(size.x, size.y, size.z)];
    if (hi - lo < 0.08 * hi) return 'sphere';
  }
  if (/\bball\b/i.test(obj.name)) return 'sphere';
  return 'hull';
}

/** Unique-ish hull input points: quantized to 3 mm (1 cm for huge meshes) */
function hullPoints(meshes: THREE.Mesh[], mats: THREE.Matrix4[]) {
  let total = 0;
  for (const m of meshes) total += m.geometry.getAttribute('position')?.count ?? 0;
  const q = total > 60000 ? 0.01 : 0.003;
  const seen = new Set<string>();
  const out: number[] = [];
  meshes.forEach((m, i) => {
    forEachVertex(m, mats[i], (v) => {
      const k = `${Math.round(v.x / q)},${Math.round(v.y / q)},${Math.round(v.z / q)}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(v.x, v.y, v.z);
    });
  });
  return new Float32Array(out);
}

function boxVolume(pts: Float32Array) {
  const b = new THREE.Box3();
  for (let i = 0; i < pts.length; i += 3) b.expandByPoint(_v.set(pts[i], pts[i + 1], pts[i + 2]));
  const s = b.getSize(_v);
  return Math.max(1e-6, s.x * s.y * s.z);
}

/** Open-top container: a floor and thin walls around its (local) bounds */
function containerDescs(R: Rapier, b: THREE.Box3, round: boolean) {
  const c = b.getCenter(new THREE.Vector3());
  const s = b.getSize(new THREE.Vector3());
  const t = THREE.MathUtils.clamp(Math.min(s.x, s.z) * 0.06, 0.008, 0.025);
  const out: { desc: RAPIER_NS.ColliderDesc; vol: number }[] = [];
  const add = (hx: number, hy: number, hz: number, x: number, y: number, z: number, rotY = 0) => {
    const d = R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z);
    if (rotY) d.setRotation({ x: 0, y: Math.sin(rotY / 2), z: 0, w: Math.cos(rotY / 2) });
    out.push({ desc: d, vol: 8 * hx * hy * hz });
  };
  add(s.x / 2, t / 2, s.z / 2, c.x, b.min.y + t / 2, c.z); // floor
  const hy = s.y / 2;
  if (round) {
    const r = (s.x + s.z) / 4 - t / 2;
    const n = 12;
    const half = Math.tan(Math.PI / n) * (r + t / 2) + t / 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      add(half, hy, t / 2, c.x + Math.sin(a) * r, c.y, c.z + Math.cos(a) * r, a);
    }
  } else {
    add(s.x / 2, hy, t / 2, c.x, c.y, b.min.z + t / 2);
    add(s.x / 2, hy, t / 2, c.x, c.y, b.max.z - t / 2);
    add(t / 2, hy, s.z / 2, b.min.x + t / 2, c.y, c.z);
    add(t / 2, hy, s.z / 2, b.max.x - t / 2, c.y, c.z);
  }
  return out;
}

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));
