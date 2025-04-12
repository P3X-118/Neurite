const { app, BrowserWindow, ipcMain } = require('electron');
const { registerShortcuts, unregisterShortcuts } = require('./modules/shortcuts');
const { createLoadingWindow, closeLoadingWindow } = require('./modules/loadingwindow');
const { isLocalServerRunning, startLocalServers, stopLocalServers } = require('./modules/servermanager');
const { createMainWindow } = require('./modules/windowmanager');
const { initializeUpdater } = require('./modules/update');
const { ensureServersDownloaded } = require('./modules/serverdownloader');
const { setupSecureFetchHandler, destroySecureProxyWindow } = require('./modules/securefetch');
const { stopFrontendServer } = require('./modules/frontendserver');

app.whenReady().then(async () => {
    // Run updater and wait for possible restart
    const shouldContinue = await initializeUpdater();
    if (!shouldContinue) return;
    
    const loadingWindow = createLoadingWindow();

    loadingWindow.on('closed', () => {
        // If the main window hasn't been shown yet, assume the user quit early
        const anyVisible = BrowserWindow.getAllWindows().some(win => win.isVisible());
        if (!anyVisible) {
            console.log('[main] Loading window closed before main window was shown. Quitting app...');
            app.quit(); // Triggers before-quit and will clean up servers
        }
    });

    setupSecureFetchHandler();

    // Create the main window
    const mainWindow = await createMainWindow();
    registerShortcuts();

    // Server readiness
    const serversPromise = (async () => {
        const running = await isLocalServerRunning();
        if (!running) {
            console.log('[main] Starting localhost_servers...');
            try {
                const serverPath = await ensureServersDownloaded();
                await startLocalServers(serverPath);
                console.log('[main] localhost_servers started.');
            } catch (err) {
                console.error('[main] Failed to start localhost_servers:', err);
            }
        } else {
            console.log('[main] localhost_servers already running.');
        }
        return true;
    })();

    // Renderer readiness
    const rendererPromise = new Promise((resolve) => {
        ipcMain.once('renderer-ready', () => {
            console.log('Renderer signaled ready');
            resolve(true);
        });
    });

    await Promise.all([serversPromise, rendererPromise]);

    try {
        await mainWindow.webContents.executeJavaScript('Host?.checkServer?.();');
    } catch (err) {
        console.warn('[main] Renderer hook failed:', err);
    }

    closeLoadingWindow();
    mainWindow.show();

    app.on('activate', () => {
        const existing = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
        if (existing) {
            existing.show();
        } else {
            createMainWindow().show();
        }
    });

    mainWindow.on('closed', () => {
        app.quit();
    });
});

app.on('will-quit', () => {
    unregisterShortcuts();
});

let isCleaningUp = false;

app.on('before-quit', async (event) => {
    if (isCleaningUp) return; // ⛔ prevent double cleanup
    isCleaningUp = true;

    console.log('[main] Running shutdown cleanup...');
    event.preventDefault();

    try {
        await stopFrontendServer();
        await stopLocalServers();
        console.log('hello');
        await destroySecureProxyWindow();
        console.log('[main] Cleanup complete. Quitting now...');
        app.exit(); // use exit to avoid loop
    } catch (err) {
        console.error('[main] Cleanup error:', err);
        app.exit(1);
    }
});