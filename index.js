/**
 * SillyTavern API Account Manager
 *
 * A dependency-free account/profile manager for OpenAI-compatible APIs.
 * The extension is intentionally written as a regular ES module so it can be
 * installed directly from a GitHub repository in SillyTavern 1.14.x.
 */

import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { identifyProvider, queryBalance, requestApiJson as requestJson } from './balance.js?v=1.8.17';
import { displayApiUrl, requestApiJsonViaSillyTavern, resolveApiEndpoint, requestNativeModels } from './api-routing.js?v=1.8.17';
import { createGenerationFetch } from './generation-monitor.js?v=1.8.17';

const EXTENSION_NAME = 'sillytavern-api-manager';
const EXTENSION_VERSION = '1.8.17';
const SETTINGS_ROOT_ID = 'st-api-account-manager';
const SETTINGS_VERSION = 3;
const TRANSFER_FORMAT = 'sillytavern-api-account-manager';
const TRANSFER_VERSION = 3;

const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    accounts: [],
    selectedAccountId: '',
    accountFilter: { type: 'all' },
    accountSort: 'name',
    autoRefresh: true,
    refreshInterval: 30,
    pollingEnabled: false,
    pollingFilter: null,
    quickSwitchPosition: null,
});

let settings;
let refreshTimer = null;
let failoverRevision = 0;
let generationActive = false;
let pendingFailover = null;
let pendingFailoverTimer = null;
let failoverInstalled = false;
let isFailingOver = false;
let formModels = [];
let formResolvedConnection = null;
let formConnectionRevision = 0;
let isLoadingModels = false;
let isLoadingBalance = false;
let isApplyingAccount = false;
let applyingAccountId = '';
let quickSwitchDrag = null;
let quickSwitchSuppressClick = false;
const activeBalanceQueries = new Map();
const activeModelQueries = new Map();
const modelChoicesVisibleForAccounts = new Set();
const modelDrafts = new Map();
const accountNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

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
    const finiteValue = typeof balance.value === 'number' && Number.isFinite(balance.value);
    const validAccountBalance = (balance.kind == null || balance.kind === 'balance')
        && balance.scope === 'account' && finiteValue;
    if (balance.status === 'ok' && !validAccountBalance) return empty;
    return {
        status: ['ok', 'loading', 'error', 'unsupported', 'unknown'].includes(balance.status) ? balance.status : 'unknown',
        value: validAccountBalance ? balance.value : null,
        currency: validAccountBalance ? asString(balance.currency) : '',
        kind: 'balance',
        scope: validAccountBalance ? 'account' : '',
        message: asString(balance.message),
        fetchedAt: Number.isFinite(Number(balance.fetchedAt)) ? Number(balance.fetchedAt) : 0,
    };
}

function savedApiEndpoint(account) {
    const resolved = normalizeUrl(account?.resolvedBaseUrl);
    return isHttpUrl(resolved) && displayApiUrl(resolved) === displayApiUrl(account?.baseUrl) ? resolved : '';
}

