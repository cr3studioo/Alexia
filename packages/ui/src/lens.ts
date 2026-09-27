// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **Alexia's own glass**, for the rail's two switchers: the pill under *How she runs* and the
 * knob on *What she may do*.
 *
 * CSS can blur what is behind a shape, and that is all it can do. Glass does something else
 * — it *bends* the picture: the middle is magnified a little, the rim pulls in the painting
 * from just outside the shape, and where it bends most the colours split into a thin rainbow.
 * One small WebGL program does that here. It redraws the painting (the same bitmap the body
 * is painted with, `--ground`) inside a rounded shape, frosted and tinted like the rail it sits
 * in, with a lit rim and a highlight from the top left.
 *
 * **Cheap per frame, because it draws every frame the glass moves.** The frost is done once,
 * not per pixel per frame: the painting is shrunk to a quarter and softened when it loads
 * (`frosted`), and the shader reads that small copy three times a pixel — once per colour, for
 * the rainbow. It used to blur the full painting in the shader, sixty-three reads a pixel every
 * frame, and the glass stuttered. Nothing is measured per frame either: where the canvas and
 * the page sit is read when they move (`measure`), and the shape comes from the switch, which
 * already knows it, rather than from the layout.
 *
 * **It only draws when asked.** The switch asks once a frame while its glass moves (the same
 * frame it moves the rest, so the two never drift apart), and a resize, a scroll of the rail,
 * the theme or the panel glass changing ask once each. No loop runs at rest.
 *
 * When WebGL is not there, `mountLens` answers `undefined` and the caller keeps CSS frosted
 * glass instead (`.no-gl` in app.css). On a Mac with macOS 26 the switchers can use Apple's
 * glass instead (`desktop.ts`, `glass`).
 *
 * No Node in here, ever (invariant 6).
 */

/** How the glass looks. `mix` is how much panel colour tints it. */
export interface LensLook {
  mix: number
  /** Pressed glass magnifies a little more — the swell under a finger. */
  pressed: () => boolean
}

/** A box in CSS pixels, from the top left of the lens's host. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Lens {
  /** One frame, now, of the shape where the switch says it is. `motion` 0–1 widens the rainbow. */
  draw: (motion?: number) => void
  /** Read again where the host sits on the page: it moved, or was laid out for the first time. */
  measure: () => void
  /** Take the canvas out and stop listening. */
  remove: () => void
}

const VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }'

/**
 * The glass itself. `S` is the shape in canvas pixels, `O` where the canvas sits on the
 * painting, `C` where the painting sits (its `cover` placement), `Pn` the panel's colour. `T`
 * is the painting already frosted (`frosted`), so one read is one frosted sample.
 *
 * A bevel only at the rim, shaped like a squircle: flat in the middle, steep at the edge. The
 * sample point is pulled outward along the rim's normal by the bevel, which is the bend. The
 * three colour channels are pulled by slightly different amounts — the rainbow fringe — and
 * more while the glass moves (`Mv`), because that is when the eye catches it on real glass.
 */
const FRAG = `
precision mediump float;
uniform sampler2D T; uniform vec2 R; uniform vec4 S; uniform float Rad; uniform vec2 O;
uniform vec4 C; uniform vec4 Pn; uniform float Mag; uniform float Dk;
uniform float Mix; uniform float Mv;
float sdf(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
vec3 frost(vec2 sp){ return texture2D(T, (sp - C.xy) / C.zw).rgb; }
void main(){
  vec2 px = vec2(gl_FragCoord.x, R.y - gl_FragCoord.y);
  vec2 hb = S.zw * 0.5; vec2 c = S.xy + hb; vec2 l = px - c;
  float d = sdf(l, hb, Rad);
  if (d > 1.0) discard;
  float edgeW = min(hb.x, hb.y) * 0.62;
  float t = clamp(-d / edgeW, 0., 1.);
  vec2 e = vec2(1., 0.);
  vec2 n = normalize(vec2(sdf(l + e.xy, hb, Rad) - sdf(l - e.xy, hb, Rad), sdf(l + e.yx, hb, Rad) - sdf(l - e.yx, hb, Rad)) + 1e-5);
  float x = 1. - t;
  float bend = 1. - pow(max(1. - x * x * x * x, 0.), 0.25);
  bend = pow(x, 3.0) * 0.6 + bend * 0.4;
  vec2 sp = O + c + l * Mag + n * bend * edgeW * 1.5;
  float ca = bend * (1.6 + 4.0 * Mv);
  vec3 col = vec3(frost(sp + n * ca).r, frost(sp).g, frost(sp - n * ca).b);
  col = mix(col, Pn.rgb, Pn.a * Mix);
  col = col * (1.05 + 0.05 * Dk) + 0.025;
  vec2 light = normalize(vec2(-0.62, -0.78));
  float rim = 1. - smoothstep(0., 3.2, -d);
  float band = 1. - smoothstep(0., edgeW * 0.6, -d);
  float lit = max(dot(n, light), 0.);
  float low = max(dot(n, -light), 0.);
  col += rim * (0.38 + 1.0 * lit);
  col += rim * low * 0.3;
  col += band * lit * 0.2;
  col -= band * low * 0.1;
  vec2 spot = (l - vec2(-hb.x * 0.55, -hb.y * 0.55)) / max(hb, vec2(1.));
  col += exp(-dot(spot, spot) * 6.0) * 0.14 * (1. - 0.4 * Dk);
  col += (1. - smoothstep(0., hb.y * 0.8, l.y + hb.y)) * 0.1;
  float a = 1. - smoothstep(-0.6, 0.6, d);
  gl_FragColor = vec4(min(col, 1.) * a, a);
}`

