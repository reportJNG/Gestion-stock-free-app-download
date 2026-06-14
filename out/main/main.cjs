"use strict";
const electron = require("electron");
const ElectronStoreImport = require("electron-store");
const promises = require("node:fs/promises");
const node_fs = require("node:fs");
const node_path = require("node:path");
const node_sqlite = require("node:sqlite");
const QRCode = require("qrcode");
const migrations = [
  `
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL,
      password_hash   TEXT    NOT NULL,
      business_type   TEXT    NOT NULL DEFAULT 'general',
      avatar_initials TEXT    NOT NULL DEFAULT '',
      is_active       INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS category_templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      icon        TEXT    NOT NULL DEFAULT 'package',
      attributes  TEXT    NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS products (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name                TEXT    NOT NULL,
      category            TEXT    NOT NULL DEFAULT 'other',
      description         TEXT    NOT NULL DEFAULT '',
      cost_price          REAL    NOT NULL DEFAULT 0,
      sell_price          REAL    NOT NULL DEFAULT 0,
      unit                TEXT    NOT NULL DEFAULT 'piece',
      low_stock_threshold INTEGER NOT NULL DEFAULT 5,
      is_archived         INTEGER NOT NULL DEFAULT 0,
      archived_at         TEXT,
      archived_reason     TEXT    NOT NULL DEFAULT '',
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
    CREATE INDEX IF NOT EXISTS idx_products_archived ON products(is_archived);

    CREATE TABLE IF NOT EXISTS product_variants (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku          TEXT    NOT NULL UNIQUE,
      attributes   TEXT    NOT NULL DEFAULT '{}',
      qr_code_data TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_sku ON product_variants(sku);

    CREATE TABLE IF NOT EXISTS stock (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id INTEGER NOT NULL UNIQUE REFERENCES product_variants(id) ON DELETE CASCADE,
      quantity   INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id      INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type            TEXT    NOT NULL,
      quantity_delta  INTEGER NOT NULL,
      quantity_before INTEGER NOT NULL,
      quantity_after  INTEGER NOT NULL,
      buyer_name      TEXT,
      note            TEXT    NOT NULL DEFAULT '',
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_movements_variant ON stock_movements(variant_id);
    CREATE INDEX IF NOT EXISTS idx_movements_user ON stock_movements(user_id);
    CREATE INDEX IF NOT EXISTS idx_movements_type ON stock_movements(type);
    CREATE INDEX IF NOT EXISTS idx_movements_date ON stock_movements(created_at);

    CREATE TABLE IF NOT EXISTS sales (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      quantity   INTEGER NOT NULL DEFAULT 1,
      unit_price REAL    NOT NULL,
      total      REAL    NOT NULL,
      buyer_name TEXT,
      sold_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sales_variant ON sales(variant_id);
    CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sold_at);
    CREATE INDEX IF NOT EXISTS idx_sales_buyer ON sales(buyer_name);

    CREATE TABLE IF NOT EXISTS archives (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id       INTEGER NOT NULL,
      product_snapshot TEXT    NOT NULL,
      deleted_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason           TEXT    NOT NULL DEFAULT '',
      archived_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_archives_date ON archives(archived_at);

    CREATE TABLE IF NOT EXISTS app_settings (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key     TEXT    NOT NULL,
      value   TEXT    NOT NULL DEFAULT '',
      UNIQUE(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS buyers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name            TEXT    NOT NULL,
      total_purchases INTEGER NOT NULL DEFAULT 0,
      total_spent     REAL    NOT NULL DEFAULT 0,
      last_purchase   TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_buyers_user ON buyers(user_id);
    CREATE INDEX IF NOT EXISTS idx_buyers_spent ON buyers(total_spent DESC);
  `
];
const categoryTemplateSeeds = [
  ["clothing", "shirt", '[{"key":"size","type":"multi","options":["XS","S","M","L","XL","XXL","XXXL"]},{"key":"color","type":"multi","options":[]}]'],
  ["shoes", "footprints", '[{"key":"size","type":"multi","options":["35","36","37","38","39","40","41","42","43","44","45","46"]},{"key":"color","type":"multi","options":[]}]'],
  ["food", "utensils", '[{"key":"expiry_date","type":"date"},{"key":"weight_g","type":"number"}]'],
  ["beverage", "coffee", '[{"key":"volume_ml","type":"number"},{"key":"expiry_date","type":"date"}]'],
  ["electronics", "cpu", '[{"key":"warranty_months","type":"number"},{"key":"brand","type":"text"}]'],
  ["cosmetics", "sparkles", '[{"key":"expiry_date","type":"date"},{"key":"shade","type":"multi","options":[]}]'],
  ["pharmacy", "pill", '[{"key":"expiry_date","type":"date"},{"key":"dosage","type":"text"}]'],
  ["furniture", "armchair", '[{"key":"material","type":"text"},{"key":"color","type":"multi","options":[]}]'],
  ["books", "book", '[{"key":"author","type":"text"},{"key":"isbn","type":"text"}]'],
  ["other", "package", "[]"]
];
const defaultSettings = [
  ["currency", "DZD"],
  ["language", "en"],
  ["low_stock_alert", "1"],
  ["scan_auto_confirm", "0"],
  ["date_format", "DD/MM/YYYY"]
];
let db = null;
const getDatabase = () => {
  if (db) {
    return db;
  }
  const dbPath = node_path.join(electron.app.getPath("userData"), "stockflow.db");
  node_fs.mkdirSync(electron.app.getPath("userData"), { recursive: true });
  db = new node_sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  const migrate = transaction(() => {
    for (const migration of migrations) {
      db?.exec(migration);
    }
    seedCategoryTemplates();
  });
  migrate();
  return db;
};
const toSqlInput = (value) => value ?? null;
const bindParams = (params) => {
  if (Array.isArray(params)) {
    return params.map(toSqlInput);
  }
  return [
    Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, toSqlInput(value)])
    )
  ];
};
const transaction = (callback) => {
  return () => {
    const database = getDatabase();
    database.exec("BEGIN");
    try {
      const result = callback();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
};
const seedCategoryTemplates = () => {
  const database = db;
  if (!database) {
    return;
  }
  const insert = database.prepare(`
    INSERT OR IGNORE INTO category_templates (name, icon, attributes)
    VALUES (?, ?, ?)
  `);
  for (const template of categoryTemplateSeeds) {
    insert.run(...template);
  }
};
const seedDefaultSettings = (userId) => {
  const insert = getDatabase().prepare(`
    INSERT OR IGNORE INTO app_settings (user_id, key, value)
    VALUES (?, ?, ?)
  `);
  for (const [key, value] of defaultSettings) {
    insert.run(userId, key, value);
  }
};
const skuFor = (productId, variantId) => {
  return `PID${productId.toString().padStart(6, "0")}V${variantId.toString().padStart(4, "0")}`;
};
const qrFor = (sku) => {
  return QRCode.toDataURL(sku, {
    width: 256,
    margin: 1,
    color: { dark: "#ffffff", light: "#00000000" }
  });
};
const initDatabase = () => {
  getDatabase();
};
const run = (sql, params = []) => {
  const result = getDatabase().prepare(sql).run(...bindParams(params));
  return {
    changes: Number(result.changes),
    lastInsertRowid: result.lastInsertRowid
  };
};
const get = (sql, params = []) => {
  return getDatabase().prepare(sql).get(...bindParams(params));
};
const all = (sql, params = []) => {
  return getDatabase().prepare(sql).all(...bindParams(params));
};
const getAllUsers = () => {
  return all("SELECT * FROM users ORDER BY created_at DESC");
};
const getUserById = (id) => {
  return get("SELECT * FROM users WHERE id = ?", [id]);
};
const createUser = (input) => {
  const create = transaction(() => {
    const result = run(
      `
        INSERT INTO users (name, password_hash, business_type, avatar_initials)
        VALUES (?, ?, ?, ?)
      `,
      [
        input.name,
        input.passwordHash,
        input.businessType ?? "general",
        input.avatarInitials ?? input.name.slice(0, 2).toUpperCase()
      ]
    );
    const userId = Number(result.lastInsertRowid);
    seedDefaultSettings(userId);
    return getUserById(userId);
  });
  return create();
};
const updateUserPassword = (userId, passwordHash) => {
  return run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [passwordHash, userId]);
};
const updateUserSettings = (userId, input) => {
  return run(
    `
      UPDATE users
      SET
        name = COALESCE(?, name),
        business_type = COALESCE(?, business_type),
        avatar_initials = COALESCE(?, avatar_initials),
        is_active = COALESCE(?, is_active),
        updated_at = datetime('now')
      WHERE id = ?
    `,
    [input.name, input.businessType, input.avatarInitials, input.isActive, userId]
  );
};
const getProducts = (filter) => {
  const clauses = ["p.user_id = ?"];
  const params = [filter.userId];
  if (!filter.includeArchived) {
    clauses.push("p.is_archived = 0");
  }
  if (filter.category) {
    clauses.push("p.category = ?");
    params.push(filter.category);
  }
  if (filter.search) {
    clauses.push("(p.name LIKE ? OR p.description LIKE ? OR CAST(p.id AS TEXT) LIKE ?)");
    params.push(`%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`);
  }
  params.push(filter.limit ?? 50, filter.offset ?? 0);
  return all(
    `
      SELECT p.*, COALESCE(SUM(s.quantity), 0) AS total_quantity, COUNT(v.id) AS variant_count
      FROM products p
      LEFT JOIN product_variants v ON v.product_id = p.id
      LEFT JOIN stock s ON s.variant_id = v.id
      WHERE ${clauses.join(" AND ")}
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `,
    params
  );
};
const getProductById = (productId) => {
  const product = get("SELECT * FROM products WHERE id = ?", [productId]);
  if (!product) {
    return void 0;
  }
  const variants = all(
    `
      SELECT v.*, COALESCE(s.quantity, 0) AS quantity
      FROM product_variants v
      LEFT JOIN stock s ON s.variant_id = v.id
      WHERE v.product_id = ?
      ORDER BY v.id ASC
    `,
    [productId]
  );
  return { ...product, variants };
};
const createProduct = async (input) => {
  const variantInputs = input.variants?.length ? input.variants : [{ attributes: {}, initialQuantity: 0 }];
  getDatabase();
  const insertProduct = transaction(() => {
    const result = run(
      `
        INSERT INTO products (
          user_id, name, category, description, cost_price, sell_price, unit, low_stock_threshold
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        input.userId,
        input.name,
        input.category ?? "other",
        input.description ?? "",
        input.costPrice ?? 0,
        input.sellPrice ?? 0,
        input.unit ?? "piece",
        input.lowStockThreshold ?? 5
      ]
    );
    const productId2 = Number(result.lastInsertRowid);
    const variantIds2 = [];
    for (const variantInput of variantInputs) {
      const attributes = "attributes" in variantInput && typeof variantInput.attributes === "object" ? variantInput.attributes : variantInput;
      const initialQuantity = "initialQuantity" in variantInput && typeof variantInput.initialQuantity === "number" ? Math.max(0, variantInput.initialQuantity) : 0;
      const variant = run(
        `
          INSERT INTO product_variants (product_id, sku, attributes)
          VALUES (?, ?, ?)
        `,
        [productId2, `PENDING-${productId2}-${Date.now()}-${variantIds2.length}`, JSON.stringify(attributes)]
      );
      const variantId = Number(variant.lastInsertRowid);
      const sku = skuFor(productId2, variantId);
      run("UPDATE product_variants SET sku = ? WHERE id = ?", [sku, variantId]);
      run("INSERT INTO stock (variant_id, quantity) VALUES (?, ?)", [variantId, initialQuantity]);
      if (initialQuantity > 0) {
        run(
          `
            INSERT INTO stock_movements (
              variant_id, user_id, type, quantity_delta, quantity_before, quantity_after, note
            )
            VALUES (?, ?, 'restock', ?, 0, ?, 'Initial stock')
          `,
          [variantId, input.userId, initialQuantity, initialQuantity]
        );
      }
      variantIds2.push(variantId);
    }
    return { productId: productId2, variantIds: variantIds2 };
  });
  const { productId, variantIds } = insertProduct();
  for (const variantId of variantIds) {
    const sku = skuFor(productId, variantId);
    const qrCodeData = await qrFor(sku);
    run("UPDATE product_variants SET qr_code_data = ? WHERE id = ?", [qrCodeData, variantId]);
  }
  return getProductById(productId);
};
const updateProduct = (productId, input) => {
  return run(
    `
      UPDATE products
      SET
        name = COALESCE(?, name),
        category = COALESCE(?, category),
        description = COALESCE(?, description),
        cost_price = COALESCE(?, cost_price),
        sell_price = COALESCE(?, sell_price),
        unit = COALESCE(?, unit),
        low_stock_threshold = COALESCE(?, low_stock_threshold),
        is_archived = COALESCE(?, is_archived),
        archived_reason = COALESCE(?, archived_reason),
        archived_at = CASE WHEN ? = 1 THEN datetime('now') ELSE archived_at END,
        updated_at = datetime('now')
      WHERE id = ?
    `,
    [
      input.name,
      input.category,
      input.description,
      input.costPrice,
      input.sellPrice,
      input.unit,
      input.lowStockThreshold,
      input.isArchived,
      input.archivedReason,
      input.isArchived,
      productId
    ]
  );
};
const deleteProduct = (productId, deletedBy, reason = "") => {
  const remove = transaction(() => {
    const snapshot = getProductById(productId);
    if (!snapshot) {
      return { changes: 0, lastInsertRowid: 0 };
    }
    run(
      "INSERT INTO archives (product_id, product_snapshot, deleted_by, reason) VALUES (?, ?, ?, ?)",
      [productId, JSON.stringify(snapshot), deletedBy, reason]
    );
    return run("DELETE FROM products WHERE id = ?", [productId]);
  });
  return remove();
};
const getVariantBySku = (sku, userId) => {
  return get(
    `
      SELECT v.*, p.name AS product_name, p.category, p.low_stock_threshold, p.sell_price, COALESCE(s.quantity, 0) AS quantity
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN stock s ON s.variant_id = v.id
      WHERE v.sku = ? AND p.user_id = ?
    `,
    [sku, userId]
  );
};
const getVariantsByProduct = (productId) => {
  return all(
    `
      SELECT v.*, COALESCE(s.quantity, 0) AS quantity
      FROM product_variants v
      LEFT JOIN stock s ON s.variant_id = v.id
      WHERE v.product_id = ?
      ORDER BY v.id ASC
    `,
    [productId]
  );
};
const addVariantQuantity = (variantId, userId, quantity, note = "") => {
  return applyStockMovement(variantId, userId, "restock", Math.abs(quantity), void 0, note);
};
const applyStockMovement = (variantId, userId, type, quantityDelta, buyerName, note = "") => {
  const apply = transaction(() => {
    const stock = get("SELECT quantity FROM stock WHERE variant_id = ?", [variantId]);
    if (!stock) {
      throw new Error(`Stock row not found for variant ${variantId}`);
    }
    const quantityBefore = stock.quantity;
    const quantityAfter = quantityBefore + quantityDelta;
    if (quantityAfter < 0) {
      throw new Error("Stock quantity cannot go below zero");
    }
    run("UPDATE stock SET quantity = ?, updated_at = datetime('now') WHERE variant_id = ?", [quantityAfter, variantId]);
    return run(
      `
        INSERT INTO stock_movements (
          variant_id, user_id, type, quantity_delta, quantity_before, quantity_after, buyer_name, note
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [variantId, userId, type, quantityDelta, quantityBefore, quantityAfter, buyerName, note]
    );
  });
  return apply();
};
const recordSale = (input) => {
  const quantity = input.quantity ?? 1;
  const record = transaction(() => {
    const variant = get(
      `
        SELECT p.sell_price
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        WHERE v.id = ?
      `,
      [input.variantId]
    );
    if (!variant) {
      throw new Error(`Variant ${input.variantId} not found`);
    }
    const unitPrice = variant.sell_price;
    const total = unitPrice * quantity;
    const sale = run(
      `
        INSERT INTO sales (variant_id, user_id, quantity, unit_price, total, buyer_name)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [input.variantId, input.userId, quantity, unitPrice, total, input.buyerName]
    );
    const stock = get("SELECT quantity FROM stock WHERE variant_id = ?", [input.variantId]);
    if (!stock) {
      throw new Error(`Stock row not found for variant ${input.variantId}`);
    }
    const quantityBefore = stock.quantity;
    const quantityAfter = quantityBefore - quantity;
    run("UPDATE stock SET quantity = ?, updated_at = datetime('now') WHERE variant_id = ?", [quantityAfter, input.variantId]);
    run(
      `
        INSERT INTO stock_movements (
          variant_id, user_id, type, quantity_delta, quantity_before, quantity_after, buyer_name, note
        )
        VALUES (?, ?, 'sale', ?, ?, ?, ?, ?)
      `,
      [input.variantId, input.userId, -quantity, quantityBefore, quantityAfter, input.buyerName, input.note ?? ""]
    );
    if (input.buyerName?.trim()) {
      run(
        `
          INSERT INTO buyers (user_id, name, total_purchases, total_spent, last_purchase)
          VALUES (?, ?, 1, ?, datetime('now'))
          ON CONFLICT(user_id, name) DO UPDATE SET
            total_purchases = total_purchases + 1,
            total_spent = total_spent + excluded.total_spent,
            last_purchase = datetime('now')
        `,
        [input.userId, input.buyerName.trim(), total]
      );
    }
    return get("SELECT * FROM sales WHERE id = ?", [sale.lastInsertRowid]);
  });
  return record();
};
const getRecentSales = (userId, limit = 20) => {
  return all(
    `
      SELECT
        s.*,
        p.id AS product_id,
        p.name AS product_name,
        p.cost_price,
        v.sku,
        v.attributes
      FROM sales s
      JOIN product_variants v ON v.id = s.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE s.user_id = ?
      ORDER BY s.sold_at DESC
      LIMIT ?
    `,
    [userId, limit]
  );
};
const getSalesByRange = (from, to) => {
  return all("SELECT * FROM sales WHERE sold_at BETWEEN ? AND ? ORDER BY sold_at DESC", [from, to]);
};
const getAllStock = (userId) => {
  return all(
    `
    SELECT
      v.id AS variant_id,
      p.id AS product_id,
      p.name AS product_name,
      p.category,
      v.sku,
      v.attributes,
      v.qr_code_data,
      COALESCE(s.quantity, 0) AS quantity,
      p.low_stock_threshold,
      p.cost_price,
      p.sell_price
      ,s.updated_at AS last_updated
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN stock s ON s.variant_id = v.id
    WHERE p.user_id = ? AND p.is_archived = 0
    ORDER BY p.name ASC, v.id ASC
  `,
    [userId]
  );
};
const getLowStock = (userId) => {
  return all(
    `
    SELECT
      v.id AS variant_id,
      p.id AS product_id,
      p.name AS product_name,
      p.category,
      v.sku,
      v.attributes,
      v.qr_code_data,
      COALESCE(s.quantity, 0) AS quantity,
      p.low_stock_threshold,
      p.cost_price,
      p.sell_price,
      s.updated_at AS last_updated
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN stock s ON s.variant_id = v.id
    WHERE p.user_id = ? AND p.is_archived = 0 AND COALESCE(s.quantity, 0) <= p.low_stock_threshold
    ORDER BY s.quantity ASC
  `,
    [userId]
  );
};
const getDailySummary = (from, to) => {
  return summaryBy("strftime('%Y-%m-%d', sold_at)", from, to);
};
const getWeeklySummary = (from, to) => {
  return summaryBy("strftime('%Y-W%W', sold_at)", from, to);
};
const summaryBy = (periodExpression, from, to) => {
  const params = [];
  const where = from && to ? "WHERE sold_at BETWEEN ? AND ?" : "";
  if (from && to) {
    params.push(from, to);
  }
  return all(
    `
      SELECT
        ${periodExpression} AS period,
        COUNT(s.id) AS sale_count,
        COUNT(DISTINCT v.product_id) AS unique_products,
        COALESCE(SUM(s.quantity), 0) AS quantity,
        COALESCE(SUM(s.total), 0) AS total,
        COALESCE(SUM((s.unit_price - p.cost_price) * s.quantity), 0) AS profit,
        COALESCE(SUM(p.cost_price * s.quantity), 0) AS cost
      FROM sales s
      JOIN product_variants v ON v.id = s.variant_id
      JOIN products p ON p.id = v.product_id
      ${where}
      GROUP BY period
      ORDER BY period DESC
    `,
    params
  );
};
const getTopProducts = (limit = 10) => {
  return all(
    `
      SELECT p.id, p.name, SUM(s.quantity) AS quantity_sold, SUM(s.total) AS total
      FROM sales s
      JOIN product_variants v ON v.id = s.variant_id
      JOIN products p ON p.id = v.product_id
      GROUP BY p.id
      ORDER BY quantity_sold DESC
      LIMIT ?
    `,
    [limit]
  );
};
const getTopBuyers = (limit = 10) => {
  return all("SELECT * FROM buyers ORDER BY total_spent DESC LIMIT ?", [limit]);
};
const getSummaryByRange = (userId, startDate, endDate) => {
  return all(
    `
      SELECT
        DATE(s.sold_at) as day,
        COUNT(*) as total_sales,
        COALESCE(SUM(s.quantity), 0) as total_units,
        COALESCE(SUM(s.total), 0) as revenue,
        COALESCE(SUM(s.total - (s.quantity * p.cost_price)), 0) as profit,
        COUNT(DISTINCT p.id) as unique_products
      FROM sales s
      JOIN product_variants v ON s.variant_id = v.id
      JOIN products p ON v.product_id = p.id
      WHERE s.user_id = ? AND s.sold_at BETWEEN ? AND ?
      GROUP BY day
      ORDER BY day ASC
    `,
    [userId, startDate, endDate]
  );
};
const getHourlyPattern = (userId, startDate, endDate) => {
  return all(
    `
      SELECT CAST(strftime('%H', sold_at) AS INTEGER) as hour, COUNT(*) as sales_count
      FROM sales
      WHERE user_id = ? AND sold_at BETWEEN ? AND ?
      GROUP BY hour
      ORDER BY hour ASC
    `,
    [userId, startDate, endDate]
  );
};
const getCategoryBreakdown = (userId, startDate, endDate) => {
  return all(
    `
      SELECT p.category, COUNT(*) as sales_count, COALESCE(SUM(s.total), 0) as revenue, COALESCE(SUM(s.quantity), 0) as units
      FROM sales s
      JOIN product_variants v ON s.variant_id = v.id
      JOIN products p ON v.product_id = p.id
      WHERE p.user_id = ? AND s.sold_at BETWEEN ? AND ?
      GROUP BY p.category
      ORDER BY revenue DESC
    `,
    [userId, startDate, endDate]
  );
};
const getPeriodComparison = (userId, currentStart, currentEnd, prevStart, prevEnd) => {
  const current = getSummaryByRange(userId, currentStart, currentEnd);
  const previous = getSummaryByRange(userId, prevStart, prevEnd);
  return { current, previous };
};
const getSalesLogByRange = (userId, startDate, endDate) => {
  return all(
    `
      SELECT
        s.*,
        p.name AS product_name,
        v.attributes,
        v.sku
      FROM sales s
      JOIN product_variants v ON s.variant_id = v.id
      JOIN products p ON v.product_id = p.id
      WHERE s.user_id = ? AND s.sold_at BETWEEN ? AND ?
      ORDER BY s.sold_at DESC
    `,
    [userId, startDate, endDate]
  );
};
const economyDateClause = (alias, startDate, endDate) => {
  return startDate && endDate ? `AND ${alias}.sold_at BETWEEN ? AND ?` : "";
};
const economyParams = (userId, limitOrStart, startOrEnd, maybeEnd) => {
  if (typeof limitOrStart === "number") {
    return startOrEnd && maybeEnd ? [userId, startOrEnd, maybeEnd, limitOrStart] : [userId, limitOrStart];
  }
  return limitOrStart && startOrEnd ? [userId, limitOrStart, startOrEnd] : [userId];
};
const getEconomyTopProducts = (userId, limit = 20, startDate, endDate) => {
  return all(
    `
      SELECT
        p.id, p.name, p.category, p.sell_price, p.cost_price,
        COALESCE(SUM(s.quantity), 0) as units_sold,
        COALESCE(SUM(s.total), 0) as revenue,
        COALESCE(SUM(s.total - (s.quantity * p.cost_price)), 0) as profit,
        COUNT(DISTINCT s.id) as transaction_count
      FROM sales s
      JOIN product_variants v ON s.variant_id = v.id
      JOIN products p ON v.product_id = p.id
      WHERE p.user_id = ? ${economyDateClause("s", startDate, endDate)}
      GROUP BY p.id
      ORDER BY revenue DESC
      LIMIT ?
    `,
    economyParams(userId, limit, startDate, endDate)
  );
};
const getEconomyTopBuyers = (userId, limit = 20, startDate, endDate) => {
  if (startDate && endDate) {
    return all(
      `
        SELECT
          b.id, b.name,
          COUNT(s.id) as total_purchases,
          COALESCE(SUM(s.total), 0) as total_spent,
          MAX(s.sold_at) as last_purchase,
          COALESCE(SUM(s.total) / NULLIF(COUNT(s.id), 0), 0) as avg_order_value
        FROM sales s
        JOIN buyers b ON b.user_id = s.user_id AND b.name = s.buyer_name
        WHERE s.user_id = ? AND s.buyer_name IS NOT NULL AND s.sold_at BETWEEN ? AND ?
        GROUP BY b.id, b.name
        ORDER BY total_spent DESC
        LIMIT ?
      `,
      [userId, startDate, endDate, limit]
    );
  }
  return all(
    `
      SELECT
        id, name, total_purchases, total_spent, last_purchase,
        (total_spent / NULLIF(total_purchases, 0)) as avg_order_value
      FROM buyers
      WHERE user_id = ?
      ORDER BY total_spent DESC
      LIMIT ?
    `,
    [userId, limit]
  );
};
const getEconomyCategoryPerformance = (userId, startDate, endDate) => {
  return all(
    `
      SELECT
        p.category,
        COUNT(DISTINCT p.id) as product_count,
        COALESCE(SUM(s.quantity), 0) as units_sold,
        COALESCE(SUM(s.total), 0) as revenue,
        COALESCE(SUM(s.total - (s.quantity * p.cost_price)), 0) as profit,
        COALESCE(AVG(p.sell_price - p.cost_price), 0) as avg_margin
      FROM sales s
      JOIN product_variants v ON s.variant_id = v.id
      JOIN products p ON v.product_id = p.id
      WHERE p.user_id = ? ${economyDateClause("s", startDate, endDate)}
      GROUP BY p.category
      ORDER BY revenue DESC
    `,
    economyParams(userId, startDate, endDate)
  );
};
const getEconomySlowMovers = (userId, dayThreshold = 30) => {
  return all(
    `
      SELECT
        p.id, p.name, p.category,
        MAX(s.sold_at) as last_sale,
        COALESCE(SUM(st.quantity), 0) as current_stock,
        COALESCE(SUM(st.quantity * p.cost_price), 0) as tied_capital
      FROM products p
      JOIN product_variants v ON p.id = v.product_id
      JOIN stock st ON v.id = st.variant_id
      LEFT JOIN sales s ON v.id = s.variant_id
      WHERE p.user_id = ? AND p.is_archived = 0
      GROUP BY p.id
      HAVING current_stock > 0 AND (last_sale IS NULL OR last_sale < datetime('now', ?))
      ORDER BY tied_capital DESC
    `,
    [userId, `-${dayThreshold} days`]
  );
};
const getEconomyProfitableVariants = (userId) => {
  return all(
    `
      SELECT
        v.id as variant_id, v.sku, v.attributes,
        p.id as product_id, p.name, p.category, p.sell_price, p.cost_price,
        CASE WHEN p.cost_price = 0 THEN 0 ELSE ((p.sell_price - p.cost_price) / p.cost_price) * 100 END as margin_percent,
        (p.sell_price - p.cost_price) as profit_per_unit
      FROM product_variants v
      JOIN products p ON v.product_id = p.id
      WHERE p.user_id = ? AND p.is_archived = 0
      ORDER BY margin_percent DESC
    `,
    [userId]
  );
};
const getArchives = (userId, limit = 50, offset = 0, query = "", from, to) => {
  const clauses = [];
  const params = [];
  if (userId) {
    clauses.push("(json_extract(a.product_snapshot, '$.user_id') = ? OR json_extract(a.product_snapshot, '$.userId') = ?)");
    params.push(userId, userId);
  }
  if (query) {
    clauses.push("a.product_snapshot LIKE ?");
    params.push(`%${query}%`);
  }
  if (from) {
    clauses.push("a.archived_at >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("a.archived_at <= ?");
    params.push(to);
  }
  params.push(limit, offset);
  return all(
    `
      SELECT
        a.id,
        a.product_id,
        a.product_snapshot,
        a.reason,
        a.archived_at,
        u.name as deleted_by_name
      FROM archives a
      JOIN users u ON a.deleted_by = u.id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY a.archived_at DESC
      LIMIT ? OFFSET ?
    `,
    params
  );
};
const getArchiveCount = (userId, query = "", from, to) => {
  const clauses = ["(json_extract(product_snapshot, '$.user_id') = ? OR json_extract(product_snapshot, '$.userId') = ?)"];
  const params = [userId, userId];
  if (query) {
    clauses.push("product_snapshot LIKE ?");
    params.push(`%${query}%`);
  }
  if (from) {
    clauses.push("archived_at >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("archived_at <= ?");
    params.push(to);
  }
  return get(`SELECT COUNT(*) as total FROM archives WHERE ${clauses.join(" AND ")}`, params);
};
const restoreArchive = async (archiveId) => {
  const archive = get("SELECT product_snapshot FROM archives WHERE id = ?", [archiveId]);
  if (!archive) {
    return void 0;
  }
  const snapshot = JSON.parse(archive.product_snapshot);
  const created = await createProduct({
    userId: Number(snapshot.user_id ?? snapshot.userId),
    name: snapshot.name,
    category: snapshot.category,
    description: snapshot.description ?? "",
    costPrice: snapshot.cost_price ?? 0,
    sellPrice: snapshot.sell_price ?? 0,
    unit: snapshot.unit ?? "piece",
    lowStockThreshold: snapshot.low_stock_threshold ?? 5,
    variants: (snapshot.variants?.length ? snapshot.variants : [{ attributes: {} }]).map((variant) => ({
      attributes: typeof variant.attributes === "string" ? JSON.parse(variant.attributes || "{}") : variant.attributes,
      initialQuantity: 0
    }))
  });
  run("DELETE FROM archives WHERE id = ?", [archiveId]);
  return created;
};
const getSetting = (userId, key) => {
  return get("SELECT value FROM app_settings WHERE user_id = ? AND key = ?", [userId, key]);
};
const getAllSettings = (userId) => {
  seedDefaultSettings(userId);
  return all("SELECT key, value FROM app_settings WHERE user_id = ? ORDER BY key", [userId]);
};
const setSetting = (userId, key, value) => {
  return run(
    `
      INSERT INTO app_settings (user_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
    `,
    [userId, key, value]
  );
};
const getProfileStats = (userId) => {
  return get(
    `
      SELECT
        (SELECT COUNT(*) FROM products WHERE user_id = ? AND is_archived = 0) AS products,
        (SELECT COUNT(*) FROM sales WHERE user_id = ?) AS total_sales,
        (SELECT COALESCE(SUM(total), 0) FROM sales WHERE user_id = ?) AS total_revenue
    `,
    [userId, userId, userId]
  );
};
const getCategoryTemplates = () => {
  return all("SELECT * FROM category_templates ORDER BY name ASC");
};
const getStockMovements = (variantId) => {
  return all(
    `
      SELECT *
      FROM stock_movements
      WHERE variant_id = ?
      ORDER BY created_at DESC
    `,
    [variantId]
  );
};
const Store = ElectronStoreImport.default;
const registerAppProtocol = () => {
  electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ]);
};
let mainWindow = null;
registerAppProtocol();
electron.app.setPath("userData", node_path.join(electron.app.getPath("appData"), "StockFlow"));
electron.app.disableHardwareAcceleration();
electron.app.commandLine.appendSwitch("disable-gpu");
electron.app.commandLine.appendSwitch("disable-gpu-compositing");
electron.app.commandLine.appendSwitch("disable-gpu-sandbox");
electron.app.commandLine.appendSwitch("in-process-gpu");
electron.app.commandLine.appendSwitch(
  "disable-features",
  "UseSkiaRenderer,VizDisplayCompositor"
);
electron.app.commandLine.appendSwitch("no-sandbox");
electron.app.commandLine.appendSwitch("disable-setuid-sandbox");
electron.app.commandLine.appendSwitch("disable-dev-shm-usage");
const resolveAppIcon = () => {
  const candidates = electron.app.isPackaged ? [node_path.join(process.resourcesPath, "icon.png")] : [node_path.join(process.cwd(), "public", "icon.png")];
  const iconPath = candidates.find((path) => node_fs.existsSync(path));
  if (!iconPath) {
    return void 0;
  }
  const image = electron.nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? void 0 : image;
};
const windowStore = new Store({
  name: "stockflow-window",
  defaults: {
    windowState: { width: 1280, height: 800 }
  }
});
const getSavedWindowBounds = () => {
  const saved = windowStore.get("windowState");
  if (saved.x === void 0 || saved.y === void 0) {
    return saved;
  }
  const onScreen = electron.screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea;
    return saved.x >= x && saved.x < x + width && saved.y >= y && saved.y < y + height;
  });
  if (!onScreen) {
    return { width: saved.width, height: saved.height };
  }
  return saved;
};
let saveWindowStateTimer = null;
const saveWindowState = (window) => {
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
      isMaximized
    });
  }, 500);
};
const attachWindowStateHandlers = (window) => {
  window.on("resize", () => saveWindowState(window));
  window.on("move", () => saveWindowState(window));
  window.on("close", () => saveWindowState(window));
};
const loadRenderer = async (window) => {
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, url) => {
      console.error(
        `[renderer] did-fail-load: code=${errorCode} desc=${errorDescription} url=${url}`
      );
    }
  );
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      "[renderer] render-process-gone:",
      details.reason,
      details.exitCode
    );
  });
  if (!process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL("app://renderer/index.html");
    return;
  }
  let retryCount = 0;
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, _description, url) => {
      if (url !== process.env.ELECTRON_RENDERER_URL || errorCode === -3 || retryCount >= 10) {
        return;
      }
      retryCount += 1;
      setTimeout(() => {
        void window.loadURL(process.env.ELECTRON_RENDERER_URL);
      }, 300);
    }
  );
  await window.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => void 0);
};
const createWindow = async () => {
  const saved = getSavedWindowBounds();
  mainWindow = new electron.BrowserWindow({
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
      preload: node_path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // ✅ FIX 5: Disable sandbox in webPreferences as well for packaged apps
      sandbox: false
    }
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
const registerIpcHandlers = () => {
  electron.ipcMain.handle(
    "db:run",
    (_event, sql, params = []) => run(sql, params)
  );
  electron.ipcMain.handle(
    "db:get",
    (_event, sql, params = []) => get(sql, params)
  );
  electron.ipcMain.handle(
    "db:all",
    (_event, sql, params = []) => all(sql, params)
  );
  electron.ipcMain.handle("db:users:getAll", () => getAllUsers());
  electron.ipcMain.handle("db:users:getById", (_event, id) => getUserById(id));
  electron.ipcMain.handle("db:users:create", (_event, input) => createUser(input));
  electron.ipcMain.handle(
    "db:users:updatePassword",
    (_event, userId, passwordHash) => updateUserPassword(userId, passwordHash)
  );
  electron.ipcMain.handle(
    "db:users:updateSettings",
    (_event, userId, input) => updateUserSettings(userId, input)
  );
  electron.ipcMain.handle("db:products:getAll", (_event, filter) => getProducts(filter));
  electron.ipcMain.handle(
    "db:products:getById",
    (_event, productId) => getProductById(productId)
  );
  electron.ipcMain.handle("db:products:create", (_event, input) => createProduct(input));
  electron.ipcMain.handle(
    "db:products:update",
    (_event, productId, input) => updateProduct(productId, input)
  );
  electron.ipcMain.handle(
    "db:products:delete",
    (_event, productId, deletedBy, reason) => deleteProduct(productId, deletedBy, reason)
  );
  electron.ipcMain.handle(
    "db:variants:getBySku",
    (_event, sku, userId) => getVariantBySku(sku, userId)
  );
  electron.ipcMain.handle(
    "db:variants:getByProduct",
    (_event, productId) => getVariantsByProduct(productId)
  );
  electron.ipcMain.handle(
    "db:variants:addQty",
    (_event, variantId, userId, quantity, note) => addVariantQuantity(variantId, userId, quantity, note)
  );
  electron.ipcMain.handle("db:sales:record", (_event, input) => recordSale(input));
  electron.ipcMain.handle(
    "db:sales:getRecent",
    (_event, userId, limit) => getRecentSales(userId, limit)
  );
  electron.ipcMain.handle(
    "db:sales:getByRange",
    (_event, from, to) => getSalesByRange(from, to)
  );
  electron.ipcMain.handle(
    "db:stock:getAll",
    (_event, userId) => getAllStock(userId)
  );
  electron.ipcMain.handle(
    "db:stock:getLow",
    (_event, userId) => getLowStock(userId)
  );
  electron.ipcMain.handle(
    "db:stock:getMovements",
    (_event, variantId) => getStockMovements(variantId)
  );
  electron.ipcMain.handle(
    "file:saveCsv",
    async (_event, filename, content) => {
      const result = await electron.dialog.showSaveDialog({
        defaultPath: filename,
        filters: [{ name: "CSV", extensions: ["csv"] }]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      await promises.writeFile(result.filePath, content, "utf8");
      return { canceled: false, filePath: result.filePath };
    }
  );
  electron.ipcMain.handle("file:exportBackup", async () => {
    const result = await electron.dialog.showSaveDialog({
      defaultPath: `stockflow-backup-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.db`,
      filters: [{ name: "SQLite database", extensions: ["db"] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await promises.copyFile(
      node_path.join(electron.app.getPath("userData"), "stockflow.db"),
      result.filePath
    );
    return { canceled: false, filePath: result.filePath };
  });
  electron.ipcMain.handle("file:importBackup", async () => {
    const result = await electron.dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "SQLite database", extensions: ["db"] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    await promises.copyFile(
      result.filePaths[0],
      node_path.join(electron.app.getPath("userData"), "stockflow.db")
    );
    return { canceled: false, filePath: result.filePaths[0] };
  });
  electron.ipcMain.handle(
    "db:reports:dailySummary",
    (_event, from, to) => getDailySummary(from, to)
  );
  electron.ipcMain.handle(
    "db:reports:weeklySummary",
    (_event, from, to) => getWeeklySummary(from, to)
  );
  electron.ipcMain.handle(
    "db:reports:topProducts",
    (_event, limit) => getTopProducts(limit)
  );
  electron.ipcMain.handle(
    "db:reports:topBuyers",
    (_event, limit) => getTopBuyers(limit)
  );
  electron.ipcMain.handle(
    "db:reports:summaryByRange",
    (_event, userId, start, end) => getSummaryByRange(userId, start, end)
  );
  electron.ipcMain.handle(
    "db:reports:hourlyPattern",
    (_event, userId, start, end) => getHourlyPattern(userId, start, end)
  );
  electron.ipcMain.handle(
    "db:reports:categoryBreakdown",
    (_event, userId, start, end) => getCategoryBreakdown(userId, start, end)
  );
  electron.ipcMain.handle(
    "db:reports:periodComparison",
    (_event, userId, currentStart, currentEnd, prevStart, prevEnd) => getPeriodComparison(userId, currentStart, currentEnd, prevStart, prevEnd)
  );
  electron.ipcMain.handle(
    "db:reports:salesLog",
    (_event, userId, start, end) => getSalesLogByRange(userId, start, end)
  );
  electron.ipcMain.handle(
    "db:economy:topProducts",
    (_event, userId, limit, start, end) => getEconomyTopProducts(userId, limit, start, end)
  );
  electron.ipcMain.handle(
    "db:economy:topBuyers",
    (_event, userId, limit, start, end) => getEconomyTopBuyers(userId, limit, start, end)
  );
  electron.ipcMain.handle(
    "db:economy:categoryPerformance",
    (_event, userId, start, end) => getEconomyCategoryPerformance(userId, start, end)
  );
  electron.ipcMain.handle(
    "db:economy:slowMovers",
    (_event, userId, dayThreshold) => getEconomySlowMovers(userId, dayThreshold)
  );
  electron.ipcMain.handle(
    "db:economy:profitableVariants",
    (_event, userId) => getEconomyProfitableVariants(userId)
  );
  electron.ipcMain.handle(
    "db:archives:getAll",
    (_event, userId, limit, offset, query, from, to) => getArchives(userId, limit, offset, query, from, to)
  );
  electron.ipcMain.handle(
    "db:archives:count",
    (_event, userId, query, from, to) => getArchiveCount(userId, query, from, to)
  );
  electron.ipcMain.handle(
    "db:archives:restore",
    (_event, archiveId) => restoreArchive(archiveId)
  );
  electron.ipcMain.handle(
    "db:settings:get",
    (_event, userId, key) => getSetting(userId, key)
  );
  electron.ipcMain.handle(
    "db:settings:getAll",
    (_event, userId) => getAllSettings(userId)
  );
  electron.ipcMain.handle(
    "db:settings:set",
    (_event, userId, key, value) => setSetting(userId, key, value)
  );
  electron.ipcMain.handle(
    "db:profile:stats",
    (_event, userId) => getProfileStats(userId)
  );
  electron.ipcMain.handle("db:categoryTemplates:getAll", () => getCategoryTemplates());
  electron.ipcMain.handle("window:minimize", () => {
    electron.BrowserWindow.getFocusedWindow()?.minimize();
  });
  electron.ipcMain.handle("window:maximize", () => {
    const window = electron.BrowserWindow.getFocusedWindow();
    if (!window) {
      return;
    }
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });
  electron.ipcMain.handle("window:close", () => {
    electron.BrowserWindow.getFocusedWindow()?.close();
  });
  electron.ipcMain.handle("shell:open-external", (_event, url) => {
    void electron.shell.openExternal(url);
  });
  electron.ipcMain.handle("shell:open-path", (_event, path) => {
    void electron.shell.openPath(path);
  });
  electron.ipcMain.handle("print:label", async (_event, html) => {
    const printWindow = new electron.BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    await printWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    );
    await new Promise((resolve) => {
      printWindow.webContents.print(
        { silent: false, printBackground: true },
        () => {
          printWindow.close();
          resolve();
        }
      );
    });
  });
  electron.ipcMain.handle("app:get-info", () => {
    const platformLabels = {
      win32: "Windows",
      darwin: "macOS",
      linux: "Linux"
    };
    const userDataPath = electron.app.getPath("userData");
    return {
      version: electron.app.getVersion(),
      platform: platformLabels[process.platform] ?? process.platform,
      userDataPath,
      dbPath: node_path.join(userDataPath, "stockflow.db")
    };
  });
};
electron.app.whenReady().then(async () => {
  electron.protocol.handle("app", (request) => {
    const url = request.url.replace("app://renderer/", "");
    const rendererPath = node_path.join(electron.app.getAppPath(), "out/renderer", url);
    return electron.net.fetch("file://" + rendererPath);
  });
  initDatabase();
  registerIpcHandlers();
  await createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
