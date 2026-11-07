import { createStarfield } from './starfield.js';

/* A local, real-media screening room. Reads a snapshot only when opened; never writes to the workbench. */
let styleLink;
let styleUsers = 0;

function useStyles() {
  if (!styleLink) {
    styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = new URL('./cinema.css', import.meta.url).href;
    document.head.append(styleLink);
  }
  styleUsers++;
  return () => { if (--styleUsers === 0) { styleLink?.remove(); styleLink = null; } };
}

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const icons = {
  play: svg('<path d="m9 5 10 7-10 7z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M8 5v14M16 5v14" stroke-width="3"/>'),
  previous: svg('<path d="M6 5v14m12-14L8 12l10 7z"/>'),
  next: svg('<path d="M18 5v14M6 5l10 7-10 7z"/>'),
  sound: svg('<path d="m11 5-6 4H2v6h3l6 4zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'),
  muted: svg('<path d="m11 5-6 4H2v6h3l6 4zm5 4 6 6m0-6-6 6"/>'),
  fullscreen: svg('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  replay: svg('<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/>'),
  back: svg('<path d="M20 12H4m6-6-6 6 6 6"/>'),
};

function localMedia(value, fallback = '') {
  if (!value) return fallback;
  try {
    const url = new URL(String(value), location.href);
    return url.origin === location.origin ? url.href : fallback;
  } catch { return fallback; }
}
function timeLabel(value) {
  const seconds = Math.max(0, Math.floor(value || 0));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function cameraLabel(value) {
  const labels = { fixed: '固定机位', 'slow-push': '缓慢推进', pan: '横向移动', 'pull-back': '缓慢拉远' };
  if (labels[value]) return labels[value];
  if (/fixed|static|locked|固定/i.test(value)) return '固定机位';
  return value;
}
function normalizeSnapshot(raw = {}) {
  const strictMedia = raw.strictMedia === true;
  const emptyPoster = '/studio/assets/empty-screen.svg';
  if (strictMedia && (!Array.isArray(raw.shots) || !raw.shots.length)) throw new Error('当前没有可放映的项目媒体。');
  const source = Array.isArray(raw.shots) && raw.shots.length ? raw.shots : [{ id: 'opening', title: '故事的第一幕', poster: '/art/studio-world.webp', duration: 6 }];
  let start = 0;
  const shots = source.map((shot, index) => {
    const duration = Math.max(0.5, Math.min(86400, Number(shot.duration) || 5));
    const result = {
      ...shot, id: shot.id ?? `shot-${index}`, title: String(shot.title || `镜头 ${index + 1}`),
      description: String(shot.description || ''), camera: String(shot.camera || '缓慢推进'),
      poster: localMedia(shot.poster, strictMedia ? emptyPoster : '/art/studio-world.webp'), video: localMedia(shot.video),
      focus: CSS.supports('object-position', String(shot.focus || '')) ? String(shot.focus) : '50% center',
      duration, start,
    };
    start += duration;
    return result;
  });
  const proposedFilter = String(raw.look?.filter || 'none');
  const filter = !/url\s*\(/i.test(proposedFilter) && CSS.supports('filter', proposedFilter) ? proposedFilter : 'none';
  let glow = Number(raw.look?.glow) || 0;
  if (glow > 1) glow /= 100;
  glow = Math.max(0, Math.min(1, glow));
  const lightPosition = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : fallback;
  const ratioMatch = String(raw.ratio || '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  const ratio = ratioMatch && Number(ratioMatch[1]) > 0 && Number(ratioMatch[2]) > 0 ? String(raw.ratio) : '16:9';
  return {
    title: String(raw.title || '未命名的电影'), episode: String(raw.episode || 'DIRECTOR’S CUT'),
    shots, selectedId: raw.selectedId, duration: start, ratio, strictMedia, mediaAudio: raw.mediaAudio === true,
    look: {
      filter, glow, accent: CSS.supports('color', String(raw.look?.accent)) ? String(raw.look.accent) : '#d5b985',
      lightX: lightPosition(raw.look?.lightX, 62), lightY: lightPosition(raw.look?.lightY, 32),
      lightColor: CSS.supports('color', String(raw.look?.lightColor)) ? String(raw.look.lightColor) : '#d9e6ed',
      lightOpacity: 0.07 + glow * 0.28,
    },
  };
}

/**
 * createCinema({getSnapshot, onClose?}) -> {open({fromStart=true}={}), close(), destroy()}.
 * fromStart:false starts at snapshot.selectedId. close reports {selectedId,time,duration}.
 * Phases: opening -> lead -> playing (data-playing indicates pause) -> credits -> closed.
 */
export function createCinema({ getSnapshot, onClose = () => {} }) {
  if (typeof getSnapshot !== 'function') throw new Error('Cinema requires getSnapshot().');
  const releaseStyles = useStyles();
  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const dialog = document.createElement('dialog');
  dialog.className = 'dc-cinema';
  dialog.setAttribute('aria-label', '导演私人放映室');
  dialog.setAttribute('aria-modal', 'true');
  dialog.innerHTML = `
    <div class="dc-room">
      <div class="dc-ambient" aria-hidden="true"></div>
      <header class="dc-header">
        <div class="dc-room-brand"><span class="dc-brand-mark">◈</span><span>PRIVATE SCREENING<small>小李短剧 · 私人放映室</small></span></div>
        <div class="dc-header-title"></div>
        <div class="dc-header-actions">
          <button class="dc-icon dc-audio" aria-label="开启影院氛围音" aria-pressed="false" title="影院氛围音">${icons.muted}</button>
          <button class="dc-icon dc-fullscreen" aria-label="进入全屏" aria-pressed="false" title="全屏">${icons.fullscreen}</button>
          <button class="dc-icon dc-close" aria-label="关闭放映室" title="回到导演台 · Esc">${icons.close}</button>
        </div>
      </header>
      <main class="dc-chamber">
        <div class="dc-projector" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="dc-sidewall dc-sidewall-left" aria-hidden="true"></div>
        <div class="dc-sidewall dc-sidewall-right" aria-hidden="true"></div>
        <div class="dc-screen-assembly">
          <div class="dc-screen-halo" aria-hidden="true"></div>
          <div class="dc-screen-frame">
            <div class="dc-screen" aria-label="影片画面">
              <div class="dc-media-stack"></div>
              <div class="dc-lightwash" aria-hidden="true"></div>
              <div class="dc-screen-vignette" aria-hidden="true"></div>
              <div class="dc-lead"><span class="dc-lead-kicker">A LITTLE STORY. A WORLD OF ITS OWN.</span><h1></h1><div class="dc-title-rule"></div><p></p><span class="dc-lead-signature">DIRECTED BY YOU</span></div>
              <button class="dc-center-play" aria-label="继续播放">${icons.play}</button>
              <div class="dc-credits"><div><span class="dc-credit-kicker">AND THE STORY GOES ON.</span><h2></h2><p>一个念头，一束光。<br>谢谢你，让这个世界发生。</p><small>DIRECTED BY YOU · 小李短剧</small><div class="dc-credit-actions"><button class="dc-replay">${icons.replay}再看一遍</button><button class="dc-return">回到导演台 ${icons.back}</button></div></div></div>
              <div class="dc-curtains" aria-hidden="true"><div class="dc-curtain dc-curtain-left"></div><div class="dc-curtain dc-curtain-right"></div></div>
            </div>
          </div>
          <div class="dc-screen-floor" aria-hidden="true"></div>
        </div>
        <div class="dc-stage-caption"><span class="dc-shot-number"></span><strong class="dc-shot-title"></strong><span class="dc-shot-camera"></span></div>
        <button class="dc-skip-intro">跳过片头 <span>↗</span></button>
      </main>
      <footer class="dc-transport">
        <div class="dc-timeline"><div class="dc-track"><div class="dc-track-fill"></div><div class="dc-cut-marks"></div></div><input class="dc-scrubber" type="range" min="0" max="1" step="0.01" value="0" aria-label="影片播放进度"/></div>
        <div class="dc-controls-row"><div class="dc-time"><span class="dc-current-time">00:00</span><i>/</i><span class="dc-total-time">00:00</span></div><div class="dc-main-controls"><button class="dc-icon dc-previous" aria-label="上一个镜头">${icons.previous}</button><button class="dc-play-toggle" aria-label="暂停播放">${icons.pause}</button><button class="dc-icon dc-next" aria-label="下一个镜头">${icons.next}</button></div><div class="dc-format"><span class="dc-ratio"></span><span>DIRECTOR’S CUT</span></div></div>
        <nav class="dc-shot-strip" aria-label="选择放映镜头"></nav>
      </footer>
      <div class="dc-announcement" aria-live="polite"></div>
    </div>`;
  document.body.append(dialog);
  const starContainer = document.createElement('div');
  starContainer.className = 'dc-star-background';
  starContainer.setAttribute('aria-hidden', 'true');
  dialog.querySelector('.dc-room').prepend(starContainer);
  const starfield = createStarfield(starContainer, { intensity: .6, density: .8 });
  starfield.setPaused(true);
  const $ = (selector) => dialog.querySelector(selector);
  const elements = {
    room: $('.dc-room'), ambient: $('.dc-ambient'), headerTitle: $('.dc-header-title'),
    leadTitle: $('.dc-lead h1'), leadEpisode: $('.dc-lead p'), creditsTitle: $('.dc-credits h2'),
    shotNumber: $('.dc-shot-number'), shotTitle: $('.dc-shot-title'), shotCamera: $('.dc-shot-camera'),
    shotStrip: $('.dc-shot-strip'), cuts: $('.dc-cut-marks'), scrubber: $('.dc-scrubber'),
    fill: $('.dc-track-fill'), currentTime: $('.dc-current-time'), totalTime: $('.dc-total-time'),
    play: $('.dc-play-toggle'), centerPlay: $('.dc-center-play'), audio: $('.dc-audio'),
    fullscreen: $('.dc-fullscreen'), ratio: $('.dc-ratio'), floor: $('.dc-screen-floor'), announcement: $('.dc-announcement'),
  };
  const mediaStack = $('.dc-media-stack');
  const layers = Array.from({ length: 2 }, () => {
    const node = document.createElement('div');
    node.className = 'dc-media-layer';
    const poster = document.createElement('img'); poster.className = 'dc-poster'; poster.alt = ''; poster.draggable = false;
    const video = document.createElement('video'); video.className = 'dc-video'; video.muted = video.defaultMuted = true;
    video.loop = true; video.playsInline = true; video.preload = 'auto';
    video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.setAttribute('aria-hidden', 'true');
    node.append(poster, video); mediaStack.append(node);
    return { node, poster, video, index: -1, controller: null, readyPromise: null, frameCallback: 0, prepared: false };
  });

  let snapshot;
  let opened = false, destroyed = false, playing = false, scrubbing = false, resumeAfterScrub = false;
  let phase = 'closed', currentTime = 0, requestedIndex = -1, currentLayer = null;
  let reduced = reducedQuery.matches, raf = 0, lastTick = 0, mediaToken = 0;
  let returnFocus = null, previousOverflow = '', audioEnabled = false, audioContext = null, master = null;
  let oscillators = [], preloads = [], audioAvailable = true;
  const timers = new Set();
  const removers = [];

  function listen(node, type, handler, options) {
    node.addEventListener(type, handler, options);
    removers.push(() => node.removeEventListener(type, handler, options));
  }
  function later(callback, ms) {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer); return timer;
  }
  function clearTimers() { timers.forEach(clearTimeout); timers.clear(); }
  function setPhase(value) { phase = value; dialog.dataset.phase = value; }
  function locate(time) {
    const safe = Math.max(0, Math.min(snapshot.duration - 0.001, time));
    const index = Math.max(0, snapshot.shots.findIndex((shot) => safe >= shot.start && safe < shot.start + shot.duration));
    return { index, offset: safe - snapshot.shots[index].start };
  }
  function pauseVideos() { layers.forEach((layer) => layer.video.pause()); }
  function updateMediaAudio() {
    if (!snapshot?.mediaAudio) return;
    for (const layer of layers) layer.video.muted = !audioEnabled || layer !== currentLayer || !playing;
  }
  function updateAudio() {
    if (!audioContext) return;
    if (opened && playing && audioEnabled && !document.hidden) {
      audioContext.resume().then(() => {
        if (!destroyed && master) master.gain.setTargetAtTime(0.16, audioContext.currentTime, 0.7);
      }).catch(() => {});
    } else {
      if (master) master.gain.setTargetAtTime(0, audioContext.currentTime, 0.08);
      // Suspend after the fade, including on close; audio never runs in the background.
      later(() => { if (!playing || !opened || !audioEnabled || document.hidden) audioContext?.suspend().catch(() => {}); }, 250);
    }
  }
  function setPlaying(value) {
    playing = Boolean(value) && opened && phase === 'playing' && !document.hidden;
    dialog.dataset.playing = String(playing);
    elements.play.innerHTML = playing ? icons.pause : icons.play;
    elements.play.setAttribute('aria-label', playing ? '暂停播放' : '继续播放');
    lastTick = 0;
    if (playing) currentLayer?.video.play().catch(() => {});
    else pauseVideos();
    updateMediaAudio();
    updateAudio(); requestFrame();
  }
  function requestFrame() { if (!raf && opened && !destroyed) raf = requestAnimationFrame(tick); }
  function setVideoTime(layer, offset) {
    const video = layer.video;
    if (!video.getAttribute('src')) return;
    const apply = () => {
      if (!opened || layer.index < 0) return;
      const time = Number.isFinite(video.duration) && video.duration > 0 ? offset % video.duration : offset;
      if (Math.abs(video.currentTime - time) > 0.12) {
        layer.node.classList.remove('dc-video-ready');
        try { video.currentTime = Math.max(0, time); } catch { /* A decoded poster remains visible while metadata arrives. */ }
      }
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener('loadedmetadata', apply, { once: true, signal: layer.controller?.signal });
  }
  function prepare(layer, index, offset = 0) {
    if (layer.index === index && layer.prepared) { setVideoTime(layer, offset); return Promise.resolve(layer); }
    if (layer.index === index && layer.readyPromise) return layer.readyPromise;
    layer.controller?.abort();
    if (layer.frameCallback && layer.video.cancelVideoFrameCallback) layer.video.cancelVideoFrameCallback(layer.frameCallback);
    layer.controller = new AbortController();
    const { signal } = layer.controller;
    const shot = snapshot.shots[index];
    layer.index = index; layer.prepared = false;
    layer.video.muted = true;
    layer.video.pause(); layer.node.classList.remove('dc-video-ready');
    layer.node.style.filter = snapshot.look.filter;
    layer.poster.style.objectPosition = layer.video.style.objectPosition = shot.focus;
    layer.poster.src = shot.poster;
    layer.poster.alt = shot.title;
    const revealVideo = () => {
      if (!opened || destroyed || signal.aborted || layer.video.readyState < 2 || layer.video.seeking) return;
      const reveal = () => { if (!signal.aborted && opened) layer.node.classList.add('dc-video-ready'); };
      if (layer.video.requestVideoFrameCallback) {
        if (layer.frameCallback && layer.video.cancelVideoFrameCallback) layer.video.cancelVideoFrameCallback(layer.frameCallback);
        layer.frameCallback = layer.video.requestVideoFrameCallback(reveal);
      }
      else requestAnimationFrame(reveal);
    };
    layer.video.addEventListener('loadeddata', revealVideo, { signal });
    layer.video.addEventListener('seeked', revealVideo, { signal });
    layer.video.addEventListener('playing', revealVideo, { signal });
    layer.video.addEventListener('error', () => layer.node.classList.remove('dc-video-ready'), { signal });
    if (shot.video) { layer.video.src = shot.video; layer.video.load(); setVideoTime(layer, offset); }
    else { layer.video.removeAttribute('src'); layer.video.load(); }
    layer.readyPromise = layer.poster.decode().catch(() => undefined).then(() => {
      if (!signal.aborted) layer.prepared = true;
      return layer;
    });
    return layer.readyPromise;
  }
  function cueNext(index) {
    const next = index + 1;
    if (next >= snapshot.shots.length || !currentLayer) return;
    const spare = layers.find((layer) => layer !== currentLayer);
    void prepare(spare, next, 0);
  }
  function activate(index, offset = 0) {
    if (!opened || !snapshot.shots[index]) return;
    requestedIndex = index;
    const shot = snapshot.shots[index];
    elements.shotNumber.textContent = `${String(index + 1).padStart(2, '0')} / ${String(snapshot.shots.length).padStart(2, '0')}`;
    elements.shotTitle.textContent = shot.title;
    elements.shotCamera.textContent = `${cameraLabel(shot.camera)} · ${shot.duration}s`;
    elements.announcement.textContent = `镜头 ${index + 1}，${shot.title}`;
    elements.shotStrip.querySelectorAll('button').forEach((button, position) => {
      button.classList.toggle('dc-active-shot', position === index);
      button.setAttribute('aria-current', position === index ? 'true' : 'false');
    });
    if (currentLayer?.index === index) { setVideoTime(currentLayer, offset); return; }
    const token = ++mediaToken;
    const incoming = layers.find((layer) => layer.index === index) || layers.find((layer) => layer !== currentLayer) || layers[0];
    const previous = currentLayer;
    void prepare(incoming, index, offset).then(() => {
      if (!opened || destroyed || token !== mediaToken) return;
      currentLayer = incoming;
      updateMediaAudio();
      layers.forEach((layer) => layer.node.classList.toggle('dc-current-layer', layer === incoming));
      elements.ambient.style.backgroundImage = elements.floor.style.backgroundImage = `url(${JSON.stringify(shot.poster)})`;
      elements.ambient.style.filter = `${snapshot.look.filter === 'none' ? '' : snapshot.look.filter} blur(80px)`;
      if (playing && shot.video) incoming.video.play().catch(() => {});
      if (previous && previous !== incoming) later(() => {
        if (currentLayer !== previous) { previous.video.pause(); cueNext(index); }
      }, reduced ? 20 : 550);
      else cueNext(index);
      requestFrame();
    });
  }
  function cameraMotion(layer) {
    if (!snapshot || layer.index < 0 || !snapshot.shots[layer.index]) return;
    if (reduced || snapshot.strictMedia) { layer.poster.style.transform = layer.video.style.transform = 'none'; return; }
    const shot = snapshot.shots[layer.index];
    const t = Math.max(0, Math.min(1, (currentTime - shot.start) / shot.duration));
    let scale = 1.035, x = 0, y = 0;
    if (/fixed|static|locked|固定/i.test(shot.camera)) scale = 1;
    else if (/拉远|后拉|zoom.?out|pull/i.test(shot.camera)) scale = 1.12 - t * 0.085;
    else if (/横移|平移|向右|pan|truck/i.test(shot.camera)) { scale = 1.075; x = (t - 0.5) * 4; }
    else if (/升|俯|crane|tilt/i.test(shot.camera)) { scale = 1.08; y = (t - 0.5) * 3; }
    else scale = 1.035 + t * 0.075;
    const transform = `translate3d(${x}%,${y}%,0) scale(${scale})`;
    layer.poster.style.transform = layer.video.style.transform = transform;
  }
  function renderTime() {
    const fraction = snapshot.duration ? currentTime / snapshot.duration : 0;
    elements.fill.style.width = `${fraction * 100}%`;
    if (!scrubbing) elements.scrubber.value = String(currentTime);
    elements.scrubber.setAttribute('aria-valuetext', `${timeLabel(currentTime)}，总长 ${timeLabel(snapshot.duration)}`);
    const label = timeLabel(currentTime);
    if (elements.currentTime.textContent !== label) elements.currentTime.textContent = label;
    layers.forEach(cameraMotion);
  }
  function tick(now) {
    raf = 0;
    if (!opened || destroyed) return;
    const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
    lastTick = now;
    if (playing && !scrubbing && phase === 'playing') {
      currentTime = Math.min(snapshot.duration, currentTime + dt);
      if (currentTime >= snapshot.duration) { finish(); return; }
      const { index, offset } = locate(currentTime);
      if (index !== requestedIndex) activate(index, offset);
    }
    renderTime();
    if (playing) requestFrame(); else lastTick = 0;
  }
  function startScreening() {
    if (!opened) return;
    clearTimers(); dialog.classList.add('dc-revealed'); setPhase('playing');
    setPlaying(true);
  }
  function finish() {
    currentTime = snapshot.duration; setPhase('credits'); setPlaying(false); renderTime();
    elements.announcement.textContent = '影片放映结束。可以再看一遍，或回到导演台。';
  }
  function seek(value, preservePlaying = playing) {
    if (!opened) return;
    clearTimers(); dialog.classList.add('dc-revealed'); setPhase('playing');
    currentTime = Math.max(0, Math.min(snapshot.duration - 0.001, Number(value) || 0));
    const { index, offset } = locate(currentTime); activate(index, offset); setPlaying(preservePlaying); renderTime();
  }
  function jump(step) {
    const index = phase === 'credits' ? snapshot.shots.length - 1 : locate(currentTime).index;
    const next = Math.max(0, Math.min(snapshot.shots.length - 1, index + step));
    seek(snapshot.shots[next].start, playing || phase === 'credits');
  }
  function populate() {
    elements.headerTitle.textContent = `${snapshot.title} / ${snapshot.episode}`;
    elements.leadTitle.textContent = elements.creditsTitle.textContent = snapshot.title;
    elements.leadEpisode.textContent = snapshot.episode;
    elements.ratio.textContent = snapshot.ratio;
    elements.totalTime.textContent = timeLabel(snapshot.duration);
    elements.scrubber.max = String(snapshot.duration);
    const [ratioWidth, ratioHeight] = snapshot.ratio.split(':').map(Number);
    dialog.style.setProperty('--dc-screen-aspect', String(ratioWidth / ratioHeight));
    dialog.style.setProperty('--dc-accent', snapshot.look.accent);
    dialog.style.setProperty('--dc-glow', String(snapshot.look.glow));
    dialog.style.setProperty('--dc-light-x', `${snapshot.look.lightX}%`);
    dialog.style.setProperty('--dc-light-y', `${snapshot.look.lightY}%`);
    dialog.style.setProperty('--dc-light-color', snapshot.look.lightColor);
    dialog.style.setProperty('--dc-light-opacity', String(snapshot.look.lightOpacity));
    elements.shotStrip.replaceChildren(); elements.cuts.replaceChildren();
    snapshot.shots.forEach((shot, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.setAttribute('aria-label', `播放镜头 ${index + 1}：${shot.title}`);
      const image = document.createElement('img'); image.src = shot.poster; image.alt = ''; image.style.objectPosition = shot.focus;
      const label = document.createElement('span'); label.textContent = String(index + 1).padStart(2, '0');
      button.append(image, label); button.addEventListener('click', () => seek(shot.start, true));
      elements.shotStrip.append(button);
      if (index) { const cut = document.createElement('i'); cut.style.left = `${shot.start / snapshot.duration * 100}%`; elements.cuts.append(cut); }
      const preload = new Image(); preload.src = shot.poster; preloads.push(preload);
    });
  }
  function releaseMedia() {
    mediaToken++; requestedIndex = -1; currentLayer = null;
    for (const layer of layers) {
      layer.controller?.abort(); layer.video.pause();
      if (layer.frameCallback && layer.video.cancelVideoFrameCallback) layer.video.cancelVideoFrameCallback(layer.frameCallback);
      layer.video.removeAttribute('src'); layer.video.load(); layer.poster.removeAttribute('src');
      layer.node.classList.remove('dc-video-ready', 'dc-current-layer');
      layer.index = -1; layer.prepared = false; layer.readyPromise = null;
    }
    preloads.forEach((image) => image.removeAttribute('src')); preloads = [];
  }
  function open({ fromStart = true } = {}) {
    if (destroyed) return;
    clearTimers(); releaseMedia();
    const previousAudioMode = snapshot?.mediaAudio;
    snapshot = normalizeSnapshot(getSnapshot() || {});
    const index = fromStart ? 0 : Math.max(0, snapshot.shots.findIndex((shot) => shot.id === snapshot.selectedId));
    currentTime = snapshot.shots[index].start;
    if (!opened) { returnFocus = document.activeElement; previousOverflow = document.body.style.overflow; }
    opened = true; playing = false; scrubbing = false; lastTick = 0;
    if (snapshot.mediaAudio) {
      audioEnabled = false;
      elements.audio.innerHTML = icons.muted;
      elements.audio.setAttribute('aria-pressed', 'false');
      elements.audio.setAttribute('aria-label', '开启影片原声');
      elements.audio.title = '影片原声';
    } else {
      if (previousAudioMode !== snapshot.mediaAudio) {
        audioEnabled = false;
        elements.audio.innerHTML = icons.muted;
        elements.audio.setAttribute('aria-pressed', 'false');
      }
      elements.audio.title = '影院氛围音';
      elements.audio.setAttribute('aria-label', audioEnabled ? '关闭影院氛围音' : '开启影院氛围音');
    }
    dialog.dataset.playing = 'false'; dialog.classList.remove('dc-revealed');
    dialog.classList.toggle('dc-reduced', reduced);
    setPhase(reduced ? 'playing' : 'opening'); populate();
    document.body.style.overflow = 'hidden';
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); }
    }
    starfield.setAccent(snapshot.look.accent);
    starfield.resize(); starfield.setPaused(false);
    activate(index, 0); renderTime();
    $('.dc-close').focus({ preventScroll: true });
    if (reduced) startScreening();
    else {
      later(() => dialog.classList.add('dc-revealed'), 40);
      later(() => { if (opened) setPhase('lead'); }, 1540);
      later(startScreening, 2380);
    }
  }
  function close() {
    if (!opened) return;
    const result = { selectedId: snapshot.shots[locate(currentTime).index]?.id, time: currentTime, duration: snapshot.duration };
    opened = false; playing = false; dialog.dataset.playing = 'false'; setPhase('closed');
    starfield.setPaused(true);
    clearTimers(); cancelAnimationFrame(raf); raf = 0; lastTick = 0;
    releaseMedia();
    if (master && audioContext) master.gain.setValueAtTime(0, audioContext.currentTime);
    audioContext?.suspend().catch(() => {});
    if (document.fullscreenElement === dialog) document.exitFullscreen?.().catch(() => {});
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    document.body.style.overflow = previousOverflow;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    onClose(result);
  }
  async function toggleAudio() {
    if (snapshot?.mediaAudio) {
      audioEnabled = !audioEnabled;
      updateMediaAudio();
      elements.audio.innerHTML = audioEnabled ? icons.sound : icons.muted;
      elements.audio.setAttribute('aria-pressed', String(audioEnabled));
      elements.audio.setAttribute('aria-label', audioEnabled ? '关闭影片原声' : '开启影片原声');
      return;
    }
    if (!audioAvailable) return;
    audioEnabled = !audioEnabled;
    if (audioEnabled && !audioContext) {
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        audioContext = new Audio(); master = audioContext.createGain(); master.gain.value = 0; master.connect(audioContext.destination);
        for (const frequency of [130.81, 196, 261.63, 311.13]) {
          const oscillator = audioContext.createOscillator(); oscillator.type = 'sine'; oscillator.frequency.value = frequency;
          const gain = audioContext.createGain(); gain.gain.value = 0.11;
          const filter = audioContext.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 850;
          oscillator.connect(gain); gain.connect(filter); filter.connect(master); oscillator.start(); oscillators.push(oscillator);
        }
      } catch { audioEnabled = false; audioAvailable = false; }
    }
    elements.audio.innerHTML = audioEnabled ? icons.sound : icons.muted;
    elements.audio.setAttribute('aria-pressed', String(audioEnabled));
    elements.audio.setAttribute('aria-label', audioEnabled ? '关闭影院氛围音' : '开启影院氛围音');
    updateAudio();
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement === dialog) await document.exitFullscreen();
      else if (dialog.requestFullscreen && document.fullscreenEnabled) await dialog.requestFullscreen();
      else dialog.classList.toggle('dc-immersive');
    } catch { dialog.classList.toggle('dc-immersive'); }
    elements.fullscreen.setAttribute('aria-pressed', String(document.fullscreenElement === dialog || dialog.classList.contains('dc-immersive')));
  }
  function togglePlay() {
    if (phase === 'opening' || phase === 'lead') startScreening();
    else if (phase === 'credits') { currentTime = 0; seek(0, true); }
    else setPlaying(!playing);
  }
  listen($('.dc-close'), 'click', close); listen($('.dc-return'), 'click', close);
  listen($('.dc-replay'), 'click', () => { currentTime = 0; seek(0, true); });
  listen($('.dc-skip-intro'), 'click', startScreening);
  listen(elements.play, 'click', togglePlay); listen(elements.centerPlay, 'click', togglePlay);
  listen($('.dc-previous'), 'click', () => jump(-1)); listen($('.dc-next'), 'click', () => jump(1));
  listen(elements.audio, 'click', toggleAudio); listen(elements.fullscreen, 'click', fullscreen);
  listen(elements.scrubber, 'pointerdown', () => { scrubbing = true; resumeAfterScrub = playing; setPlaying(false); });
  listen(elements.scrubber, 'input', () => seek(elements.scrubber.value, scrubbing ? false : playing));
  listen(elements.scrubber, 'change', () => { const resume = scrubbing ? resumeAfterScrub : playing; scrubbing = false; seek(elements.scrubber.value, resume); });
  listen(elements.scrubber, 'pointercancel', () => { scrubbing = false; setPlaying(resumeAfterScrub); });
  listen(dialog, 'cancel', (event) => { event.preventDefault(); close(); });
  listen(dialog, 'close', () => { if (opened) close(); });
  listen(dialog, 'keydown', (event) => {
    if (!opened || event.metaKey || event.ctrlKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    if (event.key === ' ' && event.target.tagName !== 'BUTTON') { event.preventDefault(); togglePlay(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seek(currentTime + 5); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(currentTime - 5); }
    else if (event.key.toLowerCase() === 'f') { event.preventDefault(); void fullscreen(); }
    else if (event.key.toLowerCase() === 'm') { event.preventDefault(); void toggleAudio(); }
  });
  listen(document, 'visibilitychange', () => { if (opened && document.hidden) { setPlaying(false); pauseVideos(); } });
  listen(document, 'fullscreenchange', () => elements.fullscreen.setAttribute('aria-pressed', String(document.fullscreenElement === dialog)));
  listen(reducedQuery, 'change', () => {
    reduced = reducedQuery.matches; dialog.classList.toggle('dc-reduced', reduced);
    if (opened && reduced && (phase === 'opening' || phase === 'lead')) startScreening();
    requestFrame();
  });

  return {
    open, close,
    destroy() {
      if (destroyed) return;
      close(); destroyed = true; clearTimers(); cancelAnimationFrame(raf); releaseMedia();
      starfield.destroy();
      removers.forEach((remove) => remove());
      oscillators.forEach((oscillator) => { try { oscillator.stop(); oscillator.disconnect(); } catch { /* Already stopped. */ } });
      oscillators = []; master?.disconnect(); audioContext?.close().catch(() => {}); audioContext = null;
      dialog.remove(); releaseStyles();
    },
  };
}