function sameBalanceConnection(left, right) {
    return Boolean(left && right)
        && displayApiUrl(left.baseUrl) === displayApiUrl(right.baseUrl)
        && asString(left.apiKey) === asString(right.apiKey)
        && (left.balanceMode || 'auto') === (right.balanceMode || 'auto')
        && (left.balanceMode !== 'account'
            || (asString(left.balanceAccessToken) === asString(right.balanceAccessToken)
                && asString(left.balanceUserId) === asString(right.balanceUserId)));
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
        pollingDisabled: source.pollingDisabled === true,
        provider: asString(source.provider),
        baseUrl,
        resolvedBaseUrl: savedApiEndpoint({ baseUrl, resolvedBaseUrl: source.resolvedBaseUrl }),
        apiKey: asString(source.apiKey).trim(),
        models: uniqueModels,
        selectedModel,
        balanceMode: source.balanceMode === 'account' ? 'account' : 'auto',
        balanceAccessToken: asString(source.balanceAccessToken).trim(),
        balanceUserId: asString(source.balanceUserId).trim(),
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

function normalizeQuickSwitchPosition(value) {
    const x = Number(value?.x);
    const y = Number(value?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
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
    const selectedAccountId = Number(source.version) >= SETTINGS_VERSION
        && selectedEntry ? selectedEntry.id : '';
    // Timed rotation and its independent cursor are obsolete. Always start
    // failover from the API that actually handled the failed generation.
    const { expandedGroups, pollingCursorId, pollingInterval, quickSwitchVisible, ...retained } = source;
    return {
        ...DEFAULT_SETTINGS,
        ...retained,
        version: SETTINGS_VERSION,
        accounts,
        selectedAccountId,
        accountFilter: normalizeAccountFilter(source.accountFilter, accounts),
        accountSort: source.accountSort === 'added' ? 'added' : 'name',
        autoRefresh: source.autoRefresh !== false,
        refreshInterval: clampInteger(source.refreshInterval, 1, 1440, DEFAULT_SETTINGS.refreshInterval),
        pollingEnabled: pollingEnabled && Boolean(pollingFilter),
        pollingFilter,
        quickSwitchPosition: normalizeQuickSwitchPosition(source.quickSwitchPosition),
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

function updateBalanceSettingsUi() {
    const accountMode = $('#sam-balance-mode')?.value === 'account';
    const help = $('#sam-balance-mode-help');
    if (help) help.textContent = accountMode
        ? '填写网站账户访问令牌和用户 ID 后，保存时自动查询余额。'
        : '根据 API 地址识别账户余额接口，使用已保存的 API Key 查询。';
    const fields = $('#sam-balance-account-fields');
    if (fields) fields.hidden = !accountMode;
    for (const selector of ['#sam-balance-access-token', '#sam-balance-user-id', '#sam-clear-balance-token']) {
        const input = $(selector);
        if (input) input.disabled = !accountMode;
    }
    const existing = settings?.accounts.find(account => account.id === $('#sam-account-id')?.value);
    const clearRow = $('#sam-balance-clear-row');
    if (clearRow) clearRow.hidden = !existing?.balanceAccessToken;
    const token = $('#sam-balance-access-token');
    if (token) token.placeholder = existing?.balanceAccessToken ? '留空以保留账户访问令牌' : '在网站个人设置中获取';
}

function persist() {
    extension_settings[EXTENSION_NAME] = settings;
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
}

function exportableAccount(account) {
    return {
        name: account.name,
        baseUrl: account.baseUrl,
        apiKey: account.apiKey,
        models: [...new Set([...(account.models || []), account.selectedModel].filter(Boolean))],
        selectedModel: account.selectedModel,
    };
}

function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportAccounts() {
    const filter = settings.accountFilter;
    const accounts = filter?.type === 'group'
        ? settings.accounts.filter(account => account.group === filter.group)
        : filter?.type === 'favorites'
            ? settings.accounts.filter(account => account.favorite === true)
            : settings.accounts;
    if (!accounts.length) {
        notify('当前没有可导出的 API。', 'warning');
        return;
    }
    const payload = {
        format: TRANSFER_FORMAT,
        version: TRANSFER_VERSION,
        exportedAt: new Date().toISOString(),
        accounts: accounts.map(exportableAccount),
    };
    const scope = filter?.type === 'group' ? `分组“${filter.group || '未分组'}”` : filter?.type === 'favorites' ? '收藏' : '全部';
    const scopeName = (filter?.type === 'group' ? (filter.group || '未分组') : filter?.type === 'favorites' ? '收藏' : '全部')
        .replace(/[\\/:*?"<>|]/g, '_');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    downloadJson(`sillytavern-api-manager-${scopeName}-${stamp}.json`, payload);
    notify(`已导出${scope}中的 ${payload.accounts.length} 个 API。文件包含密钥，请勿公开分享。`, 'success');
}

function importedKeyValue(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    return asString(value.apiKey ?? value.key ?? value.value ?? value.secret ?? value.token).trim();
}

function importedModels(source) {
    const values = Array.isArray(source?.models) ? source.models
        : Array.isArray(source?.modelList) ? source.modelList
            : source?.model ? [source.model] : [];
    return [...new Set(values.map(item => typeof item === 'object' ? item.id : item)
        .map(item => asString(item).trim()).filter(Boolean))];
}

function importedAccount(source, keyEntry, fallbackName = '未命名账户') {
    const raw = source && typeof source === 'object' ? source : {};
    const key = importedKeyValue(keyEntry) || importedKeyValue(raw);
    const models = importedModels(raw);
    const baseUrl = normalizeUrl(raw.baseUrl ?? raw.url ?? raw.endpoint ?? raw.apiUrl ?? raw.customUrl);
    const name = asString(raw.name ?? raw.siteName ?? raw.title ?? raw.provider ?? fallbackName).trim();
    if (!name || !baseUrl || !key || !isHttpUrl(baseUrl)) return null;
    const selectedModel = asString(raw.selectedModel ?? raw.defaultModel ?? raw.model).trim()
        || models[0] || '';
    const imported = normalizeAccount({
        name,
        // Imported data from any manager is placed in the virtual “全部” view.
        // Keep the real group empty so it cannot create or reuse a source group.
        group: '',
        baseUrl,
        apiKey: key,
        models,
        selectedModel,
        balanceMode: raw.balanceMode,
        balanceAccessToken: raw.balanceAccessToken,
        balanceUserId: raw.balanceUserId,
        balanceUrl: raw.balanceUrl,
        balancePath: raw.balancePath,
        balanceCurrency: raw.balanceCurrency,
        balanceParser: raw.balanceParser,
    });
    imported.createdAt = Date.now();
    imported.updatedAt = imported.createdAt;
    return imported;
}

function importedKeyEntries(source) {
    if (Array.isArray(source?.keys) && source.keys.length) return source.keys;
    if (Array.isArray(source?.apiKeys) && source.apiKeys.length) return source.apiKeys;
    const key = importedKeyValue(source);
    return key ? [key] : [];
}

function parseImportedAccounts(data) {
    if (!data || typeof data !== 'object') return [];
    const result = [];
    const addSource = (source, fallbackName) => {
        const keys = importedKeyEntries(source);
        for (const [index, entry] of keys.entries()) {
            const label = typeof entry === 'object' ? asString(entry.label ?? entry.name).trim() : '';
            const suffix = keys.length > 1 && label ? ` · ${label}` : '';
            const account = importedAccount(source, entry, `${fallbackName || '未命名账户'}${suffix}`);
            if (account) result.push(account);
        }
    };

    if (Array.isArray(data.accounts)) {
        data.accounts.forEach((account, index) => addSource(account, `账户 ${index + 1}`));
    } else if (Array.isArray(data.apis)) {
        data.apis.forEach((api, index) => addSource(api, `API ${index + 1}`));
    } else if (Array.isArray(data.profiles)) {
        data.profiles.forEach((profile, index) => addSource(profile, `配置 ${index + 1}`));
    } else if (Array.isArray(data)) {
        data.forEach((entry, index) => addSource(entry, `API ${index + 1}`));
    } else if (data.url || data.baseUrl || data.endpoint) {
        addSource(data, 'API 1');
    }
    return result;
}

function accountIdentity(account) {
    return `${account.name}\u0000${displayApiUrl(account.baseUrl)}\u0000${account.apiKey}`;
}

async function importAccountsFromFile(file) {
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        const imported = parseImportedAccounts(data);
        if (!imported.length) {
            notify('文件中没有识别到包含地址和 Key 的 API。', 'warning');
            return;
        }
        const importedAccounts = [...new Map(imported.map(account => [accountIdentity(account), account])).values()];
        const existing = new Map(settings.accounts.map(account =>
            [accountIdentity(account), account]));
        const conflicts = importedAccounts
            .map(account => ({ account, previous: existing.get(accountIdentity(account)) }))
            .filter(item => item.previous);
        const overwriteConflicts = conflicts.length === 0 || typeof globalThis.confirm !== 'function'
            || globalThis.confirm(`发现 ${conflicts.length} 个重复 API，是否全部覆盖？\n\n确定：全部覆盖\n取消：全部跳过`);
        let added = 0;
        let overwritten = 0;
        let skipped = 0;
        for (const account of importedAccounts) {
            const identity = accountIdentity(account);
            const previous = existing.get(identity);
            if (previous) {
                if (!overwriteConflicts) {
                    skipped++;
                    continue;
                }
                const preserved = {
                    id: previous.id,
                    favorite: previous.favorite,
                    pollingDisabled: previous.pollingDisabled,
                    createdAt: previous.createdAt,
                };
                Object.assign(previous, account, preserved, { updatedAt: Date.now() });
                overwritten++;
            } else {
                settings.accounts.push(account);
                existing.set(identity, account);
                added++;
            }
        }
        settings.accountFilter = { type: 'all' };
        persist();
        clearForm();
        renderAccounts();
        restartRefreshTimer();
        notify(`已导入 ${added} 个，覆盖 ${overwritten} 个，跳过 ${skipped} 个 API。`, 'success');
    } catch (error) {
        notify(`导入失败：${error?.message || '文件不是有效 JSON'}`, 'error');
    }
}

function rootElement() {
    return document.getElementById(SETTINGS_ROOT_ID);
}

function notify(message, kind = 'info', options = {}) {
    const toaster = globalThis.toastr;
    if (toaster && typeof toaster[kind] === 'function') {
        toaster[kind](message, 'API 账户管理', {
            escapeHtml: true, closeButton: true, tapToDismiss: true,
            timeOut: 5000, extendedTimeOut: 1500, ...options,
        });
    }
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
    const balanceMode = ($('#sam-balance-mode')?.value ?? existing?.balanceMode ?? 'account') === 'account' ? 'account' : 'auto';
    const enteredBalanceToken = asString($('#sam-balance-access-token')?.value).trim();
    const balanceAccessToken = $('#sam-clear-balance-token')?.checked ? ''
        : enteredBalanceToken || (sameService ? existing.balanceAccessToken : '') || '';
    const balanceUserId = asString($('#sam-balance-user-id')?.value
        ?? (sameService ? existing.balanceUserId : '')).trim();
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
        pollingDisabled: existing?.pollingDisabled === true,
        provider: identifyProvider(baseUrl),
        baseUrl,
        resolvedBaseUrl,
        apiKey,
        models,
        selectedModel,
        balanceMode,
        balanceAccessToken,
        balanceUserId,
        balanceUrl: sameService ? existing.balanceUrl : '',
        balancePath: sameService ? existing.balancePath : '',
        balanceCurrency: sameService ? existing.balanceCurrency : '',
        balanceParser: sameService ? existing.balanceParser : 'generic',
        balance: sameBalanceConnection(existing, { baseUrl, apiKey, balanceMode, balanceAccessToken, balanceUserId })
            ? existing.balance : normalizeBalance(null),
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
    };
}

function findScrollContainer(element) {
    let ancestor = element?.parentElement;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const style = globalThis.getComputedStyle?.(ancestor);
        const canScroll = style && /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`);
        if (canScroll && ancestor.scrollHeight > ancestor.clientHeight) return ancestor;
        ancestor = ancestor.parentElement;
    }
    return null;
}

function capturePageScroll(element) {
    const container = findScrollContainer(element);
    if (container) return { container, left: container.scrollLeft, top: container.scrollTop };
    return {
        container: null,
        left: Number(globalThis.scrollX ?? document.scrollingElement?.scrollLeft ?? 0),
        top: Number(globalThis.scrollY ?? document.scrollingElement?.scrollTop ?? 0),
    };
}

function restorePageScroll(state) {
    if (!state) return;
    if (state.container) {
        state.container.scrollLeft = state.left;
        state.container.scrollTop = state.top;
        return;
    }
    const scroller = document.scrollingElement;
    if (scroller) {
        scroller.scrollLeft = state.left;
        scroller.scrollTop = state.top;
    } else {
        globalThis.scrollTo?.(state.left, state.top);
    }
}

function setActiveView(view, { focus = false } = {}) {
    const activeView = view === 'editor' ? 'editor' : 'accounts';
    const root = rootElement();
    const previousView = $('#sam-tab-editor')?.getAttribute('aria-selected') === 'true' ? 'editor' : 'accounts';
    const scrollState = previousView === activeView ? null : capturePageScroll(root);
    for (const [name, tabId, panelId] of [
        ['accounts', '#sam-tab-accounts', '#sam-view-accounts'],
        ['editor', '#sam-tab-editor', '#sam-view-editor'],
    ]) {
        const active = name === activeView;
        const tab = $(tabId);
        const panel = $(panelId);
        if (tab) {
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
        }
        if (panel) panel.hidden = !active;
    }
    if (focus) (activeView === 'editor' ? $('#sam-name') : $('#sam-tab-accounts'))?.focus({ preventScroll: true });
    if (scrollState) {
        const restore = () => {
            restorePageScroll(scrollState);
            updateScrollTopButton();
        };
        restore();
        globalThis.requestAnimationFrame?.(() => globalThis.requestAnimationFrame?.(restore));
    }
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
    if ($('#sam-editor-tab-label')) $('#sam-editor-tab-label').textContent = '添加 API';
    if ($('#sam-api-key')) {
        $('#sam-api-key').required = true;
        $('#sam-api-key').placeholder = 'sk-…';
    }
    setKeyVisibility(false);
    updateBalanceSettingsUi();
    updateFormBalance();
    setActiveView('accounts');
    $('#sam-tab-accounts')?.focus({ preventScroll: true });
}

function fillForm(account) {
    if (!account) return;
    formConnectionRevision++;
    formResolvedConnection = null;
    const values = {
        '#sam-account-id': account.id,
        '#sam-name': account.name,
        '#sam-base-url': displayApiUrl(account.baseUrl),
        '#sam-api-key': '',
        '#sam-balance-mode': account.balanceMode || 'auto',
        '#sam-balance-access-token': '',
        '#sam-balance-user-id': account.balanceUserId || '',
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
    setButtonContent($('#sam-save-account'), 'fa-solid fa-floppy-disk', '保存修改');
    if ($('#sam-form-title')) $('#sam-form-title').textContent = '编辑 API';
    if ($('#sam-editor-tab-label')) $('#sam-editor-tab-label').textContent = '编辑 API';
    if ($('#sam-api-key')) {
        $('#sam-api-key').required = false;
        $('#sam-api-key').placeholder = account.apiKey ? '留空以保留当前 Key' : 'sk-…';
    }
    setKeyVisibility(false);
    if ($('#sam-clear-balance-token')) $('#sam-clear-balance-token').checked = false;
    updateBalanceSettingsUi();
    updateFormBalance();
    setActiveView('editor');
}

function populateModelSelect(models, selected = '') {
    const select = $('#sam-model-select');
    if (!select) return;
    // A refreshed model list may omit the active model. Opening the editor
    // must not silently change the connection that an unchanged save keeps.
    const availableModels = [...models];
    if (selected && !availableModels.includes(selected)) availableModels.unshift(selected);
    select.replaceChildren();
    if (!selected) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = availableModels.length ? '未选择模型' : '请先获取模型';
        select.append(option);
    }
    for (const model of availableModels) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        select.append(option);
    }
    select.value = selected;
}

function resolveAccountEndpoint(account) {
    return resolveApiEndpoint(account, {
        request: requestJson,
        nativeRequest: (baseUrl, apiKey) => requestNativeModels(baseUrl, apiKey, { getRequestHeaders }),
    });
}

async function requestBalanceJson(url, apiKey, options = {}) {
    try {
        return await requestJson(url, apiKey, { ...options, proxy: false });
    } catch (error) {
        if (!error?.network && ![502, 503, 504].includes(error?.status)) throw error;
        return requestApiJsonViaSillyTavern(url, apiKey, { ...options, getRequestHeaders });
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

function updateAccountModelsButton(button, account) {
    const query = activeModelQueries.get(account.id);
    const pending = Boolean(query && query.snapshot.baseUrl === account.baseUrl && query.snapshot.apiKey === account.apiKey);
    button.disabled = pending;
    button.setAttribute('aria-busy', String(pending));
    setButtonContent(button, pending ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-cloud-arrow-down',
        pending ? '获取中…' : '获取模型');
}

function updateAccountModelUi(account) {
    const card = $$('.sam-account-item').find(item => item.dataset.accountId === account.id);
    if (!card) return;
    updateAccountModelControl(card, account);
    const url = $('.sam-account-url', card);
    if (url) url.textContent = url.title = displayApiUrl(account.baseUrl);
    const button = $('button[data-action="models"]', card);
    if (button) updateAccountModelsButton(button, account);
}

function updateAccountModelControl(card, account) {
    const model = $('.sam-account-model', card);
    const select = $('.sam-account-model-select', card);
    const showChoices = modelChoicesVisibleForAccounts.has(account.id);
    if (model) {
        model.textContent = account.selectedModel || '未选择模型';
        model.title = account.selectedModel || '未选择模型';
        model.hidden = showChoices;
    }
    if (select) {
        populateAccountModelSelect(select, account, modelDrafts.get(account.id) ?? account.selectedModel);
        select.hidden = !showChoices;
    }
    const confirmButton = $('button[data-action="confirm-model"]', card);
    if (confirmButton) {
        confirmButton.hidden = !showChoices;
        confirmButton.disabled = !account.models.length
            || !asString(modelDrafts.get(account.id) ?? account.selectedModel).trim();
    }
}

function populateAccountModelSelect(select, account, selected = account?.selectedModel) {
    if (!select || !account) return;
    const models = [...new Set([...(account.models || []), account.selectedModel].filter(Boolean))];
    select.replaceChildren();
    if (!models.length || !selected) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = models.length ? '请选择模型' : '请先获取模型';
        select.append(option);
    }
    for (const model of models) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        select.append(option);
    }
    select.value = selected || '';
    select.disabled = !models.length;
    select.title = selected || '未选择模型';
    select.setAttribute('aria-label', `${account.name} 的默认模型`);
}

function selectAccountModel(account, model) {
    const current = settings.accounts.find(item => item.id === account.id);
    if (!current) return;
    const selectedModel = asString(model).trim();
    if (selectedModel && !current.models.includes(selectedModel)) current.models.push(selectedModel);
    if (current.selectedModel === selectedModel) return;
    current.selectedModel = selectedModel;
    current.updatedAt = Date.now();
    persist();

    // Keep the editor and SillyTavern's active custom connection in sync when
    // the model is changed from the account card.
    if ($('#sam-account-id')?.value === current.id) {
        const formSelect = $('#sam-model-select');
        if (formSelect) populateModelSelect(current.models, selectedModel);
    }
    if (current.id === settings.selectedAccountId) {
        invalidateFailover();
        const nativeSelect = document.querySelector('#model_custom_select');
        if (nativeSelect && selectedModel && ![...nativeSelect.options].some(option => option.value === selectedModel)) {
            const option = document.createElement('option');
            option.value = selectedModel;
            option.textContent = selectedModel;
            nativeSelect.append(option);
        }
        if (nativeSelect) {
            nativeSelect.value = selectedModel;
            nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setConnectionValue(['#custom_model_id'], selectedModel);
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    }
    updateAccountModelUi(current);
}

async function fetchModelsForAccount(account) {
    const snapshot = { ...account };
    const sameConnection = current => current && current.baseUrl === snapshot.baseUrl && current.apiKey === snapshot.apiKey;
    const active = activeModelQueries.get(snapshot.id);
    if (active && sameConnection(active.snapshot)) return active.promise;
    const query = { snapshot, promise: null };
    const currentAccount = () => activeModelQueries.get(snapshot.id) === query
        ? settings.accounts.find(current => current.id === snapshot.id && sameConnection(current))
        : undefined;
    query.promise = Promise.resolve().then(async () => {
        try {
            const result = await resolveAccountEndpoint(snapshot);
            const current = currentAccount();
            if (!current) return;
            const previous = { ...current };
            current.baseUrl = displayApiUrl(result.baseUrl);
            current.resolvedBaseUrl = result.baseUrl;
            current.models = [...new Set([current.selectedModel, ...result.models].filter(Boolean))];
            modelChoicesVisibleForAccounts.add(current.id);
            current.updatedAt = Date.now();
            if (current.id === settings.selectedAccountId && !sameAppliedConnection(previous, current)) {
                settings.selectedAccountId = '';
                invalidateFailover();
            }
            persist();
            // Refresh the matching draft's model choices without replacing typed fields.
            if ($('#sam-account-id')?.value === current.id) {
                const draft = readForm();
                if (draft.baseUrl === current.baseUrl && draft.apiKey === current.apiKey) {
                    formModels = [...new Set([draft.selectedModel, ...current.models].filter(Boolean))];
                    formResolvedConnection = { baseUrl: current.baseUrl, apiKey: current.apiKey, resolvedBaseUrl: result.baseUrl };
                    populateModelSelect(formModels, draft.selectedModel || current.selectedModel);
                }
            }
            updateAccountSelectionUi();
            updatePollingState();
            notify(`已获取“${current.name}”的 ${result.models.length} 个模型。`, 'success');
        } catch (error) {
            const current = currentAccount();
            if (current) notify(`${current.name}：${error?.message || '获取模型失败。'}`, 'error');
        } finally {
            if (activeModelQueries.get(snapshot.id) === query) {
                activeModelQueries.delete(snapshot.id);
                const current = settings.accounts.find(item => item.id === snapshot.id);
                if (current) updateAccountModelUi(current);
            }
        }
    });
    activeModelQueries.set(snapshot.id, query);
    updateAccountModelUi(account);
    return query.promise;
}

async function refreshBalance(account, options = {}) {
    const snapshot = { ...account };
    const active = activeBalanceQueries.get(snapshot.id);
    if (active && sameBalanceConnection(active.snapshot, snapshot)) {
        return active.promise;
    }
    const query = { snapshot, promise: null };
    const currentAccount = () => activeBalanceQueries.get(snapshot.id) === query
        ? settings.accounts.find(item => item.id === snapshot.id && sameBalanceConnection(item, snapshot))
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
    if (isLoadingBalance) return;
    if (!settings.accounts.length) {
        if (!options.silent) notify('还没有可刷新余额的账户。');
        return;
    }
    // Start with the visible accounts, then refresh the rest of the saved list.
    const queue = [...new Set([...listedAccounts(), ...settings.accounts].map(account => account.id))];
    isLoadingBalance = true;
    const button = $('#sam-refresh-all');
    let next = 0;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    const showProgress = () => {
        const label = `刷新中 ${completed}/${queue.length}`;
        if (button) {
            button.disabled = true;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.setAttribute('aria-busy', 'true');
        }
        setButtonContent(button, 'fa-solid fa-spinner fa-spin', label);
    };
    showProgress();
    try {
        const refreshNext = async () => {
            while (next < queue.length) {
                const id = queue[next++];
                // Read the latest credentials if an account was edited while queued.
                const account = settings.accounts.find(item => item.id === id);
                if (account) {
                    const result = await refreshBalance(account, { silent: true });
                    if (result?.status === 'ok') succeeded++;
                    else if (result) failed++;
                }
                completed++;
                showProgress();
            }
        };
        // A slow site must not block every other balance; keep requests bounded.
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, refreshNext));
        if (!options.silent) {
            notify(`余额刷新完成：${succeeded} 个成功${failed ? `，${failed} 个失败，请查看对应站点提示` : ''}。`,
                failed ? (succeeded ? 'warning' : 'error') : 'success');
        }
    } finally {
        isLoadingBalance = false;
        if (button) {
            button.disabled = false;
            button.title = '刷新全部余额';
            button.setAttribute('aria-label', '刷新全部余额');
            button.removeAttribute('aria-busy');
        }
        setButtonContent(button, 'fa-solid fa-rotate', '刷新余额');
    }
}

function formatBalance(balance) {
    const label = '账户余额';
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
        output.textContent = account ? formatBalance(account.balance)
            : $('#sam-balance-mode')?.value === 'account' ? '账户余额：填写网站令牌后，保存时自动查询' : '账户余额：保存后可查询';
        output.dataset.state = account?.balance?.status || 'unknown';
        output.title = account?.balance?.message || '';
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
            output.title = account.balance?.message || '';
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
    if (account.pollingDisabled) {
        const skipped = document.createElement('span');
        skipped.className = 'sam-polling-badge';
        skipped.textContent = '已跳过';
        skipped.title = '此站点已停止参与轮询';
        titleLine.append(skipped);
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
    favorite.title = account.favorite ? '取消收藏'
        : settings.accountFilter.type === 'group' ? '收藏' : '收藏并置顶';
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
    const modelRow = document.createElement('div');
    modelRow.className = 'sam-account-model-row';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'sam-account-model-label';
    modelLabel.textContent = '模型';
    const model = document.createElement('span');
    model.className = 'sam-account-model';
    const modelSelect = document.createElement('select');
    modelSelect.className = 'text_pole sam-control sam-account-model-select';
    modelSelect.dataset.action = 'model-select';
    modelSelect.dataset.accountId = account.id;
    const modelControl = document.createElement('div');
    modelControl.className = 'sam-account-model-control';
    modelControl.append(model, modelSelect);
    const confirmModel = document.createElement('button');
    confirmModel.type = 'button';
    confirmModel.className = 'menu_button sam-button sam-button-small sam-model-confirm';
    confirmModel.dataset.action = 'confirm-model';
    confirmModel.dataset.accountId = account.id;
    confirmModel.title = '确认默认模型';
    confirmModel.setAttribute('aria-label', `确认 ${account.name} 的默认模型`);
    setButtonContent(confirmModel, 'fa-solid fa-check', '确认');
    modelControl.append(confirmModel);
    const modelsButton = document.createElement('button');
    modelsButton.type = 'button';
    modelsButton.className = 'menu_button sam-button sam-button-small';
    modelsButton.dataset.action = 'models';
    modelsButton.dataset.accountId = account.id;
    modelsButton.setAttribute('aria-label', `获取 ${account.name} 的模型列表`);
    updateAccountModelsButton(modelsButton, account);
    modelRow.append(modelLabel, modelControl, modelsButton);
    meta.append(url, modelRow);
    item.append(meta);
    updateAccountModelControl(item, account);
    const balanceRow = document.createElement('div');
    balanceRow.className = 'sam-balance-row';
    const balance = document.createElement('output');
    balance.className = 'sam-account-balance';
    balance.dataset.state = account.balance?.status || 'unknown';
    balance.textContent = formatBalance(account.balance);
    balance.title = account.balance?.message || '';
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
        ['apply', 'fa-solid fa-plug', '应用', '设为当前账户并连接此 API'],
        ['polling', account.pollingDisabled ? 'fa-solid fa-play' : 'fa-solid fa-pause',
            account.pollingDisabled ? '恢复轮询' : '停止轮询',
            account.pollingDisabled ? '恢复此站点参与轮询' : '停止此站点的轮询，自动切换时跳过此站点'],
        ['edit', 'fa-solid fa-pen', '编辑', '编辑账户'],
        ['delete', 'fa-solid fa-trash-can', '删除', '删除账户'],
    ];
    for (const [action, iconClass, label, titleText] of actionDefinitions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `menu_button sam-button ${action === 'apply' ? 'sam-button-primary' : action === 'delete' ? 'sam-button-quiet' : 'sam-button-secondary'}`;
        button.dataset.action = action;
        button.dataset.accountId = account.id;
        button.title = titleText;
        setButtonContent(button, iconClass, label);
        if (action === 'apply') updateApplyButton(button, account);
        if (action === 'polling') {
            button.setAttribute('aria-pressed', String(account.pollingDisabled === true));
            button.setAttribute('aria-label', `${label}：${account.name}`);
        }
        if (action === 'edit') {
            button.setAttribute('aria-controls', 'sam-account-form');
            button.setAttribute('aria-expanded', 'false');
        }
        actions.append(button);
    }
    item.append(actions);
    return item;
}

function savedGroups({ includeUngrouped = false } = {}) {
    return [...new Set(settings.accounts.map(account => account.group).filter(group => includeUngrouped || Boolean(group)))]
        .sort((a, b) => (a || '未分组').localeCompare(b || '未分组'));
}

function groupDisplayLabel(group, distinguishVirtual = false) {
    if (!group) return '未分组';
    return distinguishVirtual && ['收藏', '全部', '未分组'].includes(group) ? `${group}（分组）` : group;
}

function createGroupButton(group, { count, formChoice = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sam-group-tab';
    button.dataset.group = group;
    if (!formChoice) {
        button.dataset.filter = 'group';
        button.setAttribute('aria-controls', 'sam-account-list sam-failover-section');
    }
    const label = groupDisplayLabel(group, !formChoice);
    button.textContent = count == null ? label : `${label} ${count}`;
    button.title = group || '未分组';
    return button;
}

function renderGroupSuggestions(selectedGroup) {
    const input = $('#sam-group');
    const choices = $('#sam-group-choices');
    if (!input || !choices) return;
    const current = selectedGroup ?? input.value;
    input.value = current;
    const buttons = savedGroups({ includeUngrouped: true }).map(group => {
        const button = createGroupButton(group, { formChoice: true });
        button.setAttribute('aria-pressed', String(group === current));
        return button;
    });
    choices.replaceChildren(...buttons);
}

function filteredAccounts(accounts, filter) {
    return accounts.filter(account => filter.type === 'all' || accountMatchesFilter(account, filter))
        .sort((a, b) => (filter.type === 'group' ? 0 : Number(b.favorite) - Number(a.favorite))
            || (a.group || '未分组').localeCompare(b.group || '未分组')
            || a.name.localeCompare(b.name));
}

function listedAccounts() {
    const filter = settings.accountFilter;
    const search = asString($('#sam-account-search')?.value).trim().toLocaleLowerCase();
    const accounts = settings.accounts.filter(account =>
        (filter.type === 'all' || accountMatchesFilter(account, filter))
        && (!search || account.name.toLocaleLowerCase().includes(search)));
    // The saved array preserves insertion order, even for accounts without timestamps.
    // Sort only this display copy so changing the view does not reorder polling.
    return accounts.sort((a, b) => (filter.type === 'group' ? 0 : Number(b.favorite) - Number(a.favorite))
        || (settings.accountSort === 'added' ? 0 : accountNameCollator.compare(a.name, b.name)));
}

function renderAccountFilters() {
    const favoritesButton = $('#sam-filter-favorites');
    const allButton = $('#sam-filter-all');
    const groupButtons = $('#sam-group-filter-buttons');
    if (!favoritesButton || !allButton || !groupButtons) return;

    setButtonContent(favoritesButton, 'fa-solid fa-star',
        `收藏 ${settings.accounts.filter(account => account.favorite).length}`);
    setButtonContent(allButton, '', `全部 ${settings.accounts.length}`);
    favoritesButton.setAttribute('aria-pressed', String(settings.accountFilter.type === 'favorites'));
    allButton.setAttribute('aria-pressed', String(settings.accountFilter.type === 'all'));

    const scrollLeft = groupButtons.scrollLeft;
    const focusedGroup = groupButtons.contains?.(document.activeElement)
        ? document.activeElement?.dataset?.group : undefined;
    const buttons = savedGroups({ includeUngrouped: true }).map(group => {
        const count = settings.accounts.filter(account => account.group === group).length;
        const button = createGroupButton(group, { count });
        button.setAttribute('aria-pressed', String(settings.accountFilter.type === 'group'
            && settings.accountFilter.group === group));
        return button;
    });
    groupButtons.replaceChildren(...buttons);
    groupButtons.scrollLeft = scrollLeft;
    if (focusedGroup !== undefined) {
        buttons.find(button => button.dataset.group === focusedGroup)?.focus({ preventScroll: true });
    }

    const renameStart = $('#sam-group-rename-start');
    const renameEditor = $('#sam-group-rename-editor');
    const canRename = settings.accountFilter.type === 'group' && Boolean(settings.accountFilter.group);
    if (renameStart) {
        renameStart.hidden = !canRename;
        renameStart.setAttribute('aria-expanded', 'false');
    }
    if (renameEditor) renameEditor.hidden = true;
}

function groupFilterButton(group) {
    const container = $('#sam-group-filter-buttons');
    if (!container) return null;
    return $$('.sam-group-tab', container).find(button => button.dataset.group === group) || null;
}

function setGroupRenameEditor(open, { focus = true } = {}) {
    const start = $('#sam-group-rename-start');
    const editor = $('#sam-group-rename-editor');
    const input = $('#sam-group-rename-input');
    const canRename = settings.accountFilter.type === 'group' && Boolean(settings.accountFilter.group);
    if (!start || !editor || !input || !canRename) return false;
    start.hidden = open;
    start.setAttribute('aria-expanded', String(open));
    editor.hidden = !open;
    if (open) {
        input.value = settings.accountFilter.group;
        if (focus) {
            input.focus({ preventScroll: true });
            input.select?.();
        }
    } else if (focus) {
        start.focus({ preventScroll: true });
    }
    return true;
}

function renameGroup(oldGroup, rawName) {
    const previous = asString(oldGroup).trim();
    const next = asString(rawName).trim();
    if (!previous || !settings.accounts.some(account => account.group === previous)) {
        notify('当前分组已不存在，请重新选择。', 'error');
        renderAccounts();
        return false;
    }
    if (!next) {
        notify('分组名称不能为空。', 'error');
        return false;
    }
    if (next.length > 60) {
        notify('分组名称不能超过 60 个字符。', 'error');
        return false;
    }
    if (next === previous) {
        setGroupRenameEditor(false);
        return false;
    }
    const merging = settings.accounts.some(account => account.group === next);
    if (merging && typeof globalThis.confirm === 'function'
        && !globalThis.confirm(`分组“${next}”已存在。是否将“${previous}”合并到该分组？`)) {
        return false;
    }

    const changedAt = Date.now();
    for (const account of settings.accounts) {
        if (account.group !== previous) continue;
        account.group = next;
        account.updatedAt = changedAt;
    }
    if (settings.accountFilter.type === 'group' && settings.accountFilter.group === previous) {
        settings.accountFilter = { type: 'group', group: next };
    }
    if (settings.pollingFilter?.type === 'group' && settings.pollingFilter.group === previous) {
        settings.pollingFilter = { type: 'group', group: next };
    }
    const draftGroup = $('#sam-group');
    if (draftGroup && asString(draftGroup.value).trim() === previous) draftGroup.value = next;

    persist();
    renderAccounts();
    updatePollingState();
    notify(merging ? `已将分组“${previous}”合并到“${next}”。` : `分组已重命名为“${next}”。`, 'success');
    $('#sam-group-rename-start')?.focus({ preventScroll: true });
    return true;
}

function submitGroupRename() {
    if (settings.accountFilter.type !== 'group') return false;
    return renameGroup(settings.accountFilter.group, $('#sam-group-rename-input')?.value);
}

function selectedAccount() {
    return settings.accounts.find(account => account.id === settings.selectedAccountId);
}

function locateSelectedAccount() {
    const account = selectedAccount();
    if (!account) {
        notify('当前没有已应用的站点。', 'warning');
        return;
    }

    const search = $('#sam-account-search');
    if (search) search.value = '';
    if (settings.accountFilter.type !== 'all') {
        settings.accountFilter = { type: 'all' };
        persist();
    }
    renderAccounts();

    const list = $('#sam-account-list');
    const card = list && $$('.sam-account-item', list).find(item => item.dataset.accountId === account.id);
    if (!card) {
        notify(`找不到已应用的站点“${account.name}”。`, 'warning');
        return;
    }
    if (typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    card.classList.remove('sam-locate-pulse');
    void card.offsetWidth;
    card.classList.add('sam-locate-pulse');
    setTimeout(() => card.classList.remove('sam-locate-pulse'), 1200);
}

function updateScrollTopButton() {
    const panel = rootElement();
    const button = ensureScrollTopButton(panel);
    if (!button || !panel) return;
    const visible = panel.open === true;
    button.hidden = !visible;
    button.style.display = visible ? 'inline-flex' : 'none';
}

function ensureScrollTopButton(panel = rootElement()) {
    let button = document.getElementById('sam-scroll-top');
    if (!button) {
        button = document.createElement('button');
        button.id = 'sam-scroll-top';
        button.className = 'sam-floating-top';
        button.type = 'button';
        button.setAttribute('aria-label', '回到页面顶部');
        button.title = '回到页面顶部';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-circle-up';
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);
    }
    if (button.parentElement !== document.body) document.body.append(button);
    // Keep this control independent of SillyTavern's button and drawer styles.
    const visible = panel?.open === true;
    for (const [property, value] of [
        ['position', 'fixed'],
        ['z-index', '2147483000'],
        ['right', 'max(12px, env(safe-area-inset-right))'],
        ['bottom', 'max(12px, env(safe-area-inset-bottom))'],
        ['display', visible ? 'inline-flex' : 'none'],
        ['visibility', 'visible'],
        ['opacity', '1'],
        ['pointer-events', 'auto'],
        ['background-color', 'rgba(145, 116, 185, 0.9)'],
        ['border-color', 'rgba(255, 255, 255, 0.35)'],
        ['color', '#ffffff'],
    ]) button.style.setProperty(property, value, 'important');
    return button;
}

function scrollAccountsToTop() {
    const scrollContainer = findScrollContainer(rootElement());
    if (scrollContainer) {
        if (scrollContainer.scrollTo) scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
        else scrollContainer.scrollTop = 0;
    } else {
        const scroller = document.scrollingElement;
        if (scroller?.scrollTo) scroller.scrollTo({ top: 0, behavior: 'smooth' });
        else globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
    }
    updateScrollTopButton();
}

function viewedPollingFilter() {
    return normalizePollingFilter(settings.accountFilter, settings.accounts);
}

function currentPollingFilter() {
    return settings.pollingEnabled
        ? normalizePollingFilter(settings.pollingFilter, settings.accounts)
        : viewedPollingFilter();
}

function isPollingEnabledFor(filter) {
    return Boolean(settings.pollingEnabled && filter && filter.type === settings.pollingFilter?.type
        && (filter.type === 'favorites' || filter.group === settings.pollingFilter.group));
}

function accountParticipatesInPolling(account, filter = currentPollingFilter()) {
    return accountMatchesFilter(account, filter) && account.pollingDisabled !== true;
}

function pollingAccounts(filter = currentPollingFilter()) {
    return filter ? filteredAccounts(settings.accounts, filter)
        .filter(account => accountParticipatesInPolling(account, filter)) : [];
}

function nextPollingAccount(filter = currentPollingFilter()) {
    const accounts = pollingAccounts(filter);
    const currentIndex = accounts.findIndex(account => account.id === settings.selectedAccountId);
    if (accounts.length < 2 || currentIndex < 0) return null;
    return accounts[(currentIndex + 1) % accounts.length];
}

function pollingFilterLabel(filter) {
    if (!filter) return '';
    return filter.type === 'favorites' ? '收藏' : `分组：${filter.group || '未分组'}`;
}

function updatePollingUi() {
    const filter = viewedPollingFilter();
    const section = $('#sam-failover-section');
    if (section) section.hidden = !filter;
    const enabled = isPollingEnabledFor(filter);
    const accounts = pollingAccounts(filter);
    const skippedCount = filter ? filteredAccounts(settings.accounts, filter).length - accounts.length : 0;
    const currentInRange = accountParticipatesInPolling(selectedAccount(), filter);
    const label = $('#sam-current-group');
    if (label) label.textContent = filter
        ? `轮询范围：${pollingFilterLabel(filter)} · ${accounts.length} 个账户参与`
            + (skippedCount ? ` · 已跳过 ${skippedCount} 个` : '')
            + (enabled && !currentInRange ? ' · 当前 API 未参与轮询，已暂停' : '')
        : '轮询范围：未选择';
    const button = $('#sam-toggle-polling');
    if (button) {
        button.disabled = !filter || (!enabled && (accounts.length < 2 || !currentInRange));
        button.title = accounts.length < 2
            ? '轮询范围至少需要两个参与轮询的账户'
            : !currentInRange ? '请先应用当前范围内参与轮询的一个 API'
                : `当前 API 正常时持续使用；生成报错后切换到“${pollingFilterLabel(filter)}”中的下一个`;
        setButtonContent(button,
            enabled ? 'fa-solid fa-stop' : 'fa-solid fa-shuffle',
            enabled ? '停止轮询' : '开启轮询');
        button.setAttribute('aria-pressed', String(enabled));
        button.classList.toggle('sam-button-primary', enabled);
    }
    updateQuickSwitchUi();
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
    if ($('#sam-account-sort')) $('#sam-account-sort').value = settings.accountSort;
    if ($('#sam-account-count')) $('#sam-account-count').textContent = `已保存 ${settings.accounts.length} 个`;
    const list = $('#sam-account-list');
    if (!list) return;
    const searchQuery = asString($('#sam-account-search')?.value).trim();
    const accounts = listedAccounts();
    const searchFeedback = $('#sam-search-feedback');
    if (searchFeedback) searchFeedback.textContent = searchQuery ? `找到 ${accounts.length} 个匹配的站点` : '';
    const scrollTop = list.scrollTop;
    if (!accounts.length) {
        const empty = document.createElement('div');
        empty.className = 'sam-empty';
        empty.textContent = searchQuery ? `没有找到匹配“${searchQuery}”的站点。`
            : settings.accounts.length && settings.accountFilter.type === 'favorites'
                ? '还没有收藏的 API。'
                : '还没有保存的 API。';
        list.replaceChildren(empty);
    } else {
        list.replaceChildren(...accounts.map(createAccountCard));
    }
    list.scrollTop = scrollTop;
}

// Applying an API only changes card state. Keeping the existing list nodes
// avoids collapsing the scroll container or losing the user's current place.
function updateApplyButton(button, account) {
    const pending = applyingAccountId === account.id;
    button.disabled = isApplyingAccount;
    button.setAttribute('aria-busy', String(pending));
    setButtonContent(button, pending ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-plug', pending ? '切换中…' : '应用');
}

function updateAccountSelectionUi() {
    const list = $('#sam-account-list');
    if (!list) return;
    for (const card of $$('.sam-account-item', list)) {
        const account = settings.accounts.find(item => item.id === card.dataset.accountId);
        if (!account) continue;
        const selected = account.id === settings.selectedAccountId;
        card.classList.toggle('sam-selected', selected);
        if (selected) card.setAttribute('aria-current', 'true');
        else card.removeAttribute('aria-current');
        const badge = $('.sam-current-badge', card);
        if (selected && !badge) {
            const current = document.createElement('span');
            current.className = 'sam-current-badge';
            current.textContent = '当前';
            $('.sam-account-title-line', card)?.append(current);
        } else if (!selected) badge?.remove();
        const button = $('button[data-action="apply"]', card);
        if (button) updateApplyButton(button, account);
        updateAccountModelControl(card, account);
    }
    updatePollingUi();
}

function quickSwitchAccounts() {
    const filter = viewedPollingFilter();
    return filter ? pollingAccounts(filter) : [];
}

function updateQuickSwitchUi() {
    const widget = $('#sam-chat-quick-switch');
    if (!widget) return;

    const filter = viewedPollingFilter();
    const accounts = quickSwitchAccounts();
    const currentIndex = accounts.findIndex(account => account.id === settings.selectedAccountId);
    const canSwitch = Boolean(filter && accounts.length > 1 && currentIndex >= 0
        && !isApplyingAccount && !isFailingOver);
    // The controls are only useful when there is a real next/previous site.
    // Keep the widget out of the chat corner when the current view cannot
    // switch between at least two applied polling accounts.
    widget.dataset.available = canSwitch ? 'true' : 'false';
    const previous = $('#sam-quick-switch-previous');
    const next = $('#sam-quick-switch-next');
    const previousTarget = currentIndex > 0 ? accounts[currentIndex - 1] : accounts.at(-1);
    const nextTarget = currentIndex >= 0 ? accounts[(currentIndex + 1) % accounts.length] : null;
    const rangeLabel = filter ? pollingFilterLabel(filter) : '未选择分组';
    for (const [button, target, label] of [
        [previous, previousTarget, '上一个站点'],
        [next, nextTarget, '下一个站点'],
    ]) {
        if (!button) continue;
        button.disabled = !canSwitch;
        const title = canSwitch ? `${label}：${target.name}（${rangeLabel}）`
            : !filter ? '请先在 API 页面选择分组或收藏'
                : accounts.length < 2 ? '当前范围内至少需要两个参与轮询的站点'
                    : '请先应用当前范围内的一个站点';
        button.title = `${title}；长按可拖动浮窗`;
        button.setAttribute('aria-label', `${label}，长按可拖动浮窗`);
    }
    positionQuickSwitch();
}

function positionQuickSwitch() {
    const widget = $('#sam-chat-quick-switch');
    const chat = $('#sheld');
    if (!widget || !chat) return;

    const rect = chat.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0
        && globalThis.getComputedStyle(chat).display !== 'none'
        && globalThis.getComputedStyle(chat).visibility !== 'hidden';
    const available = widget.dataset.available === 'true';
    widget.hidden = !visible || !available;
    if (!visible || !available) return;

    const widgetRect = widget.getBoundingClientRect();
    const maxX = Math.max(0, rect.width - widgetRect.width);
    const maxY = Math.max(0, rect.height - widgetRect.height);
    const savedPosition = settings.quickSwitchPosition;
    const offsetX = savedPosition ? savedPosition.x * maxX : Math.min(12, maxX);
    const offsetY = savedPosition ? savedPosition.y * maxY : maxY - Math.min(12, maxY);
    const left = Math.max(rect.left, Math.min(rect.left + offsetX, rect.right - widgetRect.width));
    const top = Math.max(rect.top, Math.min(rect.top + offsetY, rect.bottom - widgetRect.height));
    widget.style.left = `${left}px`;
    widget.style.top = `${top}px`;
    widget.style.bottom = 'auto';
}

function startQuickSwitchDrag(event) {
    if (event.button !== 0 || quickSwitchDrag) return;
    const widget = $('#sam-chat-quick-switch');
    const chat = $('#sheld');
    if (!widget || !chat) return;

    const rect = widget.getBoundingClientRect();
    const drag = quickSwitchDrag = {
        pointerId: event.pointerId,
        button: event.currentTarget,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        active: false,
        timer: null,
    };
    drag.timer = window.setTimeout(() => {
        if (quickSwitchDrag !== drag) return;
        drag.active = true;
        drag.button.setPointerCapture?.(drag.pointerId);
        widget.classList.add('sam-quick-switch-dragging');
    }, 350);
}

function moveQuickSwitchDrag(event) {
    if (!quickSwitchDrag || event.pointerId !== quickSwitchDrag.pointerId) return;
    const drag = quickSwitchDrag;
    if (!drag.active) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (distance > 8) {
            window.clearTimeout(drag.timer);
            quickSwitchDrag = null;
        }
        return;
    }
    const widget = $('#sam-chat-quick-switch');
    const chat = $('#sheld');
    if (!widget || !chat) return;

    const chatRect = chat.getBoundingClientRect();
    const widgetRect = widget.getBoundingClientRect();
    const maxX = Math.max(0, chatRect.width - widgetRect.width);
    const maxY = Math.max(0, chatRect.height - widgetRect.height);
    const left = Math.max(chatRect.left, Math.min(event.clientX - drag.offsetX, chatRect.left + maxX));
    const top = Math.max(chatRect.top, Math.min(event.clientY - drag.offsetY, chatRect.top + maxY));
    if (Math.abs(left - widgetRect.left) + Math.abs(top - widgetRect.top) > 2) drag.moved = true;
    widget.style.left = `${left}px`;
    widget.style.top = `${top}px`;
    widget.style.bottom = 'auto';
    event.preventDefault();
}

function finishQuickSwitchDrag(event) {
    if (!quickSwitchDrag || event.pointerId !== quickSwitchDrag.pointerId) return;
    const drag = quickSwitchDrag;
    const widget = $('#sam-chat-quick-switch');
    const chat = $('#sheld');
    window.clearTimeout(drag.timer);
    quickSwitchDrag = null;
    widget?.classList.remove('sam-quick-switch-dragging');
    if (!drag.active || !drag.moved || !widget || !chat) return;

    quickSwitchSuppressClick = true;
    window.setTimeout(() => { quickSwitchSuppressClick = false; }, 0);

    const chatRect = chat.getBoundingClientRect();
    const widgetRect = widget.getBoundingClientRect();
    const maxX = Math.max(0, chatRect.width - widgetRect.width);
    const maxY = Math.max(0, chatRect.height - widgetRect.height);
    settings.quickSwitchPosition = {
        x: maxX ? Math.max(0, Math.min(1, (widgetRect.left - chatRect.left) / maxX)) : 0,
        y: maxY ? Math.max(0, Math.min(1, (widgetRect.top - chatRect.top) / maxY)) : 0,
    };
    persist();
}

function switchQuickSite(direction) {
    if (isApplyingAccount || isFailingOver) return;
    const accounts = quickSwitchAccounts();
    const currentIndex = accounts.findIndex(account => account.id === settings.selectedAccountId);
    if (accounts.length < 2 || currentIndex < 0) return;

    const index = (currentIndex + direction + accounts.length) % accounts.length;
    const target = accounts[index];
    const apply = applyToSillyTavern(target);
    updateQuickSwitchUi();
    void apply.finally(updateQuickSwitchUi);
}

function mountQuickSwitch() {
    if ($('#sam-chat-quick-switch')) return;
    const widget = document.createElement('div');
    widget.id = 'sam-chat-quick-switch';
    widget.innerHTML = `
      <div id="sam-quick-switch-controls" role="group" aria-label="快速切换站点">
        <button id="sam-quick-switch-previous" type="button" aria-label="上一个站点" title="上一个站点">
          <span class="sam-quick-switch-arrow" aria-hidden="true">↑</span>
        </button>
        <button id="sam-quick-switch-next" type="button" aria-label="下一个站点" title="下一个站点">
          <span class="sam-quick-switch-arrow" aria-hidden="true">↓</span>
        </button>
      </div>`;
    document.body.append(widget);

    for (const [selector, direction] of [
        ['#sam-quick-switch-previous', -1],
        ['#sam-quick-switch-next', 1],
    ]) {
        const button = $(selector, widget);
        button?.addEventListener('pointerdown', startQuickSwitchDrag);
        button?.addEventListener('click', event => {
            if (quickSwitchSuppressClick) {
                event.preventDefault();
                event.stopImmediatePropagation();
                quickSwitchSuppressClick = false;
                return;
            }
            switchQuickSite(direction);
        });
    }
    document.addEventListener('pointermove', moveQuickSwitchDrag);
    document.addEventListener('pointerup', finishQuickSwitchDrag);
    document.addEventListener('pointercancel', finishQuickSwitchDrag);

    window.addEventListener('resize', positionQuickSwitch);
    window.addEventListener('scroll', positionQuickSwitch, true);
    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(positionQuickSwitch);
        const chat = $('#sheld');
        if (chat) observer.observe(chat);
        observer.observe(widget);
    }
    positionQuickSwitch();
    requestAnimationFrame(positionQuickSwitch);
    updateQuickSwitchUi();
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
    account = normalizeAccount(account);
    if (index >= 0) settings.accounts[index] = account;
    else settings.accounts.push(account);
    if (clearSelected) settings.selectedAccountId = '';
    if ((settings.accountFilter.type === 'favorites' && !account.favorite)
        || (settings.accountFilter.type === 'group' && settings.accountFilter.group !== account.group)) {
        settings.accountFilter = { type: 'group', group: account.group };
    }
    persist();
    renderAccounts();
    clearForm();
    updatePollingState();
    notify(index >= 0 ? '账户已更新。' : '账户已保存。', 'success');
    if (account.balanceMode === 'account' && account.balanceAccessToken && account.balance.status !== 'ok') {
        void refreshBalance(account);
    }
}

function editAccount(account) {
    fillForm(account);
    $('#sam-name')?.focus({ preventScroll: true });
}

function markSelectedAccount(account) {
    const current = settings.accounts.find(item => item.id === account.id);
    if (!current) return false;
    invalidateFailover();
    settings.selectedAccountId = current.id;
    persist();
    updateAccountSelectionUi();
    updatePollingState();
    return true;
}

function deleteAccount(account) {
    const confirmed = typeof globalThis.confirm === 'function'
        ? globalThis.confirm(`确定删除账户“${account.name}”吗？API Key 也会从本地设置中移除。`)
        : true;
    if (!confirmed) return;
    const visibleAccounts = listedAccounts();
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
    updatePollingState();
    notify('账户已删除。', 'success');
    const focusCard = $$('.sam-account-item').find(item => item.dataset.accountId === focusAccountId);
    const focusTarget = focusCard ? $('button[data-action="edit"]', focusCard)
        : settings.accountFilter.type === 'group' ? groupFilterButton(settings.accountFilter.group)
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
    if (options.shouldApply && !options.shouldApply()) return false;
    if (!options.shouldApply) invalidateFailover();
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
    applyingAccountId = account.id;
    updateAccountSelectionUi();
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
            const snapshot = { ...account };
            const result = await resolveAccountEndpoint(snapshot);
            if (options.shouldApply && !options.shouldApply()) return false;
            const current = settings.accounts.find(item => item.id === snapshot.id
                && item.baseUrl === snapshot.baseUrl && item.apiKey === snapshot.apiKey);
            if (!current) {
                if (!options.shouldApply) notify('已取消切换，账户或连接配置已发生变化。');
                return false;
            }
            baseUrl = result.baseUrl;
            current.baseUrl = displayApiUrl(baseUrl);
            current.resolvedBaseUrl = baseUrl;
            current.selectedModel ||= result.models[0] || '';
            current.models = [...new Set([current.selectedModel, ...result.models].filter(Boolean))];
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
        applied = markSelectedAccount(account);
        if (!applied) {
            notify('账户已被删除，未更新当前账户标识。', 'error');
            return false;
        }
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
        // Native custom connections can bypass their status check. Confirm the
        // applied configuration here; do not claim the upstream is reachable.
        const current = selectedAccount();
        const connection = nativeConnectionState();
        if (!current || current.id !== account.id || !sameAppliedConnection(current, account)
            || !nativeConnectionMatches(account, connection) || connection.model !== model) {
            if (!options.shouldApply) notify('连接配置已发生变化，请重新应用需要的账户。');
            return false;
        }
        if (!options.shouldApply) {
            notify(`切换成功：${account.name} · ${model || '未选择模型'}。已应用到酒馆。`, 'success');
        }
    } catch (error) {
        notify(error?.message || '连接未能启动，请检查酒馆连接状态。', 'error');
        return false;
    } finally {
        if (jq) jq(connect).off('click.samAccountApply', trackConnection);
        else connect.removeEventListener('click', trackConnection);
        isApplyingAccount = false;
        applyingAccountId = '';
        updateAccountSelectionUi();
    }
    return applied;
}

async function handleAccountAction(event) {
    const modelSelect = event.target.closest('select[data-action="model-select"]');
    if (modelSelect) {
        const account = settings.accounts.find(item => item.id === modelSelect.dataset.accountId);
        if (account) {
            if (modelSelect.value === account.selectedModel) modelDrafts.delete(account.id);
            else modelDrafts.set(account.id, modelSelect.value);
            updateAccountModelUi(account);
        }
        return;
    }
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const account = settings.accounts.find(item => item.id === button.dataset.accountId);
    if (!account) return;
    switch (button.dataset.action) {
        case 'edit': editAccount(account); break;
        case 'delete': deleteAccount(account); break;
        case 'polling': {
            const wasPollingEnabled = settings.pollingEnabled;
            account.pollingDisabled = !account.pollingDisabled;
            account.updatedAt = Date.now();
            if (account.id === settings.selectedAccountId) invalidateFailover();
            persist();
            renderAccounts();
            updatePollingState();
            const card = $$('.sam-account-item').find(item => item.dataset.accountId === account.id);
            $('button[data-action="polling"]', card || rootElement())?.focus({ preventScroll: true });
            notify((account.pollingDisabled ? `已停止“${account.name}”参与轮询，自动切换时将跳过。`
                : `已恢复“${account.name}”参与轮询。`)
                + (wasPollingEnabled && !settings.pollingEnabled ? '参与轮询的账户不足两个，已停止该范围的轮询。' : ''), 'success');
            break;
        }
        case 'favorite':
            account.favorite = !account.favorite;
            account.updatedAt = Date.now();
            persist();
            renderAccounts();
            updatePollingState();
            ($$('.sam-favorite-button').find(item => item.dataset.accountId === account.id)
                || $('.sam-filter-button[aria-pressed="true"]')
                || rootElement())?.focus({ preventScroll: true });
            break;
        case 'balance': await refreshBalance(account); break;
        case 'models': await fetchModelsForAccount(account); break;
        case 'confirm-model': {
            const model = modelDrafts.has(account.id) ? modelDrafts.get(account.id) : account.selectedModel;
            if (!asString(model).trim()) {
                notify('请先选择一个模型。', 'error');
                break;
            }
            modelDrafts.delete(account.id);
            selectAccountModel(account, model);
            modelChoicesVisibleForAccounts.delete(account.id);
            updateAccountModelUi(account);
            notify(`已将“${account.name}”的默认模型设为 ${model}。`, 'success');
            break;
        }
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

function invalidateFailover() {
    failoverRevision++;
    pendingFailover = null;
    if (pendingFailoverTimer !== null) clearTimeout(pendingFailoverTimer);
    pendingFailoverTimer = null;
}

function nativeConnectionState() {
    return {
        main: asString($('#main_api')?.value),
        source: asString($('#chat_completion_source')?.value),
        url: normalizeUrl($('#custom_api_url_text')?.value),
        model: asString($('#custom_model_id')?.value),
        key: asString($('#api_key_custom')?.value).trim(),
    };
}

function nativeConnectionMatches(account, connection = nativeConnectionState()) {
    return Boolean(account) && connection.main === 'openai' && connection.source === 'custom'
        && connection.url === savedApiEndpoint(account)
        // SillyTavern clears the password field after storing the chat key.
        && (!connection.key || connection.key === account.apiKey);
}

function isCurrentFailure(snapshot) {
    const account = selectedAccount();
    const connection = nativeConnectionState();
    return Boolean(snapshot) && settings.pollingEnabled && snapshot.revision === failoverRevision
        && account?.id === snapshot.account.id && sameAppliedConnection(account, snapshot.account)
        && accountParticipatesInPolling(account)
        && Object.keys(connection).every(key => connection[key] === snapshot.connection[key]);
}

function captureGenerationRequest(payload) {
    const account = selectedAccount();
    const connection = nativeConnectionState();
    if (!settings.pollingEnabled || !generationActive || isApplyingAccount
        || !accountParticipatesInPolling(account)
        || !nativeConnectionMatches(account, connection)
        || normalizeUrl(payload.custom_url) !== connection.url
        || asString(payload.model) !== connection.model) return null;
    return {
        revision: failoverRevision,
        connection,
        account: {
            id: account.id, baseUrl: account.baseUrl, resolvedBaseUrl: account.resolvedBaseUrl,
            apiKey: account.apiKey, selectedModel: account.selectedModel,
        },
    };
}

async function failOverAfterError(snapshot) {
    if (isFailingOver || isApplyingAccount || !isCurrentFailure(snapshot)) return;
    const accounts = pollingAccounts();
    const currentIndex = accounts.findIndex(account => account.id === snapshot.account.id);
    if (currentIndex < 0 || accounts.length < 2) return updatePollingState();
    const candidates = [...accounts.slice(currentIndex + 1), ...accounts.slice(0, currentIndex)];
    isFailingOver = true;
    try {
        // A candidate can fail address discovery before being applied. Try each
        // remaining candidate at most once; never loop back to the failed API.
        for (const candidate of candidates) {
            if (!isCurrentFailure(snapshot)) return;
            const applied = await applyToSillyTavern(candidate, {
                // Eligibility can change while address discovery is in flight.
                shouldApply: () => isCurrentFailure(snapshot)
                    && accountParticipatesInPolling(settings.accounts.find(account => account.id === candidate.id)),
            });
            if (applied) {
                // Applying is not proof of a successful generation. Keep this
                // API until one of its own future chat requests actually fails.
                if (settings.pollingEnabled && settings.selectedAccountId === candidate.id
                    && nativeConnectionMatches(candidate)) {
                    notify(`当前 API 请求失败，已切换到“${candidate.name}” · ${candidate.selectedModel || '未选择模型'}，请重新生成。`, 'success', {
                        timeOut: 0,
                        extendedTimeOut: 0,
                    });
                }
                return;
            }
        }
        if (isCurrentFailure(snapshot)) notify('当前 API 请求失败，范围内的其他 API 均未能应用，请检查连接设置。', 'error');
    } finally {
        isFailingOver = false;
        updatePollingState();
    }
}

function installGenerationFailover() {
    if (failoverInstalled) return;
    failoverInstalled = true;
    globalThis.fetch = createGenerationFetch({
        fetch: globalThis.fetch,
        origin: globalThis.location.origin,
        capture: captureGenerationRequest,
        onFailure: snapshot => {
            if (generationActive && isCurrentFailure(snapshot)) pendingFailover = snapshot;
        },
    });
    eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun || type === 'quiet') return;
        invalidateFailover();
        generationActive = true;
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        generationActive = false;
        const failure = pendingFailover;
        pendingFailover = null;
        if (!failure) return;
        // Defer one turn so native cleanup and a synchronous STOPPED event can
        // finish first. This timer never rotates a healthy or idle account.
        pendingFailoverTimer = setTimeout(() => {
            pendingFailoverTimer = null;
            void failOverAfterError(failure).catch(() => notify('轮询切换未能完成，请检查 API 连接设置。', 'error'));
        }, 0);
    });
    const stop = () => {
        generationActive = false;
        invalidateFailover();
    };
    eventSource.on(event_types.GENERATION_STOPPED, stop);
    eventSource.on(event_types.CHAT_CHANGED, stop);
    for (const selector of ['#main_api', '#chat_completion_source', '#custom_api_url_text',
        '#api_key_custom', '#custom_model_id', '#model_custom_select']) {
        for (const event of ['input', 'change']) {
            $(selector)?.addEventListener(event, invalidateFailover);
        }
    }
}

function updatePollingState() {
    const filter = currentPollingFilter();
    const accounts = pollingAccounts(filter);
    if (settings.pollingEnabled && (!filter || accounts.length < 2)) {
        settings.pollingEnabled = false;
        settings.pollingFilter = null;
        invalidateFailover();
        persist();
    }
    updatePollingUi();
}

function togglePolling() {
    const filter = viewedPollingFilter();
    if (!filter) return notify('请先选择具体分组或收藏视图。', 'error');
    if (isPollingEnabledFor(filter)) {
        settings.pollingEnabled = false;
        settings.pollingFilter = null;
        invalidateFailover();
        persist();
        updatePollingState();
        notify('已停止轮询。');
        return;
    }
    const accounts = pollingAccounts(filter);
    if (accounts.length < 2) return notify('轮询范围至少需要两个参与轮询的账户。', 'error');
    if (!accountParticipatesInPolling(selectedAccount(), filter)) return notify('请先应用当前范围内参与轮询的一个 API，再开启轮询。', 'error');
    invalidateFailover();
    settings.pollingEnabled = true;
    settings.pollingFilter = filter;
    persist();
    updatePollingState();
    notify(`已开启“${pollingFilterLabel(filter)}”轮询，当前 API 正常时保持使用，生成报错后才切换。`, 'success');
}

function bindEvents() {
    $('#sam-view-tabs')?.addEventListener('click', event => {
        const tab = event.target.closest('[role="tab"]');
        if (!tab) return;
        const view = tab.id === 'sam-tab-editor' ? 'editor' : 'accounts';
        setActiveView(view);
    });
    $('#sam-view-tabs')?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = $$('#sam-view-tabs [role="tab"]');
        const index = tabs.indexOf(event.target.closest('[role="tab"]'));
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        const tab = tabs[nextIndex];
        setActiveView(tab.id === 'sam-tab-editor' ? 'editor' : 'accounts');
        tab.focus();
    });
    const form = $('#sam-account-form');
    form?.addEventListener('submit', saveAccountFromForm);
    $('#sam-cancel-edit')?.addEventListener('click', () => clearForm());
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
            balanceMode: draft.balanceMode,
            balanceAccessToken: draft.balanceAccessToken,
            balanceUserId: draft.balanceUserId,
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
    $('#sam-export-accounts')?.addEventListener('click', exportAccounts);
    $('#sam-import-accounts')?.addEventListener('click', () => $('#sam-import-file')?.click());
    $('#sam-import-file')?.addEventListener('change', event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        void importAccountsFromFile(file);
    });
    $('#sam-toggle-polling')?.addEventListener('click', togglePolling);
    $('#sam-account-list')?.addEventListener('click', handleAccountAction);
    $('#sam-account-list')?.addEventListener('change', handleAccountAction);
    $('#sam-account-sort')?.addEventListener('change', event => {
        settings.accountSort = event.target.value === 'added' ? 'added' : 'name';
        persist();
        renderAccounts();
        const list = $('#sam-account-list');
        if (list) list.scrollTop = 0;
    });
    $('#sam-locate-selected')?.addEventListener('click', locateSelectedAccount);
    const panel = rootElement();
    ensureScrollTopButton(panel);
    $('#sam-scroll-top')?.addEventListener('click', scrollAccountsToTop);
    if (panel && panel.dataset.samScrollTopBound !== 'true') {
        panel.dataset.samScrollTopBound = 'true';
        globalThis.addEventListener?.('scroll', updateScrollTopButton, { capture: true, passive: true });
        let scrollContainer = panel.parentElement;
        while (scrollContainer && scrollContainer !== document.body && scrollContainer !== document.documentElement) {
            const style = globalThis.getComputedStyle?.(scrollContainer);
            const canScroll = style && /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`);
            if (canScroll && scrollContainer.scrollHeight > scrollContainer.clientHeight) {
                scrollContainer.addEventListener('scroll', updateScrollTopButton, { passive: true });
                break;
            }
            scrollContainer = scrollContainer.parentElement;
        }
        globalThis.addEventListener?.('resize', updateScrollTopButton, { passive: true });
        panel.addEventListener('toggle', updateScrollTopButton);
    }
    updateScrollTopButton();
    $('#sam-account-search')?.addEventListener('input', () => {
        renderAccounts();
        const list = $('#sam-account-list');
        if (list) list.scrollTop = 0;
    });
    $('#sam-account-filters')?.addEventListener('click', event => {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        const filter = button.dataset.filter === 'group'
            ? { type: 'group', group: button.dataset.group ?? '' }
            : { type: button.dataset.filter };
        settings.accountFilter = normalizeAccountFilter(filter, settings.accounts);
        persist();
        renderAccounts();
    });
    $('#sam-group-choices')?.addEventListener('click', event => {
        const button = event.target.closest('button[data-group]');
        if (!button) return;
        const input = $('#sam-group');
        if (!input) return;
        input.value = button.dataset.group ?? '';
        renderGroupSuggestions(input.value);
        input.focus({ preventScroll: true });
    });
    $('#sam-group')?.addEventListener('input', () => renderGroupSuggestions());
    $('#sam-balance-mode')?.addEventListener('change', () => {
        updateBalanceSettingsUi();
        updateFormBalance();
    });
    $('#sam-balance-access-token')?.addEventListener('input', () => {
        if ($('#sam-clear-balance-token')) $('#sam-clear-balance-token').checked = false;
    });
    $('#sam-group-rename-start')?.addEventListener('click', () => setGroupRenameEditor(true));
    $('#sam-group-rename-cancel')?.addEventListener('click', () => setGroupRenameEditor(false));
    $('#sam-group-rename-confirm')?.addEventListener('click', submitGroupRename);
    $('#sam-group-rename-input')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitGroupRename();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setGroupRenameEditor(false);
        }
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
    if (auto) auto.checked = settings.autoRefresh;
    if (interval) interval.value = settings.refreshInterval;
    setActiveView('accounts');
    updateBalanceSettingsUi();
    renderAccounts();
    updatePollingState();
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
        ensureScrollTopButton(panel);
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
    installGenerationFailover();
    mountQuickSwitch();
    loadSettingsIntoUi();
    restartRefreshTimer();
}

// SillyTavern loads third-party extension entry points as modules.  jQuery is
// already available globally, but DOMContentLoaded is still useful when the
// extension is imported before the settings panel has been mounted.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
