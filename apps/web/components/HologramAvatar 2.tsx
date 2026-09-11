"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

export interface AvatarSignal {
  level: number;
  bands: number[];
  speechActive: boolean;
}

export interface AvatarAdapter {
  readonly mode: "VISEME" | "AUDIO_REACTIVE";
  render(signal: AvatarSignal): React.ReactNode;
}

function ParticleField({ intensity }: { intensity: number }) {
  const pointsRef = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const values = new Float32Array(210 * 3);
    for (let index = 0; index < 210; index += 1) {
      const angle = index * 2.39996;
      const radius = 1.4 + ((index * 37) % 100) / 55;
      values[index * 3] = Math.cos(angle) * radius;
      values[index * 3 + 1] = ((index * 73) % 220) / 55 - 2;
      values[index * 3 + 2] = Math.sin(angle) * radius - 0.3;
    }
    return values;
  }, []);

  useFrame((_, delta) => {
    if (!pointsRef.current) return;
    pointsRef.current.rotation.y += delta * (0.025 + intensity * 0.08);
    const material = pointsRef.current.material;
    if (!Array.isArray(material)) material.opacity = 0.16 + intensity * 0.38;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#55f4d2" size={0.018} transparent opacity={0.2} depthWrite={false} />
    </points>
  );
}

function ReactiveCore({ signal }: { signal: AvatarSignal }) {
  const groupRef = useRef<THREE.Group>(null);
  const innerRef = useRef<THREE.Mesh>(null);
  const mouthRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Group>(null);
  const easedRef = useRef(0);

  useFrame((state, delta) => {
    easedRef.current = THREE.MathUtils.lerp(easedRef.current, signal.level, 0.24);
    const energy = easedRef.current;
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.22) * 0.18;
      groupRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.31) * 0.035;
      groupRef.current.position.y = Math.sin(state.clock.elapsedTime * 0.72) * 0.045;
      groupRef.current.scale.setScalar(1 + energy * 0.035);
    }
    if (innerRef.current) innerRef.current.scale.setScalar(0.77 + energy * 0.16);
    if (mouthRef.current) {
      mouthRef.current.scale.y = 0.18 + energy * 1.55;
      mouthRef.current.scale.x = 0.7 + (signal.bands[1] ?? 0) * 0.35;
    }
    if (ringRef.current) ringRef.current.rotation.z += delta * (0.08 + energy * 0.9);
  });

  return (
    <group ref={groupRef}>
      <mesh scale={[0.82, 1.08, 0.72]}>
        <icosahedronGeometry args={[1.05, 4]} />
        <meshPhysicalMaterial
          color="#071d20"
          emissive="#0d4f4b"
          emissiveIntensity={signal.speechActive ? 0.75 : 0.3}
          roughness={0.2}
          metalness={0.72}
          transparent
          opacity={0.82}
          wireframe
        />
      </mesh>
      <mesh ref={innerRef} scale={[0.77, 0.95, 0.68]}>
        <icosahedronGeometry args={[1, 2]} />
        <meshStandardMaterial color="#092226" emissive="#13a894" emissiveIntensity={0.24} roughness={0.5} />
      </mesh>
      <mesh position={[-0.34, 0.18, 0.72]} scale={[0.2, 0.035, 0.035]}>
        <sphereGeometry args={[1, 24, 12]} />
        <meshBasicMaterial color="#d9fff7" />
      </mesh>
      <mesh position={[0.34, 0.18, 0.72]} scale={[0.2, 0.035, 0.035]}>
        <sphereGeometry args={[1, 24, 12]} />
        <meshBasicMaterial color="#d9fff7" />
      </mesh>
      <mesh ref={mouthRef} position={[0, -0.35, 0.75]} scale={[0.72, 0.2, 0.05]}>
        <sphereGeometry args={[0.28, 32, 12]} />
        <meshBasicMaterial color="#69ffe4" transparent opacity={0.9} />
      </mesh>
      <group ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
        <mesh>
          <torusGeometry args={[1.45, 0.006, 8, 120]} />
          <meshBasicMaterial color="#44e8cb" transparent opacity={0.33} />
        </mesh>
        <mesh rotation={[0.4, 0.15, 0]}>
          <torusGeometry args={[1.7, 0.004, 8, 120]} />
          <meshBasicMaterial color="#289bff" transparent opacity={0.2} />
        </mesh>
      </group>
    </group>
  );
}

class GenericAudioReactiveAvatar implements AvatarAdapter {
  readonly mode = "AUDIO_REACTIVE" as const;

  render(signal: AvatarSignal) {
    return <ReactiveCore signal={signal} />;
  }
}

const avatarAdapter = new GenericAudioReactiveAvatar();

export function HologramAvatar({ signal }: { signal: AvatarSignal }) {
  return (
    <div className="avatar-shell" aria-label="Audio-reactive holographic avatar">
      <Canvas camera={{ position: [0, 0.1, 4.8], fov: 42 }} dpr={[1, 1.6]} gl={{ antialias: true, alpha: true }}>
        <fog attach="fog" args={["#03090b", 4, 9]} />
        <ambientLight intensity={0.42} />
        <pointLight position={[2.5, 2, 3]} color="#76ffe8" intensity={12} distance={8} />
        <pointLight position={[-3, -1, 2]} color="#248cff" intensity={7} distance={7} />
        <ParticleField intensity={signal.level} />
        {avatarAdapter.render(signal)}
      </Canvas>
      <div className="avatar-scan" />
      <span className="adapter-tag">AVATAR / {avatarAdapter.mode}</span>
    </div>
  );
}
