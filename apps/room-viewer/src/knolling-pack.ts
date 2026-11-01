export interface Rectangle { width: number; height: number }
export interface Placement extends Rectangle { index: number; x: number; y: number; rotated: boolean }

/** MaxRects: split each free rectangle around the placed item; prune contained spaces. */
/** `minWidth` (optional) widens the strip so long pieces can lie along it instead of standing it tall. */
export function packObjects(items: Rectangle[], gap = 0.07, minWidth = 0) {
  const area = items.reduce((sum,r)=>sum+(r.width+gap)*(r.height+gap),0);
  const order = items.map((r,index)=>({...r,index})).sort((a,b)=>Math.max(b.width,b.height)-Math.max(a.width,a.height));
  let best: { placements: Placement[]; width: number; height: number; score: number } | undefined;
  for(const aspect of [1.1,1.35,1.6,1.85]) {
    const width=Math.max(Math.sqrt(area*aspect),minWidth,...items.map(r=>Math.min(r.width,r.height)+gap));
    const free=[{x:0,y:0,width,height:area/width*4+10}];
    const placements: Placement[]=[];
    for(const item of order) {
      let pick: Placement | undefined, score=Infinity;
      for(const f of free)for(const rotated of [false,true]) {
        const w=(rotated?item.height:item.width)+gap,h=(rotated?item.width:item.height)+gap;
        if(w>f.width+1e-8||h>f.height+1e-8)continue;
        const s=f.y*width+Math.min(f.width-w,f.height-h)*.2;
        if(s<score){score=s;pick={index:item.index,x:f.x,y:f.y,width:w,height:h,rotated};}
      }
      if(!pick)throw new Error('Unable to pack knolling object');
      const p=pick; placements.push(p);
      const next: typeof free=[];
      for(const f of free){
        if(p.x>=f.x+f.width||p.x+p.width<=f.x||p.y>=f.y+f.height||p.y+p.height<=f.y){next.push(f);continue;}
        if(p.x>f.x)next.push({...f,width:p.x-f.x});
        if(p.x+p.width<f.x+f.width)next.push({...f,x:p.x+p.width,width:f.x+f.width-p.x-p.width});
        if(p.y>f.y)next.push({...f,height:p.y-f.y});
        if(p.y+p.height<f.y+f.height)next.push({...f,y:p.y+p.height,height:f.y+f.height-p.y-p.height});
      }
      free.splice(0,free.length,...next.filter((r,i)=>!next.some((s,j)=>i!==j&&r.x>=s.x&&r.y>=s.y&&r.x+r.width<=s.x+s.width&&r.y+r.height<=s.y+s.height&&(j<i||r.x!==s.x||r.y!==s.y||r.width!==s.width||r.height!==s.height))));
    }
    const height=Math.max(...placements.map(p=>p.y+p.height));
    const usedWidth=Math.max(...placements.map(p=>p.x+p.width));
    const score=usedWidth*height*(1+Math.abs(Math.log(usedWidth/height/1.45))*.15);
    if(!best||score<best.score)best={placements,width:usedWidth,height,score};
  }
  return best!;
}
