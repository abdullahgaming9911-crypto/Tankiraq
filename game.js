import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ============================================================
   إعدادات عامة
============================================================ */
const CITY_SCALE = 0.01;          // النموذج مُصدَّر بوحدة سم تقريباً
const TANK_MODEL_URL = './tank.glb';
const CITY_MODEL_URL = './city_map.glb';

const TURN_RATE = 1.35;           // rad/s
const MAX_SPEED_FWD = 11.5;       // m/s
const MAX_SPEED_REV = 5.5;
const ACCEL = 7.5;
const DECEL = 9.5;
const TURRET_SENS = 0.0032;
const BARREL_SENS = 0.0018;
const BARREL_MIN = -0.06, BARREL_MAX = 0.28;
const SHELL_SPEED = 95;
const GRAVITY = -9.8;
const FIRE_COOLDOWN = 1.35;
const NEAR_DIST = 45;             // نطاق فحص الاصطدام والأرض
const HULL_RADIUS = 2.35;

let scoreCount = 0;

/* ============================================================
   عناصر DOM
============================================================ */
const $ = (id) => document.getElementById(id);
const loadingEl = $('loading');
const loadFill = $('loadFill');
const loadPct = $('loadPct');
const loadSub = $('loadSub');
const toastEl = $('toast');
const crosshairEl = $('crosshair');
const scoreVal = $('scoreVal');
const speedVal = $('speedVal');
const fireRing = document.querySelector('#fireBtn .ring circle');

function toast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ============================================================
   Three.js أساسيات
============================================================ */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc3de);
scene.fog = new THREE.Fog(0x9fc3de, 90, 320);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 8, -14);

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
onResize();

/* ============================================================
   إضاءة
============================================================ */
const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3a3626, 0.65);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 120;
sun.shadow.camera.left = -45;
sun.shadow.camera.right = 45;
sun.shadow.camera.top = 45;
sun.shadow.camera.bottom = -45;
sun.shadow.bias = -0.0003;
scene.add(sun);
scene.add(sun.target);

const fillLight = new THREE.DirectionalLight(0xaecbe8, 0.35);
fillLight.position.set(-30, 20, -20);
scene.add(fillLight);

/* ============================================================
   تحميل الموارد
============================================================ */
const loader = new GLTFLoader();
let cityRoot = null, tankModel = null, tankGltfAnimations = null;
const loadState = { tank: 0, city: 0, tankTotal: 1, cityTotal: 1 };

function updateLoadUI() {
  const t = loadState.tank / (loadState.tankTotal || 1);
  const c = loadState.city / (loadState.cityTotal || 1);
  const pct = Math.round(((t + c) / 2) * 100);
  loadFill.style.width = pct + '%';
  loadPct.textContent = pct + '%';
}

function loadGLB(url, onProgress) {
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => resolve(gltf), (xhr) => {
      if (xhr.lengthComputable) onProgress(xhr.loaded, xhr.total);
    }, (err) => reject(err));
  });
}

/* ============================================================
   بيانات الاصطدام (تُبنى بعد تحميل خريطة المدينة)
============================================================ */
const collisionEntries = []; // {mesh, box, center, radius, blocking}
const raycaster = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);

function buildCollisionData(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry) {
      box.setFromObject(obj);
      if (!isFinite(box.min.x) || !isFinite(box.max.x)) return;
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const radius = size.length() * 0.5;
      const height = size.y;
      collisionEntries.push({
        mesh: obj,
        box: box.clone(),
        center,
        radius,
        blocking: height > 0.45, // تجاهل تفاصيل الأرض الرقيقة عند فحص الاصطدام الأفقي
      });
    }
  });
}

function nearbyEntries(pos, dist = NEAR_DIST) {
  const d2 = dist * dist;
  const out = [];
  for (let i = 0; i < collisionEntries.length; i++) {
    const e = collisionEntries[i];
    if (e.center.distanceToSquared(pos) < d2 + e.radius * e.radius) out.push(e);
  }
  return out;
}

function groundHeightAt(pos, nearby) {
  raycaster.set(new THREE.Vector3(pos.x, pos.y + 40, pos.z), DOWN);
  raycaster.far = 200;
  const meshes = nearby.map((e) => e.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length) return hits[0].point.y;
  return 0;
}

