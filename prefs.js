// SPDX-FileCopyrightText: 2026 Wender
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw'
import Gdk from 'gi://Gdk'
import Gio from 'gi://Gio'
import GioUnix from 'gi://GioUnix'
import Gtk from 'gi://Gtk'
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'

// Marks strings for translation; they are translated where they are shown.
const N_ = s => s

const HIDE_STYLES = [
  ['drops', N_('Drops')],
  ['shrink', N_('Shrink')],
  ['fade', N_('Fade')],
  ['ripple', N_('Ripple')],
  ['none', N_('None')],
]
const SHOW_STYLES = [
  ['drops', N_('Drops gathering')],
  ['grow', N_('Grow')],
  ['fade', N_('Fade')],
  ['ripple', N_('Ripple')],
  ['none', N_('None')],
]
const SHAPES = [
  ['teardrop', N_('Teardrop')],
  ['circle', N_('Ball')],
  ['spark', N_('Spark')],
]
const SOUNDS = [
  ['none', N_('No sound')],
  ['drop', N_('Drop (bundled)')],
  ['file', N_('Custom file')],
]


export default class HideCursorDropsPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    this._settings = this.getSettings()
    // Keep the settings (and their signal handlers) alive with the window.
    window._settings = this._settings
    window.set_default_size(640, 760)

    window.add(this._generalPage(window))
    window.add(this._animationPage())
    window.add(this._soundPage(window))
  }

  // Rows bound to settings

  _switchRow(key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle})
    this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT)
    return row
  }

  _spinRow(key, title, {lower, upper, step, digits = 0, subtitle = ''}) {
    const row = new Adw.SpinRow({
      title,
      subtitle,
      digits,
      numeric: true,
      adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    })
    this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT)
    return row
  }

  _comboRow(key, title, entries, subtitle = '') {
    const row = new Adw.ComboRow({
      title,
      subtitle,
      model: Gtk.StringList.new(entries.map(([, label]) => _(label))),
    })
    const sync = () => {
      const index = entries.findIndex(([value]) => value === this._settings.get_string(key))
      row.selected = Math.max(0, index)
    }
    sync()
    this._settings.connect(`changed::${key}`, sync)
    row.connect('notify::selected', () => {
      const value = entries[row.selected]?.[0]
      if (value && value !== this._settings.get_string(key))
        this._settings.set_string(key, value)
    })
    return row
  }

  // Makes rows sensitive only while `key` passes `test`.
  _sensitiveWhen(key, test, ...rows) {
    const sync = () => {
      const value = this._settings.get_value(key).recursiveUnpack()
      for (const row of rows)
        row.sensitive = test(value)
    }
    sync()
    this._settings.connect(`changed::${key}`, sync)
  }

  // Pages

  _generalPage(window) {
    const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'input-mouse-symbolic'})

    const hiding = new Adw.PreferencesGroup({title: _('Hiding')})
    hiding.add(this._spinRow('timeout', _('Hide after (seconds)'), {lower: 1, upper: 60, step: 1}))
    hiding.add(this._switchRow('hide-on-typing', _('Hide when typing'),
      _('Also when scrolling with the pointer at rest')))
    hiding.add(this._switchRow('animate-app-hide', _('Animate when an app hides the cursor'),
      _('Video players and fullscreen browsers hide the cursor by themselves')))
    page.add(hiding)

    page.add(this._excludedAppsGroup(window))
    return page
  }

  _animationPage() {
    const page = new Adw.PreferencesPage({title: _('Animation'), icon_name: 'applications-graphics-symbolic'})

    const hide = new Adw.PreferencesGroup({title: _('When Hiding')})
    const hideDuration = this._spinRow('animation-duration', _('Duration (ms)'), {lower: 150, upper: 3000, step: 50})
    hide.add(this._comboRow('hide-style', _('Style'), HIDE_STYLES))
    hide.add(hideDuration)
    this._sensitiveWhen('hide-style', v => v !== 'none', hideDuration)
    page.add(hide)

    const show = new Adw.PreferencesGroup({title: _('When Showing Again')})
    const showDuration = this._spinRow('show-duration', _('Duration (ms)'), {lower: 150, upper: 3000, step: 50})
    show.add(this._comboRow('show-style', _('Style'), SHOW_STYLES))
    show.add(showDuration)
    this._sensitiveWhen('show-style', v => v !== 'none', showDuration)
    page.add(show)

    const drops = new Adw.PreferencesGroup({
      title: _('Drops and Ripples'),
      description: _('Used by the Drops and Ripple styles. Size, distance and gravity are relative to the default (1.0).'),
    })
    drops.add(this._spinRow('drop-count', _('Number of drops'), {lower: 1, upper: 12, step: 1}))
    drops.add(this._comboRow('drop-shape', _('Shape'), SHAPES))
    drops.add(this._spinRow('drop-size', _('Size'), {lower: 0.5, upper: 2, step: 0.1, digits: 1}))
    drops.add(this._spinRow('drop-distance', _('Distance'), {lower: 0.5, upper: 2.5, step: 0.1, digits: 1}))
    drops.add(this._spinRow('drop-gravity', _('Gravity'), {lower: 0, upper: 3, step: 0.1, digits: 1,
      subtitle: _('0 makes the drops fly in a straight line')}))
    drops.add(this._switchRow('custom-color-enabled', _('Custom color'),
      _('Off: uses the color of the cursor itself')))
    const colorRow = this._colorRow()
    this._sensitiveWhen('custom-color-enabled', v => v, colorRow)
    drops.add(colorRow)
    page.add(drops)

    return page
  }

  _soundPage(window) {
    const page = new Adw.PreferencesPage({title: _('Sound'), icon_name: 'audio-volume-high-symbolic'})
    const group = new Adw.PreferencesGroup({
      title: _('Sounds'),
      description: _('Played as system sounds: they follow the “System Sounds” volume and GNOME’s alert sounds switch.'),
    })
    this._addSoundRows(window, group, 'hide', _('When Hiding'))
    this._addSoundRows(window, group, 'show', _('When Showing Again'))
    page.add(group)
    return page
  }

  // Composite rows

  _colorRow() {
    const button = new Gtk.ColorDialogButton({
      dialog: new Gtk.ColorDialog({with_alpha: false}),
      valign: Gtk.Align.CENTER,
    })
    const rgba = new Gdk.RGBA()
    if (rgba.parse(this._settings.get_string('custom-color')))
      button.rgba = rgba
    button.connect('notify::rgba', () => {
      const {red, green, blue} = button.rgba
      const hex = [red, green, blue]
        .map(c => Math.round(c * 255).toString(16).padStart(2, '0'))
        .join('')
      this._settings.set_string('custom-color', `#${hex}`)
    })

    const row = new Adw.ActionRow({title: _('Color')})
    row.add_suffix(button)
    row.activatable_widget = button
    return row
  }

  _soundFile(kind) {
    const mode = this._settings.get_string(`${kind}-sound`)
    if (mode === 'drop')
      return this.dir.get_child('sounds').get_child(`drop-${kind}.wav`)
    const path = this._settings.get_string(`${kind}-sound-file`)
    return mode === 'file' && path ? Gio.File.new_for_path(path) : null
  }

  _addSoundRows(window, group, kind, title) {
    const combo = this._comboRow(`${kind}-sound`, title, SOUNDS)
    const play = new Gtk.Button({
      icon_name: 'media-playback-start-symbolic',
      tooltip_text: _('Play'),
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
    })
    play.connect('clicked', () => {
      const file = this._soundFile(kind)
      if (!file)
        return
      // Held on the window so playback isn't cut short by GC.
      window._preview = Gtk.MediaFile.new_for_file(file)
      window._preview.play()
    })
    combo.add_suffix(play)
    group.add(combo)

    const fileRow = new Adw.ActionRow({title: _('File')})
    const choose = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER})
    choose.connect('clicked', () => {
      const filter = new Gtk.FileFilter({name: _('Audio')})
      filter.add_mime_type('audio/*')
      const filters = new Gio.ListStore({item_type: Gtk.FileFilter})
      filters.append(filter)
      const dialog = new Gtk.FileDialog({title: _('Choose a Sound'), filters})
      dialog.open(window, null, (_dialog, result) => {
        try {
          const file = dialog.open_finish(result)
          this._settings.set_string(`${kind}-sound-file`, file.get_path())
        } catch {
          // Cancelled.
        }
      })
    })
    fileRow.add_suffix(choose)
    group.add(fileRow)

    const sync = () => {
      const mode = this._settings.get_string(`${kind}-sound`)
      const path = this._settings.get_string(`${kind}-sound-file`)
      fileRow.visible = mode === 'file'
      fileRow.subtitle = path ? Gio.File.new_for_path(path).get_basename() : _('No file chosen')
      play.sensitive = !!this._soundFile(kind)
    }
    sync()
    this._settings.connect(`changed::${kind}-sound`, sync)
    this._settings.connect(`changed::${kind}-sound-file`, sync)
  }

  _excludedAppsGroup(window) {
    const group = new Adw.PreferencesGroup({
      title: _('Excluded Apps'),
      description: _('The cursor is never hidden automatically over these apps.'),
    })
    const add = new Gtk.Button({
      icon_name: 'list-add-symbolic',
      tooltip_text: _('Add App'),
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
    })
    add.connect('clicked', () => this._pickApp(window))
    group.set_header_suffix(add)

    let rows = []
    const sync = () => {
      for (const row of rows)
        group.remove(row)
      rows = []

      const ids = this._settings.get_strv('excluded-apps')
      for (const id of ids) {
        const app = GioUnix.DesktopAppInfo.new(id)
        const row = new Adw.ActionRow({
          title: app?.get_display_name() ?? id,
          use_markup: false,
          subtitle: app ? '' : _('App not found'),
        })
        row.add_prefix(app
          ? new Gtk.Image({gicon: app.get_icon(), pixel_size: 32})
          : new Gtk.Image({icon_name: 'application-x-executable-symbolic', pixel_size: 32}))
        const remove = new Gtk.Button({
          icon_name: 'user-trash-symbolic',
          tooltip_text: _('Remove'),
          valign: Gtk.Align.CENTER,
          css_classes: ['flat'],
        })
        remove.connect('clicked', () => this._settings.set_strv('excluded-apps',
          this._settings.get_strv('excluded-apps').filter(other => other !== id)))
        row.add_suffix(remove)
        rows.push(row)
      }
      if (!ids.length)
        rows.push(new Adw.ActionRow({title: _('No excluded apps'), css_classes: ['dim-label']}))
      for (const row of rows)
        group.add(row)
    }
    sync()
    this._settings.connect('changed::excluded-apps', sync)
    return group
  }

  _pickApp(window) {
    const excluded = this._settings.get_strv('excluded-apps')
    const apps = Gio.AppInfo.get_all()
      .filter(app => app.should_show() && app.get_id() && !excluded.includes(app.get_id()))
      .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()))

    const dialog = new Adw.Dialog({title: _('Add App'), content_width: 420, content_height: 560})
    const search = new Gtk.SearchEntry({placeholder_text: _('Search apps'), hexpand: true})
    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']})

    for (const app of apps) {
      const row = new Adw.ActionRow({title: app.get_display_name(), use_markup: false, activatable: true})
      row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 32}))
      row._search = `${app.get_display_name()} ${app.get_id()}`.toLowerCase()
      row.connect('activated', () => {
        this._settings.set_strv('excluded-apps', [...this._settings.get_strv('excluded-apps'), app.get_id()])
        dialog.close()
      })
      list.append(row)
    }
    list.set_filter_func(row => (row._search ?? '').includes(search.text.toLowerCase()))
    search.connect('search-changed', () => list.invalidate_filter())

    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 12,
      margin_top: 6,
      margin_bottom: 12,
      margin_start: 12,
      margin_end: 12,
    })
    box.append(search)
    box.append(new Gtk.ScrolledWindow({child: list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER}))

    const view = new Adw.ToolbarView({content: box})
    view.add_top_bar(new Adw.HeaderBar())
    dialog.child = view
    dialog.present(window)
    search.grab_focus()
  }
}
