const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "kanban-secret-change-in-production";
const DB_PATH = path.join(__dirname, "data", "kanban.db");

// Ensure data dir
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;

function saveDb() {
  const buf = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(buf));
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function dbExec(sql) {
  db.exec(sql);
  saveDb();
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token" });
  }
  try {
    const token = header.slice(7);
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ---- Auth Routes ----

app.post("/api/auth/register", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters" });
  }

  const existing = dbGet("SELECT id FROM users WHERE email = ?", [email]);
  if (existing) {
    return res.status(409).json({ error: "Email already registered" });
  }

  const hash = bcrypt.hashSync(password, 10);
  dbRun("INSERT INTO users (email, password_hash) VALUES (?, ?)", [email, hash]);

  const user = dbGet("SELECT id, email FROM users WHERE email = ?", [email]);

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  res.json({ token, user: { id: user.id, email: user.email } });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const user = dbGet("SELECT * FROM users WHERE email = ?", [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  res.json({ token, user: { id: user.id, email: user.email } });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// ---- Task Routes ----

app.get("/api/tasks", auth, (req, res) => {
  const tasks = dbAll("SELECT * FROM tasks WHERE user_id = ? ORDER BY position ASC", [req.user.id]);
  // sql.js returns lowercase column names from getAsObject()
  const normalized = tasks.map((t) => ({
    id: t.id,
    user_id: t.user_id,
    title: t.title,
    description: t.description,
    column_name: t.column_name,
    position: t.position,
    due_date: t.due_date,
    created_at: t.created_at,
  }));
  res.json({ tasks: normalized });
});

app.post("/api/tasks", auth, (req, res) => {
  const { title, description, column_name, due_date } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "Title is required" });
  }

  const col = column_name || "backlog";
  const validCols = ["backlog", "todo", "in_progress", "done"];
  if (!validCols.includes(col)) {
    return res.status(400).json({ error: "Invalid column: " + col });
  }

  // Get max position in this column
  const row = dbGet(
    "SELECT COALESCE(MAX(position), 0) as max_pos FROM tasks WHERE user_id = ? AND column_name = ?",
    [req.user.id, col]
  );
  const newPos = (row && row.max_pos != null) ? row.max_pos + 1 : 1;

  // Use db.prepare().run() to get last_insert_rowid reliably
  const stmt = db.prepare(
    "INSERT INTO tasks (user_id, title, description, column_name, position, due_date) VALUES (?, ?, ?, ?, ?, ?)"
  );
  stmt.run([req.user.id, title.trim(), description || "", col, newPos, due_date || null]);
  stmt.free();

  const lastIdResult = db.exec("SELECT last_insert_rowid() as id");
  let lastId;
  if (lastIdResult && lastIdResult.length > 0 && lastIdResult[0].values && lastIdResult[0].values.length > 0) {
    lastId = lastIdResult[0].values[0][0];
  }

  const task = lastId ? dbGet("SELECT * FROM tasks WHERE id = ?", [lastId]) : null;

  if (!task) {
    // Fallback: get the latest task for this user
    const fallback = dbGet(
      "SELECT * FROM tasks WHERE user_id = ? ORDER BY id DESC LIMIT 1",
      [req.user.id]
    );
    if (!fallback) {
      return res.status(500).json({ error: "Failed to create task" });
    }
    // Use fallback but save after
    saveDb();
    return res.status(201).json({
      task: {
        id: fallback.id,
        user_id: fallback.user_id,
        title: fallback.title,
        description: fallback.description,
        column_name: fallback.column_name,
        position: fallback.position,
        due_date: fallback.due_date,
        created_at: fallback.created_at,
      },
    });
  }

  saveDb();

  res.status(201).json({
    task: {
      id: task.id,
      user_id: task.user_id,
      title: task.title,
      description: task.description,
      column_name: task.column_name,
      position: task.position,
      due_date: task.due_date,
      created_at: task.created_at,
    },
  });
});

