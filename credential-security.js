function localHost(hostname) {
    return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function secureUrl(value, label) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${label}地址无效。`); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost(url.hostname))) {
        throw Object.assign(new Error(`${label}必须使用 HTTPS 才能处理密钥；本机 localhost 地址可以使用 HTTP。`), { credentialBlocked: true });
    }
    if (url.username || url.password) throw new Error('请勿把登录信息写入地址。');
    return url;
}

export function assertCredentialPage(location = globalThis.location) {
    if (location?.href) secureUrl(location.href, '酒馆');
}

export function assertCredentialRequest(value, credential, { location = globalThis.location } = {}) {
    if (!credential) return;
    assertCredentialPage(location);
    const url = secureUrl(value, '站点');
    const secret = String(credential);
    if ([...url.searchParams].some(([name, value]) => /^(?:api[_-]?key|key|token|access[_-]?token|authorization|auth)$/i.test(name)
        || value.includes(secret)) || decodeURIComponent(url.pathname).includes(secret)) {
        throw new Error('请从站点地址中移除密钥，并将其填写在密钥栏。');
    }
}
