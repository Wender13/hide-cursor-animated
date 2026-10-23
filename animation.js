// SPDX-FileCopyrightText: 2026 Wender
// SPDX-License-Identifier: GPL-2.0-or-later

// The hide animation: a copy of the cursor shrinks into its center, three
// balls of the cursor's color pop out of it, then each one shoots off to its
// own side, stretching into a drop.

import Clutter from 'gi://Clutter'
import St from 'gi://St'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'

const DROP_COUNT = 3

// Fractions of the total duration.
const SHRINK_END = 0.16
const BALLS_START = 0.1
const BALLS_POP = 0.1
const FLY_START = 0.26

const easeOutCubic = t => 1 - (1 - t) ** 3
const easeInQuad = t => t * t
const easeOutBack = t => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2
const clamp01 = t => Math.min(1, Math.max(0, t))
const random = (min, max) => min + Math.random() * (max - min)

function cursorScale(q) {
  // A short swell (the "pop" before the burst), then a fast collapse.
  if (q < 0.2)
    return 1 + 0.1 * Math.sin(q / 0.2 * Math.PI / 2)
  return 1.1 * (1 - easeInQuad((q - 0.2) / 0.8))
}

export class HideAnimation {
  /**
   * @param {object} params
   * @param {Cogl.Texture} params.sprite - the cursor texture
   * @param {number} params.spriteScale - logical px per sprite px
   * @param {number[]} params.hot - hotspot, in sprite px
   * @param {number[]} params.pointer - pointer position, in stage coords
   * @param {object} params.info - result of analyzeSprite()
   * @param {object} params.fill - drop color {r, g, b}
   * @param {?object} params.outline - drop outline color or null
   * @param {number} params.duration - ms
   * @param {Function} params.onDone
   */
  constructor({sprite, spriteScale, hot, pointer, info, fill, outline, duration, onDone}) {
    this._fill = fill
    this._outline = outline
    this._onDone = onDone

    const k = spriteScale
    const [px, py] = pointer
    const left = px - hot[0] * k
    const top = py - hot[1] * k
    const tw = sprite.get_width()
    const th = sprite.get_height()

    // Where the drops come from: the visual center of the cursor, not the
    // hotspot (which sits on the arrow's tip).
    this._ox = left + info.cx * k
    this._oy = top + info.cy * k
    const size = Math.max(info.bw, info.bh) * k

    this._container = new Clutter.Actor({reactive: false})
    Main.uiGroup.add_child(this._container)
    Main.uiGroup.set_child_above_sibling(this._container, null)

    const base = Math.random() * 2 * Math.PI
    this._lineWidth = Math.max(1, size / 20)
    this._drops = Array.from({length: DROP_COUNT}, (_, i) => {
      const radius = Math.max(3.5, size * random(0.2, 0.24))
      return {
        dir: base + i * 2 * Math.PI / DROP_COUNT + random(-0.3, 0.3),
        radius,
        // The balls sit in a small cluster, touching, before they fly.
        rest: radius * 1.15,
        reach: size * random(2.2, 2.8),
        gravity: size * 0.9,
      }
    })

    // Big enough for the drops' whole flight, gravity included.
    const half = Math.ceil(size * 4.3 + this._lineWidth + 4)
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
    this._timeline = new Clutter.Timeline({actor: this._container, duration})
    this._timeline.connect('new-frame', () => {
      this._progress = this._timeline.get_progress()
      this._update()
    })
    this._timeline.connect('completed', () => this.destroy())
    this._update()
    this._timeline.start()
  }

  _update() {
    const q = clamp01(this._progress / SHRINK_END)
    const s = Math.max(0, cursorScale(q))
    this._cursor.set_scale(s, s)
    this._cursor.opacity = Math.round(255 * clamp01((1 - q) / 0.2))
    this._cursor.visible = q < 1

    this._canvas.queue_repaint()
  }

  _repaint(area) {
    const cr = area.get_context()
    const [sw, sh] = area.get_surface_size()
    cr.scale(sw / area.width, sh / area.height)

    if (this._progress > BALLS_START) {
      for (const drop of this._drops)
        this._drawDrop(cr, drop)
    }

    cr.$dispose()
  }

  _drawDrop(cr, drop) {
    const t = this._progress
    const pop = clamp01((t - BALLS_START) / BALLS_POP)
    const f = clamp01((t - FLY_START) / (1 - FLY_START))
    const dx = Math.cos(drop.dir)
    const dy = Math.sin(drop.dir)

    // Decelerating flight plus a bit of gravity.
    const travel = drop.rest + drop.reach * easeOutCubic(f)
    const x = this._ox - this._canvasX + dx * travel
    const y = this._oy - this._canvasY + dy * travel + drop.gravity * f * f

    const vx = dx * drop.reach * 3 * (1 - f) ** 2
    const vy = dy * drop.reach * 3 * (1 - f) ** 2 + 2 * drop.gravity * f
    const speed = Math.hypot(vx, vy) / (3 * drop.reach)

    // Pops up as a ball, flies, then dries up.
    let r = drop.radius * easeOutBack(pop)
    if (f > 0.6)
      r *= 1 - easeInQuad((f - 0.6) / 0.4)
    if (r <= 0.2)
      return
    const alpha = clamp01((1 - f) / 0.25)

    // Teardrop: round head leading, tail stretched by the speed. Right after
    // launch the ball stretches into the drop shape instead of snapping.
    const tail = f > 0 ? r * 2.5 * Math.min(1, speed) * easeOutCubic(clamp01(f / 0.12)) : 0
    cr.save()
    cr.translate(x, y)
    cr.setLineWidth(Math.min(this._lineWidth, r * 0.3))
    cr.rotate(Math.atan2(vy, vx))
    cr.newPath()
    if (tail < 0.5) {
      cr.arc(0, 0, r, 0, 2 * Math.PI)
    } else {
      const beta = Math.acos(r / (r + tail))
      cr.moveTo(-(r + tail), 0)
      cr.arc(0, 0, r, Math.PI + beta, Math.PI - beta)
      cr.closePath()
    }

    const {r: fr, g: fg, b: fb} = this._fill
    cr.setSourceRGBA(fr / 255, fg / 255, fb / 255, alpha)
    if (this._outline) {
      cr.fillPreserve()
      const {r: or, g: og, b: ob} = this._outline
      cr.setSourceRGBA(or / 255, og / 255, ob / 255, alpha)
      cr.stroke()
    } else {
      cr.fill()
    }
    cr.restore()
  }

  destroy() {
    if (!this._container)
      return

    this._timeline.stop()
    this._timeline = null
    this._container.destroy()
    this._container = null

    const onDone = this._onDone
    this._onDone = null
    onDone?.()
  }
}
