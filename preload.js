// Bridge between the window and the main process.
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('petal', {
  list: call('apps:list'),
  icon: call('apps:icon'),
  uninstall: call('app:uninstall'),
  exists: call('app:exists'),
  leftovers: call('app:leftovers'),
  clean: call('app:clean'),
  isAdmin: call('admin:status'),
  relaunchAdmin: call('admin:relaunch'),
  open: call('shell:open'),
  show: call('shell:show'),
  url: call('shell:url'),
  regedit: call('shell:regedit'),
  backups: call('shell:backups'),
  exportHtml: call('export:html'),
  titlebar: call('theme:titlebar'),
  selftest: { info: call('selftest:info'), shot: call('selftest:shot'), quit: call('selftest:quit'), log: call('selftest:log') },
});
