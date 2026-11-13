import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {listMonitors, listSinks} from './actions.js';

const DEFAULT_ICON = 'view-grid-symbolic';

const TYPES = [
    {id: 'display', label: 'Display', defaults: {connector: '', layout: 'extend'}},
    {id: 'audio', label: 'Audio output', defaults: {sink: ''}},
    {id: 'volume', label: 'Volume', defaults: {volume: 50}},
    {id: 'browser', label: 'Open websites', defaults: {urls: [], kiosk: false}},
    {id: 'app', label: 'Open app', defaults: {app: '', off: 'nothing'}, noRestore: true},
    {id: 'command', label: 'Run command', defaults: {command: '', off: 'command'}, noRestore: true},
    {id: 'dnd', label: 'Do Not Disturb', defaults: {enabled: true}},
    {id: 'dark', label: 'Dark or light style', defaults: {style: 'prefer-dark'}},
    {id: 'nightlight', label: 'Night Light', defaults: {enabled: true}},
    {id: 'wallpaper', label: 'Wallpaper', defaults: {file: ''}},
    {id: 'wifi', label: 'Wi-Fi', defaults: {enabled: false}},
    {id: 'bluetooth', label: 'Bluetooth', defaults: {enabled: false}},
    {id: 'power', label: 'Power mode', defaults: {profile: 'performance'}},
    {id: 'screen', label: 'Screen blank delay', defaults: {minutes: 0}},
    {id: 'sleep', label: 'Automatic suspend', defaults: {minutes: 0}},
    {id: 'system', label: 'Lock, suspend or power off', defaults: {power: 'lock', off: 'nothing'}, noRestore: true},
];

const STYLES = [
    {id: 'prefer-dark', label: 'Dark'},
    {id: 'default', label: 'Light'},
];

const PROFILES = [
    {id: 'performance', label: 'Performance'},
    {id: 'balanced', label: 'Balanced'},
    {id: 'power-saver', label: 'Power saver'},
];

const DELAYS = [0, 1, 2, 5, 10, 15, 30, 60, 120].map(m => ({id: m, label: m ? `${m} min` : 'Never'}));

const SYSTEM_ACTIONS = [
    {id: 'lock', label: 'Lock screen'},
    {id: 'suspend', label: 'Suspend'},
    {id: 'logout', label: 'Log out'},
    {id: 'reboot', label: 'Restart'},
    {id: 'poweroff', label: 'Power off'},
];

const OFF_CHOICES = [
    {id: 'restore', label: 'Restore previous state'},
    {id: 'command', label: 'Run a command'},
    {id: 'nothing', label: 'Do nothing'},
];

const LAYOUTS = [
    {id: 'extend', label: 'Add to current displays'},
    {id: 'only', label: 'Use only this display'},
];

function newAction(type) {
    return {type: type.id, off: 'restore', offCommand: '', ...type.defaults};
}

function iconRow(icon, onChange) {
    const row = new Adw.ActionRow({title: 'Icon'});
    const preview = new Gtk.Image({icon_name: icon || DEFAULT_ICON});
    const search = new Gtk.SearchEntry({placeholder_text: 'Search icons'});
    const grid = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, min_children_per_line: 8, max_children_per_line: 8, homogeneous: true});
    grid.set_filter_func(child => child.child.tooltip_text.includes(search.text.toLowerCase()));
    search.connect('search-changed', () => grid.invalidate_filter());
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    box.append(search);
    box.append(new Gtk.ScrolledWindow({child: grid, hscrollbar_policy: Gtk.PolicyType.NEVER, min_content_height: 320, min_content_width: 380}));
    const popover = new Gtk.Popover({child: box});
    const button = new Gtk.MenuButton({child: preview, popover, valign: Gtk.Align.CENTER, tooltip_text: 'Pick icon'});
    row.add_suffix(button);
    row.activatable_widget = button;

    // Filled on first open: the theme has hundreds of symbolic icons.
    popover.connect('show', () => {
        if (grid.get_first_child())
            return;
        const names = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).get_icon_names()
            .filter(n => n.endsWith('-symbolic')).sort();
        for (const name of names) {
            const item = new Gtk.Button({icon_name: name, tooltip_text: name});
            item.add_css_class('flat');
            item.connect('clicked', () => {
                preview.icon_name = name;
                popover.popdown();
                onChange(name);
            });
            grid.append(item);
        }
    });
    return row;
}

