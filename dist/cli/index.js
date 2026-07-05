import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import qrcodeTerminal from 'qrcode-terminal';
import { createGatewayClient } from "./gateway-client.js";
import { install, uninstall } from "./install.js";
import { qr } from "./pairing.js";
import { setInterception, status } from "./remote.js";
import { selectMenu } from "./select-menu.js";
import { rotate } from "./rotate.js";
const USAGE = `usage:
  slopdeck install [--gateway-url https://your-deck-host]
  slopdeck uninstall
  slopdeck on|off     flip interception (the deck's Pause switch, remotely)
  slopdeck status     diagnose the whole chain on one screen
  slopdeck qr         re-print the phone-pairing QR
  slopdeck rotate     mint a fresh key and re-pair (the old key stops working)`;
const BARE_COMMANDS = ['uninstall', 'on', 'off', 'status', 'qr', 'rotate'];
export function parseCliArgs(argv) {
    const [command, ...rest] = argv;
    // No subcommand → install. It's the natural first action, and it makes the
    // share path robust: some `npx <github-spec> slopdeck install` forms drop the
    // trailing `install` arg, so a bare invocation must still do the obvious
    // thing rather than print usage. `--gateway-url` may still follow.
    if (command === undefined || command.startsWith('--')) {
        const flagIndex = argv.indexOf('--gateway-url');
        if (flagIndex === -1)
            return { command: 'install', gatewayUrl: undefined };
        const gatewayUrl = argv[flagIndex + 1];
        if (gatewayUrl === undefined || gatewayUrl.startsWith('--'))
            return null;
        return { command: 'install', gatewayUrl };
    }
    // Tokens travel by hidden prompt only — no command takes one via argv,
    // where it would land in shell history.
    if (BARE_COMMANDS.includes(command)) {
        return rest.length === 0 ? { command: command, gatewayUrl: undefined } : null;
    }
    if (command !== 'install')
        return null;
    const flagIndex = rest.indexOf('--gateway-url');
    if (flagIndex === -1)
        return { command, gatewayUrl: undefined };
    const gatewayUrl = rest[flagIndex + 1];
    if (gatewayUrl === undefined || gatewayUrl.startsWith('--'))
        return null;
    return { command, gatewayUrl };
}
/** Friendly menu labels for the known install choices; falls back to the raw
 * value for anything not listed. */
const CHOICE_LABELS = {
    local: 'local — runs on this machine, phone pairs over your Wi-Fi (in-page alerts)',
    hosted: 'hosted — always-on gateway, phone pairs from anywhere (locked-screen push)',
};
function ask(question, hidden) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
        // Echo the prompt once, then swallow every keystroke's echo — the token
        // must never land on screen or in terminal scrollback.
        const raw = rl;
        let prompted = false;
        raw._writeToOutput = (chunk) => {
            if (prompted)
                return;
            prompted = true;
            process.stdout.write(chunk);
        };
    }
    return new Promise((resolve) => {
        rl.question(`${question}: `, (answer) => {
            rl.close();
            if (hidden)
                process.stdout.write('\n');
            resolve(answer.trim());
        });
    });
}
/** A `MenuIo` driving the real terminal, for the interactive select menu. */
function terminalMenuIo() {
    const input = process.stdin;
    const listeners = new Map();
    return {
        isTty: Boolean(input.isTTY) && typeof input.setRawMode === 'function',
        setRawMode: (enabled) => input.setRawMode?.(enabled),
        onKey: (listener) => {
            const wrapped = (data) => listener(data.toString());
            listeners.set(listener, wrapped);
            input.on('data', wrapped);
        },
        offKey: (listener) => {
            const wrapped = listeners.get(listener);
            if (wrapped !== undefined) {
                input.removeListener('data', wrapped);
                listeners.delete(listener);
            }
        },
        resume: () => input.resume(),
        pause: () => input.pause(),
        write: (chunk) => process.stdout.write(chunk),
        ask: (question) => ask(question, false),
        onInterrupt: () => process.exit(130),
    };
}
/** The machine's first non-internal IPv4 — what the phone dials on the LAN.
 * Undefined if the machine has no such address (e.g. offline). */
function firstLanIpv4() {
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal)
                return address.address;
        }
    }
    return undefined;
}
function realFileStore() {
    return {
        async read(path) {
            try {
                return await readFile(path, 'utf8');
            }
            catch {
                return null;
            }
        },
        async write(path, content) {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, 'utf8');
        },
        async remove(path) {
            await rm(path, { force: true });
        },
    };
}
export async function runCli(argv) {
    const args = parseCliArgs(argv);
    if (args === null) {
        console.error(USAGE);
        return 2;
    }
    const home = homedir();
    const deps = {
        paths: {
            configFile: join(home, '.config', 'slopdeck', 'config.json'),
            claudeSettings: join(home, '.claude', 'settings.json'),
            zshrc: join(home, '.zshrc'),
        },
        io: {
            ask: (question) => ask(question, false),
            askHidden: (question) => ask(question, true),
            confirm: async (question, defaultYes) => {
                const answer = await ask(`${question} [${defaultYes ? 'Y/n' : 'y/N'}]`, false);
                if (answer === '')
                    return defaultYes;
                return answer.toLowerCase().startsWith('y');
            },
            choose: (question, choices) => selectMenu(question, choices.map((value) => ({ value, label: CHOICE_LABELS[value] ?? value })), terminalMenuIo()),
            say: (line) => console.log(line),
        },
        files: realFileStore(),
        createClient: createGatewayClient,
        env: process.env,
        lanIp: firstLanIpv4,
        renderQr: (text) => {
            let rendered = '';
            // qrcode-terminal invokes the callback synchronously; small = half-height
            // blocks so the code fits a normal terminal.
            qrcodeTerminal.generate(text, { small: true }, (block) => {
                rendered = block;
            });
            return rendered;
        },
        cwd: process.cwd(),
    };
    switch (args.command) {
        case 'install':
            return (await install(deps, { gatewayUrl: args.gatewayUrl })).ok ? 0 : 1;
        case 'uninstall':
            return (await uninstall(deps)).ok ? 0 : 1;
        case 'on':
        case 'off':
            return (await setInterception(deps, args.command === 'on')).ok ? 0 : 1;
        case 'status':
            return (await status(deps)).ok ? 0 : 1;
        case 'qr':
            return (await qr(deps)).ok ? 0 : 1;
        case 'rotate':
            return (await rotate(deps)).ok ? 0 : 1;
    }
}
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    runCli(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
