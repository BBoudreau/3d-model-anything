import * as THREE from 'three';
import { type Physics, type DynamicThing } from '../../../../packages/room-physics/physics';

/** Single-click throwing along the cursor ray. */
export class Slingshot {
  hovered?: DynamicThing;
  selected?: DynamicThing;
  readonly velocity = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private ground = new THREE.Plane();
  private anchor = new THREE.Vector3();
  private cursor = new THREE.Vector3();
  private roots: THREE.Object3D[];
  private objects = new Map<THREE.Object3D, DynamicThing>();
  private pickMeshes: THREE.Object3D[] = [];
  private hits: THREE.Intersection[] = [];
  private ndc = new THREE.Vector2();
  private pickMatrices = new Map<THREE.Object3D, THREE.Matrix4>();

  constructor(private physics: Physics, private camera: THREE.PerspectiveCamera, private root: THREE.Object3D) {
    this.roots = [root, ...physics.things.map(t => t.obj)];
    for (const t of physics.things) this.objects.set(t.obj, t);
    for (const root of this.roots) {
      root.updateMatrixWorld(true);
      this.pickMatrices.set(root, root.matrixWorld.clone());
      root.traverse(o => {
        if (o instanceof THREE.Mesh && !o.geometry.boundingBox) o.geometry.computeBoundingBox();
      });
    }

  }

  aim(x: number, y: number, width: number, height: number) {
    this.ray.setFromCamera(this.ndc.set(x / width * 2 - 1, 1 - y / height * 2), this.camera);
    if (this.selected) {
      if (!this.ray.ray.intersectPlane(this.ground, this.cursor)) return;
      this.velocity.copy(this.cursor).sub(this.anchor);
      this.velocity.y = 0;
      if (this.velocity.lengthSq() < .0001) {
        this.camera.getWorldDirection(this.velocity);
        this.velocity.y = 0;
      }
      // Fixed, mass-aware strength. Aim toward the cursor, without pulling back.
      this.velocity.normalize().multiplyScalar(Math.max(2.2, Math.min(12, Math.sqrt(140 / this.selected.mass))));
      this.velocity.y = 3;
      return;
    }
    // Keep exact mesh picking and furniture occlusion, but never raycast hidden walls.
    // Static matrices are prepared once; only physics-driven roots need updating.
    for (const t of this.physics.things) {
      t.obj.updateWorldMatrix(true, false);
      const last = this.pickMatrices.get(t.obj)!;
      if (!last.equals(t.obj.matrixWorld)) {
        t.obj.updateMatrixWorld(true);
        last.copy(t.obj.matrixWorld);
      }
    }
    this.pickMeshes.length = 0;
    for (const root of this.roots) root.traverseVisible(o => {
      if (o instanceof THREE.Mesh) this.pickMeshes.push(o);
    });
    this.hits.length = 0;
    this.ray.intersectObjects(this.pickMeshes, false, this.hits);
    this.hovered = undefined;
    const hit = this.hits[0];
    if (hit) for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
      const thing = this.objects.get(o);
      if (thing) { if (!this.physics.isHeld(thing)) this.hovered = thing; break; }
    }
  }

  begin() {
    if (!this.hovered) return false;
    this.selected = this.hovered;
    const p = this.selected.body.worldCom();
    this.ground.set(new THREE.Vector3(0, 1, 0), -p.y);
    if (!this.ray.ray.intersectPlane(this.ground, this.anchor)) { this.cancel(); return false; }
    this.velocity.copy(this.ray.ray.direction);
    this.velocity.y = 0;
    this.velocity.normalize().multiplyScalar(Math.max(2.2, Math.min(12, Math.sqrt(140 / this.selected.mass))));
    this.velocity.y = 3;
    return true;
  }

  release() {
    const t = this.selected;
    const velocity = this.velocity.clone();
    this.cancel();
    if (!t) return undefined;
    this.physics.unfreeze(t);
    t.body.setLinvel(velocity, true);
    t.body.setAngvel({ x: velocity.z * .35, y: 1.5, z: -velocity.x * .35 }, true);
    return t;
  }

  cancel() {
    this.selected = undefined;
    this.hovered = undefined;
  }

}
