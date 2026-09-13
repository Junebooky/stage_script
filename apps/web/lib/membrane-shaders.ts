// GLSL preserved verbatim from the user's ref_new.tsx spatial membrane reference.
export const membraneVertexShader = `
      precision highp float;

      uniform float uTime;
      uniform float uBasePointSize;
      uniform float uPixelRatio;
      uniform vec2 uObjectPos;
      uniform vec2 uObjectTrail;
      uniform float uFocusRadius;
      uniform float uElevationHeight;

      varying float vFocusInfluence;
      varying float vElevation;
      varying float vDepthRatio;

      // Stefan Gustavson's Simplex 3D Noise Implementation
      vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
      vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

      float snoise(vec3 v){
        const vec2 C = vec2(1.0/6.0, 1.0/3.0);
        const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

        vec3 i  = floor(v + dot(v, C.yyy));
        vec3 x0 = v - i + dot(i, C.xxx);

        vec3 g = step(x0.yzx, x0.xyz);
        vec3 l = 1.0 - g;
        vec3 i1 = min(g.xyz, l.zxy);
        vec3 i2 = max(g.xyz, l.zxy);

        vec3 x1 = x0 - i1 + 1.0 * C.xxx;
        vec3 x2 = x0 - i2 + 2.0 * C.xxx;
        vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

        i = mod(i, 289.0);
        vec4 p = permute(permute(permute(
                    i.z + vec4(0.0, i1.z, i2.z, 1.0))
                  + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                  + i.x + vec4(0.0, i1.x, i2.x, 1.0));

        float n_ = 0.142857142857;
        vec3 ns = n_ * D.wyz - D.xzx;

        vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

        vec4 x_ = floor(j * ns.z);
        vec4 y_ = floor(j - 7.0 * x_);

        vec4 x = x_ *ns.x + ns.yyyy;
        vec4 y = y_ *ns.x + ns.yyyy;
        vec4 h = 1.0 - abs(x) - abs(y);

        vec4 b0 = vec4(x.xy, y.xy);
        vec4 b1 = vec4(x.zw, y.zw);

        vec4 s0 = floor(b0)*2.0 + 1.0;
        vec4 s1 = floor(b1)*2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));

        vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;

        vec3 p0 = vec3(a0.xy, h.x);
        vec3 p1 = vec3(a0.zw, h.y);
        vec3 p2 = vec3(a1.xy, h.z);
        vec3 p3 = vec3(a1.zw, h.w);

        vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
        p0 *= norm.x;
        p1 *= norm.y;
        p2 *= norm.z;
        p3 *= norm.w;

        vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
        m = m * m;
        return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
      }

      void main() {
        vec3 pos = position;

        // 1. Very subtle base background ripple (nearly planar to keep background ordered)
        float baseMicroRipple = sin(pos.x * 0.9 + uTime * 0.8) * cos(pos.y * 0.8 + uTime * 0.6) * 0.035;

        // 2. Localized 3D focus field around the actively moving entity
        float dHead = length(pos.xy - uObjectPos);
        // Organic edge distortion so the focus field does not feel like an artificial circle
        float noiseEdge = snoise(vec3(pos.xy * 1.8, uTime * 1.2)) * 0.16;
        float dDistorted = max(0.0, dHead + noiseEdge);

        // Smoothstep bell profile for the main moving body
        float focusHead = smoothstep(uFocusRadius, 0.0, dDistorted);
        focusHead = pow(focusHead, 1.4); // concentrated core

        // Secondary trailing wake following the movement path
        float dTrail = length(pos.xy - uObjectTrail);
        float focusTrail = smoothstep(uFocusRadius * 0.85, 0.0, dTrail + noiseEdge * 0.8) * 0.52;

        // Total concentrated 3D influence strictly around the moving object
        float totalInfluence = clamp(focusHead + focusTrail, 0.0, 1.5);
        vFocusInfluence = totalInfluence;

        // Elevated 3D dome / protrusion in Z-space only around the object
        float elevation = (totalInfluence * uElevationHeight) + baseMicroRipple;
        pos.z = elevation;
        vElevation = elevation;

        // 3. Project into 3D view coordinates
        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        // 4. Perspective distance attenuation & localized point scale up
        float distToCam = -mvPosition.z;
        vDepthRatio = clamp(3.2 / max(distToCam, 0.1), 0.5, 2.0);

        // Surrounding background dots remain small and calm; moving object dots scale up visibly
        float scaleMultiplier = 1.0 + (pow(totalInfluence, 1.3) * 2.85);

        gl_PointSize = uBasePointSize * uPixelRatio * vDepthRatio * scaleMultiplier;
      }
    `;

export const membraneFragmentShader = `
      precision highp float;

      varying float vFocusInfluence;
      varying float vElevation;
      varying float vDepthRatio;

      void main() {
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);

        // Perfect circular antialiased point shape
        if (dist > 0.5) {
          discard;
        }

        // Smooth point profile: crisp luminous center with gentle falloff at rim
        float alphaMask = smoothstep(0.49, 0.12, dist);

        // Ethereal dreamy blue palette (몽롱하고 신비로운 블루 톤)
        // Calm base background dots: deep, restrained celestial navy/blue
        vec3 colBase      = vec3(0.10, 0.22, 0.46);
        // Active body mid-elevation: rich, dreamy cerulean mist
        vec3 colActiveMid = vec3(0.35, 0.62, 0.95);
        // Peak crest: luminous soft ice-blue & pale crystalline glow
        vec3 colHighlight = vec3(0.82, 0.92, 1.00);

        // Smooth transition driven strictly by proximity to the moving object
        float inf = clamp(vFocusInfluence, 0.0, 1.2);
        vec3 dotColor = mix(colBase, colActiveMid, smoothstep(0.08, 0.65, inf));
        dotColor = mix(dotColor, colHighlight, smoothstep(0.65, 1.15, inf));

        // Background dots have gentle opacity; moving 3D object reaches full opacity & brightness
        float baseAlpha = 0.38;
        float finalAlpha = mix(baseAlpha, 0.98, smoothstep(0.05, 0.75, inf)) * alphaMask;

        gl_FragColor = vec4(dotColor, finalAlpha);
      }
    `;
