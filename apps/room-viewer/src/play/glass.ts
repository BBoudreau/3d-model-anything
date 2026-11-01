import * as THREE from 'three';
import type { BuiltRoom } from '../../../../packages/room-runtime/types';
import { DEFAULT_GROUPS, FIXED_DT, GROUP, groups, type Collider, type DynamicThing, type Physics } from '../../../../packages/room-physics/physics';
import { physicsTag } from '../../../../packages/room-physics/tagging';
import { BOARD_GROUPS, FRESH_SHARD_BIT, PUCK_R, type Hockey } from './hockey';

/** Live shard bodies across all panes; the oldest are retired past this. */
const MAX_SHARDS = 160;
/** float glass, kg/m³ */
const DENSITY = 2500;
/** Longest arc of one fracture cell before it is split (m): no metre-long slabs from big storefront lites. */
const MAX_ARC = 0.32;
/** Cells smaller than this are dropped (m²): crumbs would only cost bodies. */
const MIN_AREA = 2e-4;
/** Steps a new shard ignores pucks (the puck that broke the pane would shove it out of the room). */
const FRESH_STEPS = 30;
/**
 * Settling: light items packed on a shelf (and shards wedged between them) can jostle at a few cm/s
 * for minutes and keep the whole island awake. After SETTLE_AFTER steps, a body this slow for
 * SETTLE_STEPS in a row is put to sleep (a new hit wakes it as usual).
 */
const SETTLE_AFTER = 150, SETTLE_STEPS = 30, SETTLE_V = .08, SETTLE_W = 2;
const FRESH_GROUPS = groups(FRESH_SHARD_BIT, 0xffff);
/** Behind broken wall glass: stops shards (and anything else loose), never the player. */
const STOP_GROUPS = groups(0x0040, GROUP.world | FRESH_SHARD_BIT);

type V2 = [number, number];
const _t = new THREE.Vector3(), _s = new THREE.Vector3();

export interface Pane {
  id: number;
  mesh: THREE.Mesh;
  /** pane-local → world, and back */
  M: THREE.Matrix4;
  inv: THREE.Matrix4;
  q: THREE.Quaternion;
  /** world normal toward the room */
  n: THREE.Vector3;
  c: THREE.Vector3;
  /** pane-local rectangle: center and half sizes */
  cx: number; cy: number; hw: number; hh: number;
  breakSpeed: number;
  thickness: number;
  /** frees the pieces held behind this pane (Physics.release) */
  releases?: string;
  backstop: boolean;
  out: number;
  group?: string;
  maxPieces?: number;
  solid: boolean;
  /** inside a dynamic body (the gumball stand): its pose is re-read every step */
  live: boolean;
  inside: THREE.Vector3;
  collider?: Collider;
  stop?: Collider;
  broken: boolean;
  remnants: THREE.Mesh[];
}

/**
 * Breakable glass for the playground. Panes tagged `{ type: 'none', breakSpeed, shatter }` (room
 * play tags) stay whole until a puck reaches them at `breakSpeed` or more along the pane normal;
 * then the pane hides and its area is cut into radial / ring fracture cells around the impact
 * point. Most cells become thin dynamic shards that fall into the room; a few edge cells stay in
 * the frame as jagged remnants. Intact panes carry a pucks-only collider (case fronts used to let
 * pucks through); wall panes also sit behind the hockey boards, which stay, so pucks never leave.
 */
export class Glass {
  readonly panes: Pane[] = [];
  readonly shards: DynamicThing[] = [];
  onShatter?: (pane: Pane, shards: DynamicThing[], at: THREE.Vector3) => void;
  /** more shatter subscribers (room play modules) */
  readonly listeners: ((pane: Pane, shards: DynamicThing[]) => void)[] = [];
  private faceMats = new Map<THREE.Material, THREE.Material>();
  private edgeMat = new THREE.MeshStandardMaterial({ color: '#a9cfc4', roughness: .1, metalness: .1, transparent: true, opacity: .7, name: 'glass-shard-edge' });
  private seq = 0;
  private fresh = new Map<DynamicThing, number>();
  /** shards and freed case items: age in steps, slow-step streak */
  private settling = new Map<DynamicThing, { age: number; slow: number }>();

