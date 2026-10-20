/* =========================================================================
   PATHFINDING GRID
   A coarse walkability grid + bounded BFS, rebuilt once per round from the
   static walls. This lets bots route around long walls/corners instead of
   only reacting to what's a few pixels in front of them.
   ========================================================================= */
import { WORLD_W, WORLD_H, PATH_CELL } from './config.js';
import { clampInt } from './math.js';
import { wallBlocked } from './arena.js';
import { state } from './state.js';

export function buildPathGrid(){
  state.pathCols = Math.ceil(WORLD_W/PATH_CELL);
  state.pathRows = Math.ceil(WORLD_H/PATH_CELL);
  state.pathGrid = new Uint8Array(state.pathCols*state.pathRows);
  for(let r=0;r<state.pathRows;r++){
    for(let c=0;c<state.pathCols;c++){
      const cx = c*PATH_CELL + PATH_CELL/2, cy = r*PATH_CELL + PATH_CELL/2;
      state.pathGrid[r*state.pathCols+c] = wallBlocked(cx,cy) ? 1 : 0;
    }
  }
}

export function cellIndex(c,r){ return r*state.pathCols + c; }

export function worldToCell(x,y){
  return {c: clampInt(Math.floor(x/PATH_CELL),0,state.pathCols-1), r: clampInt(Math.floor(y/PATH_CELL),0,state.pathRows-1)};
}

export function nearestFreeCell(c,r){
  if(state.pathGrid[cellIndex(c,r)]===0) return {c,r};
  for(let rad=1; rad<7; rad++){
    for(let dr=-rad; dr<=rad; dr++){
      for(let dc=-rad; dc<=rad; dc++){
        const nc=c+dc, nr=r+dr;
        if(nc<0||nr<0||nc>=state.pathCols||nr>=state.pathRows) continue;
        if(state.pathGrid[cellIndex(nc,nr)]===0) return {c:nc,r:nr};
      }
    }
  }
  return {c,r};
}

// bounded 8-directional BFS; returns an array of {c,r} cells from start to target, or null
export function bfsPath(startC,startR,targetC,targetR,maxNodes){
  maxNodes = maxNodes || 2500;
  const startIdx = cellIndex(startC,startR), targetIdx = cellIndex(targetC,targetR);
  if(startIdx===targetIdx) return [{c:startC,r:startR}];
  const cameFrom = new Int32Array(state.pathCols*state.pathRows).fill(-1);
  const visited = new Uint8Array(state.pathCols*state.pathRows);
  const queue = [startIdx];
  visited[startIdx] = 1;
  let head = 0, nodes = 0, found = false;
  const dirs8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  while(head<queue.length && nodes<maxNodes){
    const cur = queue[head++]; nodes++;
    if(cur===targetIdx){ found = true; break; }
    const cr = Math.floor(cur/state.pathCols), cc = cur - cr*state.pathCols;
    for(const [dc,dr] of dirs8){
      const nc = cc+dc, nr = cr+dr;
      if(nc<0||nr<0||nc>=state.pathCols||nr>=state.pathRows) continue;
      const nidx = cellIndex(nc,nr);
      if(visited[nidx] || state.pathGrid[nidx]===1) continue;
      if(dc!==0 && dr!==0){
        // don't let the path cut across a solid corner diagonally
        if(state.pathGrid[cellIndex(cc+dc,cr)]===1 && state.pathGrid[cellIndex(cc,cr+dr)]===1) continue;
      }
      visited[nidx] = 1;
      cameFrom[nidx] = cur;
      queue.push(nidx);
    }
  }
  if(!found) return null;
  const path = [];
  let cur = targetIdx;
  while(cur!==-1){
    path.push({c: cur % state.pathCols, r: Math.floor(cur/state.pathCols)});
    if(cur===startIdx) break;
    cur = cameFrom[cur];
  }
  path.reverse();
  return path;
}
