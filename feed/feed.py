"""Precached discovery feed for the roger-extensions Tachidesk source.

Every REFRESH_HOURS this rebuilds feed.json from Suwayomi: the same
Crunchyroll-style rows the extension used to fetch live (Weeb Central
filters, adult content off), with covers mirrored to disk. A small HTTP
server serves feed.json and img/ so the phone makes one fast LAN request
instead of ~20 live scrapes queued behind the downloader. Trending Now items
also carry an AniList score/genre subtitle.
"""
import base64
import io
import json
import os
import threading
import time
import traceback
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

SUWAYOMI_URL = os.environ.get("SUWAYOMI_URL", "http://10.0.0.145:4567").rstrip("/")
AUTH = base64.b64encode(f"{os.environ['AUTH_USERNAME']}:{os.environ['AUTH_PASSWORD']}".encode()).decode()
DATA_DIR = os.environ.get("DATA_DIR", "/data")
PORT = int(os.environ.get("PORT", "4580"))
REFRESH_HOURS = float(os.environ.get("REFRESH_HOURS", "6"))
WARM_MAX_AGE_HOURS = float(os.environ.get("WARM_MAX_AGE_HOURS", "20"))
SOURCE_NAME = os.environ.get("DISCOVER_SOURCE", "Weeb Central")
USER_AGENT = "manga-feed/1.0 (+https://github.com/RogerSquare/roger-extensions)"

HERO_ITEMS = 20
ROW_PAGES = 2  # ~64 items, so rows stay full after the extension hides library series
COVER_MAX_H = 900

GENRES = ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Mystery", "Romance",
          "Sci-fi", "Slice of Life", "Supernatural", "Horror", "Psychological",
          "Sports", "Historical"]

