/**
 * app.js — WebXR AR 互动 MVP 主脚本
 *
 * 功能概述：
 *  1. 初始化带光照的 Three.js 场景，启用 WebXR AR 模式
 *  2. 通过 Hit-test 在地面显示放置光标（Reticle）
 *  3. 加载 RobotExpressive.glb，使用 AnimationMixer 管理骨骼动画
 *  4. 虚拟摇杆控制模型在 XZ 平面移动并自动朝向移动方向
 *  5. 动作按钮触发 Jump 动画，结束后自动回到 Idle
 */

import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ============================================================
// 全局变量
// ============================================================

/** @type {THREE.WebGLRenderer} */
let renderer;
/** @type {THREE.Scene} */
let scene;
/** @type {THREE.PerspectiveCamera} */
let camera;
/** @type {THREE.Clock} */
let clock;

// --- WebXR ---
/** @type {XRSession|null} */
let xrSession = null;
/** @type {XRHitTestSource|null} */
let hitTestSource = null;
let hitTestSourceRequested = false;

// --- 地面光标 ---
/** @type {THREE.Mesh} */
let reticle;

// --- 模型与动画 ---
/** @type {THREE.Group|null} 放置后的机器人模型根节点 */
let robot = null;
/** @type {THREE.AnimationMixer|null} */
let mixer = null;
/**
 * 存储提取的动画动作
 * @type {{ Idle?: THREE.AnimationAction, Walking?: THREE.AnimationAction, Jump?: THREE.AnimationAction }}
 */
const animations = {};
/** @type {THREE.AnimationAction|null} 当前正在播放的动作 */
let currentAction = null;
/** 模型是否已经被放置到场景中 */
let isPlaced = false;

// --- 摇杆状态 ---
/**
 * 摇杆输出的归一化向量（每个分量范围 [-1, 1]）
 * x: 水平方向（右为正）
 * y: 垂直方向（屏幕向下为正，即摇杆向上推时 y 为负）
 */
const joystickState = {
  active: false,
  vector: { x: 0, y: 0 },
};

// 行走状态追踪（用于触发动画切换）
let wasWalking = false;

// --- 常量 ---
const MOVE_SPEED = 0.025;         // 每帧移动距离（米）
const JOYSTICK_DEAD_ZONE = 0.12;  // 摇杆死区阈值（低于此值不响应）
const ROTATION_SPEED = 8;         // 模型旋转平滑速度（弧度/秒）

// --- DOM 元素引用 ---
const statusText = /** @type {HTMLElement} */ (document.getElementById('status-text'));
const joystickBase = /** @type {HTMLElement} */ (document.getElementById('joystick-base'));
const joystickThumb = /** @type {HTMLElement} */ (document.getElementById('joystick-thumb'));
const actionBtn = /** @type {HTMLButtonElement} */ (document.getElementById('action-btn'));

// ============================================================
// 工具函数：更新顶部状态栏
// ============================================================
function updateStatus(text) {
  if (statusText) statusText.textContent = text;
}

// ============================================================
// 初始化 Three.js 场景、相机、渲染器和光照
// ============================================================
function initScene() {
  // 场景
  scene = new THREE.Scene();

  // 时钟（用于 AnimationMixer delta 计算）
  clock = new THREE.Clock();

  // 透视相机——在 AR 模式下，XR 系统会自动接管相机矩阵
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 30);

  // 渲染器：alpha:true 保留透明背景以叠加 AR 相机画面
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // 半球光（天光 + 地面反射光）
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.8);
  scene.add(hemiLight);

  // 方向光（产生阴影）
  const dirLight = new THREE.DirectionalLight(0xffffff, 2.2);
  dirLight.position.set(1.5, 4, 2);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  dirLight.shadow.camera.near = 0.1;
  dirLight.shadow.camera.far = 20;
  scene.add(dirLight);

  // 窗口尺寸变化时更新相机和渲染器
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// ============================================================
// 创建地面光标（Reticle）
// 一个扁平圆环，通过 Hit-test 贴在检测到的真实平面上，
// 指示模型即将放置的位置。
// ============================================================
function createReticle() {
  // RingGeometry 生成圆环，rotateX(-90°) 使其平躺于水平面
  const geo = new THREE.RingGeometry(0.09, 0.11, 32).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x44ff88,
    side: THREE.DoubleSide,
  });
  reticle = new THREE.Mesh(geo, mat);
  // matrixAutoUpdate = false：禁止 Three.js 自动计算矩阵，
  // 改由 Hit-test 结果的姿态矩阵直接赋值，确保精准贴合地面
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);
}

