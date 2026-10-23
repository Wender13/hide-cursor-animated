import Clutter from 'gi://Clutter'
import GLib from 'gi://GLib'
import Meta from 'gi://Meta'
import {HideAnimation} from './animation.js'
import {readSprite} from './sprite.js'

const TICK_MS = 250
const FALLBACK_FILL = {r: 0, g: 0, b: 0}

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
    this._lastMove = GLib.get_monotonic_time()

    this._positionId = this._tracker.connect('position-invalidated', this._onMove)
    this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, this._tick)
  }

  disable() {
    GLib.Source.remove(this._timer)
    this._timer = null
    this._tracker.disconnect(this._positionId)
    this._positionId = null

    this._show()

    this._tracker = null
    this._seat = null
    this._settings = null
    this._spriteCache = null
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
    this._lastMove = GLib.get_monotonic_time()
    if (this._hidden)
      this._show()
  }

  async _hide() {
    this._hidden = true
    const generation = ++this._generation

    if (!this._unfocusInhibited) {
      this._seat.inhibit_unfocus()
      this._unfocusInhibited = true
    }

    const sprite = this._tracker.get_sprite()
    let info = null
    if (sprite && this._settings.get_boolean('animation-enabled')) {
      try {
        info = await this._analyze(sprite)
      } catch (e) {
        logError(e, 'hide-cursor-drops: could not read the cursor sprite')
      }
      // The pointer moved while the sprite was being read.
      if (generation !== this._generation)
        return
    }

    // Swap the real cursor for the animated copy in the same frame.
    this._tracker.inhibit_cursor_visibility()
    this._visibilityInhibited = true

    if (info)
      this._animate(sprite, info)
  }

  _show() {
    this._hidden = false
    this._generation++

    this._animation?.destroy()
    this._animation = null

    if (this._visibilityInhibited) {
      this._tracker.uninhibit_cursor_visibility()
      this._visibilityInhibited = false
    }

    if (this._unfocusInhibited) {
      this._seat.uninhibit_unfocus()
      this._unfocusInhibited = false
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

  _animate(sprite, info) {
    let fill = info.fill ?? FALLBACK_FILL
    if (this._settings.get_boolean('custom-color-enabled'))
      fill = parseColor(this._settings.get_string('custom-color')) ?? fill

    const [x, y] = global.get_pointer()
    this._animation = new HideAnimation({
      sprite,
      spriteScale: this._spriteScale(sprite),
      hot: this._tracker.get_hot(),
      pointer: [x, y],
      info,
      fill,
      outline: info.outline,
      duration: this._settings.get_int('animation-duration'),
      onDone: () => (this._animation = null),
    })
  }
}
