// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from 'vitest'
import { answerPrompt, modal } from '../src/modal.js'

/** The Settings sheet as a dialog, and the permission prompt's one answer per question. */

afterEach(() => {
  document.body.replaceChildren()
})

function page(): { board: HTMLElement; opener: HTMLButtonElement; sheet: HTMLElement; heading: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement } {
  document.body.innerHTML = `
    <div id="board"><button id="opener">Settings</button></div>
    <div id="sheet"><h2 id="settings-heading">Settings</h2><button id="first">Back</button><button id="last">About</button></div>`
  const one = (id: string): HTMLElement => document.getElementById(id)!
  return {
    board: one('board'),
    opener: one('opener') as HTMLButtonElement,
    sheet: one('sheet'),
    heading: one('settings-heading'),
    first: one('first') as HTMLButtonElement,
    last: one('last') as HTMLButtonElement,
  }
}

test('modal: the sheet is a labelled dialog, the board goes inert and focus moves to the heading', () => {
  const { board, opener, sheet, heading } = page()
  opener.focus()
  const dialog = modal(sheet, () => [board])
  dialog.open(heading)
  expect(sheet.getAttribute('role')).toBe('dialog')
  expect(sheet.getAttribute('aria-modal')).toBe('true')
  expect(sheet.getAttribute('aria-labelledby')).toBe('settings-heading')
  expect(board.inert).toBe(true)
  expect(document.activeElement).toBe(heading)
})

test('modal: closing gives the board back and returns focus to what opened it', () => {
  const { board, opener, sheet, heading } = page()
  opener.focus()
  const dialog = modal(sheet, () => [board])
  dialog.open(heading)
  dialog.close()
  expect(board.inert).toBe(false)
  expect(document.activeElement).toBe(opener)
})

test('modal: with nothing focused before, closing falls back to the given element', () => {
  const { board, opener, sheet, heading } = page()
  const dialog = modal(sheet, () => [board])
  dialog.open(heading)
  dialog.close(opener)
  expect(document.activeElement).toBe(opener)
})

test('modal: Tab goes round the sheet rather than out of it', () => {
  const { board, sheet, heading, first, last } = page()
  modal(sheet, () => [board]).open(heading)
  last.focus()
  const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  last.dispatchEvent(forward)
  expect(forward.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(first)
  const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
  first.dispatchEvent(back)
  expect(document.activeElement).toBe(last)
})

function prompt(): HTMLElement {
  document.body.innerHTML = `<div id="prompt" hidden><p id="prompt-why"></p><button id="allow">Allow once</button><button id="deny">Not this time</button></div>`
  return document.getElementById('prompt')!
}

test('prompt: Allow after an earlier Deny answers only the new question', () => {
  const box = prompt()
  const first = vi.fn()
  const second = vi.fn()
  box.hidden = false
  answerPrompt(box, first)
  box.querySelector<HTMLElement>('#deny')!.click()
  expect(first).toHaveBeenCalledExactlyOnceWith(false)
  box.hidden = false
  answerPrompt(box, second)
  box.querySelector<HTMLElement>('#allow')!.click()
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledExactlyOnceWith(true)
})

test('prompt: a new question takes the buttons over from one never answered', () => {
  const box = prompt()
  const first = vi.fn()
  const second = vi.fn()
  answerPrompt(box, first)
  answerPrompt(box, second)
  box.querySelector<HTMLElement>('#allow')!.click()
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledExactlyOnceWith(true)
})

test('prompt: Allow once has focus when the question appears', () => {
  const box = prompt()
  box.hidden = false
  answerPrompt(box, () => undefined)
  expect(document.activeElement).toBe(box.querySelector('#allow'))
})
