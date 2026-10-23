// SPDX-FileCopyrightText: 2026 Wender
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw'
import Gdk from 'gi://Gdk'
import Gio from 'gi://Gio'
import Gtk from 'gi://Gtk'
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'


export default class HideCursorDropsPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings()
    window._settings = settings

    const page = new Adw.PreferencesPage({
      title: 'Geral',
      icon_name: 'input-mouse-symbolic',
    })
    window.add(page)

    const hiding = new Adw.PreferencesGroup({title: 'Ocultar cursor'})
    page.add(hiding)

    const timeoutRow = new Adw.SpinRow({
      title: 'Ocultar após (segundos)',
      adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, page_increment: 5}),
      numeric: true,
    })
    settings.bind('timeout', timeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT)
    hiding.add(timeoutRow)

    const anim = new Adw.PreferencesGroup({title: 'Animação'})
    page.add(anim)

    const enabledRow = new Adw.SwitchRow({
      title: 'Animar ao ocultar',
      subtitle: 'O cursor encolhe e se desfaz em três gotas',
    })
    settings.bind('animation-enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT)
    anim.add(enabledRow)

    const durationRow = new Adw.SpinRow({
      title: 'Duração (ms)',
      adjustment: new Gtk.Adjustment({lower: 150, upper: 2000, step_increment: 50, page_increment: 250}),
      numeric: true,
    })
    settings.bind('animation-duration', durationRow, 'value', Gio.SettingsBindFlags.DEFAULT)
    settings.bind('animation-enabled', durationRow, 'sensitive', Gio.SettingsBindFlags.GET)
    anim.add(durationRow)

    const customRow = new Adw.SwitchRow({
      title: 'Cor personalizada das gotas',
      subtitle: 'Desligado: usa a cor do próprio cursor',
    })
    settings.bind('custom-color-enabled', customRow, 'active', Gio.SettingsBindFlags.DEFAULT)
    settings.bind('animation-enabled', customRow, 'sensitive', Gio.SettingsBindFlags.GET)
    anim.add(customRow)

    const colorButton = new Gtk.ColorDialogButton({
      dialog: new Gtk.ColorDialog({with_alpha: false}),
      valign: Gtk.Align.CENTER,
    })
    const rgba = new Gdk.RGBA()
    if (rgba.parse(settings.get_string('custom-color')))
      colorButton.rgba = rgba
    colorButton.connect('notify::rgba', () => {
      const {red, green, blue} = colorButton.rgba
      const hex = [red, green, blue]
        .map(c => Math.round(c * 255).toString(16).padStart(2, '0'))
        .join('')
      settings.set_string('custom-color', `#${hex}`)
    })

    const colorRow = new Adw.ActionRow({title: 'Cor'})
    colorRow.add_suffix(colorButton)
    colorRow.activatable_widget = colorButton
    settings.bind('custom-color-enabled', colorRow, 'sensitive', Gio.SettingsBindFlags.GET)
    anim.add(colorRow)
  }
}
