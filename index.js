/**
 * SillyTavern API Account Manager
 *
 * A dependency-free account/profile manager for OpenAI-compatible APIs.
 * The extension is intentionally written as a regular ES module so it can be
 * installed directly from a GitHub repository in SillyTavern 1.14.x.
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const EXTENSION_NAME = 'sillytavern-api-manager';
const EXTENSION_VERSION = '1.1.1';
const SETTINGS_ROOT_ID = 'st-api-account-manager';
const SETTINGS_VERSION = 1;

const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    accounts: [],
    selectedAccountId: '',
    autoRefresh: true,
    refreshInterval: 30,
});

/**
 * The presets deliberately use OpenAI-compatible model endpoints whenever
 * possible. Users can change the API base URL; balance endpoints and parsing
 * are provided by the preset without extra form fields.
 */
const PRESETS = Object.freeze({
    openai: {
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        modelPath: '/models',
        balancePath: '',
        balanceParser: 'generic',
        currency: 'USD',
    },
    deepseek: {
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        modelPath: '/models',
        balanceUrl: 'https://api.deepseek.com/user/balance',
        balancePath: 'balance_infos.0.total_balance',
        balanceParser: 'deepseek',
        currency: 'CNY',
    },
    openrouter: {
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelPath: '/models',
        balanceUrl: 'https://openrouter.ai/api/v1/credits',
        balancePath: '',
        balanceParser: 'openrouter',
        currency: 'USD',
    },
    siliconflow: {
        label: '硅基流动 SiliconFlow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelPath: '/models',
        balanceUrl: 'https://api.siliconflow.cn/user/info',
        balancePath: 'data.balance',
        balanceParser: 'siliconflow',
        currency: 'CNY',
    },
    moonshot: {
        label: '月之暗面 Kimi',
        baseUrl: 'https://api.moonshot.cn/v1',
        modelPath: '/models',
        balancePath: '',
        balanceParser: 'generic',
        currency: 'CNY',
    },
    zhipu: {
        label: '智谱 GLM',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        modelPath: '/models',
        balancePath: '',
        balanceParser: 'generic',
        currency: 'CNY',
    },
    groq: {
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        modelPath: '/models',
        balancePath: '',
        balanceParser: 'generic',
        currency: 'USD',
    },
    together: {
        label: 'Together AI',
        baseUrl: 'https://api.together.xyz/v1',
        modelPath: '/models',
        balancePath: '',
        balanceParser: 'generic',
        currency: 'USD',
    },
    custom: {
        label: '自定义（OpenAI 兼容）',
        baseUrl: '',
        modelPath: '/models',
        balancePath: '',
        balanceParser: 'generic',
        currency: 'USD',
    },
});

