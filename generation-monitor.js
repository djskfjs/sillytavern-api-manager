/** Observe only SillyTavern's custom chat requests, leaving their bytes and errors intact. */
const GENERATION_PATH = '/api/backends/chat-completions/generate';

function generationPayload(input, init, origin) {
    try {
        const url = new URL(typeof input === 'string' ? input : input?.url || input?.href, origin);
        if (url.origin !== new URL(origin).origin || url.pathname !== GENERATION_PATH
            || (init?.method || input?.method || 'GET').toUpperCase() !== 'POST'
            || typeof init?.body !== 'string') return null;
        const data = JSON.parse(init.body);
        return data?.chat_completion_source === 'custom' && data.type !== 'quiet'
            && typeof data.custom_url === 'string' ? data : null;
    } catch {
        return null;
    }
}

function hasApiError(data, streaming) {
    return Boolean(data && (data.error || data.quota_error || data.moderation_error
        || data.success === false || (streaming && (data.message || data.detail))));
}

function completionInspector(streaming, fail) {
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    let sawEvent = false;

    const inspectJson = text => {
        try {
            if (hasApiError(JSON.parse(text), streaming)) fail();
        } catch {
            // SillyTavern also rejects malformed completion JSON.
            fail();
        }
    };

    return (chunk, end = false) => {
        if (finished) return;
        buffer += decoder.decode(chunk, { stream: !end });
        if (!streaming) {
            if (end) {
                inspectJson(buffer);
                buffer = '';
                finished = true;
            }
            return;
        }

        // Match SillyTavern 1.14's SSE framing, including split UTF-8 and CRLF.
        const frames = buffer.split(/\r\n\r\n|\r\r|\n\n/g);
        buffer = frames.pop();
        for (const frame of frames) {
            const lines = frame.split(/\r\n|\n|\r/g);
            const data = lines.filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            sawEvent = true;
            if (data === '[DONE]') {
                finished = true;
                buffer = '';
                return;
            }
            if (lines.some(line => /^event:\s*error\s*$/.test(line))) fail();
            inspectJson(data);
        }
        // Some upstreams return an ordinary JSON error even with stream=true.
        if (end && !sawEvent && buffer.trim()) inspectJson(buffer);
        if (end) {
            buffer = '';
            finished = true;
        }
    };
}

function observeBody(response, streaming, fail) {
    if (!response.body) {
        fail();
        return response;
    }
    const inspect = completionInspector(streaming, fail);
    const reader = response.body.getReader();
    let cancelled = false;
    const body = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (cancelled) return;
                if (done) {
                    inspect(undefined, true);
                    controller.close();
                    reader.releaseLock();
                } else {
                    inspect(value);
                    controller.enqueue(value);
                }
            } catch (error) {
                if (!cancelled) {
                    fail(error);
                    controller.error(error);
                    reader.releaseLock();
                }
            }
        },
        async cancel(reason) {
            cancelled = true;
            try { await reader.cancel(reason); } finally { reader.releaseLock(); }
        },
    }, { highWaterMark: 0 });
    const observed = new Response(body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
    });
    for (const property of ['url', 'redirected', 'type']) {
        Object.defineProperty(observed, property, { value: response[property] });
    }
    return observed;
}

/**
 * capture() returns an opaque snapshot only for the active managed generation.
 * onFailure() records failure; the caller waits for GENERATION_ENDED to switch.
 * No request is retried here, and no response body is cloned or read ahead.
 */
export function createGenerationFetch({ fetch: fetchImpl, origin, capture, onFailure }) {
    return async function (input, init) {
        const payload = generationPayload(input, init, origin);
        const snapshot = payload ? capture(payload) : null;
        if (!snapshot) return fetchImpl.call(this, input, init);
        const signal = init?.signal || input?.signal;
        let reported = false;
        const fail = error => {
            if (reported || signal?.aborted || error?.name === 'AbortError') return;
            reported = true;
            // An observer must never replace SillyTavern's response or error.
            try { onFailure(snapshot); } catch { /* Preserve the original request outcome. */ }
        };
        let response;
        try {
            response = await fetchImpl.call(this, input, init);
        } catch (error) {
            fail(error);
            throw error;
        }
        if (!response.ok) {
            fail();
            return response;
        }
        const streaming = payload.stream === true
            && !response.headers.get('content-type')?.includes('application/json');
        return observeBody(response, streaming, fail);
    };
}
