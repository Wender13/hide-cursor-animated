UUID := hide-cursor-drops@jr
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
BUILD := build-$(shell date +%s%N)
# Loaded once per session; changes here need a logout.
STATIC := extension.js prefs.js metadata.json
# Imported from a fresh build-* folder on every enable; see extension.js.
CODE := main.js animation.js sprite.js

.PHONY: install reload link uninstall pack clean

schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas --strict schemas

install: schemas/gschemas.compiled
	if [ -L $(DEST) ]; then rm $(DEST); fi
	mkdir -p $(DEST)/$(BUILD)
	find $(DEST) -mindepth 1 -maxdepth 1 ! -name $(BUILD) -exec rm -rf {} +
	mkdir -p $(DEST)/schemas
	cp $(STATIC) $(DEST)/
	cp $(CODE) $(DEST)/$(BUILD)/
	cp schemas/*.gschema.xml schemas/gschemas.compiled $(DEST)/schemas/
	echo $(BUILD) > $(DEST)/current

# Installs and restarts the extension in the running session, no logout.
reload: install
	gnome-extensions disable $(UUID)
	gnome-extensions enable $(UUID)

# For development: the installed extension points at this folder (changes
# then only take effect after logging out).
link: schemas/gschemas.compiled
	rm -rf $(DEST)
	ln -s $(CURDIR) $(DEST)

uninstall:
	rm -rf $(DEST)

pack: schemas/gschemas.compiled
	gnome-extensions pack --force --extra-source=main.js --extra-source=animation.js --extra-source=sprite.js .

clean:
	rm -f schemas/gschemas.compiled *.shell-extension.zip
