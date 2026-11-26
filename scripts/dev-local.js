// ============================================================
//  Локальный dev-запуск: node scripts/dev-local.js
//
//  Режимы:
//    1. Есть .env с реальными SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY —
//       запускается только server.js (работа против настоящего Supabase).
//    2. .env нет — поднимается мок Supabase (dev/mock-supabase.js)
//       на :3999 и server.js с тестовыми переменными.
//       Все данные живут в памяти и пропадают при остановке.
//
//  Порт приложения: 3000 (или PORT из окружения).
// ============================================================

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(root, ".env") });

const hasRealSupabase =
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes("localhost");

const env = { ...process.env };

if (!hasRealSupabase) {
  // Мок-режим: поднимаем локальный PostgREST-мок
  const mock = spawn(process.execPath, [path.join(root, "dev", "mock-supabase.js")], {
    stdio: "inherit",
  });
  mock.on("exit", (code) => {
    console.log("Mock Supabase exited:", code);
    process.exit(code || 0);
  });

  env.SUPABASE_URL = "http://localhost:3999";
  env.SUPABASE_SERVICE_ROLE_KEY = "local-dev-key";
  env.JWT_SECRET = env.JWT_SECRET || "local-dev-secret";
  env.BOT_TOKEN = env.BOT_TOKEN || "123456:LOCAL-DEV-TOKEN";
  console.log("LOCAL MODE: Supabase не настроен — используется встроенный мок (:3999)");
  console.log("Для работы с настоящей БД заполните .env (см. .env.example)");
}

const server = spawn(process.execPath, [path.join(root, "server.js")], {
  stdio: "inherit",
  env,
});
server.on("exit", (code) => process.exit(code || 0));

// Аккуратно гасим дочерние процессы по Ctrl+C
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
