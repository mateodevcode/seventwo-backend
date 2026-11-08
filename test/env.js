// test/env.js — se carga con --import antes que cualquier módulo de src/.
// Valores fijos solo para pruebas; la BD debe terminar en _test.
process.env.NODE_ENV = "test";
process.env.TZ = "UTC";
process.env.DATABASE_URL ??= "postgres://seventwo:seventwo_dev@localhost:5442/seventwo_test";
process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL = process.env.TEST_DATABASE_URL);
process.env.JWT_SECRET = "test-access-secret-0123456789abcdef0123456789abcdef";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-0123456789abcdef0123456789abcdef";
process.env.AUTH_PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
process.env.FRONTEND_URL = "http://localhost:3000";
delete process.env.BREVO_SMTP_EMAIL;
delete process.env.BREVO_SMTP_PASS;
