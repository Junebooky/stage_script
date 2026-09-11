// Shader source supplied in ref.tsx. Keep the SDF, ray marching and palette unchanged.
export const vertexShader = `
varying vec2 v_uv;

void main() {
  v_uv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

export const fragmentShader = `
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
