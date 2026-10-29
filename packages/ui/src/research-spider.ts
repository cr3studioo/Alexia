// SPDX-License-Identifier: AGPL-3.0-only
export interface Point { x: number; y: number }
interface Foot extends Point { from: Point; to: Point; progress: number; grounded: boolean }
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
const turn = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle))
const rotate = (p: Point, angle: number, origin: Point): Point => ({ x: origin.x + p.x * Math.cos(angle) - p.y * Math.sin(angle), y: origin.y + p.x * Math.sin(angle) + p.y * Math.cos(angle) })
const footAt = (i: number): Point => ({ x: [-27, -12, 13, 28][i % 4]!, y: (i < 4 ? -1 : 1) * [24, 33, 33, 24][i % 4]! })

/** Fast pursuit with planted feet. Gait comes from travel and turns, never an idle wave. */
export class ResearchSpider {
  position: Point
  heading = -Math.PI / 2
  speed = 0
  lift = 0
  grip = 0
  readonly feet: Foot[] = []
  #target: Point
  #time?: number
  #travel = 0
  #ground?: readonly Point[]
  #walking = false
  #jump?: { from: Point; to: Point; at: number; duration: number; height: number }

  constructor(position: Point) {
    this.position = { ...position }; this.#target = { ...position }
    for (let i = 0; i < 8; i++) {
      const point = rotate(footAt(i), this.heading, this.position)
      this.feet.push({ ...point, from: point, to: point, progress: 1, grounded: true })
    }
  }
  move(point: Point): void { this.#target = { ...point }; if (this.#jump) this.#jump.to = { ...point } }
  ground(points?: readonly Point[], walking = true): void { this.#ground = points; this.#walking = points !== undefined && walking }
  jump(point: Point, time: number): void {
    const length = distance(this.position, point)
    this.#target = { ...point }
    this.#jump = { from: { ...this.position }, to: { ...point }, at: time, duration: Math.min(230, 90 + length / 3), height: Math.min(30, 6 + length * .08) }
  }
  shift(delta: Point): void {
    const move = (point: Point): void => { point.x += delta.x; point.y += delta.y }
    move(this.position); move(this.#target)
    if (this.#jump) { move(this.#jump.from); move(this.#jump.to) }
    for (const foot of this.feet) { move(foot); foot.from = { x: foot.from.x + delta.x, y: foot.from.y + delta.y }; foot.to = { x: foot.to.x + delta.x, y: foot.to.y + delta.y } }
  }
  stop(): void { this.#target = { ...this.position }; this.speed = 0; this.#jump = undefined; this.lift = 0; this.grip = 0 }
  get airborne(): boolean { return this.#jump !== undefined }
  get arrived(): boolean { return distance(this.position, this.#target) < .6 }

  advance(time: number, instant = false): boolean {
    const dt = this.#time === undefined ? 1 / 30 : Math.max(0, Math.min(.05, (time - this.#time) / 1000))
    this.#time = time
    const dx = this.#target.x - this.position.x; const dy = this.#target.y - this.position.y
    const remaining = Math.hypot(dx, dy)
    const step = instant ? remaining : Math.min(remaining, (this.#walking ? 650 : 2400) * dt, remaining * (1 - Math.exp(-36 * dt)))
    if (remaining > .6) {
      this.heading += turn(Math.atan2(dy, dx) - this.heading) * (instant ? 1 : 1 - Math.exp(-46 * dt))
      this.position.x += dx / remaining * step; this.position.y += dy / remaining * step
    } else this.position = { ...this.#target }
    this.speed = instant || !dt ? 0 : step / dt
    this.#travel += step
    if (this.#jump) {
      const jump = this.#jump
      const p = instant ? 1 : Math.max(0, Math.min(1, (time - jump.at) / jump.duration))
      const progress = p * p * (3 - 2 * p)
      this.position = { x: jump.from.x + (jump.to.x - jump.from.x) * progress, y: jump.from.y + (jump.to.y - jump.from.y) * progress }
      this.lift = Math.sin(p * Math.PI) * jump.height
      if (p === 1) { this.#jump = undefined; this.lift = 0 }
    }
    let stepping = false
    const used = new Set<Point>()
    for (let i = 0; i < 8; i++) {
      const foot = this.feet[i]!
      const local = footAt(i)
      local.x += Math.min(this.speed * .012, 12)
      let desired = rotate(local, this.heading, this.position)
      let contact: Point | undefined
      if (this.airborne) {
        const tucked = rotate({ x: local.x * .55, y: local.y * .55 }, this.heading, this.position)
        Object.assign(foot, tucked, { progress: 1, grounded: false }); continue
      }
      if (this.#ground) {
        let best = Infinity
        for (const point of this.#ground) {
          if ((point.x - this.position.x) ** 2 + (point.y - this.position.y) ** 2 > 48 ** 2) continue
          const score = (point.x - desired.x) ** 2 + (point.y - desired.y) ** 2 + (used.has(point) ? 2000 : 0)
          if (score < best) { best = score; contact = point }
        }
        if (contact) { desired = { ...contact }; used.add(contact) }
      }
      if (instant) { Object.assign(foot, desired, { progress: 1, grounded: this.#ground === undefined || contact !== undefined }); continue }
      // Opposing groups of four alternate; an overstretched leg can step immediately.
      const phase = (Math.floor(this.#travel / 13) + i % 4 + (i < 4 ? 0 : 1)) % 2
      const reach = distance(foot, desired)
      if (foot.progress === 1 && (reach > 110 || (reach > 12 && phase === 0) || (this.speed < 20 && reach > 2))) {
        foot.from = { x: foot.x, y: foot.y }; foot.to = desired; foot.progress = 0
      }
      if (foot.progress < 1) {
        foot.to = desired
        foot.progress = Math.min(1, foot.progress + dt / .06)
        const p = foot.progress * foot.progress * (3 - 2 * foot.progress)
        foot.x = foot.from.x + (foot.to.x - foot.from.x) * p
        foot.y = foot.from.y + (foot.to.y - foot.from.y) * p
        stepping ||= foot.progress < 1
      }
      // A fast reversal can outrun a planted foot. Keep the linkage within its reach
      // while the servo replants it, rather than stretching a leg across the page.
      const length = distance(foot, this.position)
      if (length > 48) {
        foot.x = this.position.x + (foot.x - this.position.x) / length * 48
        foot.y = this.position.y + (foot.y - this.position.y) / length * 48
      }
      foot.grounded = this.#ground === undefined || (foot.progress === 1 && length <= 48 && this.#ground.some((point) => distance(point, foot) < .5))
    }
    return this.airborne || !this.arrived || stepping
  }

  draw(ctx: CanvasRenderingContext2D, accent: string, surface: string, ink: string): void {
    const line = (points: Point[], color: string, width: number): void => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath()
      points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke()
    }
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    if (this.lift > 0) {
      ctx.fillStyle = ink; ctx.globalAlpha = .15 * (1 - this.lift / 60)
      ctx.beginPath(); ctx.ellipse(this.position.x, this.position.y + 6, 16, 5, this.heading, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1
      ctx.translate(0, -this.lift)
    }
    for (let i = 0; i < 8; i++) {
      const side = i < 4 ? -1 : 1; const index = i % 4
      const hip = rotate({ x: -9 + index * 6, y: side * 7 }, this.heading, this.position)
      const foot = this.feet[i]!
      const knee = rotate({ x: [-19, -8, 10, 22][index]!, y: side * (20 + Math.sin(foot.progress * Math.PI) * 5) }, this.heading, this.position)
      // Dark rail, metal inset, exposed piston and a square contact pad.
      line([hip, knee, foot], surface, 5)
      line([hip, knee, foot], ink, 2.6)
      line([hip, { x: hip.x + (knee.x - hip.x) * .7, y: hip.y + (knee.y - hip.y) * .7 }], accent, 1.2)
      ctx.fillStyle = surface; ctx.strokeStyle = accent; ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.arc(knee.x, knee.y, 2.7, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      if (foot.grounded) { ctx.fillStyle = accent; ctx.fillRect(foot.x - 1.8, foot.y - 1.8, 3.6, 3.6) }
    }
    ctx.translate(this.position.x, this.position.y); ctx.rotate(this.heading)
    ctx.shadowColor = surface; ctx.shadowBlur = 3
    ctx.beginPath(); ctx.moveTo(-16, -5); ctx.lineTo(-10, -10); ctx.lineTo(7, -9)
    ctx.lineTo(14, -5); ctx.lineTo(14, 5); ctx.lineTo(7, 9); ctx.lineTo(-10, 10); ctx.lineTo(-16, 5); ctx.closePath()
    ctx.fillStyle = surface; ctx.fill(); ctx.strokeStyle = ink; ctx.lineWidth = 1.8; ctx.stroke()
    ctx.shadowBlur = 0
    ctx.fillStyle = accent; ctx.globalAlpha = .22; ctx.fillRect(-10, -6, 15, 12); ctx.globalAlpha = 1
    line([{ x: -12, y: -6 }, { x: -6, y: -8 }, { x: 5, y: -7 }], accent, 1)
    line([{ x: -12, y: 6 }, { x: -6, y: 8 }, { x: 5, y: 7 }], accent, 1)
    for (let x = -9; x < 2; x += 4) line([{ x, y: -3 }, { x, y: 3 }], ink, 1)
    ctx.fillStyle = ink; ctx.fillRect(6, -6, 5, 12)
    ctx.fillStyle = accent; ctx.fillRect(10, -4, 3, 2); ctx.fillRect(10, 2, 3, 2)
    for (const side of [-1, 1]) line([{ x: 13, y: side * 4 }, { x: 19, y: side * (7 - this.grip * 4) }, { x: 22, y: side * (3 - this.grip * 2) }], ink, 1.6)
    ctx.restore()
  }
}
