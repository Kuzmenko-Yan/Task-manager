// ============================================================
//  Аутентификация: access + refresh токены, автообновление
// ============================================================
const API = "/api";

// При старте достаём токены из localStorage (если залогинены ранее)
let accessToken = localStorage.getItem("kanban_access_token");
let refreshToken = localStorage.getItem("kanban_refresh_token");
let userEmail = localStorage.getItem("kanban_email");

// ---- Механизм очереди запросов на время обновления токена ----
// Если несколько запросов одновременно получают 401,
// только первый идёт на /api/auth/refresh, остальные ждут в очереди.
let isRefreshing = false;
let refreshSubscribers = [];

// Подписаться на получение нового токена (колбэк вызовется после обновления)
function subscribeTokenRefresh(cb) {
  refreshSubscribers.push(cb);
}

// Оповестить всех подписчиков о новом токене и очистить очередь
function onRefreshed(newAccessToken) {
  refreshSubscribers.forEach((cb) => cb(newAccessToken));
  refreshSubscribers = [];
}

/**
 * Обработать HTTP-ответ от сервера.
 * Возвращает распарсенный JSON или выбрасывает ошибку.
 */
function handleResponse(r) {
  if (r.status === 401) {
    logout();
    throw new Error("Unauthorized");
  }
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    // Ответ не JSON (например, HTML-ошибка) — читаем как текст
    return r.text().then((text) => {
      throw new Error(text.slice(0, 200) || "Unexpected response");
    });
  }
  return r.json().then((data) => {
    if (!r.ok) throw new Error(data.error || "Request failed");
    return data;
  });
}

/**
 * Основная функция для API-запросов.
 * Автоматически подставляет access-токен в заголовок.
 * При 401 пытается обновить токен через refresh и повторить запрос.
 */
function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (accessToken) headers["Authorization"] = "Bearer " + accessToken;

  return fetch(API + path, { ...options, headers }).then(async (r) => {
    // Если получили 401 — токен просрочен, пробуем обновить
    if (r.status === 401 && !path.startsWith("/auth/")) {
      if (!refreshToken) {
        // Нет refresh-токена — сразу разлогиниваем
        logout();
        throw new Error("Unauthorized");
      }

      // Если обновление уже идёт — ставим запрос в очередь
      if (isRefreshing) {
        return new Promise((resolve) => {
          subscribeTokenRefresh((newToken) => {
            const newHeaders = { "Content-Type": "application/json", ...options.headers };
            newHeaders["Authorization"] = "Bearer " + newToken;
            resolve(fetch(API + path, { ...options, headers: newHeaders }).then(handleResponse));
          });
        });
      }

      // Первый запрос, получивший 401 — начинает обновление
      isRefreshing = true;
      try {
        const refreshRes = await fetch(API + "/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        const refreshData = await refreshRes.json();
        if (!refreshRes.ok) throw new Error(refreshData.error || "Refresh failed");

        // Сохраняем новую пару токенов
        accessToken = refreshData.accessToken;
        refreshToken = refreshData.refreshToken;
        localStorage.setItem("kanban_access_token", accessToken);
        localStorage.setItem("kanban_refresh_token", refreshToken);
        // Оповещаем очередь
        onRefreshed(accessToken);

        // Повторяем исходный запрос с новым токеном
        const newHeaders = { "Content-Type": "application/json", ...options.headers };
        newHeaders["Authorization"] = "Bearer " + accessToken;
        return fetch(API + path, { ...options, headers: newHeaders }).then(handleResponse);
      } catch {
        // Не удалось обновить — разлогиниваем
        logout();
        throw new Error("Session expired. Please log in again.");
      } finally {
        isRefreshing = false;
      }
    }

    return handleResponse(r);
  });
}

/**
 * Выход из системы:
 * очищает токены, удаляет из localStorage, показывает форму логина.
 * Попутно отправляет /api/auth/logout, чтобы отозвать refresh-токен на сервере.
 */
