/*
 * 죽림고수 자동 회피 봇 (와플래시 https://waflash.org/107 용)
 *
 * 사용법
 *  1. 크롬에서 https://waflash.org/107 을 열고 재생 버튼(▶)을 눌러 게임을 띄운다.
 *  2. F12 → Console 탭에 이 파일 전체를 붙여 넣고 Enter. (붙여넣기가 막히면 콘솔에 allow pasting 입력 후 다시)
 *  3. 타이틀 화면의 "게임시작"을 직접 한 번 누른다. 그다음부터는 봇이 조작하고, 죽으면 "다시하기"를 자동으로 누른다.
 *     (자동 재시작이 안 되면 마우스 커서를 "다시하기" 버튼 위에 올려 두거나 한 번 직접 눌러 주면 된다.)
 *  - 멈추기: jjStop()      - 상태 보기: jjStatus()
 *
 * 동작 원리
 *  - 와플래시 에뮬레이터가 매 프레임 960x471 RGBA 픽셀을 WebGL 텍스처로 올리는 순간(texSubImage2D)을 가로채
 *    원본 프레임을 분석한다(화면 캡처 없이, 게임 프레임마다 정확히 1번).
 *  - 주황 모자 = 캐릭터, 회색 몸통 + 주황 깃털 = 화살. 화살은 프레임 간 추적해서 속도를 최소제곱으로 추정.
 *  - 2단계 이동 계획 297개를 1초(30틱) 앞까지 시뮬레이션하고, 캐릭터·화살 바운딩 박스 충돌(hitTestObject 방식)
 *    + 안전거리 + 테두리 회피 비용이 가장 낮은 방향키를 누른다.
 *  - 좌표 상수는 게임 캔버스가 960x471일 때 기준이다.
 */
(() => {
'use strict';
const canvas = document.querySelector('canvas');
if (!canvas) { console.error('[죽림고수 봇] 게임 캔버스를 찾지 못했습니다. 재생 버튼을 먼저 누르세요.'); return; }
if (canvas.width !== 960 || canvas.height !== 471) {
  console.warn('[죽림고수 봇] 캔버스 크기가 ' + canvas.width + 'x' + canvas.height + '입니다. 이 봇은 960x471 기준이라 인식이 어긋날 수 있습니다. 브라우저 창을 넓히고 새로고침해 보세요.');
}
const gl = canvas.getContext('webgl');
if (!gl) { console.error('[죽림고수 봇] WebGL 컨텍스트를 얻지 못했습니다.'); return; }

// ── 1. requestAnimationFrame을 60Hz MessageChannel 스케줄러로 교체 ──────────────
//    탭이 포커스를 잃으면 크롬이 rAF를 초당 1~3번으로 줄여 게임이 슬로모션이 되므로,
//    일반 화면과 같은 약 60fps로 계속 돌게 한다(게임을 더 빠르게 만들지는 않음).
{
  const ch = new MessageChannel(); let q = [], pending = false, last = 0, id = 0;
  ch.port1.onmessage = () => {
    const now = performance.now();
    if (now - last < 16.0) { ch.port2.postMessage(0); return; }
    last = now; pending = false; const cbs = q; q = [];
    for (const f of cbs) { try { f(now); } catch (e) { window.__err = String(e); } }
  };
  window.requestAnimationFrame = cb => { q.push(cb); if (!pending) { pending = true; ch.port2.postMessage(0); } return ++id; };
}

// ── 2. 입력 헬퍼 ───────────────────────────────────────────────────────────────
const KEYS = { L: [37, 'ArrowLeft'], U: [38, 'ArrowUp'], R: [39, 'ArrowRight'], D: [40, 'ArrowDown'] };
window.__send = (type, n) => {
  const [code, k] = KEYS[n];
  const e = new KeyboardEvent(type, { key: k, code: k, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => code });
  Object.defineProperty(e, 'which', { get: () => code });
  canvas.dispatchEvent(e);
};
// "다시하기" 버튼 클릭: 플래시 버튼은 마우스오버 상태를 거쳐야 눌리므로 이동→누름→뗌을 시간차를 두고 보낸다.
window.__click = () => {
  const r = canvas.getBoundingClientRect(); const x = r.left + 552, y = r.top + 291;
  const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', view: window };
  const mv = () => { canvas.dispatchEvent(new PointerEvent('pointerover', o)); canvas.dispatchEvent(new PointerEvent('pointermove', o)); canvas.dispatchEvent(new MouseEvent('mouseover', o)); canvas.dispatchEvent(new MouseEvent('mousemove', o)); };
  mv(); setTimeout(mv, 60);
  setTimeout(() => { canvas.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 })); canvas.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 })); }, 130);
  setTimeout(() => { canvas.dispatchEvent(new PointerEvent('pointerup', o)); canvas.dispatchEvent(new MouseEvent('mouseup', o)); canvas.dispatchEvent(new MouseEvent('click', o)); }, 220);
};

