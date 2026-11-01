import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { batchStatic } from '../../../packages/room-runtime/batch';
import { packObjects } from './knolling-pack';
import type { BuiltRoom } from '../../../packages/room-runtime/types';

interface Item { name: string; object: THREE.Object3D; size: THREE.Vector3; origin: THREE.Vector3; source: THREE.Object3D }
const inventory = new WeakMap<BuiltRoom, Item[]>();
const excluded = /^(slab|floor|ceiling|wall-|baseboard|crown|window|door(?:$|-)|plate-|beam|soffit|builtins-cabinetry|cabinet-door|oct7-charcoal|.*glow|.*halo)/i;
const label = (name: string) => name.replace(/^(oct7-|october-)/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Snapshot before static batching removes the original item boundaries. Geometry stays shared. */
export function collectInventory(room: BuiltRoom) {
  if (inventory.has(room)) return;
  room.group.updateMatrixWorld(true);
  const candidates: THREE.Object3D[] = [];
  const structural = new Set<THREE.Object3D>([room.group, ...room.walls.map(w => w.group), ...room.ceiling]);
  room.group.traverse(o => {
    if (structural.has(o) || !o.name || excluded.test(o.name) || o.name.includes(':')) return;
    const type = o.userData.physics?.type;
    if (type === 'dynamic' || type === 'static' || /^oct7-/.test(o.name)) candidates.push(o);
  });
  const candidateSet = new Set(candidates);
  const items: Item[] = [];
  for (const source of candidates) {
    // Separate nested possessions from their support (e.g. items standing on furniture).
    const copy = (node: THREE.Object3D): THREE.Object3D => {
      const clone = node.clone(false);
      for (const child of node.children) if (!candidateSet.has(child)) clone.add(copy(child));
      return clone;
    };
    const object = copy(source);
    source.matrixWorld.decompose(object.position, object.quaternion, object.scale);
    // Opt-in for pieces displayed leaning or propped: knoll them in their own rest frame instead.
    if (source.userData.knollRestPose) object.quaternion.identity();
    object.visible = true;
    object.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(object);
    if (bounds.isEmpty()) continue;
    const size = bounds.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) < 0.015) continue;
    object.position.sub(bounds.getCenter(new THREE.Vector3()));
    object.updateMatrixWorld(true);
    items.push({ name: label(source.name), object, size, origin: bounds.getCenter(new THREE.Vector3()), source });
  }
  inventory.set(room, items.sort((a, b) => Math.max(b.size.x,b.size.z) * Math.max(b.size.y,b.size.z) - Math.max(a.size.x,a.size.z) * Math.max(a.size.y,a.size.z)));
}

/**
 * Opt-in grouping: when a room tags pieces with `userData.knollGroup` (and optionally a numeric
 * `userData.knollGroupOrder`), each group is packed on its own and the groups are laid out in rows
 * under a floor label. Rooms without tags get the single MaxRects pack exactly as before.
 */
function groupedPack(items: Item[], rects: {width:number;height:number}[], gap: number) {
  const keys=items.map(i=>i.source.userData.knollGroup as string|undefined);
  if(!keys.some(Boolean))return {...packObjects(rects,gap),labels:[] as {text:string;x:number;y:number;size:number}[]};
  const order=new Map<string,number>();
  items.forEach((item,i)=>{const k=keys[i]??'Other',o=item.source.userData.knollGroupOrder??1e9;order.set(k,Math.min(order.get(k)??1e9,o));});
  const blocks=[...order.keys()].sort((a,b)=>order.get(a)!-order.get(b)!||a.localeCompare(b)).map(key=>{
    const index=keys.map((k,i)=>(k??'Other')===key?i:-1).filter(i=>i>=0);
    // Lay long pieces (conduit runs, rods) along the group's strip rather than letting them set its height.
    const long=Math.max(...index.map(i=>Math.max(rects[i].width,rects[i].height)))+gap;
    return {key,index,pack:packObjects(index.map(i=>rects[i]),gap,long),x:0,y:0};
  });
  const G=.45,L=.4,size=.27;
  const total=blocks.reduce((s,b)=>s+(b.pack.width+G)*(b.pack.height+L+G),0);
  const rowWidth=Math.max(Math.sqrt(total*1.6),...blocks.map(b=>b.pack.width));
  let x=0,y=0,rowHeight=0,width=0;
  for(const b of blocks){
    if(x>0&&x+b.pack.width>rowWidth){x=0;y+=rowHeight+G;rowHeight=0;}
    b.x=x;b.y=y+L;x+=b.pack.width+G;rowHeight=Math.max(rowHeight,b.pack.height+L);width=Math.max(width,x-G);
  }
  const placements=blocks.flatMap(b=>b.pack.placements.map(p=>({...p,index:b.index[p.index],x:p.x+b.x,y:p.y+b.y})));
  const labels=blocks.map(b=>({text:`${b.key} · ${b.index.length}`,x:b.x,y:b.y-L/2,size}));
  return {placements,width,height:y+rowHeight,labels};
}
/** Flat floor caption, left-aligned at (x, z), `size` m tall. */
function groupLabel(text: string, x: number, z: number, size: number) {
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d')!;const px=96;
  ctx.font=`600 ${px}px system-ui, sans-serif`;canvas.width=Math.ceil(ctx.measureText(text).width)+16;canvas.height=Math.ceil(px*1.3);
  ctx.font=`600 ${px}px system-ui, sans-serif`;ctx.fillStyle='#3c372e';ctx.textBaseline='middle';ctx.fillText(text,8,canvas.height/2);
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=8;
  const w=size*canvas.width/canvas.height;
  const label=new THREE.Mesh(new THREE.PlaneGeometry(w,size),new THREE.MeshBasicMaterial({map,transparent:true,toneMapped:false}));
  label.name='knoll-group-label';label.rotation.x=-Math.PI/2;label.position.set(x+w/2,.002,z);label.renderOrder=1;
  return label as THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>;
}

