import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/DRACOLoader.js';
import { MUSC, EX, GROUPS, REGION_CAM, SH_ZONES, SH_REDFLAGS, RLABEL } from './data.js';

// ---------- 颜色（与 CSS 变量对应，供 3D 用固定值）----------
const ROLE_COLOR = { primary:0xd6392f, synergist:0xe08a3c, stabilizer:0xd8b23f };
const MUSCLE_BASE = 0x9a5b52;   // 静息肌肉色（暖玫瑰）
const MUSCLE_DIM  = 0x7d574f;   // 非选中时更暗
const BONE_COLOR  = 0xd9cbb2;

// ---------- 全局 ----------
let scene, camera, renderer, controls, raycaster, pointer;
let modelRoot, modelBox = new THREE.Box3(), modelCenter = new THREE.Vector3(), modelSize = new THREE.Vector3();
let muscleMeshes = [];          // {mesh, groupId, rest:Float32Array, center:THREE.Vector3, along:THREE.Vector3}
let boneMeshes = [];
let groupIndex = {};            // groupId -> [record,...]
let baseMuscleMat, boneMat;
let curEx = null, curZone = null, curModule = 'ex';
let active = null;              // {records:[{rec,role}], t, playing, dir}
let showBones = false, showDeep = false;
let camGoal = null;             // {pos:Vector3, target:Vector3}
const clock = new THREE.Clock();
let orientFront = new THREE.Vector3(0, 0, 1); // 载入后校准

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

init();

function init(){
  scene = new THREE.Scene();
  scene.background = new THREE.Color(getStageBG());

  camera = new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.01, 100);
  camera.position.set(0, 0.2, 2.4);

  renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  $('#stage').appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4038, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(2, 3, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfd8ff, 0.7); rim.position.set(-3, 1, -3); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffe6c0, 0.5); fill.position.set(0, -2, 2); scene.add(fill);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 0.4; controls.maxDistance = 8; controls.enablePan = true;

  raycaster = new THREE.Raycaster(); pointer = new THREE.Vector2();

  addEventListener('resize', onResize);
  renderer.domElement.addEventListener('click', onClick);
  renderer.domElement.addEventListener('pointerdown', ()=>{ controls.userInteracting = true; camGoal = null; });

  buildUI();
  loadModel();
  animate();
}

function getStageBG(){
  return getComputedStyle(document.documentElement).getPropertyValue('--stage').trim() || '#14120f';
}

// ============================================================== LOAD =========
function loadModel(){
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('./libs/draco/');
  loader.setDRACOLoader(draco);
  baseMuscleMat = new THREE.MeshStandardMaterial({ color:MUSCLE_BASE, roughness:0.72, metalness:0.02 });
  boneMat = new THREE.MeshStandardMaterial({ color:BONE_COLOR, roughness:0.9, metalness:0, transparent:true, opacity:0.28, depthWrite:false });

  loader.load('./body.glb', (gltf)=>{
    modelRoot = gltf.scene;
    scene.add(modelRoot);

    modelRoot.traverse(ch=>{
      if(!ch.isMesh) return;
      const nodeName = (ch.name || '').toLowerCase();
      const type = ch.userData?.type || guessType(nodeName);
      if(type === 'muscle'){
        const gid = matchGroup(nodeName);
        ch.material = baseMuscleMat;
        ch.userData._gid = gid;
        const rec = prepMuscle(ch, gid);
        muscleMeshes.push(rec);
        if(gid){ (groupIndex[gid] ||= []).push(rec); }
      } else if(type === 'bone'){
        ch.material = boneMat; ch.visible = showBones; boneMeshes.push(ch);
      } else {
        ch.visible = false; // 其它结构（腱/软骨等）默认隐藏，保持肌肉清晰
      }
    });

    // 居中 + 计算尺寸
    modelBox.setFromObject(modelRoot);
    modelBox.getCenter(modelCenter); modelBox.getSize(modelSize);
    modelRoot.position.sub(modelCenter);
    modelBox.setFromObject(modelRoot);
    modelBox.getCenter(modelCenter); modelBox.getSize(modelSize);

    calibrateOrientation();
    fitCamera('full','front', false);
    $('#loading').style.display = 'none';
    // 默认选中一个动作
    selectEx('bench');
  },
  (p)=>{ if(p.total){ $('#loadpct').textContent = Math.round(p.loaded/p.total*100)+'%'; } },
  (err)=>{ console.error(err); $('#loadpct').textContent = '加载失败'; });
}

