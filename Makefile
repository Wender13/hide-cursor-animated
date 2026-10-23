UUID := hide-cursor-drops@wender13.github.io
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
BUILD := build-$(shell date +%s%N)
# Loaded once per session (prefs.js: per preferences app run); changes here
# need a logout. sounds/ and locale/ are installed next to them.
STATIC := extension.js prefs.js metadata.json
# Imported from a fresh build-* folder on every enable; see extension.js.
CODE := main.js animation.js sprite.js
LINGUAS := $(shell cat po/LINGUAS)
MO := $(foreach l,$(LINGUAS),locale/$(l)/LC_MESSAGES/hide-cursor-drops.mo)

.PHONY: install reload link uninstall pack pot clean

schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas --strict schemas

locale/%/LC_MESSAGES/hide-cursor-drops.mo: po/%.po
	mkdir -p $(dir $@)
	msgfmt --check -o $@ $<

# Refreshes the translation template and merges it into each language.
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=N_ \
		--no-wrap --add-comments=Translators --package-name=hide-cursor-drops \
		--msgid-bugs-address=https://github.com/Wender13/hide-cursor-animated/issues \
		-o po/hide-cursor-drops.pot prefs.js
	for l in $(LINGUAS); do msgmerge --update --no-wrap --backup=none po/$$l.po po/hide-cursor-drops.pot; done

install: schemas/gschemas.compiled $(MO)
	if [ -L $(DEST) ]; then rm $(DEST); fi
	mkdir -p $(DEST)/$(BUILD)
	find $(DEST) -mindepth 1 -maxdepth 1 ! -name $(BUILD) -exec rm -rf {} +
	mkdir -p $(DEST)/schemas
	cp $(STATIC) $(DEST)/
	cp -r sounds locale $(DEST)/
	cp $(CODE) $(DEST)/$(BUILD)/
	cp schemas/*.gschema.xml schemas/gschemas.compiled $(DEST)/schemas/
	echo $(BUILD) > $(DEST)/current

# Installs and restarts the extension in the running session, no logout.
reload: install
	gnome-extensions disable $(UUID)
	gnome-extensions enable $(UUID)

# For development: the installed extension points at this folder (changes
# then only take effect after logging out).
link: schemas/gschemas.compiled $(MO)
	rm -rf $(DEST)
	ln -s $(CURDIR) $(DEST)

uninstall:
	rm -rf $(DEST)

pack: schemas/gschemas.compiled
	gnome-extensions pack --force --podir=po --extra-source=main.js \
		--extra-source=animation.js --extra-source=sprite.js --extra-source=sounds .

clean:
	rm -rf schemas/gschemas.compiled locale *.shell-extension.zip
