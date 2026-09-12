import json
from pathlib import Path
from typing import override
from importlib.metadata import version

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory


class PokerBeerBenchAgent(BaseInstalledAgent):
    """Harbor boundary for one complete, preinstalled tournament trial."""

    SUPPORTS_ATIF = True

    @staticmethod
    @override
    def name() -> str:
        return "pokerbeer-bench"

    @override
    def version(self) -> str | None:
        return json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text())[
            "version"
        ]

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_agent(
            environment,
            command="bun --version && test -f harbor/runner/main.ts",
            cwd="/app",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self.exec_as_agent(
            environment,
            command="bun run harbor/runner/main.ts --config configs/benchmark.json",
            cwd="/app",
            timeout_sec=172800,
            env={
                "HARBOR_INSTRUCTION": instruction,
                "HARBOR_VERSION": version("harbor"),
                "HARBOR_TRIAL_ID": str(self.context_id or ""),
                "HARBOR_SESSION_NAME": self.session_id or "",
                "HARBOR_TRAJECTORY_PATH": "/logs/agent/trajectory.json",
                "HARBOR_RESULT_PATH": "/logs/artifacts/result.json",
                "HARBOR_ALLOCATION_PATH": "/tmp/viewer-allocation.json",
                "RESPONSES_EVENT_LOG_DIR": "/logs/agent/events",
            },
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        path = Path(self.logs_dir) / "trajectory.json"
        if not path.exists():
            return
        trajectory = Trajectory.model_validate_json(path.read_text())
        children = trajectory.subagent_trajectories or []
        metrics = trajectory.final_metrics
        if metrics is not None:
            context.n_input_tokens = metrics.total_prompt_tokens or 0
            context.n_output_tokens = metrics.total_completion_tokens or 0
            context.n_cache_tokens = metrics.total_cached_tokens or 0
            context.cost_usd = metrics.total_cost_usd
        context.metadata = {
            "atif_schema": trajectory.schema_version,
            "harbor_trial_id": str(self.context_id or ""),
            "player_trajectories": len(children),
        }
