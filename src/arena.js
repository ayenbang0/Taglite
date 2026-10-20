import { WORLD_W, WORLD_H, ZONE_CELL, RADIUS } from './config.js';
import { clamp, len, norm } from './math.js';
import { state } from './state.js';

/* =========================================================================
   ARENA LAYOUT
   Two rotationally-symmetric wall variants; later duels can roll the second
   one (see mapmods.js) so a deep run doesn't play the same geometry forever.
   ========================================================================= */
export function buildWalls(variant){
  const w = [];
  const t = 16; // border thickness
  w.push({x:0,y:0,w:WORLD_W,h:t,kind:'border'});
  w.push({x:0,y:WORLD_H-t,w:WORLD_W,h:t,kind:'border'});
  w.push({x:0,y:0,w:t,h:WORLD_H,kind:'border'});
  w.push({x:WORLD_W-t,y:0,w:t,h:WORLD_H,kind:'border'});

  // interior geometry is authored against a 1500x950 reference and scaled to
  // whatever the current mode's arena is, so wall density stays consistent
  const sx = WORLD_W/1500, sy = WORLD_H/950;
  const cx = WORLD_W/2, cy = WORLD_H/2;
  const pieces = (variant===1) ? [
    // variant B: open centre, heavier flanks
    {x:cx-150,y:cy-130,w:16,h:120},
    {x:cx+134,y:cy+10, w:16,h:120},
    {x:cx-150,y:cy-130,w:150,h:16},
    {x:cx,    y:cy+114,w:150,h:16},
    {x:cx-60, y:cy-16, w:120,h:16},
    {x:330,y:150,w:16,h:190},
    {x:WORLD_W-346,y:WORLD_H-340,w:16,h:190},
    {x:200,y:WORLD_H-300,w:210,h:16},
    {x:WORLD_W-410,y:284,w:210,h:16},
  ] : [
    // variant A: the original layout
    {x:cx-120,y:cy-90,w:100,h:16},
    {x:cx+20, y:cy+74,w:100,h:16},
    {x:cx-90, y:cy-90,w:16,h:90},
    {x:cx+74, y:cy,   w:16,h:90},
    {x:cx-16, y:cy-40,w:32,h:80},   // center block
    {x:275,y:188,w:16,h:150},
    {x:WORLD_W-291,y:WORLD_H-375,w:16,h:150},
    {x:275,y:WORLD_H-375,w:175,h:16},
    {x:WORLD_W-450,y:188,w:175,h:16},
  ];
  // stretch the outlying pieces outward with the arena; thickness stays put so
  // walls don't turn into slabs in the bigger modes
  pieces.forEach(p=>{
    const centred = Math.abs(p.x + p.w/2 - cx) < 200 && Math.abs(p.y + p.h/2 - cy) < 200;
    if(!centred){
      p.x = clamp(cx + (p.x + p.w/2 - cx)*sx - p.w/2, 20, WORLD_W-20-p.w);
      p.y = clamp(cy + (p.y + p.h/2 - cy)*sy - p.h/2, 20, WORLD_H-20-p.h);
    }
    w.push(p);
  });
  return w;
}

export function buildZones(params){
  const p = params || {};
  state.zoneGrid = new Map();
  const cols = Math.ceil(WORLD_W/ZONE_CELL);
  const rows = Math.ceil(WORLD_H/ZONE_CELL);
  const blobCount = p.blobCount || (6 + Math.floor(Math.random()*3));
  for(let i=0;i<blobCount;i++){
    let type;
    if(p.zoneBias === 'speed') type = 'speed';
    else if(p.zoneBias === 'slow') type = 'slow';
    else if(p.zoneBias === 'ice') type = Math.random()<0.7 ? 'ice' : 'slow';
    else type = Math.random()<0.5 ? 'slow' : 'speed';
    const c = 3 + Math.floor(Math.random()*(cols-6));
    const r = 3 + Math.floor(Math.random()*(rows-6));
    growZoneBlob(c, r, type, 8 + Math.floor(Math.random()*10));
  }
  // "DEAD PERIMETER" modifier: paint the outer band as slow ground
  if(p.outerRing){
    const margin = 3;
    for(let c=0;c<cols;c++){
      for(let r=0;r<rows;r++){
        if(c<margin || r<margin || c>=cols-margin || r>=rows-margin){
          state.zoneGrid.set(c+','+r, 'slow');
        }
      }
    }
  }
}

