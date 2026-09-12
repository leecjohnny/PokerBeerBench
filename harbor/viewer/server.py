# /// script
# requires-python = ">=3.12"
# dependencies = ["harbor==0.22.0"]
# ///

import hmac
import os
import tarfile
import urllib.request
from pathlib import Path

import uvicorn
from harbor.cli.view import STATIC_DIR
from harbor.viewer.server import create_app
from starlette.responses import Response

with urllib.request.urlopen(os.environ.pop("ARCHIVE_URL"), timeout=45) as archive:
    with tarfile.open(fileobj=archive, mode="r|gz") as bundle:
        bundle.extractall("jobs", filter="data")
app = create_app(Path("jobs"), static_dir=STATIC_DIR)
secret = os.environ.pop("VIEWER_TOKEN")


@app.middleware("http")
async def authorize(request, call_next):
    if not hmac.compare_digest(request.headers.get("x-viewer-token", ""), secret):
        return Response(status_code=403)
    if request.method not in ("GET", "HEAD"):
        return Response(status_code=405)
    return await call_next(request)


uvicorn.run(app, host="0.0.0.0", port=8080, access_log=False)