// ── 3. 인식: 원형 경기장 안의 주황(캐릭터 모자·화살 깃털) / 회색(화살 몸통) 픽셀을 3px 격자로 묶어 연결 성분 분석 ──
window.__perceive = (() => {
  const W = 960, CX = 501, CY = 238, R = 215, X0 = CX - R, Y0 = CY - R, S = 2 * R, CS = 3, G = Math.ceil(S / CS);
  const lim = (R - 5) * (R - 5);
  const mask = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const dx = x - R, dy = y - R; mask[y * S + x] = dx * dx + dy * dy <= lim ? 1 : 0; }
  const comps = (cnt, sx, sy, sxx, syy, sxy) => {
    const seen = new Uint8Array(G * G), out = [];
    for (let k = 0; k < G * G; k++) {
      if (seen[k] || !cnt[k]) continue;
      const st = [k]; seen[k] = 1;
      let n = 0, ax = 0, ay = 0, axx = 0, ayy = 0, axy = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
      while (st.length) {
        const q = st.pop(); n += cnt[q]; ax += sx[q]; ay += sy[q];
        if (sxx) { axx += sxx[q]; ayy += syy[q]; axy += sxy[q]; }
        const qx = q % G, qy = (q / G) | 0;
        if (qx < minx) minx = qx; if (qx > maxx) maxx = qx; if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          const nx = qx + a, ny = qy + b; if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
          const nk = ny * G + nx; if (!seen[nk] && cnt[nk]) { seen[nk] = 1; st.push(nk); }
        }
      }
      const mx = ax / n, my = ay / n;
      out.push({ n, x: mx, y: my, vxx: sxx ? axx / n - mx * mx : 0, vyy: sxx ? ayy / n - my * my : 0, vxy: sxx ? axy / n - mx * my : 0, w: (maxx - minx + 1) * CS, h: (maxy - miny + 1) * CS });
    }
    return out;
  };
  let lastSum = -1;
  return (d) => {
    // 같은 프레임이 두 번 업로드되면 건너뜀
    let sum = 0;
    for (let y = Y0; y < Y0 + S; y += 7) { const row = y * W; for (let x = X0; x < X0 + S; x += 5) { sum = (sum * 31 + d[(row + x) * 4] + d[(row + x) * 4 + 1] * 3) | 0; } }
    if (sum === lastSum) return null; lastSum = sum;
    const oc = new Float32Array(G * G), osx = new Float32Array(G * G), osy = new Float32Array(G * G);
    const lc = new Float32Array(G * G), lsx = new Float32Array(G * G), lsy = new Float32Array(G * G), lxx = new Float32Array(G * G), lyy = new Float32Array(G * G), lxy = new Float32Array(G * G);
    let on = 0;
    for (let y = 0; y < S; y++) {
      const row = (Y0 + y) * W + X0, gy = ((y / CS) | 0) * G;
      for (let x = 0; x < S; x++) {
        if (!mask[y * S + x]) continue;
        const i = (row + x) * 4; const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r > 200 && g > 110 && g < 215 && b < 100 && r - b > 130) { on++; const k = gy + ((x / CS) | 0); oc[k]++; osx[k] += x; osy[k] += y; }
        else if (r > 150 && g > 150 && b > 150 && r - g < 30 && g - r < 30 && g - b < 30 && b - g < 30) { const k = gy + ((x / CS) | 0); lc[k]++; lsx[k] += x; lsy[k] += y; lxx[k] += x * x; lyy[k] += y * y; lxy[k] += x * y; }
      }
    }
    const oco = comps(oc, osx, osy).sort((a, b) => b.n - a.n);
    const lco = comps(lc, lsx, lsy, lxx, lyy, lxy);
    return { on, oco, lco };
  };
})();