function resolveCircleCollision(pos, radius, nearby) {
  const out = pos.clone();
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < nearby.length; i++) {
      const e = nearby[i];
      if (!e.blocking) continue;
      const b = e.box;
      const cx = Math.max(b.min.x, Math.min(out.x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(out.z, b.max.z));
      // تجاهل الأسطح المنخفضة جداً (أرصفة) لعدم عرقلة الحركة
      if (b.min.y > pos.y + 2.2) continue;
      const dx = out.x - cx, dz = out.z - cz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < radius && dist > 1e-5) {
        const push = (radius - dist);
        out.x += (dx / dist) * push;
        out.z += (dz / dist) * push;
      } else if (dist <= 1e-5) {
        out.x += radius; // حالة نادرة: المركز داخل الصندوق تماماً
      }
    }
  }
  return out;
}

/* ============================================================
   الدبابة
============================================================ */
const tankGroup = new THREE.Object3D();
scene.add(tankGroup);
let turretNode = null, mantleNode = null;
const wheelNodes = [];
let hullYaw = 0, turretYaw = 0, barrelPitch = 0.05;
let speed = 0;
let groundY = 0;
const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();

function forwardVector(yaw, out) {
  out.set(Math.sin(yaw), 0, Math.cos(yaw));
  return out;
}

function setupTank(gltf) {
  tankModel = gltf.scene;
  tankModel.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    if (/^Turret_low/.test(o.name)) turretNode = o;
    if (/^Mantle_/.test(o.name)) mantleNode = o;
    if (/^(Sprocket|Roadwheel_low|Upper Wheel_low)/.test(o.name)) wheelNodes.push(o);
  });
  const box = new THREE.Box3().setFromObject(tankModel);
  const bottomOffset = -box.min.y;
  tankModel.position.y = bottomOffset;
  tankGroup.add(tankModel);
  tankGroup.position.set(0, 0, 0);
}

/* ============================================================
   الأهداف (Targets)
============================================================ */
const targets = [];
const targetTexture = makeTargetTexture();

function makeTargetTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2ede0';
  ctx.fillRect(0, 0, 256, 256);
  const rings = [[118, '#c0432f'], [92, '#f2ede0'], [66, '#c0432f'], [40, '#f2ede0'], [16, '#c0432f']];
  for (const [r, col] of rings) {
    ctx.beginPath();
    ctx.arc(128, 128, r, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createTargetMesh() {
  const grp = new THREE.Group();
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.09, 2.1, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3a38, roughness: 0.8 });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = 1.05;
  pole.castShadow = true;
  grp.add(pole);

  const boardGeo = new THREE.CircleGeometry(0.85, 24);
  const boardMat = new THREE.MeshStandardMaterial({ map: targetTexture, roughness: 0.6, side: THREE.DoubleSide });
  const board = new THREE.Mesh(boardGeo, boardMat);
  board.position.y = 2.15;
  board.castShadow = true;
  board.userData.isBoard = true;
  grp.add(board);

  return grp;
}

function randomPointNear(cx, cz, minR, maxR) {
  const a = Math.random() * Math.PI * 2;
  const r = minR + Math.random() * (maxR - minR);
  return new THREE.Vector3(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r);
}

function spawnTarget(pos) {
  const mesh = createTargetMesh();
  const nearby = nearbyEntries(pos, 12);
  const gY = groundHeightAt(pos, nearby);
  mesh.position.set(pos.x, gY, pos.z);
  scene.add(mesh);
  const rec = { mesh, pos: mesh.position.clone(), alive: true, radius: 1.3 };
  targets.push(rec);
  return rec;
}

function trySpawnTargetsAround(center, count) {
  let placed = 0, attempts = 0;
  while (placed < count && attempts < count * 12) {
    attempts++;
    const p = randomPointNear(center.x, center.z, 16, 55);
    const nearby = nearbyEntries(p, 3);
    let blocked = false;
    for (const e of nearby) {
      if (e.blocking && e.box.containsPoint(new THREE.Vector3(p.x, e.box.min.y + 0.2, p.z))) { blocked = true; break; }
    }
    if (blocked) continue;
    spawnTarget(p);
    placed++;
  }
}

