// ==UserScript==
// @name         Grafana NOC Alert Monitor
// @namespace    Grafana/RolimNet/Incidentes
// @version      4.0.0
// @description  Monitor NOC Grafana
// @author       Lucas Lucian
// @match        *://grafana.rolimnet.com/*
// @run-at       document-idle
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @icon         https://grafana.rolimnet.com/public/img/fav32.png
// @downloadURL  https://github.com/lucaslucianrm/userscriptsrm/raw/refs/heads/main/GrafanaAlertMonitor.user.js
// @updateURL    https://github.com/lucaslucianrm/userscriptsrm/raw/refs/heads/main/GrafanaAlertMonitor.user.js
// ==/UserScript==

(function () {

    'use strict';

    /*
    =========================================================
    CONFIG
    =========================================================
    */

    const SCRIPT_VERSION = '4.0.0';

    const REQUIRED_DASHBOARD_TITLE =
        '1 [ALERTAS] Eventos e Incidentes';

    const DB_NAME = 'GrafanaAlertDB';

    const STORE_NAME = 'notifications';

    const STORAGE_KEY_METRICS =
        'alertasgrafananoc_metrics';

    const STORAGE_KEY_NOTIFICATIONS_ENABLED =
        'alertasgrafananoc_notifications_enabled';

    const CACHE_HOURS = 360;

    const HOST_RETENTION_HOURS = 360;

    const MAX_EVENT_MINUTES = 5;

    const FALLBACK_SCAN_INTERVAL = 15000;

    const OFFLINE_TIMEOUT = 40000;

    const DELAY_TIMEOUT = 20000;

    const HEARTBEAT_INTERVAL = 30000;

    const WATCHDOG_TIMEOUT = 30000;

    const METRICS_SAVE_DEBOUNCE = 5000;

    /*
    =========================================================
    STATE
    =========================================================
    */

    let db;

    let observer;

    let processingScan = false;

    let processingStartedAt = 0;

    let lastMutationTimestamp = Date.now();

    let monitorStatus = 'ONLINE';

    let monitorStatusSince = Date.now();

    let metricsSaveTimeout = null;

    let currentPopup = null;

    let popupOutsideClickHandler = null;

    let popupEscHandler = null;

    let notificationsEnabled =
        localStorage.getItem(
            STORAGE_KEY_NOTIFICATIONS_ENABLED
        ) !== 'false';

    const activeNotificationIds = new Set();

    const recentAlerts = [];

    const recentDisasters = [];

    const recentHostsEvents = [];

    const metrics = {

        alerts: 0,

        disasters: 0,

        hosts: new Map(),

        startedAt: Date.now()

    };

    /*
    =========================================================
    DATABASE
    =========================================================
    */

    function openDatabase() {

        return new Promise((resolve, reject) => {

            const request =
                indexedDB.open(DB_NAME, 1);

            request.onerror =
                () => reject(request.error);

            request.onsuccess =
                () => {

                    db = request.result;

                    resolve();

                };

            request.onupgradeneeded =
                event => {

                    const database =
                        event.target.result;

                    if (
                        !database.objectStoreNames.contains(STORE_NAME)
                    ) {

                        database.createObjectStore(
                            STORE_NAME,
                            {
                                keyPath: 'id'
                            }
                        );

                    }

                };

        });

    }

    function getStore(mode = 'readonly') {

        return db
            .transaction(STORE_NAME, mode)
            .objectStore(STORE_NAME);

    }

    async function saveNotification(id) {

        return new Promise((resolve, reject) => {

            const request =
                getStore('readwrite')
                    .put({
                        id,
                        timestamp: Date.now()
                    });

            request.onsuccess =
                () => resolve();

            request.onerror =
                () => reject(request.error);

        });

    }

    async function hasNotification(id) {

        return new Promise((resolve, reject) => {

            const request =
                getStore()
                    .get(id);

            request.onsuccess =
                async () => {

                    const data =
                        request.result;

                    if (!data) {

                        resolve(false);

                        return;

                    }

                    const age =
                        Date.now() -
                        data.timestamp;

                    const limit =
                        CACHE_HOURS *
                        60 *
                        60 *
                        1000;

                    if (age > limit) {

                        await removeNotification(id);

                        activeNotificationIds.delete(id);

                        resolve(false);

                        return;

                    }

                    resolve(true);

                };

            request.onerror =
                () => reject(request.error);

        });

    }

    async function removeNotification(id) {

        return new Promise((resolve) => {

            getStore('readwrite')
                .delete(id);

            resolve();

        });

    }

    async function clearAllCache() {

        return new Promise((resolve) => {

            getStore('readwrite')
                .clear();

            activeNotificationIds.clear();

            resolve();

        });

    }

    async function cleanupOldCache() {

        const request =
            getStore('readwrite')
                .openCursor();

        request.onsuccess =
            event => {

                const cursor =
                    event.target.result;

                if (!cursor) {
                    return;
                }

                const age =
                    Date.now() -
                    cursor.value.timestamp;

                const limit =
                    CACHE_HOURS *
                    60 *
                    60 *
                    1000;

                if (age > limit) {

                    activeNotificationIds.delete(
                        cursor.value.id
                    );

                    cursor.delete();

                }

                cursor.continue();

            };

    }

    /*
    =========================================================
    METRICS
    =========================================================
    */

    function saveMetrics() {

        const hosts = [];

        for (const [host, timestamp] of metrics.hosts) {

            hosts.push({
                host,
                timestamp
            });

        }

        localStorage.setItem(
            STORAGE_KEY_METRICS,
            JSON.stringify({

                alerts:
                    metrics.alerts,

                disasters:
                    metrics.disasters,

                hosts,

                startedAt:
                    metrics.startedAt,

                recentAlerts,

                recentDisasters,

                recentHostsEvents

            })
        );

    }

    function saveMetricsDebounced() {

        clearTimeout(
            metricsSaveTimeout
        );

        metricsSaveTimeout =
            setTimeout(
                saveMetrics,
                METRICS_SAVE_DEBOUNCE
            );

    }

    function restoreMetrics() {

        try {

            const raw =
                localStorage.getItem(
                    STORAGE_KEY_METRICS
                );

            if (!raw) {
                return;
            }

            const parsed =
                JSON.parse(raw);

            metrics.alerts =
                parsed.alerts || 0;

            metrics.disasters =
                parsed.disasters || 0;

            metrics.startedAt =
                parsed.startedAt || Date.now();

            metrics.hosts =
                new Map();

            if (
                Array.isArray(parsed.hosts)
            ) {

                for (const item of parsed.hosts) {

                    metrics.hosts.set(
                        item.host,
                        item.timestamp
                    );

                }

            }

            if (
                Array.isArray(parsed.recentAlerts)
            ) {

                recentAlerts.push(
                    ...parsed.recentAlerts
                );

            }

            if (
                Array.isArray(parsed.recentDisasters)
            ) {

                recentDisasters.push(
                    ...parsed.recentDisasters
                );

            }

            if (
                Array.isArray(parsed.recentHostsEvents)
            ) {

                recentHostsEvents.push(
                    ...parsed.recentHostsEvents
                );

            }

        } catch (err) {

            console.error(err);

        }

    }

    function cleanupOldHosts() {

        const limit =
            HOST_RETENTION_HOURS *
            60 *
            60 *
            1000;

        for (
            const [host, timestamp]
            of metrics.hosts
        ) {

            if (
                Date.now() - timestamp > limit
            ) {

                metrics.hosts.delete(host);

            }

        }

    }

    function cleanupOldRecentItems() {

        const limit =
            HOST_RETENTION_HOURS *
            60 *
            60 *
            1000;

        const now = Date.now();

        function cleanup(array) {

            for (
                let i = array.length - 1;
                i >= 0;
                i--
            ) {

                if (
                    now - array[i].timestamp > limit
                ) {

                    array.splice(i, 1);

                }

            }

        }

        cleanup(recentAlerts);

        cleanup(recentDisasters);

        cleanup(recentHostsEvents);

    }

    function resetMetrics() {

        metrics.alerts = 0;

        metrics.disasters = 0;

        metrics.hosts.clear();

        recentAlerts.length = 0;

        recentDisasters.length = 0;

        recentHostsEvents.length = 0;

        metrics.startedAt = Date.now();

        saveMetrics();

        updateMonitorPanel();

    }

    /*
    =========================================================
    HELPERS
    =========================================================
    */

    function formatDuration(ms) {

        const totalSeconds =
            Math.floor(ms / 1000);

        const days =
            Math.floor(totalSeconds / 86400);

        const hours =
            Math.floor(
                (totalSeconds % 86400) / 3600
            );

        const minutes =
            Math.floor(
                (totalSeconds % 3600) / 60
            );

        const parts = [];

        if (days > 0) {
            parts.push(`${days}d`);
        }

        if (hours > 0) {
            parts.push(`${hours}h`);
        }

        parts.push(`${minutes}min`);

        return parts.join(' ');

    }

    function parseMinutes(age) {

        if (!age) {
            return 999;
        }

        age =
            age.toLowerCase()
                .trim();

        if (
            age.includes('segundo')
        ) {

            return 0;

        }

        if (
            age.includes('hora')
        ) {

            const match =
                age.match(/(\d+)/);

            if (!match) {
                return 999;
            }

            return parseInt(match[1]) * 60;

        }

        if (
            age.includes('dia')
        ) {

            return 9999;

        }

        const match =
            age.match(/(\d+)/);

        if (!match) {
            return 999;
        }

        return parseInt(match[1]);

    }

    /*
    =========================================================
    VALIDATION
    =========================================================
    */

    function isCorrectDashboard() {

        return document.body.innerText.includes(
            REQUIRED_DASHBOARD_TITLE
        );

    }

    /*
    =========================================================
    POPUP
    =========================================================
    */

    function destroyPopup() {

        if (currentPopup) {

            currentPopup.remove();

            currentPopup = null;

        }

        if (popupOutsideClickHandler) {

            document.removeEventListener(
                'mousedown',
                popupOutsideClickHandler
            );

            popupOutsideClickHandler = null;

        }

        if (popupEscHandler) {

            document.removeEventListener(
                'keydown',
                popupEscHandler
            );

            popupEscHandler = null;

        }

    }

    function createPopup(
        anchor,
        title,
        items,
        enableHostClick = false
    ) {

        destroyPopup();

        const popup =
            document.createElement('div');

        popup.style.position = 'fixed';

        popup.style.zIndex = '999999';

        popup.style.width = '420px';

        popup.style.maxHeight = '500px';

        popup.style.overflowY = 'auto';

        popup.style.background =
            '#111217';

        popup.style.border =
            '1px solid rgba(255,255,255,0.10)';

        popup.style.borderRadius =
            '10px';

        popup.style.padding =
            '12px';

        popup.style.boxShadow =
            '0 0 18px rgba(0,0,0,0.45)';

        popup.style.fontFamily =
            'sans-serif';

        popup.style.color =
            '#fff';

        popup.style.fontSize =
            '12px';

        const rect =
            anchor.getBoundingClientRect();

        popup.style.top =
            `${rect.bottom + 8}px`;

        popup.style.left =
            `${rect.left}px`;

        const header =
            document.createElement('div');

        header.style.display =
            'flex';

        header.style.justifyContent =
            'space-between';

        header.style.alignItems =
            'center';

        header.style.marginBottom =
            '10px';

        const titleElement =
            document.createElement('div');

        titleElement.innerText =
            title;

        titleElement.style.fontWeight =
            '700';

        const closeButton =
            document.createElement('button');

        closeButton.innerText = 'Fechar';

        closeButton.style.border =
            '1px solid rgba(255,255,255,0.15)';

        closeButton.style.background =
            'rgba(255,255,255,0.04)';

        closeButton.style.color =
            '#ffffff';

        closeButton.style.borderRadius =
            '6px';

        closeButton.style.padding =
            '4px 10px';

        closeButton.style.cursor =
            'pointer';

        closeButton.onclick =
            destroyPopup;

        header.appendChild(
            titleElement
        );

        header.appendChild(
            closeButton
        );

        popup.appendChild(
            header
        );

        if (!items.length) {

            const empty =
                document.createElement('div');

            empty.innerText =
                'Nenhum item encontrado';

            empty.style.opacity =
                '0.7';

            popup.appendChild(empty);

        } else {

            for (const item of items) {

                const card =
                    document.createElement('div');

                card.style.padding =
                    '10px';

                card.style.borderRadius =
                    '8px';

                card.style.background =
                    'rgba(255,255,255,0.03)';

                card.style.marginBottom =
                    '8px';

                card.style.border =
                    '1px solid rgba(255,255,255,0.05)';

                const host =
                    document.createElement('div');

                host.innerText =
                    item.host;

                host.style.fontWeight =
                    '700';

                host.style.marginBottom =
                    '5px';

                if (enableHostClick) {

                    host.style.cursor =
                        'pointer';

                    host.style.color =
                        '#7dcfff';

                    host.onclick =
                        () => {

                            const hostItems =
                                recentHostsEvents
                                    .filter(
                                        h =>
                                            h.host === item.host
                                    )
                                    .sort(
                                        (a, b) =>
                                            b.timestamp - a.timestamp
                                    );

                            createPopup(
                                host,
                                `Host: ${item.host}`,
                                hostItems,
                                false
                            );

                        };

                }

                const problem =
                    document.createElement('div');

                problem.innerText =
                    item.problem;

                problem.style.opacity =
                    '0.88';

                problem.style.marginBottom =
                    '6px';

                const time =
                    document.createElement('div');

                time.innerText =
                    formatDuration(
                        Date.now() - item.timestamp
                    );

                time.style.fontSize =
                    '11px';

                time.style.opacity =
                    '0.55';

                card.appendChild(host);

                card.appendChild(problem);

                card.appendChild(time);

                popup.appendChild(card);

            }

        }

        document.body.appendChild(
            popup
        );

        currentPopup = popup;

        popupOutsideClickHandler =
            event => {

                if (
                    currentPopup &&
                    !currentPopup.contains(event.target) &&
                    event.target !== anchor
                ) {

                    destroyPopup();

                }

            };

        popupEscHandler =
            event => {

                if (
                    event.key === 'Escape'
                ) {

                    destroyPopup();

                }

            };

        document.addEventListener(
            'mousedown',
            popupOutsideClickHandler
        );

        document.addEventListener(
            'keydown',
            popupEscHandler
        );

    }

    /*
    =========================================================
    UI
    =========================================================
    */

    function getBadgeStyle(active) {

        return `
            height:32px;
            padding:0 12px;
            border-radius:6px;
            border:1px solid ${
                active
                    ? 'rgba(0,255,120,0.30)'
                    : 'rgba(255,80,80,0.30)'
            };
            background:${
                active
                    ? 'rgba(0,255,120,0.08)'
                    : 'rgba(255,0,0,0.08)'
            };
            color:${
                active
                    ? '#7dffab'
                    : '#ffb3b3'
            };
            font-size:12px;
            font-weight:600;
            display:flex;
            align-items:center;
            justify-content:center;
            backdrop-filter:blur(4px);
            white-space:nowrap;
            box-sizing:border-box;
            font-family:sans-serif;
            cursor:pointer;
        `;

    }

    function buildBadge(text, color, title = '') {

        return `
            <div
                title="${title}"
                style="
                    height:32px;
                    padding:0 12px;
                    border-radius:6px;
                    border:1px solid ${color};
                    background:rgba(255,255,255,0.04);
                    color:#fff;
                    font-size:12px;
                    font-weight:600;
                    display:flex;
                    align-items:center;
                    font-family:sans-serif;
                    white-space:nowrap;
                "
            >
                ${text}
            </div>
        `;

    }

    function createTopPanel() {

        if (
            document.getElementById(
                'grafana-alert-toolbar'
            )
        ) {
            return;
        }

        const toolbar =
            document.querySelector('.css-g72xnk');

        if (!toolbar) {
            return;
        }

        const wrapper =
            document.createElement('div');

        wrapper.id =
            'grafana-alert-toolbar';

        wrapper.style.display =
            'flex';

        wrapper.style.alignItems =
            'center';

        wrapper.style.gap =
            '8px';

        wrapper.style.marginRight =
            '12px';

        const notifyButton =
            document.createElement('button');

        notifyButton.id =
            'grafana-notify-button';

        function refreshNotifyButton() {

            const hasPermission =
                Notification.permission === 'granted';

            notifyButton.innerText =
                hasPermission
                    ? (
                        notificationsEnabled
                            ? 'Notificações Ativas'
                            : 'Notificações Pausadas'
                    )
                    : 'Permitir Notificações';

            notifyButton.style.cssText =
                getBadgeStyle(
                    hasPermission &&
                    notificationsEnabled
                );

        }

        refreshNotifyButton();

        notifyButton.onclick =
            async () => {

                if (
                    Notification.permission !== 'granted'
                ) {

                    const permission =
                        await Notification.requestPermission();

                    if (
                        permission === 'granted'
                    ) {

                        notificationsEnabled = true;

                        localStorage.setItem(
                            STORAGE_KEY_NOTIFICATIONS_ENABLED,
                            'true'
                        );

                    }

                    refreshNotifyButton();

                    return;

                }

                notificationsEnabled =
                    !notificationsEnabled;

                localStorage.setItem(
                    STORAGE_KEY_NOTIFICATIONS_ENABLED,
                    String(
                        notificationsEnabled
                    )
                );

                refreshNotifyButton();

            };

        const monitor =
            document.createElement('div');

        monitor.id =
            'grafana-monitor-status';

        monitor.style.display =
            'flex';

        monitor.style.alignItems =
            'center';

        monitor.style.gap =
            '8px';

        wrapper.appendChild(
            notifyButton
        );

        wrapper.appendChild(
            monitor
        );

        toolbar.prepend(wrapper);

        updateMonitorPanel();

    }

    function updateMonitorPanel() {

        cleanupOldHosts();

        cleanupOldRecentItems();

        const panel =
            document.getElementById(
                'grafana-monitor-status'
            );

        if (!panel) {
            return;
        }

        let statusText = 'ONLINE';

        let color = '#00ff88';

        if (
            monitorStatus === 'DELAY'
        ) {

            statusText = 'DELAY';

            color = '#ffcc00';

        }

        if (
            monitorStatus === 'OFFLINE'
        ) {

            statusText = 'OFFLINE';

            color = '#ff4444';

        }

        const uptime =
            formatDuration(
                Date.now() - metrics.startedAt
            );

        const stateTime =
            formatDuration(
                Date.now() - monitorStatusSince
            );

        const statusTooltip =
            `
Monitor ativo há:
${uptime}

Estado atual há:
${stateTime}
            `.trim();

        const hosts =
            Array.from(
                metrics.hosts.keys()
            );

        panel.innerHTML =
            `
            ${buildBadge(
                statusText,
                color,
                statusTooltip
            )}

            ${buildBadge(
                `Alertas: ${metrics.alerts}`,
                '#ffaa00'
            )}

            ${buildBadge(
                `Desastres: ${metrics.disasters}`,
                '#ff4444'
            )}

            ${buildBadge(
                `Hosts: ${hosts.length}`,
                '#00ccff'
            )}

            <button
                id="reset-metrics-button"
                style="
                    height:32px;
                    padding:0 12px;
                    border-radius:6px;
                    border:1px solid rgba(255,255,255,0.15);
                    background:rgba(255,255,255,0.04);
                    color:#ffffff;
                    font-size:12px;
                    font-weight:600;
                    cursor:pointer;
                    font-family:sans-serif;
                "
            >
                Resetar
            </button>
            `;

        const resetButton =
            document.getElementById(
                'reset-metrics-button'
            );

        if (resetButton) {

            resetButton.onclick =
                () => {

                    if (
                        confirm(
                            'Deseja resetar as métricas?'
                        )
                    ) {

                        resetMetrics();

                    }

                };

        }

        const badges =
            panel.querySelectorAll('div');

        const alertBadge = badges[1];

        const disasterBadge = badges[2];

        const hostsBadge = badges[3];

        if (alertBadge) {

            alertBadge.style.cursor =
                'pointer';

            alertBadge.onclick =
                () => {

                    createPopup(
                        alertBadge,
                        'Últimos Alertas',
                        [...recentAlerts]
                            .sort(
                                (a, b) =>
                                    b.timestamp - a.timestamp
                            )
                    );

                };

        }

        if (disasterBadge) {

            disasterBadge.style.cursor =
                'pointer';

            disasterBadge.onclick =
                () => {

                    createPopup(
                        disasterBadge,
                        'Últimos Desastres',
                        [...recentDisasters]
                            .sort(
                                (a, b) =>
                                    b.timestamp - a.timestamp
                            )
                    );

                };

        }

        if (hostsBadge) {

            hostsBadge.style.cursor =
                'pointer';

            hostsBadge.onclick =
                () => {

                    const uniqueHosts =
                        [];

                    const map =
                        new Set();

                    for (
                        const item
                        of [...recentHostsEvents]
                            .sort(
                                (a, b) =>
                                    b.timestamp - a.timestamp
                            )
                    ) {

                        if (
                            map.has(item.host)
                        ) {
                            continue;
                        }

                        map.add(item.host);

                        uniqueHosts.push(item);

                    }

                    createPopup(
                        hostsBadge,
                        'Hosts',
                        uniqueHosts,
                        true
                    );

                };

        }

    }

    /*
    =========================================================
    AUDIO
    =========================================================
    */

    async function ensureAudioContext(context) {

        if (
            context.state === 'suspended'
        ) {

            await context.resume();

        }

    }

    function createBeep(
        audioContext,
        frequency,
        duration,
        volume = 0.08
    ) {

        return new Promise(resolve => {

            const oscillator =
                audioContext.createOscillator();

            const gain =
                audioContext.createGain();

            oscillator.connect(gain);

            gain.connect(audioContext.destination);

            oscillator.type = 'sine';

            oscillator.frequency.value =
                frequency;

            gain.gain.value =
                volume;

            oscillator.start();

            setTimeout(() => {

                oscillator.stop();

                resolve();

            }, duration);

        });

    }

    async function playAlertSound(severity) {

        try {

            const audioContext =
                new (
                    window.AudioContext ||
                    window.webkitAudioContext
                )();

            await ensureAudioContext(
                audioContext
            );

            const total =
                severity === 'desastre'
                    ? 6
                    : 3;

            const frequency =
                severity === 'desastre'
                    ? 780
                    : 520;

            for (let i = 0; i < total; i++) {

                await createBeep(
                    audioContext,
                    frequency,
                    220,
                    0.12
                );

                await new Promise(
                    r => setTimeout(r, 120)
                );

            }

            setTimeout(() => {

                audioContext.close();

            }, 1000);

        } catch (err) {

            console.error(err);

        }

    }

    /*
    =========================================================
    NOTIFICATION
    =========================================================
    */

    async function showDesktopNotification(
        title,
        body,
        tag
    ) {

        try {

            if (
                Notification.permission !== 'granted'
            ) {

                const permission =
                    await Notification.requestPermission();

                if (
                    permission !== 'granted'
                ) {

                    throw new Error(
                        'Permissão negada'
                    );

                }

            }

            new Notification(
                title,
                {
                    body,
                    requireInteraction: true,
                    tag
                }
            );

        } catch {

            GM_notification({
                title,
                text: body,
                timeout: 15000
            });

        }

    }

    async function sendNotification(
        severity,
        host,
        problem,
        age,
        id
    ) {

        if (
            activeNotificationIds.has(id)
        ) {
            return;
        }

        activeNotificationIds.add(id);

        await saveNotification(id);

        metrics.alerts++;

        metrics.hosts.set(
            host,
            Date.now()
        );

        const item = {

            host,

            problem,

            timestamp: Date.now()

        };

        recentAlerts.push(item);

        recentHostsEvents.push(item);

        if (
            severity === 'desastre'
        ) {

            metrics.disasters++;

            recentDisasters.push(item);

        }

        saveMetricsDebounced();

        updateMonitorPanel();

        if (
            !notificationsEnabled
        ) {
            return;
        }

        const title =
            `ALERTA ${severity.toUpperCase()}`;

        const body =
            `${host}\n${problem}\n${age}`;

        await showDesktopNotification(
            title,
            body,
            id
        );

        await playAlertSound(severity);

    }

    /*
    =========================================================
    PROCESS
    =========================================================
    */

    async function fetchProblemsAPI() {

        try {

            const response = await fetch(
                '/api/datasources/2/resources/zabbix-api',
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'problem.get',
                        params: {
                            output: 'extend',
                            recent: true,
                            acknowledged: false,
                            sortfield: ['eventid'],
                            sortorder: 'DESC',
                            limit: 150
                        },
                        id: 1
                    })
                }
            );

            const json =
                await response.json();

            return (
                json &&
                Array.isArray(json.result)
            )
                ? json.result
                : [];

        } catch (error) {

            console.error(
                '[GrafanaAlert API]',
                error
            );

            return [];
        }

    }

    async function fetchTriggersHosts(
        triggerIds
    ) {

        try {

            const response = await fetch(
                '/api/datasources/2/resources/zabbix-api',
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'trigger.get',
                        params: {
                            output: [
                                'triggerid',
                                'description'
                            ],
                            triggerids: triggerIds,
                            selectHosts: [
                                'host'
                            ]
                        },
                        id: 2
                    })
                }
            );

            const json =
                await response.json();

            if (
                !json ||
                !Array.isArray(json.result)
            ) {

                return new Map();

            }

            const hostMap =
                new Map();

            for (const trigger of json.result) {

                hostMap.set(
                    String(trigger.triggerid),
                    trigger?.hosts?.[0]?.host ||
                    trigger?.description ||
                    'Host desconhecido'
                );

            }

            return hostMap;

        } catch (error) {

            console.error(
                '[GrafanaAlert trigger.get]',
                error
            );

            return new Map();

        }

    }

    async function processTable() {

        if (
            processingScan
        ) {

            const diff =
                Date.now() -
                processingStartedAt;

            if (
                diff > WATCHDOG_TIMEOUT
            ) {

                processingScan = false;

            } else {

                return;

            }

        }

        processingScan = true;

        processingStartedAt = Date.now();

        try {

            if (
                !isCorrectDashboard()
            ) {
                return;
            }

            createTopPanel();

            const problems =
                await fetchProblemsAPI();

            if (!Array.isArray(problems)) {
                return;
            }

            const triggerIds =
                [
                    ...new Set(
                        problems
                            .map(
                                event =>
                                    String(
                                        event.objectid
                                    )
                            )
                            .filter(Boolean)
                    )
                ];

            const hostsMap =
                await fetchTriggersHosts(
                    triggerIds
                );

            lastMutationTimestamp =
                Date.now();

            for (const event of problems) {

                if (
                    event.acknowledged !== '0'
                ) {
                    continue;
                }

                const severityNumber =
                    parseInt(event.severity);

                let severity = null;

                if (
                    severityNumber >= 5
                ) {

                    severity = 'desastre';

                } else if (
                    severityNumber >= 4
                ) {

                    severity = 'alta';

                }

                if (!severity) {
                    continue;
                }

                const host =
                    hostsMap.get(
                        String(
                            event.objectid
                        )
                    ) ||
                    event.name ||
                    'Host desconhecido';

                const ageSeconds =
                    (
                        Date.now() / 1000
                    ) -
                    parseInt(event.clock);

                const minutes =
                    ageSeconds / 60;

                if (
                    minutes > MAX_EVENT_MINUTES
                ) {
                    continue;
                }

                const age =
                    Math.floor(minutes) + 'm';

                const id =
                    `api_${event.eventid}`;

                const alreadyNotified =
                    await hasNotification(id);

                if (
                    alreadyNotified
                ) {
                    continue;
                }

                await sendNotification(
                    severity,
                    host,
                    event.name,
                    age,
                    id
                );

            }

        } catch (err) {

            console.error(err);

        } finally {

            processingScan = false;

        }

    }


    /*
    =========================================================
    STATUS
    =========================================================
    */

    function checkMonitorStatus() {

        const diff =
            Date.now() -
            lastMutationTimestamp;

        let newStatus = 'ONLINE';

        if (
            diff > OFFLINE_TIMEOUT
        ) {

            newStatus = 'OFFLINE';

        } else if (
            diff > DELAY_TIMEOUT
        ) {

            newStatus = 'DELAY';

        }

        if (
            newStatus !== monitorStatus
        ) {

            monitorStatus =
                newStatus;

            monitorStatusSince =
                Date.now();

        }

        updateMonitorPanel();

    }

    /*
    =========================================================
    OBSERVER
    =========================================================
    */

    let mutationDebounce;

    function initializeObserver() {

        observer =
            new MutationObserver(() => {

                lastMutationTimestamp =
                    Date.now();

                clearTimeout(
                    mutationDebounce
                );

                mutationDebounce =
                    setTimeout(
                        processTable,
                        1000
                    );

            });

        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );

    }

    /*
    =========================================================
    MENU
    =========================================================
    */

    function registerMenu() {

        GM_registerMenuCommand(
            '🧹 Limpar Cache',
            async () => {

                await clearAllCache();

                alert(
                    'Cache removido com sucesso.'
                );

            }
        );

        GM_registerMenuCommand(
            '🔔 Testar Alerta',
            async () => {

                await showDesktopNotification(
                    'TESTE ALERTA',
                    'Teste de alerta alta',
                    'teste-alerta'
                );

                await playAlertSound(
                    'alta'
                );

            }
        );

        GM_registerMenuCommand(
            '🚨 Testar Desastre',
            async () => {

                await showDesktopNotification(
                    'TESTE DESASTRE',
                    'Teste de desastre',
                    'teste-desastre'
                );

                await playAlertSound(
                    'desastre'
                );

            }
        );

    }

    /*
    =========================================================
    HEARTBEAT
    =========================================================
    */

    function startHeartbeat() {

        setInterval(() => {

            checkMonitorStatus();

            cleanupOldHosts();

            cleanupOldCache();

        }, HEARTBEAT_INTERVAL);

    }

    /*
    =========================================================
    INIT
    =========================================================
    */

    async function initialize() {

        await openDatabase();

        await cleanupOldCache();

        restoreMetrics();

        cleanupOldRecentItems();

        registerMenu();

        initializeObserver();

        createTopPanel();

        await processTable();

        startHeartbeat();

        setInterval(
            processTable,
            FALLBACK_SCAN_INTERVAL
        );

        console.log(
            `[GrafanaAlert ${SCRIPT_VERSION}] iniciado`
        );

    }

    /*
    =========================================================
    START
    =========================================================
    */

    setTimeout(() => {

        if (
            isCorrectDashboard()
        ) {

            initialize();

        }else{
        console.log(
            `[GrafanaAlert ${SCRIPT_VERSION}] Painel não correspondente!`
        );
        }

    }, 4000);

})();
