# manga-feed

Precached discovery feed for the Tachidesk source. Every 6 hours it rebuilds
`feed.json` from Suwayomi (the same Weeb Central rows the extension used to
fetch live) and mirrors covers, then has Suwayomi pre-fetch details and
chapter lists for every listed series. The phone loads the home page with one
LAN request, and opening a series doesn't wait on a live scrape.

## Deploy (rootnas)

```bash
scp -O feed.py Dockerfile compose.yaml rogersquare@10.0.0.145:/volume1/docker/manga-feed/
ssh rogersquare@10.0.0.145
cd /volume1/docker/manga-feed
mkdir -p data
/usr/local/bin/docker compose up -d --build
```

Feed: `http://10.0.0.145:4580/feed.json`. Logs: `docker logs manga-feed`.
