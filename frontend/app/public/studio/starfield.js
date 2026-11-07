// Shared, transparent atmosphere for the gallery, workbench, and theater.
// createStarfield(parent, {accent?, density?, intensity?, backdrop?, paused?})
// returns {setPaused, setAccent, resize, destroy}. The parent supplies its bounds.
export function createStarfield(container, options = {}) {
  if(!container)throw new Error('A starfield container is required.');
  const canvas=document.createElement('canvas');
  canvas.className='director-starfield';
  canvas.setAttribute('aria-hidden','true');
  canvas.dataset.starfieldFrame='0';canvas.dataset.meteorCount='0';
  Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',display:'block',pointerEvents:'none',userSelect:'none'});
  container.append(canvas);
  const context=canvas.getContext('2d',{alpha:true});
  if(!context){canvas.remove();return{setPaused(){},setAccent(){},resize(){},destroy(){}};}

  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const density=clamp(Number.isFinite(Number(options.density))?Number(options.density):1,0,1.5);
  const intensity=clamp(Number.isFinite(Number(options.intensity))?Number(options.intensity):1,0,2);
  const backdrop=Boolean(options.backdrop);
  const mql=matchMedia('(prefers-reduced-motion: reduce)');
  let reduced=mql.matches,paused=Boolean(options.paused),destroyed=false;
  let width=1,height=1,visibleStars=0,visibleFireflies=0,elapsed=0,lastPaint=0,raf=0,frameCount=0,meteorCount=0;
  let sprites=[],backgroundFill=null,backgroundGlow=null;
  let meteorSprite=null,meteorIndex=0,nextMeteor=1.5;
  let currentAccent=String(options.accent||'#89d4e6');
  let seed=0x51a7c9;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const stars=[],fireflies=[],meteorPatterns=[];
  const meteor={active:false,start:0,pattern:null};
  for(let index=0;index<Math.ceil(650*density);index++){
    const tint=random();
    stars.push({x:random(),y:random(),size:7+random()*7,phase:random()*Math.PI*2,speed:Math.PI*2/(1.8+random()*3),tint:tint<.07?2:tint<.38?1:0,glint:index%73===0});
  }
  for(let index=0;index<Math.ceil(35*density);index++){
    const region=index%3;
    fireflies.push({x:region===0?.045+random()*.12:region===1?.835+random()*.12:.1+random()*.8,y:region===2?.82+random()*.15:.16+random()*.65,size:30+random()*16,phase:random()*Math.PI*2,speed:Math.PI*2/(8+random()*7),travel:30+random()*40,tint:random()<.55?0:1});
  }
  for(let index=0;index<16;index++){
    // Keep the full streak in the open sky above the film ribbon, rather than
    // sending its bright head behind the large image midway through the sweep.
    meteorPatterns.push({x:.06+random()*.5,y:.02+random()*.045,run:.3+random()*.2,fall:.065+random()*.075,length:150+random()*150,duration:1+random()*.6,wait:5+random()*4});
  }

  function colorRGB(value){
    const probe=document.createElement('canvas');probe.width=probe.height=1;
    const ctx=probe.getContext('2d');ctx.fillStyle='#89d4e6';
    try{ctx.fillStyle=String(value||'#89d4e6');}catch{}
    ctx.fillRect(0,0,1,1);const data=ctx.getImageData(0,0,1,1).data;
    return[data[0],data[1],data[2]];
  }
  function sprite(rgb,type){
    const image=document.createElement('canvas');image.width=image.height=96;
    const ctx=image.getContext('2d');
    const rgba=alpha=>`rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    const glow=ctx.createRadialGradient(48,48,0,48,48,48);
    glow.addColorStop(0,type===1?'rgba(255,254,202,1)':'rgba(249,253,255,.98)');
    glow.addColorStop(type===1?.075:.055,rgba(.98));
    glow.addColorStop(type===1?.17:.14,rgba(type===1?.52:.42));
    glow.addColorStop(type===1?.45:.31,rgba(type===1?.15:.09));
    glow.addColorStop(.68,rgba(.025));glow.addColorStop(1,rgba(0));
    ctx.fillStyle=glow;ctx.fillRect(0,0,96,96);
    if(type===2){
      const beam=ctx.createRadialGradient(48,48,0,48,48,42);
      beam.addColorStop(0,'rgba(244,253,255,.85)');beam.addColorStop(.18,rgba(.6));beam.addColorStop(1,rgba(0));
      ctx.fillStyle=beam;
      ctx.beginPath();ctx.moveTo(48,5);ctx.quadraticCurveTo(49.2,46.8,91,48);ctx.quadraticCurveTo(49.2,49.2,48,91);ctx.quadraticCurveTo(46.8,49.2,5,48);ctx.quadraticCurveTo(46.8,46.8,48,5);ctx.fill();
    }
    return image;
  }
  function makeMeteorSprite(){
    const image=document.createElement('canvas');image.width=320;image.height=40;
    const ctx=image.getContext('2d');
    const tail=ctx.createLinearGradient(0,20,306,20);
    tail.addColorStop(0,'#6bcfe500');tail.addColorStop(.3,'#6bcfe52e');tail.addColorStop(.75,'#9bebff8c');tail.addColorStop(1,'#effdffff');
    ctx.strokeStyle=tail;ctx.lineWidth=1.65;ctx.shadowBlur=8;ctx.shadowColor='#7bdfff';
    ctx.beginPath();ctx.moveTo(0,20);ctx.lineTo(306,20);ctx.stroke();ctx.shadowBlur=0;
    const head=ctx.createRadialGradient(306,20,0,306,20,8);
    head.addColorStop(0,'#ffffff');head.addColorStop(.2,'#efffff');head.addColorStop(.4,'#9eeaff80');head.addColorStop(1,'#7bdfff00');
    ctx.fillStyle=head;ctx.fillRect(298,12,16,16);
    return image;
  }
  function makeSprites(accent){
    for(const image of sprites)image.width=image.height=1;
    const colors=[[218,242,255],colorRGB(accent),[246,213,156]];
    sprites=[];for(let type=0;type<3;type++)for(const color of colors)sprites.push(sprite(color,type));
    sprites.push(sprite([255,219,113],1),sprite([225,248,139],1));
  }
  function draw(){
    if(destroyed)return;
    const time=reduced?0:elapsed;
    context.clearRect(0,0,width,height);
    if(backdrop){context.fillStyle=backgroundFill;context.fillRect(0,0,width,height);context.fillStyle=backgroundGlow;context.fillRect(0,0,width,height);}
    context.globalCompositeOperation='lighter';
    for(let index=0;index<visibleStars;index++){
      const star=stars[index];
      const wave=.5+.5*Math.sin(time*star.speed+star.phase);
      const light=.08+.92*Math.pow(wave,1.35);
      const driftX=Math.sin(time*.055+star.phase)*width*.0015;
      const driftY=Math.cos(time*.045+star.phase)*height*.0015;
      const size=star.size*(.82+.28*light);
      context.globalAlpha=Math.min(1,light*intensity);
      context.drawImage(sprites[star.tint],star.x*width+driftX-size/2,star.y*height+driftY-size/2,size,size);
      if(star.glint){
        const pulse=.04+.91*Math.pow(wave,3);
        const glintSize=size*2.7;
        context.globalAlpha=Math.min(1,pulse*intensity);
        context.drawImage(sprites[6+star.tint],star.x*width+driftX-glintSize/2,star.y*height+driftY-glintSize/2,glintSize,glintSize);
      }
    }
    for(let index=0;index<visibleFireflies;index++){
      const fly=fireflies[index];
      const travel=Math.min(fly.travel,width*.16,height*.13);
      const x=fly.x*width+Math.sin(time*fly.speed+fly.phase)*travel;
      const y=fly.y*height+Math.cos(time*fly.speed*.79+fly.phase)*travel*.8;
      const size=fly.size;
      const light=.65+.3*Math.sin(time*1.4+fly.phase);
      for(let sample=4;sample>0;sample--){
        const before=time-sample*.065;
        const tx=fly.x*width+Math.sin(before*fly.speed+fly.phase)*travel;
        const ty=fly.y*height+Math.cos(before*fly.speed*.79+fly.phase)*travel*.8;
        const trailSize=size*(.34-sample*.035);
        context.globalAlpha=Math.min(1,light*intensity*(.2-sample*.035));
        context.drawImage(sprites[9+fly.tint],tx-trailSize/2,ty-trailSize/2,trailSize,trailSize);
      }
      context.globalAlpha=Math.min(1,light*intensity);
      context.drawImage(sprites[9+fly.tint],x-size/2,y-size/2,size,size);
    }
    if(!reduced){
      if(!meteor.active&&time>=nextMeteor){
        meteor.active=true;meteor.start=time;meteor.pattern=meteorPatterns[meteorIndex++%meteorPatterns.length];
        canvas.dataset.meteorCount=String(++meteorCount);
      }
      if(meteor.active){
        const pattern=meteor.pattern,progress=(time-meteor.start)/pattern.duration;
        if(progress>=1){meteor.active=false;nextMeteor=meteor.start+pattern.wait;}
        else{
          const run=width*pattern.run+120,fall=height*pattern.fall;
          const x=width*pattern.x+run*progress,y=height*pattern.y+fall*progress;
          const fade=Math.min(1,progress/.12,(1-progress)/.28);
          context.globalAlpha=Math.min(1,fade*intensity);
          context.save();context.translate(x,y);context.rotate(Math.atan2(fall,run));
          context.drawImage(meteorSprite,-pattern.length,-20,pattern.length,40);context.restore();
        }
      }
    }
    context.globalAlpha=1;context.globalCompositeOperation='source-over';
  }
  function canAnimate(){return!destroyed&&!paused&&!reduced&&!document.hidden&&intensity>0;}
  function requestFrame(){if(!raf&&canAnimate())raf=requestAnimationFrame(tick);}
  function tick(now){
    raf=0;if(!canAnimate())return;
    if(!lastPaint||now-lastPaint>=1000/30){
      if(lastPaint)elapsed+=Math.min(.1,(now-lastPaint)/1000);
      lastPaint=now;draw();canvas.dataset.starfieldFrame=String(++frameCount);
    }
    requestFrame();
  }
  function motionState(){canvas.dataset.starfieldMotion=reduced?'reduced':paused?'paused':document.hidden?'hidden':'running';}
  function stop(){cancelAnimationFrame(raf);raf=0;lastPaint=0;motionState();}
  function resize(){
    if(destroyed)return;
    const bounds=container.getBoundingClientRect();
    width=Math.max(1,bounds.width);height=Math.max(1,bounds.height);
    const dpr=Math.min(devicePixelRatio||1,1.5);
    canvas.width=Math.max(1,Math.round(width*dpr));canvas.height=Math.max(1,Math.round(height*dpr));
    context.setTransform(dpr,0,0,dpr,0,0);
    const mobile=width<=649;
    visibleStars=Math.min(stars.length,Math.ceil((mobile?350:650)*density));
    visibleFireflies=Math.min(fireflies.length,Math.ceil((mobile?20:35)*density));
    if(backdrop){
      backgroundFill=context.createLinearGradient(0,0,0,height);backgroundFill.addColorStop(0,'#02070d');backgroundFill.addColorStop(1,'#03151e');
      backgroundGlow=context.createRadialGradient(width*.55,height*.65,0,width*.55,height*.65,Math.max(width,height)*.68);backgroundGlow.addColorStop(0,'#10414c50');backgroundGlow.addColorStop(1,'#06111b00');
    }
    draw();requestFrame();
  }
  function onVisibility(){motionState();if(document.hidden)stop();else requestFrame();}
  function onReduced(){reduced=mql.matches;stop();draw();requestFrame();}
  makeSprites(currentAccent);
  meteorSprite=makeMeteorSprite();motionState();
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(resize):null;
  observer?.observe(container);
  window.addEventListener('resize',resize,{passive:true});
  document.addEventListener('visibilitychange',onVisibility);
  mql.addEventListener('change',onReduced);
  resize();
  return{
    setPaused(value){if(destroyed)return;paused=Boolean(value);motionState();if(paused)stop();else requestFrame();},
    setAccent(value){if(destroyed)return;const next=String(value||'#89d4e6');if(next===currentAccent)return;currentAccent=next;makeSprites(next);draw();},
    resize,
    destroy(){if(destroyed)return;destroyed=true;stop();observer?.disconnect();window.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',onVisibility);mql.removeEventListener('change',onReduced);for(const image of sprites)image.width=image.height=1;meteorSprite.width=meteorSprite.height=1;sprites.length=stars.length=fireflies.length=meteorPatterns.length=0;canvas.width=canvas.height=1;canvas.remove();},
  };
}