function respawnTarget(rec) {
  const p = randomPointNear(tankGroup.position.x, tankGroup.position.z, 20, 60);
  const nearby = nearbyEntries(p, 12);
  const gY = groundHeightAt(p, nearby);
  rec.mesh.position.set(p.x, gY, p.z);
  rec.pos.copy(rec.mesh.position);
  rec.mesh.visible = true;
  rec.alive = true;
}

/* ============================================================
   المقذوفات والانفجارات
============================================================ */
const shellGeo = new THREE.SphereGeometry(0.16, 10, 10);
const shellMat = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff7a1a, emissiveIntensity: 1.6, roughness: 0.3 });
const shells = [];
let fireCooldownLeft = 0;

const muzzleLight = new THREE.PointLight(0xffb347, 0, 18, 2);
scene.add(muzzleLight);
let muzzleLightT = 0;

function getMuzzleWorld(out) {
  const src = mantleNode || turretNode || tankGroup;
  src.getWorldPosition(out);
  const totalYaw = hullYaw + turretYaw;
  const fx = Math.sin(totalYaw) * Math.cos(barrelPitch);
  const fz = Math.cos(totalYaw) * Math.cos(barrelPitch);
  const fy = Math.sin(barrelPitch);
  out.x += fx * 6.0; out.y += fy * 6.0 + 0.15; out.z += fz * 6.0;
  return new THREE.Vector3(fx, fy, fz);
}

function fireShell() {
  if (fireCooldownLeft > 0) return;
  fireCooldownLeft = FIRE_COOLDOWN;
  const pos = new THREE.Vector3();
  const dir = getMuzzleWorld(pos);
  const mesh = new THREE.Mesh(shellGeo, shellMat);
  mesh.position.copy(pos);
  mesh.castShadow = true;
  scene.add(mesh);
  shells.push({ mesh, vel: dir.clone().multiplyScalar(SHELL_SPEED), life: 4.5 });
  muzzleLight.position.copy(pos);
  muzzleLightT = 0.09;
  playFireSound();
  tankGroup.userData.recoil = 0.18;
}

function spawnHitEffect(pos) {
  const grp = new THREE.Group();
  const n = 10;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const g = new THREE.SphereGeometry(0.1 + Math.random() * 0.08, 5, 5);
    const m = new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0xffa93f : 0x552211, transparent: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(pos);
    const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2;
    const spd = 3 + Math.random() * 4;
    parts.push({ mesh, vel: new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e) + 0.6, Math.sin(a) * Math.cos(e)).multiplyScalar(spd) });
    grp.add(mesh);
  }
  scene.add(grp);
  playHitSound();
  return { grp, parts, life: 0.7, t: 0 };
}
const hitEffects = [];

function updateShells(dt) {
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i];
    s.vel.y += GRAVITY * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    s.life -= dt;
    let dead = s.life <= 0 || s.mesh.position.y < -5;

    if (!dead) {
      for (const t of targets) {
        if (!t.alive) continue;
        const dy = s.mesh.position.y - (t.mesh.position.y + 1.1);
        const dx = s.mesh.position.x - t.mesh.position.x;
        const dz = s.mesh.position.z - t.mesh.position.z;
        if (dx * dx + dy * dy + dz * dz < 1.6 * 1.6) {
          t.alive = false;
          t.mesh.visible = false;
          hitEffects.push(spawnHitEffect(s.mesh.position.clone()));
          scoreCount += 10;
          scoreVal.textContent = scoreCount;
          toast('إصابة مباشرة! +10');
          setTimeout(() => respawnTarget(t), 2600);
          dead = true;
          break;
        }
      }
    }
    if (!dead) {
      const nearby = nearbyEntries(s.mesh.position, 8);
      for (const e of nearby) {
        if (!e.blocking) continue;
        if (e.box.containsPoint(s.mesh.position)) { dead = true; hitEffects.push(spawnHitEffect(s.mesh.position.clone())); break; }
      }
    }
    if (dead) { scene.remove(s.mesh); shells.splice(i, 1); }
  }

  for (let i = hitEffects.length - 1; i >= 0; i--) {
    const fx = hitEffects[i];
    fx.t += dt;
    const k = fx.t / fx.life;
    for (const p of fx.parts) {
      p.vel.y += GRAVITY * 0.5 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.material.opacity = Math.max(0, 1 - k);
      p.mesh.scale.setScalar(1 - k * 0.6);
    }
    if (fx.t >= fx.life) { scene.remove(fx.grp); hitEffects.splice(i, 1); }
  }
}

