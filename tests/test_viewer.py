import hmac
import json
import os
import re
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from harbor.models.job.config import JobConfig
from harbor.models.trajectories import Trajectory
from harbor.models.trial.config import TrialConfig
from harbor.models.trial.result import TrialResult

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "viewer-integration-test-only-0000000000"
JOB = hmac.new(TOKEN.encode(), b"atif:viewer-fixture", "sha256").hexdigest()
PLAYERS = ["Secret Agent", "api_key", "小明", "p4", "p5", "p6", "p7", "p8"]


def fixture_archive():
    """Use the real publisher so native Harbor validates its generated trial files."""
    (ROOT / ".local").mkdir(exist_ok=True)
    config = TrialConfig.model_validate(
        {"task": {"path": "harbor/task"}, "agent": {"name": "fixture"}}
    )
    result = TrialResult.model_validate(
        {
            "task_name": "fixture",
            "trial_name": "source",
            "trial_uri": "file:///fixture",
            "task_id": {"path": "harbor/task"},
            "task_checksum": "fixture",
            "config": config,
            "agent_info": {"name": "fixture", "version": "1"},
            "started_at": "2026-09-12T00:00:00Z",
            "finished_at": "2026-09-12T01:00:00Z",
        }
    )
    files = {
        "config.json": JobConfig(job_name=JOB).model_dump(mode="json"),
        "source/result.json": result.model_dump(mode="json"),
    }
    children = []
    for seat, player in enumerate(PLAYERS, 1):
        name = f"seat-{seat}"
        trajectory = Trajectory.model_validate(
            {
                "trajectory_id": name,
                "agent": {"name": player, "version": "1", "extra": {"player_id": player}},
                "steps": [{"step_id": 1, "source": "agent", "message": f"Hello, {player}"}],
            }
        ).model_dump(mode="json", exclude_none=True)
        children.append(trajectory)
    files["source/agent/trajectory.json"] = Trajectory.model_validate(
        {
            **children[0],
            "trajectory_id": "root",
            "subagent_trajectories": children,
            "extra": {"simulation_id": "viewer-fixture"},
            "final_metrics": {"total_completion_tokens": 8},
        }
    ).model_dump(mode="json", exclude_none=True)
    with tempfile.TemporaryDirectory(prefix="publication-test-", dir=ROOT / ".local") as directory:
        for name, value in files.items():
            path = Path(directory) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value))
        subprocess.run(
            [
                "bun",
                "-e",
                "import {mock} from 'bun:test';"
                "mock.module('@vercel/blob',()=>({put:async(path,stream)=>{"
                "if(path.endsWith('.tar.gz')) await Bun.write(process.argv[1]+'/archive.tar.gz',"
                "await new Response(stream).arrayBuffer());return {url:'https://fixture.test'};}}));"
                "const {publishTraces}=await import('./harbor/viewer/publish.ts');"
                "await publishTraces(process.argv[1]+'/source','viewer-fixture',process.argv[2]);",
                directory,
                TOKEN,
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            timeout=30,
        )
        return (Path(directory) / "archive.tar.gz").read_bytes()


class ViewerServerTests(unittest.TestCase):
    def test_native_viewer_hydrates_archive_and_is_authenticated_read_only(self):
        archive = fixture_archive()
        downloads = []

        class ArchiveHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                downloads.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", str(len(archive)))
                self.end_headers()
                self.wfile.write(archive)

            def log_message(self, format: str, *args) -> None:
                pass

        local = ROOT / ".local"
        local.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="viewer-test-", dir=local) as directory:
            with ThreadingHTTPServer(("127.0.0.1", 0), ArchiveHandler) as origin:
                thread = threading.Thread(target=origin.serve_forever, daemon=True)
                thread.start()
                self.addCleanup(thread.join, 5)
                self.addCleanup(origin.shutdown)
                # Pass a bound socket to uvicorn so concurrent runs cannot steal the port.
                with socket.socket() as listener:
                    listener.bind(("127.0.0.1", 0))
                    base = f"http://127.0.0.1:{listener.getsockname()[1]}"
                    driver = Path(directory) / "viewer.py"
                    driver.write_text(
                        (ROOT / "harbor/viewer/server.py")
                        .read_text()
                        .replace('host="0.0.0.0", port=8080', 'fd=int(os.environ["VIEWER_FD"])')
                    )
                    subprocess.run(
                        ["uv", "sync", "--script", str(driver)],
                        check=True,
                        capture_output=True,
                        timeout=180,
                    )
                    with (Path(directory) / "server.log").open("w+") as log:
                        process = subprocess.Popen(
                            [
                                "uv",
                                "run",
                                "--offline",
                                "--script",
                                str(driver),
                            ],
                            cwd=directory,
                            env={
                                **os.environ,
                                "VIEWER_TOKEN": TOKEN,
                                "VIEWER_FD": str(listener.fileno()),
                                "ARCHIVE_URL": f"http://127.0.0.1:{origin.server_port}/harbor.tar.gz",
                            },
                            pass_fds=(listener.fileno(),),
                            stdout=log,
                            stderr=subprocess.STDOUT,
                        )
                        try:

                            def request(path, token=TOKEN, method="GET"):
                                headers = {} if token is None else {"x-viewer-token": token}
                                req = Request(base + path, headers=headers, method=method)
                                try:
                                    response = urlopen(req, timeout=2)
                                except HTTPError as error:
                                    response = error
                                with response:
                                    return response.status, response.read()

                            deadline = time.monotonic() + 30
                            while time.monotonic() < deadline:
                                if process.poll() is not None:
                                    break
                                try:
                                    if request("/api/health")[0] == 200:
                                        break
                                except (URLError, TimeoutError):
                                    pass
                                time.sleep(0.05)
                            else:
                                self.fail("Viewer did not become healthy within 30 seconds")
                            if process.poll() is not None:
                                log.seek(0)
                                self.fail(f"Viewer exited during startup:\n{log.read()}")

                            self.assertEqual(downloads, ["/harbor.tar.gz"])
                            self.assertTrue(
                                (Path(directory) / "jobs" / JOB / "config.json").is_file()
                            )
                            for token in (None, "wrong-token"):
                                for path in (
                                    "/",
                                    "/api/health",
                                    f"/api/jobs/{JOB}/trials/seat-1/trajectory",
                                ):
                                    self.assertEqual(request(path, token)[0], 403)
                            self.assertEqual(request("/api/health")[0], 200)
                            for method in ("POST", "PUT", "PATCH", "DELETE"):
                                self.assertEqual(request("/api/run", method=method)[0], 405)
                            status, html = request("/")
                            self.assertIn(b'type="module"', html)
                            self.assertNotIn(b'id="root"', html)
                            frame_source = (ROOT / "web/components/trace-frame.tsx").read_text()
                            self.assertIn("querySelector('script[type=\"module\"]')", frame_source)
                            self.assertEqual(status, 200)
                            assets = re.findall(rb'(?:src|href)="(/assets/[^\"]+)"', html)
                            self.assertTrue(
                                assets, "Native Harbor HTML must reference bundled assets"
                            )
                            for asset in assets:
                                self.assertEqual(request(asset.decode())[0], 200)
                                self.assertEqual(request(asset.decode(), None)[0], 403)
                            status, body = request(f"/api/jobs/{JOB}/config")
                            self.assertEqual(status, 200)
                            self.assertEqual(json.loads(body)["job_name"], JOB)
                            for seat, player in enumerate(PLAYERS, 1):
                                route = f"/api/jobs/{JOB}/trials/seat-{seat}"
                                status, body = request(route)
                                self.assertEqual(status, 200)
                                self.assertEqual(json.loads(body)["config"]["task"]["name"], player)
                                self.assertEqual(json.loads(body)["agent_info"]["version"], "1")
                                status, body = request(route + "/trajectory")
                                self.assertEqual(status, 200)
                                self.assertEqual(
                                    json.loads(body)["agent"]["extra"]["player_id"], player
                                )
                            status, body = request(f"/api/jobs/{JOB}/trials/root/trajectory")
                            self.assertEqual(status, 200)
                            self.assertEqual(len(json.loads(body)["subagent_trajectories"]), 8)
                            status, body = request(f"/api/jobs/{JOB}/trials/root")
                            self.assertEqual(status, 200)
                            self.assertEqual(
                                json.loads(body)["config"]["task"]["path"], "harbor/task"
                            )
                        finally:
                            process.terminate()
                            try:
                                process.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait(timeout=5)
