"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import gsap from "gsap";

type RendererState = "checking" | "webgl" | "fallback";
type GrainUniforms = {
  tDiffuse: THREE.IUniform<THREE.Texture | null>;
  uTime: THREE.IUniform<number>;
  uAmount: THREE.IUniform<number>;
};

const VERTEX_SHADER = `
  attribute float aX;
  attribute float aPhase;
  attribute float aLane;
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uSecondary;
  uniform float uPointerX;
  uniform vec2 uViewport;
  varying float vGlow;
  varying float vHeight;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    float primary = sin(uTime * 0.86 + aPhase * 8.4) * 0.5 + 0.5;
    float secondary = sin(uTime * 0.52 - aPhase * 12.0 + aLane * 1.7) * 0.5 + 0.5;
    float height = max(18.0, (primary * 0.68 + secondary * 0.32) * uViewport.y * 0.48 * uAmplitude);
    height *= mix(0.82, 1.0, uSecondary);
    vHeight = height;

    vec3 transformed = position;
    transformed.x += aX + transformed.y * height * 0.23;
    transformed.y = transformed.y * height - uViewport.y * 0.5 + 24.0;

    float distancePx = abs(aX - uPointerX);
    vGlow = 1.0 - smoothstep(0.0, max(120.0, uViewport.x * 0.24), distancePx);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  uniform vec3 uBaseColor;
  uniform vec3 uHighlightColor;
  varying float vGlow;
  varying float vHeight;
  varying vec2 vUv;

  void main() {
    float lowerWidth = smoothstep(0.0, 0.78, vUv.y);
    float upperWidth = (1.0 - smoothstep(0.78, 1.0, vUv.y)) * 3.2;
    float allowedWidth = max(0.055, min(lowerWidth, upperWidth));
    float horizontal = abs(vUv.x - 0.5) * 2.0;
    float edge = 1.0 - smoothstep(allowedWidth, allowedWidth + 0.075, horizontal);
    if (edge < 0.01 || vHeight < 1.0) discard;

    float highlight = clamp(vGlow * 0.72 + smoothstep(0.68, 1.0, vUv.y) * 0.16, 0.0, 1.0);
    vec3 color = mix(uBaseColor, uHighlightColor, highlight);
    float alpha = (0.18 + vGlow * 0.22) * edge;
    gl_FragColor = vec4(color, alpha);
  }
`;

