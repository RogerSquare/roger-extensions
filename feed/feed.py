"""Precached discovery feed for the roger-extensions Tachidesk source.

Every REFRESH_HOURS this rebuilds feed.json from Suwayomi: the same
Crunchyroll-style rows the extension used to fetch live (Weeb Central
filters, adult content off), with covers mirrored to disk and hero images
rendered to Paperback's featured-card shape. A small HTTP server serves
feed.json and img/ so the phone makes one fast LAN request instead of ~20
live scrapes queued behind the downloader.

Hero art: a TMDB backdrop when the series has an anime adaptation (needs
TMDB_TOKEN), otherwise the manga cover over a blurred copy of itself.
"""
import base64
import io
import json
import os
import threading
import time
import traceback
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

SUWAYOMI_URL = os.environ.get("SUWAYOMI_URL", "http://10.0.0.145:4567").rstrip("/")
AUTH = base64.b64encode(f"{os.environ['AUTH_USERNAME']}:{os.environ['AUTH_PASSWORD']}".encode()).decode()
TMDB_TOKEN = os.environ.get("TMDB_TOKEN", "").strip()
DATA_DIR = os.environ.get("DATA_DIR", "/data")
PORT = int(os.environ.get("PORT", "4580"))
REFRESH_HOURS = float(os.environ.get("REFRESH_HOURS", "6"))
SOURCE_NAME = os.environ.get("DISCOVER_SOURCE", "Weeb Central")
USER_AGENT = "manga-feed/1.0 (+https://github.com/RogerSquare/roger-extensions)"

# Featured card measured on the phone: 858x589 pt, title/subtitle/buttons
# drawn over the bottom ~42%. Keep the subject in the top part.
HERO_W, HERO_H = 1200, 824
HERO_ITEMS = 20
ROW_PAGES = 2  # ~64 items, so rows stay full after the extension hides library series
COVER_MAX_H = 900

GENRES = ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Mystery", "Romance",
          "Sci-fi", "Slice of Life", "Supernatural", "Horror", "Psychological",
          "Sports", "Historical"]

ROWS = [
    {"key": "hero", "title": "Trending Now", "style": "featured", "sort": "Popularity", "ongoing": True},
    {"key": "new", "title": "Newly Added", "style": "singleRowNormal", "sort": "Recently Added"},
    {"key": "popular", "title": "Most Popular", "style": "singleRowLarge", "sort": "Popularity"},
    {"key": "anime", "title": "Now an Anime", "style": "singleRowNormal", "sort": "Popularity", "anime": True},
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
            + (group("Tags", row["tag"], {"triState": "INCLUDE"}) if row.get("tag") else []))


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
        f"{{ title {{ romaji english }} coverImage {{ extraLarge }} averageScore genres }} }}"
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


def tmdb_backdrop(names):
    """Textless backdrop of the anime adaptation, if TMDB knows one."""
    if not TMDB_TOKEN:
        return None
    headers = {"Authorization": "Bearer " + TMDB_TOKEN}
    for name in [n for n in names if n]:
        try:
            results = http_json("https://api.themoviedb.org/3/search/tv?include_adult=false&query="
                                + urllib.parse.quote(name), headers=headers, timeout=20).get("results") or []
            anime = [r for r in results if 16 in (r.get("genre_ids") or [])]
            if not anime:
                continue
            images = http_json(f"https://api.themoviedb.org/3/tv/{anime[0]['id']}/images"
                               "?include_image_language=null,en", headers=headers, timeout=20)
            backdrops = sorted(images.get("backdrops") or [],
                               key=lambda b: (b.get("iso_639_1") is not None, -(b.get("vote_average") or 0)))
            if backdrops:
                return "https://image.tmdb.org/t/p/w1280" + backdrops[0]["file_path"]
        except Exception as e:
            log(f"tmdb {name!r} failed: {e}")
    return None


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


def fill(img, w, h, bias=0.5):
    """Scale to cover w x h and crop; bias < 0.5 keeps more of the top (faces, titles)."""
    scale = max(w / img.width, h / img.height)
    img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    left, top = (img.width - w) // 2, int((img.height - h) * bias)
    return img.crop((left, top, left + w, top + h))


