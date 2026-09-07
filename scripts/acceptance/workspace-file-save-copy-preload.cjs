const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("workspaceSaveCopyAcceptance", {
  saveWorkspaceCopy: async (target, path, hostId) => {
    const result = await ipcRenderer.invoke("acceptance:workspace-save-copy", target, path, hostId);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
});
