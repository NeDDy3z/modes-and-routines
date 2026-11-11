# modes-and-routines

GNOME Shell extension that adds Android-like (Samsung) Modes to Quick Settings.

A **Modes** toggle sits next to Wi-Fi/Bluetooth. Expand it to pick a mode. Starting a mode runs its actions in order; turning it off undoes them in reverse order. While a mode is on, its icon shows in the top bar. Only one mode runs at a time: picking another one turns the current one off first.

## Actions

| Action | When turned on | When turned off (default: restore) |
| --- | --- | --- |
| Display | Adds a display to the current layout, or uses only that display | Puts the previous display layout back |
| Audio output | Switches the default sound output | Switches back to the previous output |
| Open websites | Opens the URLs in Firefox with a separate profile for this mode, optionally fullscreen (kiosk) | Closes that Firefox instance |
| Run command | Runs a shell command | Runs another command, if set |

Every action can instead run its own command when the mode turns off, or do nothing.

Example: a "Movie" mode could add a second display, switch the sound to it and open a streaming site fullscreen. Turning it off closes the browser, switches the sound back and restores the display layout.

## Install (from source)

Needs GNOME Shell 51, `pactl` (PipeWire/PulseAudio), `gdctl` (ships with Mutter) and Firefox for the websites action.

```sh
glib-compile-schemas schemas/
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/modes-and-routines@erikvanek
gnome-extensions enable modes-and-routines@erikvanek
```

On Wayland, log out and back in so GNOME Shell picks it up. Set up modes in the extension settings (or "Mode Settings" in the Modes menu).

Errors show as a notification. Logs: `journalctl -f -o cat /usr/bin/gnome-shell`.

## Development

`gjs -m test.js` runs a self-check of the start/stop logic.

## Not yet

Routines (automatic triggers like time, Wi-Fi network or a display being plugged in).