/** Shared arrangement for the interactive view and deterministic animations. */
export function createKnollingLayout(room: BuiltRoom) {
  collectInventory(room);
  const items=inventory.get(room)??[];
  const objects=new THREE.Group();
  const originalGeometries=new Set<THREE.BufferGeometry>();
  const laidOut=items.map(item=>{
    const holder=new THREE.Group();const object=item.object.clone(true);holder.add(object);
    // Find the upright yaw that gives the tightest footprint before laying thin
    // vertical objects (screens, prints, tools) onto their broad face.
    let angle=0,area=Infinity;
    for(let i=0;i<36;i++){
      holder.rotation.y=i*Math.PI/72;holder.updateMatrixWorld(true);
      const size=new THREE.Box3().setFromObject(holder).getSize(new THREE.Vector3());
      if(size.x*size.z<area){area=size.x*size.z;angle=holder.rotation.y;}
    }
    holder.rotation.y=angle;holder.updateMatrixWorld(true);
    const upright=new THREE.Box3().setFromObject(holder).getSize(new THREE.Vector3());
    const flat=new THREE.Group();flat.add(holder);
    const staysUpright=/Rubber Plant|Workbench|Desk Slab Frame|Aeron Chair|Eames/i.test(item.name);
    if(!staysUpright&&upright.z<Math.min(upright.x,upright.y))flat.rotation.x=Math.PI/2;
    else if(!staysUpright&&upright.x<Math.min(upright.y,upright.z))flat.rotation.z=-Math.PI/2;
    // Lay labeled/display faces upward, rather than showing the backs of monitors
    // and framed prints. Weight emissive screen maps above generic body textures.
    flat.updateMatrixWorld(true);
    let faceScore=0;
    flat.traverse(node=>{
      if(!(node instanceof THREE.Mesh)||Array.isArray(node.material))return;
      const material=node.material as THREE.MeshStandardMaterial;
      if(!material.map&&!material.emissiveMap)return;
      const pos=node.geometry.getAttribute('position'),idx=node.geometry.index;
      const count=idx?idx.count:pos.count,step=Math.max(1,Math.floor(count/600))*3;
      const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
      for(let i=0;i+2<count;i+=step){
        a.fromBufferAttribute(pos,idx?idx.getX(i):i).applyMatrix4(node.matrixWorld);
        b.fromBufferAttribute(pos,idx?idx.getX(i+1):i+1).applyMatrix4(node.matrixWorld);
        c.fromBufferAttribute(pos,idx?idx.getX(i+2):i+2).applyMatrix4(node.matrixWorld);
        faceScore+=b.sub(a).cross(c.sub(a)).y*(material.emissiveMap?5:1);
      }
    });
    if(!staysUpright&&faceScore<-.0001)flat.rotateOnWorldAxis(new THREE.Vector3(1,0,0),Math.PI);
    const orient=new THREE.Group();orient.add(flat);orient.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(orient);const size=bounds.getSize(new THREE.Vector3());
    flat.position.sub(bounds.getCenter(new THREE.Vector3()));flat.position.y+=size.y/2;
    orient.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=true;o.receiveShadow=true;originalGeometries.add(o.geometry);}});
    objects.add(orient);return {orient,size,object};
  });
  const gap=.065;
  const packed=groupedPack(items,laidOut.map(({size})=>({width:size.x,height:size.z})),gap);
  for(const p of packed.placements){const {orient}=laidOut[p.index];if(p.rotated)orient.rotation.y=Math.PI/2;orient.position.set(p.x+(p.width-gap)/2-packed.width/2,0,p.y+(p.height-gap)/2-packed.height/2);}
  const labelResources:{dispose():void}[]=[];
  for(const l of packed.labels){const label=groupLabel(l.text,l.x-packed.width/2,l.y-packed.height/2,l.size);labelResources.push(label.material,label.material.map!);objects.add(label);}
  objects.updateMatrixWorld(true);
  return {objects,items,laidOut,packed,originalGeometries,labelResources};
}