let settings;
let refreshTimer = null;
let formModels = [];
let isLoadingModels = false;
let isLoadingBalance = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function makeId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `account-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function asString(value, fallback = '') {
    return typeof value === 'string' ? value : (value == null ? fallback : String(value));
}

function clampInteger(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function normalizeUrl(value) {
    return asString(value).trim().replace(/\/+$/, '');
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function joinUrl(base, path) {
    const cleanBase = normalizeUrl(base);
    const cleanPath = asString(path).trim();
    if (!cleanPath) return cleanBase;
    if (/^https?:\/\//i.test(cleanPath)) return cleanPath;
    if (!cleanBase) return cleanPath;
    return `${cleanBase}/${cleanPath.replace(/^\/+/, '')}`;
}

function normalizeBalance(balance) {
    if (!balance || typeof balance !== 'object') {
        return { status: 'unknown', value: null, currency: '', message: '', fetchedAt: 0 };
    }
    return {
        status: ['ok', 'loading', 'error', 'unsupported', 'unknown'].includes(balance.status) ? balance.status : 'unknown',
        value: balance.value == null ? null : balance.value,
        currency: asString(balance.currency),
        message: asString(balance.message),
        fetchedAt: Number.isFinite(Number(balance.fetchedAt)) ? Number(balance.fetchedAt) : 0,
    };
}

function normalizeAccount(account) {
    const source = account && typeof account === 'object' ? account : {};
    const models = Array.isArray(source.models)
        ? source.models.map(item => asString(item).trim()).filter(Boolean)
        : [];
    const uniqueModels = [...new Set(models)];
    const selectedModel = asString(source.selectedModel ?? source.model).trim();
    if (selectedModel && !uniqueModels.includes(selectedModel)) uniqueModels.unshift(selectedModel);
    return {
        id: asString(source.id) || makeId(),
        name: asString(source.name).trim() || '未命名账户',
        group: asString(source.group).trim(),
        provider: asString(source.provider),
        baseUrl: normalizeUrl(source.baseUrl),
        apiKey: asString(source.apiKey),
        models: uniqueModels,
        selectedModel,
        balanceUrl: asString(source.balanceUrl).trim(),
        balancePath: asString(source.balancePath).trim(),
        balanceCurrency: asString(source.balanceCurrency).trim(),
        balanceParser: asString(source.balanceParser || 'generic'),
        balance: normalizeBalance(source.balance),
        createdAt: Number(source.createdAt) || Date.now(),
        updatedAt: Number(source.updatedAt) || Date.now(),
    };
}

function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const accounts = Array.isArray(source.accounts) ? source.accounts.map(normalizeAccount) : [];
    const selected = asString(source.selectedAccountId);
    return {
        ...DEFAULT_SETTINGS,
        ...source,
        version: SETTINGS_VERSION,
        accounts,
        selectedAccountId: accounts.some(account => account.id === selected) ? selected : '',
        autoRefresh: source.autoRefresh !== false,
        refreshInterval: clampInteger(source.refreshInterval, 1, 1440, DEFAULT_SETTINGS.refreshInterval),
    };
}

function persist() {
    extension_settings[EXTENSION_NAME] = settings;
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
}

function rootElement() {
    return document.getElementById(SETTINGS_ROOT_ID);
}

function setStatus(message, kind = '') {
    const element = $('#sam-status');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('sam-status-error', kind === 'error');
    element.classList.toggle('sam-status-success', kind === 'success');
}

function notify(message, kind = 'info') {
    const toaster = globalThis.toastr;
    if (toaster && typeof toaster[kind] === 'function') {
        toaster[kind](message, 'API 账户管理');
    }
    setStatus(message, kind === 'error' ? 'error' : kind === 'success' ? 'success' : '');
}

function getPreset(key) {
    return PRESETS[key] || PRESETS.custom;
}

function populatePresets() {
    const select = $('#sam-preset');
    if (!select) return;
    // Keep the first custom option supplied by settings.html and add the rest once.
    const existing = new Set($$('option', select).map(option => option.value));
    for (const [key, preset] of Object.entries(PRESETS)) {
        if (key === 'custom' || existing.has(key)) continue;
        const option = document.createElement('option');
        option.value = key;
        option.textContent = preset.label;
        select.append(option);
    }
}

function applyPreset(key) {
    const preset = getPreset(key);
    const base = $('#sam-base-url');
    if (base && preset.baseUrl) base.value = preset.baseUrl;
    if ($('#sam-name') && !$('#sam-name').value.trim() && preset.label) $('#sam-name').value = preset.label;
    setStatus(preset.baseUrl ? `已填入 ${preset.label} 预设` : '请填写自定义 API 地址');
}

function readForm() {
    const accountId = asString($('#sam-account-id')?.value).trim();
    const existing = settings.accounts.find(account => account.id === accountId);
    const enteredKey = asString($('#sam-api-key')?.value);
    const apiKey = enteredKey || existing?.apiKey || '';
    const presetKey = asString($('#sam-preset')?.value) || 'custom';
    const preset = getPreset(presetKey);
    const baseUrl = normalizeUrl($('#sam-base-url')?.value);
    // Keep saved balance support when only the account name or group changes.
    const sameService = existing && (existing.provider || 'custom') === presetKey
        && normalizeUrl(existing.baseUrl) === baseUrl;
    const selectedModel = asString($('#sam-model-select')?.value).trim();
    const models = [...new Set([
        ...formModels,
        ...(existing?.models || []),
        selectedModel,
    ].map(item => asString(item).trim()).filter(Boolean))];
    return {
        id: accountId || makeId(),
        name: asString($('#sam-name')?.value).trim(),
        group: asString($('#sam-group')?.value).trim(),
        provider: presetKey,
        baseUrl,
        apiKey,
        models,
        selectedModel,
        balanceUrl: sameService ? existing.balanceUrl : asString(preset.balanceUrl),
        balancePath: sameService ? existing.balancePath : asString(preset.balancePath),
        balanceCurrency: sameService ? existing.balanceCurrency : asString(preset.currency),
        balanceParser: sameService ? existing.balanceParser : preset.balanceParser || 'generic',
        balance: sameService && apiKey === existing.apiKey ? existing.balance : normalizeBalance(null),
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
    };
}

function clearForm() {
    const form = $('#sam-account-form');
    if (form) form.reset();
    const accountId = $('#sam-account-id');
    if (accountId) accountId.value = '';
    const modelSelect = $('#sam-model-select');
    if (modelSelect) {
        modelSelect.replaceChildren();
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '请先获取模型';
        modelSelect.append(option);
    }
    const modelList = $('#sam-models');
    if (modelList) {
        modelList.replaceChildren();
        const muted = document.createElement('span');
        muted.className = 'sam-muted';
        muted.textContent = '尚未获取模型列表。';
        modelList.append(muted);
    }
    formModels = [];
    if ($('#sam-cancel-edit')) $('#sam-cancel-edit').hidden = true;
    if ($('#sam-save-account')) $('#sam-save-account').textContent = '保存 API';
    if ($('#sam-form-title')) $('#sam-form-title').textContent = '添加 API';
    if ($('#sam-api-key')) {
        $('#sam-api-key').required = true;
        $('#sam-api-key').placeholder = 'sk-…';
    }
    updateFormBalance();
    setStatus('就绪');
}

function fillForm(account) {
    if (!account) return;
    const values = {
        '#sam-account-id': account.id,
        '#sam-name': account.name,
        '#sam-group': account.group,
        '#sam-base-url': account.baseUrl,
        '#sam-api-key': '',
    };
    for (const [selector, value] of Object.entries(values)) {
        const input = $(selector);
        if (input) input.value = value;
    }
    const preset = $('#sam-preset');
    if (preset) preset.value = account.provider !== 'custom' && PRESETS[account.provider] ? account.provider : '';
    formModels = [...account.models];
    populateModelSelect(formModels, account.selectedModel);
    renderModelChips(formModels);
    if ($('#sam-cancel-edit')) $('#sam-cancel-edit').hidden = false;
    if ($('#sam-save-account')) $('#sam-save-account').textContent = '更新 API';
    if ($('#sam-form-title')) $('#sam-form-title').textContent = '编辑 API';
    if ($('#sam-api-key')) {
        $('#sam-api-key').required = false;
        $('#sam-api-key').placeholder = account.apiKey ? '留空以保留当前 Key' : 'sk-…';
    }
    updateFormBalance();
    setStatus(`正在编辑：${account.name}`);
}

function populateModelSelect(models, selected = '') {
    const select = $('#sam-model-select');
    if (!select) return;
    select.replaceChildren();
    if (!models.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '请先获取模型';
        select.append(option);
        return;
    }
    for (const model of models) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        option.selected = model === selected;
        select.append(option);
    }
    if (selected && !models.includes(selected)) select.value = models[0];
}

function renderModelChips(models) {
    const list = $('#sam-models');
    if (!list) return;
    list.replaceChildren();
    if (!models.length) {
        const muted = document.createElement('span');
        muted.className = 'sam-muted';
        muted.textContent = '尚未获取模型列表。';
        list.append(muted);
        return;
    }
    for (const model of models) {
        const chip = document.createElement('span');
        chip.className = 'sam-model-chip';
        chip.textContent = model;
        list.append(chip);
    }
}

function extractErrorMessage(payload, fallback) {
    if (!payload) return fallback;
    if (typeof payload === 'string') return payload.slice(0, 240) || fallback;
    if (typeof payload === 'object') {
        const candidates = [payload.error?.message, payload.message, payload.error, payload.detail];
        const message = candidates.find(value => typeof value === 'string' && value.trim());
        if (message) return message.slice(0, 240);
    }
    return fallback;
}

async function requestJson(url, apiKey) {
    if (!isHttpUrl(url)) throw new Error('URL 必须以 http:// 或 https:// 开头');
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let response;
    try {
        response = await fetch(url, { method: 'GET', headers, cache: 'no-store' });
    } catch (error) {
        throw new Error(`网络请求失败（可能被 CORS 拦截）：${error?.message || '无法连接'}`);
    }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText || ''} ${extractErrorMessage(payload, '')}`.trim().slice(0, 300));
    }
    return payload;
}

