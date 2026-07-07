# API Serves the Web SPA as a Combined Web/API Service

Accepted: 2026-07-07

The API service serves the built web SPA (`apps/web/dist`) as static assets with a client-side-routing fallback to `index.html`, so production runs two application services (combined Web/API + Runner) plus Postgres rather than three. This keeps the frontend same-origin with the API, eliminating CORS and letting the web bundle call the API with a relative base URL (`VITE_API_BASE_URL` empty). The static fallback must not shadow the API's own routes (`/api/*`, `/internal/*`, `/mcp/*`, `/health`).

## Considered Options

- **API serves static (chosen)**: no CORS, no public API URL baked into the web build, matches the existing `Dockerfile.web` which already compiles both api and web and runs the API.
- **Separate static web service**: cleaner independent scaling / CDN path, but adds a third service, requires CORS configuration, and forces the public API URL to be baked into the web bundle at build time. Not justified for a single-tenant demo.
