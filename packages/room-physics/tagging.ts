import * as THREE from 'three';

/**
 * Physics tags, set by the room modules on the top-level Object3D of each physical thing:
 *   obj.userData.physics = { type: 'dynamic', mass: 2, shape: 'hull' }
 * Untagged meshes become static colliders (merged into a few big trimeshes).
 */
export type ShapeKind =
  | 'hull' // convex hull of all its meshes (default)
  | 'compound' // one convex hull per mesh
  | 'decompose' // V-HACD convex decomposition (cached in IndexedDB), for concave things like chairs
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'container'; // open-top bin/basket: a floor + thin walls around its bounds, so things fit inside

export type SurfaceKind = 'rubber' | 'soft' | 'wood' | 'metal' | 'plastic' | 'glass' | 'cardboard' | 'stone';

export interface PhysicsTag {
  type: 'dynamic' | 'static' | 'none';
  /** False: movable by the player, but impacts do not detach this furnishing. */
  wakeOnImpact?: boolean;
  /** False for independently mounted objects, which do not rest on nearby props. */
  wakeOnSupportLoss?: boolean;
  /** m/s: a frozen piece only detaches when struck at least this fast (e.g. sign letters held in grooves). */
  breakSpeed?: number;
  /** m/s: on detaching, push the piece out along its local +z (off the board it hangs on) with a little spin. */
  detachKick?: number;
  /**
   * Breakable pane (playground): at `breakSpeed` it shatters into shards instead of detaching whole.
   * releases: frees every piece `heldBy` this id; backstop: a shards-only stop behind the pane (recessed wall glass);
   * out: shards start this far toward the room (m), clear of the sill / transom bar the pane stands on.
   */
  shatter?: {
    thickness?: number; releases?: string; backstop?: boolean; out?: number;
    /** panes sharing a group break together (the four walls of a candy hopper) */
    group?: string;
    /** keep at most this many (largest) pieces */
    maxPieces?: number;
    /** while intact, a solid collider for everything (not just pucks): things leaning on the glass */
    solid?: boolean;
  };
  /** Held in place (e.g. behind case glass): stays fixed, ungrabbable and unhittable until Physics.release(id). */
  heldBy?: string;
  /** kg (dynamic only); estimated from the volume when missing */
  mass?: number;
  shape?: ShapeKind;
  /** Box collision margin per side, in meters; leaves decorative protrusions visual-only. */
  boxInset?: [number, number, number];
  /** containers: round (circle of wall segments) instead of the bounding box */
  round?: boolean;
  /** surface preset for friction / restitution / impact sound; guessed from names when missing */
  surface?: SurfaceKind;
  friction?: number;
  restitution?: number;
}

export const physicsTag = (o: THREE.Object3D) => o.userData.physics as PhysicsTag | undefined;

export const SURFACES: Record<SurfaceKind, { friction: number; restitution: number; density: number; damping: number }> = {
  rubber: { friction: 0.9, restitution: 0.72, density: 180, damping: 0.05 }, // balls: mostly air
  soft: { friction: 1.0, restitution: 0.02, density: 60, damping: 0.6 }, // pillows, bags, jackets
  wood: { friction: 0.55, restitution: 0.2, density: 450, damping: 0.05 },
  metal: { friction: 0.4, restitution: 0.15, density: 700, damping: 0.05 },
  plastic: { friction: 0.5, restitution: 0.3, density: 140, damping: 0.05 },
  glass: { friction: 0.35, restitution: 0.25, density: 500, damping: 0.05 },
  cardboard: { friction: 0.7, restitution: 0.08, density: 120, damping: 0.1 },
  stone: { friction: 0.6, restitution: 0.1, density: 1500, damping: 0.05 },
};

/** Guess a surface from object / material names */
export function guessSurface(obj: THREE.Object3D): SurfaceKind {
  const names = [obj.name];
  obj.traverse((o) => {
    if (o !== obj && o.name) names.push(o.name);
    const m = (o as THREE.Mesh).material;
    if (m) for (const mm of Array.isArray(m) ? m : [m]) if (mm.name) names.push(mm.name);
  });
  const s = names.join(' ').toLowerCase();
  if (/ball|rubber|tire|tyre/.test(s)) return 'rubber';
  if (/pillow|cushion|bag|jacket|coat|backpack|blanket|fabric|plush|stuffed|towel|hoodie|hat|glove/.test(s)) return 'soft';
  if (/cardboard|carton|parts-box|box|paper|book/.test(s)) return 'cardboard';
  if (/glass|bottle|jar|mug|cup/.test(s)) return 'glass';
  if (/steel|metal|alu|iron|brass|drill|tool|can\b|trophy|dumbbell|weight/.test(s)) return 'metal';
  if (/wood|oak|walnut|board|stool/.test(s)) return 'wood';
  return 'plastic';
}

/**
 * Fallback auto-tagging for objects nobody has tagged yet: a named, free-standing, small
 * object that rests on something becomes dynamic. Configurable per room and via the URL:
 *   ?auto=0 (off) · ?autoMax=0.6 (largest bounding-box side, m) · ?autoLog=0
 */
export interface AutoTagConfig {
  enabled: boolean;
  /** largest bounding-box side (m) */
  maxSize: number;
  /** smallest largest side (m): skip crumbs */
  minSize: number;
  /** skip flat decals/stickers thinner than this on every axis but one */
  minThickness: number;
  /** must rest on something within this gap below it (m), else it's mounted/floating → static */
  supportGap: number;
  /** anything this close to a wall plane and above this height counts as wall-mounted → static */
  wallGap: number;
  wallMountMinY: number;
  /** bounding-box fill fraction used for the mass estimate (mass = bbox volume × fill × density) */
  fill: number;
  minMass: number;
  maxMass: number;
  /** names never auto-tagged */
  exclude: RegExp;
  /** only consider named objects (item files name their things; unnamed pieces are usually parts of furniture) */
  requireName: boolean;
}

const BASE: AutoTagConfig = {
  enabled: true,
  maxSize: 0.6,
  minSize: 0.04,
  minThickness: 0.008,
  supportGap: 0.05,
  wallGap: 0.03,
  wallMountMinY: 0.2,
  fill: 0.35,
  minMass: 0.05,
  maxMass: 25,
  requireName: true,
  exclude: /rug|mat\b|glow|halo|light|lamp|cable|cord|wire|screen|shadow|decal|sticker|label|outlet|switch|plate|frame|poster|print|panel|trap|curtain|blind|vent|trim|casing|baseboard|slab|floor|ceiling|wall|window|door|shelf|soffit|beam/i,
};

/** Rooms whose objects are tagged by hand get no fallback */
const PER_ROOM: Record<string, Partial<AutoTagConfig>> = {
  'office-v2': {},
  office: {}, // the first office pass names nothing, so only named things (none yet) qualify
  house: { enabled: false }, // Preserve explicit prop tags; never detach architecture from assembled rooms.
};

export function autoTagConfig(roomId: string, q = new URLSearchParams(location.search)): AutoTagConfig {
  const c = { ...BASE, ...PER_ROOM[roomId] };
  if (q.has('auto')) c.enabled = q.get('auto') !== '0';
  if (q.has('autoMax')) c.maxSize = Number(q.get('autoMax'));
  return c;
}

const GENERIC = /^(|Mesh|Group|Object3D|Scene)$/;
/** batch meshes from the parts ("desk:alu") and unnamed pieces are not separable objects */
export const isNamedObject = (o: THREE.Object3D) => !GENERIC.test(o.name) && !o.name.includes(':');