// ── 4. 판단·제어 (실제 테스트에서 340초 이상 버틴 최종 버전 그대로) ─────────────────
const installBot = function(opts){
if(window.__bot&&window.__bot.release)window.__bot.release();
const c=document.querySelector('canvas');
const KEYS={L:[37,'ArrowLeft'],U:[38,'ArrowUp'],R:[39,'ArrowRight'],D:[40,'ArrowDown']};
const held={L:0,U:0,R:0,D:0};
const send=(type,n)=>{const [code,k]=KEYS[n];const e=new KeyboardEvent(type,{key:k,code:k,bubbles:true,cancelable:true});Object.defineProperty(e,'keyCode',{get:()=>code});Object.defineProperty(e,'which',{get:()=>code});c.dispatchEvent(e);};
const setAct=a=>{const w={L:a.i<0,R:a.i>0,U:a.j<0,D:a.j>0};for(const n of ['L','U','R','D']){if(w[n]&&!held[n]){send('keydown',n);held[n]=1}else if(!w[n]&&held[n]){send('keyup',n);held[n]=0}}};
const ACTS=[];for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++)ACTS.push({i,j});
const STAY=ACTS[4];
const R=215,CEN=215;
const P=Object.assign({ovr:300,wRim:1,gate:5,coast:0.8,hold:0.07,margin:0.5,mgrow:0.06,cw:7,chh:6.5,cox:-0.5,coy:3,aT:1.5,sepS:5,sw:3,spd:158,tick:1/30,N:30,Rc:10,soft:8,rim:R-14,wCenter:0.6,arrowSpd:128,tailB:10,headF:8,lat:1,disc:0.95,grow:0.12,hitW:1000,softW:12,offY:5},opts||{});
const prevRuns=window.__bot&&window.__bot.allRuns||[];
const B=window.__bot={on:true,P,state:'wait',runs:[],allRuns:prevRuns,best:0,deaths:0,clicks:0,overSince:0,lastClick:0,runStart:0,char:null,act:STAY,tracks:[],nid:0,dbg:null,deathLog:[],hist:[],frames:0,ms:0};
B.release=()=>{B.on=false;setAct(STAY);window.__onFrame=null;};
const plans=[];
for(const a of ACTS)plans.push({a1:a,a2:a,m:P.N});
for(const m of (P.ms||[2,4,8,14]))for(const a of ACTS)for(const b of ACTS){if(a===b)continue;plans.push({a1:a,a2:b,m});}
function segDist(px,py,ax,ay,bx,by){const vx=bx-ax,vy=by-ay;const wx=px-ax,wy=py-ay;let t=(wx*vx+wy*vy)/(vx*vx+vy*vy||1);t=t<0?0:t>1?1:t;const dx=wx-t*vx,dy=wy-t*vy;return Math.sqrt(dx*dx+dy*dy);}
const cl={x:0,y:0};
function clampPos(x,y){const dx=x-CEN,dy=y-CEN;const d=Math.hypot(dx,dy);if(d>P.rim){cl.x=CEN+dx/d*P.rim;cl.y=CEN+dy/d*P.rim;}else{cl.x=x;cl.y=y;}return cl;}
window.__onFrame=d=>{
 if(!B.on)return;
 const t0=performance.now();
 const p=__perceive(d);if(!p)return;
 B.frames++;
 const now=t0/1000;
 const big=p.oco[0];
 if(p.on>300||(big&&big.n>200)){
  setAct(STAY);B.act=STAY;
  if(B.state==='run'){B.state='over';B.deaths++;const dur=now-B.runStart;B.runs.push(+dur.toFixed(2));B.allRuns.push(+dur.toFixed(2));if(dur>B.best)B.best=dur;B.deathLog.push(B.hist.slice(-200));if(B.deathLog.length>5)B.deathLog.shift();B.overSince=now;}
  if(B.state==='wait'){B.state='over';B.overSince=now;}
  if(B.autoRestart!==false&&now-B.overSince>0.6&&now-B.lastClick>0.7){B.lastClick=now;B.clicks++;window.__click();}
  return;}
 if(B.state!=='run'){B.state='run';B.runStart=now;B.tracks=[];B.char=null;B.hist=[];B.act=STAY;}
 let ch=null;
 if(big&&big.n>=35&&big.n<=75){ch={x:big.x,y:big.y};}
 if(ch){B.char={x:ch.x,y:ch.y,t:now};}
 else if(B.char){const dt=now-B.char.t;const q=clampPos(B.char.x+B.act.i*P.spd*dt,B.char.y+B.act.j*P.spd*dt);B.char={x:q.x,y:q.y,t:now};}
 if(!B.char)return;
 const cx=B.char.x+P.cox,cy=B.char.y+P.coy;
 const fl=p.oco.filter(o=>o!==big&&o.n<=20);
 const obs=[];
 for(const a of p.lco){if(a.n<4)continue;
  let hx,hy,hasF=false;let bd=18,bf=null;for(const f of fl){const dd=Math.hypot(f.x-a.x,f.y-a.y);if(dd<bd){bd=dd;bf=f;}}
  if(bf&&bd>3){hx=(a.x-bf.x)/bd;hy=(a.y-bf.y)/bd;hasF=true;}
  else{const ang=0.5*Math.atan2(2*a.vxy,a.vxx-a.vyy);hx=Math.cos(ang);hy=Math.sin(ang);if((cx-a.x)*hx+(cy-a.y)*hy<0){hx=-hx;hy=-hy;}}
  obs.push({x:a.x,y:a.y,hx,hy,hasF,n:a.n});}
 const used=new Set();const newTracks=[];const cand=[];
 for(const tr of B.tracks){const dt=now-tr.t;const px=tr.x+tr.vx*dt,py=tr.y+tr.vy*dt;
  obs.forEach((o,k)=>{const dd=Math.hypot(o.x-px,o.y-py);if(dd<12)cand.push([dd,tr,k]);});}
 cand.sort((a,b)=>a[0]-b[0]);const trUsed=new Set();
 for(const [dd,tr,k] of cand){if(trUsed.has(tr)||used.has(k))continue;trUsed.add(tr);used.add(k);const o=obs[k];
  const pdx=tr.x+tr.vx*(now-tr.t),pdy=tr.y+tr.vy*(now-tr.t);if(tr.known&&tr.h.length>=5&&Math.hypot(o.x-pdx,o.y-pdy)>P.gate){tr.x=pdx;tr.y=pdy;tr.t=now;tr.miss=0;tr.occ=(tr.occ||0)+1;newTracks.push(tr);continue;}tr.lastObs=now;tr.occ=0;const lh=tr.h[tr.h.length-1];
  if(o.x!==lh[1]||o.y!==lh[2]){tr.h.push([now,o.x,o.y]);if(tr.h.length>14)tr.h.shift();}
  tr.t=now;tr.miss=0;tr.x=o.x;tr.y=o.y;
  if(o.hasF){tr.hx=o.hx;tr.hy=o.hy;}
  if(tr.h.length>=3&&tr.h[tr.h.length-1][0]-tr.h[0][0]>0.06){let st=0,sx=0,sy=0,stt=0,stx=0,sty=0;const n=tr.h.length;const T0=tr.h[0][0];for(const [tt0,x,y] of tr.h){const tt=tt0-T0;st+=tt;sx+=x;sy+=y;stt+=tt*tt;stx+=tt*x;sty+=tt*y;}
   const den=n*stt-st*st;if(den>1e-12){tr.vx=(n*stx-st*sx)/den;tr.vy=(n*sty-st*sy)/den;tr.known=true;
    const ax=(sx-tr.vx*st)/n,ay=(sy-tr.vy*st)/n;tr.x=ax+tr.vx*(now-T0);tr.y=ay+tr.vy*(now-T0);}}
  else{tr.vx=tr.hx*P.arrowSpd;tr.vy=tr.hy*P.arrowSpd;}
  const sp=Math.hypot(tr.vx,tr.vy);if(sp>1){tr.ux=tr.vx/sp;tr.uy=tr.vy/sp;}
  newTracks.push(tr);}
 for(const tr of B.tracks){if(!trUsed.has(tr)){tr.miss=(tr.miss||0)+1;const age=now-(tr.lastObs||tr.t);const qx=tr.x+tr.vx*(now-tr.t)-215,qy=tr.y+tr.vy*(now-tr.t)-215;if(tr.miss<=3||(tr.known&&tr.h.length>=4&&age<P.coast&&qx*qx+qy*qy<225*225))newTracks.push(tr);}}
 obs.forEach((o,k)=>{if(used.has(k))return;newTracks.push({id:B.nid++,x:o.x,y:o.y,t:now,vx:o.hx*P.arrowSpd,vy:o.hy*P.arrowSpd,hx:o.hx,hy:o.hy,ux:o.hx,uy:o.hy,h:[[now,o.x,o.y]],known:false,miss:0,lastObs:now});});
 B.tracks=newTracks;
 const ks=B.tracks.filter(t=>t.known&&t.h.length>=6).map(t=>Math.hypot(t.vx,t.vy)).sort((a,b)=>a-b);
 if(ks.length>=2){const med=ks[ks.length>>1];if(med>40&&med<400)P.arrowSpd=P.arrowSpd*0.9+med*0.1;}
 const N=P.N,dt=P.tick;
 const arr=B.tracks.filter(t=>t.miss<=2||t.known).map(t=>{const lag=now-t.t;return {x:t.x+t.vx*lag,y:t.y+t.vy*lag,vx:t.vx,vy:t.vy,ux:t.ux,uy:t.uy,known:t.known};});
 const rel=arr.filter(a=>{const reach=Math.hypot(a.vx,a.vy)*N*dt+P.spd*1.42*N*dt+30;return Math.hypot(a.x-cx,a.y-cy)<reach;});
 const M=rel.length;const segs=new Float32Array(N*M*4);
 for(let s=0;s<N;s++){const tt=(s+1)*dt;for(let k=0;k<M;k++){const a=rel[k];const x=a.x+a.vx*tt,y=a.y+a.vy*tt;const o=(s*M+k)*4;const x1=x-a.ux*P.tailB,y1=y-a.uy*P.tailB,x2=x+a.ux*P.headF,y2=y+a.uy*P.headF;segs[o]=(x1+x2)/2;segs[o+1]=(y1+y2)/2;segs[o+2]=Math.abs(x2-x1)/2+P.aT+P.cw;segs[o+3]=Math.abs(y2-y1)/2+P.aT+P.chh;}}
 let bestC=1e18,bestP=plans[0],bestMin=0;B.curCost=1e18;const step=P.spd*dt;
 const order=[plans[ACTS.indexOf(B.act)]].concat(plans);for(const pl of order){let x=cx,y=cy,cost=0,minD=1e9,w=1;
  for(let s=0;s<N;s++){
   const a=s<P.lat?B.act:(s<pl.m+P.lat?pl.a1:pl.a2);
   const q=clampPos(x+a.i*step,y+a.j*step);x=q.x;y=q.y;
   const mg=P.margin+s*P.mgrow;
   for(let k=0;k<M;k++){const o=(s*M+k)*4;const sx=Math.abs(x-segs[o])-segs[o+2],sy=Math.abs(y-segs[o+1])-segs[o+3];const dd=sx>sy?sx:sy;
    if(dd<minD)minD=dd;
    if(dd<mg){cost+=w*(rel[k].known?P.hitW:P.hitW*0.6)*(1+Math.min(mg-dd,10)/10);}
    else{const e=(dd-mg)/P.sepS;cost+=w*P.softW*Math.exp(-e*e);}}
   const rc=Math.hypot(x-CEN,y-CEN)/R;const r2=rc*rc;cost+=w*(P.wCenter*r2*10+P.wRim*r2*r2*r2*40);
   w*=P.disc;
   if(cost>bestC&&pl.a1!==B.act)break;}
  if(pl.a1!==B.act)cost+=P.sw;
  if(pl.a1===B.act&&cost<B.curCost)B.curCost=cost;if(cost<bestC){bestC=cost;bestP=pl;bestMin=minD;}}
 if(bestP.a1!==B.act){if(now-(B.lastChange||0)>=P.hold||bestC+P.ovr<B.curCost){B.act=bestP.a1;B.lastChange=now;}}setAct(B.act);
 const ms=performance.now()-t0;B.ms=B.ms*0.95+ms*0.05;
 B.dbg={t:(now-B.runStart).toFixed(1),n:M,all:arr.length,cost:Math.round(bestC),min:bestMin.toFixed(1),act:B.act.i+','+B.act.j,spd:P.arrowSpd.toFixed(0),ms:B.ms.toFixed(1)};
 B.hist.push({t:+(now-B.runStart).toFixed(2),c:[cx|0,cy|0],a:B.act.i+','+B.act.j,cost:Math.round(bestC),min:+bestMin.toFixed(1),seen:p.oco[0]&&p.oco[0].n,near:rel.map(a=>[Math.round(a.x-cx),Math.round(a.y-cy),Math.round(a.vx),Math.round(a.vy),a.known?1:0]).sort((u,v)=>Math.hypot(u[0],u[1])-Math.hypot(v[0],v[1])).slice(0,3)});if(B.hist.length>200)B.hist.shift();
};
return 'v5b installed, plans '+plans.length;
};

