import * as THREE from 'three';
import type { BuiltRoom } from '../../../../packages/room-runtime/types';
import { FIXED_DT, GRAVITY, GROUP, groups, type Collider, type DynamicThing, type Physics } from '../../../../packages/room-physics/physics';

/** A regulation puck: 3 in × 1 in, 6 oz. */
export const PUCK_R = 0.0381;
const PUCK_H = 0.0254, PUCK_MASS = 0.17;
const MAX_PUCKS = 30;
/** Quick click: wrist shot; hold to wind up, up to a slap shot (m/s). */
const SPEED = 26, SLAP = 42, CHARGE = .7;
/** Puck-only boards on every wall plane: pucks never leave through glass or doorways. Nothing else collides with them. */
const PUCK_BIT = 0x0010, BOARD_BIT = 0x0008;
/** Shards of a pane the puck just broke: the puck flies on through them instead of shoving them out of the room. */
export const FRESH_SHARD_BIT = 0x0020;
const PUCK_GROUPS = groups(GROUP.world | PUCK_BIT, 0xffff & ~FRESH_SHARD_BIT);
export const BOARD_GROUPS = groups(BOARD_BIT, PUCK_BIT);
/** Swing timeline, seconds: wind-up, strike (the puck leaves), follow-through, return. */
const WIND = .09, STRIKE = .13, FOLLOW = .28, DONE = .5;

/** Where the stick is: a frame (blade spot, aim forward, right, up) and the hands. */
interface Pose { blade: THREE.Vector3; f: THREE.Vector3; r: THREE.Vector3; up: THREE.Vector3; hands: THREE.Vector3 }

/**
 * Playground hockey: a stick held in view; clicking shoots a puck where you aim.
 * Generic: needs only the room's walls (boards) and the Physics scene; pucks join `physics.things`
 * so they interpolate, make impact sounds and wake frozen furniture like any thrown object.
 */
export class Hockey {
  enabled = false;
  readonly pucks: DynamicThing[] = [];
  readonly stick = new THREE.Group();
  /** overhead aim, normalized device coords of the cursor */
  readonly cursor = new THREE.Vector2(0, 0);
  onShot?: (puck: DynamicThing) => void;
  private shaft: THREE.Mesh;
  private blade: THREE.Mesh;
  private swingT = Infinity;
  private pending?: { speed: number; target: THREE.Vector3 };
  /** wind-up start (ms), while the button is held */
  private charging?: number;
  private boards: Collider[] = [];
  private puckGeo = new THREE.CylinderGeometry(PUCK_R, PUCK_R, PUCK_H, 32);
  private puckMat = new THREE.MeshStandardMaterial({ color: '#0b0b0c', roughness: .55, metalness: 0, name: 'puck-rubber' });
  private ray = new THREE.Raycaster();
  private shots = 0;