// ============================================================
// 加载 RobotExpressive.glb 模型
// 模型来自 Three.js 官方示例，内含多个骨骼动画片段
// ============================================================
function loadRobotModel() {
  const loader = new GLTFLoader();
  const MODEL_URL =
    'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/models/gltf/RobotExpressive/RobotExpressive.glb';

  updateStatus('正在加载模型，请稍候…');

  loader.load(
    MODEL_URL,

    // ---- 加载成功回调 ----
    (gltf) => {
      const model = gltf.scene;

      // 缩放到适合 AR 场景的尺寸
      model.scale.setScalar(0.3);
      // 初始不可见，等待用户点击放置
      model.visible = false;

      // 开启阴影投射与接收
      model.traverse((child) => {
        if (/** @type {THREE.Mesh} */ (child).isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      // ---- 创建 AnimationMixer ----
      // AnimationMixer 是 Three.js 骨骼动画的核心管理器，
      // 每帧调用 mixer.update(delta) 驱动动画时间线前进
      mixer = new THREE.AnimationMixer(model);

      // ---- 提取动画片段 ----
      // RobotExpressive.glb 内含的动画名称包括：
      // Idle, Walking, Running, Dance, Death, Sitting,
      // Standing, Jump, Yes, No, Wave, Punch, ThumbsUp
      gltf.animations.forEach((clip) => {
        const action = mixer.clipAction(clip);

        switch (clip.name) {
          case 'Idle':
            animations.Idle = action;
            action.loop = THREE.LoopRepeat;
            break;
          case 'Walking':
            animations.Walking = action;
            action.loop = THREE.LoopRepeat;
            break;
          case 'Jump':
            animations.Jump = action;
            // 跳跃只播放一次，播完保持最后一帧
            action.loop = THREE.LoopOnce;
            action.clampWhenFinished = true;
            break;
        }
      });

      // ---- 监听动画结束事件 ----
      // 当 Jump 动画播完时，自动平滑切换回 Idle
      mixer.addEventListener('finished', (event) => {
        if (event.action === animations.Jump) {
          wasWalking = false;
          fadeToAction(animations.Idle, 0.4);
        }
      });

      scene.add(model);
      robot = model;

      console.log(
        'RobotExpressive 加载成功，可用动画:',
        gltf.animations.map((a) => a.name).join(', ')
      );
      updateStatus('模型就绪。对准地面，点击屏幕放置机器人。');
    },

    // ---- 加载进度回调 ----
    (progress) => {
      if (progress.total > 0) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        updateStatus(`正在加载模型… ${pct}%`);
      }
    },

    // ---- 加载失败回调 ----
    (error) => {
      console.error('模型加载失败:', error);
      updateStatus('❌ 模型加载失败，请检查网络连接后刷新重试。');
    }
  );
}

// ============================================================
// 动画平滑切换（crossFade）
//
// 使用 fadeOut + fadeIn 实现动画之间的线性混合过渡，
// 避免姿态突变导致的视觉跳帧。
// ============================================================

/**
 * 平滑切换到目标动画动作
 * @param {THREE.AnimationAction} toAction  目标动作
 * @param {number} [duration=0.3]           过渡时长（秒）
 */
function fadeToAction(toAction, duration = 0.3) {
  if (!toAction || currentAction === toAction) return;

  const prevAction = currentAction;
  currentAction = toAction;

  if (prevAction) {
    prevAction.fadeOut(duration);
  }

  toAction
    .reset()
    .setEffectiveTimeScale(1)
    .setEffectiveWeight(1)
    .fadeIn(duration)
    .play();
}

// ============================================================
// 初始化 ARButton 与 WebXR 会话监听
// ============================================================
function initAR() {
  // ARButton.createButton 会创建一个按钮，
  // 点击后请求 WebXR immersive-ar 会话。
  // requiredFeatures: ['hit-test'] — 平面检测
  // optionalFeatures: ['dom-overlay'] — HTML UI 叠加
  const arButton = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.getElementById('overlay') },
  });
  document.body.appendChild(arButton);

  // WebXR 会话开始
  renderer.xr.addEventListener('sessionstart', () => {
    xrSession = renderer.xr.getSession();
    hitTestSourceRequested = false;
    hitTestSource = null;
    isPlaced = false;

    // 监听屏幕点击（XR select 事件）
    xrSession.addEventListener('select', onXRSelect);

    updateStatus('对准地面，点击屏幕放置机器人');
  });

  // WebXR 会话结束
  renderer.xr.addEventListener('sessionend', () => {
    xrSession = null;
    hitTestSource = null;
    hitTestSourceRequested = false;
    if (reticle) reticle.visible = false;
    updateStatus('请点击「进入 AR」开始体验');
  });
}