async function logout() {
  const currentRefresh = refreshToken;
  accessToken = null;
  refreshToken = null;
  userEmail = null;
  localStorage.removeItem("kanban_access_token");
  localStorage.removeItem("kanban_refresh_token");
  localStorage.removeItem("kanban_email");
  showScreen("auth");

  if (currentRefresh) {
    try {
      await fetch(API + "/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + currentRefresh,
        },
        body: JSON.stringify({ refreshToken: currentRefresh }),
      });
    } catch {
      // Сеть недоступна — не страшно, токены локально уже удалены
    }
  }
}

// ============================================================
//  Telegram Mini App
//  Если страница открыта внутри Telegram (WebView),
//  window.Telegram.WebApp доступен и содержит initData —
//  подписанную строку с данными пользователя.
// ============================================================
const tg = window.Telegram && window.Telegram.WebApp;
const isTelegram = !!(tg && tg.initData);

/**
 * Сохранить сессию после любого входа (email или Telegram).
 */
function saveSession(data) {
  accessToken = data.accessToken;
  refreshToken = data.refreshToken;
  // Для Telegram-пользователей email может отсутствовать — показываем имя
  userEmail = data.user.name || data.user.email || "";
  localStorage.setItem("kanban_access_token", accessToken);
  localStorage.setItem("kanban_refresh_token", refreshToken);
  localStorage.setItem("kanban_email", userEmail);
}

/**
 * Вход через Telegram Mini App:
 * отправляем initData на сервер, тот проверяет HMAC-подпись
 * токеном бота и возвращает JWT-пару.
 */
async function telegramLogin() {
  const res = await fetch(API + "/auth/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: tg.initData }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Telegram auth failed");
  saveSession(data);
}

/**
 * Подстроить интерфейс под Telegram:
 * expand() раскрывает WebView на весь экран,
 * ready() сообщает Telegram, что приложение загружено.
 */
function initTelegramUi() {
  if (!isTelegram) return;
  tg.ready();
  tg.expand();
  // Подхватываем цветовую схему Telegram (светлая/тёмная)
  if (tg.colorScheme === "dark") {
    document.body.classList.add("tg-dark");
  }
}

// ---- Обёртки для логина/регистрации ----
function login(email, pwd) {
  return api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: pwd }),
  });
}

function register(email, pwd) {
  return api("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: pwd }),
  });
}

/**
 * Переключение между экранами: форма логина / доска.
 * Используется класс .hidden для скрытия.
 */
function showScreen(name) {
  document.getElementById("auth-screen").classList.toggle("hidden", name !== "auth");
  document.getElementById("board-screen").classList.toggle("hidden", name !== "board");
}

// ============================================================
//  Формы логина и регистрации (переключение, отправка, ошибки)
// ============================================================
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");

// Кнопка «Регистрация» — переключает с логина на форму регистрации
document.getElementById("show-register").addEventListener("click", (e) => {
  e.preventDefault();
  loginForm.classList.add("hidden");
  registerForm.classList.remove("hidden");
});

// Кнопка «Войти» — обратно на форму логина
document.getElementById("show-login").addEventListener("click", (e) => {
  e.preventDefault();
  registerForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
});

