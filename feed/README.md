# manga-feed

Precached discovery feed for the Tachidesk source. Every 6 hours it rebuilds
`feed.json` from Suwayomi (the same Weeb Central rows the extension used to
fetch live) and mirrors covers, then has Suwayomi pre-fetch details and
chapter lists for every listed series. The phone loads the home page with one
LAN request, and opening a series doesn't wait on a live scrape.

Every other installed source (in `SOURCE_LANG`, minus `SKIP_SOURCES` and
copycats) is merged into those same categories: its Popular listing into
Trending / Most Popular / the genre rows (by its genre tags) / Popular
Webtoons (webtoon sources or manhwa/manhua tags), its Latest listing into
Newly Added / New Webtoons. Rows interleave sources rank by rank and hold one
copy per title, from the highest-priority source.

`dedupe.py` checks the library every 5 minutes for the same series from two
sources (normalized title, or AniList id when the edition markers match) and
keeps the best copy: official sources first if they have at least 90% of the
chapters, then the `SOURCE_PRIORITY` order. Losers hand over read progress and
lose their downloads. Report: `http://10.0.0.145:4580/duplicates.html`.
`DEDUPE_DRY_RUN=true` reports without removing anything.

`backfill.py` is the Suwayomi back-catalog downloader (deployed separately at
`/volume1/docker/suwayomi/backfill/`); it waits 15 minutes after a series is
added so a duplicate is removed before it downloads.

## Deploy (rootnas)

```bash
scp -O feed.py Dockerfile compose.yaml rogersquare@10.0.0.145:/volume1/docker/manga-feed/
ssh rogersquare@10.0.0.145
cd /volume1/docker/manga-feed
mkdir -p data
/usr/local/bin/docker compose up -d --build
```

Feed: `http://10.0.0.145:4580/feed.json`. Logs: `docker logs manga-feed`.
