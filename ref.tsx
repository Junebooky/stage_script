'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const vertexShader = `
varying vec2 v_uv;

void main() {
  v_uv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const fragmentShader = `
uniform float u_time;
uniform float u_aspect;
uniform vec2 u_mouse;
varying vec2 v_uv;

const float PI = 3.14159265358979;

mat4 rotationMatrix(vec3 axis, float angle) {
  axis = normalize(axis);
  float s = sin(angle);
  float c = cos(angle);
  float oc = 1.0 - c;
  
  return mat4(oc * axis.x * axis.x + c,           oc * axis.x * axis.y - axis.z * s,  oc * axis.z * axis.x + axis.y * s,  0.0,
              oc * axis.x * axis.y + axis.z * s,  oc * axis.y * axis.y + c,           oc * axis.y * axis.z - axis.x * s,  0.0,
              oc * axis.z * axis.x - axis.y * s,  oc * axis.y * axis.z + axis.x * s,  oc * axis.z * axis.z + c,           0.0,
              0.0,                                0.0,                                0.0,                                1.0);
}

vec3 rotate(vec3 v, vec3 axis, float angle) {
  mat4 m = rotationMatrix(axis, angle);
  return (m * vec4(v, 1.0)).xyz;
}

float fresnel(vec3 eye, vec3 normal) {
  return pow(1.0 + dot(eye, normal), 3.0);
}

float smin( float a, float b, float k ) {
  float h = clamp( 0.5+0.5*(b-a)/k, 0.0, 1.0 );
  return mix( b, a, h ) - k*h*(1.0-h);
}

float opUnion( float d1, float d2 ) { return min(d1,d2); }

float opSubtraction( float d1, float d2 ) { return max(-d1,d2); }

float opIntersection( float d1, float d2 ) { return max(d1,d2); }

float opSmoothSubtraction( float d1, float d2, float k ) {
  float h = clamp( 0.5 - 0.5*(d2+d1)/k, 0.0, 1.0 );
  return mix( d2, -d1, h ) + k*h*(1.0-h);
}

float sdSphere(vec3 p, float r) {
  return length(p) - r;
}

float ballGyroid(in vec3 p, float t) {
  float distortion = 8.0 * t + 1.0;
  p *= distortion;
  float g = 0.5 * dot(sin(p), cos(p.yzx)) / distortion;

  return g;
}

float sdf(vec3 p, float t, float time) {
  vec3 rp = rotate(p, vec3(0.3, 1.0, 0.2), time * 0.3);
  float sphere = sdSphere(p, 1.0);
  float g = ballGyroid(rp, t);

  float space = 1.0 - t;
  space *= 0.04;
  space += 0.02;
  float dist = smin(sphere, g, -0.01) + space;
  float dist2 = smin(sphere, -g, -0.01) + space;

  return opUnion(dist, dist2);
}

vec3 calcNormal(vec3 p, float t, float time) {
  const float h = 0.0001;
  const vec2 k = vec2(1, -1) * h;
  return normalize( k.xyy * sdf( p + k.xyy, t, time ) + 
                    k.yyx * sdf( p + k.yyx, t, time ) + 
                    k.yxy * sdf( p + k.yxy, t, time ) + 
                    k.xxx * sdf( p + k.xxx, t, time ) );
}

void main() {
  vec2 centeredUV = (v_uv - 0.5) * vec2(u_aspect, 1.0);
  vec3 ray = normalize(vec3(centeredUV, -1.0));

  vec2 m = u_mouse * vec2(u_aspect, 1.0) * 0.07;
  ray = rotate(ray, vec3(1.0, 0.0, 0.0), m.y);
  ray = rotate(ray, vec3(0.0, 1.0, 0.0), -m.x);

  vec3 camPos = vec3(0.0, 0.0, 3.5);
  
  vec3 rayPos = camPos;
  float totalDist = 0.0;
  float t = (sin(u_time * 0.5 + PI / 2.0) + 1.0) * 0.5;
  float tMax = 5.0;

  for(int i = 0; i < 256; i++) {
    float dist = sdf(rayPos, t, u_time);

    if (dist < 0.0001 || tMax < totalDist) break;

    totalDist += dist;
    rayPos = camPos + totalDist * ray;
  }

  vec3 color = vec3(0.07, 0.20, 0.35);

  float cLen = length(centeredUV);
  cLen = 1.0 - smoothstep(0.0, 0.7, cLen);
  color *= vec3(cLen);

  if(totalDist < tMax) {
    vec3 normal = calcNormal(rayPos, t, u_time);

    float d = length(rayPos);
    d = smoothstep(0.5, 1.0, d);
    color = mix(vec3(1.0, 0.5, 0.0), vec3(0.00, 0.00, 0.05), d);
    
    float _fresnel = fresnel(ray, normal);
    color += vec3(0.00, 0.48, 0.80) * _fresnel * 0.8;
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

type ThreeGyroidCanvasProps = {
  className?: string;
  hoverTargetRef?: React.RefObject<HTMLElement>;
};

export default function ThreeGyroidCanvas({ className, hoverTargetRef }: ThreeGyroidCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number>();
  const mouseTargetRef = useRef(new THREE.Vector2());
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const canvasEl = renderer.domElement;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);

    const geometry = new THREE.PlaneGeometry(2, 2);
    const uniforms = {
      u_time: { value: 0 },
      u_aspect: { value: container.clientWidth / container.clientHeight },
      u_mouse: { value: new THREE.Vector2() },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const clock = new THREE.Clock();

    const startHoverSound = async () => {
      let ctx = audioContextRef.current;
      if (!ctx) {
        try {
          ctx = new AudioContext();
          audioContextRef.current = ctx;
        } catch {
          return;
        }
      }
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          return;
        }
      }

      if (!audioBufferRef.current) {
        try {
          const response = await fetch('/bg_music/neon101_bg_02.MP3');
          const arrayBuffer = await response.arrayBuffer();
          audioBufferRef.current = await ctx.decodeAudioData(arrayBuffer);
        } catch {
          return;
        }
      }

      if (sourceRef.current) return;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 0.4);

      const source = ctx.createBufferSource();
      source.buffer = audioBufferRef.current;
      source.loop = true;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
      source.onended = () => {
        gain.disconnect();
        source.disconnect();
        if (sourceRef.current === source) {
          sourceRef.current = null;
        }
        if (gainRef.current === gain) {
          gainRef.current = null;
        }
      };

      sourceRef.current = source;
      gainRef.current = gain;
    };

    const stopHoverSound = () => {
      const ctx = audioContextRef.current;
      const source = sourceRef.current;
      const gain = gainRef.current;
      if (!ctx || !source || !gain) return;

      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
      source.stop(ctx.currentTime + 0.35);
    };

    const handleResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight || 1;
      renderer.setSize(width, height);
      uniforms.u_aspect.value = width / height;
    };

    const pointerTarget = hoverTargetRef?.current ?? canvasEl;

    const handlePointerMove = (event: PointerEvent) => {
      const rect = canvasEl.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      mouseTargetRef.current.set(x, y);
    };

    const handlePointerEnterOrDown = (event: PointerEvent) => {
      if (event.type === 'pointerdown' && canvasEl.hasPointerCapture?.(event.pointerId) === false) {
        try {
          canvasEl.setPointerCapture(event.pointerId);
        } catch {
          // ignore capture errors (e.g., unsupported scenarios)
        }
      }
      startHoverSound();
    };

    const handlePointerLeaveOrUp = (event: PointerEvent) => {
      if (canvasEl.hasPointerCapture?.(event.pointerId)) {
        try {
          canvasEl.releasePointerCapture(event.pointerId);
        } catch {
          // ignore release errors
        }
      }
      mouseTargetRef.current.set(0, 0);
      stopHoverSound();
    };

    const handleTouchStart = () => {
      startHoverSound();
    };

    const handleTouchEnd = () => {
      mouseTargetRef.current.set(0, 0);
      stopHoverSound();
    };

    const handleWindowResize = () => handleResize();

    window.addEventListener('resize', handleWindowResize);
    pointerTarget.addEventListener('pointermove', handlePointerMove);
    pointerTarget.addEventListener('pointerenter', handlePointerEnterOrDown);
    pointerTarget.addEventListener('pointerleave', handlePointerLeaveOrUp);
    canvasEl.addEventListener('pointerdown', handlePointerEnterOrDown);
    canvasEl.addEventListener('pointerup', handlePointerLeaveOrUp);
    const touchListenerOptions: AddEventListenerOptions = { passive: true };
    pointerTarget.addEventListener('touchstart', handleTouchStart, touchListenerOptions);
    pointerTarget.addEventListener('touchend', handleTouchEnd, touchListenerOptions);

    let isMounted = true;

    const animate = () => {
      if (!isMounted) return;
      const delta = clock.getDelta();
      uniforms.u_time.value += delta;
      uniforms.u_mouse.value.lerp(mouseTargetRef.current, 0.1);
      renderer.render(scene, camera);
      frameRef.current = requestAnimationFrame(animate);
    };

    handleResize();
    animate();

    return () => {
      isMounted = false;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', handleWindowResize);
      pointerTarget.removeEventListener('pointermove', handlePointerMove);
      pointerTarget.removeEventListener('pointerenter', handlePointerEnterOrDown);
      pointerTarget.removeEventListener('pointerleave', handlePointerLeaveOrUp);
      canvasEl.removeEventListener('pointerdown', handlePointerEnterOrDown);
      canvasEl.removeEventListener('pointerup', handlePointerLeaveOrUp);
      pointerTarget.removeEventListener('touchstart', handleTouchStart, touchListenerOptions);
      pointerTarget.removeEventListener('touchend', handleTouchEnd, touchListenerOptions);
      stopHoverSound();
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => null);
        audioContextRef.current = null;
      }
      audioBufferRef.current = null;
      if (sourceRef.current) {
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      if (gainRef.current) {
        gainRef.current.disconnect();
        gainRef.current = null;
      }
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div ref={containerRef} className={className ?? 'w-full h-full'} />;
}
