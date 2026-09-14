// Electron wrapper: the downloadable desktop app is the exact same web app
// (same src/, same WebUSB code) running inside a bundled Chromium instead of
// the user's own browser. Electron doesn't show a native USB device picker
// like Chrome does, so we handle that ourselves below.

import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const ses = win.webContents.session;

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

  const startUrl =
    process.env.ELECTRON_START_URL || `file://${path.join(__dirname, "..", "dist", "index.html")}`;
  win.loadURL(startUrl);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
