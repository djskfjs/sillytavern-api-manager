import { requestApiJson } from './balance.js?v=1.3.0';

const AUTH_STATUSES = new Set([401, 403]);
const ROUTE_STATUSES = new Set([404, 405, 410, 501]);

function failure(message, details = {}) {
    return Object.assign(new Error(message), details);
}

function redact(value, apiKey) {
    let message = typeof value === 'string' ? value : '模型查询失败，请稍后重试。';
    if (apiKey) {
        for (const secret of new Set([apiKey, encodeURIComponent(apiKey)])) {
            message = message.split(secret).join('[密钥已隐藏]');
        }
    }
    return message.replace(/\bBearer\s+[^\s,;"'<>]+/gi, 'Bearer [密钥已隐藏]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[密钥已隐藏]').slice(0, 240);
}

function safeFailure(error, apiKey) {
    return failure(redact(error?.message, apiKey), {
        status: Number(error?.status) || undefined,
        network: error?.network === true || ['TypeError', 'AbortError'].includes(error?.name),
        protocol: error?.protocol === true,
        logical: error?.logical === true,
        nativeUnavailable: error?.nativeUnavailable === true,
        nativeUnknown: error?.nativeUnknown === true,
    });
}

function parseBase(value, apiKey = '') {
    let url;
    try { url = new URL(String(value || '').trim()); } catch {
        throw failure('请填写有效的 API 地址。');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw failure('API 地址必须使用 HTTP(S)，密钥请填写在密钥栏。');
    }
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { path = url.pathname; }
    const secretParameter = [...url.searchParams].some(([name, value]) =>
        /^(?:api[_-]?key|key|token|access[_-]?token|authorization|auth)$/i.test(name)
        || (apiKey && (value === apiKey || value === `Bearer ${apiKey}`)));
    if (secretParameter || (apiKey && path.split('/').includes(apiKey))) {
        throw failure('请从 API 地址中移除密钥，并将其填写在密钥栏。');
    }
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url;
}

function baseString(url) {
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
}

/** Hide only a terminal /v1; path prefixes and other API versions are retained. */
export function displayApiUrl(value) {
    const text = String(value || '').trim();
    try {
        const url = parseBase(text);
        url.pathname = url.pathname.replace(/\/v1$/, '') || '/';
        return baseString(url);
    } catch {
        // Incomplete form input is validated when the user requests models.
        return text;
    }
}

function endpointCandidates(account, apiKey) {
    const supplied = parseBase(account?.baseUrl, apiKey);
    const base = new URL(supplied);
    const explicitV1 = /\/v1$/.test(base.pathname);
    if (explicitV1) base.pathname = base.pathname.slice(0, -3) || '/';

    // OpenRouter's public origin has its API below /api, rather than /v1.
    if (base.hostname === 'openrouter.ai' && base.pathname === '/') base.pathname = '/api';
    const candidates = [];
    const add = url => {
        const value = baseString(url);
        if (!candidates.includes(value)) candidates.push(value);
    };
    if (!explicitV1 && /\/v\d+(?:[._a-z-][\w.-]*)?$/i.test(base.pathname)) {
        add(base);
    } else {
        const versioned = new URL(base);
        versioned.pathname = `${base.pathname === '/' ? '' : base.pathname}/v1`;
        add(versioned);
        add(base);
    }

    if (account?.resolvedBaseUrl) {
        try {
            const cached = parseBase(account.resolvedBaseUrl, apiKey);
            const value = baseString(cached);
            // An edited path must never silently reuse a previous API prefix.
            if (cached.origin === supplied.origin && candidates.includes(value)) {
                candidates.splice(candidates.indexOf(value), 1);
                candidates.unshift(value);
            }
        } catch { /* Ignore an invalid or stale saved endpoint. */ }
    }
    return candidates;
}

function modelsUrl(baseUrl) {
    const url = parseBase(baseUrl);
    url.pathname = `${url.pathname === '/' ? '' : url.pathname}/models`;
    return url.href;
}

function payloadModels(payload, apiKey) {
    if (!payload || typeof payload !== 'object') {
        throw failure('接口未返回有效的模型列表。', { protocol: true });
    }
    const code = payload.code;
    const badCode = code != null && ![true, 0, 200, 20000, '0', '200', '20000', 'ok', 'success'].includes(code);
    if (payload.error || payload.success === false || payload.status === false || badCode
        || ['error', 'failed', 'fail'].includes(payload.status)) {
        const message = [payload.error?.message, payload.message, payload.msg, payload.detail, payload.error]
            .find(value => typeof value === 'string' && value.trim());
        const status = Number(payload.error?.status ?? payload.error?.code ?? payload.statusCode ?? code);
        throw failure(redact(message || '服务端拒绝了模型查询请求。', apiKey), {
            logical: true, status: status >= 400 && status < 600 ? status : undefined,
        });
    }

    let list;
    let namedModels = false;
    if (Array.isArray(payload)) list = payload;
    else if (Array.isArray(payload.data)) list = payload.data;
    else if (Array.isArray(payload.models)) { list = payload.models; namedModels = true; }
    if (!list?.length) throw failure('接口未返回可用模型，请检查地址和密钥的模型权限。', { protocol: true });
    const models = list.map(item => {
        const value = typeof item === 'string' && namedModels ? item
            : item && typeof item === 'object' && !Array.isArray(item)
                ? item.id ?? (namedModels ? item.model ?? item.name : undefined) : undefined;
        if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f<>]/.test(value)) {
            throw failure('接口返回的数据不符合模型列表格式。', { protocol: true });
        }
        return value.trim();
    });
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

/**
 * Probe a finite, same-origin set of API bases. request receives a model URL;
 * nativeRequest, when supplied, receives the corresponding API base instead.
 */
export async function resolveApiEndpoint(account, { request = requestApiJson, nativeRequest } = {}) {
    const apiKey = String(account?.apiKey || '').trim();
    if (!apiKey) throw failure('请先填写有效的 API Key。');
    const candidates = endpointCandidates(account, apiKey);
    const errors = [];
    for (const baseUrl of candidates) {
        let directError;
        try {
            // The generic /proxy route can mix upstream and SillyTavern HTTP
            // authentication. Model queries use only the explicit native fallback.
            const payload = await request(modelsUrl(baseUrl), apiKey, { proxy: false });
            return { baseUrl, models: payloadModels(payload, apiKey) };
        } catch (error) {
            directError = safeFailure(error, apiKey);
            errors.push(directError);
        }

        // An explicit upstream authorization failure is not a version hint.
        if (AUTH_STATUSES.has(directError.status)) throw directError;
        if (typeof nativeRequest === 'function' && directError.network) {
            try {
                const payload = await nativeRequest(baseUrl, apiKey);
                return { baseUrl, models: payloadModels(payload, apiKey) };
            } catch (error) {
                const nativeError = safeFailure(error, apiKey);
                errors.push(nativeError);
                if (AUTH_STATUSES.has(nativeError.status)) throw nativeError;
                if (nativeError.nativeUnavailable || (nativeError.logical && !nativeError.nativeUnknown)
                    || (nativeError.status && !ROUTE_STATUSES.has(nativeError.status))) throw nativeError;
            }
        }
        if (AUTH_STATUSES.has(directError.status) || directError.logical
            || (directError.status && !ROUTE_STATUSES.has(directError.status))) throw directError;
    }
    throw errors.find(error => error.nativeUnknown) || errors.find(error => error.network) || errors.at(-1)
        || failure('未找到可用的 API 模型接口。', { protocol: true });
}

/**
 * SillyTavern 1.14.0 /status merges custom_include_headers after its saved key.
 * JSON is valid YAML, so the per-request Authorization override requires no
 * secret write or connection-setting mutation. Upstream challenges are not
 * forwarded as WWW-Authenticate headers by this endpoint.
 * https://github.com/SillyTavern/SillyTavern/blob/1.14.0/src/endpoints/backends/chat-completions.js
 * https://github.com/SillyTavern/SillyTavern/blob/1.14.0/src/util.js
 */
export async function requestModelsViaSillyTavern(baseUrl, apiKey, options = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw failure('请先填写有效的 API Key。');
    const base = parseBase(baseUrl, key);
    if (typeof options.getRequestHeaders !== 'function') {
        throw failure('当前环境无法提供酒馆请求认证，未启用原生模型查询。', { nativeUnavailable: true });
    }
    const fetchImpl = options.fetch || options.fetchImpl || globalThis.fetch;
    const headers = new Headers(await options.getRequestHeaders());
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
    const timeoutMs = Math.max(100, Math.min(60000, Number(options.timeoutMs) || 10000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
        response = await fetchImpl('/api/backends/chat-completions/status', {
            method: 'POST', headers, credentials: 'same-origin', cache: 'no-store',
            redirect: 'error', signal: controller.signal,
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: baseString(base),
                custom_include_headers: JSON.stringify({ Authorization: `Bearer ${key}` }),
            }),
        });
        text = await response.text();
    } catch {
        throw failure(controller.signal.aborted ? '酒馆模型查询超时，请稍后重试。' : '无法通过酒馆查询模型，请检查酒馆连接。', { network: true });
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        const status = response.status;
        const message = AUTH_STATUSES.has(status)
            ? `酒馆未通过访问认证（HTTP ${status}），请检查酒馆登录状态。`
            : `酒馆模型查询失败（HTTP ${status}）。`;
        throw failure(message, { status, nativeUnavailable: [404, 405].includes(status) });
    }
    let payload;
    try { payload = JSON.parse(text); } catch {
        throw failure('酒馆返回了网页或无效数据，未取得模型列表。', { protocol: true, nativeUnavailable: true });
    }
    if (payload?.error) {
        // The native endpoint discards upstream HTTP status. A second finite
        // candidate may work, but this must never be presented as a known 404.
        throw failure('酒馆未能取得模型列表，可能是地址不匹配、密钥无效或服务商访问限制。', {
            logical: true, nativeUnknown: true,
        });
    }
    try {
        payloadModels(payload, key);
        return payload;
    } catch (error) {
        throw safeFailure(error, key);
    }
}

export { requestModelsViaSillyTavern as requestNativeModels };
