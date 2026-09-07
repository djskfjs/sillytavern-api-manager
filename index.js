/**
 * SillyTavern API Account Manager
 *
 * A dependency-free account/profile manager for OpenAI-compatible APIs.
 * The extension is intentionally written as a regular ES module so it can be
 * installed directly from a GitHub repository in SillyTavern 1.14.x.
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { identifyProvider, queryBalance, requestApiJson as requestJson } from './balance.js?v=1.2.0';

const EXTENSION_NAME = 'sillytavern-api-manager';
const EXTENSION_VERSION = '1.2.0';
const SETTINGS_ROOT_ID = 'st-api-account-manager';
const SETTINGS_VERSION = 1;

const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    accounts: [],
    selectedAccountId: '',
    expandedGroups: [],
    autoRefresh: true,
    refreshInterval: 30,
});

let settings;
let refreshTimer = null;
let formModels = [];
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
        kind: ['balance', 'available', 'token', 'quota'].includes(balance.kind) ? balance.kind : 'balance',
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

function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const accounts = Array.isArray(source.accounts) ? source.accounts.map(normalizeAccount) : [];
    // Requests do not survive a page reload, even if another save persisted
    // their temporary loading state.
    for (const account of accounts) {
        if (account.balance.status === 'loading') account.balance.status = 'unknown';
    }
    const selected = asString(source.selectedAccountId);
    return {
        ...DEFAULT_SETTINGS,
        ...source,
        version: SETTINGS_VERSION,
        accounts,
        selectedAccountId: accounts.some(account => account.id === selected) ? selected : '',
        expandedGroups: Array.isArray(source.expandedGroups)
            ? [...new Set(source.expandedGroups.filter(group => typeof group === 'string'))] : [],
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

function readForm() {
    const accountId = asString($('#sam-account-id')?.value).trim();
    const existing = settings.accounts.find(account => account.id === accountId);
    const enteredKey = asString($('#sam-api-key')?.value).trim();
    const apiKey = enteredKey || existing?.apiKey || '';
    const baseUrl = normalizeUrl($('#sam-base-url')?.value);
    // Keep saved balance support when only the account name or group changes.
    const sameService = existing && normalizeUrl(existing.baseUrl) === baseUrl;
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
        provider: identifyProvider(baseUrl),
        baseUrl,
        apiKey,
        models,
        selectedModel,
        balanceUrl: sameService ? existing.balanceUrl : '',
        balancePath: sameService ? existing.balancePath : '',
        balanceCurrency: sameService ? existing.balanceCurrency : '',
        balanceParser: sameService ? existing.balanceParser : 'generic',
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

async function fetchModelsForDraft() {
    if (isLoadingModels) return;
    const baseUrl = normalizeUrl($('#sam-base-url')?.value);
    const apiKey = asString($('#sam-api-key')?.value).trim() || settings.accounts.find(account => account.id === $('#sam-account-id')?.value)?.apiKey || '';
    if (!baseUrl || !isHttpUrl(baseUrl)) {
        notify('请先填写有效的 API 基础地址。', 'error');
        return;
    }
    const url = joinUrl(baseUrl, '/models');
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
            const result = await queryBalance(snapshot);
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
                renderAccounts();
            }
        }
    });
    activeBalanceQueries.set(snapshot.id, query);
    account.balance = { ...normalizeBalance(account.balance), status: 'loading', message: '' };
    renderAccounts();
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
        renderAccounts();
    }
}

function formatBalance(balance) {
    if (!balance) return '余额：未查询';
    const label = balance.kind === 'available' ? '可用额度' : ['token', 'quota'].includes(balance.kind) ? '密钥额度' : '余额';
    if (balance.status === 'loading') return `${label}：查询中…`;
    if (balance.status === 'unsupported') return `余额：${balance.message || '服务商暂未开放查询接口'}`;
    if (balance.status === 'error') return `余额：查询失败（${balance.message || '未知错误'}）`;
    if (balance.status !== 'ok' || balance.value == null) return '余额：未查询';
    const value = typeof balance.value === 'number' ? balance.value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : String(balance.value);
    return `${label}：${value}${balance.currency ? ` ${balance.currency}` : ''}${balance.message ? `（${balance.message}）` : ''}`;
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
    main.append(titleWrap);
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
        ['apply', '应用', '应用并连接此 API'],
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
        if (action === 'apply') button.disabled = isApplyingAccount;
        actions.append(button);
    }
    item.append(actions);
    return item;
}

function renderGroupSuggestions() {
    const groups = [...new Set(settings.accounts.map(account => account.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
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
    renderGroupSuggestions();
    updateFormBalance();
    if ($('#sam-account-count')) $('#sam-account-count').textContent = `已保存 ${settings.accounts.length} 个`;
    const list = $('#sam-account-list');
    if (!list) return;
    const openStates = new Map($$('.sam-group-section', list).map(section => [section.dataset.group, section.open]));
    const currentGroups = new Set(settings.accounts.map(account => account.group));
    const expandedGroups = settings.expandedGroups.filter(group => currentGroups.has(group)
        && (!openStates.has(group) || openStates.get(group)));
    for (const [group, open] of openStates) {
        if (open && currentGroups.has(group) && !expandedGroups.includes(group)) expandedGroups.push(group);
    }
    if (expandedGroups.length !== settings.expandedGroups.length
        || expandedGroups.some(group => !settings.expandedGroups.includes(group))) {
        settings.expandedGroups = expandedGroups;
        persist();
    }
    const accounts = [...settings.accounts]
        .sort((a, b) => (a.group || '未分组').localeCompare(b.group || '未分组') || a.name.localeCompare(b.name));
    list.replaceChildren();
    if (!accounts.length) {
        const empty = document.createElement('div');
        empty.className = 'sam-empty';
        empty.textContent = '还没有保存的 API，在下方填写信息即可添加。';
        list.append(empty);
        return;
    }
    const groups = new Map();
    for (const account of accounts) {
        if (!groups.has(account.group)) groups.set(account.group, []);
        groups.get(account.group).push(account);
    }
    for (const [group, members] of groups) {
        const section = document.createElement('details');
        section.className = 'sam-group-section';
        section.dataset.group = group;
        section.open = openStates.has(group) ? openStates.get(group) : settings.expandedGroups.includes(group);
        const summary = document.createElement('summary');
        summary.className = 'sam-group-header';
        const title = document.createElement('span');
        title.className = 'sam-group-title';
        title.textContent = group || '未分组';
        const count = document.createElement('span');
        count.className = 'sam-group-count';
        count.textContent = `${members.length} 个 API`;
        summary.append(title, count);
        const body = document.createElement('div');
        body.className = 'sam-group-accounts';
        body.setAttribute('role', 'list');
        body.setAttribute('aria-label', `${group || '未分组'}的 API`);
        body.append(...members.map(createAccountCard));
        section.append(summary, body);
        section.addEventListener('toggle', () => {
            if (!section.isConnected) return;
            const savedOpen = settings.expandedGroups.includes(group);
            if (savedOpen === section.open) return;
            settings.expandedGroups = settings.expandedGroups.filter(name => name !== group);
            if (section.open) settings.expandedGroups.push(group);
            persist();
        });
        list.append(section);
    }
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

async function applyToSillyTavern(account) {
    if (isApplyingAccount) return;
    const apiKey = asString(account.apiKey).trim();
    if (!apiKey) return notify('请先填写并保存有效的 API Key。', 'error');
    const main = document.querySelector('#main_api');
    const source = document.querySelector('#chat_completion_source');
    const modelSelect = document.querySelector('#model_custom_select');
    const connect = document.querySelector('#api_button_openai');
    const controls = ['#custom_api_url_text', '#api_key_custom', '#custom_model_id'];
    if (!main || !source || !modelSelect || !connect || controls.some(selector => !document.querySelector(selector))
        || ![...main.options].some(option => option.value === 'openai')
        || ![...source.options].some(option => option.value === 'custom')) {
        notify('当前酒馆缺少自定义聊天补全控件，请检查酒馆版本。', 'error');
        return;
    }
    isApplyingAccount = true;
    renderAccounts();
    const jq = globalThis.jQuery;
    let connectionStarted = false;
    let connectionResult;
    const trackConnection = event => {
        connectionStarted = true;
        if (event.result?.then) connectionResult = event.result;
    };
    if (jq) jq(connect).on('click.samAccountApply', trackConnection);
    else connect.addEventListener('click', trackConnection);
    try {
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
        setConnectionValue(['#custom_api_url_text'], account.baseUrl);
        setConnectionValue(['#api_key_custom'], apiKey);
        setConnectionValue(['#custom_model_id'], model);
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
        case 'apply': await applyToSillyTavern(account); break;
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
