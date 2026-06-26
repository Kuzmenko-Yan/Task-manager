// ===== Auth =====
const API = "/api";
let accessToken = localStorage.getItem("kanban_access_token");
let refreshToken = localStorage.getItem("kanban_refresh_token");
let userEmail = localStorage.getItem("kanban_email");
let isRefreshing = false;
let refreshSubscribers = [];

function subscribeTokenRefresh(cb) {
  refreshSubscribers.push(cb);
}

function onRefreshed(newAccessToken) {
  refreshSubscribers.forEach((cb) => cb(newAccessToken));
  refreshSubscribers = [];
}

function handleResponse(r) {
  if (r.status === 401) {
    logout();
    throw new Error("Unauthorized");
  }
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return r.text().then((text) => {
      throw new Error(text.slice(0, 200) || "Unexpected response");
    });
  }
  return r.json().then((data) => {
    if (!r.ok) throw new Error(data.error || "Request failed");
    return data;
  });
}

function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (accessToken) headers["Authorization"] = "Bearer " + accessToken;

  return fetch(API + path, { ...options, headers }).then(async (r) => {
    if (r.status === 401 && !path.startsWith("/auth/")) {
      if (!refreshToken) {
        logout();
        throw new Error("Unauthorized");
      }

      if (isRefreshing) {
        return new Promise((resolve) => {
          subscribeTokenRefresh((newToken) => {
            const newHeaders = { "Content-Type": "application/json", ...options.headers };
            newHeaders["Authorization"] = "Bearer " + newToken;
            resolve(fetch(API + path, { ...options, headers: newHeaders }).then(handleResponse));
          });
        });
      }

      isRefreshing = true;
      try {
        const refreshRes = await fetch(API + "/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        const refreshData = await refreshRes.json();
        if (!refreshRes.ok) throw new Error(refreshData.error || "Refresh failed");

        accessToken = refreshData.accessToken;
        refreshToken = refreshData.refreshToken;
        localStorage.setItem("kanban_access_token", accessToken);
        localStorage.setItem("kanban_refresh_token", refreshToken);
        onRefreshed(accessToken);

        const newHeaders = { "Content-Type": "application/json", ...options.headers };
        newHeaders["Authorization"] = "Bearer " + accessToken;
        return fetch(API + path, { ...options, headers: newHeaders }).then(handleResponse);
      } catch {
        logout();
        throw new Error("Session expired. Please log in again.");
      } finally {
        isRefreshing = false;
      }
    }

    return handleResponse(r);
  });
}

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
      // ignore network errors on logout
    }
  }
}

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

function showScreen(name) {
  document.getElementById("auth-screen").classList.toggle("hidden", name !== "auth");
  document.getElementById("board-screen").classList.toggle("hidden", name !== "board");
}

// ===== Auth Forms =====
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");

document.getElementById("show-register").addEventListener("click", (e) => {
  e.preventDefault();
  loginForm.classList.add("hidden");
  registerForm.classList.remove("hidden");
});

