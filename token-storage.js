/** Device-only website tokens. This reduces server-file exposure, not page compromise. */
export function createDeviceTokenStore({ getStorage = () => globalThis.localStorage, scope } = {}) {
    const key = `sam-device-tokens:${scope}`;
    function read() {
        try {
            const storage = getStorage();
            if (!storage) throw new Error();
            const raw = storage.getItem(key);
            const entries = raw == null ? {} : JSON.parse(raw);
            if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error();
            return { storage, entries };
        } catch {
            throw new Error('无法读取当前浏览器保存的令牌。请检查浏览器存储权限；不会改为上传到酒馆。');
        }
    }
    function token(account) {
        const entry = read().entries[account.id];
        return entry?.baseUrl === account.baseUrl && typeof entry.token === 'string' ? entry.token : '';
    }
    function synchronize(accounts) {
        const { storage, entries } = read();
        const next = Object.create(null);
        for (const account of accounts) {
            if (account.balanceTokenStorage !== 'device' || !account.balanceAccessToken) continue;
            next[account.id] = { baseUrl: account.baseUrl, token: account.balanceAccessToken };
        }
        const serialized = JSON.stringify(next);
        if (serialized === JSON.stringify(entries)) return;
        try {
            if (Object.keys(next).length) storage.setItem(key, serialized);
            else storage.removeItem(key);
        } catch {
            throw new Error('当前浏览器无法保存令牌。请检查存储权限或空间后重试；不会改为上传到酒馆。');
        }
    }
    return { token, synchronize };
}

export function settingsForServer(settings) {
    if (settings.accounts.some(account => account.balanceTokenStorage === 'encrypted' && account.balanceAccessToken)) {
        throw new Error('系统令牌尚未完成加密，已阻止保存明文。');
    }
    return {
        ...settings,
        accounts: settings.accounts.map(account => ({
            ...account,
            balanceAccessToken: ['device', 'encrypted'].includes(account.balanceTokenStorage) ? '' : account.balanceAccessToken,
            balanceTokenCipher: account.balanceTokenStorage === 'encrypted' ? account.balanceTokenCipher || null : null,
        })),
    };
}
