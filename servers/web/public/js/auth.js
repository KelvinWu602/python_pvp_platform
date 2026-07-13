// Session token + username + role persistence.
//
// Storage: sessionStorage (not localStorage). Sessions naturally die when the
// user closes the tab, and other origins cannot access this tab's
// sessionStorage. Same-origin XSS can still read it — an HttpOnly cookie would
// be the fully-hardened answer, but that requires the backend to switch away
// from Bearer-token auth.
const KEY_TOKEN = 'pvp_session_id';
const KEY_USERNAME = 'pvp_username';
const KEY_UROLE = 'pvp_urole';

export function getToken() {
    return sessionStorage.getItem(KEY_TOKEN);
}
export function getUsername() {
    return sessionStorage.getItem(KEY_USERNAME) || '';
}
export function getUrole() {
    return sessionStorage.getItem(KEY_UROLE) || '';
}
export function isAdmin() {
    return getUrole() === 'root';
}
export function setAuth(token, username, urole) {
    sessionStorage.setItem(KEY_TOKEN, token);
    if (username) sessionStorage.setItem(KEY_USERNAME, username);
    if (urole) sessionStorage.setItem(KEY_UROLE, urole);
}
export function clearAuth() {
    sessionStorage.removeItem(KEY_TOKEN);
    sessionStorage.removeItem(KEY_USERNAME);
    sessionStorage.removeItem(KEY_UROLE);
}
export function isLoggedIn() {
    return !!getToken();
}
