"use strict";
const electron = require("electron");
const api = {
  db: {
    run: (sql, params = []) => electron.ipcRenderer.invoke("db:run", sql, params),
    get: (sql, params = []) => electron.ipcRenderer.invoke("db:get", sql, params),
    all: (sql, params = []) => electron.ipcRenderer.invoke("db:all", sql, params),
    users: {
      getAll: () => electron.ipcRenderer.invoke("db:users:getAll"),
      getById: (id) => electron.ipcRenderer.invoke("db:users:getById", id),
      create: (input) => electron.ipcRenderer.invoke("db:users:create", input),
      updatePassword: (userId, passwordHash) => electron.ipcRenderer.invoke("db:users:updatePassword", userId, passwordHash),
      updateSettings: (userId, input) => electron.ipcRenderer.invoke("db:users:updateSettings", userId, input)
    },
    products: {
      getAll: (filter) => electron.ipcRenderer.invoke("db:products:getAll", filter),
      getById: (productId) => electron.ipcRenderer.invoke("db:products:getById", productId),
      create: (input) => electron.ipcRenderer.invoke("db:products:create", input),
      update: (productId, input) => electron.ipcRenderer.invoke("db:products:update", productId, input),
      delete: (productId, deletedBy, reason) => electron.ipcRenderer.invoke("db:products:delete", productId, deletedBy, reason)
    },
    variants: {
      getBySku: (sku, userId) => electron.ipcRenderer.invoke("db:variants:getBySku", sku, userId),
      getByProduct: (productId) => electron.ipcRenderer.invoke("db:variants:getByProduct", productId),
      addQty: (variantId, userId, quantity, note) => electron.ipcRenderer.invoke("db:variants:addQty", variantId, userId, quantity, note)
    },
    sales: {
      record: (input) => electron.ipcRenderer.invoke("db:sales:record", input),
      getRecent: (userId, limit) => electron.ipcRenderer.invoke("db:sales:getRecent", userId, limit),
      getByRange: (from, to) => electron.ipcRenderer.invoke("db:sales:getByRange", from, to)
    },
    stock: {
      getAll: (userId) => electron.ipcRenderer.invoke("db:stock:getAll", userId),
      getLow: (userId) => electron.ipcRenderer.invoke("db:stock:getLow", userId),
      getMovements: (variantId) => electron.ipcRenderer.invoke("db:stock:getMovements", variantId)
    },
    reports: {
      dailySummary: (from, to) => electron.ipcRenderer.invoke("db:reports:dailySummary", from, to),
      weeklySummary: (from, to) => electron.ipcRenderer.invoke("db:reports:weeklySummary", from, to),
      topProducts: (limit) => electron.ipcRenderer.invoke("db:reports:topProducts", limit),
      topBuyers: (limit) => electron.ipcRenderer.invoke("db:reports:topBuyers", limit),
      summaryByRange: (userId, start, end) => electron.ipcRenderer.invoke("db:reports:summaryByRange", userId, start, end),
      hourlyPattern: (userId, start, end) => electron.ipcRenderer.invoke("db:reports:hourlyPattern", userId, start, end),
      categoryBreakdown: (userId, start, end) => electron.ipcRenderer.invoke("db:reports:categoryBreakdown", userId, start, end),
      periodComparison: (userId, currentStart, currentEnd, prevStart, prevEnd) => electron.ipcRenderer.invoke("db:reports:periodComparison", userId, currentStart, currentEnd, prevStart, prevEnd),
      salesLog: (userId, start, end) => electron.ipcRenderer.invoke("db:reports:salesLog", userId, start, end)
    },
    archives: {
      getAll: (userId, limit, offset, query, from, to) => electron.ipcRenderer.invoke("db:archives:getAll", userId, limit, offset, query, from, to),
      count: (userId, query, from, to) => electron.ipcRenderer.invoke("db:archives:count", userId, query, from, to),
      restore: (archiveId) => electron.ipcRenderer.invoke("db:archives:restore", archiveId)
    },
    settings: {
      get: (userId, key) => electron.ipcRenderer.invoke("db:settings:get", userId, key),
      getAll: (userId) => electron.ipcRenderer.invoke("db:settings:getAll", userId),
      set: (userId, key, value) => electron.ipcRenderer.invoke("db:settings:set", userId, key, value)
    },
    categoryTemplates: {
      getAll: () => electron.ipcRenderer.invoke("db:categoryTemplates:getAll")
    }
  },
  economy: {
    topProducts: (userId, limit, start, end) => electron.ipcRenderer.invoke("db:economy:topProducts", userId, limit, start, end),
    topBuyers: (userId, limit, start, end) => electron.ipcRenderer.invoke("db:economy:topBuyers", userId, limit, start, end),
    categoryPerformance: (userId, start, end) => electron.ipcRenderer.invoke("db:economy:categoryPerformance", userId, start, end),
    slowMovers: (userId, dayThreshold) => electron.ipcRenderer.invoke("db:economy:slowMovers", userId, dayThreshold),
    profitableVariants: (userId) => electron.ipcRenderer.invoke("db:economy:profitableVariants", userId)
  },
  window: {
    minimize: () => electron.ipcRenderer.invoke("window:minimize"),
    maximize: () => electron.ipcRenderer.invoke("window:maximize"),
    close: () => electron.ipcRenderer.invoke("window:close")
  },
  file: {
    saveCsv: (filename, content) => electron.ipcRenderer.invoke("file:saveCsv", filename, content),
    exportBackup: () => electron.ipcRenderer.invoke("file:exportBackup"),
    importBackup: () => electron.ipcRenderer.invoke("file:importBackup")
  },
  profile: {
    stats: (userId) => electron.ipcRenderer.invoke("db:profile:stats", userId)
  },
  shell: {
    openExternal: (url) => electron.ipcRenderer.invoke("shell:open-external", url),
    openPath: (path) => electron.ipcRenderer.invoke("shell:open-path", path)
  },
  app: {
    getInfo: () => electron.ipcRenderer.invoke("app:get-info")
  },
  print: {
    label: (html) => electron.ipcRenderer.invoke("print:label", html)
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
