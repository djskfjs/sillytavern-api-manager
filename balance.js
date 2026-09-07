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

function accountBalanceUnavailable(message = '站点未向此 API Key 提供可确认的账户总余额。') {
    return fail(message, { accountBalanceUnavailable: true, unsupported: true });
}

function accountBalance(value, currency, message = '') {
    if (number(value) == null || typeof currency !== 'string' || !currency.trim()) return null;
    return { value: number(value), currency: currency.trim(), kind: 'balance', scope: 'account', ...(message ? { message } : {}) };
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
        proxyAuthRequired: error?.proxyAuthRequired === true,
        accountBalanceUnavailable: error?.accountBalanceUnavailable === true,
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
                // Omit browser-managed credentials even for the same-origin
                // proxy, so a WWW-Authenticate challenge cannot open HTTP login.
                method: 'GET', headers, cache: 'no-store', credentials: 'omit',
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
        if (proxy && response.status === 401) {
            throw fail('代理查询未获授权（HTTP 401）。请检查 API 密钥，或请酒馆管理员检查 HTTP 访问认证与代理配置。', {
                status: 401, proxyAuthRequired: true,
            });
        }
        let payload;
        try { payload = JSON.parse(text); } catch {
            if (!response.ok) throw fail(`接口请求失败（HTTP ${response.status}）。`, { status: response.status });
            throw fail('接口返回了网页或无效 JSON，未取得 API 数据。', { protocol: true });
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

function parseLegacy(payload) {
    if (responseScope(payload) !== 'account') return null;
    const data = payload?.data || payload;
    const currency = data?.currency || payload?.currency;
    // A saved field path is not evidence of an account total: it may name key
    // quota, cumulative purchases, or a partial available balance. Prefer a
    // server-declared total; accept a plain account balance only if no total
    // field was returned at all.
    const totals = ['total_balance', 'totalBalance', 'account_balance'].filter(name => Object.prototype.hasOwnProperty.call(data, name));
    const value = totals.length ? totals.map(name => number(data[name])).find(item => item != null) ?? null : number(data?.balance);
    return accountBalance(value, currency);
}

function apiRoots(base) {
    const path = base.pathname.replace(/\/+$/, '').replace(/\/v\d+(?:beta\d*)?$/i, '');
    return [...new Set([`${base.origin}${path}`, base.origin])];
}

function responseScope(payload) {
    const objects = [payload, payload?.data].filter(value => value && typeof value === 'object');
    if (objects.some(value => value.object === 'token_usage' || typeof value.unlimited_quota === 'boolean')) return 'token';
    const scopes = objects.flatMap(value => [value.balance_scope, value.scope])
        .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().toLowerCase());
    if (scopes.some(value => ['token', 'key', 'api_key', 'apikey'].includes(value))) return 'token';
    if (scopes.some(value => value !== 'account')) return 'unknown';
    return scopes.length ? 'account' : '';
}

function quotaMetadata(payload) {
    const data = payload?.data || payload;
    let type = typeof data?.quota_display_type === 'string' ? data.quota_display_type.toUpperCase() : '';
    if (!type && typeof data?.display_in_currency === 'boolean') type = data.display_in_currency ? 'USD' : 'TOKENS';
    if (!['USD', 'CNY', 'TOKENS', 'CUSTOM'].includes(type)) type = '';
    const perUnit = number(data?.quota_per_unit);
    // These are explicit server declarations. Missing values are unknown: the
    // stock public status response usually does not expose this setting.
    const tokenStatFlags = [data?.display_token_stat, data?.display_token_stat_enabled, data?.DisplayTokenStatEnabled];
    const scope = tokenStatFlags.includes(true) ? 'token'
        : tokenStatFlags.includes(false) && perUnit > 0 ? 'account' : '';
    return {
        type, perUnit: perUnit > 0 ? perUnit : null, scope,
        cnyRate: number(data?.usd_exchange_rate),
        customRate: number(data?.custom_currency_exchange_rate),
        symbol: typeof data?.custom_currency_symbol === 'string' ? data.custom_currency_symbol.slice(0, 12) : '',
    };
}

/**
 * New API billing uses account data only when DisplayTokenStatEnabled=false.
 * Its *_usd fields use the site's display unit, so field names prove neither
 * account scope nor currency. Token usage is never an account-balance fallback.
 * https://github.com/QuantumNous/new-api/blob/v0.13.2/controller/billing.go
 */
function billingBalance(subscription, usage, meta) {
    const scopes = [responseScope(subscription), responseScope(usage)];
    if (meta?.scope === 'token' || scopes.some(scope => ['token', 'unknown'].includes(scope))) return null;
    if (meta?.scope !== 'account' && !scopes.every(scope => scope === 'account')) return null;
    const total = number(subscription?.hard_limit_usd ?? subscription?.system_hard_limit_usd);
    const used = number(usage?.total_usage);
    if (total == null || used == null) return null;
    let value = total - used / 100;
    const subscriptionCurrency = typeof subscription?.currency === 'string' ? subscription.currency.trim() : '';
    const usageCurrency = typeof usage?.currency === 'string' ? usage.currency.trim() : '';
    if (subscriptionCurrency && usageCurrency && subscriptionCurrency !== usageCurrency) return null;
    let currency = subscriptionCurrency || usageCurrency || meta?.type;
    if (!currency) return null;
    if (currency === 'TOKENS') currency = '额度单位';
    if (currency === 'CUSTOM') {
        if (!(meta?.customRate > 0 && meta?.symbol)) return null;
        value *= meta.customRate;
        currency = meta.symbol;
    }
    return accountBalance(value, currency);
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
    let unprovenBalance = false;
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
            const result = payload && parseLegacy(payload);
            if (result) return result;
            if (payload) unprovenBalance = true;
        }
    }

    if (provider === 'deepseek') {
        const payload = await attempt(`${base.origin}/user/balance`);
        const info = payload?.balance_infos?.find(item => number(item?.total_balance) != null && typeof item?.currency === 'string' && item.currency.trim());
        if (info) return accountBalance(info.total_balance, info.currency);
    } else if (provider === 'siliconflow') {
        const payload = await attempt(`${base.origin}/v1/user/info`);
        const free = number(payload?.data?.balance);
        const paid = number(payload?.data?.chargeBalance);
        const value = number(payload?.data?.totalBalance) ?? (free != null && paid != null ? free + paid : null);
        if (value != null) return accountBalance(value, base.hostname.endsWith('.cn') ? 'CNY' : 'USD');
    } else if (provider === 'moonshot') {
        const payload = await attempt(`${base.origin}/v1/users/me/balance`);
        const value = number(payload?.data?.available_balance);
        if (value != null) return accountBalance(value, base.hostname.endsWith('.cn') ? 'CNY' : 'USD');
    } else if (provider === 'openrouter') {
        const payload = await attempt(`${base.origin}/api/v1/credits`);
        const total = number(payload?.data?.total_credits);
        const used = number(payload?.data?.total_usage);
        if (total != null && used != null) return accountBalance(total - used, 'USD');
    } else if (provider === 'openai') {
        throw accountBalanceUnavailable('OpenAI 官方没有向普通 API Key 开放账户总余额接口，请在其控制台查看。');
    } else {
        for (const root of apiRoots(base)) {
            const metaPayload = await attempt(`${root}/api/status`, true);
            const meta = metaPayload ? quotaMetadata(metaPayload) : null;
            if (meta?.scope === 'token') { unprovenBalance = true; continue; }
            for (const prefix of ['', '/v1']) {
                const [subscription, usage] = await Promise.all([
                    attempt(`${root}${prefix}/dashboard/billing/subscription`),
                    attempt(`${root}${prefix}/dashboard/billing/usage`),
                ]);
                const result = subscription && usage && billingBalance(subscription, usage, meta);
                if (result) return result;
                if (subscription && usage) unprovenBalance = true;
            }
        }
    }

    const proxyAuth = errors.find(error => error.proxyAuthRequired);
    if (proxyAuth) throw proxyAuth;
    if (unprovenBalance) throw accountBalanceUnavailable();
    const transport = errors.find(error => error.proxyUnavailable) || errors.find(error => error.network);
    const denied = errors.find(error => [401, 403].includes(error.status));
    const service = errors.find(error => error.logical || (error.status && ![404, 405, 410, 501].includes(error.status)));
    if (transport || denied || service) throw transport || denied || service;
    throw accountBalanceUnavailable();
}
