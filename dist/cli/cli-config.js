export async function readCliConfig(files, configFile) {
    const content = await files.read(configFile);
    if (content === null) {
        return { ok: false, error: `no config at ${configFile} — run \`slopdeck install\` first` };
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        parsed = null;
    }
    const gatewayUrl = typeof parsed === 'object' && parsed !== null
        ? parsed.gatewayUrl
        : undefined;
    if (typeof gatewayUrl !== 'string' || gatewayUrl === '') {
        return { ok: false, error: `config at ${configFile} is malformed — re-run \`slopdeck install\`` };
    }
    const record = parsed;
    const interceptQuestions = record.interceptQuestions === true;
    const rawDeckKey = record.deckKey;
    const deckKey = typeof rawDeckKey === 'string' && rawDeckKey !== '' ? rawDeckKey : undefined;
    return { ok: true, config: { gatewayUrl, interceptQuestions, deckKey } };
}
