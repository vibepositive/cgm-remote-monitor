# Nightscout Monitor Bridge

A small read-only service that pulls the Nightscout API and returns a compact 24-hour dataset for trend review.

## Required environment variables

- `NIGHTSCOUT_URL` — base Nightscout URL, for example `https://example.code.run`
- `NIGHTSCOUT_TOKEN` — Nightscout subject token with the `readable` role only
- `BRIDGE_KEY` — a separate long random key used to protect this bridge
- `PORT` — optional; defaults to `3000`

Do not use the Nightscout API secret. Keep all three values server-side in the hosting platform's secret/environment-variable settings.

## Endpoints

- `GET /health` — unauthenticated service health check
- `GET /current?key=<BRIDGE_KEY>` — compact current snapshot based on the last 6 hours
- `GET /summary?hours=24&key=<BRIDGE_KEY>` — compact summary for the requested window
- `GET /history?hours=24&key=<BRIDGE_KEY>` — normalized glucose, treatment, Trio/OpenAPS decision, prediction and profile data
- `GET /events?hours=24&key=<BRIDGE_KEY>` — alias of `/history`

`Authorization: Bearer <BRIDGE_KEY>` can be used instead of the query parameter.

The `hours` parameter accepts 1–168 hours.

## Northflank deployment

Create a second service from this same GitHub repository and point it at this branch while testing.

Use `monitor-bridge` as the build/work directory if Northflank supports a subdirectory/work-directory setting. The start command is:

```sh
npm start
```

If Northflank builds from the repository root, use:

```sh
cd monitor-bridge && npm start
```

Configure the required environment variables as secrets. Expose the service port provided through `PORT` (the application defaults to 3000 when the host does not inject one).

After deployment, test:

```text
https://<bridge-host>/health
https://<bridge-host>/summary?hours=24&key=<BRIDGE_KEY>
https://<bridge-host>/history?hours=24&key=<BRIDGE_KEY>
```

The intended ChatGPT workflow uses the exact authenticated `/history?hours=24&key=...` URL for the daily review and `/summary` for quick checks.

## Privacy

This service never writes to Nightscout. It only performs authenticated GET requests using the read-only subject token. The bridge key should be treated as a private read-only credential because the returned data contains personal glucose and insulin information.
