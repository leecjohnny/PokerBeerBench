# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

import json
from pathlib import Path


def verify(logs: Path) -> dict[str, int]:
    reward = 0
    try:
        result = json.loads((logs / "artifacts/result.json").read_text())
        arena = json.loads((logs / "artifacts/arena.json").read_text())
        trajectory = json.loads((logs / "agent/trajectory.json").read_text())
        scores, placements = result["pokerB"]["scores"], result["pokerB"]["placements"]
        values = [entry["score"] for entry in scores]
        players = [entry["playerId"] for entry in scores]
        places, winner = list(placements.values()), result["pokerB"]["winner"]
        children = trajectory["subagent_trajectories"]
        if (
            result.get("valid") is True
            and arena.get("result") == result == trajectory.get("extra", {}).get("result")
            and arena.get("manifest", {}).get("status") == "completed"
            and arena["manifest"].get("stage") == "complete"
            and trajectory.get("schema_version") == "ATIF-v1.7"
            and len(children) == 8
            and all(
                any(step.get("source") == "agent" for step in child.get("steps", []))
                for child in children
            )
            and len(scores) == len(placements) == len(set(players)) == 8
            and set(players) == set(placements)
            and all(type(entry[key]) is int for entry in scores for key in ("place", "score"))
            and all(type(place) is int and 1 <= place <= 8 for place in places)
            and places.count(1) == 1
            and placements[winner] == 1
            and all(place == 1 + sum(other < place for other in places) for place in places)
            and all(
                entry["place"] == placements[entry["playerId"]]
                and entry["score"] == 9 - entry["place"]
                for entry in scores
            )
            and result.get("reward") == max(values)
        ):
            reward = max(values)
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        pass
    outcome = {"reward": reward, "poker_score": reward, "valid": int(reward == 8)}
    reward_path = logs / "verifier/reward.json"
    reward_path.parent.mkdir(parents=True, exist_ok=True)
    reward_path.write_text(json.dumps(outcome))
    return outcome


if __name__ == "__main__":
    verify(Path("/logs"))