function extractModels(payload) {
    const candidates = [];
    if (Array.isArray(payload)) candidates.push(payload);
    if (payload && typeof payload === 'object') {
        for (const key of ['data', 'models', 'result', 'items']) {
            if (Array.isArray(payload[key])) candidates.push(payload[key]);
        }
    }
    if (!candidates.length && payload && typeof payload === 'object') {
        // A few providers return { model_name: metadata } rather than an array.
        const mapKeys = Object.keys(payload).filter(key => !['object', 'success', 'code', 'message'].includes(key));
        if (mapKeys.length && mapKeys.every(key => typeof payload[key] === 'object' || typeof payload[key] === 'string')) {
            candidates.push(mapKeys.map(key => ({ id: key })));
        }
    }
    const result = [];
    for (const list of candidates) {
        for (const item of list) {
            const value = typeof item === 'string' ? item : item?.id ?? item?.name ?? item?.model ?? item?.model_name;
            if (typeof value === 'string' && value.trim()) result.push(value.trim());
        }
    }
    return [...new Set(result)].sort((a, b) => a.localeCompare(b));
}

function getPath(payload, path) {
    if (!path) return undefined;
    const parts = path.replace(/^\.+|\.+$/g, '').split('.').filter(Boolean);
    let current = payload;
    for (const part of parts) {
        if (current == null) return undefined;
        if (/^\d+$/.test(part) && Array.isArray(current)) current = current[Number(part)];
        else if (typeof current === 'object') current = current[part];
        else return undefined;
    }
    return current;
}

function numericValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const cleaned = value.replace(/[$,\s]/g, '');
        if (cleaned && Number.isFinite(Number(cleaned))) return Number(cleaned);
    }
    return null;
}

function findNumericByKeys(payload, keys, depth = 0) {
    if (depth > 5 || payload == null || typeof payload !== 'object') return null;
    if (Array.isArray(payload)) {
        for (const item of payload) {
            const found = findNumericByKeys(item, keys, depth + 1);
            if (found != null) return found;
        }
        return null;
    }
    for (const [key, value] of Object.entries(payload)) {
        if (keys.includes(key.toLowerCase())) {
            const number = numericValue(value);
            if (number != null) return number;
        }
    }
    for (const value of Object.values(payload)) {
        const found = findNumericByKeys(value, keys, depth + 1);
        if (found != null) return found;
    }
    return null;
}

function parseBalance(payload, account) {
    const explicit = getPath(payload, account.balancePath);
    let value = numericValue(explicit);
    const parser = account.balanceParser || 'generic';
    if (parser === 'openrouter' && payload?.data) {
        const total = numericValue(payload.data.total_credits);
        const used = numericValue(payload.data.total_usage);
        if (total != null) value = used == null ? total : total - used;
    }
    if (parser === 'deepseek' && value == null) {
        value = findNumericByKeys(payload, ['total_balance', 'balance', 'remaining_balance']);
    }
    if (parser === 'siliconflow' && value == null) {
        value = findNumericByKeys(payload, ['balance', 'available_balance', 'remaining']);
    }
    if (value == null) {
        value = findNumericByKeys(payload, ['balance', 'remaining', 'credits', 'available', 'amount', 'total_balance']);
    }
    if (value == null) return null;
    const currency = account.balanceCurrency
        || asString(getPath(payload, 'currency'))
        || asString(getPath(payload, 'data.currency'));
    return { value, currency };
}

function balanceUrlFor(account) {
    if (account.balanceUrl) return account.balanceUrl;
    const preset = getPreset(account.provider);
    if (preset.balanceUrl) return preset.balanceUrl;
    return '';
}

