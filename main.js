// SPDX-FileCopyrightText: 2026 Wender
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter'
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import {HideAnimation} from './animation.js'
import {readSprite} from './sprite.js'

const TICK_MS = 250
// Reading the sprite normally takes a few ms; past this, hide without
// animating instead of leaving the cursor up indefinitely.
const READ_TIMEOUT_MS = 500
// Apps hiding their own cursor (video players, fullscreen browsers) only
// count when the pointer was resting this long; games grabbing the pointer
// mid-motion don't.
const APP_HIDE_MIN_IDLE_US = 700 * 1000
const FALLBACK_FILL = {r: 0, g: 0, b: 0}

function withTimeout(promise, ms) {
  let id
  const timeout = new Promise((_, reject) => {
    id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      id = 0
      reject(new Error(`timed out after ${ms} ms`))
      return GLib.SOURCE_REMOVE
    })
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (id)
      GLib.Source.remove(id)
  })
}

function parseColor(str) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(str)
  if (!m)
    return null
  return {r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16)}
}

export class HideCursor {
  constructor(settings) {
    this._settings = settings
  }

  enable() {
    this._tracker = global.backend.get_cursor_tracker()
    this._seat = Clutter.get_default_backend().get_default_seat()

    this._hidden = false
    this._visibilityInhibited = false
    this._unfocusInhibited = false
    this._generation = 0
    this._animation = null
    this._spriteCache = null
    this._lastSprite = null
    this._lastPointer = global.get_pointer().slice(0, 2)
    this._lastMove = GLib.get_monotonic_time()
    this._rememberSprite()

    this._positionId = this._tracker.connect('position-invalidated', this._onMove)
    this._cursorChangedId = this._tracker.connect('cursor-changed', this._onCursorChanged)
    this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, this._tick)
  }

  disable() {
    GLib.Source.remove(this._timer)
    this._timer = null
    this._tracker.disconnect(this._positionId)
    this._positionId = null
    this._tracker.disconnect(this._cursorChangedId)
    this._cursorChangedId = null

    this._show()

    this._tracker = null
    this._seat = null
    this._settings = null
    this._spriteCache = null
    this._lastSprite = null
  }

  _debug(msg) {
    if (this._settings?.get_boolean('debug'))
      console.log(`hide-cursor-drops: ${msg}`)
  }

  _tick = () => {
    const timeout = this._settings.get_int('timeout') * 1000 * 1000
    if (!this._hidden &&
        GLib.get_monotonic_time() - this._lastMove > timeout &&
        this._tracker.get_pointer_visible())
      this._hide().catch(logError)

    return GLib.SOURCE_CONTINUE
  }

  _onMove = () => {
    // The signal also fires without real motion (e.g. on sprite updates),
    // which must not cancel the animation.
    const [x, y] = global.get_pointer()
    if (x === this._lastPointer[0] && y === this._lastPointer[1])
      return
    this._lastPointer = [x, y]
    this._lastMove = GLib.get_monotonic_time()

    if (this._hidden)
      this._show()
    else
      this._cancelAnimation()
  }

  _rememberSprite() {
    const sprite = this._tracker.get_sprite()
    if (sprite)
      this._lastSprite = {sprite, hot: this._tracker.get_hot()}
    return sprite
  }

  _onCursorChanged = () => {
    if (this._hidden)
      return

    if (this._rememberSprite()) {
      // The app brought its cursor back.
      this._cancelAnimation()
      return
    }

    // The app under the pointer made the cursor invisible, as video players
    // do after a short idle, usually well before our own timeout.
    const idle = GLib.get_monotonic_time() - this._lastMove
    if (!this._lastSprite || idle < APP_HIDE_MIN_IDLE_US) {
      this._debug('app hid the cursor while it was moving, not animating')
      return
    }
    this._debug('app hid the cursor, animating its last sprite')
    this._animateAppHide().catch(logError)
  }

  async _animateAppHide() {
    const {sprite, hot} = this._lastSprite
    this._cancelAnimation()
    const generation = this._generation

    const info = await this._readForAnimation(sprite)
    if (info && generation === this._generation && !this._hidden)
      this._animate(sprite, hot, info)
  }

  async _hide() {
    this._hidden = true
    this._cancelAnimation()
    const generation = this._generation

    if (!this._unfocusInhibited) {
      this._seat.inhibit_unfocus()
      this._unfocusInhibited = true
    }

    const sprite = this._tracker.get_sprite()
    const info = await this._readForAnimation(sprite)
    // The pointer moved while the sprite was being read.
    if (generation !== this._generation) {
      this._debug('pointer moved while reading the sprite')
      return
    }

    // Swap the real cursor for the animated copy in the same frame.
    this._tracker.inhibit_cursor_visibility()
    this._visibilityInhibited = true

    if (info)
      this._animate(sprite, this._tracker.get_hot(), info)
  }

  _show() {
    this._hidden = false
    this._cancelAnimation()

    if (this._visibilityInhibited) {
      this._tracker.uninhibit_cursor_visibility()
      this._visibilityInhibited = false
    }

    if (this._unfocusInhibited) {
      this._seat.uninhibit_unfocus()
      this._unfocusInhibited = false
    }
  }

  _cancelAnimation() {
    // Also invalidates sprite reads still in flight.
    this._generation++
    if (this._animation)
      this._debug('animation cancelled')
    this._animation?.destroy()
    this._animation = null
  }

  /** @returns {Promise<?object>} sprite info, or null to hide without animating */
  async _readForAnimation(sprite) {
    if (!this._settings.get_boolean('animation-enabled')) {
      this._debug('not animating: disabled in settings')
      return null
    }
    if (!sprite) {
      // Usually the app under the pointer already made it invisible.
      this._debug('not animating: no cursor sprite')
      return null
    }

    try {
      const info = await withTimeout(this._analyze(sprite), READ_TIMEOUT_MS)
      if (!info)
        this._debug(`not animating: sprite ${sprite.get_width()}x${sprite.get_height()} has no opaque pixels`)
      return info
    } catch (e) {
      logError(e, 'hide-cursor-drops: could not read the cursor sprite')
      return null
    }
  }

  async _analyze(sprite) {
    if (this._spriteCache?.sprite !== sprite)
      this._spriteCache = {sprite, info: await readSprite(sprite)}
    return this._spriteCache.info
  }

  _spriteScale(sprite) {
    // Same heuristic as the Shell magnifier: sprites come rendered at an
    // integer multiple of the configured (logical) cursor size.
    const avg = (sprite.get_width() + sprite.get_height()) / 2
    return 1 / Math.max(1, Math.floor(avg / Meta.prefs_get_cursor_size() + 0.1))
  }

  _animate(sprite, hot, info) {
    this._debug(`animating ${sprite.get_width()}x${sprite.get_height()} sprite, info ${JSON.stringify(info)}`)

    let fill = info.fill ?? FALLBACK_FILL
    if (this._settings.get_boolean('custom-color-enabled'))
      fill = parseColor(this._settings.get_string('custom-color')) ?? fill

    const [x, y] = global.get_pointer()
    this._animation = new HideAnimation({
      sprite,
      spriteScale: this._spriteScale(sprite),
      hot,
      pointer: [x, y],
      info,
      fill,
      outline: info.outline,
      duration: this._settings.get_int('animation-duration'),
      onDone: () => (this._animation = null),
    })
  }
}