/* ============================================================
   الصوت (Web Audio تركيبي)
============================================================ */
let actx = null;
function ensureAudio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
}
let noiseBuffer = null;
function getNoiseBuffer() {
  if (noiseBuffer) return noiseBuffer;
  const len = actx.sampleRate * 0.6;
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}
function playFireSound() {
  if (!actx) return;
  const t0 = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = getNoiseBuffer();
  const bp = actx.createBiquadFilter();
  bp.type = 'lowpass'; bp.frequency.value = 900;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.9, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
  src.connect(bp).connect(g).connect(actx.destination);
  src.start(t0); src.stop(t0 + 0.4);

  const osc = actx.createOscillator();
  osc.type = 'triangle'; osc.frequency.setValueAtTime(85, t0);
  osc.frequency.exponentialRampToValueAtTime(35, t0 + 0.25);
  const og = actx.createGain();
  og.gain.setValueAtTime(0.8, t0);
  og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
  osc.connect(og).connect(actx.destination);
  osc.start(t0); osc.stop(t0 + 0.3);
}
function playHitSound() {
  if (!actx) return;
  const t0 = actx.currentTime;
  const src = actx.createBufferSource();
  src.buffer = getNoiseBuffer();
  const bp = actx.createBiquadFilter();
  bp.type = 'lowpass'; bp.frequency.value = 500;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.7, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
  src.connect(bp).connect(g).connect(actx.destination);
  src.start(t0); src.stop(t0 + 0.55);
}
let engineOsc = null, engineGain = null, engineFilter = null;
function startEngine() {
  if (engineOsc) return;
  ensureAudio();
  engineOsc = actx.createOscillator();
  engineOsc.type = 'sawtooth';
  engineFilter = actx.createBiquadFilter();
  engineFilter.type = 'lowpass'; engineFilter.frequency.value = 220;
  engineGain = actx.createGain();
  engineGain.gain.value = 0.0;
  engineOsc.connect(engineFilter).connect(engineGain).connect(actx.destination);
  engineOsc.frequency.value = 40;
  engineOsc.start();
}
function updateEngine(speedRatio, throttle) {
  if (!engineOsc) return;
  const targetFreq = 38 + Math.abs(speedRatio) * 55;
  engineOsc.frequency.value += (targetFreq - engineOsc.frequency.value) * 0.08;
  const targetGain = 0.05 + Math.min(1, Math.abs(throttle) * 0.6 + Math.abs(speedRatio) * 0.5) * 0.09;
  engineGain.gain.value += (targetGain - engineGain.gain.value) * 0.08;
}

/* ============================================================
   المدخلات: عصا التحكم + الأزرار
============================================================ */
const input = { steer: 0, throttle: 0, aiming: false, zoomLevel: 0 };
const ZOOM_FOVS = [1, 0.62, 0.36];

