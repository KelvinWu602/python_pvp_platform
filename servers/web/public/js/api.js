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

    // Empty body handling (e.g. 204 No Content).
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

// User-facing API. Endpoint surface mirrors API_elegant.md — every method
// here maps 1:1 to a documented route, and the shape of args + returned
// data matches the doc.
export const api = {
    // ── 1. Session ────────────────────────────────────────────────────
    login: (username, password) =>
        request('POST', '/public/session', { username, password }, { public: true }),
    logout: () => request('DELETE', '/session'),

    // ── 2. Enrollments ────────────────────────────────────────────────
    listEnrolls: () => request('GET', '/enroll'),
    getEnroll: (eid) => request('GET', `/enroll/${eid}`),

    // ── 3. Codes ──────────────────────────────────────────────────────
    listEnrollCodes: (eid) => request('GET', `/enroll/${eid}/code`),
    createCode: (eid, name) => request('POST', `/enroll/${eid}/code`, { name }),
    getCode: (cid) => request('GET', `/code/${cid}`),
    getCodeText: (cid) => request('GET', `/code/${cid}/text`),

    // ── 4. Selected code (singleton subresource) ──────────────────────
    getSelectedCode: (eid) => request('GET', `/enroll/${eid}/code/selected`),
    selectCode: (eid, code_id) => request('PUT', `/enroll/${eid}/code/selected`, { code_id }),
    clearSelectedCode: (eid) => request('DELETE', `/enroll/${eid}/code/selected`),

    // ── 5. Snapshots ──────────────────────────────────────────────────
    listSnapshots: (cid) => request('GET', `/code/${cid}/snapshot`),
    getSnapshot: (cid, sid) => request('GET', `/code/${cid}/snapshot/${sid}`),
    createSnapshot: (cid, text) => request('POST', `/code/${cid}/snapshot`, { text }),

    // ── 6. Tests ──────────────────────────────────────────────────────
    createTest: (cid) => request('POST', `/code/${cid}/test`),
    getTest: (tid) => request('GET', `/test/${tid}?log=true&error=true`),

    // ── 7. Battles ────────────────────────────────────────────────────
    // Matchmaking is server-controlled; the caller cannot pick an opponent.
    createBattle: (eid) => request('POST', `/enroll/${eid}/battle`),
    listBattles: (eid) => request('GET', `/enroll/${eid}/battle`),
    getBattle: (bid) => request('GET', `/battle/${bid}`),

    // ── 8. Competition ────────────────────────────────────────────────
    // Only two user-facing competition endpoints. Display name lives on
    // each enrollment; the full competition row is not exposed.
    getCompetitionManifest: (cid) => request('GET', `/competition/${cid}/manifest`),
    getCompetitionHistogram: (cid) => request('GET', `/competition/${cid}/histogram`),

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
