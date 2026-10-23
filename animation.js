// SPDX-FileCopyrightText: 2026 Wender
// SPDX-License-Identifier: GPL-2.0-or-later

// Cursor animations for hiding and showing. While the real cursor is
// invisible, a copy of it plays one of the styles below; drops, balls and
// rings are drawn with cairo on a canvas around it.

import Clutter from 'gi://Clutter'
import GLib from 'gi://GLib'
import St from 'gi://St'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'

const easeOutCubic = t => 1 - (1 - t) ** 3
const easeInQuad = t => t * t
const easeOutBack = t => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2
const clamp01 = t => Math.min(1, Math.max(0, t))
const random = (min, max) => min + Math.random() * (max - min)
// Progress of t within [start, end], as 0..1.
const span = (t, start, end) => clamp01((t - start) / (end - start))

// A short swell (the "pop" before the burst), then a fast collapse.
function collapse(q) {
  if (q < 0.2)
    return 1 + 0.1 * Math.sin(q / 0.2 * Math.PI / 2)
  return 1.1 * (1 - easeInQuad((q - 0.2) / 0.8))
}

function collapsing(end) {
  return t => {
    const q = span(t, 0, end)
    return {scale: collapse(q), opacity: clamp01((1 - q) / 0.2)}
  }
}

function growing(start) {
  return t => {
    const q = span(t, start, 1)
    return {scale: easeOutBack(q), opacity: clamp01(q / 0.15)}
  }
}

// A style maps the progress t (0..1) to the scale and opacity of the cursor
// copy, and may draw around it.
export const HIDE_STYLES = {
  drops: {
    // The cursor shrinks straight into its center, and the balls come out
    // of it already flying, stretching into drops on the way: one
    // continuous motion, no pause between the two.
    cursor: t => {
      const q = span(t, 0, 0.13)
      return {scale: 1 - easeInQuad(q), opacity: clamp01((1 - q) / 0.3)}
    },
    draw(fx, cr, t) {
      const pop = easeOutCubic(span(t, 0.07, 0.15))
      const flight = span(t, 0.07, 1)
      for (const drop of fx.drops)
        fx.drawDrop(cr, drop, flight, pop, false)
    },
  },
  shrink: {
    cursor: t => ({scale: collapse(t), opacity: clamp01((1 - t) / 0.15)}),
  },
  fade: {
    cursor: t => ({scale: 1 - 0.2 * easeOutCubic(t), opacity: 1 - easeInQuad(t)}),
  },
  ripple: {
    cursor: collapsing(0.3),
    draw(fx, cr, t) {
      fx.drawRing(cr, span(t, 0.15, 0.85), false)
      fx.drawRing(cr, span(t, 0.3, 1), false)
    },
  },
}

export const SHOW_STYLES = {
  drops: {
    // The hide burst played backwards: drops fly in and merge into balls,
    // which shrink away as the cursor grows out of them.
    cursor: growing(0.58),
    draw(fx, cr, t) {
      const flight = 1 - span(t, 0, 0.55)
      const pop = 1 - easeInQuad(span(t, 0.55, 0.72))
      for (const drop of fx.drops)
        fx.drawDrop(cr, drop, flight, pop, true)
    },
  },
  grow: {
    cursor: growing(0),
  },
  fade: {
    cursor: t => ({scale: 0.8 + 0.2 * easeOutCubic(t), opacity: easeOutCubic(t)}),
  },
  ripple: {
    cursor: growing(0.4),
    draw(fx, cr, t) {
      fx.drawRing(cr, span(t, 0, 0.6), true)
    },
  },
}

function shapePath(cr, shape, r, tail) {
  // In the drop's frame: moving towards +x, tail stretching towards -x.
  cr.newPath()
  if (shape === 'spark') {
    // Four-pointed star with concave sides, long axis along the motion.
    const tips = [[r * 1.6 + tail * 0.4, 0], [0, r * 1.2], [-(r * 1.6 + tail), 0], [0, -r * 1.2]]
    cr.moveTo(...tips[0])
    for (let i = 1; i <= tips.length; i++) {
      const [ax, ay] = tips[i - 1]
      const [bx, by] = tips[i % tips.length]
      cr.curveTo(ax * 0.4, ay * 0.4, bx * 0.4, by * 0.4, bx, by)
    }
    cr.closePath()
  } else if (shape === 'circle' || tail < 0.5) {
    cr.arc(0, 0, r, 0, 2 * Math.PI)
  } else {
    // Teardrop: round head leading, straight sides tangent to it.
    const beta = Math.acos(r / (r + tail))
    cr.moveTo(-(r + tail), 0)
    cr.arc(0, 0, r, Math.PI + beta, Math.PI - beta)
    cr.closePath()
  }
}