function setupJoystick() {
  const base = $('joyBase');
  const stick = $('joyStick');
  let active = false, pointerId = null, cx = 0, cy = 0, radius = 60;

  function start(e) {
    if (editMode) return;
    active = true; pointerId = e.pointerId;
    const r = base.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2; radius = r.width / 2;
    base.setPointerCapture(pointerId);
    move(e);
    ensureAudio(); startEngine();
  }
  function move(e) {
    if (!active || e.pointerId !== pointerId) return;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > radius) { dx = (dx / d) * radius; dy = (dy / d) * radius; }
    stick.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = dx / radius, ny = dy / radius;
    input.steer = Math.abs(nx) > 0.08 ? nx : 0;
    input.throttle = Math.abs(ny) > 0.08 ? -ny : 0;
  }
  function end(e) {
    if (e.pointerId !== pointerId) return;
    active = false; pointerId = null;
    stick.style.transform = 'translate(0,0)';
    input.steer = 0; input.throttle = 0;
  }
  base.addEventListener('pointerdown', start);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function setupActionButtons() {
  const fireBtn = $('fireBtn'), aimBtn = $('aimBtn'), zoomBtn = $('zoomBtn');

  fireBtn.addEventListener('pointerdown', (e) => {
    if (editMode) return;
    e.preventDefault();
    ensureAudio();
    fireShell();
  });

  aimBtn.addEventListener('pointerdown', (e) => {
    if (editMode) return;
    e.preventDefault();
    input.aiming = !input.aiming;
    aimBtn.classList.toggle('active', input.aiming);
    crosshairEl.classList.toggle('active', input.aiming);
  });

  zoomBtn.addEventListener('pointerdown', (e) => {
    if (editMode) return;
    e.preventDefault();
    input.zoomLevel = (input.zoomLevel + 1) % ZOOM_FOVS.length;
    zoomBtn.classList.toggle('active', input.zoomLevel > 0);
  });

  // سحب على الشاشة لتوجيه البرج والمدفع أثناء التصويب
  let dragging = false, lastX = 0, lastY = 0, dragId = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!input.aiming || editMode) return;
    dragging = true; dragId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragId) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    turretYaw -= dx * TURRET_SENS;
    barrelPitch = Math.max(BARREL_MIN, Math.min(BARREL_MAX, barrelPitch + dy * BARREL_SENS));
  });
  window.addEventListener('pointerup', (e) => { if (e.pointerId === dragId) dragging = false; });
}

/* ============================================================
   وضع تحرير الأزرار (الإعدادات)
============================================================ */
let editMode = false;
const CONTROL_IDS = {
  joy: 'joyBase', fire: 'fireBtn', aim: 'aimBtn', zoom: 'zoomBtn',
};
const DEFAULTS = {}; // يُملأ عند أول تشغيل من موضع CSS الافتراضي

function captureDefaults() {
  for (const key in CONTROL_IDS) {
    const el = $(CONTROL_IDS[key]);
    const r = el.getBoundingClientRect();
    DEFAULTS[key] = { left: r.left, top: r.top, size: 1, opacity: 1 };
  }
}

function applyControlStyle(key, { left, top, size, opacity }) {
  const el = $(CONTROL_IDS[key]);
  if (left != null) { el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; }
  el.style.transform = `scale(${size})`;
  el.style.opacity = opacity;
}

const controlState = {};
function initControlState() {
  for (const key in CONTROL_IDS) controlState[key] = { left: null, top: null, size: 1, opacity: 1 };
}