document.getElementById("show-login").addEventListener("click", (e) => {
  e.preventDefault();
  registerForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const pwd = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";

  try {
    const data = await login(email, pwd);
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    userEmail = data.user.email;
    localStorage.setItem("kanban_access_token", accessToken);
    localStorage.setItem("kanban_refresh_token", refreshToken);
    localStorage.setItem("kanban_email", userEmail);
    document.getElementById("user-email-display").textContent = userEmail;
    showScreen("board");
    initColumnTitleEditing();
    updateColumnTitles();
    loadTasks();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

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
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    userEmail = data.user.email;
    localStorage.setItem("kanban_access_token", accessToken);
    localStorage.setItem("kanban_refresh_token", refreshToken);
    localStorage.setItem("kanban_email", userEmail);
    document.getElementById("user-email-display").textContent = userEmail;
    showScreen("board");
    initColumnTitleEditing();
    updateColumnTitles();
    loadTasks();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("logout-btn").addEventListener("click", logout);

// ===== Kanban Board =====
const columnsOrder = ["backlog", "todo", "in_progress", "done"];
const columnNames = {
  backlog: "Бэклог",
  todo: "To Do",
  in_progress: "В процессе",
  done: "Готово",
};
let allTasks = [];
let previousTasks = []; // snapshot for rollback on D&D error

// ===== Custom column names (stored in localStorage) =====
const DEFAULT_COLUMN_NAMES = {
  backlog: "Бэклог",
  todo: "To Do",
  in_progress: "В процессе",
  done: "Готово",
};

function loadColumnNames() {
  try {
    const saved = JSON.parse(localStorage.getItem("kanban_column_names") || "{}");
    return { ...DEFAULT_COLUMN_NAMES, ...saved };
  } catch {
    return { ...DEFAULT_COLUMN_NAMES };
  }
}

function saveColumnNames(names) {
  localStorage.setItem("kanban_column_names", JSON.stringify(names));
}

function getColumnNames() {
  return loadColumnNames();
}

function updateColumnTitles() {
  const names = getColumnNames();
  columnsOrder.forEach((col) => {
    // Update header span
    const span = document.querySelector(`.col-title[data-col="${col}"]`);
    if (span && span.textContent.trim() !== names[col]) {
      span.textContent = names[col];
    }

    // Update selects: new-task-column, edit-task-column
    document.querySelectorAll("select option[value='" + col + "']").forEach((opt) => {
      opt.textContent = names[col];
    });
  });
}

function initColumnTitleEditing() {
  document.querySelectorAll(".col-title").forEach((span) => {
    span.addEventListener("blur", () => {
      const col = span.dataset.col;
      const newName = span.textContent.trim();
      if (!newName || newName === "") {
        // Reset to default if empty
        span.textContent = DEFAULT_COLUMN_NAMES[col] || col;
        return;
      }
      const names = getColumnNames();
      names[col] = newName;
      saveColumnNames(names);
      updateColumnTitles();
    });

    // Prevent newlines when pressing Enter
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        span.blur();
      }
    });
  });
}

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

function parseItems(desc) {
  if (!desc) return [];
  try {
    const arr = JSON.parse(desc);
    if (Array.isArray(arr)) return arr.filter(Boolean);
  } catch {}
  // Fallback: treat old plain text as a single item
  return desc.trim() ? [desc.trim()] : [];
}

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

function renderBoard() {
  columnsOrder.forEach((col) => {
    const body = document.getElementById("col-" + col);
    const tasks = allTasks.filter((t) => t.column_name === col);
    document.getElementById("count-" + col).textContent = tasks.length;

    // Build new HTML
    const newHtml = tasks.map((task) => {
      return `<div class="task-card ${dueClass(task.due_date)}" data-id="${task.id}">${buildCardHtml(task)}</div>`;
    }).join("");

    // Only replace if content actually changed (avoids unnecessary DOM thrashing)
    if (body.innerHTML !== newHtml) {
      body.innerHTML = newHtml;
    }

    // Re-bind click handlers to cards in this column
    body.querySelectorAll(".task-card").forEach((card) => {
      const taskId = parseInt(card.dataset.id);
      const task = allTasks.find((t) => t.id === taskId);
      if (task) {
        // Remove previous listener clone by replacing with a new one
        const newCard = card.cloneNode(true);
        newCard.addEventListener("click", () => openModal(task));
        card.replaceWith(newCard);
      }
    });
  });
}

function updateColumnCounts() {
  columnsOrder.forEach((col) => {
    const tasks = allTasks.filter((t) => t.column_name === col);
    document.getElementById("count-" + col).textContent = tasks.length;
  });
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ===== Add Task =====
document.getElementById("add-task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const titleInput = document.getElementById("new-task-title");
  const columnSelect = document.getElementById("new-task-column");
    const dueInput = document.getElementById("new-task-due");
    const title = titleInput.value.trim();

  if (!title) return;

  try {
    const data = await api("/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        column_name: columnSelect.value,
        due_date: dueInput.value || null,
      }),
    });
    titleInput.value = "";
    // Add new task to local state and render (avoids full reload)
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

