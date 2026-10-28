# manga-feed

Precached discovery feed for the Tachidesk source. Every 6 hours it rebuilds
`feed.json` from Suwayomi (the same Weeb Central rows the extension used to
fetch live), mirrors covers, and renders hero images at Paperback's featured
card size (1200x824). The phone then loads the home page with one LAN request.

Hero art is a TMDB backdrop when the series has an anime adaptation, otherwise
the manga cover over a blurred copy of itself.

## Deploy (rootnas)

```bash
scp -O feed.py Dockerfile compose.yaml rogersquare@10.0.0.145:/volume1/docker/manga-feed/
ssh rogersquare@10.0.0.145
cd /volume1/docker/manga-feed
[ -f .env ] || : > .env      # TMDB_TOKEN=... goes here; never commit it
mkdir -p data
/usr/local/bin/docker compose up -d --build
```

Feed: `http://10.0.0.145:4580/feed.json`. Logs: `docker logs manga-feed`.
