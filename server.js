// ============================================================
//  Kanban Server — Express + SQLite (sql.js) + JWT-аутентификация
// ============================================================

const express = require("express");
const jwt = require("jsonwebtoken");   // access + refresh токены
const bcrypt = require("bcryptjs");    // хеширование паролей
const initSqlJs = require("sql.js");   // SQLite, скомпилирован в WebAssembly (не требует установки)
const fs = require("fs");
const path = require("path");

const app = express();

// ---- Конфигурация из переменных окружения ----
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
// Если секрет не задан — сервер не запустится (защита от случайного деплоя без секрета)
if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is not set");
  process.exit(1);
}
const ACCESS_EXPIRES_IN = process.env.ACCESS_EXPIRES_IN || "15m";    // access-токен: 15 минут
const REFRESH_EXPIRES_IN = process.env.REFRESH_EXPIRES_IN || "30d";  // refresh-токен: 30 дней
const DB_PATH = path.join(__dirname, "data", "kanban.db");

// Создаём папку data/, если её нет
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Глобальное подключение к БД (открывается при старте сервера)
let db;

// ============================================================
//  Хранилище refresh-токенов (в памяти)
//  Структура: Map<userId, Set<refreshToken>>
//  В продакшене с несколькими инстансами нужно заменить на Redis
//  или отдельную таблицу в БД.
// ============================================================
const refreshTokens = new Map();

// ============================================================
//  Вспомогательные функции для работы с БД
//  sql.js не имеет асинхронного API — всё синхронно.
//  После каждого изменения вызываем saveDb() —
//  экспортируем БД в бинарный буфер и пишем на диск.
// ============================================================

// Сохранить БД на диск
function saveDb() {
  const buf = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(buf));
}

// Выполнить INSERT/UPDATE/DELETE и сразу сохранить
function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// Получить одну строку (SELECT ... LIMIT 1) или null
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params); // подставляем ?-параметры
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free(); // обязательно освобождаем prepared statement
  return result;
}

// Получить все строки запроса
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

// Выполнить SQL без параметров (CREATE TABLE, ALTER TABLE, PRAGMA и т.д.)
function dbExec(sql) {
  db.exec(sql);
  saveDb();
}

// ============================================================
//  Middleware
// ============================================================

// Парсинг JSON-тела запросов
app.use(express.json());
// Раздача статических файлов из public/ (index.html, app.js, style.css и др.)
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
//  Работа с JWT-токенами
// ============================================================

/**
 * Создать access-токен (короткоживущий, 15 минут).
 * payload.type = "access" — чтобы отличать от refresh-токена.
 */
function generateAccessToken(user) {
  return jwt.sign({ id: user.id, email: user.email, type: "access" }, JWT_SECRET, {
    expiresIn: ACCESS_EXPIRES_IN,
  });
}

/**
 * Создать refresh-токен (долгоживущий, 30 дней).
 * payload.type = "refresh" — не может использоваться для доступа к API.
 */
function generateRefreshToken(user) {
  return jwt.sign({ id: user.id, type: "refresh" }, JWT_SECRET, {
    expiresIn: REFRESH_EXPIRES_IN,
  });
}

// Сохранить refresh-токен в памяти (привязываем к userId)
function storeRefreshToken(userId, token) {
  if (!refreshTokens.has(userId)) {
    refreshTokens.set(userId, new Set());
  }
  refreshTokens.get(userId).add(token);
}

// Удалить один конкретный refresh-токен (при ротации)
function removeRefreshToken(userId, token) {
  const userTokens = refreshTokens.get(userId);
  if (userTokens) {
    userTokens.delete(token);
    if (userTokens.size === 0) {
      // Нет токенов — удаляем запись о пользователе
      refreshTokens.delete(userId);
    }
  }
}

// Удалить ВСЕ refresh-токены пользователя (при logout или force-logout)
function clearUserRefreshTokens(userId) {
  refreshTokens.delete(userId);
}