// random flood-fill from a seed cell so each patch has an organic, irregular outline
function growZoneBlob(c0, r0, type, size){
  const frontier = [{c:c0,r:r0}];
  const visited = new Set([c0+','+r0]);
  let count = 0;
  while(frontier.length && count<size){
    const idx = Math.floor(Math.random()*frontier.length);
    const cell = frontier.splice(idx,1)[0];
    const key = cell.c+','+cell.r;
    if(!state.zoneGrid.has(key)){ state.zoneGrid.set(key, type); count++; }
    const nbrs = [{c:cell.c+1,r:cell.r},{c:cell.c-1,r:cell.r},{c:cell.c,r:cell.r+1},{c:cell.c,r:cell.r-1}];
    for(const n of nbrs){
      const nkey = n.c+','+n.r;
      if(!visited.has(nkey) && Math.random()<0.65){
        visited.add(nkey);
        frontier.push(n);
      }
    }
  }
}

/** Recomputed each duel, since the arena resizes per mode. */
export function puSpawnPoints(){
  return [
    {x:WORLD_W*0.13, y:WORLD_H*0.5},
    {x:WORLD_W*0.87, y:WORLD_H*0.5},
    {x:WORLD_W*0.5,  y:WORLD_H*0.13},
    {x:WORLD_W*0.5,  y:WORLD_H*0.87},
    {x:WORLD_W*0.33, y:WORLD_H*0.5},
    {x:WORLD_W*0.67, y:WORLD_H*0.5},
  ];
}

/* =========================================================================
   QUERIES / COLLISION
   ========================================================================= */
export function zoneAt(x,y){
  for(const z of state.tempZones){
    if(len(x-z.x, y-z.y) <= z.r) return z;
  }
  const c = Math.floor(x/ZONE_CELL), r = Math.floor(y/ZONE_CELL);
  const t = state.zoneGrid.get(c+','+r);
  if(t) return {type:t};
  return null;
}

export function resolveWalls(e){
  if(e.intangibleT>0) return; // phased out of the world entirely
  const slide = e.mods && e.mods.wallSlide;   // GHOST WEIGHT keeps your speed
  for(const w of state.walls.concat(state.tempWalls)){
    const nx = clamp(e.x, w.x, w.x+w.w);
    const ny = clamp(e.y, w.y, w.y+w.h);
    const dx = e.x-nx, dy = e.y-ny;
    const d = len(dx,dy);
    if(d < RADIUS){
      if(d===0){
        // push out along smallest axis
        e.x += RADIUS; continue;
      }
      const push = (RADIUS-d);
      const n = norm(dx,dy);
      e.x += n.x*push; e.y += n.y*push;
      const vn = e.vx*n.x + e.vy*n.y;
      // BRITTLE BONES: speed is bought with fragility - hit a wall hard and
      // you're dazed for a moment
      if(e.mods && e.mods.brittleBones && vn < -70){
        e.stunT = Math.max(e.stunT, 0.5);
      }
      if(!slide){
        // WALL KICK: a hard hit springs you back off the wall and quickens your restart
        if(vn < -60 && e.mods && e.mods.wallKick){
          e.vx += n.x*(-vn)*0.5; e.vy += n.y*(-vn)*0.5;
          e.kickT = 0.6;
        }
        if(vn < 0){ e.vx -= vn*n.x; e.vy -= vn*n.y; }
      }
    }
  }
}

export function wallBlocked(x,y){
  for(const w of state.walls){
    if(x > w.x-RADIUS && x < w.x+w.w+RADIUS && y > w.y-RADIUS && y < w.y+w.h+RADIUS) return true;
  }
  for(const w of state.tempWalls){
    if(x > w.x-RADIUS && x < w.x+w.w+RADIUS && y > w.y-RADIUS && y < w.y+w.h+RADIUS) return true;
  }
  return false;
}

/** Does a straight segment cross a wall? Used by piercing-tag and bolt checks. */
export function segmentBlocked(x0,y0,x1,y1,step){
  const s = step || 4;
  const dx = x1-x0, dy = y1-y0;
  const d = len(dx,dy);
  if(d===0) return wallBlocked(x0,y0);
  const n = {x:dx/d, y:dy/d};
  for(let t=0;t<=d;t+=s){
    if(wallBlocked(x0+n.x*t, y0+n.y*t)) return true;
  }
  return false;
}
