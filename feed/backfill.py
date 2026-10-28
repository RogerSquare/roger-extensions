"""Queue every not-yet-downloaded chapter of every Suwayomi library series.

Suwayomi auto-downloads only chapters released after a series is added; this
fills in the back catalog so "add to library" means "download all of it".

Deployed as the `backfill` service in /volume1/docker/suwayomi/compose.yaml
(script at /volume1/docker/suwayomi/backfill/backfill.py).
"""
import base64, json, os, time, urllib.request

URL = os.environ.get("SUWAYOMI_URL", "http://suwayomi:4567") + "/api/graphql"
AUTH = base64.b64encode(f"{os.environ['AUTH_USERNAME']}:{os.environ['AUTH_PASSWORD']}".encode()).decode()
INTERVAL = int(os.environ.get("INTERVAL_SECONDS", "600"))
# manga-feed's duplicate check runs every 5 minutes; give it time to remove a
# duplicate before its whole back catalog gets queued
GRACE_SECONDS = int(os.environ.get("GRACE_SECONDS", "900"))
BATCH = 200


def gql(query, variables=None):
    req = urllib.request.Request(URL, json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 {"Content-Type": "application/json", "Authorization": f"Basic {AUTH}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.load(r)
    if body.get("errors"):
        raise RuntimeError(body["errors"])
    return body["data"]


def run_once():
    queued = {d["chapter"]["id"] for d in gql("{ downloadStatus { queue { chapter { id } } } }")["downloadStatus"]["queue"]}
    mangas = gql("{ mangas(condition:{inLibrary:true}) { nodes { id title inLibraryAt } } }")["mangas"]["nodes"]
    settled = time.time() - GRACE_SECONDS
    total = 0
    for m in [m for m in mangas if int(m["inLibraryAt"] or 0) < settled]:
        chapters = gql("query($id:Int!){ chapters(condition:{mangaId:$id, isDownloaded:false}) { nodes { id } } }",
                       {"id": m["id"]})["chapters"]["nodes"]
        ids = [c["id"] for c in chapters if c["id"] not in queued]
        for i in range(0, len(ids), BATCH):
            gql("mutation($ids:[Int!]!){ enqueueChapterDownloads(input:{ids:$ids}) { clientMutationId } }",
                {"ids": ids[i:i + BATCH]})
        if ids:
            print(f"queued {len(ids):>5}  {m['title']}", flush=True)
            total += len(ids)
    if total:
        gql("mutation { startDownloader(input:{}) { clientMutationId } }")
        print(f"queued {total} chapters total; downloader started", flush=True)


while True:
    try:
        run_once()
    except Exception as e:
        print(f"backfill error: {e}", flush=True)
    time.sleep(INTERVAL)
