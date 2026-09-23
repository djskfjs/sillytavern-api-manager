/**
 * SillyTavern API Account Manager
 *
 * A dependency-free account/profile manager for OpenAI-compatible APIs.
 * The extension is intentionally written as a regular ES module so it can be
 * installed directly from a GitHub repository in SillyTavern 1.14.x.
 */

import { extension_settings } from '../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { identifyProvider, queryBalance, requestApiJson as requestJson } from './balance.js?v=1.7.0';
import { displayApiUrl, requestApiJsonViaSillyTavern, resolveApiEndpoint, requestNativeModels } from './api-routing.js?v=1.7.0';

const EXTENSION_NAME = 'sillytavern-api-manager';
const EXTENSION_VERSION = '1.7.0';
const SETTINGS_ROOT_ID = 'st-api-account-manager';
const SETTINGS_VERSION = 3;

const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    accounts: [],
    selectedAccountId: '',
    accountFilter: { type: 'all' },
    autoRefresh: true,
    refreshInterval: 30,
    pollingEnabled: false,
    pollingFilter: null,
    pollingCursorId: '',
    pollingInterval: 5,
});

let settings;
let refreshTimer = null;
let pollingTimer = null;
let formModels = [];
let formResolvedConnection = null;
let formConnectionRevision = 0;
let isLoadingModels = false;
let isLoadingBalance = false;
let isApplyingAccount = false;
const activeBalanceQueries = new Map();

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
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
        return false;
    }
}

function normalizeBalance(balance) {
    const empty = { status: 'unknown', value: null, currency: '', kind: 'balance', scope: '', message: '', fetchedAt: 0 };
    if (!balance || typeof balance !== 'object') return empty;
    const kind = ['balance', 'token', 'quota'].includes(balance.kind) ? balance.kind : 'balance';
    const finiteValue = typeof balance.value === 'number' && Number.isFinite(balance.value);
    const unlimited = kind === 'token' && balance.value === '不限额';
    const validScope = kind === 'balance' ? balance.scope === 'account' : balance.scope === 'token';
    if (balance.status === 'ok' && (!validScope || (!finiteValue && !unlimited))) {
        return empty;
    }
    return {
        status: ['ok', 'loading', 'error', 'unsupported', 'unknown'].includes(balance.status) ? balance.status : 'unknown',
        value: balance.value == null ? null : balance.value,
        currency: asString(balance.currency),
        kind,
        scope: balance.scope === 'account' ? 'account' : balance.scope === 'token' ? 'token' : '',
        message: asString(balance.message),
        fetchedAt: Number.isFinite(Number(balance.fetchedAt)) ? Number(balance.fetchedAt) : 0,
    };
}

function savedApiEndpoint(account) {
    const resolved = normalizeUrl(account?.resolvedBaseUrl);
    return isHttpUrl(resolved) && displayApiUrl(resolved) === displayApiUrl(account?.baseUrl) ? resolved : '';
}

