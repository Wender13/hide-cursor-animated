// SPDX-FileCopyrightText: 2026 Wender
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import {CursorAnimation, HIDE_STYLES, SHOW_STYLES} from './animation.js'
import {readSprite} from './sprite.js'

const TICK_MS = 250
// Reading the sprite normally takes a few ms; past this, hide without
// animating instead of leaving the cursor up indefinitely.
const READ_TIMEOUT_MS = 500
// Apps hiding their own cursor (video players, fullscreen browsers) only
// count when the pointer was resting this long; games grabbing the pointer
// mid-motion don't.
const APP_HIDE_MIN_IDLE_US = 700 * 1000
// Typing only counts once the pointer has rested this long, and is told
// apart from motion and clicks this long after the input arrives.
const TYPING_MIN_REST_US = 300 * 1000
const TYPING_CHECK_MS = 60
const BUTTONS_MASK = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
  Clutter.ModifierType.BUTTON3_MASK | Clutter.ModifierType.BUTTON4_MASK |
  Clutter.ModifierType.BUTTON5_MASK
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

function soundsDir() {
  // Installed builds keep the code in a subfolder; see extension.js.
  const here = Gio.File.new_for_uri(import.meta.url).get_parent()
  return [here, here.get_parent()]
    .map(dir => dir.get_child('sounds'))
    .find(dir => dir.query_exists(null))
}

export class HideCursor {
  constructor(settings) {
    this._settings = settings
  }

  enable() {
    this._tracker = global.backend.get_cursor_tracker()
    this._seat = Clutter.get_default_backend().get_default_seat()
    this._idleMonitor = global.backend.get_core_idle_monitor()

    this._hidden = false
    this._hidVisibleCursor = false
    this._visibilityInhibited = false
    this._unfocusInhibited = false
    this._generation = 0
    this._animation = null
    this._animationKind = null
    this._spriteCache = null
    this._lastSprite = null
    this._activeWatch = 0
    this._typingCheck = 0
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
    if (this._activeWatch)
      this._idleMonitor.remove_watch(this._activeWatch)
    this._activeWatch = 0
    if (this._typingCheck)
      GLib.Source.remove(this._typingCheck)
    this._typingCheck = 0

    this._show({animate: false})

    this._tracker = null
    this._seat = null
    this._idleMonitor = null
    this._settings = null
    this._spriteCache = null
    this._lastSprite = null
  }

  _debug(msg) {
    if (this._settings?.get_boolean('debug'))
      console.log(`hide-cursor-drops: ${msg}`)
  }

  _tick = () => {
    const now = GLib.get_monotonic_time()
    const timeout = this._settings.get_int('timeout') * 1000 * 1000
    if (!this._hidden && now - this._lastMove > timeout && this._canHide('idle'))
      this._hide().catch(logError)

    // Re-armed here rather than on every input event, which would mean a
    // callback per pointer motion.
    if (!this._hidden && !this._activeWatch &&
        this._settings.get_boolean('hide-on-typing') &&
        now - this._lastMove > TYPING_MIN_REST_US)
      this._activeWatch = this._idleMonitor.add_user_active_watch(this._onUserActive)

    return GLib.SOURCE_CONTINUE
  }

  _canHide(reason) {
    if (!this._tracker.get_pointer_visible())
      return false
    const app = this._excludedAppUnderPointer()
    if (app) {
      this._debug(`not hiding (${reason}): pointer over excluded app ${app}`)
      // Retry only after the next movement, not on every tick.
      this._lastMove = GLib.get_monotonic_time()
      return false
    }
    return true
  }