app.put("/api/tasks/:id", auth, (req, res) => {
  const taskId = parseInt(req.params.id);
  const task = dbGet("SELECT * FROM tasks WHERE id = ? AND user_id = ?", [taskId, req.user.id]);

  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  const { title, description, column_name, position, due_date } = req.body;

  if (title !== undefined && title.trim() === "") {
    return res.status(400).json({ error: "Title cannot be empty" });
  }

  const updates = [];
  const params = [];

  if (title !== undefined) {
    updates.push("title = ?");
    params.push(title.trim());
  }
  if (description !== undefined) {
    updates.push("description = ?");
    params.push(description);
  }
  if (column_name !== undefined) {
    const validCols = ["backlog", "todo", "in_progress", "done"];
    if (!validCols.includes(column_name)) {
      return res.status(400).json({ error: "Invalid column: " + column_name });
    }
    updates.push("column_name = ?");
    params.push(column_name);
  }
  if (position !== undefined) {
    updates.push("position = ?");
    params.push(position);
  }
  if (due_date !== undefined) {
    updates.push("due_date = ?");
    params.push(due_date);
  }

  if (updates.length > 0) {
    params.push(taskId, req.user.id);
    dbRun(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`, params);
  }

  const updated = dbGet("SELECT * FROM tasks WHERE id = ?", [taskId]);
  res.json({
    task: {
      id: updated.id,
      user_id: updated.user_id,
      title: updated.title,
      description: updated.description,
      column_name: updated.column_name,
      position: updated.position,
      due_date: updated.due_date,
      created_at: updated.created_at,
    },
  });
});

// Batch update positions (for drag & drop)
app.post("/api/tasks/reorder", auth, (req, res) => {
  const { tasks: taskUpdates } = req.body;
  if (!Array.isArray(taskUpdates)) {
    return res.status(400).json({ error: "tasks array required" });
  }

  // Use a manual transaction-like approach: run all, save once
  for (const t of taskUpdates) {
    db.run("UPDATE tasks SET column_name = ?, position = ? WHERE id = ? AND user_id = ?", [
      t.column_name,
      t.position,
      t.id,
      req.user.id,
    ]);
  }
  saveDb();

  res.json({ ok: true });
});

app.delete("/api/tasks/:id", auth, (req, res) => {
  const taskId = parseInt(req.params.id);
  // Check existence first
  const task = dbGet("SELECT id FROM tasks WHERE id = ? AND user_id = ?", [taskId, req.user.id]);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  dbRun("DELETE FROM tasks WHERE id = ? AND user_id = ?", [taskId, req.user.id]);
  res.json({ ok: true });
});

// SPA fallback: serve index.html for any non-API route
app.get(/^\/(?!api\/)/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- Init DB & Start Server ----
async function start() {
  const SQL = await initSqlJs();

  // Load or create database
  if (fs.existsSync(DB_PATH)) {
    const fileBuf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuf);
    console.log("Database loaded from file");
  } else {
    db = new SQL.Database();
    console.log("New database created");
  }

  // Create tables
  dbExec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  dbExec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      column_name TEXT NOT NULL DEFAULT 'backlog',
      position INTEGER NOT NULL DEFAULT 0,
      due_date TEXT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Migrate: add due_date column if not exists
  try {
    const cols = db.exec("PRAGMA table_info(tasks)");
    if (cols && cols.length > 0) {
      const colNames = cols[0].values.map((r) => r[1]); // column name is index 1
      if (!colNames.includes("due_date")) {
        dbExec("ALTER TABLE tasks ADD COLUMN due_date TEXT NULL");
        console.log("Migration: added due_date column");
      }
    }
  } catch (e) {
    // Ignore if migration fails (e.g. column already exists in older sql.js)
  }

  // Seed positions
  dbRun("UPDATE tasks SET position = id WHERE position = 0");

  app.listen(PORT, () => {
    console.log(`Kanban server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});