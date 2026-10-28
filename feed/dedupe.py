"""Find and resolve duplicate library series across Suwayomi sources.

The same series added from two sources is two unrelated Suwayomi entries, so
the backfill would download both and Komga would show both. Matching is by
normalized title, or by AniList id when both copies carry the same edition
markers (so "Bleach" and "Bleach (Color)" stay separate).

Winner: official sources first, but only with at least OFFICIAL_MIN_SHARE of
the best copy's chapters (MANGA Plus often has just the first and latest
chapters); then SOURCE_PRIORITY; then more chapters; then the earlier add.
Losers hand their read progress to the winner, lose their queued and
downloaded chapters, and leave the library. With DEDUPE_DRY_RUN on, nothing
changes; the report shows what would happen.
"""
import html
import json
import os
import re
import time
import unicodedata

OFFICIAL_SOURCES = ["MANGA Plus by SHUEISHA", "Webtoons.com", "VIZ", "K Manga", "Comikey"]
SOURCE_PRIORITY = ["Weeb Central", "MangaFire", "Manganato", "Mangakakalot", "MangaPill", "MangaKatana",
                   "Mangago", "MangaDex", "Asura Scans", "Flame Comics", "Vortex Scans", "Hive Scans",
                   "Drake Scans", "Manhua Plus"]
OFFICIAL_MIN_SHARE = 0.9
EDITION_MARKERS = {"color", "colored", "colour", "coloured", "official", "remake", "novel", "anthology",
                   "oneshot", "pilot", "raw", "webcomic", "fancolored", "digital"}


def normalize(title):
    # "×" is a common stand-in for "x" (Spy × Family, Hunter × Hunter)
    title = unicodedata.normalize("NFKD", title.replace("×", "x")).encode("ascii", "ignore").decode().lower()
    ascii_title = re.sub(r"[^a-z0-9]+", " ", title.replace("&", " and ")).strip()
    return re.sub(r"^the ", "", ascii_title)


def title_key(title):
    """normalize(), but never empty: an all-CJK title would otherwise collide with every other one."""
    return normalize(title) or title.strip().lower()


def editions(title):
    return EDITION_MARKERS & set(normalize(title).split())


def source_rank(name):
    for i, prefix in enumerate(OFFICIAL_SOURCES + SOURCE_PRIORITY):
        if name.startswith(prefix):
            return i
    return len(OFFICIAL_SOURCES) + len(SOURCE_PRIORITY)


def is_official(name):
    return any(name.startswith(prefix) for prefix in OFFICIAL_SOURCES)


def pick_winner(group):
    most = max(m["chapterCount"] for m in group)

    def key(m):
        name = m["source"]["displayName"]
        # An official copy missing most chapters drops behind the aggregators
        demoted = is_official(name) and m["chapterCount"] < OFFICIAL_MIN_SHARE * most
        return (demoted, source_rank(name), -m["chapterCount"], int(m["inLibraryAt"] or 0))

    return sorted(group, key=key)[0]