async function fetchModelsForDraft() {
    if (isLoadingModels) return;
    const baseUrl = normalizeUrl($('#sam-base-url')?.value);
    const apiKey = asString($('#sam-api-key')?.value) || settings.accounts.find(account => account.id === $('#sam-account-id')?.value)?.apiKey || '';
    const preset = getPreset(asString($('#sam-preset')?.value));
    if (!baseUrl || !isHttpUrl(baseUrl)) {
        notify('请先填写有效的 API 基础地址。', 'error');
        return;
    }
    const url = joinUrl(baseUrl, preset.modelPath || '/models');
    isLoadingModels = true;
    const button = $('#sam-fetch-models');
    if (button) { button.disabled = true; button.textContent = '获取中…'; }
    setStatus('正在获取模型…');
    try {
        const payload = await requestJson(url, apiKey);
        const models = extractModels(payload);
        if (!models.length) throw new Error('接口返回中没有找到模型列表');
        formModels = models;
        populateModelSelect(models, $('#sam-model-select')?.value || models[0]);
        renderModelChips(models);
        notify(`已获取 ${models.length} 个模型。`, 'success');
    } catch (error) {
        notify(error?.message || '获取模型失败。', 'error');
    } finally {
        isLoadingModels = false;
        if (button) { button.disabled = false; button.textContent = '获取模型'; }
    }
}

async function refreshBalance(account, options = {}) {
    const url = balanceUrlFor(account);
    if (!url) {
        account.balance = { status: 'unsupported', value: null, currency: account.balanceCurrency, message: '暂不支持余额查询', fetchedAt: Date.now() };
        account.updatedAt = Date.now();
        persist();
        renderAccounts();
        return account.balance;
    }
    account.balance = { ...normalizeBalance(account.balance), status: 'loading', message: '', currency: account.balanceCurrency };
    renderAccounts();
    try {
        const payload = await requestJson(url, account.apiKey);
        const parsed = parseBalance(payload, account);
        if (!parsed) throw new Error('当前服务商的余额返回格式暂不支持');
        account.balance = { status: 'ok', value: parsed.value, currency: parsed.currency || account.balanceCurrency, message: '', fetchedAt: Date.now() };
        account.updatedAt = Date.now();
        persist();
        if (!options.silent) notify(`${account.name} 余额已更新。`, 'success');
    } catch (error) {
        account.balance = { status: 'error', value: null, currency: account.balanceCurrency, message: error?.message || '查询失败', fetchedAt: Date.now() };
        persist();
        if (!options.silent) notify(`${account.name}：${account.balance.message}`, 'error');
    }
    renderAccounts();
    return account.balance;
}

async function refreshAllBalances(options = {}) {
    if (isLoadingBalance || !settings.accounts.length) return;
    isLoadingBalance = true;
    if (!options.silent) setStatus('正在刷新余额…');
    try {
        // Sequential requests avoid flooding providers and keep rate limits friendly.
        for (const account of settings.accounts) await refreshBalance(account, { silent: true });
        if (!options.silent) notify('余额刷新完成。', 'success');
    } finally {
        isLoadingBalance = false;
        renderAccounts();
    }
}

function formatBalance(balance) {
    if (!balance) return '余额：未查询';
    if (balance.status === 'loading') return '余额：查询中…';
    if (balance.status === 'unsupported') return '余额：暂不支持查询';
    if (balance.status === 'error') return `余额：查询失败（${balance.message || '未知错误'}）`;
    if (balance.status !== 'ok' || balance.value == null) return '余额：未查询';
    const value = typeof balance.value === 'number' ? balance.value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : String(balance.value);
    return `余额：${value}${balance.currency ? ` ${balance.currency}` : ''}`;
}

function formatTime(timestamp) {
    if (!timestamp) return '';
    try { return new Date(timestamp).toLocaleString(); } catch { return ''; }
}

function updateFormBalance() {
    const account = settings.accounts.find(item => item.id === $('#sam-account-id')?.value);
    const output = $('#sam-form-balance');
    if (output) {
        output.textContent = account ? formatBalance(account.balance) : '余额：保存后可查询';
        output.dataset.state = account?.balance?.status || 'unknown';
    }
    const button = $('#sam-fetch-balance');
    if (button) {
        button.disabled = !account || account.balance?.status === 'loading';
        button.textContent = account?.balance?.status === 'loading' ? '查询中…' : '查询余额';
    }
}

