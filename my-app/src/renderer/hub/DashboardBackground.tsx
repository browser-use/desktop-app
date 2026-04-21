import React, { useEffect, useRef } from 'react';

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
out vec4 fragColor;
uniform vec2 u_resolution;
uniform float u_time;

// Sine band: density 0..1 from perpendicular distance to a sine curve across the width.
float sineBand(vec2 uv, float aspect, float t) {
  float x = uv.x * aspect;
  float width = aspect;
  // One wavelength across width. Very slow drift so it feels alive but nearly static.
  float phase = (x / width) * 6.2831853 + t * 0.12;
  float curveY = 0.5 + sin(phase) * 0.14 + sin(t * 0.25) * 0.01;
  float d = abs(uv.y - curveY);
  float thickness = 0.20;
  float band = 1.0 - smoothstep(0.0, thickness, d);
  return clamp(band, 0.0, 1.0);
}

void main() {
  float aspect = u_resolution.x / u_resolution.y;

  // Uniform dot lattice in pixel space.
  float DOT_SPACING = 12.0;
  float MAX_RADIUS  = 3.2;
  vec2 cell = floor(gl_FragCoord.xy / DOT_SPACING);
  vec2 cellCenter = (cell + 0.5) * DOT_SPACING;
  float distPx = length(gl_FragCoord.xy - cellCenter);

  // Sample density at each cell center so all pixels of one dot share the same size.
  vec2 cellUv = cellCenter / u_resolution;
  float density = sineBand(cellUv, aspect, u_time);

  // Nonlinear radius curve: stays small across most of the band, ramps up sharply near the peak.
  float sizeCurve = pow(density, 3.0);
  float radius = MAX_RADIUS * sizeCurve;
  float dotMask = 1.0 - smoothstep(radius - 0.6, radius + 0.4, distPx);
  // Kill dots where density is basically zero so the edges fade cleanly.
  dotMask *= smoothstep(0.02, 0.12, density);

  vec3 dotColor = vec3(0.32, 0.38, 0.52);
  vec3 bg = vec3(0.027, 0.027, 0.035);
  fragColor = vec4(mix(bg, dotColor, dotMask * 0.55), 1.0);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

export function DashboardBackground(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) {
      console.warn('[DashboardBackground] WebGL2 unavailable');
      return;
    }

    let program: WebGLProgram | null = null;
    try {
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      program = gl.createProgram();
      if (!program) throw new Error('createProgram failed');
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
      }
    } catch (err) {
      console.error('[DashboardBackground] shader setup failed', err);
      return;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const resLoc = gl.getUniformLocation(program, 'u_resolution');
    const timeLoc = gl.getUniformLocation(program, 'u_time');

    gl.useProgram(program);

    const dpr = 1;

    const resize = () => {
      const w = canvas.clientWidth * dpr;
      const h = canvas.clientHeight * dpr;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    let raf = 0;
    let running = true;
    const start = performance.now();

    const render = () => {
      if (!running) return;
      const t = (performance.now() - start) / 1000;
      gl.uniform2f(resLoc, canvas.width, canvas.height);
      gl.uniform1f(timeLoc, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(render);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  return <canvas ref={canvasRef} className="dashboard__bg" aria-hidden="true" />;
}

export default DashboardBackground;
