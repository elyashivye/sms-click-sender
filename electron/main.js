// Electron wrapper: the downloadable desktop app is the exact same web app
// (same src/, same WebUSB code) running inside a bundled Chromium instead of
// the user's own browser. Electron doesn't show a native USB device picker
// like Chrome does, so we handle that ourselves below.
//
// It also runs the background scheduler (electron/scheduler.js), which is
// why closing the window hides it to the tray instead of quitting - a
// scheduled reminder still needs a live renderer (for WebUSB) to run.

import { app, BrowserWindow, ipcMain, Menu, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deleteLocalJob,
  getLocalJob,
  getServerConfig,
  saveLocalJob,
  setServerConfig,
} from "./store.js";
import { resolvePendingRequest, startScheduler, stopScheduler } from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 820,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const ses = mainWindow.webContents.session;

  // There's normally exactly one phone plugged in during a session, so we
  // auto-pick the first (and usually only) matching device instead of
  // building a custom chooser UI.
  ses.on("select-usb-device", (event, details, callback) => {
    event.preventDefault();
    const device = details.deviceList[0];
    callback(device ? device.deviceId : undefined);
  });

  ses.setPermissionCheckHandler((_webContents, permission) => permission === "usb");
  ses.setDevicePermissionHandler((details) => details.deviceType === "usb");

  // Keep the window (and its WebUSB connection) alive in the background so
  // scheduled jobs can still run after the user "closes" the window.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  const startUrl =
    process.env.ELECTRON_START_URL || `file://${path.join(__dirname, "..", "dist", "index.html")}`;
  mainWindow.loadURL(startUrl);
}

function createTray() {
  tray = new Tray(path.join(__dirname, "assets", "tray-icon.png"));
  tray.setToolTip("SMS Click Sender");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "פתח", click: () => mainWindow?.show() },
      {
        label: "יציאה",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", () => mainWindow?.show());
}

function registerIpcHandlers() {
  ipcMain.handle("get-server-config", () => getServerConfig());
  ipcMain.handle("set-server-config", (_event, config) => setServerConfig(config));
  ipcMain.handle("get-local-job", (_event, scheduleId) => getLocalJob(scheduleId));
  ipcMain.handle("save-local-job", (_event, scheduleId, jobData) => saveLocalJob(scheduleId, jobData));
  ipcMain.handle("delete-local-job", (_event, scheduleId) => deleteLocalJob(scheduleId));
  ipcMain.on("job-result", (_event, { requestId, ...result }) => {
    resolvePendingRequest(requestId, result);
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  createTray();
  startScheduler(() => mainWindow);
});

app.on("before-quit", () => {
  isQuitting = true;
  stopScheduler();
});

app.on("window-all-closed", () => {
  // Intentionally not quitting: the window hides instead of closing (see
  // above), and on macOS/Windows/Linux the tray keeps the app reachable.
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
  } else {
    createWindow();
  }
});
