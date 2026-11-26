import { MathUtils } from 'three';
import { Director } from './director.js';

const STORAGE_KEY = 'manhattan.director.v1';
const EASINGS = ['linear', 'in', 'out', 'inout'];
const seconds = shot => Number.isFinite(shot.duration) ? Math.max(0, shot.duration) : 0;
const validFov = value => Number.isFinite(value) && value > 0 && value < 180;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function isShotFile(data) {
  return data?.version === 1 && Array.isArray(data.shots) && data.shots.every(shot =>
    isRecord(shot) && Array.isArray(shot.keys) && shot.keys.every(key =>
      isRecord(key) && Array.isArray(key.pos) && key.pos.length === 3 && key.pos.every(Number.isFinite)));
}

const styles = `
  .director-panel, .director-time {
    position: fixed;
    z-index: 2;
    color: #fff;
    background: rgba(12, 18, 28, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 10px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
  .director-panel {
    top: 78px;
    left: 14px;
    width: min(360px, calc(100vw - 28px));
    max-height: calc(100vh - 92px);
    overflow: auto;
    padding: 8px 10px;
    overscroll-behavior: contain;
  }
  .director-panel[hidden], .director-time[hidden] { display: none; }
  .director-panel header { display: flex; align-items: center; gap: 8px; }
  .director-panel header strong { margin-right: auto; }
  .director-panel button {
    color: inherit;
    font: inherit;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 4px;
    padding: 0 6px;
    cursor: pointer;
  }
  .director-panel ul {
    margin: 6px 0;
    padding: 0;
    list-style: none;
    max-height: 132px;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .director-panel li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto auto;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border-radius: 5px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.82);
  }
  .director-panel li[aria-current="true"] { background: rgba(255, 215, 106, 0.14); color: #ffd76a; }
  .director-panel input[type="text"] {
    width: 100%;
    min-width: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 1px 3px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    user-select: text;
  }
  .director-panel input[type="text"]:hover, .director-panel input[type="text"]:focus {
    border-color: rgba(255, 215, 106, 0.6);
    background: rgba(0, 0, 0, 0.22);
  }
  .director-panel label { display: flex; align-items: center; gap: 3px; cursor: pointer; }
  .director-panel input[type="checkbox"] { margin: 0; accent-color: #ffd76a; }
  .director-legend { display: grid; grid-template-columns: repeat(auto-fit, minmax(138px, 1fr)); gap: 2px 5px; }
  .director-legend span { display: flex; align-items: center; gap: 4px; font-size: 11px; }
  .director-legend kbd { padding: 0 3px; margin: 0; line-height: 15px; }
  .director-panel p { margin: 4px 0 0; font-size: 11px; }
  .director-panel [data-status], .director-panel a { color: #ffd76a; }
  .director-downloads:not([hidden]) { display: flex; gap: 10px; }
  .director-panel.is-drop-target { border-color: #ffd76a; }
  .director-time {
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    padding: 2px 8px;
    color: #ffd76a;
    font-size: 11px;
    pointer-events: none;
  }
  body:has(.director-time:not([hidden])) #overlay { visibility: hidden; }
`;

