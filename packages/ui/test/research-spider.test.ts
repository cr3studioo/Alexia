// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { ResearchSpider } from '../src/research-spider.js'

test('pursuit reaches a distant pointer quickly and immediately changes both axes on retarget', () => {
  const spider = new ResearchSpider({ x: 40, y: 40 })
  spider.move({ x: 340, y: 190 })
  for (let t = 0; t <= 300; t += 1000 / 30) spider.advance(t)
  expect(Math.hypot(spider.position.x - 340, spider.position.y - 190)).toBeLessThan(2)
  const before = { ...spider.position }
  spider.move({ x: 70, y: 330 })
  spider.advance(333)
  expect(spider.position.x).toBeLessThan(before.x - 10)
  expect(spider.position.y).toBeGreaterThan(before.y + 10)
  for (let t = 366; t < 700; t += 1000 / 30) spider.advance(t)
  expect(spider.arrived).toBe(true)
})

test('legs plant between alternating steps and settle without an idle animation', () => {
  const spider = new ResearchSpider({ x: 100, y: 100 })
  const planted = spider.feet.map(({ x, y }) => ({ x, y }))
  spider.move({ x: 125, y: 100 }); spider.advance(0)
  expect(spider.feet.some((f, i) => f.x === planted[i]!.x && f.y === planted[i]!.y)).toBe(true)
  expect(spider.feet.some((f) => f.progress < 1)).toBe(true)
  spider.move({ x: 350, y: 100 })
  let moving = true
  for (let t = 33; t <= 1000; t += 33) moving = spider.advance(t)
  expect(moving).toBe(false)
  const still = JSON.stringify({ position: spider.position, heading: spider.heading, feet: spider.feet })
  for (let t = 2000; t <= 3000; t += 33) expect(spider.advance(t)).toBe(false)
  expect(JSON.stringify({ position: spider.position, heading: spider.heading, feet: spider.feet })).toBe(still)
})

test('reduced motion places the whole robot immediately, with no pending leg movement', () => {
  const spider = new ResearchSpider({ x: 10, y: 10 })
  spider.move({ x: 260, y: 170 })
  expect(spider.advance(0, true)).toBe(false)
  expect(spider.position).toEqual({ x: 260, y: 170 })
  expect(spider.feet.every((f) => f.progress === 1)).toBe(true)
  const state = JSON.stringify(spider.feet)
  expect(spider.advance(100, true)).toBe(false)
  expect(JSON.stringify(spider.feet)).toBe(state)
})

test('fast turns keep every leg within reach of the chassis', () => {
  const spider = new ResearchSpider({ x: 50, y: 50 })
  for (let t = 0; t < 1500; t += 33) {
    spider.move(t % 99 === 0 ? { x: 600, y: 400 } : { x: 60, y: 80 })
    spider.advance(t)
    for (const foot of spider.feet) expect(Math.hypot(foot.x - spider.position.x, foot.y - spider.position.y)).toBeLessThanOrEqual(49)
  }
})

test('planted feet land on characters instead of the spaces between them', () => {
  const letters = []
  for (const y of [80, 112]) for (let x = 40; x < 240; x += 8) letters.push({ x, y })
  const spider = new ResearchSpider({ x: 100, y: 92 })
  spider.ground(letters); spider.move({ x: 175, y: 100 })
  for (let t = 0; t < 1500; t += 33) {
    spider.advance(t)
    for (const foot of spider.feet.filter((f) => f.grounded)) expect(letters.some((p) => Math.hypot(p.x - foot.x, p.y - foot.y) < .5)).toBe(true)
  }
  expect(spider.feet.filter((f) => f.grounded).length).toBeGreaterThanOrEqual(6)
  const resting = JSON.stringify(spider.feet)
  expect(spider.advance(2000)).toBe(false)
  expect(JSON.stringify(spider.feet)).toBe(resting)
})

test('gap jumps lift the chassis, retract the legs, and land without a reduced-motion animation', () => {
  const spider = new ResearchSpider({ x: 40, y: 60 })
  spider.jump({ x: 240, y: 100 }, 0)
  expect(spider.advance(80)).toBe(true)
  expect(spider.lift).toBeGreaterThan(10)
  expect(spider.feet.every((f) => !f.grounded)).toBe(true)
  for (const foot of spider.feet) expect(Math.hypot(foot.x - spider.position.x, foot.y - spider.position.y)).toBeLessThan(30)
  spider.advance(300)
  expect(spider.airborne).toBe(false)
  expect(spider.lift).toBe(0)
  expect(spider.position).toEqual({ x: 240, y: 100 })
  spider.jump({ x: 40, y: 60 }, 400)
  spider.advance(400, true)
  expect(spider.lift).toBe(0)
  expect(spider.airborne).toBe(false)
})