function createAccountCard(account) {
    const item = document.createElement('article');
    item.className = 'sam-account-item';
    item.setAttribute('role', 'listitem');
    item.dataset.accountId = account.id;
    if (account.id === settings.selectedAccountId) item.classList.add('sam-selected');

    const main = document.createElement('div');
    main.className = 'sam-account-main';
    const titleWrap = document.createElement('div');
    titleWrap.style.minWidth = '0';
    const title = document.createElement('div');
    title.className = 'sam-account-name';
    title.textContent = account.name;
    titleWrap.append(title);
    if (account.group) {
        const group = document.createElement('div');
        group.className = 'sam-account-group';
        group.textContent = account.group;
        titleWrap.append(group);
    }
    main.append(titleWrap);
    const provider = document.createElement('span');
    provider.className = 'sam-account-time';
    provider.textContent = PRESETS[account.provider]?.label || '自定义';
    main.append(provider);
    item.append(main);

    const url = document.createElement('div');
    url.className = 'sam-account-url';
    url.title = account.baseUrl;
    url.textContent = account.baseUrl || '未填写 API 地址';
    item.append(url);
    const model = document.createElement('div');
    model.className = 'sam-account-model';
    model.textContent = account.selectedModel ? `模型：${account.selectedModel}` : `模型：${account.models.length ? `${account.models.length} 个可用` : '未选择'}`;
    item.append(model);
    const balanceRow = document.createElement('div');
    balanceRow.className = 'sam-balance-row';
    const balance = document.createElement('output');
    balance.className = 'sam-account-balance';
    balance.dataset.state = account.balance?.status || 'unknown';
    balance.textContent = formatBalance(account.balance);
    const balanceButton = document.createElement('button');
    balanceButton.type = 'button';
    balanceButton.className = 'menu_button sam-button sam-button-small';
    balanceButton.dataset.action = 'balance';
    balanceButton.dataset.accountId = account.id;
    balanceButton.textContent = account.balance?.status === 'loading' ? '查询中…' : '刷新余额';
    balanceButton.disabled = account.balance?.status === 'loading';
    balanceButton.setAttribute('aria-label', `查询 ${account.name} 的余额`);
    balanceRow.append(balance, balanceButton);
    item.append(balanceRow);
    if (account.balance?.fetchedAt) {
        const time = document.createElement('div');
        time.className = 'sam-account-time';
        time.textContent = `更新于 ${formatTime(account.balance.fetchedAt)}`;
        item.append(time);
    }

    const actions = document.createElement('div');
    actions.className = 'sam-account-actions';
    const actionDefinitions = [
        ['edit', '编辑', '编辑账户'],
        ['models', '模型', '刷新模型列表'],
        ['apply', '应用', '应用到酒馆当前连接'],
        ['delete', '删除', '删除账户'],
    ];
    for (const [action, label, titleText] of actionDefinitions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `menu_button sam-button ${action === 'delete' ? 'sam-button-quiet' : 'sam-button-secondary'}`;
        button.dataset.action = action;
        button.dataset.accountId = account.id;
        button.title = titleText;
        button.textContent = label;
        actions.append(button);
    }
    item.append(actions);
    return item;
}

