import asyncio
import copy
import json
import runpy
import subprocess
import tempfile
import unittest
from importlib.metadata import version
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from harbor.models.trial.result import StepResult
from harbor.trial.errors import AgentTimeoutError
from harbor.trial.trial import Trial

from pokerbeer_harbor_agent import PokerBeerBenchAgent

ROOT = Path(__file__).resolve().parents[1]
verify = runpy.run_path(str(ROOT / "harbor/task/tests/verify.py"))["verify"]


class HarborContractTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        process = subprocess.run(
            ["bun", "tests/fixtures/harbor.ts"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        cls.fixture = json.loads(process.stdout)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.logs = Path(self.directory.name)
        self.bundle = copy.deepcopy(self.fixture["success"])
        self.agent = PokerBeerBenchAgent(logs_dir=self.logs / "agent")
        self.agent.context_id = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        self.agent.session_id = "harbor-contract"
        self.environment = MagicMock(spec=BaseEnvironment)
        self.environment.exec = AsyncMock(return_value=ExecResult(return_code=0))

    def write_bundle(self):
        for name, path in (
            ("result", "artifacts/result.json"),
            ("arena", "artifacts/arena.json"),
            ("harness", "artifacts/harness.json"),
            ("trajectory", "agent/trajectory.json"),
        ):
            target = self.logs / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(self.bundle[name]))

    def synchronize_result(self):
        self.bundle["arena"]["result"] = self.bundle["result"]
        self.bundle["trajectory"]["extra"]["result"] = self.bundle["result"]

    def test_real_game_artifacts_preserve_player_ids_and_award_eight(self):
        trajectory = Trajectory.model_validate(self.bundle["trajectory"])
        assert trajectory.subagent_trajectories is not None
        assert trajectory.extra is not None
        self.assertEqual(len(trajectory.subagent_trajectories), 8)
        for player_id in ("Secret Agent", "api_key"):
            self.assertIn(player_id, self.bundle["result"]["pokerB"]["placements"])
            self.assertIn(player_id, trajectory.extra["result"]["pokerB"]["placements"])
        self.write_bundle()
        self.assertEqual(verify(self.logs), {"reward": 8, "poker_score": 8, "valid": 1})
        context = AgentContext()
        self.agent.populate_context_post_run(context)
        self.assertEqual(
            (context.n_input_tokens, context.n_output_tokens, context.n_cache_tokens), (80, 16, 8)
        )

    def test_failure_artifacts_preserve_available_context_without_awarding_a_result(self):
        for name in ("partial", "preflight", "resumed_partial", "no_new_turns"):
            with self.subTest(name=name):
                self.bundle = copy.deepcopy(self.fixture[name])
                trajectory = Trajectory.model_validate(self.bundle["trajectory"])
                self.write_bundle()
                context = AgentContext()
                self.agent.populate_context_post_run(context)
                assert context.metadata is not None
                self.assertEqual(
                    context.metadata["player_trajectories"],
                    len(trajectory.subagent_trajectories or []),
                )
                self.assertEqual(verify(self.logs)["reward"], 0)
        step = self.fixture["partial"]["trajectory"]["subagent_trajectories"][0]["steps"][0]
        self.assertEqual(step["extra"]["response"], self.fixture["raw_response"])

    def test_resumed_partial_trace_preserves_empty_seat_evidence_without_fabricating_turns(self):
        for name, active_seats in (("resumed_partial", [2, 4, 6, 8]), ("no_new_turns", [])):
            with self.subTest(name=name):
                trajectory = Trajectory.model_validate(self.fixture[name]["trajectory"])
                children = trajectory.subagent_trajectories or []
                expected_ids = [f"fixture-seat-{seat}" for seat in active_seats]
                self.assertEqual([child.trajectory_id for child in children], expected_ids)
                assert trajectory.steps[1].observation is not None
                references = trajectory.steps[1].observation.results
                referenced_ids = []
                for result in references:
                    assert result.subagent_trajectory_ref is not None
                    referenced_ids.append(result.subagent_trajectory_ref[0].trajectory_id)
                self.assertEqual(referenced_ids, expected_ids)
                assert trajectory.extra is not None
                missing = trajectory.extra["seats_without_turns"]
                self.assertEqual(
                    [seat["trajectory_id"] for seat in missing],
                    [f"fixture-seat-{seat}" for seat in range(1, 9) if seat not in active_seats],
                )
                for seat in missing:
                    index = int(seat["trajectory_id"].rsplit("-", 1)[1]) - 1
                    self.assertEqual(seat["session_id"], f"fixture-seat-{index + 1}")
                    self.assertEqual(
                        seat["agent"]["extra"]["player_id"],
                        ["Secret Agent", "api_key", "p3", "p4", "p5", "p6", "p7", "p8"][index],
                    )
                    self.assertEqual(seat["steps"], [])
                    self.assertEqual(seat["final_metrics"]["total_steps"], 0)
                    self.assertEqual(
                        seat["extra"]["errors"],
                        [{"message": "No new Response before interruption."}],
                    )
                    self.assertEqual(
                        seat["extra"]["mcp_calls"],
                        [{"name": "get_actions", "response": {"state": "waiting"}}],
                    )

    def test_context_reads_partial_traces_but_verifier_rejects_incomplete_player_set(self):
        for name in ("preflight", "resumed_partial", "no_new_turns"):
            with self.subTest(name=name):
                self.bundle = copy.deepcopy(self.fixture[name])
                self.bundle["trajectory"]["extra"]["harness"]["status"] = "completed"
                self.write_bundle()
                self.agent.populate_context_post_run(AgentContext())
                self.assertEqual(verify(self.logs)["reward"], 0)

    def test_harbor_rejects_duplicate_or_missing_trajectory_ids(self):
        for duplicate in (True, False):
            with self.subTest(duplicate=duplicate):
                self.bundle = copy.deepcopy(self.fixture["success"])
                children = self.bundle["trajectory"]["subagent_trajectories"]
                children[1]["trajectory_id"] = children[0]["trajectory_id"] if duplicate else None
                self.write_bundle()
                with self.assertRaises(ValueError):
                    self.agent.populate_context_post_run(AgentContext())

    def test_verifier_rejects_inconsistent_or_corrupt_evidence(self):
        for corruption in (
            "mismatch",
            "score",
            "boolean",
            "winner",
            "missing_player",
            "empty_trace",
        ):
            with self.subTest(corruption=corruption):
                self.bundle = copy.deepcopy(self.fixture["success"])
                result = self.bundle["result"]
                if corruption == "mismatch":
                    self.bundle["arena"]["result"] = {}
                elif corruption in ("score", "boolean"):
                    result["pokerB"]["scores"][0]["score"] = True if corruption == "boolean" else 99
                elif corruption == "winner":
                    result["pokerB"]["placements"][result["pokerB"]["winner"]] = 2
                elif corruption == "missing_player":
                    result["pokerB"]["scores"].pop()
                else:
                    self.bundle["trajectory"]["subagent_trajectories"][0]["steps"] = []
                if corruption != "mismatch":
                    self.synchronize_result()
                self.write_bundle()
                self.assertEqual(verify(self.logs)["reward"], 0)

    def test_missing_malformed_and_wrong_shape_json_fail_closed(self):
        self.assertEqual(verify(self.logs)["reward"], 0)
        for body in ("{", "[]", "null", '{"manifest": []}'):
            with self.subTest(body=body):
                self.write_bundle()
                (self.logs / "artifacts/arena.json").write_text(body)
                self.assertEqual(verify(self.logs)["reward"], 0)

    def test_competition_rank_ties_keep_existing_reward(self):
        poker = self.bundle["result"]["pokerB"]
        players = list(poker["placements"])
        poker["placements"] = dict(zip(players, (1, 2, 3, 3, 5, 6, 7, 8), strict=True))
        poker["winner"] = players[0]
        poker["scores"] = [
            {"playerId": player, "place": place, "score": 9 - place}
            for player, place in poker["placements"].items()
        ]
        self.synchronize_result()
        self.write_bundle()
        self.assertEqual(verify(self.logs)["reward"], 8)

    async def test_preinstalled_image_check_and_launch_use_framework_execution(self):
        self.assertEqual(
            self.agent.version(), json.loads((ROOT / "package.json").read_text())["version"]
        )
        await self.agent.install(self.environment)
        self.assertIn("bun --version", self.environment.exec.call_args.kwargs["command"])
        await self.agent.run("Play until complete.", self.environment, AgentContext())
        launch = self.environment.exec.call_args.kwargs
        self.assertEqual(launch["env"]["HARBOR_INSTRUCTION"], "Play until complete.")
        self.assertEqual(launch["env"]["HARBOR_VERSION"], version("harbor"))
        self.assertEqual(launch["env"]["HARBOR_TRIAL_ID"], str(self.agent.context_id))

    async def test_nonzero_process_exit_propagates(self):
        self.environment.exec.return_value = ExecResult(return_code=1, stderr="Trial failed.")
        with self.assertRaises(NonZeroAgentExitCodeError):
            await self.agent.run("play", self.environment, AgentContext())

    async def test_harbor_outer_timeout_cancels_the_running_command(self):
        cancelled = asyncio.Event()

        async def blocked(**_kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        self.environment.exec.side_effect = blocked
        self.environment.with_default_user.return_value = nullcontext()
        self.environment.scoped_exec_env.return_value = nullcontext()
        phase = SimpleNamespace(
            agent=self.agent,
            user_agent=None,
            agent_environment=self.environment,
            _emit=AsyncMock(),
            _now=Trial._now,
            _network_plan=lambda _: SimpleNamespace(agent_env_baseline=None, agent_phase=None),
            _phase_network_policy=lambda *_args, **_kwargs: nullcontext(),
            _log_context=lambda *_args: nullcontext(),
        )
        target = StepResult(step_name="tournament")
        with self.assertRaises(AgentTimeoutError):
            await Trial._run_agent_phase(
                cast(Trial, phase), target=target, instruction="play", timeout_sec=0.01, user=None
            )
        self.assertTrue(cancelled.is_set())
        assert target.agent_execution is not None
        self.assertIsNotNone(target.agent_execution.finished_at)