// ============================================================
// XR select 事件：点击屏幕放置模型
// ============================================================
function onXRSelect() {
  // 摇杆激活期间点击，不触发放置，防止操作冲突
  if (joystickState.active) return;
  // 模型已放置后不重复放置
  if (isPlaced) return;

  // Reticle 可见说明检测到了地面
  if (reticle && reticle.visible && robot) {
    // 从 Reticle 的世界矩阵中提取位置与旋转
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    reticle.matrix.decompose(position, quaternion, scale);

    robot.position.copy(position);
    // 保持 Y 轴旋转为 0（模型朝向初始方向），后续由摇杆控制朝向
    robot.rotation.set(0, 0, 0);
    robot.visible = true;

    isPlaced = true;
    reticle.visible = false;

    // 放置后开始播放 Idle 待机动画
    fadeToAction(animations.Idle, 0.2);
    updateStatus('机器人已放置！左摇杆移动，右按钮播放跳跃动作');
  }
}

// ============================================================
// 虚拟摇杆实现
//
// 核心数学原理：
//  1. 记录 touchstart 时的摇杆底座中心位置
//  2. 计算手指当前位置相对于底座中心的偏移 (deltaX, deltaY)
//  3. 将偏移量限制在摇杆半径范围内（等比缩放）
//  4. 除以半径，得到范围 [-1, 1] 的归一化向量
//  5. 渲染循环中读取该向量，乘以速度后转换为 3D 移动量
// ============================================================

/** 摇杆底座圆的半径（像素）—— 与 CSS 中 #joystick-base 宽度的一半一致（120px / 2 = 60px） */
const JOYSTICK_RADIUS = 60;

/** 当前跟踪的触摸点 identifier（多点触控时精确区分） */
let joystickTouchId = null;
/** 摇杆底座中心的屏幕坐标（每次 touchstart 时重新计算） */
const joystickCenter = { x: 0, y: 0 };

function initJoystick() {
  const base = joystickBase;

  // touchstart：记录触摸中心，激活摇杆
  base.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault(); // 阻止 scroll、zoom 等默认行为

      if (joystickTouchId !== null) return; // 已有触摸点，忽略新的触点

      const touch = e.changedTouches[0];
      joystickTouchId = touch.identifier;

      // 计算底座中心在屏幕中的绝对坐标
      const rect = base.getBoundingClientRect();
      joystickCenter.x = rect.left + rect.width / 2;
      joystickCenter.y = rect.top + rect.height / 2;

      joystickState.active = true;
      base.classList.add('active');

      applyJoystickInput(touch.clientX, touch.clientY);
    },
    { passive: false }
  );

  // touchmove：更新拇指位置和归一化向量
  base.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      const touch = Array.from(e.changedTouches).find(
        (t) => t.identifier === joystickTouchId
      );
      if (!touch) return;
      applyJoystickInput(touch.clientX, touch.clientY);
    },
    { passive: false }
  );

  // touchend / touchcancel：重置摇杆
  const resetJoystick = (e) => {
    const touch = Array.from(e.changedTouches).find(
      (t) => t.identifier === joystickTouchId
    );
    if (!touch) return;

    joystickTouchId = null;
    joystickState.active = false;
    joystickState.vector.x = 0;
    joystickState.vector.y = 0;

    base.classList.remove('active');

    // 拇指回弹到底座中心
    joystickThumb.style.left = '50%';
    joystickThumb.style.top = '50%';
    joystickThumb.style.transform = 'translate(-50%, -50%)';
  };

  base.addEventListener('touchend', resetJoystick, { passive: false });
  base.addEventListener('touchcancel', resetJoystick, { passive: false });
}

/**
 * 根据当前触摸位置更新摇杆拇指的视觉位置和输出向量。
 *
 * 数学步骤：
 *  delta = touch - center         原始偏移（像素）
 *  dist = |delta|                  偏移距离
 *  if dist > R: delta = delta * (R/dist)   等比限制在半径内
 *  vector = delta / R              归一化到 [-1, 1]
 *
 * @param {number} touchX  触摸点屏幕 X
 * @param {number} touchY  触摸点屏幕 Y
 */
