/** Password encryption for stored website tokens, not protection from a hostile page. */
const ITERATIONS = 600000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const VERIFY_TEXT = 'SillyTavern API Manager token vault v1';

function encode(bytes) {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
}

function decode(text, length) {
    if (typeof text !== 'string' || text.length > 100000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('加密数据格式损坏，原数据已保留。');
    let bytes;
    try { bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0)); } catch { throw new Error('加密数据格式损坏，原数据已保留。'); }
    if (length && bytes.length !== length) throw new Error('加密数据格式损坏，原数据已保留。');
    return bytes;
}

export function createTokenVault(config = null, { crypto = globalThis.crypto } = {}) {
    let metadata = config ? structuredClone(config) : null;
    let key = null;
    let revision = 0;
    function available() {
        if (!crypto?.subtle || !crypto?.getRandomValues) throw new Error('当前浏览器不支持安全加密，请使用 HTTPS 或本机 localhost 酒馆。');
    }
    function checkConfig() {
        available();
        if (metadata?.version !== 1 || metadata?.iterations !== ITERATIONS
            || typeof metadata?.id !== 'string' || !/^[A-Za-z0-9+/=]{24}$/.test(metadata.id)) {
            throw new Error('令牌加密配置无法识别，原数据已保留。');
        }
        decode(metadata.salt, 16);
    }
    async function derive(password) {
        const bytes = encoder.encode(String(password));
        try {
            const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
            return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256',
                salt: decode(metadata.salt, 16), iterations: ITERATIONS }, material,
            { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        } finally { bytes.fill(0); }
    }
    async function encrypt(value, aad, currentKey) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const bytes = encoder.encode(value);
        if (bytes.length > 65536) throw new Error('系统令牌内容过长。');
        try {
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
                additionalData: encoder.encode(aad), tagLength: 128 }, currentKey, bytes);
            return { version: 1, iv: encode(iv), data: encode(new Uint8Array(encrypted)) };
        } finally { bytes.fill(0); }
    }
    async function decrypt(cipher, aad, currentKey) {
        if (cipher?.version !== 1) throw new Error('加密数据格式损坏，原数据已保留。');
        const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(cipher.iv, 12),
            additionalData: encoder.encode(aad), tagLength: 128 }, currentKey, decode(cipher.data)));
        try { return decoder.decode(bytes); } finally { bytes.fill(0); }
    }
    const binding = account => `sam-token:${metadata.id}:${JSON.stringify([String(account.id), String(account.baseUrl)])}`;
    return {
        get config() { return metadata ? structuredClone(metadata) : null; },
        get unlocked() { return Boolean(key); },
        lock() { key = null; revision++; },
        async initialize(password) {
            available();
            if (metadata) throw new Error('已有加密密码，请先解锁。');
            if (typeof password !== 'string' || password.length < 12) throw new Error('解锁密码至少需要 12 个字符。');
            const started = revision;
            metadata = { version: 1, iterations: ITERATIONS,
                id: encode(crypto.getRandomValues(new Uint8Array(16))),
                salt: encode(crypto.getRandomValues(new Uint8Array(16))) };
            try {
                const nextKey = await derive(password);
                metadata.verifier = await encrypt(VERIFY_TEXT, `sam-vault:${metadata.id}`, nextKey);
                if (started !== revision) throw new Error('加密操作已取消。');
                key = nextKey;
                return this.config;
            } catch (error) { metadata = null; key = null; throw error; }
        },
        async unlock(password) {
            checkConfig();
            const started = revision;
            const nextKey = await derive(password);
            try {
                const value = await decrypt(metadata.verifier, `sam-vault:${metadata.id}`, nextKey);
                if (value !== VERIFY_TEXT) throw new Error();
            } catch { throw new Error('解锁密码不正确或加密数据损坏，原数据已保留。'); }
            if (started !== revision) throw new Error('解锁操作已取消。');
            key = nextKey;
        },
        async seal(account, token) {
            checkConfig();
            if (!key) throw new Error('请先解锁系统令牌。');
            if (typeof token !== 'string' || !token.trim() || token.length > 65536) throw new Error('系统令牌内容无效。');
            const started = revision;
            const cipher = await encrypt(token, binding(account), key);
            if (started !== revision) throw new Error('令牌已锁定，请重新解锁。');
            return cipher;
        },
        async open(account) {
            checkConfig();
            if (!key) throw new Error('请先解锁系统令牌。');
            const started = revision;
            let token;
            try { token = await decrypt(account.balanceTokenCipher, binding(account), key); }
            catch { throw new Error('系统令牌无法解密，账户地址或密文可能已改变；原数据已保留。'); }
            if (started !== revision) throw new Error('令牌已锁定，请重新解锁。');
            return token;
        },
    };
}
