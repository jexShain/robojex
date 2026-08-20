const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('robojex', {
  platform: 'electron',
});