ROWS = [
    # Same large portrait tiles as Most Popular; the user preferred them to banner art
    {"key": "hero", "title": "Trending Now", "style": "singleRowLarge", "sort": "Popularity", "ongoing": True,
     "subtitles": True},
    {"key": "new", "title": "Newly Added", "style": "singleRowNormal", "sort": "Recently Added"},
    {"key": "popular", "title": "Most Popular", "style": "singleRowLarge", "sort": "Popularity"},
    {"key": "anime", "title": "Now an Anime", "style": "singleRowNormal", "sort": "Popularity", "anime": True},
    # Webtoons: Korean manhwa and Chinese manhua (vertical-scroll, usually full color)
    {"key": "webtoonPopular", "title": "Popular Webtoons", "style": "singleRowNormal", "sort": "Popularity",
     "types": ["Manhwa", "Manhua"]},
    {"key": "webtoonNew", "title": "New Webtoons", "style": "singleRowNormal", "sort": "Recently Added",
     "types": ["Manhwa", "Manhua"]},
] + [{"key": "genre" + "".join(c for c in g if c.isalpha()), "title": g, "style": "singleRowNormal",
      "sort": "Popularity", "tag": g} for g in GENRES]


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def http_json(url, body=None, headers=None, timeout=90):
    req = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None,
                                 {"Content-Type": "application/json", "Accept": "application/json",
                                  "User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def http_bytes(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def gql(query, variables=None):
    body = http_json(SUWAYOMI_URL + "/api/graphql", {"query": query, "variables": variables or {}},
                     {"Authorization": "Basic " + AUTH})
    if body.get("errors"):
        raise RuntimeError(body["errors"])
    return body["data"]


# ---------------------------------------------------------------- rows

def find_source():
    nodes = gql("{ sources { nodes { id displayName } } }")["sources"]["nodes"]
    return next(n["id"] for n in nodes if n["displayName"].startswith(SOURCE_NAME))


def source_filters(source_id):
    data = gql("""query($id: LongString!) { source(id: $id) { filters { __typename
        ... on SelectFilter { name values }
        ... on GroupFilter { name filters { ... on CheckBoxFilter { name } ... on TriStateFilter { name } } } } } }""",
               {"id": source_id})
    return [{"type": f["__typename"], "name": f.get("name", ""), "values": f.get("values") or [],
             "children": [c.get("name", "") for c in f.get("filters") or []]}
            for f in data["source"]["filters"]]


def filter_changes(filters, row):
    # Matched by name, like the extension: a missing filter is skipped, never misapplied
    def select(name, value):
        for i, f in enumerate(filters):
            if f["type"] == "SelectFilter" and f["name"] == name and value in f["values"]:
                return [{"position": i, "selectState": f["values"].index(value)}]
        return []

    def group(name, child, change):
        for i, f in enumerate(filters):
            if f["type"] == "GroupFilter" and f["name"] == name and child in f["children"]:
                return [{"position": i, "groupChange": {"position": f["children"].index(child), **change}}]
        return []

    return (select("Sort", row["sort"]) + select("Adult Content", "False")
            + (select("Anime Adaptation", "True") if row.get("anime") else [])
            + (group("Series Status", "Ongoing", {"checkBoxState": True}) if row.get("ongoing") else [])
            + (group("Tags", row["tag"], {"triState": "INCLUDE"}) if row.get("tag") else [])
            + [change for kind in row.get("types", []) for change in group("Series Type", kind, {"checkBoxState": True})])


def fetch_row(source_id, filters, row):
    mangas, seen = [], set()
    for page in range(1, ROW_PAGES + 1):
        data = gql("""mutation($s: LongString!, $p: Int!, $f: [FilterChangeInput!]) {
            fetchSourceManga(input: { source: $s, type: SEARCH, page: $p, query: "", filters: $f }) {
                hasNextPage mangas { id title thumbnailUrl } } }""",
                   {"s": source_id, "p": page, "f": filter_changes(filters, row)})["fetchSourceManga"]
        for m in data["mangas"]:
            if m["id"] not in seen:
                seen.add(m["id"])
                mangas.append(m)
        if not data["hasNextPage"]:
            break
    return mangas


# ---------------------------------------------------------------- metadata

def anilist_lookup(titles):
    """One batched query; Page() returns [] on a miss where Media() 404s the batch."""
    if not titles:
        return {}
    aliases = " ".join(
        f"m{i}: Page(perPage: 1) {{ media(search: {json.dumps(t)}, type: MANGA, sort: SEARCH_MATCH) "
        f"{{ averageScore genres }} }}"
        for i, t in enumerate(titles))
    try:
        data = http_json("https://graphql.anilist.co", {"query": f"query {{ {aliases} }}"}).get("data") or {}
    except Exception as e:
        log(f"anilist failed: {e}")
        return {}
    out = {}
    for i, t in enumerate(titles):
        media = ((data.get(f"m{i}") or {}).get("media") or [None])[0]
        if media:
            out[t] = media
    return out


# ---------------------------------------------------------------- images

def suwayomi_image(path):
    return http_bytes(SUWAYOMI_URL + "/" + path.lstrip("/"), {"Authorization": "Basic " + AUTH})


def mirror_cover(manga, max_age_days=7):
    """Cover saved locally so the phone never waits on Suwayomi or the site for art."""
    rel = f"img/c/{manga['id']}.jpg"
    dest = os.path.join(DATA_DIR, rel)
    if os.path.exists(dest) and time.time() - os.path.getmtime(dest) < max_age_days * 86400:
        return rel
    if not manga.get("thumbnailUrl"):
        return None
    try:
        img = Image.open(io.BytesIO(suwayomi_image(manga["thumbnailUrl"]))).convert("RGB")
        if img.height > COVER_MAX_H:
            img = img.resize((round(img.width * COVER_MAX_H / img.height), COVER_MAX_H), Image.LANCZOS)
        save_jpeg(img, dest, 85)
        return rel
    except Exception as e:
        log(f"cover {manga['id']} failed: {e}")
        return None


def save_jpeg(img, dest, quality):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".tmp"
    img.save(tmp, "JPEG", quality=quality, optimize=True, progressive=True)
    os.replace(tmp, dest)


# ---------------------------------------------------------------- build

def build_feed():
    started = time.time()
    source_id = find_source()
    filters = source_filters(source_id)
    rows_out = []
    for row in ROWS:
        try:
            mangas = fetch_row(source_id, filters, row)
        except Exception as e:
            log(f"row {row['key']} failed: {e}")
            continue
        items = []
        if row.get("subtitles"):
            candidates = mangas[:HERO_ITEMS]
            meta = anilist_lookup([m["title"] for m in candidates])
            for m in candidates:
                image = mirror_cover(m)
                if not image:
                    continue
                info = meta.get(m["title"], {})
                score = f"★ {info['averageScore']}%" if info.get("averageScore") else ""
                items.append({"id": str(m["id"]), "title": m["title"], "image": image,
                              "subtitle": " · ".join([s for s in [score, *(info.get("genres") or [])[:3]] if s])})
        else:
            for m in mangas:
                image = mirror_cover(m)
                if image:
                    items.append({"id": str(m["id"]), "title": m["title"], "image": image})
        rows_out.append({"key": row["key"], "title": row["title"], "style": row["style"], "items": items})
        log(f"row {row['key']}: {len(items)} items")

    feed = {"version": 1, "generatedAt": int(time.time()), "sourceId": str(source_id), "rows": rows_out}
    tmp = os.path.join(DATA_DIR, "feed.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(feed, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(DATA_DIR, "feed.json"))
    log(f"feed built in {time.time() - started:.0f}s: {sum(len(r['items']) for r in rows_out)} items")
    return rows_out


def warm_series(rows):
    """Have Suwayomi fetch details + chapter lists for every feed series ahead of time.

    Browse results are stubs (no description, no chapters), so opening one on the
    phone waited on two live scrapes queued behind the downloader. Hero and top
    rows go first; series refreshed within WARM_MAX_AGE_HOURS are skipped.
    """
    ordered = list(dict.fromkeys(int(item["id"]) for row in rows for item in row["items"]))
    details, chapters = {}, {}
    for i in range(0, len(ordered), 200):
        nodes = gql("query($ids: [Int!]) { mangas(filter: { id: { in: $ids } }) { nodes { id lastFetchedAt chaptersLastFetchedAt } } }",
                    {"ids": ordered[i:i + 200]})["mangas"]["nodes"]
        details.update({n["id"]: int(n["lastFetchedAt"] or 0) for n in nodes})
        chapters.update({n["id"]: int(n["chaptersLastFetchedAt"] or 0) for n in nodes})
    # Details and chapters age separately (opening a series on the phone fetches details alone)
    cutoff = time.time() - WARM_MAX_AGE_HOURS * 3600
    stale = [mid for mid in ordered if details.get(mid, 0) < cutoff or chapters.get(mid, 0) < cutoff]
    started, warmed = time.time(), 0
    for n, mid in enumerate(stale, 1):
        try:
            if details.get(mid, 0) < cutoff:
                gql("mutation($id: Int!) { fetchManga(input: { id: $id }) { manga { id } } }", {"id": mid})
            if chapters.get(mid, 0) < cutoff:
                gql("mutation($id: Int!) { fetchChapters(input: { mangaId: $id }) { chapters { id } } }", {"id": mid})
            warmed += 1
        except Exception as e:
            log(f"warm {mid} failed: {e}")
        if n % 50 == 0:
            log(f"warming: {n}/{len(stale)} in {time.time() - started:.0f}s")
    log(f"warmed {warmed}/{len(stale)} series ({len(ordered) - len(stale)} already fresh) in {time.time() - started:.0f}s")


def builder_loop():
    while True:
        try:
            warm_series(build_feed())
        except Exception:
            log("build failed:\n" + traceback.format_exc())
        time.sleep(REFRESH_HOURS * 3600)


class FeedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Images are immutable per manga id; feed.json changes every rebuild
        self.send_header("Cache-Control", "no-cache" if self.path.startswith("/feed.json") else "max-age=86400")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    threading.Thread(target=builder_loop, daemon=True).start()
    log(f"serving {DATA_DIR} on :{PORT}; refresh every {REFRESH_HOURS}h")
    ThreadingHTTPServer(("0.0.0.0", PORT), partial(FeedHandler, directory=DATA_DIR)).serve_forever()