/** The painting, once per file, shared by every lens on the page. */
const paintings = new Map<string, Promise<HTMLImageElement>>()

const painting = (src: string): Promise<HTMLImageElement> => {
  let known = paintings.get(src)
  if (!known) {
    known = new Promise((done, fail) => {
      const img = new Image()
      img.onload = () => done(img)
      img.onerror = () => fail(new Error(`no painting at ${src}`))
      img.src = src
    })
    paintings.set(src, known)
  }
  return known
}

/**
 * Softens RGBA pixels in place: each one averaged with its neighbours, three across and then
 * three down, the edges repeating. On the quarter-size painting that is about the frost the
 * shader used to work out per pixel — a glass that lets the colours of the painting through
 * as a soft wave, without its detail.
 */
export function soften(data: Uint8ClampedArray, width: number, height: number): void {
  const copy = new Float32Array(data.length)
  const pass = (from: ArrayLike<number>, to: { [i: number]: number }, across: boolean): void => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4
        const before = across ? (y * width + Math.max(0, x - 1)) * 4 : (Math.max(0, y - 1) * width + x) * 4
        const after = across ? (y * width + Math.min(width - 1, x + 1)) * 4 : (Math.min(height - 1, y + 1) * width + x) * 4
        for (let c = 0; c < 4; c += 1) to[at + c] = (from[before + c]! + from[at + c]! + from[after + c]!) / 3
      }
    }
  }
  pass(data, copy, true)
  pass(copy, data, false)
}

/** The painting frosted once, at a quarter of its size, for every lens on the page. */
const frosts = new Map<string, Promise<HTMLCanvasElement | undefined>>()

const frosted = (src: string): Promise<HTMLCanvasElement | undefined> => {
  let known = frosts.get(src)
  if (!known) {
    known = painting(src).then((img) => {
      let from: CanvasImageSource = img
      let width = img.naturalWidth || img.width
      let height = img.naturalHeight || img.height
      let small: HTMLCanvasElement | undefined
      // Halved twice rather than quartered at once: each halving averages every pixel it
      // drops, where one big step would skip three in four and shimmer as the glass moves.
      for (let i = 0; i < 2; i += 1) {
        width = Math.max(1, Math.round(width / 2))
        height = Math.max(1, Math.round(height / 2))
        small = document.createElement('canvas')
        small.width = width
        small.height = height
        const pen = small.getContext('2d')
        if (!pen) return undefined
        pen.imageSmoothingEnabled = true
        pen.imageSmoothingQuality = 'high'
        pen.drawImage(from, 0, 0, width, height)
        from = small
      }
      const pen = small?.getContext('2d')
      if (!small || !pen) return undefined
      const pixels = pen.getImageData(0, 0, width, height)
      soften(pixels.data, width, height)
      pen.putImageData(pixels, 0, 0)
      return small
    })
    frosts.set(src, known)
  }
  return known
}

/**
 * Which file the body is painted with, read off `--ground` rather than written down again:
 * `url('/theme-dark.webp')` in the sheet, and the browser may hand it back quoted or not.
 */
export const groundUrl = (value: string): string | undefined => /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(value)?.[1]

/**
 * Where a `cover` background lands in a box: scaled until it fills both ways, and centred —
 * the body's `center / cover`. In the same units as the box.
 */
export function coverBox(
  box: { width: number; height: number },
  image: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const scale = Math.max(box.width / image.width, box.height / image.height)
  const width = image.width * scale
  const height = image.height * scale
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height }
}

let swatch: CanvasRenderingContext2D | null | undefined

/**
 * Any CSS colour as four numbers 0–1. The rail's is a `color-mix` in oklab, which the browser
 * hands back in whatever notation it likes, so it is painted onto one pixel and read back
 * rather than parsed. Transparent when there is no 2D canvas either.
 */
export function rgba(colour: string): [number, number, number, number] {
  swatch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!swatch) return [0, 0, 0, 0]
  swatch.clearRect(0, 0, 1, 1)
  swatch.fillStyle = colour
  swatch.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = swatch.getImageData(0, 0, 1, 1).data
  return [r / 255, g / 255, b / 255, a / 255]
}