// ============================================================
//  Middleware аутентификации
//  Проверяет заголовок Authorization: Bearer <accessToken>
//  При невалидном токене возвращает 401.
// ============================================================
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token" });
  }
  try {
    const token = header.slice(7); // убираем "Bearer "
    const payload = jwt.verify(token, JWT_SECRET);
    // Проверяем, что это access-токен (refresh-токеном нельзя достучаться до API)
    if (payload.type !== "access") {
      return res.status(401).json({ error: "Invalid token type" });
    }
    req.user = payload; // кладём { id, email } в req.user
    next();
  } catch {
    // Токен просрочен или подпись не совпадает
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ============================================================
//  Маршруты авторизации
// ============================================================

// ---- Регистрация ----
app.post("/api/auth/register", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters" });
  }

  // Проверяем, не занят ли email
  const existing = dbGet("SELECT id FROM users WHERE email = ?", [email]);
  if (existing) {
    return res.status(409).json({ error: "Email already registered" });
  }

  // Хешируем пароль (bcrypt, 10 раундов соли)
  const hash = bcrypt.hashSync(password, 10);
  dbRun("INSERT INTO users (email, password_hash) VALUES (?, ?)", [email, hash]);

  // Получаем созданного пользователя
  const user = dbGet("SELECT id, email FROM users WHERE email = ?", [email]);

  // Создаём пару токенов
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  storeRefreshToken(user.id, refreshToken);

  // Отдаём клиенту токены + инфу о пользователе
  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email },
  });
});

// ---- Вход (логин) ----
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const user = dbGet("SELECT * FROM users WHERE email = ?", [email]);
  // Сравниваем пароль с хешем
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  storeRefreshToken(user.id, refreshToken);

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email },
  });
});

// ---- Обновление токенов (refresh) ----
// Клиент присылает refresh-токен, получает новую пару.
// Старый refresh-токен при этом отзывается (ротация).
app.post("/api/auth/refresh", (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ error: "No refresh token" });
  }

  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== "refresh") {
      return res.status(401).json({ error: "Invalid token type" });
    }

    // Проверяем, что токен есть в хранилище (не отозван)
    const userTokens = refreshTokens.get(payload.id);
    if (!userTokens || !userTokens.has(refreshToken)) {
      return res.status(401).json({ error: "Refresh token revoked" });
    }

    // Проверяем, что пользователь всё ещё существует в БД
    const user = dbGet("SELECT id, email FROM users WHERE id = ?", [payload.id]);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Ротация: удаляем старый refresh-токен, создаём новый
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);
    removeRefreshToken(user.id, refreshToken);
    storeRefreshToken(user.id, newRefreshToken);

    res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
});

// ---- Выход (logout) ----
// Отзывает все refresh-токены пользователя.
// Middleware auth НЕ используется — клиент может разлогиниться
// даже с просроченным access-токеном.
app.post("/api/auth/logout", (req, res) => {
  const { refreshToken } = req.body;

  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, JWT_SECRET);
      if (payload.type === "refresh") {
        // Удаляем ВСЕ refresh-токены пользователя
        // (выход на всех устройствах)
        clearUserRefreshTokens(payload.id);
      }
    } catch {
      // Если refresh-токен уже просрочен или невалиден —
      // это не ошибка, просто игнорируем
    }
  }

  res.json({ ok: true });
});