// extras: more keys for the panel, each [key code, key label, what it does, function]
export function createDirectorUI({ director, camera, player, extras = [] }) {
  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);

  const panel = document.createElement('section');
  panel.className = 'director-panel';
  panel.setAttribute('aria-label', 'Camera shots');
  panel.hidden = true;
  panel.innerHTML = `
    <header>
      <strong>Camera shots</strong>
      <span data-summary></span>
      <button type="button" aria-label="Close camera shots">Close</button>
    </header>
    <ul aria-label="Shots"></ul>
    <p data-empty hidden>No shots yet. Press N to create one.</p>
    <p data-view></p>
    <div class="director-legend" aria-label="Keyboard shortcuts"></div>
    <p>Drop a shots.json here to load it. Esc releases the mouse.</p>
    <p data-status role="status" hidden></p>
    <p class="director-downloads" hidden><a download="shots.json">shots.json</a><a download="shots-baked.json">shots-baked.json</a></p>
  `;

  const readout = document.createElement('div');
  readout.className = 'director-time';
  readout.hidden = true;
  document.body.append(panel, readout);

  const list = panel.querySelector('ul');
  const summary = panel.querySelector('[data-summary]');
  const empty = panel.querySelector('[data-empty]');
  const view = panel.querySelector('[data-view]');
  const status = panel.querySelector('[data-status]');
  const downloads = panel.querySelector('.director-downloads');
  let keyIndex = -1;
  let playback = null;
  let loadSequence = 0;

  const currentShot = () => director.shots[director.current];

  function setStatus(message = '') {
    status.textContent = message;
    status.hidden = !message;
  }

  function setFov(fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  function save() {
    try {
      const data = { ...director.toJSON(), current: director.current, fov: camera.fov };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Editing and export remain available when storage is blocked or full.
    }
  }

  function refreshSelection(scroll = false) {
    for (const row of list.children) {
      const selected = Number(row.dataset.shot) === director.current;
      row.setAttribute('aria-current', String(selected));
      if (selected && scroll) row.scrollIntoView({ block: 'nearest' });
    }
    const key = keyIndex < 0 ? '—' : `${keyIndex + 1} / ${currentShot().keys.length}`;
    view.textContent = `Lens ${Number(camera.fov.toFixed(1))}° · key ${key}`;
  }

  function renderShots() {
    list.replaceChildren(...director.shots.map((shot, index) => {
      const row = document.createElement('li');
      row.dataset.shot = index;
      row.innerHTML = `
        <input type="text" autocomplete="off" spellcheck="false" placeholder="untitled">
        <span></span><span></span><span></span>
        <label><input type="checkbox">night</label>
      `;
      const name = row.firstElementChild;
      name.value = typeof shot.name === 'string' ? shot.name : '';
      name.setAttribute('aria-label', `Name of shot ${index + 1}`);
      const [duration, ease, keys] = row.querySelectorAll('span');
      duration.textContent = `${Number(seconds(shot).toFixed(2))} s`;
      ease.textContent = EASINGS.includes(shot.ease) ? shot.ease : 'linear';
      keys.textContent = `${shot.keys.length} keys`;
      const night = row.querySelector('input[type="checkbox"]');
      night.checked = shot.night === true;
      night.setAttribute('aria-label', `Shot ${index + 1} at night`);
      return row;
    }));
    const total = director.shots.reduce((sum, shot) => sum + seconds(shot), 0);
    summary.textContent = `${Number(total.toFixed(2))} s in all`;
    empty.hidden = director.shots.length > 0;
    refreshSelection();
  }

  function changed() {
    clearDownloads();
    renderShots();
    save();
  }

  function select(index, scroll = false) {
    if (!director.shots[index] || index === director.current) return;
    director.current = index;
    keyIndex = -1;
    refreshSelection(scroll);
    save();
  }

  function newShot() {
    const index = director.newShot(`Shot ${director.shots.length + 1}`);
    director.shots[index].night = false;
    keyIndex = -1;
    changed();
    list.children[index].scrollIntoView({ block: 'nearest' });
  }

  function addKey() {
    if (!currentShot()) newShot();
    director.addKey();
    changed();
  }

  function removeKey() {
    if (!currentShot()?.keys.length) return;
    director.removeLastKey();
    if (keyIndex >= currentShot().keys.length) keyIndex = -1;
    changed();
  }

  function changeDuration(delta) {
    const shot = currentShot();
    if (!shot) return;
    shot.duration = Math.max(0.5, seconds(shot) + delta);
    changed();
  }

  function cycleEasing() {
    const shot = currentShot();
    if (!shot) return;
    shot.ease = EASINGS[(EASINGS.indexOf(shot.ease) + 1) % EASINGS.length];
    changed();
  }

  function changeFov(delta) {
    setFov(MathUtils.clamp(camera.fov + delta, 1, 179));
    refreshSelection();
    save();
  }

  function jumpKey(direction) {
    const keys = currentShot()?.keys;
    if (!keys?.length) return;
    const last = keys.length - 1;
    const start = keyIndex < 0 ? (direction < 0 ? last + 1 : -1) : keyIndex;
    keyIndex = MathUtils.clamp(start + direction, 0, last);
    const key = keys[keyIndex];
    if (player.mode === 'drive' && player.vehicle) {
      player.vehicle.dark = true;
      player.vehicle = null;
    }
    player.mode = 'fly';
    player.vel?.set(0, 0, 0);
    player.pos.fromArray(key.pos);
    player.yaw = Number.isFinite(key.yaw) ? key.yaw : 0;
    player.pitch = Number.isFinite(key.pitch) ? key.pitch : 0;
    camera.position.copy(player.pos);
    camera.rotation.set(player.pitch, -player.yaw, 0, 'YXZ');
    setFov(validFov(key.fov) ? key.fov : 70);
    refreshSelection();
    save();
  }

  function replaceKey() {
    const key = currentShot()?.keys[keyIndex];
    if (!key) return setStatus('Jump to a key with U / I first, then replace it.');
    director.addKey();
    const pose = currentShot().keys.pop();
    Object.assign(key, pose);
    if (pose.roll === undefined) delete key.roll;
    changed();
  }

  function toggleNight() {
    const shot = currentShot();
    if (!shot) return;
    shot.night = shot.night !== true;
    changed();
  }

  function blurPanel() {
    const focused = document.activeElement;
    if (panel.contains(focused)) focused.blur();
  }

  function setOpen(open) {
    if (!open) {
      blurPanel();
      panel.classList.remove('is-drop-target');
    }
    panel.hidden = !open;
    if (open) refreshSelection(true);
  }

  function stopPlayback() {
    if (!playback) return;
    const { engine, fov, position, rotation, hadNoHud } = playback;
    playback = null;
    engine.stop();
    document.removeEventListener('pointerlockchange', stopOnUnlock);
    camera.position.copy(position);
    camera.quaternion.copy(rotation);
    setFov(fov);
    document.body.classList.toggle('no-hud', hadNoHud);
    readout.hidden = true;
    setOpen(true);
  }

  function stopOnUnlock() {
    if (!document.pointerLockElement) stopPlayback();
  }

  function showTime() {
    const { elapsed, duration } = playback;
    const label = `${Math.min(elapsed, duration).toFixed(1)} / ${duration.toFixed(1)} s`;
    if (readout.textContent !== label) readout.textContent = label;
  }

  function startPlayback(all) {
    const shots = (all ? director.shots : [currentShot()]).filter(shot => shot?.keys.length);
    if (!shots.length) return setStatus('Add a key before playing.');

    // Exclude empty drafts from an all-shots preview without changing the editable list.
    const engine = all && shots.length !== director.shots.length ? new Director(camera) : director;
    if (engine !== director) engine.shots = shots;
    playback = {
      engine,
      position: camera.position.clone(),
      rotation: camera.quaternion.clone(),
      fov: camera.fov,
      hadNoHud: document.body.classList.contains('no-hud'),
      duration: shots.reduce((sum, shot) => sum + seconds(shot), 0),
      elapsed: 0,
    };
    player.keys?.clear();
    setOpen(false);
    document.body.classList.add('no-hud');
    readout.hidden = false;
    showTime();
    document.addEventListener('pointerlockchange', stopOnUnlock);
    try {
      if (all) engine.playAll();
      else engine.play();
    } catch {
      stopPlayback();
      setStatus('These shots cannot be played.');
    }
  }

  function update(dt) {
    if (!playback) return false;
    const { engine, position, rotation } = playback;
    // The player has already positioned the camera for this frame.
    position.copy(camera.position);
    rotation.copy(camera.quaternion);
    if (!engine.playing) {
      stopPlayback();
      return false;
    }
    try {
      const ownsCamera = engine.update(dt);
      if (ownsCamera) {
        playback.elapsed += Number.isFinite(dt) ? Math.max(0, dt) : 0;
        showTime();
        return true;
      }
      stopPlayback();
    } catch {
      stopPlayback();
      setStatus('These shots cannot be played.');
    }
    return false;
  }

  function clearDownloads() {
    for (const link of downloads.children) {
      if (!link.hasAttribute('href')) continue;
      URL.revokeObjectURL(link.href);
      link.removeAttribute('href');
    }
    downloads.hidden = true;
  }

  function download() {
    const urls = [];
    try {
      const payloads = [director.toJSON(), director.bake(60)];
      for (const payload of payloads) {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        urls.push(URL.createObjectURL(blob));
      }
    } catch {
      for (const url of urls) URL.revokeObjectURL(url);
      return setStatus('These shots cannot be exported.');
    }
    clearDownloads();
    for (const [index, link] of [...downloads.children].entries()) link.href = urls[index];
    downloads.hidden = false;
    // Keep the links available if the browser limits consecutive automatic downloads.
    for (const link of downloads.children) link.click();
  }

  function load(data) {
    ++loadSequence;
    if (!isShotFile(data)) {
      setStatus('Could not load that file; choose a shots.json exported from here.');
      return;
    }
    stopPlayback();
    blurPanel();
    director.fromJSON(data);
    keyIndex = -1;
    list.scrollTop = 0;
    setStatus();
    changed();
  }

  const bindings = [
    ['KeyB', 'B', 'open / close this panel', () => setOpen(panel.hidden)],
    ['KeyN', 'N', 'new shot', newShot],
    ['KeyK', 'K', 'add a key at this view', addKey],
    ['Backspace', '⌫', 'delete the last key', removeKey],
    ['BracketLeft', '[', 'previous shot', () => select(director.current - 1, true)],
    ['BracketRight', ']', 'next shot', () => select(director.current + 1, true)],
    ['Minus', '−', 'half a second shorter', () => changeDuration(-0.5)],
    ['Equal', '=', 'half a second longer', () => changeDuration(0.5)],
    ['KeyL', 'L', 'change easing', cycleEasing],
    ['Comma', ',', 'narrower lens', () => changeFov(-5)],
    ['Period', '.', 'wider lens', () => changeFov(5)],
    ['KeyU', 'U', 'jump to the previous key', () => jumpKey(-1)],
    ['KeyI', 'I', 'jump to the next key', () => jumpKey(1)],
    ['KeyR', 'R', 'replace it with this view', replaceKey],
    ['KeyY', 'Y', 'night on / off', toggleNight],
    ['KeyP', 'P', 'play this shot', () => startPlayback(false)],
    ['KeyO', 'O', 'play all shots', () => startPlayback(true)],
    ['KeyX', 'X', 'stop (any key)', stopPlayback],
    ['KeyJ', 'J', 'download shots.json', download],
  ];
  bindings.push(...extras);
  const shortcuts = new Map(bindings.map(([code, , , action]) => [code, action]));
  panel.querySelector('.director-legend').append(...bindings.map(([, key, label]) => {
    const entry = document.createElement('span');
    const cap = document.createElement('kbd');
    cap.textContent = key;
    entry.append(cap, label);
    return entry;
  }));

  function handleKey(event) {
    if (playback) {
      event.preventDefault();
      stopPlayback();
      return true;
    }
    const focused = document.activeElement;
    if (!panel.hidden && panel.contains(focused) && focused.matches('input[type="text"]')) {
      if (!event.isComposing && (event.key === 'Enter' || event.key === 'Escape')) {
        event.preventDefault();
        focused.blur();
      }
      return true;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return false;
    if (panel.hidden && event.code !== 'KeyB') return false;
    const action = shortcuts.get(event.code);
    if (!action) return false;
    event.preventDefault();
    if (!event.repeat) {
      setStatus();
      action();
    }
    return true;
  }

  const rowIndex = target => Number(target.closest('[data-shot]')?.dataset.shot);
  panel.querySelector('button').addEventListener('click', () => setOpen(false));
  list.addEventListener('click', event => select(rowIndex(event.target)));
  list.addEventListener('focusin', event => {
    select(rowIndex(event.target));
    if (event.target.matches('input[type="text"]')) player.keys?.clear();
  });
  list.addEventListener('input', event => {
    if (!event.target.matches('input[type="text"]')) return;
    director.shots[rowIndex(event.target)].name = event.target.value;
    clearDownloads();
    save();
  });
  list.addEventListener('change', event => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    director.shots[rowIndex(event.target)].night = event.target.checked;
    clearDownloads();
    save();
  });
  panel.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    panel.classList.add('is-drop-target');
  });
  panel.addEventListener('dragleave', event => {
    if (!panel.contains(event.relatedTarget)) panel.classList.remove('is-drop-target');
  });
  panel.addEventListener('drop', async event => {
    event.preventDefault();
    panel.classList.remove('is-drop-target');
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    const request = ++loadSequence;
    try {
      const data = JSON.parse(await file.text());
      if (request === loadSequence) load(data);
    } catch {
      if (request === loadSequence) setStatus('That file is not valid JSON.');
    }
  });

  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isShotFile(data)) {
      director.fromJSON(data);
      if (Number.isInteger(data.current) && director.shots[data.current]) director.current = data.current;
      if (validFov(data.fov)) setFov(data.fov);
    }
  } catch {
    // Storage may be unavailable or contain an old or malformed value.
  }
  renderShots();

  return {
    handleKey,
    update,
    load,
    play: () => startPlayback(false),
    get playing() { return !!playback; },
    get shots() { return director.shots; },
    get open() { return !panel.hidden; },
  };
}