function renderGroupFilter() {
    const select = $('#sam-filter-group');
    if (!select) return;
    const selected = select.value;
    const groups = [...new Set(settings.accounts.map(account => account.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部分组';
    select.append(all);
    for (const group of groups) {
        const option = document.createElement('option');
        option.value = group;
        option.textContent = group;
        select.append(option);
    }
    select.value = groups.includes(selected) ? selected : '';
    const suggestions = $('#sam-group-options');
    if (suggestions) {
        suggestions.replaceChildren(...groups.map(group => {
            const option = document.createElement('option');
            option.value = group;
            return option;
        }));
    }
}

function renderAccounts() {
    renderGroupFilter();
    updateFormBalance();
    if ($('#sam-account-count')) $('#sam-account-count').textContent = `已保存 ${settings.accounts.length} 个`;
    const list = $('#sam-account-list');
    if (!list) return;
    const filter = asString($('#sam-filter-group')?.value);
    const accounts = settings.accounts
        .filter(account => !filter || account.group === filter)
        .sort((a, b) => (a.group || '未分组').localeCompare(b.group || '未分组') || a.name.localeCompare(b.name));
    list.replaceChildren();
    if (!accounts.length) {
        const empty = document.createElement('div');
        empty.className = 'sam-empty';
        empty.textContent = settings.accounts.length ? '该分组暂无账户。' : '还没有保存的 API，在下方填写信息即可添加。';
        list.append(empty);
        return;
    }
    for (const account of accounts) list.append(createAccountCard(account));
}

function saveAccountFromForm(event) {
    event?.preventDefault();
    let account;
    try { account = readForm(); } catch (error) {
        notify(error?.message || '表单读取失败。', 'error');
        return;
    }
    if (!account.name) return notify('请填写账户名称。', 'error');
    if (!account.baseUrl || !isHttpUrl(account.baseUrl)) return notify('请填写有效的 API 基础地址。', 'error');
    if (!account.apiKey) return notify('请填写 API Key。', 'error');
    const index = settings.accounts.findIndex(item => item.id === account.id);
    if (index >= 0) settings.accounts[index] = normalizeAccount(account);
    else settings.accounts.push(normalizeAccount(account));
    settings.selectedAccountId = account.id;
    persist();
    renderAccounts();
    clearForm();
    notify(index >= 0 ? '账户已更新。' : '账户已保存。', 'success');
}

function editAccount(account) {
    settings.selectedAccountId = account.id;
    persist();
    fillForm(account);
    renderAccounts();
}

function deleteAccount(account) {
    const confirmed = typeof globalThis.confirm === 'function'
        ? globalThis.confirm(`确定删除账户“${account.name}”吗？API Key 也会从本地设置中移除。`)
        : true;
    if (!confirmed) return;
    settings.accounts = settings.accounts.filter(item => item.id !== account.id);
    if (settings.selectedAccountId === account.id) settings.selectedAccountId = '';
    persist();
    if ($('#sam-account-id')?.value === account.id) clearForm();
    renderAccounts();
    notify('账户已删除。', 'success');
}

function findConnectionInput(selectors) {
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element;
    }
    return null;
}

function setConnectionValue(selectors, value) {
    const element = findConnectionInput(selectors);
    if (!element) return false;
    element.value = value;
    for (const eventName of ['input', 'change']) element.dispatchEvent(new Event(eventName, { bubbles: true }));
    return true;
}

function applyToSillyTavern(account) {
    const main = document.querySelector('#main_api');
    const source = document.querySelector('#chat_completion_source');
    const controls = ['#custom_api_url_text', '#api_key_custom', '#custom_model_id'];
    if (!main || !source || controls.some(selector => !document.querySelector(selector))
        || ![...main.options].some(option => option.value === 'openai')
        || ![...source.options].some(option => option.value === 'custom')) {
        notify('当前酒馆缺少自定义聊天补全控件，请检查酒馆版本。', 'error');
        return;
    }
    // Fill the complete connection before source changes can trigger a reconnect.
    const mainChanged = main.value !== 'openai';
    const sourceChanged = source.value !== 'custom';
    main.value = 'openai';
    source.value = 'custom';
    setConnectionValue(['#custom_api_url_text'], account.baseUrl);
    setConnectionValue(['#api_key_custom'], account.apiKey);
    setConnectionValue(['#custom_model_id'], account.selectedModel || '');
    if (sourceChanged) source.dispatchEvent(new Event('change', { bubbles: true }));
    if (mainChanged) main.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    notify('已填入下方的自定义连接设置，请点击酒馆“连接”。', 'success');
}

async function handleAccountAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const account = settings.accounts.find(item => item.id === button.dataset.accountId);
    if (!account) return;
    settings.selectedAccountId = account.id;
    persist();
    switch (button.dataset.action) {
        case 'edit': editAccount(account); break;
        case 'delete': deleteAccount(account); break;
        case 'models':
            fillForm(account);
            await fetchModelsForDraft();
            if (formModels.length) {
                account.models = [...formModels];
                account.selectedModel = asString($('#sam-model-select')?.value).trim() || account.selectedModel;
                account.updatedAt = Date.now();
                persist();
                renderAccounts();
            }
            break;
        case 'balance': await refreshBalance(account); break;
        case 'apply': applyToSillyTavern(account); break;
        default: break;
    }
}

function restartRefreshTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if (!settings.autoRefresh) return;
    const intervalMs = settings.refreshInterval * 60 * 1000;
    refreshTimer = setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        refreshAllBalances({ silent: true });
    }, intervalMs);
}

