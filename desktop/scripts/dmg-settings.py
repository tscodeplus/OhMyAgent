# dmgbuild settings — OhMyAgent dmg layout.
#
# tauri's bundler lays out the dmg (app icon + /Applications drop target) by
# driving Finder via AppleScript, which needs a TCC automation grant and hangs
# on headless CI runners. dmgbuild writes the layout (.DS_Store) directly from
# Python — no Finder, no AppleScript — so it works on GitHub Actions.
#
# Usage (from the repo root):
#   dmgbuild -D app_path=desktop/src-tauri/target/release/bundle/macos/OhMyAgent.app \
#            -s desktop/scripts/dmg-settings.py OhMyAgent out.dmg

import os

app_path = defines['app_path']
app_name = os.path.basename(app_path)

files = [app_path]
symlinks = {'Applications': '/Applications'}
format = 'UDZO'
# App bundle is ~230 MB uncompressed; give the filesystem headroom on top.
size = '320m'

# Window ((x, y), (w, h)) in points. Wide enough for the two icons side by
# side with labels, centered on screen.
window_rect = ((100, 100), (640, 400))

# App on the left, /Applications link on the right — both centered between
# the window edges (Finder labels sit below the icons, so the icons sit a
# touch above the vertical midpoint; y is measured from the window top).
icon_locations = {
    app_name: (140, 140),
    'Applications': (500, 140),
}

icon_size = 100
text_size = 12
label_pos = 'bottom'
