from __future__ import annotations

from dataclasses import dataclass

from app.config.quantum_profile import FIXED_QUANTUM_PROFILE


# Main benchmark axes. QAOA depth, shots, optimizer budget and ADMM rounds are
# fixed by FIXED_QUANTUM_PROFILE and are never changed to improve runtime.
QUBIT_BUDGETS = [8, 10, 14, 18, 20, 24, 26]
GENERATOR_COUNTS = [10, 20, 30, 40, 50]
GENERATOR_SCALING_QUBITS = [10, 20]
QUANTUM_SEEDS = [11, 23, 37]

METHOD_COMPARISON_QUBITS = 10
QUBIT_SCALING_SCENARIO = "double-peak"
GENERATOR_SCALING_SCENARIO = "double-peak"


@dataclass(frozen=True)
class IEEE30Case:
    case_id: str
    description: str


# Eight 24-hour operating profiles derived from the same MATPOWER case30
# copper-plate UC adaptation. Network topology is not solved by this prototype;
# demand is aggregated and the same ten virtual thermal units are retained.
IEEE30_CASES = [
    IEEE30Case("base-day", "Balanced IEEE30-derived operating day"),
    IEEE30Case("cloudy-solar", "Cloud cover suppresses midday solar"),
    IEEE30Case("double-peak", "Strong morning and evening demand peaks"),
    IEEE30Case("summer-solar", "High afternoon demand with strong solar"),
    IEEE30Case("windy-night", "High overnight wind production"),
    IEEE30Case("evening-ramp", "Steep evening net-load ramp"),
    IEEE30Case("high-demand", "High-load stress profile"),
    IEEE30Case("renewable-drop", "Renewable output drops before evening peak"),
]

CLASSICAL_MIP_GAP = 0.005
CLASSICAL_TIME_LIMIT_SECONDS = 60.0
WARMUP_SEED = 0

FIXED_PROFILE = FIXED_QUANTUM_PROFILE
