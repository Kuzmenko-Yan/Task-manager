// ============================================================
//  Kanban Server — Express + Supabase (Postgres) + JWT
//  + авторизация через Telegram Mini App (initData)
// ============================================================
//
//  Переменные окружения (см. .env.example):
//    PORT                      — порт сервера (по умолчанию 3000)
//    JWT_SECRET                — секрет для подписи JWT (обязателен)
//    SUPABASE_URL              — URL проекта Supabase (обязателен)
//    SUPABASE_SERVICE_ROLE_KEY — service_role ключ Supabase (обязателен,
//                                ТОЛЬКО сервер, никогда не отдавать клиенту)
//    BOT_TOKEN                 — токен бота от @BotFather (нужен для входа
//                                через Telegram Mini App)
//    ACCESS_EXPIRES_IN         — срок access-токена (по умолчанию "15m")
//    REFRESH_EXPIRES_IN        — срок refresh-токена (по умолчанию "30d")
// ============================================================

require("dotenv").config(); // подхватывает .env при локальной разработке

const express = require("express");
const jwt = require("jsonwebtoken");        // access + refresh токены
const bcrypt = require("bcryptjs");         // хеширование паролей
const crypto = require("crypto");           // HMAC-проверка Telegram initData
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();

// ---- Конфигурация из переменных окружения ----
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ACCESS_EXPIRES_IN = process.env.ACCESS_EXPIRES_IN || "15m";    // access-токен: 15 минут
const REFRESH_EXPIRES_IN = process.env.REFRESH_EXPIRES_IN || "30d";  // refresh-токен: 30 дней

// Если критичные переменные не заданы — сервер не запустится
// (защита от случайного деплоя без секретов)
if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is not set");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  process.exit(1);
}
if (!BOT_TOKEN) {
  console.warn("WARNING: BOT_TOKEN is not set — Telegram Mini App auth disabled");
}

// Клиент Supabase с service_role ключом.
// Этот ключ обходит Row Level Security, поэтому ВСЯ фильтрация
// по user_id делается в коде сервера (см. запросы ниже).
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ============================================================
//  Хранилище refresh-токенов (в памяти)
//  Структура: Map<userId, Set<refreshToken>>
//  При горизонтальном масштабировании заменить на Redis
//  или отдельную таблицу в БД.
// ============================================================
const refreshTokens = new Map();

// ============================================================
//  Вспомогательные функции для работы с БД (Supabase)
//  Все функции async — supabase-js возвращает промисы.
// ============================================================

// Получить одну строку или null
async function dbGet(query) {
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

// Получить все строки запроса
async function dbAll(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ============================================================
//  Middleware
// ============================================================

// Парсинг JSON-тела запросов (initData от Telegram — длинная строка, лимит чуть выше дефолта)
app.use(express.json({ limit: "256kb" }));
// Раздача статических файлов из public/ (index.html, app.js, style.css и др.)
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
//  Работа с JWT-токенами
// ============================================================

/**
 * Создать access-токен (короткоживущий, 15 минут).
 * payload.type = "access" — чтобы отличать от refresh-токена.
 * payload.name — отображаемое имя (email или имя из Telegram).
 */
function generateAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: displayName(user), type: "access" },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES_IN }
  );
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

// Отображаемое имя пользователя: email, имя из Telegram или @username
function displayName(user) {
  return user.email || user.first_name || (user.username ? "@" + user.username : null) || "user";
}

// Публичное представление пользователя (без хеша пароля)
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: displayName(user),
    telegram_id: user.telegram_id || null,
  };
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
      refreshTokens.delete(userId);
    }
  }
}

// Удалить ВСЕ refresh-токены пользователя (при logout)
function clearUserRefreshTokens(userId) {
  refreshTokens.delete(userId);
}

// Выдать пару токенов и вернуть стандартный ответ клиенту
function issueTokens(user) {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  storeRefreshToken(user.id, refreshToken);
  return { accessToken, refreshToken, user: publicUser(user) };
}

