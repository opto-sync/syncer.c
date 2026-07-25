# Integration tests need a live Postgres and are excluded by default, so
# `mix test` is hermetic. To run them:
#
#   docker run -d --name opto-sync-pg -e POSTGRES_PASSWORD=postgres \
#     -p 55432:5432 postgres:16-alpine
#   PG_URL=postgres://postgres:postgres@host.docker.internal:55432/postgres \
#     mix test --include integration
ExUnit.start(exclude: [:integration])
