# Hide Cursor Drops

A GNOME Shell extension that hides the mouse cursor after a period of
inactivity, with an animation: the cursor quickly shrinks into its center,
three small balls pop out of it, and each one shoots off to its own side,
stretching into a drop before it fades away.

The drops take the color of the cursor itself. The extension reads the
current cursor image and uses its fill color for the drops and its outline
color for their border, so it follows your cursor theme and the cursor's
current shape (arrow, text beam, busy spinner, ...).

Works on Wayland. Supports GNOME Shell 49 and 50.

## Settings

- **Hide after** – seconds of inactivity before the cursor hides (default 5).
- **Animate when hiding** – turn the animation off to just hide the cursor.
- **Duration** – animation length in milliseconds (default 900).
- **Custom drop color** – use a fixed color instead of the cursor's.

Moving the mouse shows the cursor again immediately, cancelling the
animation if it is still running.

## Installation

```sh
git clone https://github.com/Wender13/hide-cursor-animated.git
cd hide-cursor-animated
make install
```

Then log out and back in (GNOME on Wayland only discovers new extensions at
login) and enable it:

```sh
gnome-extensions enable hide-cursor-drops@jr
```

If you use another cursor-hiding extension, such as
[Hide Cursor](https://github.com/elcste/hide-cursor), disable it first; both
would fight over the cursor.

`make uninstall` removes it. `make pack` builds a zip for
`gnome-extensions install`.

## Development

GJS caches modules by URL, so GNOME Shell normally keeps running an
extension's old code until you log out. To avoid that, `extension.js` is a
small loader: `make install` copies the code into a fresh `build-*` folder
and the loader imports it from there on every enable. After the first
login with the extension installed, apply changes with:

```sh
make reload
```

This only covers `main.js`, `animation.js` and `sprite.js`. Changes to
`extension.js`, `prefs.js` or `metadata.json` still need a logout.

### Files

| File | Purpose |
|------|---------|
| `extension.js` | Loader that imports the current build |
| `main.js` | Idle detection, hiding and showing the cursor |
| `animation.js` | The shrink and drops animation |
| `sprite.js` | Reads the cursor image and finds its colors and visual center |
| `prefs.js` | Preferences window |

Logs from the extension show up in `journalctl --user -f -o cat /usr/bin/gnome-shell`.

## License

Licensed under the GNU General Public License, version 2 or (at your
option) any later version, like GNOME Shell itself. See [LICENSE](LICENSE).