function applyJoystickInput(touchX, touchY) {
  let dx = touchX - joystickCenter.x;
  let dy = touchY - joystickCenter.y;

  const dist = Math.sqrt(dx * dx + dy * dy);

  // 超出底座半径时等比缩小，使手指可以自由移动但输出不超过 ±1
  if (dist > JOYSTICK_RADIUS) {
    const ratio = JOYSTICK_RADIUS / dist;
    dx *= ratio;
    dy *= ratio;
  }

  // 归一化向量，分量范围 [-1, 1]
  joystickState.vector.x = dx / JOYSTICK_RADIUS;
  joystickState.vector.y = dy / JOYSTICK_RADIUS;

  // 更新拇指 CSS 位置（百分比相对于底座）
  // dx/R ∈ [-1,1] → 映射到 [0%, 100%]，中心为 50%
  const pctX = 50 + (dx / JOYSTICK_RADIUS) * 50;
  const pctY = 50 + (dy / JOYSTICK_RADIUS) * 50;
  joystickThumb.style.left = `${pctX}%`;
  joystickThumb.style.top = `${pctY}%`;
  joystickThumb.style.transform = 'translate(-50%, -50%)';
}

// ============================================================
// 动作按钮：触发 Jump 动画
// ============================================================
function initActionButton() {
  const playJump = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!robot || !animations.Jump) return;

    // 按下视觉反馈
    actionBtn.classList.add('pressed');
    setTimeout(() => actionBtn.classList.remove('pressed'), 150);

    // 中断当前动画，播放 Jump（mixer 的 finished 事件会处理回 Idle）
    fadeToAction(animations.Jump, 0.15);
    wasWalking = false;
  };

  // 同时监听 touchstart 和 click，兼容触摸与桌面调试
  actionBtn.addEventListener('touchstart', playJump, { passive: false });
  actionBtn.addEventListener('click', playJump);
}

// ============================================================
// 每帧处理：摇杆向量 → 3D 空间移动
//
// 摇杆向量到三维坐标的转换逻辑：
//
//   摇杆坐标系（屏幕 2D）：
//     vector.x ∈ [-1,1]  向右为正
//     vector.y ∈ [-1,1]  向下为正（屏幕坐标）
//
//   Three.js 世界坐标系（右手系）：
//     X 轴向右为正
//     Y 轴向上为正（本场景中垂直方向，模型不移动）
//     Z 轴向屏幕外（朝向摄影机）为正
//
//   映射规则（简单固定世界轴映射）：
//     moveX = vector.x          右/左 → +X/-X
//     moveZ = vector.y          摇杆下/上 → +Z/-Z
//                               （上推 vector.y<0 → 向 -Z 即"前进"方向）
//
//   模型朝向（rotation.y）：
//     使用 Math.atan2(x, z) 计算从 +Z 轴顺时针到移动向量的角度。
//     例：向右移动 (moveX=1, moveZ=0) → atan2(1,0) = π/2
//         rotation.y = π/2 使模型面向 +X 方向。
//
//   注意：若模型默认面向 -Z（部分 GLTF 模型的约定），
//   可在加载后对 model.rotation.y 加 Math.PI 做初始修正。
// ============================================================

/**
 * 读取摇杆状态，在 XZ 平面移动机器人并更新朝向。
 * @param {number} delta  上一帧到当前帧经过的时间（秒）
 */
function updateRobotMovement(delta) {
  if (!robot || !isPlaced || !joystickState.active) return;

  const { x, y } = joystickState.vector;

  // 计算摇杆推力大小（向量模长）
  const magnitude = Math.sqrt(x * x + y * y);

  // 死区过滤：避免摇杆轻微抖动引起不必要的移动
  if (magnitude < JOYSTICK_DEAD_ZONE) return;

  // 摇杆向量 → 世界空间 XZ 移动分量
  const moveX = x;   // 水平：向右为 +X
  const moveZ = y;   // 垂直：摇杆向下为 +Z（向前推为 -Z）

  // 根据移动方向计算目标朝向角度（rotation.y）
  // Math.atan2(a, b) 返回从 +b 轴到向量 (a, b) 的角度（弧度）
  // 这里 atan2(moveX, moveZ) 返回 XZ 平面上从 +Z 轴顺时针的角度
  const targetAngle = Math.atan2(moveX, moveZ);

  // 平滑旋转：将当前角度逐渐向目标角度靠近（避免突然转身）
  let angleDiff = targetAngle - robot.rotation.y;
  // 处理角度环绕，确保走最短旋转路径（最多旋转 180°）
  while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
  while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
  robot.rotation.y += angleDiff * Math.min(1, ROTATION_SPEED * delta);

  // 按摇杆力度（magnitude）和速度移动模型
  // 归一化后再乘 magnitude，使轻推慢走、重推快走
  const speed = MOVE_SPEED * Math.min(magnitude, 1);
  robot.position.x += moveX * speed;
  robot.position.z += moveZ * speed;
}

