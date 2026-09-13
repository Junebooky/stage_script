"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { membraneFragmentShader, membraneVertexShader } from "@/lib/membrane-shaders";
import "./membrane.css";

export interface AvatarSignal {
  level: number;
  bands: number[];
  speechActive: boolean;
}

export interface AvatarAdapter {
  readonly mode: "VISEME" | "AUDIO_REACTIVE";
  render(signal: AvatarSignal): ReactNode;
}

function MembraneCanvas({ signal }: { signal: AvatarSignal }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const signalRef = useRef(signal);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => { signalRef.current = signal; }, [signal]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
        stencil: false,
        depth: true
      });
    } catch {
      setUnavailable(true);
      return;
    }

    const canvas = renderer.domElement;
    canvas.setAttribute("aria-hidden", "true");
    container.appendChild(canvas);

    // Camera, point field, shaders, and trajectory follow ref_new.tsx exactly.
    // Dimensions are measured from the stage, leaving captions and audio visible.
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, -0.32, 3.7);
    camera.lookAt(0, 0.08, 0);

    const objectPos = new THREE.Vector2(-0.8, 0.6);
    const objectTrail = new THREE.Vector2(-0.8, 0.6);
    const uniforms = {
      uTime: { value: 0 },
      uBasePointSize: { value: 3.4 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uObjectPos: { value: new THREE.Vector2() },
      uObjectTrail: { value: new THREE.Vector2() },
      uFocusRadius: { value: 0.95 },
      uElevationHeight: { value: 0.58 }
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: membraneVertexShader,
      fragmentShader: membraneFragmentShader,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
    const points = new THREE.Points(new THREE.BufferGeometry(), material);
    points.frustumCulled = false;
    scene.add(points);

    let frustumWidth = 4;
    let frustumHeight = 2.5;
    let frame = 0;
    let previous = performance.now();
    let energy = 0;
    let contextLost = false;
    let disposed = false;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionQuery.matches;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height);
      uniforms.uPixelRatio.value = pixelRatio;

      const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.position.z;
      frustumWidth = visibleHeight * camera.aspect * 1.25;
      frustumHeight = visibleHeight * 1.25;
      const spacing = Math.max(0.062, Math.min(0.088, 2.6 / Math.sqrt(width * height / 300)));
      const cols = Math.max(45, Math.round(frustumWidth / spacing));
      const rows = Math.max(30, Math.round(frustumHeight / spacing));
      const positions = new Float32Array(cols * rows * 3);
      const stepX = frustumWidth / (cols - 1);
      const stepY = frustumHeight / (rows - 1);
      let index = 0;
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          positions[index] = -frustumWidth / 2 + col * stepX;
          positions[index + 1] = -frustumHeight / 2 + row * stepY;
          positions[index + 2] = 0;
          index += 3;
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      points.geometry.dispose();
      points.geometry = geometry;
    };

    const animate = (now: number) => {
      if (disposed || document.hidden || contextLost) return;
      const delta = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      uniforms.uTime.value += delta * (reducedMotion ? 0.125 : 0.575);
      const t = uniforms.uTime.value;
      const reachX = frustumWidth * 0.42;
      const reachY = frustumHeight * 0.40;
      objectPos.set(
        Math.sin(t * 0.85) * (reachX * 0.75) + Math.cos(t * 0.38) * (reachX * 0.25),
        Math.cos(t * 0.72) * (reachY * 0.70) + Math.sin(t * 0.45) * (reachY * 0.30)
      );
      uniforms.uObjectPos.value.copy(objectPos);
      objectTrail.lerp(objectPos, 0.08);
      uniforms.uObjectTrail.value.copy(objectTrail);
      camera.position.x = Math.sin(t * 0.3) * 0.08;
      camera.position.y = -0.32 + Math.cos(t * 0.25) * 0.05;

      // Preserve the microphone response without changing the reference's quiet appearance.
      const level = Number.isFinite(signalRef.current.level) ? signalRef.current.level : 0;
      energy = THREE.MathUtils.lerp(energy, THREE.MathUtils.clamp(level, 0, 1), 0.22);
      uniforms.uElevationHeight.value = 0.58 + energy * (reducedMotion ? 0.025 : 0.08);
      uniforms.uFocusRadius.value = 0.95 + energy * 0.045;

      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };

    const resume = () => {
      cancelAnimationFrame(frame);
      previous = performance.now();
      if (!disposed && !document.hidden && !contextLost) frame = requestAnimationFrame(animate);
    };
    const onVisibilityChange = () => resume();
    const onMotionChange = (event: MediaQueryListEvent) => { reducedMotion = event.matches; };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      cancelAnimationFrame(frame);
      setUnavailable(true);
    };
    const onContextRestored = () => {
      contextLost = false;
      setUnavailable(false);
      resize();
      resume();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    motionQuery.addEventListener("change", onMotionChange);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    resize();
    resume();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      motionQuery.removeEventListener("change", onMotionChange);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      scene.remove(points);
      points.geometry.dispose();
      material.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, []);

  return (
    <div ref={containerRef} className="avatar-shell membrane-field" role="img" aria-label="Audio-reactive spatial membrane dot field">
      {unavailable ? <span className="membrane-fallback" aria-hidden="true" /> : null}
    </div>
  );
}

class MembraneAvatarAdapter implements AvatarAdapter {
  readonly mode = "AUDIO_REACTIVE" as const;
  render(signal: AvatarSignal) { return <MembraneCanvas signal={signal} />; }
}
const avatarAdapter = new MembraneAvatarAdapter();

export function HologramAvatar({ signal }: { signal: AvatarSignal }) {
  return avatarAdapter.render(signal);
}
