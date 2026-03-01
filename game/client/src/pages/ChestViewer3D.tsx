import { useEffect, useRef, useCallback } from 'react';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4, Color3 } from '@babylonjs/core/Maths/math.color';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { Animation } from '@babylonjs/core/Animations/animation';
import { CubicEase, EasingFunction } from '@babylonjs/core/Animations/easing';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';

// Side-effect import: registers GLTF/GLB loader plugin
import '@babylonjs/loaders/glTF';

type ChestState = 'idle' | 'shaking' | 'open' | 'reveal';

interface ChestViewer3DProps {
  chestState: ChestState;
  modelPath?: string;
}

/**
 * Standalone BabylonJS canvas that renders a 3D chest model.
 * Manages its own Engine/Scene lifecycle independently from the game scene.
 */
export function ChestViewer3D({
  chestState,
  modelPath = '/models/chest.glb',
}: ChestViewer3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const meshesRef = useRef<AbstractMesh[]>([]);
  const animGroupsRef = useRef<AnimationGroup[]>([]);
  const lidMeshRef = useRef<AbstractMesh | null>(null);
  const rootMeshRef = useRef<AbstractMesh | null>(null);
  const prevStateRef = useRef<ChestState>('idle');
  const idleAnimFrameRef = useRef<number | null>(null);

  // ── Programmatic shake animation ──────────────────────────────────
  const playShakeAnimation = useCallback(() => {
    const root = rootMeshRef.current;
    if (!root) return;

    const fps = 60;
    const totalFrames = 30; // 0.5s at 60fps

    // Position shake (X axis)
    const shakePos = new Animation(
      'chestShakePos', 'position.x', fps,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CONSTANT,
    );
    const baseX = root.position.x;
    const amp = 0.15;
    shakePos.setKeys([
      { frame: 0, value: baseX },
      { frame: 3, value: baseX - amp },
      { frame: 6, value: baseX + amp },
      { frame: 9, value: baseX - amp * 0.8 },
      { frame: 12, value: baseX + amp * 0.8 },
      { frame: 15, value: baseX - amp * 0.6 },
      { frame: 18, value: baseX + amp * 0.6 },
      { frame: 21, value: baseX - amp * 0.3 },
      { frame: 24, value: baseX + amp * 0.3 },
      { frame: 27, value: baseX - amp * 0.1 },
      { frame: totalFrames, value: baseX },
    ]);

    // Rotation shake (Z axis)
    const shakeRot = new Animation(
      'chestShakeRot', 'rotation.z', fps,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CONSTANT,
    );
    const rotAmp = 0.06;
    shakeRot.setKeys([
      { frame: 0, value: 0 },
      { frame: 3, value: -rotAmp },
      { frame: 6, value: rotAmp },
      { frame: 9, value: -rotAmp * 0.7 },
      { frame: 12, value: rotAmp * 0.7 },
      { frame: 15, value: -rotAmp * 0.5 },
      { frame: 18, value: rotAmp * 0.5 },
      { frame: 21, value: -rotAmp * 0.2 },
      { frame: 24, value: rotAmp * 0.2 },
      { frame: 27, value: 0 },
      { frame: totalFrames, value: 0 },
    ]);

    const scene = sceneRef.current;
    if (!scene) return;
    scene.beginDirectAnimation(root, [shakePos, shakeRot], 0, totalFrames, false, 1);
  }, []);

  // ── Programmatic lid open (fallback if no built-in anim) ──────────
  const playLidOpenAnimation = useCallback(() => {
    const lid = lidMeshRef.current;
    const scene = sceneRef.current;
    if (!lid || !scene) return;

    const fps = 60;
    const totalFrames = 36; // 0.6s

    const openAnim = new Animation(
      'lidOpen', 'rotation.x', fps,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CONSTANT,
    );

    const ease = new CubicEase();
    ease.setEasingMode(EasingFunction.EASINGMODE_EASEOUT);
    openAnim.setEasingFunction(ease);

    openAnim.setKeys([
      { frame: 0, value: lid.rotation.x },
      { frame: totalFrames, value: -Math.PI * 0.6 }, // ~108 degrees open
    ]);

    scene.beginDirectAnimation(lid, [openAnim], 0, totalFrames, false, 1);
  }, []);

  // ── Programmatic lid close ────────────────────────────────────────
  const playLidCloseAnimation = useCallback(() => {
    const lid = lidMeshRef.current;
    const scene = sceneRef.current;
    if (!lid || !scene) return;

    const fps = 60;
    const totalFrames = 20; // 0.33s

    const closeAnim = new Animation(
      'lidClose', 'rotation.x', fps,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CONSTANT,
    );

    const ease = new CubicEase();
    ease.setEasingMode(EasingFunction.EASINGMODE_EASEIN);
    closeAnim.setEasingFunction(ease);

    closeAnim.setKeys([
      { frame: 0, value: lid.rotation.x },
      { frame: totalFrames, value: 0 },
    ]);

    scene.beginDirectAnimation(lid, [closeAnim], 0, totalFrames, false, 1);
  }, []);

  // ── Idle bob animation ────────────────────────────────────────────
  const startIdleBob = useCallback(() => {
    stopIdleBob();
    const root = rootMeshRef.current;
    if (!root) return;

    const baseY = root.position.y;
    let t = 0;
    const animate = () => {
      t += 0.02;
      root.position.y = baseY + Math.sin(t) * 0.03;
      idleAnimFrameRef.current = requestAnimationFrame(animate);
    };
    idleAnimFrameRef.current = requestAnimationFrame(animate);
  }, []);

  const stopIdleBob = useCallback(() => {
    if (idleAnimFrameRef.current !== null) {
      cancelAnimationFrame(idleAnimFrameRef.current);
      idleAnimFrameRef.current = null;
    }
  }, []);

  // ── Try to play a built-in animation group by exact name ──────────
  const tryPlayAnimGroup = useCallback((name: string, loop: boolean = false): boolean => {
    // Prefer exact match, then fallback to includes
    const lc = name.toLowerCase();
    const group =
      animGroupsRef.current.find(g => g.name.toLowerCase() === lc) ??
      animGroupsRef.current.find(g => g.name.toLowerCase().includes(lc));
    if (group) {
      group.start(loop, 1.0, group.from, group.to, false);
      return true;
    }
    return false;
  }, []);

  // ── Initialize engine + scene + load model ────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      adaptToDeviceRatio: true,
      alpha: true,
    });
    engineRef.current = engine;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 0); // transparent background
    sceneRef.current = scene;

    // Camera — fixed-angle arc rotate
    const camera = new ArcRotateCamera(
      'chestCam',
      Math.PI * 0.75,  // alpha — slight angle from front
      Math.PI / 4,     // beta — looking down ~45 degrees
      3.0,             // radius
      new Vector3(0, 0.55, 0), // target center-mass including open lid
      scene,
    );
    camera.lowerRadiusLimit = 3.0;
    camera.upperRadiusLimit = 3.0;
    camera.lowerBetaLimit = camera.beta;
    camera.upperBetaLimit = camera.beta;
    camera.lowerAlphaLimit = camera.alpha;
    camera.upperAlphaLimit = camera.alpha;
    // No user interaction — locked camera
    camera.attachControl(canvas, false);
    camera.inputs.clear();

    // Lighting
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;
    hemi.groundColor = new Color3(0.15, 0.1, 0.25);

    const dir = new DirectionalLight('dir', new Vector3(-0.5, -1, 0.5), scene);
    dir.intensity = 0.8;

    // Load model — split into rootUrl + filename for BabylonJS
    const lastSlash = modelPath.lastIndexOf('/');
    const rootUrl = modelPath.substring(0, lastSlash + 1);  // e.g. "/models/"
    const fileName = modelPath.substring(lastSlash + 1);     // e.g. "chest.glb"
    SceneLoader.ImportMeshAsync('', rootUrl, fileName, scene).then(result => {
      meshesRef.current = result.meshes as AbstractMesh[];
      animGroupsRef.current = result.animationGroups ?? [];

      // Stop all animations so chest starts closed
      for (const ag of result.animationGroups ?? []) {
        ag.stop();
        ag.reset();
      }

      // Find root mesh (first TransformNode or mesh)
      const root = result.meshes[0];
      rootMeshRef.current = root;

      // Auto-detect lid mesh by name (common Kenney naming: "lid", "top", "cover")
      const lid = result.meshes.find(m => {
        const name = m.name.toLowerCase();
        return name.includes('lid') || name.includes('top') || name.includes('cover');
      });
      lidMeshRef.current = lid ?? null;

      // Center the model — compute bounding and offset
      let minY = Infinity;
      for (const mesh of result.meshes) {
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo();
        if (bb) {
          const worldMin = bb.boundingBox.minimumWorld;
          if (worldMin.y < minY) minY = worldMin.y;
        }
      }
      if (root && isFinite(minY)) {
        root.position.y -= minY; // sit on ground
      }

      // Start idle bob
      startIdleBob();

      // Log animation groups for debugging
      if (animGroupsRef.current.length > 0) {
        console.log('[ChestViewer3D] Animation groups:', animGroupsRef.current.map(g => g.name));
      }
      if (lid) {
        console.log('[ChestViewer3D] Detected lid mesh:', lid.name);
      }
    }).catch(err => {
      console.warn('[ChestViewer3D] Failed to load chest model:', err);
    });

    // Render loop
    engine.runRenderLoop(() => scene.render());

    // Handle resize
    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      stopIdleBob();
      scene.dispose();
      engine.dispose();
      engineRef.current = null;
      sceneRef.current = null;
      meshesRef.current = [];
      animGroupsRef.current = [];
      lidMeshRef.current = null;
      rootMeshRef.current = null;
    };
  }, [modelPath]); // only re-init if model path changes

  // ── React to chestState changes ───────────────────────────────────
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = chestState;

    if (prev === chestState) return;

    switch (chestState) {
      case 'idle': {
        // Close the lid if it was open
        if (prev === 'reveal' || prev === 'open') {
          // Try built-in close animation first
          if (!tryPlayAnimGroup('close')) {
            playLidCloseAnimation();
          }
        }
        startIdleBob();
        break;
      }
      case 'shaking': {
        stopIdleBob();
        // Try built-in shake animation, fall back to programmatic
        if (!tryPlayAnimGroup('shake')) {
          playShakeAnimation();
        }
        break;
      }
      case 'open': {
        // Try built-in open animation, fall back to lid rotation
        if (!tryPlayAnimGroup('open')) {
          playLidOpenAnimation();
        }
        break;
      }
      case 'reveal': {
        // Keep open — no additional action needed
        break;
      }
    }
  }, [chestState, playShakeAnimation, playLidOpenAnimation, playLidCloseAnimation, startIdleBob, stopIdleBob, tryPlayAnimGroup]);

  return (
    <canvas
      ref={canvasRef}
      className="chest-viewer-3d"
    />
  );
}
