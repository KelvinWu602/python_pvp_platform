// Session token + username + role persistence.
const KEY_TOKEN = 'pvp_auth_token';
const KEY_USERNAME = 'pvp_username';
const KEY_UROLE = 'pvp_urole';

export function getToken() {
    return localStorage.getItem(KEY_TOKEN);
}
export function getUsername() {
    return localStorage.getItem(KEY_USERNAME) || '';
}
export function getUrole() {
    return localStorage.getItem(KEY_UROLE) || '';
}
export function isAdmin() {
    return getUrole() === 'root';
}
export function setAuth(token, username, urole) {
    localStorage.setItem(KEY_TOKEN, token);
    if (username) localStorage.setItem(KEY_USERNAME, username);
    if (urole) localStorage.setItem(KEY_UROLE, urole);
}
export function clearAuth() {
    localStorage.removeItem(KEY_TOKEN);
    localStorage.removeItem(KEY_USERNAME);
    localStorage.removeItem(KEY_UROLE);
}
export function isLoggedIn() {
    return !!getToken();
}