function setupSettingsPanel() {
  const gearBtn = $('gearBtn');
  const overlay = $('settingsOverlay');
  const closeBtn = $('closeSettings');
  const editToggle = $('editModeToggle');
  const resetBtn = $('resetBtn');

  gearBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); overlay.classList.add('open'); });
  closeBtn.addEventListener('pointerdown', () => overlay.classList.remove('open'));
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });

  editToggle.addEventListener('change', () => {
    editMode = editToggle.checked;
    for (const key in CONTROL_IDS) {
      $(CONTROL_IDS[key]).classList.toggle('editing', editMode);
    }
    toast(editMode ? 'اسحب أي زر لتغيير مكانه' : 'تم قفل مواقع الأزرار');
  });

  for (const key of Object.keys(CONTROL_IDS)) {
    const sizeSlider = $(`s_${key}_size`);
    const opSlider = $(`s_${key}_op`);
    const sizeVal = $(`v_${key}_size`);
    const opVal = $(`v_${key}_op`);
    sizeSlider.value = controlState[key].size;
    opSlider.value = controlState[key].opacity;
    sizeVal.textContent = Number(sizeSlider.value).toFixed(2) + 'x';
    opVal.textContent = Math.round(opSlider.value * 100) + '%';

    sizeSlider.addEventListener('input', () => {
      controlState[key].size = parseFloat(sizeSlider.value);
      sizeVal.textContent = controlState[key].size.toFixed(2) + 'x';
      applyControlStyle(key, controlState[key]);
    });
    opSlider.addEventListener('input', () => {
      controlState[key].opacity = parseFloat(opSlider.value);
      opVal.textContent = Math.round(controlState[key].opacity * 100) + '%';
      applyControlStyle(key, controlState[key]);
    });
  }

  resetBtn.addEventListener('pointerdown', () => {
    for (const key in CONTROL_IDS) {
      const el = $(CONTROL_IDS[key]);
      el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = '';
      el.style.transform = ''; el.style.opacity = '';
      controlState[key] = { left: null, top: null, size: 1, opacity: 1 };
      $(`s_${key}_size`).value = 1;
      $(`s_${key}_op`).value = 1;
      $(`v_${key}_size`).textContent = '1.00x';
      $(`v_${key}_op`).textContent = '100%';
    }
    // إعادة تطبيق مواقع CSS الافتراضية عبر إزالة الأنماط المضمّنة (تمت أعلاه)
    toast('تمت إعادة ضبط جميع الأزرار');
  });

  // سحب الأزرار عند تفعيل وضع التحرير
  for (const key in CONTROL_IDS) {
    const el = $(CONTROL_IDS[key]);
    let dragging = false, pid = null, offX = 0, offY = 0;
    el.addEventListener('pointerdown', (e) => {
      if (!editMode) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true; pid = e.pointerId;
      const r = el.getBoundingClientRect();
      offX = e.clientX - r.left; offY = e.clientY - r.top;
      el.setPointerCapture(pid);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pid) return;
      const w = el.offsetWidth * controlState[key].size;
      const h = el.offsetHeight * controlState[key].size;
      let left = e.clientX - offX, top = e.clientY - offY;
      left = Math.max(4, Math.min(window.innerWidth - w - 4, left));
      top = Math.max(4, Math.min(window.innerHeight - h - 4, top));
      controlState[key].left = left; controlState[key].top = top;
      applyControlStyle(key, controlState[key]);
    });
    el.addEventListener('pointerup', (e) => { if (e.pointerId === pid) dragging = false; });
  }
}

/* ============================================================
   الكاميرا
============================================================ */
const camPos = new THREE.Vector3(0, 8, -14);
const camLook = new THREE.Vector3();

function updateCamera(dt) {
  const fwd = forwardVector(hullYaw, tmpVec);
  const aimFwd = forwardVector(hullYaw + turretYaw, tmpVec2);
  let dist, height, lookHeight, lookAhead;
  if (input.aiming) {
    dist = 6.5; height = 3.3; lookHeight = 2.0; lookAhead = 14;
  } else {
    dist = 11.5; height = 5.2; lookHeight = 1.6; lookAhead = 6;
  }
  const dirForCam = input.aiming ? aimFwd : fwd;
  const desired = tankGroup.position.clone()
    .addScaledVector(dirForCam, -dist)
    .add(new THREE.Vector3(0, height, 0));
  camPos.lerp(desired, 1 - Math.pow(0.0005, dt));
  const lookTarget = tankGroup.position.clone()
    .addScaledVector(dirForCam, lookAhead)
    .add(new THREE.Vector3(0, lookHeight, 0));
  camLook.lerp(lookTarget, 1 - Math.pow(0.0008, dt));
  camera.position.copy(camPos);
  camera.lookAt(camLook);

  const baseFov = input.aiming ? 38 : 55;
  const targetFov = baseFov * ZOOM_FOVS[input.zoomLevel];
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6);
  camera.updateProjectionMatrix();
}

/* ============================================================
   حلقة التحديث الرئيسية
============================================================ */
const clock = new THREE.Clock();
let lastNearby = [];
let nearbyTimer = 0;

