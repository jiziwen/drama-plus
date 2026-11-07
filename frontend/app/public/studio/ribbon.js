import * as THREE from './vendor/three.module.js';

// Pixel-layout ribbon rebuilt from the supplied Work Ribbon public specification.
// Programmatic select never echoes onSelect. Media stays local; setPaused freezes
// the gallery while the surrounding editor is active. destroy releases all GL/video state.

const CAMERA_Z = 41.18;
const FOV = 53.4;
const PI = Math.PI;

const CARD_VERTEX = `
varying vec2 vUv;
varying vec3 vWorld;
varying float vSheetX;
uniform vec2 u_res;
uniform float u_sheetW, u_sheetD, u_sheetT, u_sheetC, u_sheetV;
uniform float u_leanA, u_leanW, u_diag, u_axis, u_hover, u_dent;
float shape(float q) {
  return mix(1. - q*q, sin(3.14159265359*q), u_sheetC) * exp(-q*q);
}
float slope(float q) {
  float bowl = -2.*q*(2.-q*q);
  float ess = 3.14159265359*cos(3.14159265359*q)-2.*q*sin(3.14159265359*q);
  return mix(bowl, ess, u_sheetC) * exp(-q*q);
}
float ramp(float x) { float s=clamp(x,-1.,1.); return s*(1.5-.5*s*s); }
void main() {
  vUv=uv;
  vec2 q=uv*2.-1.;
  float dome=(1.-q.x*q.x)*(1.-q.y*q.y);
  vec3 p=position;
  p.z-=u_hover*u_dent*u_res.y*dome;
  vec3 wp=(modelMatrix*vec4(p,1.)).xyz;
  if(u_axis>.5) wp.xy=wp.yx;
  float x=wp.x;
  float sheetQ=x/u_sheetW*u_sheetT-.2;
  float roll=-.16*slope(sheetQ)/3.14159265359*u_sheetC;
  roll+=1.8*u_sheetV*smoothstep(.3,.9,abs(x/u_sheetW))*sign(x/u_sheetW);
  float c=cos(roll),s=sin(roll);
  wp.yz=mat2(c,s,-s,c)*wp.yz;
  wp.z-=u_sheetD*shape(sheetQ);
  wp.y+=u_diag*x;
  float rear=1.-smoothstep(-1.,.3,x/u_sheetW);
  wp.y+=.1*u_sheetW*u_sheetV*rear;
  wp.z+=.2*u_sheetW*u_sheetV*rear;
  if(u_leanW>.001) wp.z+=u_leanA*ramp(x/u_leanW);
  vSheetX=x;
  if(u_axis>.5) wp.xy=wp.yx;
  vWorld=wp;
  gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.);
}`;

const CARD_FRAGMENT = `
precision highp float;
varying vec2 vUv;
varying vec3 vWorld;
varying float vSheetX;
uniform sampler2D u_texture,u_overlay;
uniform vec4 u_crop;
uniform vec2 u_res;
uniform float u_sheetW,u_sheetD,u_sheetT,u_sheetC,u_sheetV;
uniform float u_leanA,u_leanW,u_hover,u_dent,u_shade,u_shadeS;
uniform float u_corner,u_aspect,u_alpha,u_axis;
float shape(float q) {return mix(1.-q*q,sin(3.14159265359*q),u_sheetC)*exp(-q*q);}
float slope(float q) {
  return mix(-2.*q*(2.-q*q),3.14159265359*cos(3.14159265359*q)-2.*q*sin(3.14159265359*q),u_sheetC)*exp(-q*q);
}
void main() {
  vec4 media=texture2D(u_texture,u_crop.xy+vUv*u_crop.zw);
  vec4 overlay=texture2D(u_overlay,vUv);
  vec3 rgb=mix(media.rgb,overlay.rgb,overlay.a);
  vec2 q=vUv*2.-1.;
  float dome=(1.-q.x*q.x)*(1.-q.y*q.y);
  float sq=vSheetX/u_sheetW*u_sheetT-.2;
  float curveZ=-u_sheetD*shape(sq);
  float depth=clamp((u_sheetD-curveZ)/max(.001,2.*u_sheetD)+u_hover*u_dent*dome,0.,1.);
  rgb=mix(rgb,vec3(.059),u_shade*.8*pow(depth,u_shadeS));
  float dz=-u_sheetD*slope(sq)*u_sheetT/u_sheetW;
  if(u_leanW>.001) {
    float s=min(abs(vSheetX/u_leanW),1.);
    dz+=u_leanA/u_leanW*1.5*(1.-s*s);
  }
  dz+=u_hover*u_dent*u_res.y*4.*q.x*(1.-q.y*q.y)/u_res.x;
  float dy=u_hover*u_dent*4.*q.y*(1.-q.x*q.x);
  vec3 n=normalize(vec3(-dz,-dy,1.));
  float roll=-.16*slope(sq)/3.14159265359*u_sheetC;
  roll+=1.8*u_sheetV*smoothstep(.3,.9,abs(vSheetX/u_sheetW))*sign(vSheetX/u_sheetW);
  n.yz=mat2(cos(roll),sin(roll),-sin(roll),cos(roll))*n.yz;
  if(u_axis>.5) n.xy=n.yx;
  vec3 light=normalize(vec3(-.4,.5,1.));
  rgb*=1.-.12*(1.-(dot(n,light)*.5+.5));
  vec3 halfway=normalize(light+normalize(cameraPosition-vWorld));
  rgb+=vec3(pow(max(0.,dot(n,halfway)),48.)*.35);
  vec2 box=abs((vUv-.5)*vec2(u_aspect,1.))-vec2(u_aspect*.5-u_corner,.5-u_corner);
  float dist=length(max(box,0.))+min(max(box.x,box.y),0.)-u_corner;
  float aa=max(fwidth(dist),.0001);
  float alpha=(1.-smoothstep(-aa,aa,dist))*u_alpha;
  if(alpha<.001) discard;
  gl_FragColor=vec4(rgb,alpha);
  #include <colorspace_fragment>
}`;