const dark = (): boolean => {
  const theme = document.documentElement.dataset.theme
  return theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * A lens over `host`: a canvas filling it, drawing the glass wherever `shape` says — a box from
 * the host's top left, which the switch keeps as it moves its glass, so nothing is read off the
 * layout per frame. `undefined` when WebGL is not there or the program will not build.
 */
export function mountLens(host: HTMLElement, shape: () => Box | undefined, look: LensLook): Lens | undefined {
  const canvas = document.createElement('canvas')
  canvas.className = 'lens'
  canvas.setAttribute('aria-hidden', 'true')
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false })
  if (!gl) return undefined
  const compile = (type: number, source: string): WebGLShader | null => {
    const one = gl.createShader(type)
    if (!one) return null
    gl.shaderSource(one, source)
    gl.compileShader(one)
    return one
  }
  const program = gl.createProgram()
  const vert = compile(gl.VERTEX_SHADER, VERT)
  const frag = compile(gl.FRAGMENT_SHADER, FRAG)
  if (!vert || !frag) return undefined
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const corner = gl.getAttribLocation(program, 'p')
  gl.enableVertexAttribArray(corner)
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)
  const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name)
  const U = {
    T: at('T'), R: at('R'), S: at('S'), Rad: at('Rad'), O: at('O'), C: at('C'), Pn: at('Pn'),
    Mag: at('Mag'), Dk: at('Dk'), Mix: at('Mix'), Mv: at('Mv'),
  }
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.uniform1i(U.T, 0)
  host.prepend(canvas)

  /** The painting's own size, for its `cover` placement; the texture is the frosted copy. */
  let image: { width: number; height: number } | undefined
  let loaded = ''
  let panel: [number, number, number, number] = [0, 0, 0, 0]
  let isDark = false
  // Where things sit, read by `measure` when they move and not per frame.
  let own = { left: 0, top: 0, width: 0, height: 0 }
  let cover = { left: 0, top: 0, width: 0, height: 0 }
  let dpr = 1

  const measure = (): void => {
    const box = canvas.getBoundingClientRect()
    const ground = document.documentElement.getBoundingClientRect()
    // Two is all a Retina screen has; a bigger ratio (a zoomed page) only multiplies the work.
    dpr = Math.min(devicePixelRatio || 1, 2)
    own = { left: box.left - ground.left, top: box.top - ground.top, width: box.width, height: box.height }
    // The painting covers the whole window, the way the body is painted (`center / cover`),
    // so the glass shows the very part of it that is behind the rail at this spot.
    if (image) cover = coverBox({ width: ground.width, height: innerHeight }, image)
    const width = Math.round(own.width * dpr)
    const height = Math.round(own.height * dpr)
    if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
      canvas.width = width
      canvas.height = height
    }
  }

  /** Reads the theme's painting and the rail's colour again: a theme or a glass change. */
  const refresh = (): void => {
    const root = getComputedStyle(document.documentElement)
    const surface = host.closest<HTMLElement>('.panel') ?? document.body
    panel = rgba(getComputedStyle(surface).backgroundColor)
    isDark = dark()
    const src = groundUrl(root.getPropertyValue('--ground'))
    if (!src || src === loaded) {
      measure()
      draw()
      return
    }
    loaded = src
    void Promise.all([painting(src), frosted(src)]).then(
      ([one, frost]) => {
        if (loaded !== src || !frost) return
        image = { width: one.naturalWidth || one.width, height: one.naturalHeight || one.height }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frost)
        measure()
        draw()
      },
      () => undefined,
    )
  }

  const draw = (motion = 0): void => {
    const box = shape()
    if (!image || !box || document.hidden || canvas.width === 0 || canvas.height === 0) return
    const { width, height } = canvas
    gl.viewport(0, 0, width, height)
    gl.uniform2f(U.R, width, height)
    gl.uniform4f(U.S, box.left * dpr, box.top * dpr, box.width * dpr, box.height * dpr)
    gl.uniform1f(U.Rad, (Math.min(box.width, box.height) / 2) * dpr)
    gl.uniform2f(U.O, own.left * dpr, own.top * dpr)
    gl.uniform4f(U.C, cover.left * dpr, cover.top * dpr, cover.width * dpr, cover.height * dpr)
    gl.uniform4f(U.Pn, ...panel)
    gl.uniform1f(U.Mix, look.mix)
    gl.uniform1f(U.Mag, look.pressed() ? 0.84 : 0.9)
    gl.uniform1f(U.Dk, isDark ? 1 : 0)
    gl.uniform1f(U.Mv, Math.max(0, Math.min(1, motion)))
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  const moved = (): void => {
    measure()
    draw()
  }
  const scheme = matchMedia('(prefers-color-scheme: dark)')
  // The theme lives on the root's `data-theme`; the panel glass on its `style` (theme.ts).
  const watch = new MutationObserver(refresh)
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
  scheme.addEventListener('change', refresh)
  addEventListener('resize', moved)
  // The rail scrolls, and the canvas with it, over a painting that stays put.
  document.addEventListener('scroll', moved, { capture: true, passive: true })
  refresh()

  return {
    draw,
    measure,
    remove: () => {
      watch.disconnect()
      scheme.removeEventListener('change', refresh)
      removeEventListener('resize', moved)
      document.removeEventListener('scroll', moved, { capture: true })
      canvas.remove()
    },
  }
}