// ===== Drag & Drop =====
function initSortable() {
  columnsOrder.forEach((col) => {
    const el = document.getElementById("col-" + col);
    new Sortable(el, {
      group: "kanban",
      animation: 150,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      ghostClass: "sortable-ghost",
      dragClass: "sortable-drag",
      onEnd: function (evt) {
        // Save snapshot before mutations for rollback
        previousTasks = allTasks.map((t) => ({ ...t }));

        // Determine target column from the target list
        const targetCol = evt.to.closest(".column-body").id.replace("col-", "");

        // Build updates from actual DOM state (SortableJS already moved elements)
        const updates = [];
        columnsOrder.forEach((c) => {
          const cards = document.querySelectorAll("#col-" + c + " .task-card");
          cards.forEach((card, i) => {
            const cardId = parseInt(card.dataset.id);
            // Ensure target column is applied for the dragged element
            const effectiveColumn = (c === targetCol && card.dataset.id === String(evt.item.dataset.id))
              ? targetCol
              : c;
            updates.push({
              id: cardId,
              column_name: effectiveColumn,
              position: i,
            });
          });
        });

        // Optimistic update: write new column/position into allTasks
        allTasks = allTasks.map((t) => {
          const upd = updates.find((u) => u.id === t.id);
          if (upd) {
            return { ...t, column_name: upd.column_name, position: upd.position };
          }
          return t;
        });

        // Re-sort allTasks to match new positions within each column
        const sorted = [];
        columnsOrder.forEach((c) => {
          const colTasks = allTasks
            .filter((t) => t.column_name === c)
            .sort((a, b) => a.position - b.position);
          sorted.push(...colTasks);
        });
        allTasks = sorted;

        // Update counts only — don't rebuild DOM (Sortable already did)
        updateColumnCounts();

        // Sync with server
        api("/tasks/reorder", {
          method: "POST",
          body: JSON.stringify({ tasks: updates }),
        }).catch((err) => {
          console.error("Reorder sync failed:", err);
          // Rollback to previous state
          allTasks = previousTasks.map((t) => ({ ...t }));
          // Reload from server to get authoritative state
          loadTasks();
        });
      },
    });
  });
}

// ===== Modal =====
const modal = document.getElementById("task-modal");
const modalClose = document.getElementById("modal-close");
const modalCancel = document.getElementById("modal-cancel");
const editForm = document.getElementById("edit-task-form");

function openModal(task) {
  document.getElementById("edit-task-id").value = task.id;
  document.getElementById("edit-task-title").value = task.title;
  document.getElementById("edit-task-due").value = task.due_date || "";

  const items = parseItems(task.description);
  const inputs = document.querySelectorAll("#edit-task-items .task-item-input");
  inputs.forEach((inp, i) => { inp.value = items[i] || ""; });
  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
}

modalClose.addEventListener("click", closeModal);
modalCancel.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = parseInt(document.getElementById("edit-task-id").value);
  const title = document.getElementById("edit-task-title").value.trim();
  const rawItems = Array.from(document.querySelectorAll("#edit-task-items .task-item-input")).map(inp => inp.value.trim()).filter(Boolean);
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
    // Update local state
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

// ===== Init =====
if (accessToken && userEmail) {
  // Verify token is still valid before showing board
  api("/me")
    .then(() => {
      document.getElementById("user-email-display").textContent = userEmail;
      showScreen("board");
      initColumnTitleEditing();
      updateColumnTitles();
      loadTasks();
    })
    .catch(() => {
      // Token expired or invalid
      logout();
    });
} else {
  showScreen("auth");
}

initSortable();

// ===== PWA Service Worker =====
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}