"""Minimal fixed-profile Qamomile → CUDA-Q GPU execution check.

Run in the Colab GPU environment after installing
``requirements-quantum-colab.txt``. ``REQUIRE_CUDAQ=1`` ensures the test
fails instead of using the NumPy fallback.
"""
from __future__ import annotations

import os

from app.backends.hybrid_qaoa import HybridQAOABackend
from app.config.quantum_profile import build_fixed_hybrid_config
from app.models.schemas import QUBOProblem, RunConfig


def main() -> None:
    os.environ["CUDAQ_TARGET"] = "nvidia"
    os.environ["REQUIRE_CUDAQ"] = "1"

    problem = QUBOProblem(
        dimension=2,
        offset=0.0,
        linear={"0": -1.0, "1": -0.6},
        quadratic={"0,1": 1.4},
        variable_order=[("SMOKE_G1", 0), ("SMOKE_G2", 0)],
        penalty_weights={"smoke": 1.0},
        metadata={"incumbent_bitstring": "00"},
    )
    config = RunConfig(
        hybrid_config=build_fixed_hybrid_config(
            qubit_budget=2,
            candidate_generators=2,
            candidate_hours=1,
            top_k=2,
        )
    )
    result = HybridQAOABackend().solve(problem, config)
    print(
        {
            "status": result.status,
            "mode": result.mode_label,
            "target": "nvidia",
            "source": result.candidates[0].source,
            "best_bitstring": result.candidates[0].bitstring,
            "best_energy": result.candidates[0].energy,
            "objective_mode": result.raw_payload.get("objective_mode"),
        }
    )


if __name__ == "__main__":
    main()