def vignette(canvas, strength=200):
    # Darker edges pull the eye to the centered cover
    small = Image.new("L", (HERO_W // 8, HERO_H // 8), 0)
    w, h = small.size
    ImageDraw.Draw(small).ellipse((-w * 0.15, -h * 0.35, w * 1.15, h * 1.05), fill=255)
    mask = small.filter(ImageFilter.GaussianBlur(w // 6)).resize(canvas.size)
    return Image.composite(canvas, Image.blend(canvas, Image.new("RGB", canvas.size, (0, 0, 0)), strength / 255), mask)


def rounded_mask(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius, fill=255)
    return mask


def bottom_fade(canvas, start=0.42, strength=250):
    # Paperback draws title, subtitle and buttons over the lower part of the card
    fade = Image.new("L", (1, HERO_H), 0)
    begin = int(HERO_H * start)
    for y in range(begin, HERO_H):
        fade.putpixel((0, y), int(strength * ((y - begin) / (HERO_H - begin)) ** 1.3))
    black = Image.new("RGB", canvas.size, (0, 0, 0))
    return Image.composite(black, canvas, fade.resize(canvas.size))


def render_backdrop_hero(backdrop):
    # Whole 16:9 backdrop across the top, extended downward by a blurred copy
    canvas = ImageEnhance.Brightness(fill(backdrop, HERO_W, HERO_H).filter(ImageFilter.GaussianBlur(30))).enhance(0.5)
    sharp = backdrop.resize((HERO_W, round(backdrop.height * HERO_W / backdrop.width)), Image.LANCZOS)
    canvas.paste(sharp, (0, 0))
    return bottom_fade(canvas, start=0.40)


def render_cover_hero(cover):
    # Crunchyroll-style: the sharp cover over its own upper art, blurred and
    # saturated (a heavy blur turns into a grey smear), with a vignette
    bg = fill(cover, HERO_W, HERO_H, bias=0.2).filter(ImageFilter.GaussianBlur(18))
    canvas = vignette(ImageEnhance.Brightness(ImageEnhance.Color(bg).enhance(1.35)).enhance(0.62))
    cover_h = int(HERO_H * 0.60)
    sharp = cover.resize((round(cover.width * cover_h / cover.height), cover_h), Image.LANCZOS)
    x, y = (HERO_W - sharp.width) // 2, 26
    shadow = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x + 4, y + 14, x + sharp.width + 4, y + sharp.height + 14), 16, fill=200)
    canvas = Image.composite(Image.new("RGB", canvas.size, (0, 0, 0)), canvas, shadow.filter(ImageFilter.GaussianBlur(22)))
    canvas.paste(sharp, (x, y), rounded_mask(sharp, 14))
    return bottom_fade(canvas, start=0.55)


def build_hero(manga, meta):
    rel = f"img/h/{manga['id']}.jpg"
    names = [(meta.get("title") or {}).get("english"), (meta.get("title") or {}).get("romaji"), manga["title"]]
    backdrop_url = tmdb_backdrop(list(dict.fromkeys(names)))
    try:
        if backdrop_url:
            img = render_backdrop_hero(Image.open(io.BytesIO(http_bytes(backdrop_url))).convert("RGB"))
        else:
            cover_url = (meta.get("coverImage") or {}).get("extraLarge")
            raw = http_bytes(cover_url) if cover_url else suwayomi_image(manga["thumbnailUrl"])
            img = render_cover_hero(Image.open(io.BytesIO(raw)).convert("RGB"))
        save_jpeg(img, os.path.join(DATA_DIR, rel), 86)
        return rel, "tmdb" if backdrop_url else "cover"
    except Exception as e:
        log(f"hero {manga['id']} failed: {e}")
        return None, None


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
        if row["style"] == "featured":
            candidates = mangas[:HERO_ITEMS]
            meta = anilist_lookup([m["title"] for m in candidates])
            for m in candidates:
                info = meta.get(m["title"], {})
                image, kind = build_hero(m, info)
                if not image:
                    continue
                score = f"★ {info['averageScore']}%" if info.get("averageScore") else ""
                items.append({"id": str(m["id"]), "title": m["title"], "image": image, "art": kind,
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


def builder_loop():
    while True:
        try:
            build_feed()
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
    log(f"serving {DATA_DIR} on :{PORT}; refresh every {REFRESH_HOURS}h; tmdb {'on' if TMDB_TOKEN else 'off'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), partial(FeedHandler, directory=DATA_DIR)).serve_forever()
