"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { fragmentShader, vertexShader } from "@/lib/gyroid-shaders";

export interface AvatarSignal {
  level: number;
  bands: number[];
  speechActive: boolean;
}

export interface AvatarAdapter {
  readonly mode: "VISEME" | "AUDIO_REACTIVE";
  render(signal: AvatarSignal): ReactNode;
}

function GyroidCanvas({ signal }: { signal: AvatarSignal }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const signalRef = useRef(signal);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => { signalRef.current = signal; }, [signal]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setUnavailable(true);
      return;
    }

    // The reference's actual ray-marched gyroid, not approximating it with meshes.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    const geometry = new THREE.PlaneGeometry(2, 2);
    const uniforms = {
      u_time: { value: 0 },
      u_aspect: { value: 1 },
      u_mouse: { value: new THREE.Vector2() }
    };
    const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms });
    scene.add(new THREE.Mesh(geometry, material));
    const pointer = new THREE.Vector2();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      renderer.setSize(Math.max(1, width), Math.max(1, height));
      uniforms.u_aspect.value = width / Math.max(1, height);
    };
    const move = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, (event.clientY - rect.top) / rect.height * 2 - 1);
    };
    const leave = () => pointer.set(0, 0);
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerleave", leave);
    resize();

    let frame = 0;
    let previous = performance.now();
    let energy = 0;
    const animate = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      energy = THREE.MathUtils.lerp(energy, signalRef.current.level, 0.22);
      if (!reducedMotion.matches) {
        uniforms.u_time.value += delta * (1 + energy * 0.18);
        uniforms.u_mouse.value.lerp(pointer, 0.1);
      }
      // Only a subtle audio pulse is added; the reference shader is unchanged.
      renderer.domElement.style.setProperty("--audio-pulse", String(1 + energy * 0.035));
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerleave", leave);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div ref={containerRef} className="avatar-shell" aria-label="Audio-reactive gyroid">
      {unavailable ? <span className="avatar-fallback" aria-hidden="true" /> : null}
    </div>
  );
}

class GyroidAvatarAdapter implements AvatarAdapter {
  readonly mode = "AUDIO_REACTIVE" as const;
  render(signal: AvatarSignal) { return <GyroidCanvas signal={signal} />; }
}
const avatarAdapter = new GyroidAvatarAdapter();

export function HologramAvatar({ signal }: { signal: AvatarSignal }) {
  return avatarAdapter.render(signal);
}