function bindEvents() {
    const form = $('#sam-account-form');
    form?.addEventListener('submit', saveAccountFromForm);
    $('#sam-cancel-edit')?.addEventListener('click', clearForm);
    $('#sam-preset')?.addEventListener('change', event => applyPreset(event.target.value));
    $('#sam-fetch-models')?.addEventListener('click', fetchModelsForDraft);
    $('#sam-fetch-balance')?.addEventListener('click', async () => {
        const id = asString($('#sam-account-id')?.value);
        const account = settings.accounts.find(item => item.id === id);
        if (!account) {
            notify('请先保存账户，再查询余额。', 'error');
            return;
        }
        const draft = readForm();
        Object.assign(account, {
            provider: draft.provider,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey,
            balanceUrl: draft.balanceUrl,
            balancePath: draft.balancePath,
            balanceCurrency: draft.balanceCurrency,
            balanceParser: draft.balanceParser,
        });
        await refreshBalance(account);
        updateFormBalance();
    });
    $('#sam-refresh-all')?.addEventListener('click', () => refreshAllBalances());
    $('#sam-filter-group')?.addEventListener('change', renderAccounts);
    $('#sam-account-list')?.addEventListener('click', handleAccountAction);
    $('#sam-auto-refresh')?.addEventListener('change', event => {
        settings.autoRefresh = Boolean(event.target.checked);
        persist();
        restartRefreshTimer();
    });
    $('#sam-refresh-interval')?.addEventListener('change', event => {
        settings.refreshInterval = clampInteger(event.target.value, 1, 1440, 30);
        event.target.value = settings.refreshInterval;
        persist();
        restartRefreshTimer();
    });
    $('#sam-key-toggle')?.addEventListener('click', event => {
        const input = $('#sam-api-key');
        if (!input) return;
        const visible = input.type === 'text';
        input.type = visible ? 'password' : 'text';
        event.currentTarget.textContent = visible ? '显示' : '隐藏';
        event.currentTarget.setAttribute('aria-label', visible ? '显示 API Key' : '隐藏 API Key');
        event.currentTarget.setAttribute('aria-pressed', String(!visible));
    });
}

function loadSettingsIntoUi() {
    const auto = $('#sam-auto-refresh');
    const interval = $('#sam-refresh-interval');
    if (auto) auto.checked = settings.autoRefresh;
    if (interval) interval.value = settings.refreshInterval;
    renderAccounts();
    if (settings.selectedAccountId) {
        const account = settings.accounts.find(item => item.id === settings.selectedAccountId);
        if (account) fillForm(account);
    }
}

async function loadPanel() {
    const host = document.querySelector('#openai_api');
    const source = host?.querySelector('#chat_completion_source');
    if (!source) return false;
    try {
        let panel = rootElement();
        if (!panel) {
            const panelUrl = new URL('./settings.html', import.meta.url);
            panelUrl.searchParams.set('v', EXTENSION_VERSION);
            const response = await fetch(panelUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const template = document.createElement('template');
            template.innerHTML = await response.text();
            panel = template.content.querySelector(`#${SETTINGS_ROOT_ID}`);
            if (!panel) throw new Error('API 账户面板缺少根节点');
        }
        source.after(panel);
        const styleUrl = new URL('./style.css', import.meta.url);
        styleUrl.searchParams.set('v', EXTENSION_VERSION);
        const styleHref = styleUrl.href;
        if (!document.querySelector(`link[data-sam-style="${styleHref}"]`)) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = styleHref;
            link.dataset.samStyle = styleHref;
            document.head.append(link);
        }
        return Boolean(rootElement());
    } catch (error) {
        console.error('[API Account Manager] Unable to load settings panel', error);
        return false;
    }
}

async function init() {
    settings = normalizeSettings(extension_settings[EXTENSION_NAME]);
    extension_settings[EXTENSION_NAME] = settings;
    const loaded = await loadPanel();
    if (!loaded) {
        // Wait for the native API connection drawer when it mounts after imports.
        setTimeout(() => init(), 500);
        return;
    }
    populatePresets();
    bindEvents();
    loadSettingsIntoUi();
    restartRefreshTimer();
}

// SillyTavern loads third-party extension entry points as modules.  jQuery is
// already available globally, but DOMContentLoaded is still useful when the
// extension is imported before the settings panel has been mounted.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
