// Fetch wrapper: injects Bearer token, handles 401 → session expired redirect.
import { getToken, clearAuth } from './auth.js';

function meta(name) {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : '';
}

export const API_BASE = meta('api-base') || '';
export const S3_BASE = meta('s3-base') || '';
export const ORGANIZER_CONTACT = meta('organizer-contact') || 'mailto:admin@example.com';

class ApiError extends Error {
    constructor(status, body) {
        super(body?.error || `HTTP ${status}`);
        this.status = status;
        this.body = body;
    }
}

async function request(method, path, body, opts = {}) {
    const url = API_BASE + path;
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token && !opts.public) {
        headers.Authorization = `Bearer ${token}`;
    }
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res;
    try {
        res = await fetch(url, init);
    } catch (err) {
        throw new ApiError(0, { error: 'Network error' });
    }

    if (res.status === 401 && !opts.public) {
        clearAuth();
        // Only redirect if we weren't already on the expired page (avoid loops).
        if (!location.hash.startsWith('#/expired') && !location.hash.startsWith('#/login')) {
            location.hash = '#/expired';
        }
        throw new ApiError(401, { error: 'Session expired' });
    }

    // Empty body handling
    let payload = null;
    const text = await res.text();
    if (text) {
        try { payload = JSON.parse(text); } catch { payload = text; }
    }

    if (!res.ok) {
        throw new ApiError(res.status, payload || {});
    }
    return payload;
}

export const api = {
    // Public routes (no auth injection)
    login: (username, password) =>
        request('POST', '/public/user/session', { username, password }, { public: true }),

    // User routes
    logout: () => request('DELETE', '/user/session'),

    listCompetitions: () => request('GET', '/competition'),
    getCompetition: (id) => request('GET', `/competition/${id}`),
    getCompetitionHistogram: (id) => request('GET', `/competition/${id}/score-histogram`),

    listCodes: () => request('GET', '/code'),
    getCode: (id) => request('GET', `/code/${id}`),
    createCode: (payload) => request('POST', '/code', payload),
    updateCode: (id, code) => request('PUT', `/code/${id}`, { code }),
    listSnapshots: (id) => request('GET', `/code/${id}/snapshot`),

    listEnrolls: () => request('GET', '/enroll'),
    getEnroll: (id) => request('GET', `/enroll/${id}`),
    getLinkedCode: (eid) => request('GET', `/enroll/${eid}/code`),
    linkCode: (eid, code_id) => request('POST', `/enroll/${eid}/code`, { code_id }),
    unlinkCode: (eid, cid) => request('DELETE', `/enroll/${eid}/code/${cid}`),

    createTest: (eid, code_id) => request('POST', `/enroll/${eid}/test`, { code_id }),
    listTests: (eid) => request('GET', `/enroll/${eid}/test`),
    getTest: (id) => request('GET', `/test/${id}?log=true&error=true`),

    createBattle: (eid, b_enroll_id) =>
        request('POST', `/enroll/${eid}/battle`, b_enroll_id ? { b_enroll_id } : {}),
    listBattles: (eid) => request('GET', `/enroll/${eid}/battle`),
    getBattle: (id) => request('GET', `/battle/${id}`),

    // ── Admin (root-only). All routes below hit /admin/* and require
    // urole='root'; the server returns 403 for non-root callers.
    adminListUsers: (q) => request('GET', `/admin/user?q=${encodeURIComponent(q)}`),
    adminGetUser: (id) => request('GET', `/admin/user/${id}`),
    adminCreateUser: ({ username, full_name, password }) =>
        request('POST', '/admin/user', { username, full_name, password }),
    adminUpdateUser: (id, payload) => request('PUT', `/admin/user/${id}`, payload),

    adminListCompetitions: (q) => request('GET', `/admin/competition?q=${encodeURIComponent(q)}`),
    adminGetCompetition: (id) => request('GET', `/admin/competition/${id}`),
    adminCreateCompetition: (payload) => request('POST', '/admin/competition', payload),
    adminUpdateCompetition: (id, payload) => request('PUT', `/admin/competition/${id}`, payload),
    adminListCompetitionEnrolls: (id) => request('GET', `/admin/competition/${id}/enroll`),

    adminCreateEnroll: (competition_id, user_id) =>
        request('POST', '/admin/enroll', { competition_id, user_id }),
    adminDeleteEnroll: (enroll_id) => request('DELETE', `/admin/enroll/${enroll_id}`),

    adminApproveCode: (competition_id, user_id) =>
        request('POST', '/admin/approve-code', { competition_id, user_id }),
};

export function videoUrl(videoReference) {
    if (!videoReference) return null;
    return `${S3_BASE}/${videoReference}`;
}

// Fetch a manifest.json (or any JSON asset) from the public S3 bucket.
// Cached in sessionStorage keyed by the reference string.
export async function fetchManifest(reference) {
    if (!reference) return null;
    const cacheKey = `pvp_manifest:${reference}`;
    try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) return JSON.parse(cached);
    } catch { /* ignore parse errors */ }

    try {
        const res = await fetch(`${S3_BASE}/${reference}`, { credentials: 'omit' });
        if (!res.ok) return null;
        const json = await res.json();
        try { sessionStorage.setItem(cacheKey, JSON.stringify(json)); } catch { /* quota */ }
        return json;
    } catch (err) {
        console.warn('Failed to fetch manifest:', err);
        return null;
    }
}

export { ApiError };
