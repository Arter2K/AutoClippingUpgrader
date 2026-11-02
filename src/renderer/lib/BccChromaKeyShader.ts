import { keyRgb, morphologyPasses, type BccChromaConfig } from '../../shared/bcc-chroma';

const vertex = `#version 300 es
in vec2 a_position; out vec2 v_uv;
void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;
const fragment = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 outColor;
uniform sampler2D u_input,u_foreground,u_matte,u_background,u_blurred;
uniform int u_pass,u_view,u_expand,u_blue,u_native;
uniform vec2 u_texel,u_direction;
uniform vec3 u_key,u_weights;
uniform float u_similarity,u_fraction,u_sigma,u_black,u_white,u_gamma,u_strength,u_balance,u_restore,u_wrap;
vec3 ycbcr(vec3 c){return vec3(dot(c,vec3(.299,.587,.114)),dot(c,vec3(-.169,-.331,.5)),dot(c,vec3(.5,-.419,-.081)));}
void main(){
  if(u_pass==0){
    vec3 a=ycbcr(texture(u_foreground,v_uv).rgb),b=ycbcr(u_key);
    float d=length(vec3((a.y-b.y)*u_weights.x,(a.z-b.z)*u_weights.y,(a.x-b.x)*u_weights.z));
    if(u_native==1){
      if(max(max(u_key.r,u_key.g),u_key.b)-min(min(u_key.r,u_key.g),u_key.b)<10./255.)d=length(texture(u_foreground,v_uv).rgb-u_key)/sqrt(3.);
      else {d=0.;for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){
        vec3 delta=texture(u_foreground,v_uv+vec2(float(x),float(y))*u_texel).rgb-u_key;
        d+=length(vec2(dot(delta,vec3(-.148,-.291,.439)),dot(delta,vec3(.439,-.368,-.071))))/sqrt(2.);
      }d/=9.;}
    }
    float m=clamp((d-u_similarity)/.25,0.,1.);outColor=vec4(vec3(m),1.);return;
  }
  if(u_pass==1){
    float center=texture(u_input,v_uv).r,m=center;
    for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){
      float a=texture(u_input,v_uv+vec2(float(x),float(y))*u_texel).r;
      m=u_expand==1?max(m,a):min(m,a);
    }
    outColor=vec4(vec3(mix(center,m,u_fraction)),1.);return;
  }
  if(u_pass==2){
    vec4 sum=vec4(0.);float total=0.;int radius=int(ceil(3.*u_sigma));
    for(int i=-90;i<=90;i++){if(abs(i)>radius)continue;
      float w=exp(-float(i*i)/(2.*u_sigma*u_sigma));sum+=texture(u_input,v_uv+float(i)*u_direction*u_texel)*w;total+=w;
    }
    outColor=sum/max(.00001,total);return;
  }
  if(u_pass==3){
    float a=pow(clamp((texture(u_input,v_uv).r-u_black)/(u_white-u_black),0.,1.),1./u_gamma);
    a*=texture(u_foreground,v_uv).a;outColor=vec4(vec3(a),1.);return;
  }
  vec4 fg=texture(u_foreground,v_uv);float a=texture(u_matte,v_uv).r;
  if(u_view==2){outColor=fg;return;}
  if(u_view==1){outColor=vec4(vec3(a),1.);return;}
  float spill=max(0.,(u_blue==1?fg.b:fg.g)-(fg.r*u_balance+(u_blue==1?fg.g:fg.b)*(1.-u_balance)))*u_strength;
  float restore=u_restore*(u_blue==1?.114:.587);
  vec3 rgb=clamp(fg.rgb+spill*vec3(restore,restore-(u_blue==1?0.:1.),restore-(u_blue==1?1.:0.)),0.,1.);
  float edge=clamp(4.*a*(1.-texture(u_blurred,v_uv).r)*u_wrap,0.,1.);
  rgb=mix(rgb,texture(u_background,v_uv).rgb,edge);outColor=vec4(rgb,a);
}`;

