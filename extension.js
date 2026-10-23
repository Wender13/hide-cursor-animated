import GLib from 'gi://GLib'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js'


// GJS caches modules by URL, so disabling and enabling an extension never
// picks up new code; normally that takes logging out. `make install` puts
// the code in a fresh build-* folder and names it in `current`, and enable()
// imports from there, so `make reload` swaps the code in place.
export default class HideCursorDrops extends Extension {
  enable() {
    const generation = this._generation = (this._generation ?? 0) + 1
    this._import().then(({HideCursor}) => {
      // Disabled while the import was pending.
      if (generation !== this._generation)
        return
      this._impl = new HideCursor(this.getSettings())
      this._impl.enable()
    }).catch(e => logError(e, 'hide-cursor-drops'))
  }

  disable() {
    this._generation++
    this._impl?.disable()
    this._impl = null
  }

  _import() {
    let build = '.'
    try {
      const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([this.path, 'current']))
      build = new TextDecoder().decode(bytes).trim()
    } catch {
      // Running straight from the source tree (`make link`) or a packed zip.
    }
    return import(this.dir.resolve_relative_path(`${build}/main.js`).get_uri())
  }
}