installBot({ softW: 30, sepS: 6, wCenter: 0.4, wRim: 1, lat: 0, aT: 2.5 });

// ── 5. 에뮬레이터가 프레임 픽셀을 GPU로 올리는 순간을 가로채서 봇에 넘김 ────────────
const origTex = WebGLRenderingContext.prototype.texSubImage2D;
window.__gf = 0;
gl.texSubImage2D = function (...a) {
  const d = a[8];
  if (d && d.length === canvas.width * canvas.height * 4) {
    window.__gf++;
    if (window.__onFrame) { try { window.__onFrame(d); } catch (e) { window.__err2 = String(e); } }
  }
  return origTex.apply(this, a);
};

// ── 6. 콘솔 명령 ───────────────────────────────────────────────────────────────
window.jjStop = () => { if (window.__bot) window.__bot.release(); gl.texSubImage2D = origTex; console.log('[죽림고수 봇] 정지'); };
window.jjStatus = () => {
  const B = window.__bot;
  console.log('[죽림고수 봇] 상태:', B.state, '| 이번 판(실제 시간):', (B.dbg ? B.dbg.t : '-') + 's', '| 지난 판들(실제 시간, 초):', B.runs.join(', ') || '-');
  return B.dbg;
};
console.log('[죽림고수 봇] 시작! 멈추려면 jjStop(), 상태는 jjStatus()');
})();