// ============================================================
// 每帧处理：根据摇杆状态切换 Walking / Idle 动画
// ============================================================
function updateWalkAnimation() {
  if (!robot || !isPlaced) return;

  // 跳跃动画播放期间不干预
  if (currentAction === animations.Jump) return;

  const { x, y } = joystickState.vector;
  const magnitude = Math.sqrt(x * x + y * y);
  const isMoving = joystickState.active && magnitude >= JOYSTICK_DEAD_ZONE;

  if (isMoving && !wasWalking) {
    // 从静止 → 行走：平滑切换到 Walking
    fadeToAction(animations.Walking, 0.3);
    wasWalking = true;
  } else if (!isMoving && wasWalking) {
    // 从行走 → 静止：平滑切换回 Idle
    fadeToAction(animations.Idle, 0.3);
    wasWalking = false;
  }
}

// ============================================================
// Hit-test 更新（每 XR 帧调用）
//
// Hit-test 工作原理：
//  1. 请求 'viewer' 参考空间（相机视角正前方）
//  2. 以该空间向 AR 场景发射射线
//  3. 设备 AR 系统检测真实平面（如地板、桌面）
//  4. 返回命中点的姿态（位置 + 旋转）
//  5. 将姿态矩阵赋值给 Reticle，使光标贴合地面
// ============================================================
function updateHitTest(frame) {
  const session = renderer.xr.getSession();
  const referenceSpace = renderer.xr.getReferenceSpace();
  if (!session || !referenceSpace) return;

  // 只在首帧请求 Hit-test 源（异步，后续复用）
  if (!hitTestSourceRequested) {
    session
      .requestReferenceSpace('viewer')
      .then((viewerSpace) =>
        session.requestHitTestSource({ space: viewerSpace })
      )
      .then((source) => {
        hitTestSource = source;
      })
      .catch((err) => {
        console.warn('Hit-test 请求失败:', err);
      });

    hitTestSourceRequested = true;

    // 会话结束时清理 Hit-test 源
    session.addEventListener('end', () => {
      hitTestSourceRequested = false;
      hitTestSource = null;
    });
  }

  // 模型已放置后不再显示 Reticle
  if (isPlaced) {
    reticle.visible = false;
    return;
  }

  if (hitTestSource) {
    const results = frame.getHitTestResults(hitTestSource);

    if (results.length > 0) {
      const pose = results[0].getPose(referenceSpace);
      if (pose) {
        reticle.visible = true;
        // 直接使用姿态矩阵（包含位置和平面法线旋转）
        reticle.matrix.fromArray(pose.transform.matrix);
      }
    } else {
      reticle.visible = false;
    }
  }
}

// ============================================================
// 主渲染循环
// ============================================================
function startRenderLoop() {
  // setAnimationLoop 替代 requestAnimationFrame，
  // 在 WebXR 会话中自动以显示刷新率调用，并传入 XRFrame 对象
  renderer.setAnimationLoop((timestamp, frame) => {
    const delta = clock.getDelta();

    // 驱动骨骼动画（每帧推进时间线）
    if (mixer) mixer.update(delta);

    // AR 帧处理
    if (frame) {
      updateHitTest(frame);
    }

    // 读取摇杆，移动模型
    updateRobotMovement(delta);

    // 切换行走/待机动画
    updateWalkAnimation();

    // 渲染场景
    renderer.render(scene, camera);
  });
}

// ============================================================
// 应用入口
// ============================================================
function main() {
  initScene();
  createReticle();
  loadRobotModel();
  initAR();
  initJoystick();
  initActionButton();
  startRenderLoop();
}

main();
