import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {listMonitors, listSinks} from './actions.js';

const DEFAULT_ICON = 'view-grid-symbolic';

const TYPES = [
    {id: 'display', label: 'Display'},
    {id: 'audio', label: 'Audio output'},
    {id: 'browser', label: 'Open websites'},
    {id: 'command', label: 'Run command'},
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
    const action = {type, off: type === 'command' ? 'command' : 'restore', offCommand: ''};
    if (type === 'display')
        Object.assign(action, {connector: '', layout: 'extend'});
    if (type === 'audio')
        action.sink = '';
    if (type === 'browser')
        Object.assign(action, {urls: [], kiosk: false});
    if (type === 'command')
        action.command = '';
    return action;
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
        const iconPreview = new Gtk.Image({icon_name: mode.icon || DEFAULT_ICON});
        const iconRow = entryRow('Icon name (e.g. video-display-symbolic)', mode.icon, text => {
            mode.icon = text;
            iconPreview.icon_name = text || DEFAULT_ICON;
            this._save();
        });
        iconRow.add_suffix(iconPreview);
        general.add(iconRow);
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
            mode.actions.push(newAction(TYPES[typeDropdown.selected].id));
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
        const group = new Adw.PreferencesGroup({title: `${index + 1}. ${TYPES.find(t => t.id === action.type).label}`});

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
        } else {
            group.add(entryRow('Command', action.command, text => set('command', text)));
        }

        const choices = action.type === 'command' ? OFF_CHOICES.filter(c => c.id !== 'restore') : OFF_CHOICES;
        const offCommand = entryRow('Command when turned off', action.offCommand, text => set('offCommand', text));
        offCommand.visible = action.off === 'command';
        group.add(comboRow('When turned off', choices, action.off, id => {
            set('off', id);
            offCommand.visible = id === 'command';
        }));
        group.add(offCommand);
        return group;
    }
}
