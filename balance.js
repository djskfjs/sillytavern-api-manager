/** Balance protocols; no provider selection or user supplied endpoint is required. */
const PROVIDER_HOSTS = new Map([
    ['api.openai.com', 'openai'],
    ['api.deepseek.com', 'deepseek'],
    ['openrouter.ai', 'openrouter'],
    ['api.siliconflow.cn', 'siliconflow'],
    ['api.siliconflow.com', 'siliconflow'],
    ['api.moonshot.cn', 'moonshot'],
    ['api.moonshot.ai', 'moonshot'],
]);

function fail(message, details = {}) {
    return Object.assign(new Error(message), details);
}

function httpUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw fail('请填写有效的 API 地址。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw fail('API 地址必须使用 HTTP(S)，密钥请填写在密钥栏。');
    }
    url.hash = '';
    return url;
}

export function identifyProvider(baseUrl) {
    try { return PROVIDER_HOSTS.get(httpUrl(baseUrl).hostname.toLowerCase()) || 'custom'; } catch { return 'custom'; }
}

function number(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function redact(value, apiKey) {
    let text = typeof value === 'string' ? value : '查询失败，请稍后重试。';
    if (apiKey) text = text.split(apiKey).join('[密钥已隐藏]');
    return text.replace(/\bBearer\s+[^\s,;"'<>]+/gi, 'Bearer [密钥已隐藏]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[密钥已隐藏]').slice(0, 220);
}

function payloadMessage(payload, fallback, apiKey) {
    const message = [payload?.error?.message, payload?.message, payload?.msg, payload?.detail, payload?.error]
        .find(value => typeof value === 'string' && value.trim());
    return redact(message || fallback, apiKey);
}

function assertPayload(payload, apiKey) {
    if (!payload || typeof payload !== 'object') throw fail('接口没有返回有效的 JSON 数据。', { protocol: true });
    const code = payload.code;
    const badCode = code != null && ![true, 0, 200, 20000, '0', '200', '20000', 'ok', 'success'].includes(code);
    if (payload.success === false || payload.status === false || payload.error || badCode
        || ['error', 'failed', 'fail'].includes(payload.status)) {
        throw fail(payloadMessage(payload, '服务端拒绝了查询请求。', apiKey), { logical: true });
    }
    return payload;
}

function safeError(error, apiKey) {
    return fail(redact(error?.message, apiKey), {
        status: error?.status,
        unsupported: error?.unsupported === true,
        network: error?.network === true,
        proxyUnavailable: error?.proxyUnavailable === true,
        logical: error?.logical === true,
        protocol: error?.protocol === true,
    });
}

/**
 * SillyTavern 1.14: /proxy/:url(*) decodes the path parameter, preserving a
 * fully encoded URL including its query string. The proxy is opt-in on the server.
 * https://github.com/SillyTavern/SillyTavern/blob/1.14.0/src/server-main.js
 */
export async function requestApiJson(url, apiKey = '', options = {}) {
    const target = httpUrl(url);
    const key = String(apiKey || '').trim();
    if (key && (Array.from(target.searchParams.values()).includes(key)
        || target.pathname.split('/').includes(encodeURIComponent(key)))) {
        throw fail('请从 API 地址中移除密钥，并将其填写在密钥栏。');
    }
    const fetchImpl = options.fetch || globalThis.fetch;
    const timeoutMs = Math.max(100, Math.min(60000, Number(options.timeoutMs) || 8000));
    const headers = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;

    async function get(endpoint, proxy = false) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        let text;
        try {
            response = await fetchImpl(endpoint, {
                method: 'GET', headers, cache: 'no-store', credentials: 'same-origin',
                redirect: 'error', signal: controller.signal,
            });
            text = await response.text();
        } catch {
            throw fail(controller.signal.aborted ? '查询超时，请检查网络后重试。' : '网络请求失败，可能受到浏览器跨域限制。', { network: true });
        } finally {
            clearTimeout(timer);
        }
        if (proxy && /CORS proxy is disabled|Enable it in config\.yaml|--corsProxy/i.test(text)) {
            throw fail('浏览器无法跨域查询，酒馆代理尚未开启。请在酒馆服务器 config.yaml 设置 enableCorsProxy: true 并重启酒馆，然后重试。', {
                network: true, proxyUnavailable: true,
            });
        }
        let payload;
        try { payload = JSON.parse(text); } catch {
            if (!response.ok) throw fail(`接口请求失败（HTTP ${response.status}）。`, { status: response.status });
            throw fail('接口返回了网页或无效 JSON，未取得余额数据。', { protocol: true });
        }
        if (!response.ok) {
            const fallback = [401, 403].includes(response.status)
                ? `接口拒绝访问（HTTP ${response.status}），请检查密钥及查询权限。`
                : `接口请求失败（HTTP ${response.status}）。`;
            throw fail(payloadMessage(payload, fallback, key), { status: response.status });
        }
        return assertPayload(payload, key);
    }

    try {
        return await get(target.href);
    } catch (error) {
        if (!error.network || options.proxy === false) throw safeError(error, key);
        try {
            return await get(`/proxy/${encodeURIComponent(target.href)}`, true);
        } catch (proxyError) {
            throw safeError(proxyError, key);
        }
    }
}

function atPath(payload, path) {
    if (!path) return undefined;
    return String(path).replace(/\[(\d+)\]/g, '.$1').replace(/^\$\./, '').split('.')
        .reduce((value, key) => value != null && Object.prototype.hasOwnProperty.call(Object(value), key) ? value[key] : undefined, payload);
}

function parseLegacy(payload, account) {
    const data = payload?.data || payload;
    let value = number(atPath(payload, account.balancePath));
    let currency = String(account.balanceCurrency || data?.currency || payload?.currency || '');
    if (value == null && account.balanceParser === 'openrouter') {
        const total = number(data?.total_credits);
        const used = number(data?.total_usage);
        if (total != null && used != null) value = total - used;
    }
    if (value == null && Array.isArray(payload?.balance_infos)) {
        const info = payload.balance_infos.find(item => number(item?.total_balance) != null);
        value = number(info?.total_balance);
        currency = String(info?.currency || currency);
    }
    if (value == null) {
        value = [data?.totalBalance, data?.balance, data?.available_balance, data?.remaining_balance, data?.total_balance]
            .map(number).find(item => item != null) ?? null;
    }
    return value == null ? null : { value, currency, kind: 'balance' };
}

function apiRoots(base) {
    const path = base.pathname.replace(/\/+$/, '').replace(/\/v\d+(?:beta\d*)?$/i, '');
    return [...new Set([`${base.origin}${path}`, base.origin])];
}

function tokenInfo(payload) {
    const data = payload?.data || payload;
    const available = number(data?.total_available);
    const unlimited = data?.unlimited_quota === true;
    return available != null || unlimited ? { available, unlimited } : null;
}

function quotaMetadata(payload) {
    const data = payload?.data || payload;
    let type = typeof data?.quota_display_type === 'string' ? data.quota_display_type.toUpperCase() : '';
    if (!type && typeof data?.display_in_currency === 'boolean') type = data.display_in_currency ? 'USD' : 'TOKENS';
    if (!['USD', 'CNY', 'TOKENS', 'CUSTOM'].includes(type)) type = '';
    const perUnit = number(data?.quota_per_unit);
    return {
        type, perUnit: perUnit > 0 ? perUnit : null,
        cnyRate: number(data?.usd_exchange_rate),
        customRate: number(data?.custom_currency_exchange_rate),
        symbol: typeof data?.custom_currency_symbol === 'string' ? data.custom_currency_symbol.slice(0, 12) : '',
    };
}

function tokenBalance(token, meta) {
    if (token.unlimited) return { value: '不限额', currency: '', kind: 'token', message: '该密钥未设额度上限；仍受账户余额限制。' };
    if (meta?.perUnit && meta.type === 'USD') return { value: token.available / meta.perUnit, currency: 'USD', kind: 'token' };
    if (meta?.perUnit && meta.type === 'CNY' && meta.cnyRate > 0) {
        return { value: token.available / meta.perUnit * meta.cnyRate, currency: 'CNY', kind: 'token' };
    }
    if (meta?.perUnit && meta.type === 'CUSTOM' && meta.customRate > 0 && meta.symbol) {
        return { value: token.available / meta.perUnit * meta.customRate, currency: meta.symbol, kind: 'token' };
    }
    return {
        value: token.available, currency: '额度单位', kind: 'quota',
        message: meta?.type === 'TOKENS' ? '站点以原始额度单位计量。' : '无法读取站点的金额换算信息，显示原始密钥额度。',
    };
}

/**
 * New API returns raw quota at /api/usage/token/. Its billing *_usd fields use
 * the site's display unit; CNY is already converted and TOKENS is raw quota.
 * Billing scope depends on the server's DisplayTokenStatEnabled setting.
 * https://github.com/QuantumNous/new-api/blob/v0.13.2/controller/token.go
 * https://github.com/QuantumNous/new-api/blob/v0.13.2/controller/billing.go
 */
function billingBalance(subscription, usage, token, meta) {
    const total = number(subscription?.hard_limit_usd ?? subscription?.system_hard_limit_usd);
    const used = number(usage?.total_usage);
    if (total == null || used == null || (token?.unlimited && total === 100000000)) return null;
    if (!token && total === 100000000) {
        // Older One API versions have no token-usage endpoint. The same fixed
        // number can be an unlimited-token sentinel or a finite raw quota, so
        // neither an amount nor an unlimited account balance can be inferred.
        return { value: '无法确认', currency: '', kind: 'available', message: '站点账单可能返回了无限额度标记，未能确认实际金额。' };
    }
    let value = total - used / 100;
    const explicitCurrency = typeof subscription?.currency === 'string' ? subscription.currency : '';
    // A confirmed New API token must not turn raw quota into dollars merely
    // because that server reused OpenAI's historical *_usd field names.
    if (token && !meta?.type && !explicitCurrency) return null;
    const unitKnown = Boolean(explicitCurrency || meta?.type);
    let currency = explicitCurrency || meta?.type || '额度单位';
    if (currency === 'TOKENS') currency = '额度单位';
    if (currency === 'CUSTOM') {
        if (!(meta?.customRate > 0 && meta?.symbol)) return null;
        value *= meta.customRate;
        currency = meta.symbol;
    }
    return { value, currency, kind: 'available', message: unitKnown
        ? '站点账单可用额度，统计范围由服务端设置决定。'
        : '账单未提供可确认的币种，按站点返回的额度单位显示。' };
}

/** Returns a balance only after a protocol-specific response has been verified. */
export async function queryBalance(account, { request = requestApiJson } = {}) {
    const base = httpUrl(account?.baseUrl);
    base.search = '';
    const apiKey = String(account?.apiKey || '').trim();
    if (!apiKey) throw fail('请先填写并保存 API 密钥。');
    const provider = identifyProvider(base.href);
    const errors = [];
    const cache = new Map();
    async function attempt(url, publicRequest = false) {
        const target = httpUrl(url);
        if (target.origin !== base.origin) throw fail('余额查询地址与 API 地址不同，已阻止发送密钥。');
        const cacheKey = `${publicRequest ? 'public' : 'key'}:${target.href}`;
        if (!cache.has(cacheKey)) {
            cache.set(cacheKey, Promise.resolve().then(() => request(target.href, publicRequest ? '' : apiKey))
                .then(payload => assertPayload(payload, apiKey))
                .catch(error => { const safe = safeError(error, apiKey); if (!publicRequest) errors.push(safe); return null; }));
        }
        return await cache.get(cacheKey);
    }

    // Preserve same-origin custom configurations. Known official APIs must use
    // their own parser: old paths/currencies must not override current semantics.
    if (provider === 'custom' && account.balanceUrl) {
        let legacy;
        try { legacy = httpUrl(new URL(account.balanceUrl, `${base.origin}/`).href); } catch { /* invalid legacy URL */ }
        if (legacy?.origin === base.origin) {
            const payload = await attempt(legacy.href);
            const result = payload && parseLegacy(payload, account);
            if (result) return result;
        }
    }

    if (provider === 'deepseek') {
        const payload = await attempt(`${base.origin}/user/balance`);
        const info = payload?.balance_infos?.find(item => number(item?.total_balance) != null && typeof item?.currency === 'string');
        if (info) return { value: number(info.total_balance), currency: info.currency, kind: 'balance' };
    } else if (provider === 'siliconflow') {
        const payload = await attempt(`${base.origin}/v1/user/info`);
        const value = number(payload?.data?.totalBalance) ?? number(payload?.data?.balance);
        if (value != null) return { value, currency: base.hostname.endsWith('.cn') ? 'CNY' : 'USD', kind: 'balance' };
    } else if (provider === 'moonshot') {
        const payload = await attempt(`${base.origin}/v1/users/me/balance`);
        const value = number(payload?.data?.available_balance);
        if (value != null) return { value, currency: base.hostname.endsWith('.cn') ? 'CNY' : 'USD', kind: 'balance' };
    } else if (provider === 'openrouter') {
        const payload = await attempt(`${base.origin}/api/v1/credits`);
        const total = number(payload?.data?.total_credits);
        const used = number(payload?.data?.total_usage);
        if (total != null && used != null) return { value: total - used, currency: 'USD', kind: 'balance' };
        const keyPayload = await attempt(`${base.origin}/api/v1/key`);
        const remaining = number(keyPayload?.data?.limit_remaining);
        if (remaining != null) return { value: remaining, currency: 'USD', kind: 'token' };
        if (keyPayload?.data && keyPayload.data.limit === null) return { value: '不限额', currency: '', kind: 'token', message: '该密钥未设额度上限；仍受账户余额限制。' };
    } else if (provider === 'openai') {
        throw fail('OpenAI 官方没有向普通 API Key 开放账户余额接口，请在其控制台查看。', { unsupported: true });
    } else {
        let fallback = null;
        for (const root of apiRoots(base)) {
            const tokenPayload = await attempt(`${root}/api/usage/token/`);
            const token = tokenPayload && tokenInfo(tokenPayload);
            const metaPayload = await attempt(`${root}/api/status`, true);
            const meta = metaPayload ? quotaMetadata(metaPayload) : null;
            for (const prefix of ['', '/v1']) {
                const [subscription, usage] = await Promise.all([
                    attempt(`${root}${prefix}/dashboard/billing/subscription`),
                    attempt(`${root}${prefix}/dashboard/billing/usage`),
                ]);
                const result = subscription && usage && billingBalance(subscription, usage, token, meta);
                if (result) return result;
            }
            if (token && !fallback) fallback = tokenBalance(token, meta);
        }
        if (fallback) return fallback;
    }

    const transport = errors.find(error => error.proxyUnavailable) || errors.find(error => error.network);
    const denied = errors.find(error => [401, 403].includes(error.status));
    const service = errors.find(error => error.logical || (error.status && ![404, 405, 410, 501].includes(error.status)));
    if (transport || denied || service) throw transport || denied || service;
    throw fail('未找到该站点可用的余额接口，已尝试令牌额度和兼容账单查询。', { unsupported: true });
}