/**
 * Логин: отправляем email/пароль на /api/auth/login.
 * При успехе сохраняем токены в localStorage и показываем доску.
 * При ошибке — выводим текст под формой.
 */
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const pwd = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";

  try {
    const data = await login(email, pwd);
    saveSession(data);
    document.getElementById("user-email-display").textContent = userEmail;
    showScreen("board");
    initColumnTitleEditing();
    updateColumnTitles();
    loadTasks();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

/**
 * Регистрация: минимальная проверка (пароль ≥ 4 символов),
 * затем POST /api/auth/register. Логика как у логина.
 */
registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("register-email").value.trim();
  const pwd = document.getElementById("register-password").value;
  const errorEl = document.getElementById("register-error");
  errorEl.textContent = "";

  if (pwd.length < 4) {
    errorEl.textContent = "Пароль должен быть минимум 4 символа";
    return;
  }

  try {
    const data = await register(email, pwd);
    saveSession(data);
    document.getElementById("user-email-display").textContent = userEmail;
    showScreen("board");
    initColumnTitleEditing();
    updateColumnTitles();
    loadTasks();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// Кнопка «Выйти» в шапке доски
document.getElementById("logout-btn").addEventListener("click", logout);

// ============================================================
//  Kanban-доска: колонки, рендеринг, кастомизация заголовков
// ============================================================

// Порядок колонок на доске (ключи совпадают с column_name в БД)
const columnsOrder = ["backlog", "todo", "in_progress", "done"];
const columnNames = {
  backlog: "Бэклог",
  todo: "To Do",
  in_progress: "В процессе",
  done: "Готово",
};

// Иконки разделов (для чипов)
const COLUMN_ICONS = {
  backlog: "📥",
  todo: "📝",
  in_progress: "⚙️",
  done: "✅",
};

// Активный раздел (чип). Сохраняется между сессиями.
let currentColumn = localStorage.getItem("kanban_current_column") || "backlog";
if (!columnsOrder.includes(currentColumn)) currentColumn = "backlog";

// Все задачи текущего пользователя (загружаются с сервера)
let allTasks = [];

// Снимок состояния задач до drag&drop — нужен для отката при ошибке синхронизации
let previousTasks = [];

// ============================================================
//  Пользовательские названия колонок (хранятся в localStorage)
//  Пользователь может переименовать колонку, дважды кликнув по заголовку.
// ============================================================
const DEFAULT_COLUMN_NAMES = {
  backlog: "Бэклог",
  todo: "To Do",
  in_progress: "В процессе",
  done: "Готово",
};

// Загрузить кастомные названия из localStorage, дополнив дефолтами
function loadColumnNames() {
  try {
    const saved = JSON.parse(localStorage.getItem("kanban_column_names") || "{}");
    return { ...DEFAULT_COLUMN_NAMES, ...saved };
  } catch {
    return { ...DEFAULT_COLUMN_NAMES };
  }
}

// Сохранить названия в localStorage
function saveColumnNames(names) {
  localStorage.setItem("kanban_column_names", JSON.stringify(names));
}

// Получить текущие названия колонок
function getColumnNames() {
  return loadColumnNames();
}

/**
 * Обновить заголовки разделов: перестраивает чипы
 * и подставляет новые имена в <select> модального окна.
 * Вызывается после переименования или при первоначальной загрузке.
 */
function updateColumnTitles() {
  renderSections();

  // Опции в <select> модалки редактирования (перемещение между разделами)
  const names = getColumnNames();
  columnsOrder.forEach((col) => {
    document.querySelectorAll("#edit-task-column option[value='" + col + "']").forEach((opt) => {
      opt.textContent = names[col];
    });
  });
}

/**
 * Отрисовать чипы разделов (Бэклог / To Do / В процессе / Готово).
 * Чип = иконка + редактируемое название + счётчик задач.
 * Клик переключает активный раздел и перерисовывает список.
 */
function renderSections() {
  const box = document.getElementById("sections");
  if (!box) return;
  const names = getColumnNames();
  box.innerHTML = "";

  columnsOrder.forEach((col) => {
    const count = allTasks.filter((t) => t.column_name === col).length;
    const chip = document.createElement("div");
    chip.className = "section-chip" + (col === currentColumn ? " active" : "");
    chip.dataset.col = col;
    chip.innerHTML =
      `<span class="chip-icon">${COLUMN_ICONS[col]}</span>` +
      `<span class="col-title" contenteditable="true" data-col="${col}">${escapeHtml(names[col])}</span>` +
      `<span class="chip-count">${count}</span>`;

    // Клик по чипу — переключение раздела.
    // Если клик был по редактируемому названию — не переключаем,
    // чтобы не мешать переименованию.
    chip.addEventListener("click", (e) => {
      if (e.target.classList.contains("col-title")) return;
      if (col === currentColumn) return;
      currentColumn = col;
      localStorage.setItem("kanban_current_column", col);
      renderSections();
      renderBoard();
    });

    box.appendChild(chip);
  });

  // Перевешиваем обработчики переименования на свежие чипы
  initColumnTitleEditing();
}

/**
 * Включить редактирование заголовков колонок по двойному клику.
 * При потере фокуса (blur) сохраняем новое имя.
 * Enter завершает редактирование.
 */
function initColumnTitleEditing() {
  document.querySelectorAll(".col-title").forEach((span) => {
    span.addEventListener("blur", () => {
      const col = span.dataset.col;
      const newName = span.textContent.trim();
      if (!newName || newName === "") {
        // Пустое имя — сбрасываем на дефолтное
        span.textContent = DEFAULT_COLUMN_NAMES[col] || col;
        return;
      }
      const names = getColumnNames();
      names[col] = newName;
      saveColumnNames(names);
      updateColumnTitles();
    });

    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        span.blur();
      }
    });
  });
}

