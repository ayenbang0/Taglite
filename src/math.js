export function len(x,y){ return Math.sqrt(x*x+y*y); }
export function norm(x,y){ const l = len(x,y)||1; return {x:x/l,y:y/l}; }
export function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
export function clampInt(v,a,b){ return Math.max(a, Math.min(b,v)); }
export function dist(a,b){ return len(a.x-b.x, a.y-b.y); }
export function rotateVec(v, deg){
  const rad = deg*Math.PI/180;
  return {x: v.x*Math.cos(rad)-v.y*Math.sin(rad), y: v.x*Math.sin(rad)+v.y*Math.cos(rad)};
}