  constructor(private physics: Physics, private scene: THREE.Scene, room: BuiltRoom, private hockey: Hockey) {
    // the scene, not room.group: Physics moved dynamic bodies (and their panes) to the scene root
    scene.updateMatrixWorld(true);
    const inside = new THREE.Vector3(...room.camera.target);
    scene.traverse(o => {
      const tag = physicsTag(o);
      if (!(o instanceof THREE.Mesh) || !tag?.shatter) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox!;
      let live = false;
      for (let a = o.parent; a; a = a.parent) if (physicsTag(a)?.type === 'dynamic') live = true;
      const p: Pane = {
        id: this.panes.length, mesh: o, M: new THREE.Matrix4(), inv: new THREE.Matrix4(), q: new THREE.Quaternion(), n: new THREE.Vector3(), c: new THREE.Vector3(),
        cx: (b.min.x + b.max.x) / 2, cy: (b.min.y + b.max.y) / 2, hw: (b.max.x - b.min.x) / 2, hh: (b.max.y - b.min.y) / 2,
        breakSpeed: tag.breakSpeed ?? 4, thickness: tag.shatter.thickness ?? .006, releases: tag.shatter.releases,
        backstop: !!tag.shatter.backstop, out: tag.shatter.out ?? 0, group: tag.shatter.group, maxPieces: tag.shatter.maxPieces,
        solid: !!tag.shatter.solid, live, inside, broken: false, remnants: [],
      };
      this.pose(p);
      this.panes.push(p);
    });
    for (const p of this.panes) this.addCollider(p);
    if (this.panes.length) physics.beforeStep.push(() => this.beforeStep());
  }

  /** world frame of a pane from its mesh (once; every step for live panes) */
  private pose(p: Pane) {
    p.M.copy(p.mesh.matrixWorld);
    p.inv.copy(p.M).invert();
    p.M.decompose(_t, p.q, _s);
    p.c.set(p.cx, p.cy, 0).applyMatrix4(p.M);
    p.n.set(0, 0, 1).applyQuaternion(p.q);
    if (_t.copy(p.inside).sub(p.c).dot(p.n) < 0) p.n.negate();
  }

  get broken() { return this.panes.filter(p => p.broken).length; }

  /** Reset: every pane whole again, every shard gone. Call before Physics.resetAll(). */
  reset() {
    while (this.shards.length) this.removeShard(this.shards[0]);
    this.settling.clear();
    for (const p of this.panes) {
      for (const r of p.remnants) { r.removeFromParent(); r.geometry.dispose(); }
      p.remnants.length = 0;
      if (p.stop) { this.removeBody(p.stop); p.stop = undefined; }
      if (p.broken) { p.broken = false; p.mesh.visible = true; this.addCollider(p); }
    }
  }

  /** Break a pane at a world point (tests / scripted hits). */
  shatterAt(id: number, world: THREE.Vector3) {
    const p = this.panes[id];
    if (p && !p.broken) this.shatter(p, world.clone().applyMatrix4(p.inv));
  }

  // ------------------------------------------------------------------------------------------