function guessType(n){
  if(/muscle|deltoid|trapezius|pectoralis|biceps|triceps|latissimus|gluteus|quadriceps|gastrocnemius|oblique|abdominis|supraspinatus|infraspinatus|subscapularis|teres|rhomboid|serratus|erector|iliocostalis|longissimus|spinalis|adductor|soleus|tibialis|brachialis|brachioradialis|flexor|extensor|sartorius|semitendinosus|semimembranosus/.test(n)) return 'muscle';
  return 'other';
}

function matchGroup(nodeName){
  // GLTFLoader 会把空格→下划线、去掉点号，这里归一化回空格再匹配
  const n = nodeName.replace(/_/g, ' ');
  for(const gid in MUSC){
    for(const frag of MUSC[gid].match){ if(n.includes(frag)) return gid; }
  }
  return null;
}

// 预处理肌肉网格：记录静息顶点、局部长轴、中心，用于收缩形变
function prepMuscle(mesh, gid){
  const geom = mesh.geometry;
  if(!geom.boundingBox) geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const center = new THREE.Vector3(); bb.getCenter(center);
  const size = new THREE.Vector3(); bb.getSize(size);
  // 长轴 = 局部包围盒最长维度
  let along = new THREE.Vector3(1,0,0);
  if(size.y >= size.x && size.y >= size.z) along.set(0,1,0);
  else if(size.z >= size.x && size.z >= size.y) along.set(0,0,1);
  const pos = geom.attributes.position;
  const rest = new Float32Array(pos.array); // 拷贝静息态
  return { mesh, groupId:gid, rest, center, along, deforming:false };
}

// 校准朝向：脸/胸在 +Z 还是 -Z。用胸大肌相对模型中心的 z 判断
function calibrateOrientation(){
  // 用几何中心（局部即绝对，模型为恒等变换）而非物体原点
  const recs = groupIndex['pec'] || [];
  if(!recs.length) return;
  const avg = a => a.reduce((s,x)=>s+x,0)/(a.length||1);
  const pecZ = avg(recs.map(r=>r.center.z));
  const allZ = avg(muscleMeshes.map(r=>r.center.z));
  orientFront.set(0, 0, pecZ >= allZ ? 1 : -1);
}

// ============================================================== HIGHLIGHT ====
function clearActive(){
  muscleMeshes.forEach(r=>{
    r.deforming = false;
    restoreGeom(r);
    if(r.mesh.material !== baseMuscleMat && r.mesh.material !== boneMat){
      r.mesh.material.dispose?.();
    }
    r.mesh.material = baseMuscleMat;
    r.mesh.visible = true;
  });
  active = null;
}

function restoreGeom(r){
  const pos = r.mesh.geometry.attributes.position;
  if(pos.array.length === r.rest.length){ pos.array.set(r.rest); pos.needsUpdate = true; r.mesh.geometry.computeVertexNormals(); }
}

function applyRoles(roleMap){ // roleMap: gid -> role
  // 未参与的肌肉调暗；若高亮含深层肌肉，则把非活动肌肉变半透明让深层可见
  const anyRole = Object.keys(roleMap).length>0;
  const hasDeep = Object.keys(roleMap).some(g=> MUSC[g]?.deep);
  const dim = hasDeep
    ? new THREE.MeshStandardMaterial({ color:MUSCLE_DIM, roughness:0.82, metalness:0, transparent:true, opacity:0.16, depthWrite:false })
    : new THREE.MeshStandardMaterial({ color:anyRole?MUSCLE_DIM:MUSCLE_BASE, roughness:0.82, metalness:0 });
  const recs = [];
  muscleMeshes.forEach(r=>{
    const role = roleMap[r.groupId];
    if(role){
      const col = ROLE_COLOR[role];
      const mat = new THREE.MeshStandardMaterial({ color:col, roughness:0.55, metalness:0.05, emissive:col, emissiveIntensity:0.12 });
      r.mesh.material = mat; r.mesh.visible = true; r.deforming = true; r.role = role;
      recs.push(r);
    } else {
      r.mesh.material = dim; r.mesh.visible = true; r.deforming = false; r.role = null;
      restoreGeom(r);
    }
  });
  active = { records:recs, t:0, dir:1, playing:true };
}

const ROLE_AMP = { primary:1.0, synergist:0.6, stabilizer:0.32 };