export class CursorAnimation {
  /**
   * @param {object} params
   * @param {object} params.style - an entry of HIDE_STYLES or SHOW_STYLES
   * @param {boolean} params.follow - keep the animation on the pointer while
   *   it moves (show animations play while the user moves the mouse)
   * @param {Cogl.Texture} params.sprite - the cursor texture
   * @param {number} params.spriteScale - logical px per sprite px
   * @param {number[]} params.hot - hotspot, in sprite px
   * @param {number[]} params.pointer - pointer position, in stage coords
   * @param {object} params.info - result of analyzeSprite()
   * @param {object} params.fill - drop color {r, g, b}
   * @param {?object} params.outline - drop outline color or null
   * @param {object} params.drops - {count, size, distance, gravity, shape},
   *   size/distance/gravity relative to the defaults
   * @param {number} params.duration - ms
   * @param {Function} params.onDone - called once, however it ends
   * @param {?Function} params.log - receives frame timing stats at the end
   */
  constructor({style, follow, sprite, spriteScale, hot, pointer, info, fill, outline, drops, duration, onDone, log = null}) {
    this._style = style
    this._log = log
    this._follow = follow
    this._fill = fill
    this._outline = outline
    this._shape = drops.shape
    this._onDone = onDone

    const k = spriteScale
    const [px, py] = pointer
    this._startPointer = [px, py]
    const left = px - hot[0] * k
    const top = py - hot[1] * k
    const tw = sprite.get_width()
    const th = sprite.get_height()

    // Everything starts from the visual center of the cursor, not the
    // hotspot (which sits on the arrow's tip).
    this._ox = left + info.cx * k
    this._oy = top + info.cy * k
    const size = Math.max(info.bw, info.bh) * k

    const base = Math.random() * 2 * Math.PI
    this._lineWidth = Math.max(1, size / 20)
    this._drops = Array.from({length: drops.count}, (_, i) => {
      const radius = Math.max(3.5, size * random(0.2, 0.24)) * drops.size
      return {
        dir: base + i * 2 * Math.PI / drops.count + random(-0.3, 0.3) * Math.min(1, 3 / drops.count),
        radius,
        // The balls sit in a small cluster, touching, before they fly.
        rest: drops.count > 1 ? radius * 1.15 : 0,
        reach: size * random(2.2, 2.8) * drops.distance,
        gravity: size * 0.9 * drops.gravity,
      }
    })
    this._ringRadius = size * 1.6 * drops.distance
    this._ringWidth = Math.max(1.5, size * 0.08 * drops.size)

    // Fullscreen windows are otherwise scanned out directly, skipping the
    // stage, and the animation would play unseen.
    global.compositor.disable_unredirect()

    this._container = new Clutter.Actor({reactive: false})
    Main.uiGroup.add_child(this._container)
    Main.uiGroup.set_child_above_sibling(this._container, null)

    if (style.draw) {
      // Big enough for the drops' whole flight, gravity included, and for
      // the rings.
      const reach = Math.max(0, ...this._drops.map(d =>
        d.rest + d.reach + d.gravity + d.radius * 4.5))
      const half = Math.ceil(Math.max(reach, this._ringRadius + this._ringWidth) +
        this._lineWidth + 4)
      this._canvasX = Math.floor(this._ox) - half
      this._canvasY = Math.floor(this._oy) - half
      this._canvas = new St.DrawingArea({
        x: this._canvasX,
        y: this._canvasY,
        width: 2 * half,
        height: 2 * half,
      })
      this._canvas.connect('repaint', this._repaint.bind(this))
      this._container.add_child(this._canvas)
    }

    // Above the canvas, so the drops seem to come out from under it.
    this._cursor = new Clutter.Actor({
      content: Clutter.TextureContent.new_from_texture(sprite, null),
      x: left,
      y: top,
      width: tw * k,
      height: th * k,
    })
    this._cursor.set_pivot_point(info.cx / tw, info.cy / th)
    this._cursor.set_content_scaling_filters(
      Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR)
    this._container.add_child(this._cursor)

    this._progress = 0
    this._frames = 0
    this._longestGap = 0
    this._lastFrame = GLib.get_monotonic_time()
    this._timeline = new Clutter.Timeline({actor: this._container, duration})
    this._timeline.connect('new-frame', () => {
      const now = GLib.get_monotonic_time()
      this._longestGap = Math.max(this._longestGap, now - this._lastFrame)
      this._lastFrame = now
      this._frames++
      this._progress = this._timeline.get_progress()
      this._update()
    })
    this._timeline.connect('completed', () => this.destroy())
    this._update()
    this._timeline.start()

    // The timeline only advances on new frames; never leave the copy of the
    // cursor on screen if they stop coming.
    this._watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration + 1000, () => {
      this._watchdog = 0
      this.destroy()
      return GLib.SOURCE_REMOVE
    })
  }

  get drops() {
    return this._drops
  }

  _update() {
    if (this._follow) {
      const [x, y] = global.get_pointer()
      this._container.set_translation(
        x - this._startPointer[0], y - this._startPointer[1], 0)
    }

    const {scale, opacity} = this._style.cursor(this._progress)
    const s = Math.max(0, scale)
    this._cursor.set_scale(s, s)
    this._cursor.opacity = Math.round(255 * clamp01(opacity))
    this._cursor.visible = s > 0 && opacity > 0

    this._canvas?.queue_repaint()
  }

  _repaint(area) {
    const cr = area.get_context()
    const [sw, sh] = area.get_surface_size()
    cr.scale(sw / area.width, sh / area.height)
    cr.translate(this._ox - this._canvasX, this._oy - this._canvasY)
    this._style.draw(this, cr, this._progress)
    cr.$dispose()
  }

  _paint(cr, alpha) {
    const {r, g, b} = this._fill
    cr.setSourceRGBA(r / 255, g / 255, b / 255, alpha)
    if (!this._outline) {
      cr.fill()
      return
    }
    cr.fillPreserve()
    const {r: or, g: og, b: ob} = this._outline
    cr.setSourceRGBA(or / 255, og / 255, ob / 255, alpha)
    cr.stroke()
  }

  /**
   * Draws one drop, relative to the origin.
   *
   * @param {number} flight - 0 at the cluster, 1 at the end of the flight
   * @param {number} pop - size factor of the ball before/after the flight
   * @param {boolean} inward - flying towards the cluster instead of away
   */
  drawDrop(cr, drop, flight, pop, inward) {
    const f = flight
    const dx = Math.cos(drop.dir)
    const dy = Math.sin(drop.dir)

    // Decelerating flight plus a bit of gravity.
    const travel = drop.rest + drop.reach * easeOutCubic(f)
    const x = dx * travel
    const y = dy * travel + drop.gravity * f * f

    const sign = inward ? -1 : 1
    const vx = sign * dx * drop.reach * 3 * (1 - f) ** 2
    const vy = sign * (dy * drop.reach * 3 * (1 - f) ** 2 + 2 * drop.gravity * f)
    const speed = Math.hypot(vx, vy) / (3 * drop.reach || 1)

    // Pops up as a ball, flies, then dries up.
    let r = drop.radius * pop
    if (f > 0.6)
      r *= 1 - easeInQuad((f - 0.6) / 0.4)
    if (r <= 0.2)
      return
    const alpha = clamp01((1 - f) / 0.25)

    // Right after launch the ball stretches into its flying shape instead
    // of snapping into it.
    const tail = f > 0 ? r * 2.5 * Math.min(1, speed) * easeOutCubic(clamp01(f / 0.12)) : 0

    cr.save()
    cr.translate(x, y)
    cr.setLineWidth(Math.min(this._lineWidth, r * 0.3))
    if (vx || vy)
      cr.rotate(Math.atan2(vy, vx))
    shapePath(cr, this._shape, r, tail)
    this._paint(cr, alpha)
    cr.restore()
  }

  /**
   * Draws a ring around the origin.
   *
   * @param {number} p - 0..1 progress of the ring
   * @param {boolean} inward - contracting instead of expanding
   */
  drawRing(cr, p, inward) {
    if (p <= 0 || p >= 1)
      return
    const radius = this._ringRadius * (inward ? 1 - easeOutCubic(p) : easeOutCubic(p))
    const alpha = inward ? clamp01(p / 0.3) : 1 - easeInQuad(p)
    if (radius < 1)
      return

    cr.save()
    cr.newPath()
    cr.arc(0, 0, radius, 0, 2 * Math.PI)
    if (this._outline) {
      const {r, g, b} = this._outline
      cr.setSourceRGBA(r / 255, g / 255, b / 255, alpha)
      cr.setLineWidth(this._ringWidth + 2 * this._lineWidth)
      cr.strokePreserve()
    }
    const {r, g, b} = this._fill
    cr.setSourceRGBA(r / 255, g / 255, b / 255, alpha)
    cr.setLineWidth(this._ringWidth)
    cr.stroke()
    cr.restore()
  }

  destroy() {
    if (!this._container)
      return

    if (this._watchdog)
      GLib.Source.remove(this._watchdog)
    this._watchdog = 0
    this._timeline.stop()
    this._timeline = null
    this._container.destroy()
    this._container = null
    global.compositor.enable_unredirect()

    this._log?.(`${this._frames} frames, longest gap ${(this._longestGap / 1000).toFixed(1)} ms, ended at ${Math.round(this._progress * 100)}%`)

    const onDone = this._onDone
    this._onDone = null
    onDone?.()
  }
}