/** Multipass WebGL2 matte processing; no readPixels or CPU pixel loop in playback. */
export class BccChromaKeyShader {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private textures: WebGLTexture[] = [];
  private frames: WebGLFramebuffer[] = [];
  private buffer: WebGLBuffer;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private width = 0; private height = 0; private lost = false;
  lastPassCount = 0;
  constructor() {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('Для BCC-превью требуется WebGL2. Доступен контрольный кадр FFmpeg.');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(`BCC shader: ${message}`); }
      return shader;
    };
    const v = compile(gl.VERTEX_SHADER, vertex), f = compile(gl.FRAGMENT_SHADER, fragment), program = gl.createProgram()!;
    gl.attachShader(program, v); gl.attachShader(program, f); gl.linkProgram(program); gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`BCC shader link: ${gl.getProgramInfoLog(program)}`);
    this.program = program; gl.useProgram(program);
    this.buffer = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'a_position'); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    for (let i = 0; i < 8; i++) { this.textures.push(gl.createTexture()!); this.frames.push(gl.createFramebuffer()!); }
    ['u_input','u_foreground','u_matte','u_background','u_blurred'].forEach((name, i) => gl.uniform1i(this.u(name), i));
  }
  private u(name: string) { if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name)); return this.uniforms.get(name)!; }
  private bind(unit: number, texture: number) { this.gl.activeTexture(this.gl.TEXTURE0 + unit); this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures[texture]!); }
  private pass(mode: number, input: number, target: number | null) {
    const gl = this.gl;
    // Avoid framebuffer feedback through samplers from another dynamic shader branch.
    if (mode !== 4) { this.bind(1, 0); this.bind(2, 0); this.bind(3, 0); this.bind(4, 0); }
    this.bind(0, input); gl.uniform1i(this.u('u_pass'), mode);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target === null ? null : this.frames[target]!); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); this.lastPassCount++;
  }
  private blur(input: number, output: number, temp: number, sigma: number) {
    const gl = this.gl; gl.uniform1f(this.u('u_sigma'), Math.max(.01, sigma));
    gl.uniform2f(this.u('u_direction'), 1, 0); this.pass(2, input, temp);
    gl.uniform2f(this.u('u_direction'), 0, 1); this.pass(2, temp, output);
  }
  render(source: TexImageSource, background: TexImageSource, config: BccChromaConfig, width: number, height: number, pixelScale = 1): HTMLCanvasElement {
    const gl = this.gl; if (this.lost || gl.isContextLost()) throw new Error('Контекст WebGL2 потерян. Переоткройте проект; экспорт FFmpeg доступен.');
    width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
    if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('Слой превышает размер WebGL2-текстуры');
    gl.useProgram(this.program);
    if (width !== this.width || height !== this.height) {
      this.width = this.canvas.width = width; this.height = this.canvas.height = height;
      for (let i = 0; i < this.textures.length; i++) {
        this.bind(0, i); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.frames[i]!); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.textures[i]!, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('BCC WebGL2 framebuffer allocation failed');
      }
    }
    gl.viewport(0, 0, width, height); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.bind(1, 0); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.bind(3, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, background);
    this.bind(2, 4); this.bind(4, 5);
    const p = config.primary_key, m = config.matte_cleanup, s = config.spill_suppression;
    gl.uniform2f(this.u('u_texel'), 1 / width, 1 / height); gl.uniform3fv(this.u('u_key'), keyRgb(p.key_color));
    gl.uniform3f(this.u('u_weights'), p.hue_weight, p.saturation_weight, p.luma_weight);
    gl.uniform1f(this.u('u_similarity'), p.similarity); gl.uniform1f(this.u('u_black'), m.black_clip); gl.uniform1f(this.u('u_white'), m.white_clip); gl.uniform1f(this.u('u_gamma'), m.matte_gamma);
    gl.uniform1i(this.u('u_native'), Number(p.hue_weight === 1 && p.saturation_weight === 1 && p.luma_weight === 0));
    const blue = keyRgb(p.key_color)[2] > keyRgb(p.key_color)[1]; gl.uniform1i(this.u('u_blue'), Number(blue));
    gl.uniform1f(this.u('u_strength'), s.enabled ? s.strength : 0); gl.uniform1f(this.u('u_balance'), s.balance); gl.uniform1f(this.u('u_restore'), Number(s.restore_luminance));
    gl.uniform1f(this.u('u_wrap'), config.light_wrap.enabled ? config.light_wrap.intensity : 0);
    gl.uniform1i(this.u('u_view'), config.view_mode === 'alpha_matte' ? 1 : config.view_mode === 'source_only' ? 2 : 0);
    this.lastPassCount = 0; this.pass(0, 0, 2); let matte = 2;
    const morph = morphologyPasses(m.matte_choke_px * pixelScale); gl.uniform1i(this.u('u_expand'), Number(morph.expand));
    for (let i = 0; i < morph.count + Number(morph.fraction > 0); i++) {
      const next = matte === 2 ? 3 : 2; gl.uniform1f(this.u('u_fraction'), i < morph.count ? 1 : morph.fraction); this.pass(1, matte, next); matte = next;
    }
    if (m.matte_softness_px > 0) { const next = matte === 2 ? 3 : 2; this.blur(matte, next, 7, m.matte_softness_px * pixelScale); matte = next; }
    this.pass(3, matte, 4);
    if (config.light_wrap.enabled && config.light_wrap.intensity > 0) {
      this.blur(4, 5, 7, config.light_wrap.width_px * pixelScale); this.blur(1, 6, 7, config.light_wrap.width_px * pixelScale); this.bind(3, 6);
    } else { this.bind(4, 4); }
    this.bind(1, 0); this.bind(2, 4); if (config.light_wrap.enabled && config.light_wrap.intensity > 0) this.bind(4, 5);
    this.pass(4, 0, null); return this.canvas;
  }
  dispose() { const gl = this.gl; for (const f of this.frames) gl.deleteFramebuffer(f); for (const t of this.textures) gl.deleteTexture(t); gl.deleteBuffer(this.buffer); gl.deleteProgram(this.program); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