export function createRibbonV2(container, options = {}) {
  if(!container) throw new Error('A ribbon container is required.');
  const looping=options.loop!==false;
  const onSelect=typeof options.onSelect==='function'?options.onSelect:()=>{};
  const onOpen=typeof options.onOpen==='function'?options.onOpen:()=>{};
  const mql=matchMedia('(prefers-reduced-motion: reduce)');
  const originalPosition=container.style.position;
  if(getComputedStyle(container).position==='static') container.style.position='relative';
  let items=normalize(options.items);
  let selectedId=items[0]?.id;
  let width=1,height=1,U=1,H=1,W=1,k=1,cardH=1,loop=1;
  let mobile=false,reduced=mql.matches,paused=false,destroyed=false,failed=false;
  let target=0,current=0,pending=0,lastFrame=0,raf=0;
  let depth=0,velocity=0,userUsed=false,userSettling=false,editing=false;
  let lastWheel=0,lastBurst=-1000,resizeTimer=0,drag=null,hovered=null;
  let pointer={x:-100,y:-100,active:false};
  const parallax={x:0,y:0,tx:0,ty:0};
  const removers=[];
  const records=new Map();
  const cards=[];
  const host=document.createElement('div');
  Object.assign(host.style,{position:'absolute',inset:'0',overflow:'hidden'});
  host.className='director-liquid-ribbon';
  container.append(host);
  const fallback=document.createElement('div');
  Object.assign(fallback.style,{position:'absolute',inset:'0',display:'none',alignItems:'center',gap:'16px',overflowX:'auto',padding:'30px',background:'#050505'});
  fallback.setAttribute('aria-label','故事项目选择');
  host.append(fallback);
  let renderer,scene,camera,geometry;
  const blankCanvas=document.createElement('canvas');
  blankCanvas.width=blankCanvas.height=4;
  const blankContext=blankCanvas.getContext('2d');
  blankContext.fillStyle='#111';blankContext.fillRect(0,0,4,4);
  const blank=new THREE.CanvasTexture(blankCanvas);
  blank.colorSpace=THREE.SRGBColorSpace;

  function localURL(value,fallbackValue='/studio/assets/story-placeholder.svg') {
    try {const url=new URL(String(value||fallbackValue),document.baseURI);return url.origin===location.origin?url.href:fallbackValue;}catch{return fallbackValue;}
  }
  function normalize(value) {
    return (Array.isArray(value)?value:[]).filter(item=>item&&item.id!=null).map(item=>({...item,
      title:String(item.title||'未命名故事'),poster:localURL(item.poster),
      video:item.video?localURL(item.video,''):null,
      aspect:Number(item.aspect)>0?Number(item.aspect):1.7,
      posterFocus:Number.isFinite(Number(item.posterFocus))?Math.max(0,Math.min(1,Number(item.posterFocus))):.5,
    }));
  }
  function listen(node,event,fn,config) {node.addEventListener(event,fn,config);removers.push(()=>node.removeEventListener(event,fn,config));}
  function wrap(value,start,length) {return ((value-start)%length+length)%length+start;}
  function ramp(value) {const s=Math.max(-1,Math.min(1,value));return s*(1.5-.5*s*s);}
  function slope(q) {return (mobile?-2*q*(2-q*q):PI*Math.cos(PI*q)-2*q*Math.sin(PI*q))*Math.exp(-q*q);}
  function shape(q) {return (mobile?1-q*q:Math.sin(PI*q))*Math.exp(-q*q);}
  function smooth(a,b,x) {const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);}
  function isEditable(node) {return node instanceof HTMLElement&&node.matches('input,textarea,select,[contenteditable="true"]');}
  function canRender() {return renderer&&!destroyed&&!failed&&!paused&&!document.hidden;}
  function requestRender() {if(!raf&&canRender())raf=requestAnimationFrame(tick);}

  function textureSettings(texture) {
    texture.colorSpace=THREE.SRGBColorSpace;
    texture.anisotropy=Math.min(8,renderer?.capabilities.getMaxAnisotropy()||1);
    return texture;
  }
  function stopVideo(record) {record.video?.pause();}
  function makeVideo(record) {
    if(reduced||record.video||!record.item.video||record.retired)return;
    const video=document.createElement('video');
    video.crossOrigin='anonymous';video.muted=video.defaultMuted=true;video.loop=true;video.playsInline=true;
    video.setAttribute('playsinline','');video.setAttribute('muted','');video.preload='auto';video.src=record.item.video;
    record.video=video;
    const firstFrame=()=>{
      if(destroyed||record.retired||reduced)return;
      if(!record.videoTexture)record.videoTexture=textureSettings(new THREE.VideoTexture(video));
      record.texture=record.videoTexture;record.mediaAspect=video.videoWidth/video.videoHeight||record.mediaAspect;
      updateMedia(record);requestRender();
    };
    video.addEventListener('loadeddata',firstFrame,{once:true});
    video.addEventListener('playing',()=>{firstFrame();requestRender();});
    video.addEventListener('error',()=>{record.videoFailed=true;stopVideo(record);},{once:true});
    if(video.requestVideoFrameCallback)record.frameCallback=video.requestVideoFrameCallback(firstFrame);
  }
  function createRecord(item) {
    const record={item,texture:blank,posterTexture:null,videoTexture:null,video:null,videoFailed:false,mediaAspect:item.aspect,ready:false,retired:false};
    records.set(item.id,record);
    const loader=new THREE.TextureLoader();loader.setCrossOrigin('anonymous');
    const load=(url,last=false)=>loader.load(url,texture=>{
      if(destroyed||record.retired){texture.dispose();return;}
      record.posterTexture=textureSettings(texture);record.texture=record.videoTexture||texture;
      record.mediaAspect=record.videoTexture&&record.video?.videoWidth?record.video.videoWidth/record.video.videoHeight:texture.image.width/texture.image.height;
      record.ready=true;updateMedia(record);requestRender();
    },undefined,()=>{
      if(!last&&!destroyed&&!record.retired)load('/studio/assets/story-placeholder.svg',true);
      else{record.ready=true;requestRender();}
    });
    load(item.poster);
    makeVideo(record);
    return record;
  }
  function crop(card) {
    const mediaAspect=card.record.mediaAspect||card.item.aspect;
    let sx=1,sy=1;
    if(card.item.aspect>mediaAspect)sy=mediaAspect/card.item.aspect;else sx=card.item.aspect/mediaAspect;
    const ox=Math.max(0,Math.min(1-sx,card.item.posterFocus-sx/2));
    card.material.uniforms.u_crop.value.set(ox,(1-sy)/2,sx,sy);
  }
  function updateMedia(record) {
    cards.filter(card=>card.record===record).forEach(card=>{card.material.uniforms.u_texture.value=record.texture;crop(card);});
  }
  function drawOverlay(card) {
    const s=2*Math.min(devicePixelRatio||1,2)/1.5;
    const canvas=document.createElement('canvas');canvas.width=Math.max(2,Math.round(card.w*s));canvas.height=Math.max(2,Math.round(card.h*s));
    const ctx=canvas.getContext('2d');ctx.scale(s,s);
    const inset=(mobile?10:20)*U,font=(mobile?16:18)*U;
    ctx.font=`400 ${Math.max(12,font)}px "Inter Tight", "PingFang SC", sans-serif`;
    ctx.fillStyle='#fff';ctx.shadowColor='#0009';ctx.shadowBlur=12*U;
    ctx.fillText(card.item.caption||card.item.title,inset,card.h-10*U-.22*font,card.w-inset*2-35*U);
    ctx.shadowBlur=0;
    const radius=Math.max(10,12.5*U),x=card.w-inset-radius,y=card.h-10*U-radius;
    ctx.beginPath();ctx.arc(x,y,radius,0,PI*2);ctx.fillStyle='#050505';ctx.fill();
    const arm=4.5*U;ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(1.1,1.4*U);ctx.lineCap='round';ctx.lineJoin='round';
    ctx.beginPath();ctx.moveTo(x-arm,y);ctx.lineTo(x+arm,y);
    if(mobile){ctx.moveTo(x+arm*.2,y-arm*.8);ctx.lineTo(x+arm,y);ctx.lineTo(x+arm*.2,y+arm*.8);}
    else{ctx.moveTo(x,y-arm);ctx.lineTo(x,y+arm);}
    ctx.stroke();
    card.overlay?.dispose();card.overlay=textureSettings(new THREE.CanvasTexture(canvas));
    card.material.uniforms.u_overlay.value=card.overlay;
  }
  function disposeRecord(record) {
    record.retired=true;stopVideo(record);
    if(record.video){
      if(record.frameCallback&&record.video.cancelVideoFrameCallback)record.video.cancelVideoFrameCallback(record.frameCallback);
      record.video.removeAttribute('src');record.video.load();
    }
    record.posterTexture?.dispose();record.videoTexture?.dispose();
  }
  function clearCards() {
    for(const card of cards){scene?.remove(card.mesh);card.overlay?.dispose();card.material.dispose();}
    cards.length=0;records.forEach(disposeRecord);records.clear();hovered=null;
  }
  function buildCards() {
    clearCards();
    for(const item of items)createRecord(item);
    const slotCount=items.length?(looping?Math.max(items.length,Math.ceil(8/items.length)*items.length):items.length):0;
    for(let index=0;index<slotCount;index++) {
      const item=items[index%items.length],record=records.get(item.id);
      const uniforms={
        u_texture:{value:record.texture},u_overlay:{value:blank},u_crop:{value:new THREE.Vector4(0,0,1,1)},u_res:{value:new THREE.Vector2(1,1)},
        u_sheetW:{value:1},u_sheetD:{value:0},u_sheetT:{value:1.15},u_sheetC:{value:1},u_sheetV:{value:0},
        u_leanA:{value:0},u_leanW:{value:1},u_diag:{value:.03},u_axis:{value:0},u_dent:{value:.035},
        u_shade:{value:1},u_shadeS:{value:1},u_corner:{value:.045},u_aspect:{value:item.aspect},u_hover:{value:0},u_alpha:{value:0},
      };
      const material=new THREE.ShaderMaterial({uniforms,vertexShader:CARD_VERTEX,fragmentShader:CARD_FRAGMENT,transparent:true,depthTest:false,depthWrite:false,extensions:{derivatives:true},side:THREE.DoubleSide});
      const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;mesh.renderOrder=0;scene.add(mesh);
      cards.push({item,record,mesh,material,index,base:0,x:0,y:0,w:1,h:1,hover:0,alpha:0,overlay:null,rect:null});
    }
    renderFallback();layout(true);
  }
  function layout(reset=false) {
    if(destroyed)return;
    const bounds=container.getBoundingClientRect();width=Math.max(1,bounds.width);height=Math.max(1,bounds.height);
    const wasMobile=mobile;mobile=width<=649;U=mobile?width/390:width/1500;
    H=Math.tan(THREE.MathUtils.degToRad(FOV/2))*CAMERA_Z;W=H*width/height;k=2*H/height;
    cardH=Math.max(120,Math.min(innerHeight*.435,480,height*.72));
    loop=0;
    for(const card of cards){
      card.w=mobile?width-40*U:cardH*card.item.aspect;card.h=mobile?card.w/card.item.aspect:cardH;
      card.base=loop;loop+=(mobile?card.h:card.w)+(mobile?20:10)*U;
      card.mesh.scale.set(card.w*k,card.h*k,1);card.material.uniforms.u_res.value.set(card.w*k,card.h*k);
      card.material.uniforms.u_corner.value=(mobile?15:20)*U/card.h;
      drawOverlay(card);crop(card);
    }
    loop=Math.max(1,loop);
    if(renderer){
      renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.setSize(width,height,false);
      camera.aspect=width/height;camera.updateProjectionMatrix();
      renderer.domElement.style.touchAction=mobile?'pan-x':'pan-y';
    }
    if(reset||wasMobile!==mobile){
      const card=cards.find(entry=>entry.item.id===selectedId)||cards[0];
      current=target=card?card.base+(mobile?card.h/2-height/2:card.w/2-width/2):0;
      pending=0;parallax.x=parallax.y=parallax.tx=parallax.ty=0;
    }
    updateLabel();requestRender();
  }
  function setTargetFor(id,user=false) {
    const matching=cards.filter(card=>card.item.id===id);
    if(!matching.length){
      const item=items.find(entry=>entry.id===id);if(!item)return;
      const changed=selectedId!==id;selectedId=id;updateLabel();
      if(user&&changed)onSelect(id,item);
      return;
    }
    const axis=mobile?height:width;
    const centers=matching.flatMap(card=>{
      const value=card.base+(mobile?card.h:card.w)/2-axis/2;
      if(!looping)return [value];
      const n=Math.round((current-value)/loop);
      return [value+(n-1)*loop,value+n*loop,value+(n+1)*loop];
    });
    target=centers.reduce((best,value)=>Math.abs(value-current)<Math.abs(best-current)?value:best,centers[0]);
    pending=0;
    const changed=selectedId!==id;selectedId=id;
    if(user){userUsed=true;userSettling=false;if(changed)onSelect(id,items.find(item=>item.id===id));}
    if(reduced)current=target;
    updateLabel();requestRender();
  }
  function updateLabel() {
    if(renderer){renderer.domElement.dataset.ribbonItems=String(items.length);renderer.domElement.dataset.ribbonCards=String(cards.length);}
    if(renderer)renderer.domElement.setAttribute('aria-label',`故事流动画廊。当前：${items.find(item=>item.id===selectedId)?.title||'无项目'}。拖动或滚轮浏览，左右键切换，回车打开。`);
    fallback.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.id===String(selectedId))));
  }
  function clampTarget() {
    if(looping||!cards.length)return;
    const span=mobile?height:width,first=cards[0],last=cards[cards.length-1];
    target=Math.max(first.base+(mobile?first.h:first.w)/2-span/2,Math.min(last.base+(mobile?last.h:last.w)/2-span/2,target));
  }
  function push(delta) {
    target+=delta;
    if(!mobile)target=current+Math.tanh((target-current)/width)*width;
    userUsed=true;userSettling=true;requestRender();
  }
  function deform(card,u,v) {
    let x=(card.x+u*card.w-width/2)*k,y=-(card.y+v*card.h-height/2)*k;
    const qx=u*2-1,qy=(1-v)*2-1;
    let z=-card.hover*.035*card.h*k*(1-qx*qx)*(1-qy*qy);
    if(mobile){const swap=x;x=y;y=swap;}
    const sheet=mobile?H:W,q=x/sheet*(mobile?1:1.15)-.2;
    const roll=(mobile?0:-.16*slope(q)/PI)+(!mobile?1.8*velocity*smooth(.3,.9,Math.abs(x/sheet))*Math.sign(x/sheet):0);
    const yy=y*Math.cos(roll)-z*Math.sin(roll);z=y*Math.sin(roll)+z*Math.cos(roll);y=yy;
    z-=depth*shape(q);y+=(mobile?0:.03)*x;
    const rear=1-smooth(-1,.3,x/sheet);
    if(!mobile){y+=.1*W*velocity*rear;z+=.2*W*velocity*rear-.12*W*ramp(x/W);}
    if(mobile){const swap=x;x=y;y=swap;}
    return new THREE.Vector3(x,y,z);
  }
  function projectRect(card) {
    let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity,z=0;
    for(let column=0;column<5;column++)for(const edge of [0,1]){
      const point=deform(card,column/4,edge);z+=point.z;
      point.project(camera);
      const x=(point.x*.5+.5)*width,y=(-point.y*.5+.5)*height;
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
    return {x:left,y:top,width:right-left,height:bottom-top,z:z/10,id:card.item.id};
  }
  function pick(x,y) {
    return cards.filter(card=>card.rect&&x>=card.rect.x&&x<=card.rect.x+card.rect.width&&y>=card.rect.y&&y<=card.rect.y+card.rect.height)
      .sort((a,b)=>b.rect.z-a.rect.z)[0]||null;
  }
  function viewportRect(card) {
    if(!card?.rect)return null;
    const stage=container.getBoundingClientRect(),rect=card.rect;
    return {x:stage.left+rect.x,y:stage.top+rect.y,left:stage.left+rect.x,top:stage.top+rect.y,
      width:rect.width,height:rect.height,right:stage.left+rect.x+rect.width,bottom:stage.top+rect.y+rect.height};
  }
  function selectedCard() {
    return cards.filter(card=>card.item.id===selectedId&&card.rect)
      .sort((a,b)=>Math.abs(mobile?a.rect.y+a.rect.height/2-height/2:a.rect.x+a.rect.width/2-width/2)-Math.abs(mobile?b.rect.y+b.rect.height/2-height/2:b.rect.x+b.rect.width/2-width/2))[0]||null;
  }
  function openCard(card) {
    if(!card)return;
    const rect=viewportRect(card);
    setTargetFor(card.item.id,true);
    onOpen(card.item.id,card.item,{rect});
  }
  function plusHit(card,point) {
    const inset=(mobile?10:20)*U,radius=Math.max(10,12.5*U);
    const u=1-(inset+radius)/card.w,v=1-(10*U+radius)/card.h;
    const center=deform(card,u,v).project(camera);
    const edge=deform(card,u-radius/card.w,v).project(camera);
    const x=(center.x*.5+.5)*width,y=(-center.y*.5+.5)*height;
    const projectedRadius=Math.abs(center.x-edge.x)*width/2;
    return Math.hypot(point.x-x,point.y-y)<=Math.max(12,projectedRadius+5);
  }
  function updateCards(delta) {
    let animating=false;
    const span=mobile?height:width,left=-(loop-span)/2;
    for(const card of cards){
      const axis=looping?wrap(card.base-current,left,loop):card.base-current;
      card.x=mobile?(width-card.w)/2:axis;card.y=mobile?axis:(height-card.h)/2;
      card.mesh.position.set((card.x+card.w/2-width/2)*k,-(card.y+card.h/2-height/2)*k,0);
      const uniforms=card.material.uniforms;
      uniforms.u_sheetW.value=mobile?H:W;uniforms.u_sheetD.value=depth;
      uniforms.u_sheetT.value=mobile?1:1.15;uniforms.u_sheetC.value=mobile?0:1;uniforms.u_sheetV.value=mobile?0:velocity;
      uniforms.u_leanA.value=mobile?0:-.12*W;uniforms.u_leanW.value=mobile?0:W;
      uniforms.u_diag.value=mobile?0:.03;uniforms.u_axis.value=mobile?1:0;
      uniforms.u_shade.value=mobile?0:1;uniforms.u_shadeS.value=mobile?.6:1;
      const wantedHover=!mobile&&!reduced&&hovered===card&&!drag?1:0;
      card.hover+=(wantedHover-card.hover)*(1-Math.exp(-(wantedHover?8:6)*delta));
      if(Math.abs(wantedHover-card.hover)>.002)animating=true;
      uniforms.u_hover.value=card.hover;
      if(card.record.ready&&card.alpha<1){card.alpha=reduced?1:Math.min(1,card.alpha+delta/.6);animating=true;}
      uniforms.u_alpha.value=card.alpha;
      card.rect=projectRect(card);
    }
    let videoPlaying=false;
    for(const record of records.values()){
      const visible=cards.some(card=>card.record===record&&(mobile?card.y+card.h>-.5*height&&card.y<1.5*height:card.x+card.w>-.5*width&&card.x<1.5*width));
      if(record.video&&!record.videoFailed&&!reduced&&!paused&&visible&&!document.hidden){
        if(record.video.paused)record.video.play().catch(()=>{});
        if(!record.video.paused)videoPlaying=true;
      }else stopVideo(record);
    }
    return animating||videoPlaying;
  }
  function tick(now) {
    raf=0;if(!canRender())return;
    const dt=lastFrame?Math.min(.05,(now-lastFrame)/1000):1/60;lastFrame=now;
    const auto=looping&&!userUsed&&!pointer.active&&!drag&&!editing&&!reduced&&items.length>1;
    if(auto)target+=dt*19;
    if(pending){const part=pending*(1-Math.pow(1-.22,Math.min(dt*60,4)));target+=part;pending-=part;if(Math.abs(pending)<.05){target+=pending;pending=0;}if(!mobile)target=current+Math.tanh((target-current)/width)*width;}
    clampTarget();
    const t=Math.tanh((target-current)/(mobile?245:550));velocity=reduced?0:Math.min(1,Math.abs(t*Math.abs(t)));
    depth=mobile?H*.18*1.1*velocity:W*.2*(1+1.1*velocity);
    if(reduced)current=target;else current=Math.round((current+(target-current)*.1*Math.min(dt*60,2))*100)/100;
    if(Math.abs(target-current)<.025)current=target;
    const px=reduced||mobile?0:parallax.tx,py=reduced||mobile?0:parallax.ty;
    parallax.x+=(px-parallax.x)*(1-Math.exp(-dt*5));parallax.y+=(py-parallax.y)*(1-Math.exp(-dt*5));
    camera.rotation.set(-parallax.y*.04,parallax.x*.0698,0,'YXZ');camera.updateMatrixWorld();
    const animated=updateCards(dt);
    if(pointer.active&&!drag&&!mobile&&!reduced){
      const next=pick(pointer.x,pointer.y);
      if(next!==hovered){hovered=next;renderer.domElement.style.cursor=hovered?'pointer':'grab';requestRender();}
    }
    if((auto||userSettling)&&!drag&&(auto||(Math.abs(target-current)<1&&!pending))){
      const axisCenter=mobile?height/2:width/2;
      const closest=[...cards].sort((a,b)=>Math.abs((mobile?a.y+a.h/2:a.x+a.w/2)-axisCenter)-Math.abs((mobile?b.y+b.h/2:b.x+b.w/2)-axisCenter))[0];
      if(closest&&selectedId!==closest.item.id){selectedId=closest.item.id;updateLabel();onSelect(selectedId,closest.item);}
      if(!auto)userSettling=false;
    }
    try {
      renderer.render(scene,camera);
    }catch{showFallback();return;}
    const moving=Math.abs(target-current)>.025||Math.abs(pending)>.01||Math.abs(px-parallax.x)>.001||Math.abs(py-parallax.y)>.001;
    if(auto||moving||animated)requestRender();else lastFrame=0;
  }
  function stopInteraction() {
    userUsed=true;pending=0;drag=null;hovered=null;records.forEach(stopVideo);cancelAnimationFrame(raf);raf=0;lastFrame=0;
  }
  function showFallback() {
    failed=true;cancelAnimationFrame(raf);raf=0;records.forEach(stopVideo);
    fallback.style.display='flex';if(renderer)renderer.domElement.style.display='none';
  }
  function renderFallback() {
    fallback.replaceChildren();
    for(const item of items){
      const button=document.createElement('button');button.type='button';button.dataset.id=String(item.id);
      Object.assign(button.style,{position:'relative',flex:'0 0 72%',maxWidth:'650px',aspectRatio:String(item.aspect),padding:'0',border:'1px solid #444',borderRadius:'14px',overflow:'hidden',background:'#111',color:'#fff',cursor:'pointer'});
      const image=document.createElement('img');image.src=item.poster;image.alt=item.title;image.draggable=false;
      Object.assign(image.style,{width:'100%',height:'100%',objectFit:'cover',objectPosition:`${item.posterFocus*100}% center`});
      const title=document.createElement('span');title.textContent=`${item.title}  +`;
      Object.assign(title.style,{position:'absolute',left:'18px',bottom:'15px',font:'16px sans-serif',textShadow:'0 2px 8px #000'});
      button.append(image,title);button.addEventListener('click',()=>setTargetFor(item.id,true));button.addEventListener('dblclick',()=>{
        const bounds=button.getBoundingClientRect();
        onOpen(item.id,item,{rect:{x:bounds.x,y:bounds.y,left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height,right:bounds.right,bottom:bounds.bottom}});
      });fallback.append(button);
    }
    updateLabel();
  }
  function onWheel(event) {
    if(event.ctrlKey||paused||failed||!items.length)return;
    const scale=event.deltaMode===1?16:event.deltaMode===2?height:1;
    const delta=(Math.abs(event.deltaY)>=Math.abs(event.deltaX)?event.deltaY:event.deltaX)*scale;
    const now=performance.now(),interval=now-lastWheel;
    if(interval<30)lastBurst=now;
    if(Math.abs(delta)>=40&&interval>=30&&now-lastBurst>500){pending+=delta*1.25*2;userUsed=true;userSettling=true;requestRender();}
    else push(delta*1.25);
    lastWheel=now;
  }
  function pointerPosition(event) {const rect=renderer.domElement.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top};}
  function onPointerDown(event) {
    if(event.button!==0||paused||!items.length)return;
    userUsed=true;pending=0;
    const point=pointerPosition(event);drag={id:event.pointerId,start:point,last:point,moved:false,delta:0,time:performance.now()};
    renderer.domElement.focus({preventScroll:true});
  }
  function onPointerMove(event) {
    if(paused||failed)return;
    const point=pointerPosition(event);pointer={...point,active:event.pointerType!=='touch'};
    parallax.tx=(point.x/width-.5)*2;parallax.ty=(point.y/height-.5)*2;
    if(drag&&drag.id===event.pointerId){
      const distance=mobile?point.y-drag.start.y:point.x-drag.start.x;
      if(Math.abs(distance)>5){
        drag.moved=true;
        if(!renderer.domElement.hasPointerCapture(event.pointerId))renderer.domElement.setPointerCapture(event.pointerId);
        const delta=mobile?drag.last.y-point.y:drag.last.x-point.x;
        drag.delta=delta;drag.time=performance.now();push(delta*(mobile?3.25:1.8));
        renderer.domElement.style.cursor='grabbing';
      }
      drag.last=point;
    }
    requestRender();
  }
  function finishPointer(event,cancel=false) {
    if(!drag||drag.id!==event.pointerId)return;
    const previous=drag;drag=null;
    if(renderer.domElement.hasPointerCapture(event.pointerId))renderer.domElement.releasePointerCapture(event.pointerId);
    if(previous.moved&&!reduced&&performance.now()-previous.time<150)push(previous.delta*35);
    else if(!previous.moved&&!cancel){
      const point=pointerPosition(event),card=pick(point.x,point.y);
      if(card){if(plusHit(card,point))openCard(card);else setTargetFor(card.item.id,true);}
    }
    renderer.domElement.style.cursor='grab';requestRender();
  }
  function onKeyDown(event) {
    if(event.metaKey||event.ctrlKey||event.altKey||!items.length)return;
    const index=Math.max(0,items.findIndex(item=>item.id===selectedId));
    if(event.key==='ArrowRight'||event.key==='ArrowDown'||event.key==='ArrowLeft'||event.key==='ArrowUp'){
      event.preventDefault();userUsed=true;
      const step=event.key==='ArrowRight'||event.key==='ArrowDown'?1:-1;
      setTargetFor(items[looping?(index+step+items.length)%items.length:Math.max(0,Math.min(items.length-1,index+step))].id,true);
    }else if(event.key==='PageDown'||event.key==='PageUp'||event.key===' '){event.preventDefault();push(.9*height*(event.key==='PageUp'||event.shiftKey?-1:1));}
    else if(event.key==='Enter'){event.preventDefault();openCard(selectedCard());}
  }

  try {
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
    renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(0x050505,0);
    const canvas=renderer.domElement;canvas.className='director-liquid-canvas';canvas.tabIndex=0;canvas.setAttribute('role','img');
    Object.assign(canvas.style,{position:'absolute',inset:'0',display:'block',width:'100%',height:'100%',cursor:'grab',outlineOffset:'-3px'});host.prepend(canvas);
    scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(FOV,1,.1,2000);camera.position.set(0,0,CAMERA_Z);
    geometry=new THREE.PlaneGeometry(1,1,96,24);
    buildCards();
    listen(canvas,'wheel',onWheel,{passive:true});listen(canvas,'pointerdown',onPointerDown,{passive:true});listen(canvas,'pointermove',onPointerMove,{passive:true});
    listen(canvas,'pointerup',event=>finishPointer(event));listen(canvas,'pointercancel',event=>finishPointer(event,true));listen(canvas,'lostpointercapture',event=>finishPointer(event,true));
    listen(canvas,'pointerleave',()=>{if(!drag){pointer.active=false;hovered=null;parallax.tx=parallax.ty=0;requestRender();}});
    listen(canvas,'dblclick',event=>{const point=pointerPosition(event);openCard(pick(point.x,point.y));});
    listen(canvas,'keydown',onKeyDown);
    listen(canvas,'webglcontextlost',event=>{event.preventDefault();showFallback();});
    listen(canvas,'webglcontextrestored',()=>{failed=false;fallback.style.display='none';canvas.style.display='block';requestRender();});
    document.fonts?.load('400 18px "Inter Tight"').then(()=>{if(!destroyed){cards.forEach(drawOverlay);requestRender();}}).catch(()=>{});
  }catch{renderFallback();showFallback();}

  const resize=()=>{if(!destroyed)layout();};
  const resizeObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resize,100);}):null;
  resizeObserver?.observe(container);
  listen(window,'resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resize,100);},{passive:true});
  listen(document,'visibilitychange',()=>{if(document.hidden){records.forEach(stopVideo);cancelAnimationFrame(raf);raf=0;lastFrame=0;}else requestRender();});
  listen(document,'focusin',event=>{if(isEditable(event.target)){editing=true;userUsed=true;}requestRender();});
  listen(document,'focusout',()=>{editing=false;requestRender();});
  listen(mql,'change',()=>{
    reduced=mql.matches;pending=0;lastFrame=0;
    for(const record of records.values()){
      if(reduced){stopVideo(record);record.texture=record.posterTexture||blank;record.mediaAspect=record.posterTexture?record.posterTexture.image.width/record.posterTexture.image.height:record.item.aspect;updateMedia(record);}
      else {
        makeVideo(record);
        if(record.videoTexture){record.texture=record.videoTexture;record.mediaAspect=record.video.videoWidth/record.video.videoHeight||record.item.aspect;updateMedia(record);}
      }
    }
    if(reduced)current=target;requestRender();
  });

  return {
    select(id){if(id!==selectedId)userUsed=true;setTargetFor(id);},
    setPaused(value){paused=Boolean(value);lastFrame=0;if(paused){cancelAnimationFrame(raf);raf=0;records.forEach(stopVideo);}else requestRender();},
    setItems(next){if(destroyed)return;items=normalize(next);if(!items.some(item=>item.id===selectedId))selectedId=items[0]?.id;pending=0;userUsed=true;if(scene)buildCards();else renderFallback();},
    resize,
    getSelectedRect(){return viewportRect(selectedCard());},
    getHitRects(){return cards.filter(card=>card.rect).map(card=>({...card.rect}));},
    destroy(){
      if(destroyed)return;destroyed=true;cancelAnimationFrame(raf);clearTimeout(resizeTimer);resizeObserver?.disconnect();removers.forEach(remove=>remove());
      clearCards();geometry?.dispose();blank.dispose();renderer?.dispose();renderer?.forceContextLoss();host.remove();container.style.position=originalPosition;
    },
  };
}
