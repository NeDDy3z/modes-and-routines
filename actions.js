import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

export async function run(argv) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
    if (!proc.get_successful())
        throw new Error(`${argv.join(' ')}: ${stderr.trim()}`);
    return stdout.trim();
}

// No pipes: a command that starts a background program would keep them open forever.
async function runShell(command) {
    const proc = Gio.Subprocess.new(['sh', '-c', command], Gio.SubprocessFlags.NONE);
    try {
        await proc.wait_check_async(null);
    } catch {
        throw new Error(`"${command}" exited with ${proc.get_exit_status()}`);
    }
}

export async function listSinks() {
    const sinks = JSON.parse(await run(['pactl', '-f', 'json', 'list', 'sinks']));
    return sinks.map(s => ({
        id: s.name,
        label: s.description && s.description !== '(null)' ? s.description : s.name,
    }));
}

async function getDisplayState() {
    const reply = await Gio.DBus.session.call(
        'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', 'GetCurrentState',
        null, null, Gio.DBusCallFlags.NONE, -1, null);
    const [, monitors, logical] = reply.recursiveUnpack();
    return {monitors, logical};
}

export async function listMonitors() {
    const {monitors} = await getDisplayState();
    return monitors.map(([[connector], , props]) => ({
        id: connector,
        label: `${props['display-name'] ?? connector} (${connector})`,
    }));
}

function currentMode(monitor) {
    const modes = monitor[1];
    return (modes.find(m => m[6]['is-current']) ?? modes.find(m => m[6]['is-preferred']) ?? modes[0]);
}

function currentLayout({monitors, logical}) {
    return logical.map(([x, y, scale, transform, primary, specs]) => ({
        x, y, scale, transform, primary,
        monitors: specs.map(([connector]) => ({
            connector,
            mode: currentMode(monitors.find(m => m[0][0] === connector))[0],
        })),
    }));
}

const TRANSFORMS = ['normal', '90', '180', '270', 'flipped', 'flipped-90', 'flipped-180', 'flipped-270'];

export function gdctlArgs(layout) {
    const argv = ['gdctl', 'set'];
    for (const lm of layout) {
        argv.push('-L');
        if (lm.rightOf)
            argv.push('--right-of', lm.rightOf);
        else
            argv.push('-x', `${lm.x}`, '-y', `${lm.y}`);
        argv.push('-s', `${lm.scale}`, '-t', TRANSFORMS[lm.transform]);
        if (lm.primary)
            argv.push('-p');
        for (const m of lm.monitors)
            argv.push('-M', m.connector, '-m', m.mode);
    }
    return argv;
}

const audio = {
    async on(action) {
        const previous = await run(['pactl', 'get-default-sink']);
        await run(['pactl', 'set-default-sink', action.sink]);
        return previous;
    },
    async restore(action, previous) {
        await run(['pactl', 'set-default-sink', previous]);
    },
};

const display = {
    async on(action) {
        const state = await getDisplayState();
        const previous = currentLayout(state);
        const monitor = state.monitors.find(m => m[0][0] === action.connector);
        if (!monitor)
            throw new Error(`Display ${action.connector} is not connected`);
        const mode = currentMode(monitor);
        const target = {scale: mode[4], transform: 0, monitors: [{connector: action.connector, mode: mode[0]}]};

        let layout;
        if (action.layout === 'only') {
            layout = [{...target, x: 0, y: 0, primary: true}];
        } else if (previous.some(lm => lm.monitors.some(m => m.connector === action.connector))) {
            return previous;
        } else {
            // shortcut: places it right of the logical monitor that starts furthest right, not the true right edge
            const rightmost = previous.reduce((r, lm) => (lm.x > r.x ? lm : r));
            layout = [...previous, {...target, rightOf: rightmost.monitors[0].connector, primary: false}];
        }
        await run(gdctlArgs(layout));
        return previous;
    },
    async restore(action, previous) {
        await run(gdctlArgs(previous));
    },
};

const browser = {
    async on(action, mode) {
        const profile = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell-modes', 'profiles', mode.id]);
        GLib.mkdir_with_parents(profile, 0o700);
        Gio.Subprocess.new([
            'firefox', '--new-instance', '--profile', profile,
            ...(action.kiosk ? ['--kiosk'] : []),
            ...action.urls,
        ], Gio.SubprocessFlags.NONE);
        return profile;
    },
    async restore(action, profile) {
        await run(['pkill', '-f', '--', `--profile ${profile}`]).catch(() => {});
    },
};

const command = {
    async on(action) {
        await runShell(action.command);
        return null;
    },
};

const app = {
    async on(action) {
        const info = GioUnix.DesktopAppInfo.new(action.app);
        if (!info)
            throw new Error(`App ${action.app} is not installed`);
        info.launch([], null);
        return null;
    },
};