class Deduper:
    def __init__(self, gql, anilist_ids, data_dir, log, dry_run):
        self.gql, self.anilist_ids, self.log, self.dry_run = gql, anilist_ids, log, dry_run
        self.history_path = os.path.join(data_dir, "duplicates.json")
        self.page_path = os.path.join(data_dir, "duplicates.html")
        self.cache_path = os.path.join(data_dir, "anilist_ids.json")

    def _load(self, path, default):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return default

    def _save(self, path, data):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)

    def library(self):
        return self.gql("""{ mangas(condition: { inLibrary: true }) { nodes {
            id title inLibraryAt source { displayName } chapters { totalCount } } } }""")["mangas"]["nodes"]

    def groups(self, library):
        cache = self._load(self.cache_path, {})
        missing = [m["title"] for m in library if m["title"] not in cache]
        if missing:
            cache.update(self.anilist_ids(missing))
            self._save(self.cache_path, cache)

        parent = {m["id"]: m["id"] for m in library}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        by_key = {}
        for m in library:
            keys = [("title", title_key(m["title"]))]
            if cache.get(m["title"]):
                keys.append(("anilist", cache[m["title"]], tuple(sorted(editions(m["title"])))))
            for k in keys:
                if k in by_key:
                    parent[find(m["id"])] = find(by_key[k])
                else:
                    by_key[k] = m["id"]

        grouped = {}
        for m in library:
            m["chapterCount"] = m["chapters"]["totalCount"]
            grouped.setdefault(find(m["id"]), []).append(m)
        return [g for g in grouped.values() if len(g) > 1]

    def resolve(self, winner, loser):
        read = self.gql("""query($id: Int!) { chapters(condition: { mangaId: $id, isRead: true }) {
            nodes { chapterNumber } } }""", {"id": loser["id"]})["chapters"]["nodes"]
        read_numbers = {c["chapterNumber"] for c in read}
        if read_numbers:
            target = self.gql("""query($id: Int!) { chapters(condition: { mangaId: $id }) {
                nodes { id chapterNumber isRead } } }""", {"id": winner["id"]})["chapters"]["nodes"]
            ids = [c["id"] for c in target if c["chapterNumber"] in read_numbers and not c["isRead"]]
            if ids:
                self.gql("mutation($ids: [Int!]!) { updateChapters(input: { ids: $ids, patch: { isRead: true } }) { clientMutationId } }",
                         {"ids": ids})

        chapters = self.gql("""query($id: Int!) { chapters(condition: { mangaId: $id }) {
            nodes { id isDownloaded } } }""", {"id": loser["id"]})["chapters"]["nodes"]
        queued = {d["chapter"]["id"] for d in self.gql("{ downloadStatus { queue { chapter { id } } } }")["downloadStatus"]["queue"]}
        dequeue = [c["id"] for c in chapters if c["id"] in queued]
        downloaded = [c["id"] for c in chapters if c["isDownloaded"]]
        if dequeue:
            self.gql("mutation($ids: [Int!]!) { dequeueChapterDownloads(input: { ids: $ids }) { clientMutationId } }", {"ids": dequeue})
        if downloaded:
            self.gql("mutation($ids: [Int!]!) { deleteDownloadedChapters(input: { ids: $ids }) { clientMutationId } }", {"ids": downloaded})
        self.gql("mutation($id: Int!) { updateManga(input: { id: $id, patch: { inLibrary: false } }) { clientMutationId } }",
                 {"id": loser["id"]})
        return len(read_numbers), len(dequeue), len(downloaded)

    def run(self):
        history = self._load(self.history_path, [])
        found = self.groups(self.library())
        for group in found:
            winner = pick_winner(group)
            for loser in [m for m in group if m["id"] != winner["id"]]:
                entry = {"at": int(time.time()), "dryRun": self.dry_run, "title": winner["title"],
                         "kept": {"id": winner["id"], "source": winner["source"]["displayName"], "chapters": winner["chapterCount"]},
                         "removed": {"id": loser["id"], "title": loser["title"], "source": loser["source"]["displayName"],
                                     "chapters": loser["chapterCount"]}}
                if not self.dry_run:
                    read, dequeued, deleted = self.resolve(winner, loser)
                    entry.update({"readCopied": read, "dequeued": dequeued, "deletedFiles": deleted})
                # Dry runs re-detect the same pair every pass; keep one row per pair
                history = [h for h in history if not (h["dryRun"] and h["removed"]["id"] == loser["id"])]
                history.append(entry)
                self.log(f"duplicate{' (dry run)' if self.dry_run else ''}: keep {winner['title']!r} "
                         f"[{entry['kept']['source']}, {winner['chapterCount']} ch], remove [{entry['removed']['source']}, "
                         f"{loser['chapterCount']} ch]")
        self._save(self.history_path, history[-500:])
        self.render(history[-500:], len(found))

    def render(self, history, open_groups):
        rows = "".join(
            f"<tr><td>{time.strftime('%Y-%m-%d %H:%M', time.localtime(h['at']))}</td>"
            f"<td>{html.escape(h['title'])}</td>"
            f"<td>{html.escape(h['kept']['source'])} <span>({h['kept']['chapters']} ch)</span></td>"
            f"<td>{html.escape(h['removed']['source'])} <span>({h['removed']['chapters']} ch)</span></td>"
            f"<td>{'would remove' if h['dryRun'] else 'removed'}</td></tr>"
            for h in reversed(history))
        mode = "DRY RUN: nothing is removed yet" if self.dry_run else "automatic"
        page = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manga duplicates</title><style>
:root{{color-scheme:dark}}body{{font:15px system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:16px}}
h1{{font-size:20px;margin:0 0 4px}}p{{color:#aaa;margin:0 0 16px}}table{{border-collapse:collapse;width:100%}}
td,th{{text-align:left;padding:8px;border-bottom:1px solid #333;vertical-align:top}}th{{color:#aaa;font-weight:500}}
span{{color:#888}}</style></head><body><h1>Duplicate series</h1>
<p>Mode: {mode} · {open_groups} duplicate group(s) in the library on the last check · updated {time.strftime('%Y-%m-%d %H:%M')}</p>
<table><tr><th>When</th><th>Series</th><th>Kept</th><th>Removed</th><th></th></tr>{rows or '<tr><td colspan=5>No duplicates found.</td></tr>'}</table>
</body></html>"""
        with open(self.page_path + ".tmp", "w", encoding="utf-8") as f:
            f.write(page)
        os.replace(self.page_path + ".tmp", self.page_path)
