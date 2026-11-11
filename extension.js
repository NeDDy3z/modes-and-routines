import GObject from 'gi://GObject';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {startMode, stopMode} from './actions.js';

const DEFAULT_ICON = 'view-grid-symbolic';

function parse(json, fallback) {
    try {
        return json ? JSON.parse(json) : fallback;
    } catch {
        return fallback;
    }
}

const ModesToggle = GObject.registerClass(
class ModesToggle extends QuickMenuToggle {
    _init(extension) {
        super._init({title: 'Modes', iconName: DEFAULT_ICON, toggleMode: false});
        this._extension = extension;

        this.menu.setHeader(DEFAULT_ICON, 'Modes');
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Mode Settings', () => {
            Main.panel.closeQuickSettings();
            extension.openPreferences();
        });

        this.connect('clicked', () => extension.toggle());
    }

    sync(modes, active) {
        this.checked = !!active;
        this.subtitle = active?.mode.name ?? null;
        this.iconName = active?.mode.icon || DEFAULT_ICON;

        this._section.removeAll();
        for (const mode of modes) {
            const item = new PopupMenu.PopupImageMenuItem(mode.name, mode.icon || DEFAULT_ICON);
            item.setOrnament(mode.id === active?.mode.id ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._extension.switchTo(mode.id === active?.mode.id ? null : mode));
            this._section.addMenuItem(item);
        }
        if (!modes.length)
            this._section.addMenuItem(new PopupMenu.PopupMenuItem('No modes yet', {reactive: false}));
    }
});

const ModesIndicator = GObject.registerClass(
class ModesIndicator extends SystemIndicator {
    _init(extension) {
        super._init();
        this._icon = this._addIndicator();
        this.toggle = new ModesToggle(extension);
        this.quickSettingsItems.push(this.toggle);
    }

    sync(modes, active) {
        this._icon.visible = !!active;
        this._icon.iconName = active?.mode.icon || DEFAULT_ICON;
        this.toggle.sync(modes, active);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class ModesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._busy = false;
        this._indicator = new ModesIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._settings.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    // Modes keep running while disabled (e.g. screen lock); the active state stays in settings.
    disable() {
        this._settings.disconnectObject(this);
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _modes() {
        return parse(this._settings.get_string('modes'), []);
    }

    _active() {
        return parse(this._settings.get_string('active'), null);
    }

    _sync() {
        this._indicator.sync(this._modes(), this._active());
    }

    toggle() {
        if (this._active()) {
            this.switchTo(null);
            return;
        }
        const modes = this._modes();
        const last = this._settings.get_string('last-mode');
        const mode = modes.find(m => m.id === last) ?? modes[0];
        if (mode)
            this.switchTo(mode);
        else
            this.openPreferences();
    }

    async switchTo(mode) {
        if (this._busy)
            return;
        this._busy = true;
        const settings = this._settings;
        const errors = [];
        try {
            const active = this._active();
            if (active) {
                errors.push(...await stopMode(active.mode, active.snapshots));
                settings.set_string('active', '');
            }
            if (mode) {
                const {snapshots, errors: startErrors} = await startMode(mode);
                errors.push(...startErrors);
                settings.set_string('active', JSON.stringify({mode, snapshots}));
                settings.set_string('last-mode', mode.id);
            }
        } catch (e) {
            errors.push(e.message);
        } finally {
            this._busy = false;
        }
        if (errors.length)
            Main.notifyError('Modes', errors.join('\n'));
    }
}