function updateTank(dt) {
  hullYaw += input.steer * TURN_RATE * dt;
  const targetSpeed = input.throttle >= 0 ? input.throttle * MAX_SPEED_FWD : input.throttle * MAX_SPEED_REV;
  const rate = Math.abs(targetSpeed) > Math.abs(speed) ? ACCEL : DECEL;
  speed += Math.sign(targetSpeed - speed) * Math.min(Math.abs(targetSpeed - speed), rate * dt);
  if (Math.abs(input.throttle) < 0.01 && Math.abs(speed) < 0.05) speed = 0;

  const fwd = forwardVector(hullYaw, tmpVec);
  const proposed = tankGroup.position.clone().addScaledVector(fwd, speed * dt);

  nearbyTimer -= dt;
  if (nearbyTimer <= 0) { lastNearby = nearbyEntries(tankGroup.position); nearbyTimer = 0.15; }

  const resolvedFront = resolveCircleCollision(
    proposed.clone().addScaledVector(fwd, 1.6), HULL_RADIUS, lastNearby
  ).addScaledVector(fwd, -1.6);
  const resolved = resolveCircleCollision(resolvedFront, HULL_RADIUS, lastNearby);

  const gY = groundHeightAt(resolved, lastNearby);
  groundY += (gY - groundY) * Math.min(1, dt * 10);

  tankGroup.position.set(resolved.x, groundY, resolved.z);
  tankGroup.rotation.y = hullYaw;

  if (turretNode) turretNode.rotation.y = turretYaw;
  if (mantleNode) mantleNode.rotation.x = -barrelPitch;

  const wheelSpin = (speed * dt) / 0.42;
  for (const w of wheelNodes) w.rotation.x += wheelSpin;

  tankGroup.updateMatrixWorld(true);

  speedVal.textContent = Math.round(Math.abs(speed) * 3.6);
  updateEngine(speed / MAX_SPEED_FWD, input.throttle);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  updateTank(dt);
  updateShells(dt);
  updateCamera(dt);

  if (fireCooldownLeft > 0) {
    fireCooldownLeft = Math.max(0, fireCooldownLeft - dt);
    const frac = 1 - fireCooldownLeft / FIRE_COOLDOWN;
    if (fireRing) fireRing.style.strokeDashoffset = String(226 * (1 - frac));
  }
  if (muzzleLightT > 0) {
    muzzleLightT -= dt;
    muzzleLight.intensity = Math.max(0, muzzleLightT / 0.09) * 6;
  }

  sun.position.copy(tankGroup.position).add(new THREE.Vector3(35, 55, -20));
  sun.target.position.copy(tankGroup.position);
  sun.target.updateMatrixWorld();

  renderer.render(scene, camera);
}

/* ============================================================
   بدء التشغيل
============================================================ */
async function boot() {
  initControlState();
  setupJoystick();
  setupActionButtons();
  setupSettingsPanel();

  try {
    loadSub.textContent = 'تحميل الدبابة…';
    const tankGltf = await loadGLB(TANK_MODEL_URL, (l, t) => { loadState.tank = l; loadState.tankTotal = t; updateLoadUI(); });
    setupTank(tankGltf);

    loadSub.textContent = 'تحميل خريطة المدينة…';
    const cityGltf = await loadGLB(CITY_MODEL_URL, (l, t) => { loadState.city = l; loadState.cityTotal = t; updateLoadUI(); });
    cityRoot = cityGltf.scene;
    cityRoot.scale.setScalar(CITY_SCALE);
    cityRoot.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (o.material) {
          o.material.side = THREE.FrontSide;
        }
      }
    });
    scene.add(cityRoot);

    loadSub.textContent = 'تجهيز نظام الاصطدام والأرضية…';
    await new Promise((r) => setTimeout(r, 30));
    buildCollisionData(cityRoot);

    const startGround = groundHeightAt(new THREE.Vector3(0, 0, 0), nearbyEntries(new THREE.Vector3(0, 0, 0)));
    groundY = startGround;
    tankGroup.position.set(0, groundY, 0);
    tankGroup.updateMatrixWorld(true);

    trySpawnTargetsAround(tankGroup.position, 8);

    captureDefaults();

    loadFill.style.width = '100%';
    loadPct.textContent = '100%';
    setTimeout(() => {
      loadingEl.classList.add('hidden');
      toast('اسحب العصا للحركة، واضغط زر التصويب لتوجيه البرج 🎯', 3200);
    }, 250);

    animate();
  } catch (err) {
    console.error(err);
    loadSub.textContent = 'حدث خطأ أثناء تحميل النماذج. تأكد أن كل الملفات (game.js, tank.glb, city_map.glb) في نفس المجلد وأن الصفحة تُفتح عبر خادم محلي.';
  }
}

boot();