function comboRow(title, items, selectedId, onChange) {
    if (selectedId && !items.some(i => i.id === selectedId))
        items = [...items, {id: selectedId, label: `${selectedId} (not available)`}];
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(items.map(i => i.label)),
        selected: Math.max(0, items.findIndex(i => i.id === selectedId)),
    });
    row.connect('notify::selected', () => onChange(items[row.selected]?.id ?? ''));
    if (items.length && items[row.selected].id !== selectedId)
        onChange(items[row.selected].id);
    return row;
}

function entryRow(title, text, onChange) {
    const row = new Adw.EntryRow({title, text});
    row.connect('changed', () => onChange(row.text));
    return row;
}

export default class ModesPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._window = window;
        try {
            this._modes = JSON.parse(this._settings.get_string('modes'));
        } catch {
            this._modes = [];
        }
        [this._sinks, this._monitors] = await Promise.all([
            listSinks().catch(() => []),
            listMonitors().catch(() => []),
        ]);
        this._apps = Gio.AppInfo.get_all().filter(a => a.should_show())
            .map(a => ({id: a.get_id(), label: a.get_display_name()}))
            .sort((a, b) => a.label.localeCompare(b.label));

        const page = new Adw.PreferencesPage();
        this._list = new Adw.PreferencesGroup({
            title: 'Modes',
            description: 'Pick a mode in Quick Settings to run its actions. Turning it off undoes them in reverse order.',
        });
        const addButton = new Gtk.Button({icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Add mode'});
        addButton.add_css_class('flat');
        addButton.connect('clicked', () => {
            const mode = {id: GLib.uuid_string_random(), name: 'New mode', icon: DEFAULT_ICON, actions: []};
            this._modes.push(mode);
            this._save();
            this._openMode(mode);
        });
        this._list.set_header_suffix(addButton);
        page.add(this._list);
        window.add(page);
        this._listRows = [];
        this._renderList();
    }

    _save() {
        this._settings.set_string('modes', JSON.stringify(this._modes));
        this._renderList();
    }

    _renderList() {
        this._listRows.forEach(row => this._list.remove(row));
        this._listRows = this._modes.map(mode => {
            const row = new Adw.ActionRow({title: mode.name, subtitle: `${mode.actions.length} action(s)`, activatable: true});
            row.add_prefix(new Gtk.Image({icon_name: mode.icon || DEFAULT_ICON}));
            row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
            row.connect('activated', () => this._openMode(mode));
            this._list.add(row);
            return row;
        });
    }

    _openMode(mode) {
        const page = new Adw.PreferencesPage();
        const navPage = new Adw.NavigationPage({title: mode.name, child: new Adw.ToolbarView({content: page})});
        navPage.child.add_top_bar(new Adw.HeaderBar());

        const general = new Adw.PreferencesGroup();
        general.add(entryRow('Name', mode.name, text => {
            mode.name = text;
            navPage.title = text;
            this._save();
        }));
        general.add(iconRow(mode.icon, name => {
            mode.icon = name;
            this._save();
        }));
        page.add(general);

        const actionGroups = [];
        const typeDropdown = Gtk.DropDown.new_from_strings(TYPES.map(t => t.label));
        typeDropdown.valign = Gtk.Align.CENTER;
        const addButton = new Gtk.Button({icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Add action'});
        addButton.add_css_class('flat');
        const addBox = new Gtk.Box({spacing: 6});
        addBox.append(typeDropdown);
        addBox.append(addButton);
        const header = new Adw.PreferencesGroup({title: 'Actions', description: 'Run in this order when the mode turns on.'});
        header.set_header_suffix(addBox);
        page.add(header);

        const deleteGroup = new Adw.PreferencesGroup();
        const deleteButton = new Gtk.Button({label: 'Delete mode', halign: Gtk.Align.CENTER});
        deleteButton.add_css_class('destructive-action');
        deleteButton.connect('clicked', () => {
            this._modes = this._modes.filter(m => m !== mode);
            this._save();
            this._window.pop_subpage();
        });
        deleteGroup.add(deleteButton);

        const render = () => {
            actionGroups.forEach(g => page.remove(g));
            page.remove(deleteGroup);
            actionGroups.length = 0;
            mode.actions.forEach((action, index) => {
                const group = this._actionGroup(mode, action, index, render);
                page.add(group);
                actionGroups.push(group);
            });
            page.add(deleteGroup);
        };
        addButton.connect('clicked', () => {
            mode.actions.push(newAction(TYPES[typeDropdown.selected]));
            this._save();
            render();
        });
        page.add(deleteGroup);
        render();

        this._window.push_subpage(navPage);
    }

    _actionGroup(mode, action, index, render) {
        const set = (key, value) => {
            action[key] = value;
            this._save();
        };
        const type = TYPES.find(t => t.id === action.type);
        const group = new Adw.PreferencesGroup({title: `${index + 1}. ${type.label}`});

        const buttons = new Gtk.Box({spacing: 6});
        const addButton = (icon, tooltip, sensitive, onClick) => {
            const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, sensitive});
            button.add_css_class('flat');
            button.connect('clicked', () => {
                onClick();
                this._save();
                render();
            });
            buttons.append(button);
        };
        const move = to => mode.actions.splice(to, 0, ...mode.actions.splice(index, 1));
        addButton('go-up-symbolic', 'Move up', index > 0, () => move(index - 1));
        addButton('go-down-symbolic', 'Move down', index < mode.actions.length - 1, () => move(index + 1));
        addButton('user-trash-symbolic', 'Remove', true, () => mode.actions.splice(index, 1));
        group.set_header_suffix(buttons);

        if (action.type === 'display') {
            group.add(comboRow('Display', this._monitors, action.connector, id => set('connector', id)));
            group.add(comboRow('Layout', LAYOUTS, action.layout, id => set('layout', id)));
        } else if (action.type === 'audio') {
            group.add(comboRow('Output', this._sinks, action.sink, id => set('sink', id)));
        } else if (action.type === 'browser') {
            group.add(entryRow('Websites (separated by spaces)', action.urls.join(' '),
                text => set('urls', text.split(/\s+/).filter(Boolean))));
            const kiosk = new Adw.SwitchRow({title: 'Fullscreen (kiosk)', subtitle: 'Opens in Firefox with its own profile for this mode', active: action.kiosk});
            kiosk.connect('notify::active', () => set('kiosk', kiosk.active));
            group.add(kiosk);
        } else if (action.type === 'command') {
            group.add(entryRow('Command', action.command, text => set('command', text)));
        } else if (action.type === 'app') {
            group.add(comboRow('App', this._apps, action.app, id => set('app', id)));
        } else if (action.type === 'volume') {
            const spin = Adw.SpinRow.new_with_range(0, 150, 5);
            spin.title = 'Volume (%)';
            spin.value = action.volume;
            spin.connect('notify::value', () => set('volume', spin.value));
            group.add(spin);
        } else if (['dnd', 'nightlight', 'wifi', 'bluetooth'].includes(action.type)) {
            const toggle = new Adw.SwitchRow({title: `Turn ${type.label} on`, subtitle: 'Off turns it off', active: action.enabled});
            toggle.connect('notify::active', () => set('enabled', toggle.active));
            group.add(toggle);
        } else if (action.type === 'dark') {
            group.add(comboRow('Style', STYLES, action.style, id => set('style', id)));
        } else if (action.type === 'power') {
            group.add(comboRow('Power mode', PROFILES, action.profile, id => set('profile', id)));
        } else if (action.type === 'screen') {
            group.add(comboRow('Blank screen after', DELAYS, action.minutes, id => set('minutes', id)));
        } else if (action.type === 'sleep') {
            group.add(comboRow('Suspend after', DELAYS, action.minutes, id => set('minutes', id)));
        } else if (action.type === 'system') {
            group.add(comboRow('Action', SYSTEM_ACTIONS, action.power, id => set('power', id)));
        } else if (action.type === 'wallpaper') {
            group.add(this._fileRow(action.file, file => set('file', file)));
        }

        const choices = type.noRestore ? OFF_CHOICES.filter(c => c.id !== 'restore') : OFF_CHOICES;
        const offCommand = entryRow('Command when turned off', action.offCommand, text => set('offCommand', text));
        offCommand.visible = action.off === 'command';
        group.add(comboRow('When turned off', choices, action.off, id => {
            set('off', id);
            offCommand.visible = id === 'command';
        }));
        group.add(offCommand);
        return group;
    }

    _fileRow(file, onChange) {
        const row = new Adw.ActionRow({title: 'Image', subtitle: file ? GLib.path_get_basename(file) : 'None'});
        const button = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Choose image'});
        button.add_css_class('flat');
        const filter = new Gtk.FileFilter({name: 'Images'});
        filter.add_mime_type('image/*');
        button.connect('clicked', () => {
            new Gtk.FileDialog({default_filter: filter}).open(this._window, null, (dialog, result) => {
                let picked;
                try {
                    picked = dialog.open_finish(result).get_path();
                } catch {
                    return; // cancelled
                }
                row.subtitle = GLib.path_get_basename(picked);
                onChange(picked);
            });
        });
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }
}