// ---- Текущий пользователь (проверка токена) ----
// Используется фронтендом при загрузке страницы:
// если токен валиден — показываем доску, иначе — форму логина.
app.get("/api/me", auth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// ============================================================
//  Маршруты для работы с задачами
//  Все требуют аутентификации (middleware auth).
// ============================================================

// ---- Получить все задачи текущего пользователя ----
// Сортируем по position (порядок в колонке).
app.get("/api/tasks", auth, (req, res) => {
  const tasks = dbAll(
    "SELECT * FROM tasks WHERE user_id = ? ORDER BY position ASC",
    [req.user.id]
  );
  // sql.js возвращает имена колонок в нижнем регистре — нормализуем
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

// ---- Создать новую задачу ----
app.post("/api/tasks", auth, (req, res) => {
  const { title, description, column_name, due_date } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "Title is required" });
  }

  const col = column_name || "backlog";
  // Разрешённые колонки
  const validCols = ["backlog", "todo", "in_progress", "done"];
  if (!validCols.includes(col)) {
    return res.status(400).json({ error: "Invalid column: " + col });
  }

  // Вычисляем position: максимальная позиция в колонке + 1
  const row = dbGet(
    "SELECT COALESCE(MAX(position), 0) as max_pos FROM tasks WHERE user_id = ? AND column_name = ?",
    [req.user.id, col]
  );
  const newPos = (row && row.max_pos != null) ? row.max_pos + 1 : 1;

  // Вставляем через prepare (точнее возвращает last_insert_rowid)
  const stmt = db.prepare(
    "INSERT INTO tasks (user_id, title, description, column_name, position, due_date) VALUES (?, ?, ?, ?, ?, ?)"
  );
  stmt.run([req.user.id, title.trim(), description || "", col, newPos, due_date || null]);
  stmt.free();

  // Получаем ID только что вставленной строки
  const lastIdResult = db.exec("SELECT last_insert_rowid() as id");
  let lastId;
  if (lastIdResult && lastIdResult.length > 0 && lastIdResult[0].values && lastIdResult[0].values.length > 0) {
    lastId = lastIdResult[0].values[0][0];
  }

  const task = lastId ? dbGet("SELECT * FROM tasks WHERE id = ?", [lastId]) : null;

  // Фолбэк: если не удалось получить ID через last_insert_rowid
  if (!task) {
    const fallback = dbGet(
      "SELECT * FROM tasks WHERE user_id = ? ORDER BY id DESC LIMIT 1",
      [req.user.id]
    );
    if (!fallback) {
      return res.status(500).json({ error: "Failed to create task" });
    }
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

// ---- Обновить задачу ----
// Можно обновить любые поля: title, description, column_name, position, due_date.
app.put("/api/tasks/:id", auth, (req, res) => {
  const taskId = parseInt(req.params.id);
  const task = dbGet("SELECT * FROM tasks WHERE id = ? AND user_id = ?", [taskId, req.user.id]);

  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  const { title, description, column_name, position, due_date } = req.body;

  // Заголовок можно сменить, но нельзя сделать пустым
  if (title !== undefined && title.trim() === "") {
    return res.status(400).json({ error: "Title cannot be empty" });
  }

  // Динамически собираем SET-часть SQL: обновляем только то, что передано
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

  // Возвращаем обновлённую задачу
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

// ---- Массовое переупорядочивание (drag & drop) ----
// Клиент присылает массив { id, column_name, position }.
// Обновляем все позиции одним запросом (быстрее, чем N отдельных PUT).
app.post("/api/tasks/reorder", auth, (req, res) => {
  const { tasks: taskUpdates } = req.body;
  if (!Array.isArray(taskUpdates)) {
    return res.status(400).json({ error: "tasks array required" });
  }

  // Обновляем каждую задачу; сохраняем на диск один раз в конце
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

// ---- Удалить задачу ----
app.delete("/api/tasks/:id", auth, (req, res) => {
  const taskId = parseInt(req.params.id);
  const task = dbGet("SELECT id FROM tasks WHERE id = ? AND user_id = ?", [taskId, req.user.id]);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  dbRun("DELETE FROM tasks WHERE id = ? AND user_id = ?", [taskId, req.user.id]);
  res.json({ ok: true });
});

// ---- SPA fallback ----
// Все не-API GET-запросы отдаём index.html — нужно для клиентского роутинга
// и чтобы PWA работал корректно при прямых переходах по URL.
app.get(/^\/(?!api\/)/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================
//  Инициализация БД и запуск сервера
// ============================================================
async function start() {
  // Загружаем sql.js (WebAssembly-сборка SQLite)
  const SQL = await initSqlJs();

  // Открываем или создаём файл БД
  if (fs.existsSync(DB_PATH)) {
    const fileBuf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuf);
    console.log("Database loaded from file");
  } else {
    db = new SQL.Database();
    console.log("New database created");
  }

  // ---- Создаём таблицы (если их ещё нет) ----
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

  // ---- Миграция: если колонки due_date нет, добавляем ----
  try {
    const cols = db.exec("PRAGMA table_info(tasks)");
    if (cols && cols.length > 0) {
      const colNames = cols[0].values.map((r) => r[1]);
      if (!colNames.includes("due_date")) {
        dbExec("ALTER TABLE tasks ADD COLUMN due_date TEXT NULL");
        console.log("Migration: added due_date column");
      }
    }
  } catch (e) {
    // Не страшно, если миграция не сработала (старая версия sql.js)
  }

  // ---- Сидирование: если position = 0, проставляем по id ----
  dbRun("UPDATE tasks SET position = id WHERE position = 0");

  // ---- Запуск ----
  app.listen(PORT, () => {
    console.log(`Kanban server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});