// ============================================================
//  Middleware аутентификации
//  Проверяет заголовок Authorization: Bearer <accessToken>
// ============================================================
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token" });
  }
  try {
    const token = header.slice(7); // убираем "Bearer "
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== "access") {
      return res.status(401).json({ error: "Invalid token type" });
    }
    req.user = payload; // { id, email, name }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ============================================================
//  Проверка подписи Telegram Mini App initData
//  Алгоритм из официальной документации:
//    1. Убираем параметр hash из query-строки
//    2. Остальные пары key=value сортируем по ключу, склеиваем "\n"
//    3. secret = HMAC_SHA256("WebAppData", BOT_TOKEN)
//    4. check  = HMAC_SHA256(secret, data_check_string) в hex
//    5. Сравниваем check с hash (timing-safe)
//  Плюс проверяем свежесть auth_date (не старше 24 часов).
// ============================================================
function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Сравнение без утечки по времени
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Свежесть подписи: не старше 24 часов
  const authDate = parseInt(params.get("auth_date") || "0", 10);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

  try {
    return JSON.parse(params.get("user")); // { id, first_name, username, ... }
  } catch {
    return null;
  }
}

// ============================================================
//  Маршруты авторизации
// ============================================================

// ---- Вход через Telegram Mini App ----
// Клиент (внутри Telegram WebView) присылает { initData } —
// сырую строку Telegram.WebApp.initData. Сервер проверяет подпись,
// находит или создаёт пользователя по telegram_id и выдаёт JWT-пару.
app.post("/api/auth/telegram", async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) {
      return res.status(400).json({ error: "initData is required" });
    }

    const tgUser = verifyTelegramInitData(initData);
    if (!tgUser || !tgUser.id) {
      return res.status(401).json({ error: "Invalid Telegram initData" });
    }

    // Ищем пользователя по telegram_id
    let user = await dbGet(
      supabase.from("users").select("*").eq("telegram_id", tgUser.id)
    );

    if (!user) {
      // Первый вход из Telegram — создаём пользователя
      const { data, error } = await supabase
        .from("users")
        .insert({
          telegram_id: tgUser.id,
          first_name: tgUser.first_name || null,
          username: tgUser.username || null,
        })
        .select()
        .single();
      if (error) throw error;
      user = data;
    }

    res.json(issueTokens(user));
  } catch (err) {
    console.error("Telegram auth error:", err);
    res.status(500).json({ error: "Auth failed" });
  }
});

// ---- Регистрация (email + пароль, фолбэк вне Telegram) ----
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters" });
    }

    const existing = await dbGet(
      supabase.from("users").select("id").eq("email", email)
    );
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const hash = bcrypt.hashSync(password, 10);
    const { data: user, error } = await supabase
      .from("users")
      .insert({ email, password_hash: hash })
      .select()
      .single();
    if (error) throw error;

    res.json(issueTokens(user));
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ---- Вход (логин) ----
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await dbGet(supabase.from("users").select("*").eq("email", email));
    if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    res.json(issueTokens(user));
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ---- Обновление токенов (refresh) ----
// Клиент присылает refresh-токен, получает новую пару.
// Старый refresh-токен при этом отзывается (ротация).
app.post("/api/auth/refresh", async (req, res) => {
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
    const user = await dbGet(
      supabase.from("users").select("*").eq("id", payload.id)
    );
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
app.post("/api/auth/logout", (req, res) => {
  const { refreshToken } = req.body;

  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, JWT_SECRET);
      if (payload.type === "refresh") {
        clearUserRefreshTokens(payload.id);
      }
    } catch {
      // Просроченный/невалидный токен — просто игнорируем
    }
  }

  res.json({ ok: true });
});

// ---- Текущий пользователь (проверка токена) ----
app.get("/api/me", auth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name } });
});

// ============================================================
//  Маршруты для работы с задачами
//  Все требуют аутентификации (middleware auth).
// ============================================================

const VALID_COLUMNS = ["backlog", "todo", "in_progress", "done"];