function normalizeAccount(account) {
    const source = account && typeof account === 'object' ? account : {};
    const models = Array.isArray(source.models)
        ? source.models.map(item => asString(item).trim()).filter(Boolean)
        : [];
    const uniqueModels = [...new Set(models)];
    const selectedModel = asString(source.selectedModel ?? source.model).trim();
    if (selectedModel && !uniqueModels.includes(selectedModel)) uniqueModels.unshift(selectedModel);
    const rawBaseUrl = normalizeUrl(source.baseUrl);
    const baseUrl = displayApiUrl(rawBaseUrl);
    return {
        id: asString(source.id) || makeId(),
        name: asString(source.name).trim() || '未命名账户',
        group: asString(source.group).trim(),
        favorite: source.favorite === true,
        provider: asString(source.provider),
        baseUrl,
        resolvedBaseUrl: savedApiEndpoint({ baseUrl, resolvedBaseUrl: source.resolvedBaseUrl }),
        apiKey: asString(source.apiKey).trim(),
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

function normalizeAccountFilter(filter, accounts) {
    if (filter?.type === 'favorites') return { type: 'favorites' };
    if (filter?.type === 'group' && typeof filter.group === 'string'
        && accounts.some(account => account.group === filter.group)) {
        return { type: 'group', group: filter.group };
    }
    return { type: 'all' };
}

function sameAppliedConnection(left, right) {
    return Boolean(left && right)
        && displayApiUrl(left.baseUrl) === displayApiUrl(right.baseUrl)
        && savedApiEndpoint(left) === savedApiEndpoint(right)
        && asString(left.apiKey) === asString(right.apiKey)
        && asString(left.selectedModel) === asString(right.selectedModel);
}

function normalizePollingFilter(filter, accounts) {
    if (filter?.type === 'favorites') return { type: 'favorites' };
    if (filter?.type === 'group' && typeof filter.group === 'string'
        && accounts.some(account => account.group === filter.group)) {
        return { type: 'group', group: filter.group };
    }
    return null;
}

function accountMatchesFilter(account, filter) {
    if (!account || !filter) return false;
    return filter.type === 'favorites' ? account.favorite === true
        : filter.type === 'group' ? account.group === filter.group : false;
}

function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const accounts = Array.isArray(source.accounts) ? source.accounts.map(normalizeAccount) : [];
    // Requests do not survive a page reload, even if another save persisted
    // their temporary loading state.
    for (const account of accounts) {
        if (account.balance.status === 'loading') account.balance.status = 'unknown';
    }
    const selected = asString(source.selectedAccountId);
    const selectedEntry = accounts.find(account => account.id === selected);
    const pollingEnabled = source.pollingEnabled === true;
    const legacyPollingFilter = selectedEntry ? { type: 'group', group: selectedEntry.group } : null;
    const pollingFilter = pollingEnabled
        ? normalizePollingFilter(source.pollingFilter, accounts)
            || normalizePollingFilter(legacyPollingFilter, accounts)
        : null;
    const savedCursor = asString(source.pollingCursorId);
    const pollingCursor = accounts.find(account => account.id === savedCursor)
        || selectedEntry;
    const pollingCursorId = pollingEnabled && accountMatchesFilter(pollingCursor, pollingFilter)
        ? pollingCursor.id : '';
    const selectedAccountId = Number(source.version) >= SETTINGS_VERSION
        && selectedEntry ? selectedEntry.id : '';
    const { expandedGroups, ...retained } = source;
    return {
        ...DEFAULT_SETTINGS,
        ...retained,
        version: SETTINGS_VERSION,
        accounts,
        selectedAccountId,
        accountFilter: normalizeAccountFilter(source.accountFilter, accounts),
        autoRefresh: source.autoRefresh !== false,
        refreshInterval: clampInteger(source.refreshInterval, 1, 1440, DEFAULT_SETTINGS.refreshInterval),
        pollingEnabled: pollingEnabled && Boolean(pollingFilter),
        pollingFilter,
        pollingCursorId,
        pollingInterval: clampInteger(source.pollingInterval, 1, 1440, DEFAULT_SETTINGS.pollingInterval),
    };
}

function setButtonContent(button, iconClass, label) {
    if (!button) return;
    const text = document.createElement('span');
    text.textContent = label;
    if (!iconClass) {
        button.replaceChildren(text);
        return;
    }
    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    button.replaceChildren(icon, text);
}

function setKeyVisibility(visible) {
    const input = $('#sam-api-key');
    const button = $('#sam-key-toggle');
    if (!input || !button) return;
    input.type = visible ? 'text' : 'password';
    setButtonContent(button, visible ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye', visible ? '隐藏' : '显示');
    button.setAttribute('aria-label', visible ? '隐藏 API Key' : '显示 API Key');
    button.setAttribute('aria-pressed', String(visible));
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

function readForm() {
    const accountId = asString($('#sam-account-id')?.value).trim();
    const existing = settings.accounts.find(account => account.id === accountId);
    const enteredKey = asString($('#sam-api-key')?.value).trim();
    const apiKey = enteredKey || existing?.apiKey || '';
    const enteredUrl = normalizeUrl($('#sam-base-url')?.value);
    const baseUrl = displayApiUrl(enteredUrl);
    // Keep saved balance support when only the account name or group changes.
    const sameService = existing && displayApiUrl(existing.baseUrl) === baseUrl;
    const sameConnection = sameService && apiKey === existing.apiKey;
    const resolvedBaseUrl = formResolvedConnection?.baseUrl === baseUrl && formResolvedConnection.apiKey === apiKey
        ? formResolvedConnection.resolvedBaseUrl : sameConnection ? savedApiEndpoint(existing) : '';
    const selectedModel = asString($('#sam-model-select')?.value).trim();
    const models = [...new Set([
        ...formModels,
        ...(sameConnection ? existing.models : []),
        selectedModel,
    ].map(item => asString(item).trim()).filter(Boolean))];
    return {
        id: accountId || makeId(),
        name: asString($('#sam-name')?.value).trim(),
        group: asString($('#sam-group')?.value).trim(),
        favorite: existing?.favorite === true,
        provider: identifyProvider(baseUrl),
        baseUrl,
        resolvedBaseUrl,
        apiKey,
        models,
        selectedModel,
        balanceUrl: sameService ? existing.balanceUrl : '',
        balancePath: sameService ? existing.balancePath : '',
        balanceCurrency: sameService ? existing.balanceCurrency : '',
        balanceParser: sameService ? existing.balanceParser : 'generic',
        balance: sameConnection ? existing.balance : normalizeBalance(null),
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
    };
}

function clearForm() {
    formConnectionRevision++;
    formResolvedConnection = null;
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
    formModels = [];
    renderGroupSuggestions('');
    if ($('#sam-delete-account')) $('#sam-delete-account').hidden = true;
    if ($('#sam-cancel-edit')) $('#sam-cancel-edit').hidden = true;
    setButtonContent($('#sam-save-account'), 'fa-solid fa-floppy-disk', '保存 API');
    if ($('#sam-form-title')) $('#sam-form-title').textContent = '添加 API';
    if ($('#sam-api-key')) {
        $('#sam-api-key').required = true;
        $('#sam-api-key').placeholder = 'sk-…';
    }
    setKeyVisibility(false);
    updateFormBalance();
    setStatus('就绪');
    $('.sam-editor-summary')?.focus({ preventScroll: true });
}

function fillForm(account) {
    if (!account) return;
    const editor = $('#sam-editor');
    if (editor) editor.open = true;
    formConnectionRevision++;
    formResolvedConnection = null;
    const values = {
        '#sam-account-id': account.id,
        '#sam-name': account.name,
        '#sam-base-url': displayApiUrl(account.baseUrl),
        '#sam-api-key': '',
    };
    for (const [selector, value] of Object.entries(values)) {
        const input = $(selector);
        if (input) input.value = value;
    }
    renderGroupSuggestions(account.group);
    formModels = [...account.models];
    populateModelSelect(formModels, account.selectedModel);
    if ($('#sam-cancel-edit')) $('#sam-cancel-edit').hidden = false;
    if ($('#sam-delete-account')) $('#sam-delete-account').hidden = false;
    setButtonContent($('#sam-save-account'), 'fa-solid fa-floppy-disk', '更新 API');
    if ($('#sam-form-title')) $('#sam-form-title').textContent = '编辑 API';
    if ($('#sam-api-key')) {
        $('#sam-api-key').required = false;
        $('#sam-api-key').placeholder = account.apiKey ? '留空以保留当前 Key' : 'sk-…';
    }
    setKeyVisibility(false);
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

function resolveAccountEndpoint(account) {
    return resolveApiEndpoint(account, {
        request: requestJson,
        nativeRequest: (baseUrl, apiKey) => requestNativeModels(baseUrl, apiKey, { getRequestHeaders }),
    });
}

async function requestBalanceJson(url, apiKey) {
    try {
        return await requestJson(url, apiKey, { proxy: false });
    } catch (error) {
        if (!error?.network) throw error;
        return requestApiJsonViaSillyTavern(url, apiKey, { getRequestHeaders });
    }
}

function invalidateDraftConnection() {
    formConnectionRevision++;
    formResolvedConnection = null;
    formModels = [];
    populateModelSelect([]);
}

async function fetchModelsForDraft() {
    if (isLoadingModels) return;
    const draft = readForm();
    if (!draft.baseUrl || !isHttpUrl(draft.baseUrl)) {
        notify('请先填写有效的 API 基础地址。', 'error');
        return;
    }
    if (!draft.apiKey) return notify('请先填写有效的 API Key。', 'error');
    const revision = formConnectionRevision;
    const stillCurrent = () => {
        if (revision !== formConnectionRevision) return false;
        const current = readForm();
        return current.baseUrl === draft.baseUrl && current.apiKey === draft.apiKey;
    };
    isLoadingModels = true;
    const button = $('#sam-fetch-models');
    if (button) {
        button.disabled = true;
        setButtonContent(button, 'fa-solid fa-spinner fa-spin', '获取中…');
    }
    setStatus('正在获取模型…');
    try {
        const result = await resolveAccountEndpoint(draft);
        if (!stillCurrent()) return;
        const { models } = result;
        const baseUrl = displayApiUrl(result.baseUrl);
        formResolvedConnection = { baseUrl, apiKey: draft.apiKey, resolvedBaseUrl: result.baseUrl };
        if ($('#sam-base-url')) $('#sam-base-url').value = baseUrl;
        formModels = models;
        populateModelSelect(models, $('#sam-model-select')?.value || models[0]);
        notify(`已获取 ${models.length} 个模型。`, 'success');
    } catch (error) {
        if (stillCurrent()) notify(error?.message || '获取模型失败。', 'error');
    } finally {
        isLoadingModels = false;
        if (button) {
            button.disabled = false;
            setButtonContent(button, 'fa-solid fa-cloud-arrow-down', '获取模型');
        }
    }
}

async function refreshBalance(account, options = {}) {
    const snapshot = { ...account };
    const active = activeBalanceQueries.get(snapshot.id);
    if (active && active.snapshot.baseUrl === snapshot.baseUrl && active.snapshot.apiKey === snapshot.apiKey) {
        return active.promise;
    }
    const query = { snapshot, promise: null };
    const currentAccount = () => activeBalanceQueries.get(snapshot.id) === query
        ? settings.accounts.find(item => item.id === snapshot.id
            && item.baseUrl === snapshot.baseUrl && item.apiKey === snapshot.apiKey)
        : undefined;
    // Register the promise before starting work, so a replacement connection
    // cannot reuse or be overwritten by an older request for the same account.
    query.promise = Promise.resolve().then(async () => {
        try {
            const result = await queryBalance(snapshot, { request: requestBalanceJson });
            const current = currentAccount();
            if (!current) return null;
            current.balance = normalizeBalance({ ...result, status: 'ok', fetchedAt: Date.now() });
            current.updatedAt = Date.now();
            persist();
            if (!options.silent) notify(`${current.name} 的余额信息已更新。`, 'success');
            return current.balance;
        } catch (error) {
            const current = currentAccount();
            if (!current) return null;
            current.balance = normalizeBalance({ status: error?.unsupported ? 'unsupported' : 'error', value: null,
                message: error?.message || '查询失败', fetchedAt: Date.now() });
            persist();
            if (!options.silent) notify(`${current.name}：${current.balance.message}`, 'error');
            return current.balance;
        } finally {
            if (activeBalanceQueries.get(snapshot.id) === query) {
                activeBalanceQueries.delete(snapshot.id);
                const current = settings.accounts.find(item => item.id === snapshot.id);
                if (current) updateAccountBalanceUi(current);
            }
        }
    });
    activeBalanceQueries.set(snapshot.id, query);
    account.balance = { ...normalizeBalance(account.balance), status: 'loading', message: '' };
    updateAccountBalanceUi(account);
    return query.promise;
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
    }
}

function formatBalance(balance) {
    const label = ['token', 'quota'].includes(balance?.kind) ? '密钥可用额度' : '账户余额';
    if (balance?.status === 'loading') return `${label}：查询中…`;
    if (balance?.status === 'unsupported') return `${label}：${balance.message || '站点未开放查询接口'}`;
    if (balance?.status === 'error') return `${label}：查询失败（${balance.message || '未知错误'}）`;
    if (balance?.status !== 'ok') return `${label}：未查询`;
    const value = typeof balance.value === 'number'
        ? balance.value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : balance.value;
    if (value == null || value === '') return `${label}：未查询`;
    return `${label}：${value}${balance.currency ? ` ${balance.currency}` : ''}`;
}

function formatTime(timestamp) {
    if (!timestamp) return '';
    try { return new Date(timestamp).toLocaleString(); } catch { return ''; }
}

function updateFormBalance() {
    const account = settings.accounts.find(item => item.id === $('#sam-account-id')?.value);
    const output = $('#sam-form-balance');
    if (output) {
        output.textContent = account ? formatBalance(account.balance) : '账户余额：保存后可查询';
        output.dataset.state = account?.balance?.status || 'unknown';
    }
    const button = $('#sam-fetch-balance');
    if (button) {
        button.disabled = !account || account.balance?.status === 'loading';
        setButtonContent(button,
            account?.balance?.status === 'loading' ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-wallet',
            account?.balance?.status === 'loading' ? '查询中…' : '查询余额');
    }
}

function updateAccountBalanceUi(account) {
    const card = $$('.sam-account-item').find(item => item.dataset.accountId === account.id);
    if (card) {
        const output = $('.sam-account-balance', card);
        if (output) {
            output.textContent = formatBalance(account.balance);
            output.dataset.state = account.balance?.status || 'unknown';
        }
        const button = $('button[data-action="balance"]', card);
        if (button) {
            button.disabled = account.balance?.status === 'loading';
            setButtonContent(button,
                button.disabled ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate',
                button.disabled ? '查询中…' : '刷新余额');
        }
        const time = $('.sam-account-time', card);
        if (time) {
            time.hidden = !account.balance?.fetchedAt;
            time.textContent = account.balance?.fetchedAt ? `更新于 ${formatTime(account.balance.fetchedAt)}` : '';
        }
    }
    if ($('#sam-account-id')?.value === account.id) updateFormBalance();
}

function createAccountCard(account) {
    const item = document.createElement('article');
    item.className = 'sam-account-item';
    item.setAttribute('role', 'listitem');
    item.dataset.accountId = account.id;
    const selected = account.id === settings.selectedAccountId;
    if (selected) {
        item.classList.add('sam-selected');
        item.setAttribute('aria-current', 'true');
    }
    if (account.favorite) item.classList.add('sam-favorite');

    const main = document.createElement('div');
    main.className = 'sam-account-main';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'sam-account-identity';
    const titleLine = document.createElement('div');
    titleLine.className = 'sam-account-title-line';
    const title = document.createElement('div');
    title.className = 'sam-account-name';
    title.textContent = account.name;
    titleLine.append(title);
    if (selected) {
        const current = document.createElement('span');
        current.className = 'sam-current-badge';
        current.textContent = '当前';
        titleLine.append(current);
    }
    const group = document.createElement('div');
    group.className = 'sam-account-group';
    group.textContent = account.group || '未分组';
    titleWrap.append(titleLine, group);
    const favorite = document.createElement('button');
    favorite.type = 'button';
    favorite.className = 'sam-favorite-button';
    favorite.dataset.action = 'favorite';
    favorite.dataset.accountId = account.id;
    favorite.textContent = account.favorite ? '★' : '☆';
    favorite.title = account.favorite ? '取消收藏' : '收藏并置顶';
    favorite.setAttribute('aria-label', `${account.favorite ? '取消收藏' : '收藏'} ${account.name}`);
    favorite.setAttribute('aria-pressed', String(account.favorite));
    main.append(titleWrap, favorite);
    item.append(main);

    const meta = document.createElement('div');
    meta.className = 'sam-account-meta';
    const url = document.createElement('span');
    url.className = 'sam-account-url';
    url.title = displayApiUrl(account.baseUrl);
    url.textContent = displayApiUrl(account.baseUrl) || '未填写 API 地址';
    const model = document.createElement('span');
    model.className = 'sam-account-model';
    model.title = account.selectedModel || '未选择模型';
    model.textContent = account.selectedModel || '未选择模型';
    meta.append(url, model);
    item.append(meta);
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
    setButtonContent(balanceButton,
        account.balance?.status === 'loading' ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate',
        account.balance?.status === 'loading' ? '查询中…' : '刷新余额');
    balanceButton.disabled = account.balance?.status === 'loading';
    balanceButton.setAttribute('aria-label', `查询 ${account.name} 的余额`);
    balanceRow.append(balance, balanceButton);
    item.append(balanceRow);
    const time = document.createElement('div');
    time.className = 'sam-account-time';
    time.hidden = !account.balance?.fetchedAt;
    time.textContent = account.balance?.fetchedAt ? `更新于 ${formatTime(account.balance.fetchedAt)}` : '';
    item.append(time);

    const actions = document.createElement('div');
    actions.className = 'sam-account-actions';
    const actionDefinitions = [
        ['edit', 'fa-solid fa-pen', '编辑', '编辑账户'],
        ['apply', 'fa-solid fa-plug', '应用', '设为当前账户并连接此 API'],
        ['delete', 'fa-solid fa-trash-can', '删除', '删除账户'],
    ];
    for (const [action, iconClass, label, titleText] of actionDefinitions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `menu_button sam-button ${action === 'delete' ? 'sam-button-quiet' : 'sam-button-secondary'}`;
        button.dataset.action = action;
        button.dataset.accountId = account.id;
        button.title = titleText;
        setButtonContent(button, iconClass, label);
        if (action === 'apply') button.disabled = isApplyingAccount;
        actions.append(button);
    }
    item.append(actions);
    return item;
}

function savedGroups({ includeUngrouped = false } = {}) {
    return [...new Set(settings.accounts.map(account => account.group).filter(group => includeUngrouped || Boolean(group)))]
        .sort((a, b) => (a || '未分组').localeCompare(b || '未分组'));
}

function groupOptionValue(group) {
    return `group:${encodeURIComponent(group)}`;
}

function groupFromOptionValue(value) {
    if (!asString(value).startsWith('group:')) return undefined;
    try {
        return decodeURIComponent(value.slice(6));
    } catch {
        return undefined;
    }
}

function createOption(label, value) {
    const option = document.createElement('option');
    option.textContent = label;
    option.value = value;
    return option;
}

function renderGroupSuggestions(selectedGroup) {
    const groups = savedGroups();
    const input = $('#sam-group');
    const options = $('#sam-group-options');
    if (!input || !options) return;
    const current = selectedGroup ?? input.value;
    const entries = groups.map(group => {
        const option = document.createElement('option');
        option.value = group;
        return option;
    });
    options.replaceChildren(...entries);
    input.value = current;

    const picker = $('#sam-group-select');
    if (!picker) return;
    const placeholder = createOption('选择已有分组', '');
    const ungrouped = createOption('未分组', groupOptionValue(''));
    picker.replaceChildren(placeholder, ungrouped,
        ...groups.map(group => createOption(group, groupOptionValue(group))));
    picker.value = settings.accounts.some(account => account.group === current)
        ? groupOptionValue(current) : '';
}

function filteredAccounts(accounts, filter) {
    return accounts.filter(account => filter.type === 'all' || accountMatchesFilter(account, filter))
        .sort((a, b) => Number(b.favorite) - Number(a.favorite)
            || (a.group || '未分组').localeCompare(b.group || '未分组')
            || a.name.localeCompare(b.name));
}

function renderAccountFilters() {
    const favoritesButton = $('#sam-filter-favorites');
    const allButton = $('#sam-filter-all');
    const groupSelect = $('#sam-group-filter');
    if (!favoritesButton || !allButton || !groupSelect) return;

    setButtonContent(favoritesButton, 'fa-solid fa-star',
        `收藏 ${settings.accounts.filter(account => account.favorite).length}`);
    setButtonContent(allButton, '', `全部 ${settings.accounts.length}`);
    favoritesButton.setAttribute('aria-pressed', String(settings.accountFilter.type === 'favorites'));
    allButton.setAttribute('aria-pressed', String(settings.accountFilter.type === 'all'));

    const placeholder = createOption('选择分组', '');
    const options = savedGroups({ includeUngrouped: true }).map(group => {
        const count = settings.accounts.filter(account => account.group === group).length;
        return createOption(`${group || '未分组'} ${count}`, groupOptionValue(group));
    });
    groupSelect.replaceChildren(placeholder, ...options);
    groupSelect.value = settings.accountFilter.type === 'group'
        ? groupOptionValue(settings.accountFilter.group) : '';
    groupSelect.parentElement?.classList.toggle('sam-active', settings.accountFilter.type === 'group');
}

function selectedAccount() {
    return settings.accounts.find(account => account.id === settings.selectedAccountId);
}

function suggestedPollingFilter() {
    if (settings.accountFilter.type === 'favorites') return { type: 'favorites' };
    if (settings.accountFilter.type === 'group') return { ...settings.accountFilter };
    const account = selectedAccount();
    return account ? { type: 'group', group: account.group } : null;
}

function currentPollingFilter() {
    return settings.pollingEnabled
        ? normalizePollingFilter(settings.pollingFilter, settings.accounts)
        : normalizePollingFilter(suggestedPollingFilter(), settings.accounts);
}

function pollingAccounts(filter = currentPollingFilter()) {
    return filter ? filteredAccounts(settings.accounts, filter) : [];
}

function nextPollingAccount(filter = currentPollingFilter()) {
    const accounts = pollingAccounts(filter);
    if (!accounts.length) return null;
    const cursorId = settings.pollingEnabled ? settings.pollingCursorId : settings.selectedAccountId;
    const currentIndex = accounts.findIndex(account => account.id === cursorId);
    return accounts[(currentIndex + 1 + accounts.length) % accounts.length];
}

function pollingFilterLabel(filter) {
    if (!filter) return '';
    return filter.type === 'favorites' ? '收藏' : (filter.group || '未分组');
}

function updatePollingUi() {
    const filter = currentPollingFilter();
    const accounts = pollingAccounts(filter);
    const label = $('#sam-current-group');
    if (label) label.textContent = filter
        ? `轮询范围：${pollingFilterLabel(filter)} · ${accounts.length} 个账户`
        : '轮询范围：未选择';
    const button = $('#sam-toggle-polling');
    if (button) {
        button.disabled = !settings.pollingEnabled && accounts.length < 2;
        button.title = accounts.length < 2
            ? '当前轮询范围至少需要两个账户'
            : `按设定间隔循环应用“${pollingFilterLabel(filter)}”中的账户`;
        setButtonContent(button,
            settings.pollingEnabled ? 'fa-solid fa-stop' : 'fa-solid fa-shuffle',
            settings.pollingEnabled ? '停止轮询' : '开启轮询');
        button.setAttribute('aria-pressed', String(settings.pollingEnabled));
        button.classList.toggle('sam-button-primary', settings.pollingEnabled);
    }
}

function renderAccounts() {
    const validFilter = normalizeAccountFilter(settings.accountFilter, settings.accounts);
    if (validFilter.type !== settings.accountFilter.type || validFilter.group !== settings.accountFilter.group) {
        settings.accountFilter = validFilter;
        persist();
    }
    renderGroupSuggestions();
    renderAccountFilters();
    updatePollingUi();
    updateFormBalance();
    if ($('#sam-account-count')) $('#sam-account-count').textContent = `已保存 ${settings.accounts.length} 个`;
    const list = $('#sam-account-list');
    if (!list) return;
    const accounts = filteredAccounts(settings.accounts, settings.accountFilter);
    list.replaceChildren();
    if (!accounts.length) {
        const empty = document.createElement('div');
        empty.className = 'sam-empty';
        empty.textContent = settings.accounts.length && settings.accountFilter.type === 'favorites'
            ? '还没有收藏的 API。'
            : '还没有保存的 API。';
        list.append(empty);
        return;
    }
    list.append(...accounts.map(createAccountCard));
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
    const existing = index >= 0 ? settings.accounts[index] : null;
    const clearSelected = existing?.id === settings.selectedAccountId
        && !sameAppliedConnection(existing, account);
    if (index >= 0) settings.accounts[index] = normalizeAccount(account);
    else settings.accounts.push(normalizeAccount(account));
    if (clearSelected) settings.selectedAccountId = '';
    if ((settings.accountFilter.type === 'favorites' && !account.favorite)
        || (settings.accountFilter.type === 'group' && settings.accountFilter.group !== account.group)) {
        settings.accountFilter = { type: 'group', group: account.group };
    }
    persist();
    renderAccounts();
    clearForm();
    restartPollingTimer();
    notify(index >= 0 ? '账户已更新。' : '账户已保存。', 'success');
}

function editAccount(account) {
    fillForm(account);
}

function markSelectedAccount(account, options = {}) {
    const current = settings.accounts.find(item => item.id === account.id);
    if (!current) return false;
    settings.selectedAccountId = current.id;
    if (settings.pollingEnabled) {
        const filter = normalizePollingFilter(settings.pollingFilter, settings.accounts);
        settings.pollingCursorId = accountMatchesFilter(current, filter) ? current.id : '';
    }
    persist();
    renderAccounts();
    if (options.restartPolling !== false) restartPollingTimer();
    return true;
}

function deleteAccount(account) {
    const confirmed = typeof globalThis.confirm === 'function'
        ? globalThis.confirm(`确定删除账户“${account.name}”吗？API Key 也会从本地设置中移除。`)
        : true;
    if (!confirmed) return;
    const visibleAccounts = filteredAccounts(settings.accounts, settings.accountFilter);
    const visibleIndex = visibleAccounts.findIndex(item => item.id === account.id);
    const focusAccountId = visibleAccounts[visibleIndex + 1]?.id
        || visibleAccounts[visibleIndex - 1]?.id || '';
    settings.accounts = settings.accounts.filter(item => item.id !== account.id);
    if (settings.selectedAccountId === account.id) {
        settings.selectedAccountId = '';
    }
    persist();
    if ($('#sam-account-id')?.value === account.id) clearForm();
    renderAccounts();
    restartPollingTimer();
    notify('账户已删除。', 'success');
    const focusCard = $$('.sam-account-item').find(item => item.dataset.accountId === focusAccountId);
    const focusTarget = focusCard ? $('button[data-action="edit"]', focusCard)
        : settings.accountFilter.type === 'group' ? $('#sam-group-filter')
            : $('.sam-filter-button[aria-pressed="true"]');
    (focusTarget || rootElement())?.focus({ preventScroll: true });
}

function deleteEditedAccount() {
    const id = asString($('#sam-account-id')?.value);
    const account = settings.accounts.find(item => item.id === id);
    if (account) deleteAccount(account);
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

async function applyToSillyTavern(account, options = {}) {
    if (isApplyingAccount) return false;
    const apiKey = asString(account.apiKey).trim();
    if (!apiKey) {
        notify('请先填写并保存有效的 API Key。', 'error');
        return false;
    }
    const main = document.querySelector('#main_api');
    const source = document.querySelector('#chat_completion_source');
    const modelSelect = document.querySelector('#model_custom_select');
    const connect = document.querySelector('#api_button_openai');
    const controls = ['#custom_api_url_text', '#api_key_custom', '#custom_model_id'];
    if (!main || !source || !modelSelect || !connect || controls.some(selector => !document.querySelector(selector))
        || ![...main.options].some(option => option.value === 'openai')
        || ![...source.options].some(option => option.value === 'custom')) {
        notify('当前酒馆缺少自定义聊天补全控件，请检查酒馆版本。', 'error');
        return false;
    }
    isApplyingAccount = true;
    renderAccounts();
    const jq = globalThis.jQuery;
    let connectionStarted = false;
    let connectionResult;
    let applied = false;
    const trackConnection = event => {
        connectionStarted = true;
        if (event.result?.then) connectionResult = event.result;
    };
    try {
        let baseUrl = savedApiEndpoint(account);
        if (!baseUrl) {
            setStatus('正在识别 API 地址…');
            const snapshot = { ...account };
            const result = await resolveAccountEndpoint(snapshot);
            const current = settings.accounts.find(item => item.id === snapshot.id
                && item.baseUrl === snapshot.baseUrl && item.apiKey === snapshot.apiKey);
            if (!current) return false;
            baseUrl = result.baseUrl;
            current.baseUrl = displayApiUrl(baseUrl);
            current.resolvedBaseUrl = baseUrl;
            current.models = result.models;
            current.selectedModel = current.selectedModel || result.models[0] || '';
            account = current;
            persist();
        }
        if (jq) jq(connect).on('click.samAccountApply', trackConnection);
        else connect.addEventListener('click', trackConnection);
        // Source changes can reconnect and restore the old model selection.
        // Fill all controls, including the native model selector, beforehand.
        const mainChanged = main.value !== 'openai';
        const sourceChanged = source.value !== 'custom';
        const model = account.selectedModel || '';
        if (model && ![...modelSelect.options].some(option => option.value === model)) {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model;
            modelSelect.append(option);
        }
        modelSelect.value = model;
        main.value = 'openai';
        source.value = 'custom';
        setConnectionValue(['#custom_api_url_text'], baseUrl);
        setConnectionValue(['#api_key_custom'], apiKey);
        setConnectionValue(['#custom_model_id'], model);
        applied = markSelectedAccount(account, { restartPolling: options.restartPolling !== false });
        if (!applied) {
            notify('账户已被删除，未更新当前账户标识。', 'error');
            return false;
        }
        notify('已应用，正在连接…');
        if (sourceChanged) source.dispatchEvent(new Event('change', { bubbles: true }));
        if (mainChanged) main.dispatchEvent(new Event('change', { bubbles: true }));
        // SillyTavern already connects when its source changes. Reuse that
        // click; otherwise trigger its handler, which saves the key first.
        if (!connectionStarted) {
            if (jq) connectionResult = jq(connect).triggerHandler('click');
            else connect.click();
        }
        if (connectionResult?.then) await connectionResult;
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    } catch (error) {
        notify(error?.message || '连接未能启动，请检查酒馆连接状态。', 'error');
    } finally {
        if (jq) jq(connect).off('click.samAccountApply', trackConnection);
        else connect.removeEventListener('click', trackConnection);
        isApplyingAccount = false;
        renderAccounts();
    }
    return applied;
}

async function handleAccountAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const account = settings.accounts.find(item => item.id === button.dataset.accountId);
    if (!account) return;
    switch (button.dataset.action) {
        case 'edit': editAccount(account); break;
        case 'delete': deleteAccount(account); break;
        case 'favorite':
            account.favorite = !account.favorite;
            account.updatedAt = Date.now();
            persist();
            renderAccounts();
            restartPollingTimer();
            ($$('.sam-favorite-button').find(item => item.dataset.accountId === account.id)
                || $('.sam-filter-button[aria-pressed="true"]')
                || rootElement())?.focus({ preventScroll: true });
            break;
        case 'balance': await refreshBalance(account); break;
        case 'apply':
            await applyToSillyTavern(account);
            {
                const card = $$('.sam-account-item').find(item => item.dataset.accountId === account.id);
                if (card) $('button[data-action="apply"]', card)?.focus({ preventScroll: true });
            }
            break;
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

async function pollNextAccount() {
    pollingTimer = null;
    if (!settings.pollingEnabled) return;
    if (document.visibilityState === 'hidden' || isApplyingAccount) {
        restartPollingTimer();
        return;
    }
    const next = nextPollingAccount();
    if (!next) {
        settings.pollingEnabled = false;
        settings.pollingFilter = null;
        settings.pollingCursorId = '';
        persist();
        updatePollingUi();
        return;
    }
    settings.pollingCursorId = next.id;
    persist();
    try {
        await applyToSillyTavern(next, { restartPolling: false });
    } finally {
        restartPollingTimer();
    }
}

function restartPollingTimer() {
    if (pollingTimer) clearTimeout(pollingTimer);
    pollingTimer = null;
    const filter = currentPollingFilter();
    const accounts = pollingAccounts(filter);
    let changed = false;
    if (settings.pollingEnabled && (!filter || accounts.length < 2)) {
        settings.pollingEnabled = false;
        settings.pollingFilter = null;
        settings.pollingCursorId = '';
        changed = true;
    } else if (settings.pollingEnabled && settings.pollingCursorId
        && !accounts.some(account => account.id === settings.pollingCursorId)) {
        settings.pollingCursorId = '';
        changed = true;
    }
    if (changed) persist();
    updatePollingUi();
    if (!settings.pollingEnabled) return;
    pollingTimer = setTimeout(pollNextAccount, settings.pollingInterval * 60 * 1000);
}

function togglePolling() {
    if (settings.pollingEnabled) {
        settings.pollingEnabled = false;
        settings.pollingFilter = null;
        settings.pollingCursorId = '';
        persist();
        restartPollingTimer();
        notify('已停止轮询。');
        return;
    }
    const filter = currentPollingFilter();
    const accounts = pollingAccounts(filter);
    if (!filter) return notify('请先选择收藏、具体分组，或应用一个账户。', 'error');
    if (accounts.length < 2) return notify('当前轮询范围至少需要两个账户。', 'error');
    settings.pollingEnabled = true;
    settings.pollingFilter = filter;
    settings.pollingCursorId = accounts.some(account => account.id === settings.selectedAccountId)
        ? settings.selectedAccountId : '';
    persist();
    restartPollingTimer();
    notify(`已开启“${pollingFilterLabel(filter)}”轮询，每 ${settings.pollingInterval} 分钟切换一次。`, 'success');
}

function bindEvents() {
    const form = $('#sam-account-form');
    form?.addEventListener('submit', saveAccountFromForm);
    $('#sam-cancel-edit')?.addEventListener('click', clearForm);
    $('#sam-delete-account')?.addEventListener('click', deleteEditedAccount);
    $('#sam-fetch-models')?.addEventListener('click', fetchModelsForDraft);
    for (const selector of ['#sam-base-url', '#sam-api-key']) {
        $(selector)?.addEventListener('input', invalidateDraftConnection);
    }
    $('#sam-base-url')?.addEventListener('blur', event => {
        event.target.value = displayApiUrl(event.target.value);
    });
    $('#sam-fetch-balance')?.addEventListener('click', async () => {
        const id = asString($('#sam-account-id')?.value);
        const account = settings.accounts.find(item => item.id === id);
        if (!account) {
            notify('请先保存账户，再查询余额。', 'error');
            return;
        }
        const draft = readForm();
        const clearSelected = account.id === settings.selectedAccountId
            && !sameAppliedConnection(account, draft);
        Object.assign(account, {
            provider: draft.provider,
            baseUrl: draft.baseUrl,
            resolvedBaseUrl: draft.resolvedBaseUrl,
            apiKey: draft.apiKey,
            models: draft.models,
            selectedModel: draft.selectedModel,
            balanceUrl: draft.balanceUrl,
            balancePath: draft.balancePath,
            balanceCurrency: draft.balanceCurrency,
            balanceParser: draft.balanceParser,
        });
        if (clearSelected) {
            settings.selectedAccountId = '';
            persist();
            renderAccounts();
        }
        await refreshBalance(account);
        updateFormBalance();
    });
    $('#sam-refresh-all')?.addEventListener('click', () => refreshAllBalances());
    $('#sam-toggle-polling')?.addEventListener('click', togglePolling);
    $('#sam-account-list')?.addEventListener('click', handleAccountAction);
    $('#sam-account-filters')?.addEventListener('click', event => {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        settings.accountFilter = normalizeAccountFilter({ type: button.dataset.filter }, settings.accounts);
        persist();
        renderAccounts();
    });
    $('#sam-group-filter')?.addEventListener('change', event => {
        const group = groupFromOptionValue(event.target.value);
        settings.accountFilter = group === undefined
            ? { type: 'all' }
            : normalizeAccountFilter({ type: 'group', group }, settings.accounts);
        persist();
        renderAccounts();
    });
    $('#sam-group-select')?.addEventListener('change', event => {
        const group = groupFromOptionValue(event.target.value);
        const input = $('#sam-group');
        if (input && group !== undefined) input.value = group;
    });
    $('#sam-group')?.addEventListener('input', event => {
        const picker = $('#sam-group-select');
        if (!picker) return;
        const group = asString(event.target.value).trim();
        picker.value = settings.accounts.some(account => account.group === group)
            ? groupOptionValue(group) : '';
    });
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
    $('#sam-polling-interval')?.addEventListener('change', event => {
        settings.pollingInterval = clampInteger(event.target.value, 1, 1440, DEFAULT_SETTINGS.pollingInterval);
        event.target.value = settings.pollingInterval;
        persist();
        restartPollingTimer();
    });
    $('#sam-key-toggle')?.addEventListener('click', event => {
        const input = $('#sam-api-key');
        if (!input) return;
        const visible = input.type === 'text';
        setKeyVisibility(!visible);
    });
}

function loadSettingsIntoUi() {
    const auto = $('#sam-auto-refresh');
    const interval = $('#sam-refresh-interval');
    const pollingInterval = $('#sam-polling-interval');
    if (auto) auto.checked = settings.autoRefresh;
    if (interval) interval.value = settings.refreshInterval;
    if (pollingInterval) pollingInterval.value = settings.pollingInterval;
    renderAccounts();
    restartPollingTimer();
}

async function loadPanel() {
    const host = document.querySelector('#openai_api');
    const modelSelect = host?.querySelector('#model_custom_select');
    const modelForm = modelSelect?.closest('form');
    if (!modelForm || modelForm.id !== 'custom_form' || modelForm.parentElement !== host) return false;
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
        // Available Models is the last field of the native custom form.
        // Insert outside it so the account form is never nested in another form.
        modelForm.after(panel);
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
    bindEvents();
    loadSettingsIntoUi();
    restartRefreshTimer();
}

// SillyTavern loads third-party extension entry points as modules.  jQuery is
// already available globally, but DOMContentLoaded is still useful when the
// extension is imported before the settings panel has been mounted.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
