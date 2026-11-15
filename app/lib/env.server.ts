// React Router dev doesn't load .env into process.env, so do it here. Import
// this module for its side effect wherever server code reads process.env.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: callers handle missing variables themselves
}