// ---- Загрузка задач с сервера и рендеринг доски ----

function loadTasks() {
  api("/tasks")
    .then((data) => {
      allTasks = data.tasks || [];
      renderBoard();
    })
    .catch((err) => {
      console.error("Load tasks error:", err);
    });
}

/**
 * Форматировать срок задачи для отображения в карточке.
 * Возвращает HTML с классом:
 *   due-none     — без срока
 *   due-overdue  — просрочено
 *   due-today    — сегодня
 *   due-future   — будущая дата
 */
function formatDue(due_date) {
  if (!due_date) return '<span class="due-none">Без срока</span>';
  const [y, m, d] = due_date.split("-");
  const dateStr = `${d}.${m}.${y}`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(y, m - 1, d);

  if (due < today) return '<span class="due-overdue">⏳ Просрочено ' + dateStr + "</span>";
  if (due.getTime() === today.getTime()) return '<span class="due-today">⏳ Сегодня</span>';
  return '<span class="due-future">⏳ ' + dateStr + "</span>";
}

// CSS-класс для карточки в зависимости от срока
function dueClass(due_date) {
  if (!due_date) return "due-none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = due_date.split("-");
  const due = new Date(y, m - 1, d);
  if (due < today) return "due-overdue";
  if (due.getTime() === today.getTime()) return "due-today";
  return "due-future";
}

/**
 * Распарсить description задачи в массив пунктов.
 * description хранится как JSON-массив строк.
 * Если это старый формат (просто текст) — оборачиваем в массив из одного элемента.
 */
function parseItems(desc) {
  if (!desc) return [];
  try {
    const arr = JSON.parse(desc);
    if (Array.isArray(arr)) return arr.filter(Boolean);
  } catch {}
  return desc.trim() ? [desc.trim()] : [];
}

/**
 * Собрать HTML-содержимое карточки задачи:
 * заголовок, список пунктов, срок.
 */
