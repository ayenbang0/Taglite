import { IW, IH, ISO_X, ISO_Y, ISO_Z } from './config.js';
import { state } from './state.js';

/* =========================================================================
   ISOMETRIC PROJECTION
   Gameplay lives in top-down world space (x,y); only presentation and input
   are projected. 1 voxel = 1 world unit; larger x+y is nearer the viewer.
   `state.camera` is the world point shown at the centre of the screen.
   ========================================================================= */

const SQRT2 = 1.41421356;
const INV_SQRT2 = 0.70710678;

export function project(x, y, z = 0){
  const c = state.camera;
  return {
    x: IW/2 + ((x-c.x) - (y-c.y))*ISO_X,
    y: IH/2 + ((x-c.x) + (y-c.y))*ISO_Y - z*ISO_Z,
  };
}

export function projectVec(dx, dy, dz = 0){
  return { x:(dx-dy)*ISO_X, y:(dx+dy)*ISO_Y - dz*ISO_Z };
}

/** Inverse of `project` on the ground plane (z = 0). */
export function screenToWorld(sx, sy){
  const c = state.camera;
  const a = (sx - IW/2)/ISO_X;
  const b = (sy - IH/2)/ISO_Y;
  return { x: c.x + (a+b)/2, y: c.y + (b-a)/2 };
}

/** Unit screen-space direction of a world-space direction. */
export function dirToScreen(dx, dy){
  const v = projectVec(dx, dy);
  const l = Math.hypot(v.x, v.y) || 1;
  return { x:v.x/l, y:v.y/l };
}

/** Screen-relative WASD -> world direction (W = screen-up = world (-.707,-.707)). */
export function inputToWorld(sx, sy){
  return { x:(sx+sy)*INV_SQRT2, y:(sy-sx)*INV_SQRT2 };
}

export function onScreen(sx, sy, margin = 0){
  return sx > -margin && sx < IW+margin && sy > -margin && sy < IH+margin;
}

/* ---- pixel-crisp primitives (no anti-aliased arcs) ---- */

export function pixelLine(ctx, x0, y0, x1, y1, color){
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  ctx.fillStyle = color;
  const dx = Math.abs(x1-x0), dy = -Math.abs(y1-y0);
  const sx = x0<x1 ? 1 : -1, sy = y0<y1 ? 1 : -1;
  let err = dx+dy, guard = 2000;
  for(;;){
    ctx.fillRect(x0, y0, 1, 1);
    if((x0===x1 && y0===y1) || --guard<=0) break;
    const e2 = 2*err;
    if(e2 >= dy){ err += dy; x0 += sx; }
    if(e2 <= dx){ err += dx; y0 += sy; }
  }
}

/** Midpoint ellipse outline; `from`/`to` (radians, 0..2PI) optionally restrict to an arc. */
function ellipsePoints(cx, cy, rx, ry, fn){
  rx = Math.max(1, Math.round(rx)); ry = Math.max(1, Math.round(ry));
  cx = Math.round(cx); cy = Math.round(cy);
  let x = 0, y = ry;
  let d1 = ry*ry - rx*rx*ry + 0.25*rx*rx;
  let dx = 2*ry*ry*x, dy = 2*rx*rx*y;
  while(dx < dy){
    fn(cx+x, cy+y); fn(cx-x, cy+y); fn(cx+x, cy-y); fn(cx-x, cy-y);
    if(d1 < 0){ x++; dx += 2*ry*ry; d1 += dx + ry*ry; }
    else { x++; y--; dx += 2*ry*ry; dy -= 2*rx*rx; d1 += dx - dy + ry*ry; }
  }
  let d2 = ry*ry*(x+0.5)*(x+0.5) + rx*rx*(y-1)*(y-1) - rx*rx*ry*ry;
  while(y >= 0){
    fn(cx+x, cy+y); fn(cx-x, cy+y); fn(cx+x, cy-y); fn(cx-x, cy-y);
    if(d2 > 0){ y--; dy -= 2*rx*rx; d2 += rx*rx - dy; }
    else { y--; x++; dx += 2*ry*ry; dy -= 2*rx*rx; d2 += dx - dy + rx*rx; }
  }
}

/** Ring on the ground plane (a world-space circle of radius r). */
export function groundRing(ctx, x, y, r, color, alpha = 1){
  const s = project(x, y);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  ellipsePoints(s.x, s.y, r*SQRT2*ISO_X, r*SQRT2*ISO_Y, (px, py)=>ctx.fillRect(px, py, 1, 1));
  ctx.restore();
}

/** Partial ring for progress sweeps: draws the arc from angle a0 to a1 (radians, world-space). */
export function groundArc(ctx, x, y, r, a0, a1, color, alpha = 1){
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  const steps = Math.max(8, Math.ceil(r*2));
  for(let i=0;i<=steps;i++){
    const a = a0 + (a1-a0)*(i/steps);
    const p = project(x + Math.cos(a)*r, y + Math.sin(a)*r);
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
  }
  ctx.restore();
}

/** Filled disc on the ground plane, built from scanline spans. */
export function groundDisc(ctx, x, y, r, color, alpha = 1){
  const s = project(x, y);
  const rx = Math.max(1, Math.round(r*SQRT2*ISO_X)), ry = Math.max(1, Math.round(r*SQRT2*ISO_Y));
  const cx = Math.round(s.x), cy = Math.round(s.y);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  for(let yy=-ry; yy<=ry; yy++){
    const w = Math.round(rx*Math.sqrt(Math.max(0, 1 - (yy*yy)/(ry*ry))));
    ctx.fillRect(cx-w, cy+yy, w*2+1, 1);
  }
  ctx.restore();
}