// ---- Получить все задачи текущего пользователя ----
app.get("/api/tasks", auth, async (req, res) => {
  try {
    const tasks = await dbAll(
      supabase
        .from("tasks")
        .select("*")
        .eq("user_id", req.user.id)
        .order("position", { ascending: true })
    );
    res.json({ tasks });
  } catch (err) {
    console.error("Get tasks error:", err);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

// ---- Создать новую задачу ----
app.post("/api/tasks", auth, async (req, res) => {
  try {
    const { title, description, column_name, due_date } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    const col = column_name || "backlog";
    if (!VALID_COLUMNS.includes(col)) {
      return res.status(400).json({ error: "Invalid column: " + col });
    }

    // Вычисляем position: максимальная позиция в колонке + 1
    const last = await dbGet(
      supabase
        .from("tasks")
        .select("position")
        .eq("user_id", req.user.id)
        .eq("column_name", col)
        .order("position", { ascending: false })
        .limit(1)
    );
    const newPos = last && last.position != null ? last.position + 1 : 1;

    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        user_id: req.user.id,
        title: title.trim(),
        description: description || "",
        column_name: col,
        position: newPos,
        due_date: due_date || null,
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ task });
  } catch (err) {
    console.error("Create task error:", err);
    res.status(500).json({ error: "Failed to create task" });
  }
});

// ---- Обновить задачу ----
app.put("/api/tasks/:id", auth, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await dbGet(
      supabase.from("tasks").select("id").eq("id", taskId).eq("user_id", req.user.id)
    );
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    const { title, description, column_name, position, due_date } = req.body;

    if (title !== undefined && title.trim() === "") {
      return res.status(400).json({ error: "Title cannot be empty" });
    }

    // Обновляем только переданные поля
    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (description !== undefined) updates.description = description;
    if (column_name !== undefined) {
      if (!VALID_COLUMNS.includes(column_name)) {
        return res.status(400).json({ error: "Invalid column: " + column_name });
      }
      updates.column_name = column_name;
    }
    if (position !== undefined) updates.position = position;
    if (due_date !== undefined) updates.due_date = due_date;

    const { data: updated, error } = await supabase
      .from("tasks")
      .update(updates)
      .eq("id", taskId)
      .eq("user_id", req.user.id)
      .select()
      .single();
    if (error) throw error;

    res.json({ task: updated });
  } catch (err) {
    console.error("Update task error:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

// ---- Массовое переупорядочивание (drag & drop) ----
// Клиент присылает массив { id, column_name, position }.
app.post("/api/tasks/reorder", auth, async (req, res) => {
  try {
    const { tasks: taskUpdates } = req.body;
    if (!Array.isArray(taskUpdates)) {
      return res.status(400).json({ error: "tasks array required" });
    }

    // Обновляем каждую задачу параллельно;
    // фильтр по user_id гарантирует, что чужие задачи не затронутся
    await Promise.all(
      taskUpdates.map((t) =>
        supabase
          .from("tasks")
          .update({ column_name: t.column_name, position: t.position })
          .eq("id", t.id)
          .eq("user_id", req.user.id)
          .then(({ error }) => {
            if (error) throw error;
          })
      )
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Reorder error:", err);
    res.status(500).json({ error: "Failed to reorder tasks" });
  }
});

// ---- Удалить задачу ----
app.delete("/api/tasks/:id", auth, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { data, error } = await supabase
      .from("tasks")
      .delete()
      .eq("id", taskId)
      .eq("user_id", req.user.id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: "Task not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Delete task error:", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// ---- SPA fallback ----
// Все не-API GET-запросы отдаём index.html
app.get(/^\/(?!api\/)/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================
//  Запуск сервера
//  Таблицы создаются в Supabase (см. supabase/schema.sql),
//  миграции при старте больше не нужны.
// ============================================================
app.listen(PORT, () => {
  console.log(`Kanban server running on http://localhost:${PORT}`);
});