function buildCardHtml(task) {
  const items = parseItems(task.description);
  const itemsHtml = items.length > 0
    ? `<ul class="task-items">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  return `
    <div class="task-title">${escapeHtml(task.title)}</div>
    ${itemsHtml}
    <div class="task-meta">${formatDue(task.due_date)}</div>
  `;
}

/**
 * Отрисовать список задач активного раздела (чипа).
 * Показываем одну колонку во всю ширину — как в TaskFlow.
 * Сравниваем с текущим innerHTML — если не изменился, DOM не трогаем.
 * На каждую карточку вешаем обработчик клика — открытие модалки.
 * Попутно обновляем счётчики в чипах (renderSections).
 */
function renderBoard() {
  renderSections();

  const body = document.getElementById("tasks-list");
  const tasks = allTasks
    .filter((t) => t.column_name === currentColumn)
    .sort((a, b) => a.position - b.position);

  if (tasks.length === 0) {
    const emptyHtml = '<div class="empty-hint">В этом разделе пока нет задач</div>';
    if (body.innerHTML !== emptyHtml) body.innerHTML = emptyHtml;
    return;
  }

  const newHtml = tasks.map((task) => {
    return `<div class="task-card ${dueClass(task.due_date)}" data-id="${task.id}">${buildCardHtml(task)}</div>`;
  }).join("");

  if (body.innerHTML !== newHtml) {
    body.innerHTML = newHtml;
  }

  // Вешаем обработчики клика (открытие модалки) на каждую карточку
  body.querySelectorAll(".task-card").forEach((card) => {
    const taskId = parseInt(card.dataset.id);
    const task = allTasks.find((t) => t.id === taskId);
    if (task) {
      // cloneNode + replace убирает старый обработчик, чтобы не дублировались
      const newCard = card.cloneNode(true);
      newCard.addEventListener("click", () => openModal(task));
      card.replaceWith(newCard);
    }
  });
}

// Экранирование HTML-спецсимволов (защита от XSS)
function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
//  Создание новой задачи (форма «Добавить задачу»)
// ============================================================
document.getElementById("add-task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const titleInput = document.getElementById("new-task-title");
  const dueInput = document.getElementById("new-task-due");
  const title = titleInput.value.trim();

  if (!title) return;

  try {
    // POST /api/tasks — задача попадает в активный раздел (чип)
    const data = await api("/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        column_name: currentColumn,
        due_date: dueInput.value || null,
      }),
    });
    titleInput.value = "";
    // Оптимистично добавляем задачу в локальный стейт без перезагрузки с сервера
    if (data.task) {
      allTasks.push(data.task);
      renderBoard();
    } else {
      loadTasks();
    }
  } catch (err) {
    alert("Ошибка: " + err.message);
  }
});

// ============================================================
//  Drag & Drop (SortableJS)
//  Работает внутри активного раздела: меняет порядок карточек
//  в списке. Перенос между разделами — через модалку (селект).
//  Оптимистичный подход: сразу меняем стейт, затем
//  синхронизируем с сервером через POST /api/tasks/reorder.
// ============================================================
function initSortable() {
  const el = document.getElementById("tasks-list");
  new Sortable(el, {
    draggable: ".task-card",      // перетаскиваем только карточки (не заглушку «пусто»)
    animation: 150,               // плавная анимация перемещения
    easing: "cubic-bezier(0.2, 0, 0, 1)",
    ghostClass: "sortable-ghost", // класс для «призрака» перетаскиваемой карточки
    dragClass: "sortable-drag",   // класс для исходной карточки во время перетаскивания

    /**
     * onEnd — пользователь отпустил карточку.
     * SortableJS уже переместил элемент в DOM, нам нужно:
     *   1. Сохранить снимок allTasks (для отката при ошибке)
     *   2. Собрать новый порядок из DOM
     *   3. Обновить локальный стейт
     *   4. Отправить изменения на сервер
     */
    onEnd: function () {
      // Снимок до изменений — для отката при ошибке синхронизации
      previousTasks = allTasks.map((t) => ({ ...t }));

      // Новый порядок позиций внутри активного раздела (1-based)
      const updates = [];
      el.querySelectorAll(".task-card").forEach((card, i) => {
        updates.push({
          id: parseInt(card.dataset.id),
          column_name: currentColumn,
          position: i + 1,
        });
      });

      // Оптимистичное обновление локального стейта
      allTasks = allTasks.map((t) => {
        const upd = updates.find((u) => u.id === t.id);
        return upd ? { ...t, position: upd.position } : t;
      });

      // Синхронизация с сервером
      api("/tasks/reorder", {
        method: "POST",
        body: JSON.stringify({ tasks: updates }),
      }).catch((err) => {
        console.error("Reorder sync failed:", err);
        // При ошибке: откатываем стейт и перезагружаем доску с сервера
        allTasks = previousTasks.map((t) => ({ ...t }));
        loadTasks();
      });
    },
  });
}

// ============================================================
//  Модальное окно: просмотр, редактирование, удаление задачи
// ============================================================
const modal = document.getElementById("task-modal");
const modalClose = document.getElementById("modal-close");
const modalCancel = document.getElementById("modal-cancel");
const editForm = document.getElementById("edit-task-form");

/**
 * Открыть модалку и заполнить поля данными задачи.
 * description парсится из JSON-массива в отдельные инпуты.
 */
function openModal(task) {
  document.getElementById("edit-task-id").value = task.id;
  document.getElementById("edit-task-title").value = task.title;
  document.getElementById("edit-task-due").value = task.due_date || "";

  const items = parseItems(task.description);
  const inputs = document.querySelectorAll("#edit-task-items .task-item-input");
  inputs.forEach((inp, i) => { inp.value = items[i] || ""; });
  modal.classList.remove("hidden");
}

// Закрыть модалку
function closeModal() {
  modal.classList.add("hidden");
}

// Закрытие по кнопкам [×], «Отмена» и клику на фон (оверлей)
modalClose.addEventListener("click", closeModal);
modalCancel.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

/**
 * Сохранение изменений задачи (PUT /api/tasks/:id).
 * Собирает заголовок, пункты (массив → JSON), колонку, срок.
 * После успеха обновляет локальный стейт и перерисовывает доску.
 */
editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = parseInt(document.getElementById("edit-task-id").value);
  const title = document.getElementById("edit-task-title").value.trim();
  // Собрать непустые пункты из инпутов
  const rawItems = Array.from(
    document.querySelectorAll("#edit-task-items .task-item-input")
  ).map(inp => inp.value.trim()).filter(Boolean);
  // description хранится как JSON-массив строк
  const description = rawItems.length > 0 ? JSON.stringify(rawItems) : "";
  const column_name = document.getElementById("edit-task-column").value;
  const due_date = document.getElementById("edit-task-due").value || null;

  if (!title) {
    alert("Заголовок не может быть пустым");
    return;
  }

  try {
    const data = await api("/tasks/" + id, {
      method: "PUT",
      body: JSON.stringify({ title, description, column_name, due_date }),
    });
    // Обновить локальный стейт (если сервер вернул обновлённую задачу)
    if (data.task) {
      allTasks = allTasks.map((t) => (t.id === data.task.id ? data.task : t));
      renderBoard();
    } else {
      loadTasks();
    }
    closeModal();
  } catch (err) {
    alert("Ошибка: " + err.message);
  }
});

// Кнопка «Удалить» в модалке — DELETE /api/tasks/:id
document.getElementById("delete-task-btn").addEventListener("click", async () => {
  const id = parseInt(document.getElementById("edit-task-id").value);
  if (!confirm("Удалить задачу?")) return;

  try {
    await api("/tasks/" + id, { method: "DELETE" });
    allTasks = allTasks.filter((t) => t.id !== id);
    renderBoard();
    closeModal();
  } catch (err) {
    alert("Ошибка: " + err.message);
  }
});

// ============================================================
//  Инициализация приложения при загрузке страницы
// ============================================================
function enterBoard() {
  document.getElementById("user-email-display").textContent = userEmail;
  showScreen("board");
  initColumnTitleEditing();
  updateColumnTitles();
  loadTasks();
}

initTelegramUi();

if (isTelegram) {
  // Открыто внутри Telegram Mini App — входим через initData,
  // форму логина не показываем вовсе.
  telegramLogin()
    .then(enterBoard)
    .catch((err) => {
      console.error("Telegram login failed:", err);
      // Подпись не сошлась или сервер недоступен — показываем
      // экран авторизации с ошибкой как фолбэк
      showScreen("auth");
      document.getElementById("login-error").textContent =
        "Не удалось войти через Telegram. Попробуйте ещё раз.";
    });
} else if (accessToken && userEmail) {
  // Если токен есть в localStorage — проверяем его валидность через GET /api/me
  api("/me")
    .then(enterBoard)
    .catch(() => {
      // Токен просрочен или невалиден — выходим
      logout();
    });
} else {
  // Нет токена — показываем форму логина
  showScreen("auth");
}

// Инициализируем drag&drop (SortableJS) для всех колонок
initSortable();

// ============================================================
//  Регистрация Service Worker для PWA (офлайн-поддержка)
// ============================================================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