function updateDeform(dt){
  if(!active) return;
  if(active.playing){
    const speed = 0.5;
    active.t += active.dir * dt * speed;
    if(active.t >= 1){ active.t = 1; active.dir = -1; }
    else if(active.t <= 0){ active.t = 0; active.dir = 1; }
  }
  const tri = active.t;                 // 0..1 三角波
  const act = easeInOut(tri);
  const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _perp = new THREE.Vector3();
  active.records.forEach(r=>{
    const amp = ROLE_AMP[r.role] || 0.4;
    const a = act * amp;
    const K = 0.20 * a;   // 沿长轴缩短
    const T = 0.16 * a;   // 垂直增粗
    const pos = r.mesh.geometry.attributes.position;
    if(pos.array.length !== r.rest.length) return;
    const arr = pos.array, rest = r.rest, c = r.center, ax = r.along;
    for(let i=0;i<arr.length;i+=3){
      _p.set(rest[i]-c.x, rest[i+1]-c.y, rest[i+2]-c.z);
      const comp = _p.dot(ax);
      _perp.copy(_p).addScaledVector(ax, -comp);
      // 收缩：沿轴分量缩短、垂直分量放大
      _v.copy(ax).multiplyScalar(comp*(1-K)).add(_perp.multiplyScalar(1+T));
      arr[i]   = c.x + _v.x;
      arr[i+1] = c.y + _v.y;
      arr[i+2] = c.z + _v.z;
    }
    pos.needsUpdate = true;
    r.mesh.geometry.computeVertexNormals();
    // 发光脉冲
    if(r.mesh.material.emissive){ r.mesh.material.emissiveIntensity = 0.12 + 0.55*a; }
  });
  // 相位文字
  const concentric = active.dir > 0;
  const pill = $('#phasePill'), breath = $('#breathTxt');
  if(pill && curEx){
    pill.textContent = concentric ? '向心 · 收缩' : '离心 · 拉长';
    pill.className = 'phase-pill ' + (concentric ? 'con' : 'ecc');
    breath.textContent = concentric ? curEx.cyc.c : curEx.cyc.e;
  }
}
function easeInOut(t){ return t<0.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2; }

// ============================================================== SELECT =======
function selectEx(id){
  curEx = EX.find(e=>e.id===id); curZone = null;
  if(!curEx) return;
  clearActive();
  const roleMap = {}; curEx.m.forEach(([gid,role])=> roleMap[gid]=role);
  // 若涉及深层肌肉自动开启深层视角（这里主要用于相机与提示）
  applyRoles(roleMap);
  const cam = REGION_CAM[curEx.cam] || REGION_CAM.full;
  fitCamera(cam.part, cam.view, true);
  renderExDetail();
  markListSelection();
}

function selectZone(id){
  curZone = SH_ZONES.find(z=>z.id===id); if(!curZone) return;
  curEx = null;
  clearActive();
  const roleMap = {};
  curZone.highlight.forEach((gid,i)=> roleMap[gid] = i===0 ? 'primary' : 'synergist');
  applyRoles(roleMap);
  // 肩部聚焦
  const back = curZone.highlight.some(g=> (MUSC[g]?.region||'').includes('B') || ['deltP','infra','teres','rhom','levscap','teresMaj'].includes(g));
  fitCamera('upper', back?'back':'front', true);
  renderZoneDetail();
  $$('.zone-btn').forEach(b=> b.setAttribute('aria-pressed', b.dataset.z===id));
}

// ============================================================== CAMERA =======
function fitCamera(part, view, animate){
  const s = Math.max(modelSize.x, modelSize.y, modelSize.z);
  const h = modelSize.y;
  let targetY = 0, dist = s*1.15;
  if(part==='upper'){ targetY = h*0.18; dist = s*0.62; }
  else if(part==='lower'){ targetY = -h*0.22; dist = s*0.6; }
  else { targetY = 0; dist = s*0.78; }
  const dir = orientFront.clone().multiplyScalar(view==='back'?-1:1);
  const pos = new THREE.Vector3(0, targetY, 0).addScaledVector(dir, dist);
  pos.y += h*0.04;
  const target = new THREE.Vector3(0, targetY, 0);
  if(animate){ camGoal = { pos, target }; }
  else { camera.position.copy(pos); controls.target.copy(target); controls.update(); }
}
$('#btnFront')?.addEventListener('click', ()=> fitCamera(curPart(), 'front', true));
$('#btnBack')?.addEventListener('click', ()=> fitCamera(curPart(), 'back', true));
$('#btnReset')?.addEventListener('click', ()=> fitCamera('full','front', true));
function curPart(){ const c = curEx? REGION_CAM[curEx.cam] : (curZone? {part:'upper'}:null); return c? c.part : 'full'; }

