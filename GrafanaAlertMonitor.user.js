// ==UserScript==
// @name         Grafana NOC Alert Monitor
// @namespace    Grafana/RolimNet/Incidentes
// @version      4.8.0
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

    const SCRIPT_VERSION = '4.8.0';
    const REQUIRED_DASHBOARD_TITLE = '1 [ALERTAS] Eventos e Incidentes';
    const DB_NAME = 'GrafanaAlertDB';

    const STORE_NOTIFICATIONS = 'notifications';
    const STORE_ALERTS = 'alerts';
    const STORE_DISASTERS = 'disasters';
    const STORE_HOST_EVENTS = 'hostEvents';

    const STORAGE_KEY_SESSION_START = 'alertasgrafananoc_session_start';
    const STORAGE_KEY_METRICS = 'alertasgrafananoc_metrics';
    const STORAGE_KEY_NOTIFICATIONS_ENABLED = 'alertasgrafananoc_notifications_enabled';

    // 8760h = 1 ano
    const RETENTION_MS = 8760 * 60 * 60 * 1000;

    const MAX_EVENT_MINUTES = 5;
    const FALLBACK_SCAN_INTERVAL = 15000;
    const OFFLINE_TIMEOUT = 40000;
    const DELAY_TIMEOUT = 20000;
    const HEARTBEAT_INTERVAL = 30000;
    const WATCHDOG_TIMEOUT = 30000;
    const METRICS_SAVE_DEBOUNCE = 5000;
    const POPUP_PAGE_SIZE = 20;

    // ---- FLAP DETECTOR CONFIG ----
    // Dashboard OPGW uid para buscar os itemids dos paineis
    const FLAP_DASHBOARD_UID = 'EYe1bmNvz';
    // datasourceId do PostgreSQL/history_uint usado pelo painel OPGW
    const FLAP_DATASOURCE_ID = 3;
    // Numero de leituras historicas por interface para comparar (30min / 2min = 15 pontos)
    const FLAP_HISTORY_READINGS = 15;
    // Intervalo de busca de dados (ms)
    const FLAP_SCAN_INTERVAL = 60000;
    // Queda percentual minima entre leituras consecutivas para detectar flap
    // Ex: 0.70 = queda de 70% ou mais em relacao a leitura anterior
    const FLAP_DROP_THRESHOLD = 0.70;
    // ID do painel onde os cards de flap serao renderizados
    const FLAP_PANEL_ID = 'panel-240';

    // Dashboard de Links TRANSP
    const FLAP_LINKS_DASHBOARD_UID = 'a8vK2Qf7z';

    // Segmentos excluidos: se o label contiver qualquer uma dessas strings (case-insensitive), e ignorado
    // Adicione aqui novos padroes para excluir no futuro
    const FLAP_EXCLUDE_SEGMENTS = [
        'AGREGADO',
        'SOMA',
        'TOTAL',
        'TRANSP-INFOVIA - 100',
        'TRANSP. INFOVIA - SÃO PAULO',
        'INFOVIA - SÃO PAULO',
        'OLLA VILHENA',
    ];

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
    let sharedAudioContext = null;
    let mutationDebounce;

    let notificationsEnabled =
        localStorage.getItem(STORAGE_KEY_NOTIFICATIONS_ENABLED) !== 'false';

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
    SESSION START
    =========================================================
    */

    function initSessionStart() {
        if (!sessionStorage.getItem(STORAGE_KEY_SESSION_START)) {
            sessionStorage.setItem(STORAGE_KEY_SESSION_START, String(Date.now()));
        }
    }

    function getSessionStart() {
        return parseInt(
            sessionStorage.getItem(STORAGE_KEY_SESSION_START) || Date.now()
        );
    }

    /*
    =========================================================
    DATABASE
    =========================================================
    */

    function openDatabase() {
        return new Promise((resolve, reject) => {
            // Sempre abre sem versão fixa para evitar VersionError caso o banco
            // já esteja em versão superior (ex: instância antiga ainda aberta)
            const request = indexedDB.open(DB_NAME);

            request.onerror = () => reject(request.error);

            request.onsuccess = () => {
                db = request.result;
                const currentVersion = db.version;

                // Banco já está atualizado — apenas resolve
                if (
                    db.objectStoreNames.contains(STORE_NOTIFICATIONS) &&
                    db.objectStoreNames.contains(STORE_ALERTS) &&
                    db.objectStoreNames.contains(STORE_DISASTERS) &&
                    db.objectStoreNames.contains(STORE_HOST_EVENTS)
                ) {
                    resolve();
                    return;
                }

                // Precisa criar stores/índices — fecha e reabre com versão incrementada
                db.close();
                const upgrade = indexedDB.open(DB_NAME, currentVersion + 1);

                upgrade.onerror = () => reject(upgrade.error);
                upgrade.onsuccess = () => { db = upgrade.result; resolve(); };

                upgrade.onupgradeneeded = event => {
                    const database = event.target.result;
                    const tx = event.target.transaction;

                    if (!database.objectStoreNames.contains(STORE_NOTIFICATIONS)) {
                        const s = database.createObjectStore(STORE_NOTIFICATIONS, { keyPath: 'id' });
                        s.createIndex('by_timestamp', 'timestamp');
                    } else {
                        const s = tx.objectStore(STORE_NOTIFICATIONS);
                        if (!s.indexNames.contains('by_timestamp')) {
                            s.createIndex('by_timestamp', 'timestamp');
                        }
                    }

                    [STORE_ALERTS, STORE_DISASTERS, STORE_HOST_EVENTS].forEach(name => {
                        if (!database.objectStoreNames.contains(name)) {
                            const s = database.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
                            s.createIndex('by_timestamp', 'timestamp');
                        }
                    });
                };
            };

            request.onupgradeneeded = event => {
                const database = event.target.result;
                const tx = event.target.transaction;

                if (!database.objectStoreNames.contains(STORE_NOTIFICATIONS)) {
                    const s = database.createObjectStore(STORE_NOTIFICATIONS, { keyPath: 'id' });
                    s.createIndex('by_timestamp', 'timestamp');
                } else {
                    const s = tx.objectStore(STORE_NOTIFICATIONS);
                    if (!s.indexNames.contains('by_timestamp')) {
                        s.createIndex('by_timestamp', 'timestamp');
                    }
                }

                [STORE_ALERTS, STORE_DISASTERS, STORE_HOST_EVENTS].forEach(name => {
                    if (!database.objectStoreNames.contains(name)) {
                        const s = database.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
                        s.createIndex('by_timestamp', 'timestamp');
                    }
                });
            };
        });
    }

    function getStore(storeName, mode = 'readonly') {
        return db.transaction(storeName, mode).objectStore(storeName);
    }

    async function saveNotification(id) {
        return new Promise((resolve, reject) => {
            const req = getStore(STORE_NOTIFICATIONS, 'readwrite').put({ id, timestamp: Date.now() });
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async function hasNotification(id) {
        return new Promise((resolve, reject) => {
            const req = getStore(STORE_NOTIFICATIONS).get(id);

            req.onsuccess = async () => {
                const data = req.result;
                if (!data) { resolve(false); return; }
                if (Date.now() - data.timestamp > RETENTION_MS) {
                    await removeNotification(id);
                    activeNotificationIds.delete(id);
                    resolve(false);
                    return;
                }
                resolve(true);
            };

            req.onerror = () => reject(req.error);
        });
    }

    async function removeNotification(id) {
        return new Promise((resolve, reject) => {
            const req = getStore(STORE_NOTIFICATIONS, 'readwrite').delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async function clearAllCache() {
        return new Promise((resolve, reject) => {
            const req = getStore(STORE_NOTIFICATIONS, 'readwrite').clear();
            req.onsuccess = () => { activeNotificationIds.clear(); resolve(); };
            req.onerror = () => reject(req.error);
        });
    }

    async function cleanupOldCache() {
        const stores = [STORE_NOTIFICATIONS, STORE_ALERTS, STORE_DISASTERS, STORE_HOST_EVENTS];
        const cutoff = Date.now() - RETENTION_MS;

        for (const storeName of stores) {
            await new Promise(resolve => {
                const store = getStore(storeName, 'readwrite');

                // Usa índice se disponível (v2), senão cursor completo (fallback v1)
                const cursorReq = store.indexNames.contains('by_timestamp')
                    ? store.index('by_timestamp').openCursor(IDBKeyRange.upperBound(cutoff))
                    : store.openCursor();

                cursorReq.onsuccess = event => {
                    const cur = event.target.result;
                    if (!cur) { resolve(); return; }

                    const age = Date.now() - (cur.value.timestamp || 0);
                    if (age > RETENTION_MS) {
                        if (storeName === STORE_NOTIFICATIONS) {
                            activeNotificationIds.delete(cur.value.id);
                        }
                        cur.delete();
                    }

                    cur.continue();
                };

                cursorReq.onerror = () => resolve();
            });
        }
    }

    async function saveHistoryItem(storeName, item) {
        return new Promise((resolve, reject) => {
            const req = getStore(storeName, 'readwrite').add({
                ...item,
                timestamp: item.timestamp || Date.now()
            });
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async function loadHistoryFromDB(storeName) {
        return new Promise((resolve) => {
            const items = [];
            const store = getStore(storeName);

            // Usa índice se disponível, senão cursor completo como fallback
            const cursorReq = store.indexNames.contains('by_timestamp')
                ? store.index('by_timestamp').openCursor(null, 'prev')
                : store.openCursor(null, 'prev');

            cursorReq.onsuccess = event => {
                const cur = event.target.result;
                if (!cur) { resolve(items); return; }
                items.push(cur.value);
                cur.continue();
            };

            cursorReq.onerror = () => resolve(items);
        });
    }

    async function clearHistoryStore(storeName) {
        return new Promise((resolve, reject) => {
            const req = getStore(storeName, 'readwrite').clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    /*
    =========================================================
    METRICS
    =========================================================
    */

    function saveMetrics() {
        const hosts = [];
        for (const [host, timestamp] of metrics.hosts) {
            hosts.push({ host, timestamp });
        }
        localStorage.setItem(STORAGE_KEY_METRICS, JSON.stringify({
            alerts: metrics.alerts,
            disasters: metrics.disasters,
            hosts,
            startedAt: metrics.startedAt
        }));
    }

    function saveMetricsDebounced() {
        clearTimeout(metricsSaveTimeout);
        metricsSaveTimeout = setTimeout(saveMetrics, METRICS_SAVE_DEBOUNCE);
    }

    function restoreMetrics() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_METRICS);
            if (!raw) return;

            const parsed = JSON.parse(raw);
            metrics.alerts = parsed.alerts || 0;
            metrics.disasters = parsed.disasters || 0;
            metrics.startedAt = parsed.startedAt || Date.now();
            metrics.hosts = new Map();

            if (Array.isArray(parsed.hosts)) {
                for (const item of parsed.hosts) {
                    metrics.hosts.set(item.host, item.timestamp);
                }
            }
        } catch (err) {
            console.error('[GrafanaAlert] restoreMetrics:', err);
        }
    }

    async function restoreHistoryFromDB() {
        try {
            const [alerts, disasters, hostEvents] = await Promise.all([
                loadHistoryFromDB(STORE_ALERTS),
                loadHistoryFromDB(STORE_DISASTERS),
                loadHistoryFromDB(STORE_HOST_EVENTS)
            ]);

            // Se o IndexedDB ainda está vazio (primeira execução da v4.7.0),
            // migra o histórico que estava salvo no localStorage (versões anteriores)
            if (alerts.length === 0 && disasters.length === 0 && hostEvents.length === 0) {
                await migrateLegacyHistory();

                const [migratedAlerts, migratedDisasters, migratedHostEvents] = await Promise.all([
                    loadHistoryFromDB(STORE_ALERTS),
                    loadHistoryFromDB(STORE_DISASTERS),
                    loadHistoryFromDB(STORE_HOST_EVENTS)
                ]);

                recentAlerts.push(...migratedAlerts);
                recentDisasters.push(...migratedDisasters);
                recentHostsEvents.push(...migratedHostEvents);
                return;
            }

            recentAlerts.push(...alerts);
            recentDisasters.push(...disasters);
            recentHostsEvents.push(...hostEvents);
        } catch (err) {
            console.error('[GrafanaAlert] restoreHistoryFromDB:', err);
        }
    }

    // Migração única: move recentAlerts/Disasters/HostEvents do localStorage para o IndexedDB
    async function migrateLegacyHistory() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_METRICS);
            if (!raw) return;

            const parsed = JSON.parse(raw);

            const saveAll = async (storeName, array) => {
                if (!Array.isArray(array) || array.length === 0) return;
                for (const item of array) {
                    await saveHistoryItem(storeName, item).catch(() => {});
                }
            };

            await saveAll(STORE_ALERTS, parsed.recentAlerts);
            await saveAll(STORE_DISASTERS, parsed.recentDisasters);
            await saveAll(STORE_HOST_EVENTS, parsed.recentHostsEvents);

            console.log('[GrafanaAlert] Histórico migrado do localStorage para IndexedDB');
        } catch (err) {
            console.error('[GrafanaAlert] migrateLegacyHistory:', err);
        }
    }

    function cleanupOldHosts() {
        for (const [host, timestamp] of metrics.hosts) {
            if (Date.now() - timestamp > RETENTION_MS) {
                metrics.hosts.delete(host);
            }
        }
    }

    async function resetMetrics() {
        metrics.alerts = 0;
        metrics.disasters = 0;
        metrics.hosts.clear();
        metrics.startedAt = Date.now();
        recentAlerts.length = 0;
        recentDisasters.length = 0;
        recentHostsEvents.length = 0;

        await Promise.all([
            clearAllCache(),
            clearHistoryStore(STORE_ALERTS),
            clearHistoryStore(STORE_DISASTERS),
            clearHistoryStore(STORE_HOST_EVENTS)
        ]);

        saveMetrics();
        updateMonitorPanel();
    }

    /*
    =========================================================
    HELPERS
    =========================================================
    */

    function formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        parts.push(`${minutes}min`);
        return parts.join(' ');
    }

    /*
    =========================================================
    VALIDATION
    =========================================================
    */

    function isCorrectDashboard() {
        return document.title.includes(REQUIRED_DASHBOARD_TITLE) ||
            document.body.innerText.includes(REQUIRED_DASHBOARD_TITLE);
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
            document.removeEventListener('mousedown', popupOutsideClickHandler);
            popupOutsideClickHandler = null;
        }
        if (popupEscHandler) {
            document.removeEventListener('keydown', popupEscHandler);
            popupEscHandler = null;
        }
    }

    function positionPopup(popup, anchor) {
        const rect = anchor.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let top = rect.bottom + 8;
        let left = rect.left;

        popup.style.visibility = 'hidden';
        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
        document.body.appendChild(popup);

        const popupRect = popup.getBoundingClientRect();

        if (left + popupRect.width > viewportWidth - 8) {
            left = Math.max(8, rect.right - popupRect.width);
        }
        if (top + popupRect.height > viewportHeight - 8) {
            top = Math.max(8, rect.top - popupRect.height - 8);
        }

        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
        popup.style.visibility = 'visible';
    }

    function createPopup(anchor, title, items, enableHostClick = false) {
        destroyPopup();

        const popup = document.createElement('div');
        popup.style.position = 'fixed';
        popup.style.zIndex = '999999';
        popup.style.width = '420px';
        popup.style.maxHeight = '500px';
        popup.style.overflowY = 'auto';
        popup.style.background = '#111217';
        popup.style.border = '1px solid rgba(255,255,255,0.10)';
        popup.style.borderRadius = '10px';
        popup.style.padding = '12px';
        popup.style.boxShadow = '0 0 18px rgba(0,0,0,0.45)';
        popup.style.fontFamily = 'sans-serif';
        popup.style.color = '#fff';
        popup.style.fontSize = '12px';

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.marginBottom = '10px';

        const titleElement = document.createElement('div');
        titleElement.innerText = title;
        titleElement.style.fontWeight = '700';

        const closeButton = document.createElement('button');
        closeButton.innerText = 'Fechar';
        closeButton.style.border = '1px solid rgba(255,255,255,0.15)';
        closeButton.style.background = 'rgba(255,255,255,0.04)';
        closeButton.style.color = '#ffffff';
        closeButton.style.borderRadius = '6px';
        closeButton.style.padding = '4px 10px';
        closeButton.style.cursor = 'pointer';
        closeButton.onclick = destroyPopup;

        header.appendChild(titleElement);
        header.appendChild(closeButton);
        popup.appendChild(header);

        if (!items.length) {
            const empty = document.createElement('div');
            empty.innerText = 'Nenhum item encontrado';
            empty.style.opacity = '0.7';
            popup.appendChild(empty);
        } else {
            let currentPage = 0;
            const totalPages = Math.ceil(items.length / POPUP_PAGE_SIZE);
            const listContainer = document.createElement('div');
            popup.appendChild(listContainer);

            const pager = document.createElement('div');
            pager.style.display = 'flex';
            pager.style.justifyContent = 'space-between';
            pager.style.alignItems = 'center';
            pager.style.marginTop = '10px';
            pager.style.paddingTop = '8px';
            pager.style.borderTop = '1px solid rgba(255,255,255,0.08)';

            const btnPrev = document.createElement('button');
            btnPrev.innerText = '← Anterior';
            btnPrev.style.border = '1px solid rgba(255,255,255,0.15)';
            btnPrev.style.background = 'rgba(255,255,255,0.04)';
            btnPrev.style.color = '#fff';
            btnPrev.style.borderRadius = '6px';
            btnPrev.style.padding = '4px 10px';
            btnPrev.style.cursor = 'pointer';
            btnPrev.style.fontSize = '11px';

            const pageInfo = document.createElement('div');
            pageInfo.style.fontSize = '11px';
            pageInfo.style.opacity = '0.6';

            const btnNext = document.createElement('button');
            btnNext.innerText = 'Próximo →';
            btnNext.style.border = '1px solid rgba(255,255,255,0.15)';
            btnNext.style.background = 'rgba(255,255,255,0.04)';
            btnNext.style.color = '#fff';
            btnNext.style.borderRadius = '6px';
            btnNext.style.padding = '4px 10px';
            btnNext.style.cursor = 'pointer';
            btnNext.style.fontSize = '11px';

            function renderPage(page) {
                currentPage = page;
                listContainer.innerHTML = '';

                const start = page * POPUP_PAGE_SIZE;
                const end = Math.min(start + POPUP_PAGE_SIZE, items.length);
                const slice = items.slice(start, end);

                for (const item of slice) {
                    const card = document.createElement('div');
                    card.style.padding = '10px';
                    card.style.borderRadius = '8px';
                    card.style.background = 'rgba(255,255,255,0.03)';
                    card.style.marginBottom = '8px';
                    card.style.border = '1px solid rgba(255,255,255,0.05)';

                    const hostEl = document.createElement('div');
                    hostEl.innerText = item.host;
                    hostEl.style.fontWeight = '700';
                    hostEl.style.marginBottom = '5px';

                    if (enableHostClick) {
                        hostEl.style.cursor = 'pointer';
                        hostEl.style.color = '#7dcfff';
                        hostEl.onclick = () => {
                            const hostItems = recentHostsEvents
                                .filter(h => h.host === item.host)
                                .sort((a, b) => b.timestamp - a.timestamp);
                            createPopup(hostEl, `Host: ${item.host}`, hostItems, false);
                        };
                    }

                    const problemEl = document.createElement('div');
                    problemEl.innerText = item.problem || '';
                    problemEl.style.opacity = '0.88';
                    problemEl.style.marginBottom = '6px';

                    const timeEl = document.createElement('div');
                    timeEl.innerText = formatDuration(Date.now() - item.timestamp);
                    timeEl.style.fontSize = '11px';
                    timeEl.style.opacity = '0.55';

                    card.appendChild(hostEl);
                    card.appendChild(problemEl);
                    card.appendChild(timeEl);
                    listContainer.appendChild(card);
                }

                pageInfo.innerText = `${page + 1} / ${totalPages}`;
                btnPrev.disabled = page === 0;
                btnNext.disabled = page >= totalPages - 1;
                btnPrev.style.opacity = page === 0 ? '0.3' : '1';
                btnNext.style.opacity = page >= totalPages - 1 ? '0.3' : '1';
                popup.scrollTop = 0;
            }

            btnPrev.onclick = () => { if (currentPage > 0) renderPage(currentPage - 1); };
            btnNext.onclick = () => { if (currentPage < totalPages - 1) renderPage(currentPage + 1); };

            pager.appendChild(btnPrev);
            pager.appendChild(pageInfo);
            pager.appendChild(btnNext);
            popup.appendChild(pager);

            renderPage(0);

            if (totalPages <= 1) pager.style.display = 'none';
        }

        positionPopup(popup, anchor);
        currentPopup = popup;

        popupOutsideClickHandler = event => {
            if (currentPopup && !currentPopup.contains(event.target) && event.target !== anchor) {
                destroyPopup();
            }
        };

        popupEscHandler = event => {
            if (event.key === 'Escape') destroyPopup();
        };

        document.addEventListener('mousedown', popupOutsideClickHandler);
        document.addEventListener('keydown', popupEscHandler);
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
            border:1px solid ${active ? 'rgba(0,255,120,0.30)' : 'rgba(255,80,80,0.30)'};
            background:${active ? 'rgba(0,255,120,0.08)' : 'rgba(255,0,0,0.08)'};
            color:${active ? '#7dffab' : '#ffb3b3'};
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
        if (document.getElementById('grafana-alert-toolbar')) return;

        const toolbar = document.querySelector('.css-g72xnk');
        if (!toolbar) return;

        const wrapper = document.createElement('div');
        wrapper.id = 'grafana-alert-toolbar';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '8px';
        wrapper.style.marginRight = '12px';

        const notifyButton = document.createElement('button');
        notifyButton.id = 'grafana-notify-button';

        function refreshNotifyButton() {
            const hasPermission = Notification.permission === 'granted';
            notifyButton.innerText = hasPermission
                ? (notificationsEnabled ? 'Notificações Ativas' : 'Notificações Pausadas')
                : 'Permitir Notificações';
            notifyButton.style.cssText = getBadgeStyle(hasPermission && notificationsEnabled);
        }

        refreshNotifyButton();

        notifyButton.onclick = async () => {
            if (Notification.permission !== 'granted') {
                const permission = await Notification.requestPermission();
                if (permission === 'granted') {
                    notificationsEnabled = true;
                    localStorage.setItem(STORAGE_KEY_NOTIFICATIONS_ENABLED, 'true');
                }
                refreshNotifyButton();
                return;
            }
            notificationsEnabled = !notificationsEnabled;
            localStorage.setItem(STORAGE_KEY_NOTIFICATIONS_ENABLED, String(notificationsEnabled));
            refreshNotifyButton();
        };

        const monitor = document.createElement('div');
        monitor.id = 'grafana-monitor-status';
        monitor.style.display = 'flex';
        monitor.style.alignItems = 'center';
        monitor.style.gap = '8px';

        wrapper.appendChild(notifyButton);
        wrapper.appendChild(monitor);
        toolbar.prepend(wrapper);

        updateMonitorPanel();
    }

    function updateMonitorPanel() {
        cleanupOldHosts();

        const panel = document.getElementById('grafana-monitor-status');
        if (!panel) return;

        let statusText = 'ONLINE';
        let color = '#00ff88';

        if (monitorStatus === 'DELAY') {
            statusText = 'DELAY';
            color = '#ffcc00';
        }

        if (monitorStatus === 'OFFLINE') {
            statusText = 'OFFLINE';
            color = '#ff4444';
        }

        const sessionUptime = formatDuration(Date.now() - getSessionStart());
        const metricsUptime = formatDuration(Date.now() - metrics.startedAt);
        const stateTime = formatDuration(Date.now() - monitorStatusSince);

        const statusTooltip = [
            `Monitor ativo há:\n${sessionUptime}`,
            `Métricas desde:\n${metricsUptime}`,
            `Estado atual há:\n${stateTime}`
        ].join('\n\n');

        const hosts = Array.from(metrics.hosts.keys());

        panel.innerHTML = `
            ${buildBadge(statusText, color, statusTooltip)}
            ${buildBadge(`Alertas: ${metrics.alerts}`, '#ffaa00')}
            ${buildBadge(`Desastres: ${metrics.disasters}`, '#ff4444')}
            ${buildBadge(`Hosts: ${hosts.length}`, '#00ccff')}
        `;

        const badges = panel.querySelectorAll('div');
        const alertBadge = badges[1];
        const disasterBadge = badges[2];
        const hostsBadge = badges[3];

        if (alertBadge) {
            alertBadge.style.cursor = 'pointer';
            alertBadge.onclick = () => {
                createPopup(
                    alertBadge,
                    'Últimos Alertas',
                    [...recentAlerts].sort((a, b) => b.timestamp - a.timestamp)
                );
            };
        }

        if (disasterBadge) {
            disasterBadge.style.cursor = 'pointer';
            disasterBadge.onclick = () => {
                createPopup(
                    disasterBadge,
                    'Últimos Desastres',
                    [...recentDisasters].sort((a, b) => b.timestamp - a.timestamp)
                );
            };
        }

        if (hostsBadge) {
            hostsBadge.style.cursor = 'pointer';
            hostsBadge.onclick = () => {
                const uniqueHosts = [];
                const seen = new Set();
                for (const item of [...recentHostsEvents].sort((a, b) => b.timestamp - a.timestamp)) {
                    if (seen.has(item.host)) continue;
                    seen.add(item.host);
                    uniqueHosts.push(item);
                }
                createPopup(hostsBadge, 'Hosts', uniqueHosts, true);
            };
        }
    }

    /*
    =========================================================
    AUDIO
    =========================================================
    */

    function getAudioContext() {
        if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
            sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        return sharedAudioContext;
    }

    async function ensureAudioContext(context) {
        if (context.state === 'suspended') await context.resume();
    }

    function createBeep(audioContext, frequency, duration, volume = 0.08) {
        return new Promise(resolve => {
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();

            oscillator.connect(gain);
            gain.connect(audioContext.destination);
            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            gain.gain.value = volume;
            oscillator.start();

            setTimeout(() => { oscillator.stop(); resolve(); }, duration);
        });
    }

    async function playAlertSound(severity) {
        try {
            const audioContext = getAudioContext();
            await ensureAudioContext(audioContext);

            const total = severity === 'desastre' ? 6 : 3;
            const frequency = severity === 'desastre' ? 780 : 520;

            for (let i = 0; i < total; i++) {
                await createBeep(audioContext, frequency, 220, 0.12);
                await new Promise(r => setTimeout(r, 120));
            }
        } catch (err) {
            console.error('[GrafanaAlert] playAlertSound:', err);
        }
    }

    /*
    =========================================================
    NOTIFICATION
    =========================================================
    */

    async function showDesktopNotification(title, body, tag) {
        try {
            if (Notification.permission !== 'granted') {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') throw new Error('Permissão negada');
            }
            new Notification(title, { body, requireInteraction: true, tag });
        } catch {
            GM_notification({ title, text: body, timeout: 15000 });
        }
    }

    async function sendNotification(severity, host, problem, age, id) {
        if (activeNotificationIds.has(id)) return;

        activeNotificationIds.add(id);
        await saveNotification(id);

        metrics.alerts++;
        metrics.hosts.set(host, Date.now());

        const item = { host, problem, timestamp: Date.now() };

        recentAlerts.push(item);
        recentHostsEvents.push(item);

        await saveHistoryItem(STORE_ALERTS, item);
        await saveHistoryItem(STORE_HOST_EVENTS, item);

        if (severity === 'desastre') {
            metrics.disasters++;
            recentDisasters.push(item);
            await saveHistoryItem(STORE_DISASTERS, item);
        }

        saveMetricsDebounced();
        updateMonitorPanel();

        if (!notificationsEnabled) return;

        const title = `ALERTA ${severity.toUpperCase()}`;
        const body = `${host}\n${problem}\n${age}`;

        await showDesktopNotification(title, body, id);
        await playAlertSound(severity);
    }

    /*
    =========================================================
    PROCESS
    =========================================================
    */

    async function fetchProblemsAPI() {
        try {
            const response = await fetch('/api/datasources/2/resources/zabbix-api', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
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
            });
            const json = await response.json();
            return (json && Array.isArray(json.result)) ? json.result : [];
        } catch (error) {
            console.error('[GrafanaAlert] fetchProblemsAPI:', error);
            return [];
        }
    }

    async function fetchTriggersHosts(triggerIds) {
        try {
            const response = await fetch('/api/datasources/2/resources/zabbix-api', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'trigger.get',
                    params: {
                        output: ['triggerid', 'description'],
                        triggerids: triggerIds,
                        selectHosts: ['host']
                    },
                    id: 2
                })
            });

            const json = await response.json();
            if (!json || !Array.isArray(json.result)) return new Map();

            const hostMap = new Map();
            for (const trigger of json.result) {
                hostMap.set(
                    String(trigger.triggerid),
                    trigger?.hosts?.[0]?.host || trigger?.description || 'Host desconhecido'
                );
            }
            return hostMap;
        } catch (error) {
            console.error('[GrafanaAlert] fetchTriggersHosts:', error);
            return new Map();
        }
    }

    async function processTable() {
        if (processingScan) {
            if (Date.now() - processingStartedAt > WATCHDOG_TIMEOUT) {
                processingScan = false;
            } else {
                return;
            }
        }

        processingScan = true;
        processingStartedAt = Date.now();

        try {
            if (!isCorrectDashboard()) return;

            createTopPanel();

            const problems = await fetchProblemsAPI();
            if (!Array.isArray(problems)) return;

            const triggerIds = [
                ...new Set(problems.map(event => String(event.objectid)).filter(Boolean))
            ];

            const hostsMap = await fetchTriggersHosts(triggerIds);
            lastMutationTimestamp = Date.now();

            const candidates = problems.filter(event => {
                if (event.acknowledged !== '0') return false;
                const sev = parseInt(event.severity);
                if (sev < 4) return false;
                const ageSeconds = (Date.now() / 1000) - parseInt(event.clock);
                if ((ageSeconds / 60) > MAX_EVENT_MINUTES) return false;
                return true;
            });

            const notifiedFlags = await Promise.all(
                candidates.map(event => hasNotification(`api_${event.eventid}`))
            );

            for (let i = 0; i < candidates.length; i++) {
                if (notifiedFlags[i]) continue;

                const event = candidates[i];
                const severity = parseInt(event.severity) >= 5 ? 'desastre' : 'alta';
                const host = hostsMap.get(String(event.objectid)) || event.name || 'Host desconhecido';
                const ageSeconds = (Date.now() / 1000) - parseInt(event.clock);
                const age = Math.floor(ageSeconds / 60) + 'm';
                const id = `api_${event.eventid}`;

                await sendNotification(severity, host, event.name, age, id);
            }
        } catch (err) {
            console.error('[GrafanaAlert] processTable:', err);
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
        const diff = Date.now() - lastMutationTimestamp;
        let newStatus = 'ONLINE';

        if (diff > OFFLINE_TIMEOUT) newStatus = 'OFFLINE';
        else if (diff > DELAY_TIMEOUT) newStatus = 'DELAY';

        if (newStatus !== monitorStatus) {
            monitorStatus = newStatus;
            monitorStatusSince = Date.now();
        }

        updateMonitorPanel();
    }

    /*
    =========================================================
    OBSERVER
    =========================================================
    */

    function initializeObserver() {
        const target = document.querySelector('#panel-10') || document.body;

        observer = new MutationObserver(() => {
            lastMutationTimestamp = Date.now();
            clearTimeout(mutationDebounce);
            mutationDebounce = setTimeout(processTable, 1000);
        });

        observer.observe(target, { childList: true, subtree: true });
    }

    /*
    =========================================================
    MENU
    =========================================================
    */

    function registerMenu() {
        GM_registerMenuCommand('🧹 Limpar Cache', async () => {
            await clearAllCache();
            alert('Cache removido com sucesso.');
        });

        GM_registerMenuCommand('🔄 Resetar Métricas', async () => {
            if (confirm('Deseja resetar todas as métricas e histórico?')) {
                await resetMetrics();
                alert('Métricas resetadas com sucesso.');
            }
        });

        GM_registerMenuCommand('🔔 Testar Alerta', async () => {
            await showDesktopNotification('TESTE ALERTA', 'Teste de alerta alta', 'teste-alerta');
            await playAlertSound('alta');
        });

        GM_registerMenuCommand('🚨 Testar Desastre', async () => {
            await showDesktopNotification('TESTE DESASTRE', 'Teste de desastre', 'teste-desastre');
            await playAlertSound('desastre');
        });
    }

    /*
    =========================================================
    AUDIO UNLOCK + WAKE LOCK
    =========================================================
    */

    let audioUnlocked = false;
    let wakeLockSentinel = null;

    // Desbloqueia o AudioContext na primeira interacao do usuario
    function setupAudioUnlock() {
        const unlock = async () => {
            if (audioUnlocked) return;
            try {
                const ctx = getAudioContext();
                if (ctx.state === 'suspended') {
                    await ctx.resume();
                }
                audioUnlocked = true;
                console.log('[GrafanaAlert] AudioContext desbloqueado pela interacao do usuario');
            } catch (err) {
                console.error('[GrafanaAlert] setupAudioUnlock:', err);
            }
        };

        // Escuta qualquer interacao na pagina
        ['click', 'keydown', 'touchstart', 'mousedown'].forEach(event => {
            document.addEventListener(event, unlock, { once: false, passive: true });
        });
    }

    // Solicita WakeLock para manter a aba ativa e evitar suspensao
    async function requestWakeLock() {
        if (!('wakeLock' in navigator)) {
            console.warn('[GrafanaAlert] WakeLock nao suportado neste browser');
            return;
        }
        try {
            wakeLockSentinel = await navigator.wakeLock.request('screen');
            console.log('[GrafanaAlert] WakeLock ativo');

            // Re-solicita o WakeLock se a visibilidade da pagina mudar (ex: volta do background)
            document.addEventListener('visibilitychange', async () => {
                if (document.visibilityState === 'visible' && wakeLockSentinel === null) {
                    try {
                        wakeLockSentinel = await navigator.wakeLock.request('screen');
                        console.log('[GrafanaAlert] WakeLock reativado');
                    } catch (err) {
                        console.error('[GrafanaAlert] WakeLock reativacao:', err);
                    }
                }
            });

            wakeLockSentinel.addEventListener('release', () => {
                wakeLockSentinel = null;
                console.log('[GrafanaAlert] WakeLock liberado');
            });
        } catch (err) {
            // WakeLock pode falhar se a pagina nao estiver visivel ou permissao negada
            console.warn('[GrafanaAlert] WakeLock nao disponivel:', err.message);
        }
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
        initSessionStart();

        await openDatabase();
        await cleanupOldCache();

        restoreMetrics();
        await restoreHistoryFromDB();

        registerMenu();
        initializeObserver();
        createTopPanel();

        // Desbloqueia audio na primeira interacao e ativa wake lock
        setupAudioUnlock();
        await requestWakeLock();

        await processTable();

        startHeartbeat();
        setInterval(processTable, FALLBACK_SCAN_INTERVAL);

        startFlapDetector();

        console.log(`[GrafanaAlert ${SCRIPT_VERSION}] iniciado`);
    }


    /*
    =========================================================
    FLAP DETECTOR STATE
    =========================================================
    */

    // Mapa de historico de leituras por itemid: itemid -> number[]
    const flapHistory = new Map();
    // Altura ja aplicada ao panel-240 (evita acumular delta a cada render)
    let flapPanelAppliedHeight = 106;
    // Mapa de estado de flap por segmento: label -> { flapping, flapCount, lastSeen }
    const flapState = new Map();
    // Segmentos extraidos do dashboard OPGW
    let flapSegments = [];

    /*
    =========================================================
    FLAP DETECTOR - HELPERS
    =========================================================
    */



    // Formata bytes em unidade legivel (b/s, Kb/s, Mb/s, Gb/s)
    function formatBps(bitsPerSec) {
        if (bitsPerSec === null || bitsPerSec === undefined) return 'N/A';
        const v = Math.abs(bitsPerSec);
        if (v >= 1e9) return (bitsPerSec / 1e9).toFixed(2) + ' Gb/s';
        if (v >= 1e6) return (bitsPerSec / 1e6).toFixed(2) + ' Mb/s';
        if (v >= 1e3) return (bitsPerSec / 1e3).toFixed(2) + ' Kb/s';
        return bitsPerSec.toFixed(0) + ' b/s';
    }

    // Detecta flap em array de leituras consecutivas
    // Criterios (ambos necessarios):
    //   1. Queda >= FLAP_DROP_THRESHOLD em pelo menos 2 leituras consecutivas
    //   2. Apos a queda, o valor sobe novamente (oscilacao real confirmada)
    // Retorna { flapping: bool, dropCount: number, lastDrop: number|null }
    function detectFlap(readings) {
        if (!readings || readings.length < 3) return { flapping: false, dropCount: 0, lastDrop: null };

        // Filtra zeros isolados que podem ser artefatos de coleta (ponto nulo interpolado)
        const filtered = readings.filter((v, i) => {
            if (v === 0 && i > 0 && i < readings.length - 1) {
                // Zero entre dois valores positivos = artefato, ignora
                return readings[i - 1] > 0 && readings[i + 1] > 0 ? false : true;
            }
            return true;
        });

        if (filtered.length < 3) return { flapping: false, dropCount: 0, lastDrop: null };

        let dropCount = 0;
        let lastDrop = null;
        let consecutiveDrops = 0;
        let hasRecovery = false;
        let inDrop = false;

        for (let i = 1; i < filtered.length; i++) {
            const prev = filtered[i - 1];
            const curr = filtered[i];

            if (prev > 0 && curr >= 0) {
                const drop = (prev - curr) / prev;

                if (drop >= FLAP_DROP_THRESHOLD) {
                    consecutiveDrops++;
                    lastDrop = drop;
                    inDrop = true;
                } else {
                    if (inDrop && curr > prev * (1 - FLAP_DROP_THRESHOLD)) {
                        // Valor subiu apos queda — oscilacao real confirmada
                        hasRecovery = true;
                        if (consecutiveDrops >= 2) dropCount += consecutiveDrops;
                    }
                    consecutiveDrops = 0;
                    inDrop = false;
                }
            }
        }

        // Criterio: precisa de 2+ quedas consecutivas E pelo menos uma recuperacao
        const flapping = dropCount >= 2 && hasRecovery;
        return { flapping, dropCount, lastDrop };
    }

    /*
    =========================================================
    FLAP DETECTOR - API
    =========================================================
    */

    // Verifica se um label de segmento deve ser excluido
    function isExcludedSegment(label) {
        const upper = label.toUpperCase();
        return FLAP_EXCLUDE_SEGMENTS.some(p => upper.includes(p.toUpperCase()));
    }

    // Resolve o itemid real via API Zabbix buscando pelo nome exato do item
    async function resolveItemId(target) {
        try {
            const itemFilter = target?.item?.filter || '';
            if (!itemFilter) return null;

            const resp = await fetch('/api/datasources/2/resources/zabbix-api', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'item.get',
                    params: {
                        output: ['itemid', 'name'],
                        search: { name: itemFilter },
                        searchWildcardsEnabled: true,
                        limit: 1
                    },
                    id: 10
                })
            });

            const json = await resp.json();
            if (json?.result?.length > 0) {
                const id = parseInt(json.result[0].itemid);
                console.log(`[GrafanaAlert] resolveItemId: "${itemFilter}" -> ${id}`);
                return id;
            }
            console.warn(`[GrafanaAlert] resolveItemId: item nao encontrado para "${itemFilter}"`);
            return null;
        } catch (err) {
            console.error('[GrafanaAlert] resolveItemId:', err);
            return null;
        }
    }

    // Busca os itemids dos paineis do dashboard OPGW via API do Grafana + Zabbix
    async function fetchOPGWSegments() {
        try {
            const resp = await fetch(`/api/dashboards/uid/${FLAP_DASHBOARD_UID}`, {
                credentials: 'include'
            });
            const data = await resp.json();
            const panels = data?.dashboard?.panels || [];
            const segments = [];

            // Paineis text com titulo nao vazio sao os labels dos segmentos
            // O titulo vem com aspas duplas no JSON: '"PVO X AQS "' -> remover
            const titlePanels = panels.filter(p =>
                p.type === 'text' &&
                p.title !== undefined &&
                p.title.replace(/"/g, '').trim() !== '' &&
                p.id !== 292
            );

            for (const tp of titlePanels) {
                const rawLabel = tp.title.replace(/"/g, '').trim();

                // Aplica lista de exclusao
                if (isExcludedSegment(rawLabel)) {
                    console.log(`[GrafanaAlert] fetchOPGWSegments: excluindo "${rawLabel}"`);
                    continue;
                }

                // Adiciona prefixo OPGW em todos os segmentos deste dashboard
                const label = `OPGW - ${rawLabel}`;
                const tpY = tp.gridPos?.y ?? 0;
                const tpX = tp.gridPos?.x ?? 0;

                // Singlestats ficam na linha y+1, mesmo bloco horizontal
                const singlestats = panels
                    .filter(p =>
                        p.type === 'singlestat' &&
                        (p.gridPos?.y ?? 0) === tpY + 1 &&
                        (p.gridPos?.x ?? 0) >= tpX &&
                        (p.gridPos?.x ?? 0) < tpX + 8
                    )
                    .sort((a, b) => (a.gridPos?.x ?? 0) - (b.gridPos?.x ?? 0));

                // Para cada singlestat, resolve o itemid via Zabbix API
                const itemIds = [];
                for (const ss of singlestats) {
                    for (const target of (ss.targets || [])) {
                        const id = await resolveItemId(target);
                        if (id) itemIds.push(id);
                    }
                }

                if (itemIds.length >= 2) {
                    segments.push({ label, itemIdIn: itemIds[0], itemIdOut: itemIds[1] });
                } else if (itemIds.length === 1) {
                    segments.push({ label, itemIdIn: itemIds[0], itemIdOut: null });
                } else {
                    console.warn(`[GrafanaAlert] fetchOPGWSegments: sem itemids para "${label}"`);
                    segments.push({ label, itemIdIn: null, itemIdOut: null });
                }
            }

            console.log(`[GrafanaAlert] fetchOPGWSegments: ${segments.length} segmentos`, segments);
            return segments;
        } catch (err) {
            console.error('[GrafanaAlert] fetchOPGWSegments:', err);
            return [];
        }
    }

    // Busca segmentos do dashboard de Links TRANSP
    async function fetchLinksSegments() {
        try {
            const resp = await fetch(`/api/dashboards/uid/${FLAP_LINKS_DASHBOARD_UID}`, {
                credentials: 'include'
            });
            const data = await resp.json();
            const panels = data?.dashboard?.panels || [];
            const segments = [];

            const titlePanels = panels.filter(p =>
                p.type === 'text' &&
                p.title !== undefined &&
                p.title.replace(/"/g, '').trim() !== ''
            );

            for (const tp of titlePanels) {
                const rawLabel = tp.title.replace(/"/g, '').trim();

                // Aplica lista de exclusao
                if (isExcludedSegment(rawLabel)) {
                    console.log(`[GrafanaAlert] fetchLinksSegments: excluindo "${rawLabel}"`);
                    continue;
                }

                // Adiciona prefixo TRANSP se o label ainda nao tiver
                const upperLabel = rawLabel.toUpperCase();
                const label = upperLabel.includes('TRANSP') ? rawLabel : `TRANSP - ${rawLabel}`;

                const tpY = tp.gridPos?.y ?? 0;
                const tpX = tp.gridPos?.x ?? 0;

                const singlestats = panels
                    .filter(p =>
                        p.type === 'singlestat' &&
                        (p.gridPos?.y ?? 0) === tpY + 1 &&
                        (p.gridPos?.x ?? 0) >= tpX &&
                        (p.gridPos?.x ?? 0) < tpX + 8
                    )
                    .sort((a, b) => (a.gridPos?.x ?? 0) - (b.gridPos?.x ?? 0));

                const itemIds = [];
                for (const ss of singlestats) {
                    for (const target of (ss.targets || [])) {
                        const id = await resolveItemId(target);
                        if (id) itemIds.push(id);
                    }
                }

                if (itemIds.length >= 2) {
                    segments.push({ label, itemIdIn: itemIds[0], itemIdOut: itemIds[1] });
                } else if (itemIds.length === 1) {
                    segments.push({ label, itemIdIn: itemIds[0], itemIdOut: null });
                } else {
                    console.warn(`[GrafanaAlert] fetchLinksSegments: sem itemids para "${label}"`);
                    segments.push({ label, itemIdIn: null, itemIdOut: null });
                }
            }

            console.log(`[GrafanaAlert] fetchLinksSegments: ${segments.length} segmentos`, segments);
            return segments;
        } catch (err) {
            console.error('[GrafanaAlert] fetchLinksSegments:', err);
            return [];
        }
    }

    // Busca historico de um itemid via /api/tsdb/query (history_uint)
    async function fetchItemHistory(itemId) {
        try {
            const now = Math.floor(Date.now() / 1000);
            // Janela de 20 minutos para pegar as ultimas 10 leituras (intervalo de 2min)
            const from = now - 1800; // 30 minutos
            const resp = await fetch('/api/tsdb/query', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    queries: [{
                        refId: 'A',
                        format: 'time_series',
                        datasourceId: FLAP_DATASOURCE_ID,
                        rawSql: `SELECT to_char(itemid, 'FM99999999999999999999') AS metric, clock / 120 * 120 AS time, AVG(value) AS value FROM history_uint WHERE itemid IN (${itemId}) AND clock > ${from} AND clock < ${now} GROUP BY 1, 2 ORDER BY time ASC`,
                        maxDataPoints: FLAP_HISTORY_READINGS
                    }]
                })
            });
            const data = await resp.json();
            // Extrai array de valores da serie temporal
            const series = data?.results?.A?.series;
            if (!series || series.length === 0) return [];
            const points = series[0]?.points || [];
            // points: [[value, timestamp], ...]
            // Os items de trafego do Zabbix ja retornam a taxa em bits/s
            return points
                .filter(p => p[0] !== null)
                .map(p => p[0]);
        } catch (err) {
            console.error('[GrafanaAlert] fetchItemHistory:', itemId, err);
            return [];
        }
    }

    /*
    =========================================================
    FLAP DETECTOR - RENDER
    =========================================================
    */

    // Ajusta a altura do panel-240 e reposiciona todos os paineis abaixo
    // Usa delta incremental para nao acumular altura a cada render
    function resizeFlapPanel(cardCount) {
        const panelEl = document.getElementById(FLAP_PANEL_ID);
        if (!panelEl) return;

        // Calcula nova altura necessaria
        const cardsPerRow = Math.floor(1820 / 174);
        const rows = Math.ceil(cardCount / cardsPerRow);
        const cardHeight = 76;
        const padding = 16;
        const newHeight = Math.max(106, rows * cardHeight + padding);

        // Delta em relacao ao que ja foi aplicado anteriormente
        const delta = newHeight - flapPanelAppliedHeight;
        if (delta === 0) return; // nada mudou, nao faz nada

        // Aplica nova altura no painel
        panelEl.style.height = `${newHeight}px`;
        const expandTrigger = panelEl.querySelector('.expand-trigger div');
        if (expandTrigger) expandTrigger.style.height = `${newHeight + 1}px`;

        // Reposiciona paineis abaixo com o delta incremental
        const layout = panelEl.closest('.react-grid-layout');
        if (!layout) return;

        const panelTop = parseInt(panelEl.style.top) || 0;
        layout.querySelectorAll('.react-grid-item').forEach(p => {
            if (p === panelEl) return;
            const pTop = parseInt(p.style.top) || 0;
            if (pTop > panelTop) {
                p.style.top = `${pTop + delta}px`;
            }
        });

        const currentLayoutHeight = parseInt(layout.style.height) || 0;
        layout.style.height = `${currentLayoutHeight + delta}px`;

        // Atualiza altura aplicada para o proximo calculo
        flapPanelAppliedHeight = newHeight;
    }

    function renderFlapPanel() {
        const panelEl = document.getElementById(FLAP_PANEL_ID);
        if (!panelEl) return;

        // Remove card anterior se existir para nao duplicar
        const existing = panelEl.querySelector('#flap-detector-cards');
        if (existing) existing.remove();

        if (flapSegments.length === 0) return;

        const panelContent = panelEl.querySelector('.panel-content');
        if (!panelContent) return;

        // Remove o conteudo original do markdown (header roxo) na primeira renderizacao
        const markdownEl = panelContent.querySelector('.markdown-html');
        if (markdownEl) markdownEl.style.display = 'none';

        // Redimensiona o painel conforme quantidade de segmentos
        resizeFlapPanel(flapSegments.length);

        // Layout: flex row com wrap — ocupa toda a altura disponivel do painel redimensionado
        let html = `
            <div id="flap-detector-cards" style="
                display:flex;
                flex-wrap:wrap;
                gap:6px;
                padding:6px 10px;
                align-items:flex-start;
                align-content:flex-start;
                width:100%;
                box-sizing:border-box;
                position:absolute;
                top:0;
                left:0;
                z-index:10;
                overflow:hidden;
            ">`;

        for (const seg of flapSegments) {
            const state = flapState.get(seg.label) || { flapping: false, dropCount: 0, lastSeen: null };
            const inHistory = flapHistory.get(seg.itemIdIn) || [];
            const outHistory = seg.itemIdOut ? (flapHistory.get(seg.itemIdOut) || []) : [];

            const inLast = inHistory.length > 0 ? inHistory[inHistory.length - 1] : null;
            const outLast = outHistory.length > 0 ? outHistory[outHistory.length - 1] : null;

            const isFlapping = state.flapping;
            const borderColor = isFlapping ? '#ff4444' : '#00cc66';
            const bgColor = isFlapping ? 'rgba(255,0,0,0.08)' : 'rgba(0,200,100,0.06)';
            const statusIcon = isFlapping ? '⚡' : '✓';
            const statusLabel = isFlapping ? `FLAP (${state.dropCount}x)` : 'ESTAVEL';
            const statusColor = isFlapping ? '#ff6666' : '#00cc66';

            html += `
                <div style="
                    border:1px solid ${borderColor};
                    background:${bgColor};
                    border-radius:8px;
                    padding:6px 10px;
                    min-width:160px;
                    font-family:sans-serif;
                    font-size:11px;
                    color:#fff;
                    flex:1 1 160px;
                    max-width:220px;
                ">
                    <div style="font-weight:700;font-size:12px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${seg.label}">
                        ${seg.label}
                    </div>
                    <div style="color:${statusColor};font-weight:600;margin-bottom:4px;">
                        ${statusIcon} ${statusLabel}
                    </div>
                    <div style="opacity:0.8;display:flex;gap:8px;">
                        <span title="Entrada">⬇ ${formatBps(inLast)}</span>
                        <span title="Saida">⬆ ${formatBps(outLast)}</span>
                    </div>
                </div>`;
        }

        html += '</div>';
        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        panelContent.style.position = 'relative';
        panelContent.appendChild(wrapper.firstElementChild);
    }

    /*
    =========================================================
    FLAP DETECTOR - SCAN
    =========================================================
    */

    async function flapScan() {
        try {
            // Na primeira vez, descobre os segmentos de ambos os dashboards
            if (flapSegments.length === 0) {
                const [opgwSegs, linksSegs] = await Promise.all([
                    fetchOPGWSegments(),
                    fetchLinksSegments()
                ]);
                flapSegments = [...opgwSegs, ...linksSegs];
                if (flapSegments.length === 0) {
                    console.warn('[GrafanaAlert] flapScan: nenhum segmento encontrado');
                    return;
                }
            }

            // Para cada segmento, busca historico e detecta flap
            for (const seg of flapSegments) {
                // Entrada
                if (seg.itemIdIn) {
                    const hist = await fetchItemHistory(seg.itemIdIn);
                    flapHistory.set(seg.itemIdIn, hist);
                }
                // Saida
                if (seg.itemIdOut) {
                    const hist = await fetchItemHistory(seg.itemIdOut);
                    flapHistory.set(seg.itemIdOut, hist);
                }

                // Detecta flap combinando entrada e saida
                const inHist = flapHistory.get(seg.itemIdIn) || [];
                const outHist = seg.itemIdOut ? (flapHistory.get(seg.itemIdOut) || []) : [];
                const inFlap = detectFlap(inHist);
                const outFlap = detectFlap(outHist);

                const wasFlapping = flapState.get(seg.label)?.flapping || false;
                const isFlapping = inFlap.flapping || outFlap.flapping;
                const dropCount = inFlap.dropCount + outFlap.dropCount;

                flapState.set(seg.label, {
                    flapping: isFlapping,
                    dropCount,
                    lastSeen: isFlapping ? Date.now() : (flapState.get(seg.label)?.lastSeen || null)
                });

                // Notifica se comecou a flapar
                if (isFlapping && !wasFlapping && notificationsEnabled) {
                    const inLast = inHist.length > 0 ? inHist[inHist.length - 1] : null;
                    await showDesktopNotification(
                        'FLAP DETECTADO - OPGW',
                        `${seg.label}
Ent: ${formatBps(inLast)} | ${dropCount} queda(s) brusca(s)`,
                        `flap_${seg.label}`
                    );
                    await playAlertSound('alta');
                }
            }

            renderFlapPanel();
        } catch (err) {
            console.error('[GrafanaAlert] flapScan:', err);
        }
    }

    function startFlapDetector() {
        // Aguarda o DOM do painel OPGW estar carregado via API antes de escanear
        setTimeout(async () => {
            await flapScan();
            setInterval(flapScan, FLAP_SCAN_INTERVAL);
        }, 3000);
    }

    /*
    =========================================================
    START
    =========================================================
    */

    setTimeout(() => {
        if (isCorrectDashboard()) {
            initialize();
        } else {
            console.log(`[GrafanaAlert ${SCRIPT_VERSION}] Painel nao correspondente!`);
        }
    }, 4000);

})();