let cleanup: (()=>void) | undefined;
export function stopKnolling() { cleanup?.(); cleanup=undefined; }
export async function showKnolling(host: HTMLElement, room: BuiltRoom, title: string) {
  stopKnolling();host.replaceChildren();
  const items=inventory.get(room)??[];
  const caption=document.createElement('header');
  const heading=document.createElement('h1');heading.textContent=title;
  const note=document.createElement('p');note.textContent=`${items.length} modeled objects & assemblies · Same scale · Drag to orbit · Right-drag to pan · Scroll to zoom`;
  const fitButton=document.createElement('button');fitButton.textContent='Fit all';
  caption.append(heading,note,fitButton);host.append(caption);
  if(!items.length){note.textContent='No individually modeled objects in this room yet.';return;}
  const renderer=new THREE.WebGLRenderer({antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
  renderer.toneMapping=THREE.AgXToneMapping;renderer.toneMappingExposure=1.05;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  host.prepend(renderer.domElement);renderer.domElement.setAttribute('aria-label','Overhead knolling arrangement');
  const scene=new THREE.Scene();scene.background=new THREE.Color('#d7d0c1');
  const studio=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer);
  const environment=pmrem.fromScene(studio,.08);scene.environment=environment.texture;scene.environmentIntensity=.3;
  studio.dispose();pmrem.dispose();
  scene.add(new THREE.HemisphereLight('#fffaf0','#a59b85',2));
  const {objects,packed,originalGeometries,labelResources}=createKnollingLayout(room);
  scene.add(objects);
  batchStatic(objects,[],{mergeDynamic:true});
  const floorMaterial=new THREE.MeshStandardMaterial({color:'#d7d0c1',roughness:1});
  const floorGeometry=new THREE.PlaneGeometry(200,200);
  const floor=new THREE.Mesh(floorGeometry,floorMaterial);floor.rotation.x=-Math.PI/2;floor.position.y=-.015;floor.receiveShadow=true;scene.add(floor);
  const light=new THREE.DirectionalLight('#fff8e9',2.8);light.position.set(-5,14,-4);light.castShadow=true;
  const extent=Math.max(packed.width,packed.height);
  Object.assign(light.shadow.camera,{left:-extent,right:extent,top:extent,bottom:-extent,near:.1,far:50});
  light.shadow.mapSize.set(4096,4096);light.shadow.normalBias=.012;light.shadow.bias=-.0001;scene.add(light);
  const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,100);
  camera.position.set(0,30,.001);camera.up.set(0,1,0);camera.lookAt(0,0,0);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableRotate=true;controls.enableDamping=false;controls.maxPolarAngle=Math.PI/2-.04;
  controls.screenSpacePanning=true;controls.mouseButtons.LEFT=THREE.MOUSE.ROTATE;controls.mouseButtons.RIGHT=THREE.MOUSE.PAN;controls.minZoom=.5;controls.maxZoom=18;
  let pending=0,disposed=false;
  const render=()=>{if(disposed||pending)return;pending=requestAnimationFrame(()=>{pending=0;renderer.render(scene,camera);renderer.shadowMap.autoUpdate=false;host.dataset.ready='1';});};
  // Fit the arrangement into the area below the caption header (it overlays the canvas), not the whole canvas.
  const fit=()=>{
    const W=host.clientWidth,H=host.clientHeight,aspect=W/H;
    const header=Math.min(H*.4,Math.max(0,caption.getBoundingClientRect().bottom-host.getBoundingClientRect().top+8));
    const perPx=Math.max((packed.height+1)/(H-header),(packed.width+1)/W),height=perPx*H,shift=-header/2*perPx;
    camera.left=-height*aspect/2;camera.right=height*aspect/2;camera.top=height/2;camera.bottom=-height/2;camera.zoom=1;
    camera.position.set(0,30,shift+.001);controls.target.set(0,0,shift);camera.updateProjectionMatrix();controls.update();render();
  };
  const resize=()=>{renderer.setSize(host.clientWidth,host.clientHeight);fit();};
  const observer=new ResizeObserver(resize);observer.observe(host);
  controls.addEventListener('change',render);fitButton.addEventListener('click',fit);renderer.domElement.addEventListener('dblclick',fit);
  host.dataset.ready='0';host.dataset.items=String(items.length);resize();
  cleanup=()=>{disposed=true;cancelAnimationFrame(pending);observer.disconnect();controls.dispose();environment.dispose();light.shadow.dispose();floorGeometry.dispose();floorMaterial.dispose();objects.traverse(o=>{if(o instanceof THREE.Mesh&&!originalGeometries.has(o.geometry))o.geometry.dispose();});for(const r of labelResources)r.dispose();renderer.dispose();renderer.forceContextLoss();};
}