  private addCollider(p: Pane) {
    if (p.live) return; // the body it rides on has its own colliders
    const { R, world } = this.physics;
    const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(p.c.x, p.c.y, p.c.z).setRotation(p.q));
    p.collider = world.createCollider(R.ColliderDesc.cuboid(p.hw, p.hh, .004).setCollisionGroups(p.solid ? DEFAULT_GROUPS : BOARD_GROUPS).setRestitution(.3).setFriction(.2), body);
  }

  private removeCollider(p: Pane) {
    if (p.collider) this.removeBody(p.collider);
    p.collider = undefined;
  }

  private removeBody(c: Collider) {
    const body = c.parent();
    if (body) this.physics.world.removeRigidBody(body);
  }

  /**
   * Wall glass sits mid-wall on a transom bar or kick rail; a shard landing on that ledge would slide
   * out of the room. A shards-only stop 2 cm behind the pane, from the floor to its top, keeps them in.
   */
  private addStop(p: Pane) {
    const { R, world } = this.physics;
    const top = p.c.y + p.hh + .05, c = p.c.clone().addScaledVector(p.n, -.025).setY(top / 2);
    const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(c.x, c.y, c.z).setRotation(p.q));
    p.stop = world.createCollider(R.ColliderDesc.cuboid(p.hw + .05, top / 2, .006).setCollisionGroups(STOP_GROUPS).setFriction(.4), body);
  }

  /**
   * A puck heading into a pane fast enough (normal speed) breaks it just before contact. Wall panes
   * are recessed behind the hockey boards, so the check looks a few steps ahead of the puck.
   */
  private beforeStep() {
    for (const s of [...this.shards]) if (s.body.translation().y < -1) this.removeShard(s);
    for (const [s, n] of this.fresh) {
      if (n > 1) { this.fresh.set(s, n - 1); continue; }
      this.fresh.delete(s);
      for (const c of s.colliders) c.setCollisionGroups(DEFAULT_GROUPS);
    }
    for (const [t, st] of this.settling) {
      if (++st.age < SETTLE_AFTER || t.frozen || t.body.isSleeping()) { st.slow = 0; continue; }
      const v = t.body.linvel(), w = t.body.angvel();
      if (Math.hypot(v.x, v.y, v.z) < SETTLE_V && Math.hypot(w.x, w.y, w.z) < SETTLE_W) { if (++st.slow >= SETTLE_STEPS) { t.body.sleep(); st.slow = 0; } }
      else st.slow = 0;
    }
    for (const p of this.panes) if (p.live && !p.broken) { p.mesh.updateWorldMatrix(true, false); this.pose(p); }
    const hit = new THREE.Vector3(), local = new THREE.Vector3();
    for (const puck of this.hockey.pucks) {
      const p = puck.body.translation(), v = puck.body.linvel();
      for (const pane of this.panes) {
        if (pane.broken) continue;
        const vn = -(v.x * pane.n.x + v.y * pane.n.y + v.z * pane.n.z);
        if (vn < pane.breakSpeed) continue;
        const d = (p.x - pane.c.x) * pane.n.x + (p.y - pane.c.y) * pane.n.y + (p.z - pane.c.z) * pane.n.z;
        if (d < -PUCK_R) continue;
        const t = Math.max(0, d - PUCK_R) / vn;
        if (t > 3 * FIXED_DT) continue;
        hit.set(p.x + v.x * t, p.y + v.y * t, p.z + v.z * t);
        local.copy(hit).applyMatrix4(pane.inv);
        if (Math.abs(local.x - pane.cx) > pane.hw + PUCK_R * .5 || Math.abs(local.y - pane.cy) > pane.hh + PUCK_R * .5) continue;
        this.shatter(pane, local);
        // the pane takes some of the energy
        puck.body.setLinvel({ x: v.x * .7, y: v.y * .7, z: v.z * .7 }, true);
        break;
      }
    }
  }

  private shatter(pane: Pane, local: THREE.Vector3) {
    pane.broken = true;
    pane.mesh.visible = false;
    this.removeCollider(pane);
    if (pane.backstop) this.addStop(pane);
    const ix = THREE.MathUtils.clamp(local.x - pane.cx, -pane.hw, pane.hw), iy = THREE.MathUtils.clamp(local.y - pane.cy, -pane.hh, pane.hh);
    let cells = fracture(pane.hw, pane.hh, ix, iy);
    if (pane.maxPieces && cells.length > pane.maxPieces) cells = cells.map(c => [c, Math.abs(polyArea(c))] as const).sort((a, b) => b[1] - a[1]).slice(0, pane.maxPieces).map(([c]) => c);
    const reach = Math.max(pane.hw, pane.hh);
    const made: DynamicThing[] = [];
    const face = this.faceMat(pane.mesh.material as THREE.Material);
    const R = this.physics.R, world = this.physics.world;
    for (const poly of cells) {
      const { geo, cx, cy, area, verts } = shardGeometry(poly, pane.thickness);
      const r = Math.hypot(cx - ix, cy - iy);
      const onEdge = poly.some(([x, y]) => pane.hw - Math.abs(x) < .002 || pane.hh - Math.abs(y) < .002);
      // a few big edge pieces stay in the frame: the hole reads as a break, not a missing pane
      if (onEdge && r > .45 * reach && Math.random() < .45) {
        const m = new THREE.Mesh(geo, [face, this.edgeMat]);
        m.name = `glass-remnant-${pane.id}`;
        m.castShadow = false;
        m.position.set(pane.cx + cx, pane.cy + cy, 0).applyMatrix4(pane.mesh.matrix);
        m.quaternion.copy(pane.mesh.quaternion);
        pane.mesh.parent!.add(m);
        pane.remnants.push(m);
        continue;
      }
      const pos = new THREE.Vector3(pane.cx + cx, pane.cy + cy, 0).applyMatrix4(pane.M).addScaledVector(pane.n, pane.out);
      const mass = THREE.MathUtils.clamp(area * pane.thickness * DENSITY, .003, .35);
      const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(pane.q)
        .setCcdEnabled(true).setLinearDamping(.1).setAngularDamping(.5).setCanSleep(true));
      const desc = (R.ColliderDesc.convexHull(verts) ?? R.ColliderDesc.cuboid(.02, .02, pane.thickness / 2))
        .setMass(mass).setFriction(.6).setRestitution(.12).setCollisionGroups(FRESH_GROUPS)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS | R.ActiveEvents.COLLISION_EVENTS).setContactForceEventThreshold(mass * 22);
      const collider = world.createCollider(desc, body);
      // into the room and down, harder and spreading near the impact; pieces never fly out of the room
      const f = Math.exp(-r / .25);
      const radial = new THREE.Vector3(cx - ix, cy - iy, 0).normalize().applyQuaternion(pane.q);
      const v = pane.n.clone().multiplyScalar(.35 + Math.random() * .9 + 1.4 * f).addScaledVector(radial, .9 * f * Math.random());
      v.y -= .2 + Math.random() * .4;
      body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
      body.setAngvel({ x: (Math.random() - .5) * 8, y: (Math.random() - .5) * 8, z: (Math.random() - .5) * 8 }, true);
      const mesh = new THREE.Mesh(geo, [face, this.edgeMat]);
      mesh.name = `glass-shard-${++this.seq}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData.shard = true;
      mesh.position.copy(pos);
      mesh.quaternion.copy(pane.q);
      this.scene.add(mesh);
      const size = Math.sqrt(area) * 1.4;
      const thing: DynamicThing = {
        name: mesh.name, obj: mesh, body, colliders: [collider], mass, shape: 'hull', surface: 'glass', auto: false, size,
        home: { p: pos.clone(), q: pane.q.clone() }, prev: { p: pos.clone(), q: pane.q.clone() }, curr: { p: pos.clone(), q: pane.q.clone() },
        asleep: false, frozen: false, supported: [], wakeOnImpact: false,
        bounds: new THREE.Box3().setFromObject(mesh),
      };
      mesh.userData.playThing = thing;
      this.physics.things.push(thing);
      this.physics.byBody.set(body.handle, thing);
      this.physics.byCollider.set(collider.handle, thing);
      this.shards.push(thing);
      this.fresh.set(thing, FRESH_STEPS);
      this.settling.set(thing, { age: 0, slow: 0 });
      made.push(thing);
    }
    while (this.shards.length > MAX_SHARDS) this.removeShard(this.shards[0]);
    if (pane.releases) for (const t of this.physics.release(pane.releases, pane.n.clone().multiplyScalar(1.3))) this.settling.set(t, { age: 0, slow: 0 });
    const kept = made.filter(s => this.shards.includes(s));
    this.onShatter?.(pane, kept, new THREE.Vector3(pane.cx + ix, pane.cy + iy, 0).applyMatrix4(pane.M));
    for (const f of this.listeners) f(pane, kept);
    // the rest of its group goes too (each at its own center)
    if (pane.group) for (const o of this.panes) if (o.group === pane.group && !o.broken) this.shatter(o, new THREE.Vector3(o.cx, o.cy, 0));
  }

  removeShard(t: DynamicThing) {
    const i = this.physics.things.indexOf(t);
    if (i >= 0) this.physics.things.splice(i, 1);
    this.physics.byBody.delete(t.body.handle);
    for (const c of t.colliders) this.physics.byCollider.delete(c.handle);
    this.physics.world.removeRigidBody(t.body);
    this.fresh.delete(t);
    this.settling.delete(t);
    t.obj.removeFromParent();
    (t.obj as THREE.Mesh).geometry.dispose();
    this.shards.splice(this.shards.indexOf(t), 1);
  }

  /** the pane's own glass, a touch more opaque so shards on the floor still read */
  private faceMat(src: THREE.Material) {
    let m = this.faceMats.get(src);
    if (!m) {
      m = src.clone();
      m.name = 'glass-shard-face';
      m.opacity = Math.max(m.opacity, .3);
      this.faceMats.set(src, m);
    }
    return m;
  }
}

/**
 * Radial-and-ring fracture of the rectangle [−hw, hw] × [−hh, hh] around (ix, iy): 8–11 jittered
 * radial cracks, rings that grow ~1.9× outward (small splinters at the hit, big pieces near the
 * frame), long cells split along the arc, every cell clipped to the pane. Convex polygons.
 */
export function fracture(hw: number, hh: number, ix: number, iy: number): V2[][] {
  const rnd = Math.random;
  const far = Math.hypot(hw + Math.abs(ix), hh + Math.abs(iy)) + .01;
  const nRays = 8 + Math.floor(rnd() * 4);
  const base = rnd() * Math.PI * 2;
  const ang = Array.from({ length: nRays }, (_, i) => base + (i + (rnd() - .5) * .6) * Math.PI * 2 / nRays);
  const radii = [0];
  for (let r = .06 + rnd() * .03; r < far; r *= 1.7 + rnd() * .45) radii.push(r);
  radii.push(far * 1.6);
  const K = radii.length;
  // per-ray jitter of the ring crossings (not the hit point or the outer bound)
  const rr = radii.map((r, k) => ang.map(() => (k === 0 || k === K - 1 ? r : r * (.85 + rnd() * .3))));
  const P = (r: number, a: number): V2 => [ix + r * Math.cos(a), iy + r * Math.sin(a)];
  const cells: V2[][] = [];
  for (let k = 0; k < K - 1; k++) {
    for (let i = 0; i < nRays; i++) {
      const j = (i + 1) % nRays;
      const a0 = ang[i], a1 = ang[j] + (j === 0 ? Math.PI * 2 : 0);
      const outer = Math.min(radii[k + 1], far);
      const m = Math.max(1, Math.ceil(outer * (a1 - a0) / MAX_ARC));
      for (let s = 0; s < m; s++) {
        const t0 = s / m, t1 = (s + 1) / m;
        const ta = a0 + (a1 - a0) * t0, tb = a0 + (a1 - a0) * t1;
        const lerp = (row: number[], t: number) => row[i] + (row[j] - row[i]) * t;
        const poly: V2[] = k === 0
          ? [[ix, iy], P(lerp(rr[1], t0), ta), P(lerp(rr[1], t1), tb)]
          : [P(lerp(rr[k], t0), ta), P(lerp(rr[k + 1], t0), ta), P(lerp(rr[k + 1], t1), tb), P(lerp(rr[k], t1), tb)];
        const clipped = clipRect(poly, hw, hh);
        if (clipped.length >= 3 && Math.abs(polyArea(clipped)) >= MIN_AREA) cells.push(clipped);
      }
    }
  }
  return cells;
}

function polyArea(p: V2[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; a += x0 * y1 - x1 * y0; }
  return a / 2;
}

/** Sutherland–Hodgman against the four pane edges */
function clipRect(poly: V2[], hw: number, hh: number) {
  const edges: [number, number, number][] = [[1, 0, hw], [-1, 0, hw], [0, 1, hh], [0, -1, hh]]; // a·x + b·y ≤ c
  let out = poly;
  for (const [a, b, c] of edges) {
    const inp = out;
    out = [];
    for (let i = 0; i < inp.length; i++) {
      const P = inp[i], Q = inp[(i + 1) % inp.length];
      const dp = a * P[0] + b * P[1] - c, dq = a * Q[0] + b * Q[1] - c;
      if (dp <= 0) out.push(P);
      if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
        const t = dp / (dp - dq);
        out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
      }
    }
    if (out.length < 3) return [];
  }
  return out;
}

/** A thin prism over a convex polygon, centered on its centroid: group 0 faces, group 1 edges. */
function shardGeometry(poly: V2[], t: number) {
  let pts = poly;
  let area = polyArea(pts);
  if (area < 0) { pts = [...pts].reverse(); area = -area; }
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length], k = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * k; cy += (y0 + y1) * k;
  }
  cx /= 6 * area; cy /= 6 * area;
  // 1.5 mm gap so neighbours don't start in contact
  const loc = pts.map(([x, y]): V2 => {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1, k = Math.max(.5, 1 - .0015 / d);
    return [dx * k, dy * k];
  });
  const h = t / 2, pos: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => pos.push(...a, ...b, ...c);
  for (let i = 1; i < loc.length - 1; i++) {
    tri([...loc[0], h], [...loc[i], h], [...loc[i + 1], h]);
    tri([...loc[0], -h], [...loc[i + 1], -h], [...loc[i], -h]);
  }
  const faceVerts = pos.length / 3;
  for (let i = 0; i < loc.length; i++) {
    const a = loc[i], b = loc[(i + 1) % loc.length];
    tri([...a, -h], [...b, -h], [...b, h]);
    tri([...a, -h], [...b, h], [...a, h]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.addGroup(0, faceVerts, 0);
  geo.addGroup(faceVerts, pos.length / 3 - faceVerts, 1);
  const verts = new Float32Array(loc.flatMap(([x, y]) => [x, y, h, x, y, -h]));
  return { geo, cx, cy, area, verts };
}