const volume = {
    async on(action) {
        const previous = (await run(['pactl', 'get-sink-volume', '@DEFAULT_SINK@'])).match(/(\d+)%/)[1];
        await run(['pactl', 'set-sink-volume', '@DEFAULT_SINK@', `${action.volume}%`]);
        return previous;
    },
    async restore(action, previous) {
        await run(['pactl', 'set-sink-volume', '@DEFAULT_SINK@', `${previous}%`]);
    },
};

const quote = text => GLib.Variant.new_string(text).print(false);

// Snapshot is the same [schema, key, value] list with the old values, so restore just sets them back.
async function setKeys(keys) {
    const previous = [];
    for (const [schema, key, value] of keys) {
        previous.push([schema, key, await run(['gsettings', 'get', schema, key])]);
        await run(['gsettings', 'set', schema, key, value]);
    }
    return previous;
}

const gsettings = keysFor => ({
    on: action => setKeys(keysFor(action)),
    restore: (action, previous) => setKeys(previous),
});

const POWER = 'org.gnome.settings-daemon.plugins.power';

function dbusProperty(bus, name, path, iface, prop, type, valueOf) {
    const call = (method, args) => Gio.DBus[bus].call(name, path, 'org.freedesktop.DBus.Properties', method,
        args, null, Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, -1, null);
    const set = value => call('Set', new GLib.Variant('(ssv)', [iface, prop, new GLib.Variant(type, value)]));
    return {
        async on(action) {
            const [previous] = (await call('Get', new GLib.Variant('(ss)', [iface, prop]))).recursiveUnpack();
            await set(valueOf(action));
            return previous;
        },
        restore: (action, previous) => set(previous),
    };
}

const SYSTEM_COMMANDS = {
    lock: ['gdbus', 'call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver',
        '--method', 'org.gnome.ScreenSaver.Lock'],
    suspend: ['systemctl', 'suspend'],
    logout: ['gnome-session-quit', '--logout', '--no-prompt'],
    reboot: ['gnome-session-quit', '--reboot', '--no-prompt'],
    poweroff: ['gnome-session-quit', '--power-off', '--no-prompt'],
};

const system = {
    async on(action) {
        await run(SYSTEM_COMMANDS[action.power]);
        return null;
    },
};

export const HANDLERS = {
    audio, display, browser, command, app, volume, system,
    dnd: gsettings(a => [['org.gnome.desktop.notifications', 'show-banners', `${!a.enabled}`]]),
    nightlight: gsettings(a => [['org.gnome.settings-daemon.plugins.color', 'night-light-enabled', `${a.enabled}`]]),
    dark: gsettings(a => [['org.gnome.desktop.interface', 'color-scheme', quote(a.style)]]),
    wallpaper: gsettings(a => ['picture-uri', 'picture-uri-dark'].map(key =>
        ['org.gnome.desktop.background', key, quote(GLib.filename_to_uri(a.file, null))])),
    screen: gsettings(a => [['org.gnome.desktop.session', 'idle-delay', `${a.minutes * 60}`]]),
    sleep: gsettings(a => ['ac', 'battery'].flatMap(source => [
        [POWER, `sleep-inactive-${source}-type`, quote(a.minutes ? 'suspend' : 'nothing')],
        [POWER, `sleep-inactive-${source}-timeout`, `${a.minutes * 60}`],
    ])),
    power: dbusProperty('system', 'org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles',
        'org.freedesktop.UPower.PowerProfiles', 'ActiveProfile', 's', a => a.profile),
    wifi: dbusProperty('system', 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
        'org.freedesktop.NetworkManager', 'WirelessEnabled', 'b', a => a.enabled),
    bluetooth: dbusProperty('session', 'org.gnome.SettingsDaemon.Rfkill', '/org/gnome/SettingsDaemon/Rfkill',
        'org.gnome.SettingsDaemon.Rfkill', 'BluetoothAirplaneMode', 'b', a => !a.enabled),
};

export async function startMode(mode, handlers = HANDLERS) {
    const snapshots = [];
    const errors = [];
    for (const action of mode.actions) {
        try {
            snapshots.push(await handlers[action.type].on(action, mode) ?? null);
        } catch (e) {
            snapshots.push(null);
            errors.push(e.message);
        }
    }
    return {snapshots, errors};
}

export async function stopMode(mode, snapshots, handlers = HANDLERS) {
    const errors = [];
    for (let i = mode.actions.length - 1; i >= 0; i--) {
        const action = mode.actions[i];
        try {
            if (action.off === 'command' && action.offCommand)
                await handlers.command.on({command: action.offCommand}, mode);
            else if (action.off === 'restore' && snapshots[i] !== null)
                await handlers[action.type].restore?.(action, snapshots[i]);
        } catch (e) {
            errors.push(e.message);
        }
    }
    return errors;
}
