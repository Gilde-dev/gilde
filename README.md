# Gilde

Control plane of an AI factory. See `AGENTS.md` for the repository layout and commands.

## Postgres and Cloudflare tunnel

By default the API uses SQLite (`db.sqlite`). To use Postgres and receive GitHub webhooks locally:

1. Start Postgres: `docker compose up -d`
2. Set `DATABASE_URL=postgres://gilde:gilde@localhost:5432/gilde` (see `apps/api/.env.example`) and run `pnpm dev`.
3. In Cloudflare Zero Trust, create a tunnel and copy its token.
4. Give the tunnel a public hostname with service `http://host.docker.internal:4100` and path `api/webhooks/github`.
5. Put the token in `.env` as `TUNNEL_TOKEN` (see `.env.example`) and start the tunnel: `docker compose --profile tunnel up -d`
