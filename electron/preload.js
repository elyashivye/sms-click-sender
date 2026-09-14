// Exposes a small, explicit API to the renderer (contextIsolation stays on,
// nodeIntegration stays off) - the frontend uses window.smsSender.isElectron
// to detect it's running inside the desktop app and show the scheduling UI.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("smsSender", {
  isElectron: true,

  getServerConfig: () => ipcRenderer.invoke("get-server-config"),
  setServerConfig: (config) => ipcRenderer.invoke("set-server-config", config),

  getLocalJob: (scheduleId) => ipcRenderer.invoke("get-local-job", scheduleId),
  saveLocalJob: (scheduleId, jobData) => ipcRenderer.invoke("save-local-job", scheduleId, jobData),
  deleteLocalJob: (scheduleId) => ipcRenderer.invoke("delete-local-job", scheduleId),

  // Called by the main process when a scheduled job is due. Returns an
  // unsubscribe function.
  onRunJob: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("run-job", listener);
    return () => ipcRenderer.removeListener("run-job", listener);
  },

  reportJobResult: (requestId, result) => ipcRenderer.send("job-result", { requestId, ...result }),
});
