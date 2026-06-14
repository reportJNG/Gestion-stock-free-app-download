import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  net,
  screen,
  shell,
} from "electron";
import ElectronStoreImport from "electron-store";

// electron-store v11 is ESM-only; CJS require() exposes the class on `.default`
const Store = (
  ElectronStoreImport as typeof ElectronStoreImport & {
    default: typeof ElectronStoreImport;
  }
).default;
import { copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  addVariantQuantity,
  all,
  createProduct,
  createUser,
  deleteProduct,
  get,
  getAllStock,
  getAllUsers,
  getArchives,
  getArchiveCount,
  getCategoryTemplates,
  getDailySummary,
  getLowStock,
  getStockMovements,
  getProductById,
  getProducts,
  getRecentSales,
  getSalesByRange,
  getSetting,
  getAllSettings,
  getProfileStats,
  getTopBuyers,
  getTopProducts,
  getSummaryByRange,
  getHourlyPattern,
  getCategoryBreakdown,
  getPeriodComparison,
  getSalesLogByRange,
  getEconomyTopProducts,
  getEconomyTopBuyers,
  getEconomyCategoryPerformance,
  getEconomySlowMovers,
  getEconomyProfitableVariants,
  getUserById,
  getVariantBySku,
  getVariantsByProduct,
  getWeeklySummary,
  initDatabase,
  recordSale,
  restoreArchive,
  run,
  setSetting,
  updateProduct,
  updateUserPassword,
  updateUserSettings,
} from "./db/database";

const registerAppProtocol = (): void => {
  // Register a custom app:// protocol so type="module" scripts work from file system
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
};

let mainWindow: BrowserWindow | null = null;

// ✅ FIX 1: Set userData path BEFORE app is ready, using app.getPath('appData')
// process.cwd() breaks in packaged/installed apps
// Register custom protocol BEFORE app is ready
registerAppProtocol();

app.setPath("userData", join(app.getPath("appData"), "StockFlow"));

// ✅ FIX 2: Full GPU disable flags (must be set before app is ready)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch(
  "disable-features",
  "UseSkiaRenderer,VizDisplayCompositor",
);
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");
app.commandLine.appendSwitch("disable-dev-shm-usage");

const resolveAppIcon = (): Electron.NativeImage | undefined => {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "icon.png")]
    : [join(process.cwd(), "public", "icon.png")];

  const iconPath = candidates.find((path) => existsSync(path));
  if (!iconPath) {
    return undefined;
  }

  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? undefined : image;
};

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

const windowStore = new Store<{ windowState: WindowState }>({
  name: "stockflow-window",
  defaults: {
    windowState: { width: 1280, height: 800 },
  },
});

const getSavedWindowBounds = (): WindowState => {
  const saved = windowStore.get("windowState");
  if (saved.x === undefined || saved.y === undefined) {
    return saved;
  }

  const onScreen = screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea;
    return (
      saved.x! >= x &&
      saved.x! < x + width &&
      saved.y! >= y &&
      saved.y! < y + height
    );
  });

  if (!onScreen) {
    return { width: saved.width, height: saved.height };
  }

  return saved;
};

let saveWindowStateTimer: ReturnType<typeof setTimeout> | null = null;

const saveWindowState = (window: BrowserWindow): void => {
  if (saveWindowStateTimer) {
    clearTimeout(saveWindowStateTimer);
  }

  saveWindowStateTimer = setTimeout(() => {
    const isMaximized = window.isMaximized();
    const bounds = isMaximized ? window.getNormalBounds() : window.getBounds();
    windowStore.set("windowState", {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    });
  }, 500);
};

const attachWindowStateHandlers = (window: BrowserWindow): void => {
  window.on("resize", () => saveWindowState(window));
  window.on("move", () => saveWindowState(window));
  window.on("close", () => saveWindowState(window));
};

const loadRenderer = async (window: BrowserWindow): Promise<void> => {
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, url) => {
      console.error(
        `[renderer] did-fail-load: code=${errorCode} desc=${errorDescription} url=${url}`,
      );
    },
  );

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      "[renderer] render-process-gone:",
      details.reason,
      details.exitCode,
    );
  });

  if (!process.env.ELECTRON_RENDERER_URL) {
    // Use custom app:// protocol so ES module scripts load correctly in packaged build
    await window.loadURL("app://renderer/index.html");
    return;
  }

  let retryCount = 0;
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, _description, url) => {
      if (
        url !== process.env.ELECTRON_RENDERER_URL ||
        errorCode === -3 ||
        retryCount >= 10
      ) {
        return;
      }

      retryCount += 1;
      setTimeout(() => {
        void window.loadURL(process.env.ELECTRON_RENDERER_URL as string);
      }, 300);
    },
  );

  await window
    .loadURL(process.env.ELECTRON_RENDERER_URL)
    .catch(() => undefined);
};