const GRAIN_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAmount: { value: 0.018 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision mediump float;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAmount;
    varying vec2 vUv;

    float hash(vec2 point) {
      return fract(sin(dot(point, vec2(12.9898, 78.233)) + uTime) * 43758.5453);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float noise = (hash(gl_FragCoord.xy * 0.35) - 0.5) * uAmount;
      gl_FragColor = vec4(color.rgb + noise, color.a);
    }
  `,
};

function isLowCapabilityDevice() {
  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  return navigator.hardwareConcurrency <= 2 || (navigatorWithMemory.deviceMemory !== undefined && navigatorWithMemory.deviceMemory <= 2);
}

function StaticWaveFallback() {
  return <div className="hive-wave-fallback" data-testid="hive-wave-fallback">{Array.from({ length: 28 }, (_, index) => <i style={{ "--wave-height": `${Math.round(24 + ((Math.sin(index * 0.72) + 1) / 2) * 70)}%` } as React.CSSProperties} key={index} />)}</div>;
}

export function HiveWaveBackground({ className = "" }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [rendererState, setRendererState] = useState<RendererState>("checking");
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const host = canvasRef.current;
    if (!root || !host || reducedMotion || isLowCapabilityDevice()) {
      setRendererState("fallback");
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "high-performance" });
    } catch {
      setRendererState("fallback");
      return;
    }

    while (host.firstChild) host.removeChild(host.firstChild);
    const canvas = renderer.domElement;
    canvas.setAttribute("data-hive-wave-canvas", "true");
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    camera.position.z = 2;
    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.56, 0.08);
    const grainPass = new ShaderPass(GRAIN_SHADER);
    const grainUniforms = grainPass.uniforms as GrainUniforms;
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(grainPass);

    const waveUniforms = {
      uTime: new THREE.Uniform(0),
      uAmplitude: new THREE.Uniform(0.82),
      uSecondary: new THREE.Uniform(0.48),
      uPointerX: new THREE.Uniform(0),
      uViewport: new THREE.Uniform(new THREE.Vector2(1, 1)),
      uBaseColor: new THREE.Uniform(new THREE.Color("#5b21b6")),
      uHighlightColor: new THREE.Uniform(new THREE.Color("#a78bfa")),
    };
    const material = new THREE.ShaderMaterial({
      uniforms: waveUniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    let bars: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | undefined;
    let width = 1;
    let height = 1;
    let pointerTarget = 0;
    let pointerCurrent = 0;
    let visible = !document.hidden;
    let intersecting = true;
    let contextLost = false;
    let frame = 0;
    let previousFrame = performance.now();
    let elapsed = 0;
    const compact = window.matchMedia("(max-width: 900px)").matches;
    const mobile = window.matchMedia("(max-width: 700px)").matches;
    const frameInterval = 1_000 / (compact ? 30 : 60);
    const motion = { amplitude: compact ? 0.5 : 0.82, secondary: 0.48 };
    const timeline = gsap.timeline({ paused: true, repeat: -1, yoyo: true });
    timeline.to(motion, { amplitude: compact ? 0.66 : 1, secondary: 0.78, duration: 6.5, ease: "sine.inOut" });

    const applyTheme = () => {
      const light = document.documentElement.dataset.theme === "light";
      waveUniforms.uBaseColor.value.set(light ? "#b9a4d0" : "#5b21b6");
      waveUniforms.uHighlightColor.value.set(light ? "#70409f" : "#a78bfa");
      bloomPass.strength = light ? 0.16 : 0.42;
      grainUniforms.uAmount.value = light ? 0.008 : 0.018;
    };

    const rebuildBars = () => {
      if (bars) {
        scene.remove(bars);
        bars.geometry.dispose();
      }

      const extension = Math.min(180, width * 0.16);
      const span = width + extension * 2;
      const count = Math.min(150, Math.max(44, Math.floor(span / (mobile ? 15 : 18))));
      const barWidth = mobile ? 6 : 8;
      const geometry = new THREE.PlaneGeometry(barWidth, 1, 1, 1);
      geometry.translate(0, 0.5, 0);
      const xPositions = new Float32Array(count);
      const phases = new Float32Array(count);
      const lanes = new Float32Array(count);

      for (let index = 0; index < count; index += 1) {
        const progress = count === 1 ? 0 : index / (count - 1);
        xPositions[index] = -span * 0.5 + progress * span;
        phases[index] = progress;
        lanes[index] = index % 2;
      }

      geometry.setAttribute("aX", new THREE.InstancedBufferAttribute(xPositions, 1));
      geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
      geometry.setAttribute("aLane", new THREE.InstancedBufferAttribute(lanes, 1));
      bars = new THREE.InstancedMesh(geometry, material, count);
      bars.frustumCulled = false;
      scene.add(bars);
    };

    const resize = () => {
      const bounds = root.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1 : 1.5);
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      composer.setPixelRatio(dpr * (mobile ? 0.72 : 0.86));
      composer.setSize(width, height);
      camera.left = -width * 0.5;
      camera.right = width * 0.5;
      camera.top = height * 0.5;
      camera.bottom = -height * 0.5;
      camera.updateProjectionMatrix();
      waveUniforms.uViewport.value.set(width, height);
      pointerTarget = 0;
      pointerCurrent = 0;
      rebuildBars();
    };

    const shouldRun = () => visible && intersecting && !contextLost;
    const renderFrame = (now: number) => {
      if (!shouldRun()) {
        frame = 0;
        return;
      }
      frame = window.requestAnimationFrame(renderFrame);
      const deltaMs = Math.min(100, now - previousFrame);
      if (deltaMs < frameInterval) return;
      previousFrame = now - (deltaMs % frameInterval);
      elapsed += deltaMs / 1_000;
      pointerCurrent += (pointerTarget - pointerCurrent) * Math.min(1, deltaMs / 85);
      waveUniforms.uTime.value = elapsed;
      waveUniforms.uAmplitude.value = motion.amplitude;
      waveUniforms.uSecondary.value = motion.secondary;
      waveUniforms.uPointerX.value = pointerCurrent;
      grainUniforms.uTime.value = elapsed * 29;
      composer.render();
    };

    const syncRunning = () => {
      if (shouldRun()) {
        timeline.resume();
        previousFrame = performance.now();
        if (!frame) frame = window.requestAnimationFrame(renderFrame);
      } else {
        timeline.pause();
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const bounds = root.getBoundingClientRect();
      const within = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      pointerTarget = within ? event.clientX - bounds.left - width * 0.5 : 0;
    };
    const onVisibility = () => { visible = !document.hidden; syncRunning(); };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      setRendererState("fallback");
      syncRunning();
    };
    const onContextRestored = () => setGeneration((current) => current + 1);

    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? true;
      syncRunning();
    }, { threshold: 0.01 });
    const themeRoot = document.documentElement;
    const themeObserver = new MutationObserver(applyTheme);

    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    resizeObserver.observe(root);
    intersectionObserver.observe(root);
    themeObserver.observe(themeRoot, { attributes: true, attributeFilter: ["data-theme"] });

    applyTheme();
    resize();
    setRendererState("webgl");
    syncRunning();

    return () => {
      timeline.kill();
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      themeObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      if (bars) {
        scene.remove(bars);
        bars.geometry.dispose();
      }
      material.dispose();
      grainPass.dispose();
      bloomPass.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentElement === host) host.removeChild(canvas);
    };
  }, [generation, reducedMotion]);

  const showFallback = reducedMotion || rendererState !== "webgl";
  return (
    <div ref={rootRef} className={`hive-wave-background ${className}`} data-renderer={showFallback ? "fallback" : "webgl"} aria-hidden="true">
      <div ref={canvasRef} className="hive-wave-canvas" />
      {showFallback && <StaticWaveFallback />}
    </div>
  );
}