  _excludedAppUnderPointer() {
    const excluded = this._settings.get_strv('excluded-apps')
    if (!excluded.length)
      return null

    const [x, y] = global.get_pointer()
    const workspace = global.workspace_manager.get_active_workspace()
    const actors = global.get_window_actors()
    for (let i = actors.length - 1; i >= 0; i--) {
      const window = actors[i].meta_window
      if (!actors[i].visible || window.minimized || !window.located_on_workspace(workspace))
        continue
      const rect = window.get_frame_rect()
      if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height)
        continue
      const id = Shell.WindowTracker.get_default().get_window_app(window)?.get_id()
      return excluded.includes(id) ? id : null
    }
    return null
  }

  _onUserActive = () => {
    // The watch fires once; _tick arms it again.
    this._activeWatch = 0
    if (this._typingCheck)
      return

    // Input arrived. Let the event be processed first, then tell typing
    // (or scrolling) apart from pointer motion and clicks.
    const buttonsAtInput = global.get_pointer()[2] & BUTTONS_MASK
    this._typingCheck = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TYPING_CHECK_MS, () => {
      this._typingCheck = 0
      const moved = GLib.get_monotonic_time() - this._lastMove < 1000 * TYPING_CHECK_MS * 2
      const clicked = buttonsAtInput || global.get_pointer()[2] & BUTTONS_MASK
      if (!this._hidden && !moved && !clicked &&
          this._settings.get_boolean('hide-on-typing') && this._canHide('typing')) {
        this._debug('typing, hiding')
        this._hide().catch(logError)
      }
      return GLib.SOURCE_REMOVE
    })
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
    else if (this._animationKind === 'hide')
      this._cancelAnimation()
  }

  _rememberSprite() {
    const sprite = this._tracker.get_sprite()
    if (sprite)
      this._lastSprite = {sprite, hot: this._tracker.get_hot()}
    return sprite
  }

  _onCursorChanged = () => {
    // While we keep the cursor invisible, the sprite reads as missing.
    if (this._hidden || this._visibilityInhibited)
      return

    if (this._rememberSprite()) {
      // The app brought its cursor back.
      if (this._animationKind === 'hide')
        this._cancelAnimation()
      return
    }

    // The app under the pointer made the cursor invisible, as video players
    // do after a short idle, usually well before our own timeout.
    const idle = GLib.get_monotonic_time() - this._lastMove
    if (!this._lastSprite || !this._settings.get_boolean('animate-app-hide'))
      return
    if (idle < APP_HIDE_MIN_IDLE_US) {
      this._debug('app hid the cursor while it was moving, not animating')
      return
    }
    const app = this._excludedAppUnderPointer()
    if (app) {
      this._debug(`app hid the cursor over excluded app ${app}, not animating`)
      return
    }
    this._debug('app hid the cursor, animating its last sprite')
    this._animateAppHide().catch(logError)
  }

  async _animateAppHide() {
    const {sprite, hot} = this._lastSprite
    this._cancelAnimation()
    const generation = this._generation

    const style = this._settings.get_string('hide-style')
    const info = await this._readForAnimation(sprite, style)
    if (!info || generation !== this._generation || this._hidden)
      return
    this._playSound('hide')
    this._animate('hide', HIDE_STYLES[style], sprite, hot, info)
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
    if (sprite)
      this._lastSprite = {sprite, hot: this._tracker.get_hot()}
    const style = this._settings.get_string('hide-style')
    const info = await this._readForAnimation(sprite, style)
    // The pointer moved while the sprite was being read.
    if (generation !== this._generation) {
      this._debug('pointer moved while reading the sprite')
      return
    }

    // Swap the real cursor for the animated copy in the same frame.
    this._inhibitVisibility()
    this._hidVisibleCursor = !!sprite
    if (sprite)
      this._playSound('hide')
    if (info)
      this._animate('hide', HIDE_STYLES[style], sprite, this._lastSprite.hot, info)
  }

  _show({animate = true} = {}) {
    this._hidden = false
    this._cancelAnimation()

    if (this._unfocusInhibited) {
      this._seat.uninhibit_unfocus()
      this._unfocusInhibited = false
    }

    if (!this._visibilityInhibited)
      return

    const wasVisible = this._hidVisibleCursor
    this._hidVisibleCursor = false
    if (wasVisible && animate)
      this._playSound('show')

    if (animate && wasVisible && this._lastSprite)
      this._animateShow().catch(e => {
        logError(e)
        this._uninhibitVisibility()
      })
    else
      this._uninhibitVisibility()
  }

  async _animateShow() {
    // The real cursor stays invisible until the copy has fully grown back.
    const generation = this._generation
    const {sprite, hot} = this._lastSprite
    const style = this._settings.get_string('show-style')
    const info = await this._readForAnimation(sprite, style)
    // Whoever bumped the generation (a new hide) took over the cursor.
    if (generation !== this._generation)
      return
    if (!info) {
      this._uninhibitVisibility()
      return
    }
    this._animate('show', SHOW_STYLES[style], sprite, hot, info, {
      follow: true,
      duration: this._settings.get_int('show-duration'),
      onDone: () => this._uninhibitVisibility(),
    })
  }

  _inhibitVisibility() {
    if (this._visibilityInhibited)
      return
    this._tracker.inhibit_cursor_visibility()
    this._visibilityInhibited = true
  }

  _uninhibitVisibility() {
    if (!this._visibilityInhibited || this._hidden)
      return
    this._tracker.uninhibit_cursor_visibility()
    this._visibilityInhibited = false
  }

  _cancelAnimation() {
    // Also invalidates sprite reads still in flight.
    this._generation++
    const animation = this._animation
    this._animation = null
    this._animationKind = null
    if (animation)
      this._debug('animation cancelled')
    animation?.destroy()
  }

  /** @returns {Promise<?object>} sprite info, or null to skip animating */
  async _readForAnimation(sprite, style) {
    if (style === 'none') {
      this._debug('not animating: style set to none')
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

  _animate(kind, style, sprite, hot, info, {follow = false, duration, onDone} = {}) {
    this._debug(`animating ${kind} of ${sprite.get_width()}x${sprite.get_height()} sprite, info ${JSON.stringify(info)}`)

    const settings = this._settings
    let fill = info.fill ?? FALLBACK_FILL
    if (settings.get_boolean('custom-color-enabled'))
      fill = parseColor(settings.get_string('custom-color')) ?? fill

    const [x, y] = global.get_pointer()
    const animation = new CursorAnimation({
      style,
      follow,
      sprite,
      spriteScale: this._spriteScale(sprite),
      hot,
      pointer: [x, y],
      info,
      fill,
      outline: info.outline,
      drops: {
        count: settings.get_int('drop-count'),
        size: settings.get_double('drop-size'),
        distance: settings.get_double('drop-distance'),
        gravity: settings.get_double('drop-gravity'),
        shape: settings.get_string('drop-shape'),
      },
      duration: duration ?? settings.get_int('animation-duration'),
      log: settings.get_boolean('debug') ? msg => this._debug(`${kind} animation: ${msg}`) : null,
      onDone: () => {
        if (this._animation === animation) {
          this._animation = null
          this._animationKind = null
        }
        onDone?.()
      },
    })
    this._animation = animation
    this._animationKind = kind
  }

  _playSound(kind) {
    const mode = this._settings.get_string(`${kind}-sound`)
    let file = null
    if (mode === 'drop')
      file = soundsDir()?.get_child(`drop-${kind}.wav`)
    else if (mode === 'file' && this._settings.get_string(`${kind}-sound-file`))
      file = Gio.File.new_for_path(this._settings.get_string(`${kind}-sound-file`))
    if (!file)
      return

    // Event sounds: follows the "System Sounds" volume and on/off switch.
    global.display.get_sound_player().play_from_file(
      file, kind === 'hide' ? 'Cursor hidden' : 'Cursor shown', null)
  }
}
