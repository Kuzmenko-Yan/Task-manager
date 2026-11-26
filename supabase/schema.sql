-- ============================================================
--  Схема БД для Kanban (Supabase / Postgres)
--  Выполнить один раз: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- Пользователи.
-- Два способа входа:
--   1. email + пароль        → email, password_hash
--   2. Telegram Mini App     → telegram_id, first_name, username
-- Оба набора полей nullable: telegram-пользователю не нужен email,
-- email-пользователю не нужен telegram_id.
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT UNIQUE,
  password_hash TEXT,
  telegram_id   BIGINT UNIQUE,
  first_name    TEXT,
  username      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Задачи канбан-доски.
-- column_name: 'backlog' | 'todo' | 'in_progress' | 'done'
-- position — порядок карточки внутри колонки (drag & drop).
-- description — JSON-массив строк (пункты) или пустая строка.
CREATE TABLE IF NOT EXISTS tasks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  column_name TEXT NOT NULL DEFAULT 'backlog'
              CHECK (column_name IN ('backlog', 'todo', 'in_progress', 'done')),
  position    INTEGER NOT NULL DEFAULT 0,
  due_date    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Индексы под основные запросы сервера
CREATE INDEX IF NOT EXISTS idx_tasks_user_column ON tasks (user_id, column_name, position);
CREATE INDEX IF NOT EXISTS idx_users_telegram ON users (telegram_id);

-- ------------------------------------------------------------
--  Row Level Security
--  Сервер ходит в БД с service_role ключом, который ОБХОДИТ RLS,
--  и сам фильтрует строки по user_id. Клиенту никакие ключи
--  не выдаются, поэтому RLS включаем и НЕ создаём политик —
--  прямой доступ извне к таблицам закрыт полностью.
-- ------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