const createWindow = async (): Promise<void> => {
  const saved = getSavedWindowBounds();

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: "#0a0a0a",
    show: false,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // ✅ FIX 5: Disable sandbox in webPreferences as well for packaged apps
      sandbox: false,
    },
  });

  attachWindowStateHandlers(mainWindow);

  if (saved.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  if (process.env.VITE_DEV_TOOLS === "true") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  await loadRenderer(mainWindow);
};

const registerIpcHandlers = (): void => {
  ipcMain.handle("db:run", (_event, sql: string, params = []) =>
    run(sql, params),
  );
  ipcMain.handle("db:get", (_event, sql: string, params = []) =>
    get(sql, params),
  );
  ipcMain.handle("db:all", (_event, sql: string, params = []) =>
    all(sql, params),
  );
  ipcMain.handle("db:users:getAll", () => getAllUsers());
  ipcMain.handle("db:users:getById", (_event, id: number) => getUserById(id));
  ipcMain.handle("db:users:create", (_event, input) => createUser(input));
  ipcMain.handle(
    "db:users:updatePassword",
    (_event, userId: number, passwordHash: string) =>
      updateUserPassword(userId, passwordHash),
  );
  ipcMain.handle("db:users:updateSettings", (_event, userId: number, input) =>
    updateUserSettings(userId, input),
  );
  ipcMain.handle("db:products:getAll", (_event, filter) => getProducts(filter));
  ipcMain.handle("db:products:getById", (_event, productId: number) =>
    getProductById(productId),
  );
  ipcMain.handle("db:products:create", (_event, input) => createProduct(input));
  ipcMain.handle("db:products:update", (_event, productId: number, input) =>
    updateProduct(productId, input),
  );
  ipcMain.handle(
    "db:products:delete",
    (_event, productId: number, deletedBy: number, reason?: string) =>
      deleteProduct(productId, deletedBy, reason),
  );
  ipcMain.handle(
    "db:variants:getBySku",
    (_event, sku: string, userId: number) => getVariantBySku(sku, userId),
  );
  ipcMain.handle("db:variants:getByProduct", (_event, productId: number) =>
    getVariantsByProduct(productId),
  );
  ipcMain.handle(
    "db:variants:addQty",
    (
      _event,
      variantId: number,
      userId: number,
      quantity: number,
      note?: string,
    ) => addVariantQuantity(variantId, userId, quantity, note),
  );
  ipcMain.handle("db:sales:record", (_event, input) => recordSale(input));
  ipcMain.handle(
    "db:sales:getRecent",
    (_event, userId: number, limit?: number) => getRecentSales(userId, limit),
  );
  ipcMain.handle("db:sales:getByRange", (_event, from: string, to: string) =>
    getSalesByRange(from, to),
  );
  ipcMain.handle("db:stock:getAll", (_event, userId: number) =>
    getAllStock(userId),
  );
  ipcMain.handle("db:stock:getLow", (_event, userId: number) =>
    getLowStock(userId),
  );
  ipcMain.handle("db:stock:getMovements", (_event, variantId: number) =>
    getStockMovements(variantId),
  );
  ipcMain.handle(
    "file:saveCsv",
    async (_event, filename: string, content: string) => {
      const result = await dialog.showSaveDialog({
        defaultPath: filename,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      await writeFile(result.filePath, content, "utf8");
      return { canceled: false, filePath: result.filePath };
    },
  );
  ipcMain.handle("file:exportBackup", async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: `stockflow-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: "SQLite database", extensions: ["db"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await copyFile(
      join(app.getPath("userData"), "stockflow.db"),
      result.filePath,
    );
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle("file:importBackup", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "SQLite database", extensions: ["db"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    await copyFile(
      result.filePaths[0],
      join(app.getPath("userData"), "stockflow.db"),
    );
    return { canceled: false, filePath: result.filePaths[0] };
  });
  ipcMain.handle(
    "db:reports:dailySummary",
    (_event, from?: string, to?: string) => getDailySummary(from, to),
  );
  ipcMain.handle(
    "db:reports:weeklySummary",
    (_event, from?: string, to?: string) => getWeeklySummary(from, to),
  );
  ipcMain.handle("db:reports:topProducts", (_event, limit?: number) =>
    getTopProducts(limit),
  );
  ipcMain.handle("db:reports:topBuyers", (_event, limit?: number) =>
    getTopBuyers(limit),
  );
  ipcMain.handle(
    "db:reports:summaryByRange",
    (_event, userId: number, start: string, end: string) =>
      getSummaryByRange(userId, start, end),
  );
  ipcMain.handle(
    "db:reports:hourlyPattern",
    (_event, userId: number, start: string, end: string) =>
      getHourlyPattern(userId, start, end),
  );
  ipcMain.handle(
    "db:reports:categoryBreakdown",
    (_event, userId: number, start: string, end: string) =>
      getCategoryBreakdown(userId, start, end),
  );
  ipcMain.handle(
    "db:reports:periodComparison",
    (
      _event,
      userId: number,
      currentStart: string,
      currentEnd: string,
      prevStart: string,
      prevEnd: string,
    ) =>
      getPeriodComparison(userId, currentStart, currentEnd, prevStart, prevEnd),
  );
  ipcMain.handle(
    "db:reports:salesLog",
    (_event, userId: number, start: string, end: string) =>
      getSalesLogByRange(userId, start, end),
  );
  ipcMain.handle(
    "db:economy:topProducts",
    (_event, userId: number, limit?: number, start?: string, end?: string) =>
      getEconomyTopProducts(userId, limit, start, end),
  );
  ipcMain.handle(
    "db:economy:topBuyers",
    (_event, userId: number, limit?: number, start?: string, end?: string) =>
      getEconomyTopBuyers(userId, limit, start, end),
  );
  ipcMain.handle(
    "db:economy:categoryPerformance",
    (_event, userId: number, start?: string, end?: string) =>
      getEconomyCategoryPerformance(userId, start, end),
  );
  ipcMain.handle(
    "db:economy:slowMovers",
    (_event, userId: number, dayThreshold?: number) =>
      getEconomySlowMovers(userId, dayThreshold),
  );
  ipcMain.handle("db:economy:profitableVariants", (_event, userId: number) =>
    getEconomyProfitableVariants(userId),
  );
  ipcMain.handle(
    "db:archives:getAll",
    (
      _event,
      userId?: number,
      limit?: number,
      offset?: number,
      query?: string,
      from?: string,
      to?: string,
    ) => getArchives(userId, limit, offset, query, from, to),
  );
  ipcMain.handle(
    "db:archives:count",
    (_event, userId: number, query?: string, from?: string, to?: string) =>
      getArchiveCount(userId, query, from, to),
  );
  ipcMain.handle("db:archives:restore", (_event, archiveId: number) =>
    restoreArchive(archiveId),
  );
  ipcMain.handle("db:settings:get", (_event, userId: number, key: string) =>
    getSetting(userId, key),
  );
  ipcMain.handle("db:settings:getAll", (_event, userId: number) =>
    getAllSettings(userId),
  );
  ipcMain.handle(
    "db:settings:set",
    (_event, userId: number, key: string, value: string) =>
      setSetting(userId, key, value),
  );
  ipcMain.handle("db:profile:stats", (_event, userId: number) =>
    getProfileStats(userId),
  );
  ipcMain.handle("db:categoryTemplates:getAll", () => getCategoryTemplates());

  ipcMain.handle("window:minimize", () => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });

  ipcMain.handle("window:maximize", () => {
    const window = BrowserWindow.getFocusedWindow();
    if (!window) {
      return;
    }

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

  ipcMain.handle("window:close", () => {
    BrowserWindow.getFocusedWindow()?.close();
  });

  ipcMain.handle("shell:open-external", (_event, url: string) => {
    void shell.openExternal(url);
  });

  ipcMain.handle("shell:open-path", (_event, path: string) => {
    void shell.openPath(path);
  });

  ipcMain.handle("print:label", async (_event, html: string) => {
    const printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    await printWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );

    await new Promise<void>((resolve) => {
      printWindow.webContents.print(
        { silent: false, printBackground: true },
        () => {
          printWindow.close();
          resolve();
        },
      );
    });
  });

  ipcMain.handle("app:get-info", () => {
    const platformLabels: Record<string, string> = {
      win32: "Windows",
      darwin: "macOS",
      linux: "Linux",
    };
    const userDataPath = app.getPath("userData");

    return {
      version: app.getVersion(),
      platform: platformLabels[process.platform] ?? process.platform,
      userDataPath,
      dbPath: join(userDataPath, "stockflow.db"),
    };
  });
};

app.whenReady().then(async () => {
  // Handle app:// protocol — serves renderer files from the asar
  protocol.handle("app", (request) => {
    const url = request.url.replace("app://renderer/", "");
    const rendererPath = join(app.getAppPath(), "out/renderer", url);
    return net.fetch("file://" + rendererPath);
  });

  initDatabase();
  registerIpcHandlers();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
