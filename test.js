// Run with: gjs -m test.js
import {gdctlArgs, startMode, stopMode} from './actions.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(`FAIL: ${message}`);
}

const calls = [];
const fake = name => ({
    async on(action) {
        calls.push(`${name}.on:${action.command ?? ''}`);
        if (action.fail)
            throw new Error(`${name} broke`);
        return `${name}-snap`;
    },
    async restore(action, snapshot) {
        calls.push(`${name}.restore:${snapshot}`);
    },
});
const handlers = {display: fake('display'), audio: fake('audio'), browser: fake('browser'), command: fake('command')};

const mode = {
    id: 'sample',
    actions: [
        {type: 'display', off: 'restore'},
        {type: 'audio', off: 'restore', fail: true},
        {type: 'browser', off: 'nothing'},
        {type: 'command', command: 'x', off: 'command', offCommand: 'y'},
    ],
};

const {snapshots, errors} = await startMode(mode, handlers);
assert(errors.length === 1 && errors[0] === 'audio broke', 'start collects errors and keeps going');
assert(snapshots[1] === null && snapshots[0] === 'display-snap', 'failed action has no snapshot');

calls.length = 0;
const stopErrors = await stopMode(mode, snapshots, handlers);
assert(stopErrors.length === 0, 'stop has no errors');
assert(JSON.stringify(calls) === JSON.stringify(['command.on:y', 'display.restore:display-snap']),
    `stop runs in reverse, skips failed/nothing actions: ${calls}`);

const argv = gdctlArgs([
    {x: 0, y: 0, scale: 1, transform: 1, primary: true, monitors: [{connector: 'DP-2', mode: '2560x1440@120.010'}]},
    {rightOf: 'DP-2', scale: 1, transform: 0, primary: false, monitors: [{connector: 'HDMI-2', mode: '1920x1080@60.000'}]},
]).join(' ');
assert(argv === 'gdctl set -L -x 0 -y 0 -s 1 -t 90 -p -M DP-2 -m 2560x1440@120.010 -L --right-of DP-2 -s 1 -t normal -M HDMI-2 -m 1920x1080@60.000',
    `gdctl args: ${argv}`);

print('ok');
