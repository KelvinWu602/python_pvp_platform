// Session token + username persistence.
const KEY_TOKEN = 'pvp_auth_token';
const KEY_USERNAME = 'pvp_username';

export function getToken() {
    return localStorage.getItem(KEY_TOKEN);
}
export function getUsername() {
    return localStorage.getItem(KEY_USERNAME) || '';
}
export function setAuth(token, username) {
    localStorage.setItem(KEY_TOKEN, token);
    if (username) localStorage.setItem(KEY_USERNAME, username);
}
export function clearAuth() {
    localStorage.removeItem(KEY_TOKEN);
    localStorage.removeItem(KEY_USERNAME);
}
export function isLoggedIn() {
    return !!getToken();
}
