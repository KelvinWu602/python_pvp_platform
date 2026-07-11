// Central place for all Traditional Chinese UI strings.
export const t = {
    siteTitle: '順德聯誼總會翁祐中學 扣叮大師官方網站',
    contactOrganizer: '聯絡主辦方',
    username: '用戶名稱',
    password: '密碼',
    login: '登入',
    confirm: '確認',
    logout: '登出',
    yourCompetitions: '你的比賽',
    contestCode: '比賽代碼',
    lastUpdated: '上次更新',
    lastTested: '上次測試',
    updated: '更新',
    test: '測試',
    testing: '測試中',
    userError: '程式錯誤',
    infraError: '測試失敗',
    refresh: '重新整理',
    retestBlocked: '此代碼已測試或正在測試，請儲存新版本後再測試',
    save: 'SAVE',
    editCode: '編輯代碼',
    testResult: '測試結果',
    testStatus: '測試狀態',
    battleResult: '對戰結果',
    output: '輸出',
    errorMessage: '錯誤訊息',
    success: '成功',
    fail: '失敗',
    win: '勝利',
    lose: '失敗',
    draw: '和局',
    win_short: '勝',
    lose_short: '負',
    tie_short: '和',
    yourCode: '你的代碼',
    yourScore: '你的戰績',
    opponentScore: '對手戰績',
    inProgress: '進行中',
    battle: '對戰',
    battleVideo: '對戰影片',
    minutesLeft: '比賽時間尚餘 {n} 分鐘',
    hoursLeft: '比賽時間尚餘 {n} 小時',
    daysLeft: '比賽時間尚餘 {n} 天',
    ended: '比賽已結束',
    notStarted: '比賽尚未開始',
    winBanner: '勝利！',
    loseBanner: '失敗！',
    drawBanner: '和局！',
    errorOccurred: '發生錯誤',
    returnForNext: '返回進行下一場對戰',
    loadFailed: '加載失敗',
    sessionExpired: '登入時限已過',
    pleaseReLogin: '請重新',
    createCode: '建立新代碼',
    codeName: '代碼名稱',
    cancel: '取消',
    create: '建立',
    invalidCredentials: '用戶名稱或密碼錯誤',
    generalError: '發生錯誤，請重試',
    noCodeYet: '尚未有代碼，請點擊「+」建立',
    noEnrollment: '目前沒有進行中的比賽',
    selectCompetition: '請先選擇左方的比賽',
    noLinkedCode: '尚未選定代碼',
    linkCode: '選定',
    noOpponent: '找不到合適的對手',
    codeNotTested: '尚未測試代碼，無法對戰',
    ongoing: '進行中',
    upcoming: '即將開始',
    finished: '已結束',
};

export function fmt(str, params) {
    return str.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
}

// Format a UTC ISO date to local "YYYY-MM-DD HH:mm".
export function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
