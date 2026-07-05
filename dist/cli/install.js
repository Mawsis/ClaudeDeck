import { generateHookSettings } from "../config-generator/generate.js";
import { pairingUrl, phoneReachableBase } from "./pairing.js";
import { addHookSettings, addZshrcBlock, removeHookSettings, removeZshrcBlock, } from "./settings-surgeon.js";
/** The default hosted gateway — the author's always-on backend. */
export const HOSTED_GATEWAY_URL = 'https://slopdeck.mawsis.dev';
const LOCAL = 'local';
const HOSTED = 'hosted';
/** The honest privacy line and the loud anonymous-key warning, printed on every
 * install so the tradeoffs are never hidden behind a happy path. */
const PRIVACY_LINE = 'privacy: the deck sees your project folder names and shell command payloads and the questions Claude asks — not your credentials or file contents.';
const KEY_WARNING = 'IMPORTANT: this workspace key is the only way to reach your deck. Save it (or sign up later to recover it) — if you lose it, you cannot get back in and anyone who has it can see your sessions.';
export async function install(deps, options) {
    const { io, files, paths, createClient } = deps;
    const mode = await io.choose('run slopdeck locally or use the hosted gateway?', [LOCAL, HOSTED]);
    // Resolve the gateway URL and mint a fresh workspace — never a hand-typed or
    // hand-generated token. Local mints against the machine's own ungated
    // endpoint; hosted mints against the public one.
    const gatewayUrl = options.gatewayUrl ?? (mode === HOSTED ? HOSTED_GATEWAY_URL : await io.ask('local gateway URL'));
    const client = createClient(gatewayUrl);
    const minted = mode === HOSTED ? await client.mintHosted() : await client.mintLocal();
    if (!minted.ok) {
        io.say(minted.error === 'unreachable'
            ? `gateway unreachable at ${gatewayUrl}: ${minted.detail}`
            : `could not mint a workspace at ${gatewayUrl}: gateway error (${minted.error === 'http' ? `http ${minted.status}` : minted.error})`);
        return { ok: false };
    }
    const { hookKey, deckKey } = minted.value;
    // The phone reaches a local gateway over the machine's LAN IP on the same
    // Wi-Fi; the hosted one over its real domain. Resolve the reachable base
    // BEFORE writing anything, so a local machine with no LAN IP aborts clean.
    const pairingBase = phoneReachableBase(deps, gatewayUrl);
    if (pairingBase === null) {
        io.say('could not detect a LAN IP — the phone must reach this machine directly; nothing was written');
        return { ok: false };
    }
    if (mode === LOCAL) {
        io.say('note: on the LAN you get in-page alerts only; locked-screen notifications need the hosted option.');
    }
    const interceptQuestions = await io.confirm('enable question interception (answer AskUserQuestion from the deck — undocumented hack)?', false);
    // Compute every file edit before writing any of them: a malformed settings
    // file must abort with the disk untouched — the config file included.
    const settingsBefore = (await files.read(paths.claudeSettings)) ?? '';
    const surgery = addHookSettings(settingsBefore, generateHookSettings({ gatewayUrl, interceptQuestions }));
    if (!surgery.ok) {
        io.say(`refusing to touch ${paths.claudeSettings}: ${surgery.error}`);
        return { ok: false };
    }
    const zshrcBefore = (await files.read(paths.zshrc)) ?? '';
    await files.write(paths.configFile, 
    // The deck key is stored here — it is the phone-pairing credential and the
    // proof `rotate` presents. The hook key is deliberately absent: it lives
    // only in the marked .zshrc block, where Claude Code's env interpolation
    // picks it up.
    JSON.stringify({ gatewayUrl, interceptQuestions, deckKey }, null, 2) + '\n');
    await files.write(paths.claudeSettings, surgery.content);
    await files.write(paths.zshrc, addZshrcBlock(zshrcBefore, hookKey));
    io.say('slopdeck installed — open a new shell so the hook key is exported');
    // The pairing finale: QR for the phone, the honest privacy line, the loud
    // key warning, then a handshake through the real hook-auth path — one moment
    // that proves DNS/LAN, the hook key, gateway, SSE, and deck end to end.
    io.say(deps.renderQr(pairingUrl(pairingBase, deckKey)));
    io.say('scan with the phone camera to pair the deck');
    io.say(PRIVACY_LINE);
    io.say(KEY_WARNING);
    const handshake = await client.handshake(hookKey, {
        sessionId: 'slopdeck-install',
        cwd: deps.cwd,
    });
    if (!handshake.ok) {
        io.say('handshake failed — the setup files are in place, but the pipeline proof did not go through. ' +
            'Check that the gateway is still running.');
        return { ok: false };
    }
    io.say('handshake sent — look at your phone: the mascot waves when the whole chain works');
    return { ok: true };
}
export async function uninstall(deps) {
    const { io, files, paths } = deps;
    // Same validate-then-write discipline in reverse. Removal keys on
    // slopdeck's own fingerprints, so no config file is needed to undo.
    const settingsBefore = await files.read(paths.claudeSettings);
    const surgery = settingsBefore === null ? null : removeHookSettings(settingsBefore);
    if (surgery !== null && !surgery.ok) {
        io.say(`refusing to touch ${paths.claudeSettings}: ${surgery.error}`);
        return { ok: false };
    }
    const zshrcBefore = await files.read(paths.zshrc);
    if (surgery !== null)
        await files.write(paths.claudeSettings, surgery.content);
    if (zshrcBefore !== null)
        await files.write(paths.zshrc, removeZshrcBlock(zshrcBefore));
    await files.remove(paths.configFile);
    io.say('slopdeck uninstalled — already-running Claude sessions keep their hooks until restarted');
    return { ok: true };
}