// ============================================================== RAYCAST ======
function onClick(e){
  if(controls.userInteracting){ controls.userInteracting = false; }
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX-rect.left)/rect.width)*2-1;
  pointer.y = -((e.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer, camera);
  const targets = muscleMeshes.filter(r=>r.mesh.visible).map(r=>r.mesh);
  const hits = raycaster.intersectObjects(targets, false);
  if(hits.length){
    const gid = hits[0].object.userData._gid;
    if(gid) showMuscleInfo(gid);
  }
}

// ============================================================== UI ===========
function buildUI(){
  // tabs
  $$('.tab').forEach(t=> t.addEventListener('click', ()=>{
    curModule = t.dataset.mod;
    $$('.tab').forEach(x=> x.setAttribute('aria-selected', x===t));
    $('#panelEx').classList.toggle('hidden', curModule!=='ex');
    $('#panelSh').classList.toggle('hidden', curModule!=='sh');
    if(curModule==='sh' && !curZone){ /* prompt */ }
    if(curModule==='ex' && !curEx) selectEx('bench');
    if(curModule==='sh' && !curZone){ clearActive(); fitCamera('upper','front',true); }
  }));
  // exercise list
  const host = $('#exList');
  GROUPS.forEach(([gid,gname])=>{
    const items = EX.filter(e=>e.g===gid);
    const t = document.createElement('div'); t.className='grp-title'; t.textContent=gname; host.appendChild(t);
    items.forEach(e=>{
      const b = document.createElement('button'); b.className='ex-btn'; b.dataset.ex=e.id;
      b.innerHTML = `<span class="dot"></span>${e.name}`;
      b.addEventListener('click', ()=> selectEx(e.id));
      host.appendChild(b);
    });
  });
  // shoulder zones
  const zhost = $('#zoneList');
  SH_ZONES.forEach(z=>{
    const b = document.createElement('button'); b.className='zone-btn'; b.dataset.z=z.id;
    b.textContent = z.name;
    b.addEventListener('click', ()=> selectZone(z.id));
    zhost.appendChild(b);
  });
  $('#shRed').innerHTML = SH_REDFLAGS.map(r=>`<li>${r}</li>`).join('');
  // toggles
  $('#tglBones').addEventListener('click', ()=>{
    showBones = !showBones; boneMeshes.forEach(m=> m.visible = showBones);
    $('#tglBones').classList.toggle('on', showBones);
  });
  // theme
  $('#themeBtn').addEventListener('click', ()=>{
    const cur = document.documentElement.getAttribute('data-theme')
      || (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
    document.documentElement.setAttribute('data-theme', cur==='dark'?'light':'dark');
    scene.background = new THREE.Color(getStageBG());
    setThemeIcon();
  });
  setThemeIcon();
}

function markListSelection(){
  $$('.ex-btn').forEach(b=> b.setAttribute('aria-pressed', b.dataset.ex===curEx?.id));
}
function setThemeIcon(){
  const cur = document.documentElement.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
  $('#themeBtn').innerHTML = cur==='dark'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>';
}

// ---------- 详情面板 ----------
function ic(kind){
  if(kind==='ok') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
  if(kind==='no') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  return '';
}
function renderExDetail(){
  const e = curEx; const g = GROUPS.find(x=>x[0]===e.g)[1];
  const rows = e.m.map(([gid,role])=>{
    const mm = MUSC[gid]; if(!mm) return '';
    const found = (groupIndex[gid]||[]).length;
    return `<div class="mrow ${role}" data-gid="${gid}"><span class="bar"></span>
      <span class="nm">${mm.cn}</span><span class="lat">${mm.lat}</span>
      <span class="rl">${RLABEL[role]}</span></div>`;
  }).join('');
  $('#exDetail').innerHTML = `
    <div class="d-head">
      <div class="d-meta">${g} · ${e.m.length} 块肌肉参与</div>
      <h2 class="d-title">${e.name}</h2>
    </div>
    <div class="anim-bar">
      <button class="play" id="playBtn2" aria-label="播放/暂停"></button>
      <span class="phase-pill con" id="phasePill">向心 · 收缩</span>
      <span class="breath" id="breathTxt"></span>
    </div>
    <div class="muscle-rows">${rows}</div>
    <div class="sec"><div class="sec-h">动作要点</div><ul class="info-list">${e.cue.map(c=>`<li>${ic('ok')}<span>${c}</span></li>`).join('')}</ul></div>
    <div class="sec"><div class="sec-h">常见错误</div><ul class="info-list warn">${e.err.map(c=>`<li>${ic('no')}<span>${c}</span></li>`).join('')}</ul></div>
    <p class="hint">提示：拖动旋转模型，滚轮缩放，点击任意肌肉查看它练在哪。</p>`;
  $('#playBtn2').addEventListener('click', ()=>{ if(active){ active.playing=!active.playing; updatePlayIcon2(); } });
  updatePlayIcon2();
  $$('#exDetail .mrow').forEach(row=>{
    row.addEventListener('mouseenter', ()=> soloHighlight(row.dataset.gid));
    row.addEventListener('mouseleave', ()=> { const rm={}; curEx.m.forEach(([g,r])=>rm[g]=r); applyRoles(rm); });
    row.addEventListener('click', ()=> showMuscleInfo(row.dataset.gid));
  });
}
function updatePlayIcon2(){
  const b = $('#playBtn2'); if(!b) return;
  b.innerHTML = active?.playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}
function soloHighlight(gid){
  if(!active) return;
  active.records.forEach(r=>{
    const on = r.groupId===gid;
    if(r.mesh.material.emissive){ r.mesh.material.emissiveIntensity = on?0.6:0.05; r.mesh.material.opacity = 1; }
    r.mesh.material.transparent = !on; r.mesh.material.opacity = on?1:0.25;
  });
}

function showMuscleInfo(gid){
  const mm = MUSC[gid]; if(!mm) return;
  const uses = EX.filter(e=> e.m.some(x=>x[0]===gid));
  $('#exDetail').innerHTML = `
    <div class="d-head"><div class="d-meta">${mm.lat}</div><h2 class="d-title">${mm.cn}</h2></div>
    <p class="hint" style="margin-top:0">练到这块肌肉的动作（点击查看动作解剖）：</p>
    <div class="rev">${uses.map(e=>{
      const role = e.m.find(x=>x[0]===gid)[1];
      return `<button data-ex="${e.id}">${e.name}<span class="rr">${RLABEL[role]}</span></button>`;
    }).join('') || '<span class="lat">暂无收录动作</span>'}</div>
    <button class="link-back" id="backEx">← 返回当前动作</button>`;
  $$('#exDetail .rev button').forEach(b=> b.addEventListener('click', ()=> selectEx(b.dataset.ex)));
  $('#backEx').addEventListener('click', ()=> curEx && selectEx(curEx.id));
  // 高亮这块肌肉
  clearActive(); applyRoles({ [gid]:'primary' });
  const back = ['deltP','infra','teres','rhom','levscap','teresMaj','lat','trapU','trapM','glut','glutM','ham','calf','erec'].includes(gid);
  fitCamera(curPart()==='lower'?'lower':'upper', back?'back':'front', true);
}

function sevChip(s){ return {hi:['hi','高关注'],mid:['mid','中等'],lo:['lo','偏轻']}[s]; }
function renderZoneDetail(){
  const z = curZone;
  const probs = z.problems.map(p=>{
    const [cls,txt] = sevChip(p.sev);
    return `<div class="prob"><h4>${p.t}<span class="chip ${cls}">${txt}</span></h4>
      <div class="pb"><div class="row"><span class="k">诱因</span><span>${p.why}</span></div>
      <div class="row"><span class="k">典型表现</span><span>${p.sign}</span></div></div></div>`;
  }).join('');
  $('#shDetail').innerHTML = `
    <div class="d-head"><div class="d-meta">点击定位 · 教育参考</div><h2 class="d-title">${z.name}</h2></div>
    <div class="sec"><div class="sec-h">由浅入深的结构</div>
      <div class="layers">${z.layers.map(l=>`<div class="layer"><span class="lv">${l[0]}</span><b>${l[1]}</b></div>`).join('')}</div></div>
    <div class="sec"><div class="sec-h">常见对应问题</div>
      <div class="probs">${probs}</div></div>
    <div class="sec"><div class="sec-h">简易自测</div>
      <div class="tags">${z.tests.do.map(t=>`<span class="tag ok">${ic('ok')}<span>${t}</span></span>`).join('')}</div></div>
    <div class="sec"><div class="sec-h" style="color:var(--crit)">先避开 / 减量</div>
      <div class="tags">${z.tests.avoid.map(t=>`<span class="tag no">${ic('no')}<span>${t}</span></span>`).join('')}</div></div>`;
}

// ============================================================== LOOP =========
function onResize(){ camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); }
function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if(camGoal){
    camera.position.lerp(camGoal.pos, 0.09);
    controls.target.lerp(camGoal.target, 0.12);
    if(camera.position.distanceTo(camGoal.pos) < 0.01){ camera.position.copy(camGoal.pos); controls.target.copy(camGoal.target); camGoal=null; }
  }
  updateDeform(dt);
  controls.update();
  renderer.render(scene, camera);
}