  constructor(private physics: Physics, private camera: THREE.PerspectiveCamera, private scene: THREE.Scene,
    private room: BuiltRoom, private view: () => 'fpv' | 'playground', private ignore?: () => Collider | undefined) {
    const carbon = new THREE.MeshStandardMaterial({ color: '#1d1f22', roughness: .35, metalness: .2, name: 'stick-carbon' });
    const tape = new THREE.MeshStandardMaterial({ color: '#f1f1ec', roughness: .9, name: 'stick-tape' });
    // unit shaft along +y, unit blade along +x; posed every frame
    this.shaft = new THREE.Mesh(new THREE.BoxGeometry(.032, 1, .022).translate(0, .5, 0), carbon);
    this.blade = new THREE.Mesh(new THREE.BoxGeometry(1, .075, .014).translate(.5, .0375, 0), tape);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(.036, .12, .026).translate(0, .94, 0), tape);
    this.shaft.add(knob);
    this.stick.add(this.shaft, this.blade);
    this.stick.name = 'hockey-stick';
    this.stick.visible = false;
    this.stick.traverse(o => { o.userData.hockey = true; if (o instanceof THREE.Mesh) { o.castShadow = false; o.frustumCulled = false; } });
    scene.add(this.stick);
    physics.beforeStep.push(() => this.beforeStep());
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.stick.visible = on;
    if (on && !this.boards.length) this.buildBoards();
  }

  /** Button down: pull the stick back; the longer it's held, the harder the shot. */
  windup() {
    if (!this.enabled || this.pending) return false;
    this.charging = performance.now();
    this.swingT = Infinity;
    return true;
  }

  get winding() { return this.charging !== undefined; }

  get charge() { return this.charging === undefined ? 0 : THREE.MathUtils.clamp((performance.now() - this.charging) / 1000 / CHARGE, 0, 1); }

  /** Button up (or a plain call): swing through and release the puck at the strike frame. */
  shoot(ndc?: THREE.Vector2) {
    if (!this.enabled || this.pending) return false;
    const held = this.charge;
    this.charging = undefined;
    const pose = this.pose();
    const target = this.aimPoint(ndc ?? (this.view() === 'fpv' ? new THREE.Vector2() : this.cursor), pose);
    const speed = THREE.MathUtils.lerp(SPEED, SLAP, THREE.MathUtils.clamp((held - .2) / .8, 0, 1));
    this.pending = { speed, target };
    this.windBack = .32 + .25 * held;
    this.swingT = held > .05 ? WIND : 0;
    return true;
  }

  private windBack = .32;

  /** Advance the swing; true while the stick moves (needs a render). */
  update(dt: number) {
    if (!this.enabled) return false;
    const animating = this.swingT < DONE || this.charging !== undefined;
    if (animating) this.swingT += Math.min(dt, .05);
    if (this.pending && this.swingT >= WIND + (STRIKE - WIND) * .5) {
      const { speed, target } = this.pending;
      this.pending = undefined;
      this.release(this.pose(), target, speed);
    }
    this.place(this.pose());
    return animating || !!this.pending;
  }

  /** Remove every puck (Reset). */
  clear() {
    while (this.pucks.length) this.remove(this.pucks[0]);
    this.pending = undefined;
    this.charging = undefined;
    this.swingT = Infinity;
  }

  // ------------------------------------------------------------------------------------------

  /** FPV: the blade sits low in view; overhead: the stick stands on the floor at the bottom of the screen. */
  private pose(): Pose {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const f = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), r = new THREE.Vector3();
    if (this.view() === 'fpv') {
      cam.getWorldDirection(f);
      const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      r.crossVectors(f, camUp).normalize();
      // blade low in the frame, hands off the bottom-right corner
      const blade = cam.position.clone().addScaledVector(f, 1.05).addScaledVector(camUp, -.6).addScaledVector(r, .02);
      const hands = cam.position.clone().addScaledVector(f, .3).addScaledVector(camUp, -.42).addScaledVector(r, .34);
      return { blade, f, r, up: camUp, hands };
    }
    const spot = this.floorAt(new THREE.Vector2(0, -.62)) ?? new THREE.Vector3(...this.room.camera.target).setY(0);
    this.keepInside(spot);
    const aim = this.floorAt(this.cursor);
    f.copy(aim ? aim.sub(spot) : new THREE.Vector3(...this.room.camera.target).sub(spot)).setY(0);
    if (f.lengthSq() < 1e-4) cam.getWorldDirection(f).setY(0);
    f.normalize();
    r.crossVectors(f, up).normalize();
    const blade = spot.clone().addScaledVector(f, .35).setY(0);
    const hands = spot.clone().addScaledVector(r, -.3).addScaledVector(f, -.15).setY(1.0);
    return { blade, f, r, up, hands };
  }

  /** Pose the stick, offset by the swing (blade back, through the puck, up in the follow-through). */
  private place({ blade, f, r, up, hands }: Pose) {
    const t = this.swingT;
    let back = 0, lift = 0;
    const wb = this.charging !== undefined ? .32 + .25 * this.charge : this.windBack;
    if (this.charging !== undefined) { back = -wb; lift = .5 * (wb - .32); }
    else if (t < WIND) back = -wb * (t / WIND);
    else if (t < STRIKE) { const k = (t - WIND) / (STRIKE - WIND); back = -wb * (1 - k); lift = .5 * (wb - .32) * (1 - k); }
    else if (t < FOLLOW) { const k = (t - STRIKE) / (FOLLOW - STRIKE); back = .38 * k; lift = .3 * k; }
    else if (t < DONE) { const k = 1 - (t - FOLLOW) / (DONE - FOLLOW); back = .38 * k; lift = .3 * k; }
    const heel = blade.clone().addScaledVector(r, -.12).addScaledVector(f, back).addScaledVector(up, lift);
    const toe = heel.clone().addScaledVector(r, .3);
    const hand = hands.clone().addScaledVector(f, -back * .35);
    this.orient(this.shaft, heel, hand, 'y', f, up);
    this.orient(this.blade, heel, toe, 'x', f, up);
  }

  /** Stretch a unit part from a to b (along its x or y axis), thin side toward `face`, blade height up. */
  private orient(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, axis: 'x' | 'y', face: THREE.Vector3, up: THREE.Vector3) {
    const d = b.clone().sub(a);
    const len = d.length();
    d.normalize();
    const z = face.clone().addScaledVector(d, -face.dot(d)).normalize();
    const M = new THREE.Matrix4();
    if (axis === 'y') M.makeBasis(new THREE.Vector3().crossVectors(d, z), d, z);
    else {
      let y = new THREE.Vector3().crossVectors(z, d);
      if (y.dot(up) < 0) { z.negate(); y = y.negate(); }
      M.makeBasis(d, y, z);
    }
    m.quaternion.setFromRotationMatrix(M);
    m.position.copy(a);
    m.scale.set(axis === 'x' ? len : 1, axis === 'y' ? len : 1, 1);
  }

  private floorAt(ndc: THREE.Vector2) {
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return hit ?? undefined;
  }

  /** Walk a floor point toward the room's center until it is inside the walls (+ a margin). */
  private keepInside(p: THREE.Vector3) {
    const c = new THREE.Vector3(...this.room.camera.target).setY(0);
    const inside = (x: number, z: number) => this.room.walkable(x, z) && this.room.walkable(x + .5, z) && this.room.walkable(x - .5, z) && this.room.walkable(x, z + .5) && this.room.walkable(x, z - .5);
    for (let i = 0; i < 40 && !inside(p.x, p.z); i++) p.lerp(c, .1);
  }

  /** The first visible surface under the aim ray (hidden cutaway walls and ceilings don't count). */
  private aimPoint(ndc: THREE.Vector2, pose: Pose) {
    this.ray.setFromCamera(ndc, this.camera);
    const meshes: THREE.Object3D[] = [];
    const visit = (o: THREE.Object3D) => {
      if (!o.visible || o.userData.hockey) return;
      if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some(m => m.visible && !(m.transparent && m.opacity < .35) && m.blending !== THREE.AdditiveBlending)) meshes.push(o);
      }
      for (const c of o.children) visit(c);
    };
    visit(this.scene);
    const hit = this.ray.intersectObjects(meshes, false).find(h => h.distance > .3);
    if (hit) return hit.point;
    return pose.blade.clone().addScaledVector(pose.f, 8);
  }

  /** Launch from the blade toward the target on a ballistic arc (flat along the floor when the target is low). */
  private release(pose: Pose, target: THREE.Vector3, speed: number) {
    const start = pose.blade.clone().addScaledVector(pose.r, .03).addScaledVector(pose.f, .08);
    if (this.view() === 'playground') start.y = PUCK_H / 2 + .003;
    else {
      // never spawn through a wall right in front of the camera
      const R = this.physics.R;
      const o = this.camera.position, d = start.clone().sub(o);
      const len = d.length(); d.normalize();
      const hit = this.physics.world.castRay(new R.Ray(o, d), len + PUCK_R, true, R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.ignore?.());
      if (hit) start.copy(o).addScaledVector(d, Math.max(.05, hit.timeOfImpact - PUCK_R * 2));
    }
    // From above you see the top of things; shoot at their base like a real shot, and lob only at high targets.
    if (this.view() === 'playground' && target.y < 1.2) target = target.clone().setY(Math.min(target.y, .12));
    const delta = target.clone().sub(start);
    const h = delta.y, flat = new THREE.Vector3(delta.x, 0, delta.z), dist = flat.length();
    flat.normalize();
    if (dist < .05) flat.copy(pose.f).setY(0).normalize();
    // low ballistic angle; a target below the blade (or along the floor) is a flat shot
    const g = -GRAVITY, v2 = speed * speed;
    const disc = v2 * v2 - g * (g * dist * dist + 2 * h * v2);
    let angle = disc >= 0 ? Math.atan((v2 - Math.sqrt(disc)) / (g * Math.max(dist, .05))) : Math.PI / 4;
    if (this.view() === 'playground') angle = Math.max(0, angle);
    const vel = flat.multiplyScalar(Math.cos(angle) * speed).setY(Math.sin(angle) * speed);
    this.spawn(start, vel);
  }

  private spawn(p: THREE.Vector3, v: THREE.Vector3) {
    if (this.pucks.length >= MAX_PUCKS) this.remove(this.pucks[0]);
    const { R, world } = this.physics;
    // Hard CCD alone let a 22 m/s puck tunnel through thin dynamic props (the trophy); soft CCD catches them.
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z)
      .setCcdEnabled(true).setSoftCcdPrediction(.6).setLinearDamping(.08).setAngularDamping(.6).setCanSleep(true));
    const collider = world.createCollider(R.ColliderDesc.cylinder(PUCK_H / 2, PUCK_R).setMass(PUCK_MASS)
      .setFriction(.3).setRestitution(.45).setCollisionGroups(PUCK_GROUPS)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS | R.ActiveEvents.COLLISION_EVENTS)
      .setContactForceEventThreshold(PUCK_MASS * 22), body);
    body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    body.setAngvel({ x: 0, y: (Math.random() - .5) * 30, z: 0 }, true);
    const mesh = new THREE.Mesh(this.puckGeo, this.puckMat);
    mesh.name = `puck-${++this.shots}`;
    mesh.userData.hockey = true;
    mesh.receiveShadow = true;
    mesh.position.copy(p);
    this.scene.add(mesh);
    const q = new THREE.Quaternion();
    const thing: DynamicThing = {
      name: mesh.name, obj: mesh, body, colliders: [collider], mass: PUCK_MASS, shape: 'cylinder', surface: 'rubber',
      auto: false, size: PUCK_R * 2, home: { p: p.clone(), q: q.clone() }, prev: { p: p.clone(), q: q.clone() },
      curr: { p: p.clone(), q: q.clone() }, asleep: false, frozen: false, supported: [], wakeOnImpact: false,
      bounds: new THREE.Box3().setFromCenterAndSize(p, new THREE.Vector3(PUCK_R * 2, PUCK_H, PUCK_R * 2)),
    };
    mesh.userData.playThing = thing;
    this.physics.things.push(thing);
    this.physics.byBody.set(body.handle, thing);
    this.physics.byCollider.set(collider.handle, thing);
    this.pucks.push(thing);
    this.onShot?.(thing);
  }

  private remove(t: DynamicThing) {
    const i = this.physics.things.indexOf(t);
    if (i >= 0) this.physics.things.splice(i, 1);
    this.physics.byBody.delete(t.body.handle);
    for (const c of t.colliders) this.physics.byCollider.delete(c.handle);
    this.physics.world.removeRigidBody(t.body);
    t.obj.removeFromParent();
    this.pucks.splice(this.pucks.indexOf(t), 1);
  }

  /**
   * Frozen furniture is a fixed body until something moving touches it, so a fast puck would bounce
   * off before the contact wakes it. Wake whatever lies just ahead of each fast puck instead.
   */
  private beforeStep() {
    const R = this.physics.R;
    for (const t of [...this.pucks]) {
      const p = t.body.translation();
      if (p.y < -1) { this.remove(t); continue; }
      const v = t.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed < .5) continue;
      const d = { x: v.x / speed, y: v.y / speed, z: v.z / speed };
      const side = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(PUCK_R * .9);
      for (const s of [0, 1, -1]) {
        const o = { x: p.x + side.x * s, y: p.y, z: p.z + side.z * s };
        const hit = this.physics.world.castRay(new R.Ray(o, d), speed * FIXED_DT * 2 + PUCK_R + .02, true, R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, t.body);
        const thing = this.physics.thingForCollider(hit?.collider);
        if (thing?.frozen && speed >= (thing.obj.userData.physics?.breakSpeed ?? 0)) this.physics.unfreeze(thing);
      }
    }
  }

  private buildBoards() {
    const { R, world } = this.physics;
    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    const h = Math.max(1, this.room.wallTop);
    for (const { def } of this.room.walls) {
      const c = def.origin.clone().addScaledVector(def.u, def.length / 2).addScaledVector(def.n, -.1).setY(h / 2);
      const yaw = Math.atan2(-def.u.z, def.u.x);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      this.boards.push(world.createCollider(R.ColliderDesc.cuboid(def.length / 2 + .3, h / 2, .1)
        .setTranslation(c.x, c.y, c.z).setRotation(q).setCollisionGroups(BOARD_GROUPS).setRestitution(.4).setFriction(.3), body));
    }
  }
}
