from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class BackendKind(str, Enum):
    CLASSICAL = "classical_highs"
    HYBRID = "hybrid_qaoa"


class StageState(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    WARNING = "warning"
    FAILED = "failed"


class GeneratorSpec(BaseModel):
    id: str
    name: str
    p_min: float
    p_max: float
    variable_cost: float
    no_load_cost: float
    startup_cost: float
    shutdown_cost: float = 0.0
    ramp_up: float
    ramp_down: float
    min_up_time: int = 1
    min_down_time: int = 1
    initial_status: int = 0
    initial_output: float = 0.0


class DatasetModel(BaseModel):
    id: str
    name: str
    description: str
    hours: list[int]
    demand: list[float]
    renewable: list[float]
    reserve: list[float]
    generators: list[GeneratorSpec]

    solar_available: list[float] = Field(default_factory=list)
    wind_available: list[float] = Field(default_factory=list)
    grid_import_limit_mw: float = 0.0
    initial_battery_soc_mwh: float = 0.0
    battery_capacity_mwh: float = 0.0
    battery_charge_limit_mw: float = 0.0
    battery_discharge_limit_mw: float = 0.0
    battery_charge_efficiency: float = 0.95
    battery_discharge_efficiency: float = 0.95
    grid_import_cost_per_mwh: float = 36.0
    battery_throughput_cost_per_mwh: float = 4.0


class ScenarioProfilesInput(BaseModel):
    demand_mw: list[float] = Field(min_length=24, max_length=24)
    solar_available_mw: list[float] = Field(min_length=24, max_length=24)
    wind_available_mw: list[float] = Field(min_length=24, max_length=24)


class ScenarioInput(BaseModel):
    contract_version: str | None = None
    scenario_id: str | None = None
    scenario_name: str | None = None
    profile_id: str | None = None
    profile_name: str | None = None
    profile_source: str | None = None
    horizon_hours: int = Field(default=24, ge=1)

    peak_demand_mw: float | None = Field(default=None, ge=0)
    solar_availability_mw: float | None = Field(default=None, ge=0)
    wind_availability_mw: float | None = Field(default=None, ge=0)
    grid_import_limit_mw: float | None = Field(default=None, ge=0)
    initial_battery_soc_mwh: float | None = Field(default=None, ge=0)
    initial_battery_soc_percent: float | None = Field(default=None, ge=0, le=100)
    battery_capacity_mwh: float | None = Field(default=None, ge=0)
    battery_charge_limit_mw: float | None = Field(default=None, ge=0)
    battery_discharge_limit_mw: float | None = Field(default=None, ge=0)
    profiles: ScenarioProfilesInput


class ClassicalConfig(BaseModel):
    mip_gap: float = Field(default=0.001, ge=0.0, le=0.25)
    time_limit_seconds: float = Field(default=60.0, gt=0.0, le=600.0)


class HybridConfig(BaseModel):
    qubit_budget: int = Field(default=10, ge=2, le=64)
    candidate_generators: int = Field(default=2, ge=1, le=64)
    candidate_hours: int = Field(default=5, ge=1, le=24)
    qaoa_depth: int = Field(default=1, ge=1, le=2)
    shots: int = Field(default=1000, ge=128, le=10000)
    optimizer_shots: int = Field(default=256, ge=64, le=4096)
    optimizer_evaluations: int = Field(default=20, ge=4, le=100)
    top_k: int = Field(default=10, ge=2, le=100)
    max_quantum_rounds: int = Field(default=3, ge=1, le=3)
    random_seed: int = 7
    quantum_target: str | None = None
    allow_numpy_fallback: bool = True
    rho_initial: float = Field(default=0.08, gt=0.0)
    rho_growth: float = Field(default=1.8, gt=1.0)
    rho_max: float = Field(default=2.0, gt=0.0)
    residual_tolerance_mw: float = Field(default=0.25, ge=0.0)
    residual_progress_ratio: float = Field(default=0.85, gt=0.0, le=1.0)
    deviation_weight: float = Field(default=0.15, ge=0.0)
    temporal_weight: float = Field(default=0.08, ge=0.0)
    score_weights: dict[str, float] = Field(
        default_factory=lambda: {
            "fractionality": 0.28,
            "residual": 0.24,
            "dual": 0.18,
            "cost": 0.12,
            "temporal": 0.10,
            "transition": 0.08,
        }
    )


class RunConfig(BaseModel):
    dataset_id: str = "default_10x24"
    run_mode: str = "comparison"
    scenario_input: ScenarioInput | None = None
    classical_config: ClassicalConfig = Field(default_factory=ClassicalConfig)
    hybrid_config: HybridConfig = Field(default_factory=HybridConfig)
    presentation_mode: bool = False
    presentation_delay_ms: int = 0


class StageEvent(BaseModel):
    stage: str
    state: StageState
    message: str
    timestamp: float
    details: dict[str, Any] = Field(default_factory=dict)


class CandidateScore(BaseModel):
    generator_id: str
    hour: int
    relaxed_value: float
    baseline_value: int
    fractionality_score: float
    residual_score: float
    dual_pressure_score: float
    cost_impact_score: float
    temporal_score: float
    transition_score: float
    final_score: float
    selected: bool = False


class CandidateBlock(BaseModel):
    generator_ids: list[str]
    hours: list[int]
    positions: list[tuple[str, int]]
    rationale: str
    block_score: float


class QUBOProblem(BaseModel):
    dimension: int
    offset: float
    linear: dict[str, float]
    quadratic: dict[str, float]
    variable_order: list[tuple[str, int]]
    penalty_weights: dict[str, float]
    metadata: dict[str, Any] = Field(default_factory=dict)


class IsingProblem(BaseModel):
    dimension: int
    offset: float
    linear_z: dict[str, float]
    quadratic_zz: dict[str, float]
    variable_order: list[tuple[str, int]]
    scale: float = 1.0


class CandidateBitstring(BaseModel):
    rank: int
    bitstring: str
    energy: float
    sample_count: int
    probability: float
    hamming_distance_from_incumbent: int
    source: str
    is_feasible: bool | None = None
    true_cost: float | None = None
    violation: str | None = None
    violation_count: int = 0
    weighted_violation: float = 0.0
    residual_norm_mw: float | None = None
    dispatch: list[dict[str, Any]] | None = None


class DispatchResult(BaseModel):
    feasible: bool
    total_cost: float
    total_variable_cost: float
    total_no_load_cost: float
    total_startup_cost: float
    total_grid_import_cost: float = 0.0
    total_battery_cost: float = 0.0
    total_curtailment_cost: float = 0.0
    total_grid_import_mwh: float = 0.0
    total_battery_discharge_mwh: float = 0.0
    total_battery_charge_mwh: float = 0.0
    total_renewable_curtailment_mwh: float = 0.0
    total_shortage_mwh: float = 0.0
    total_surplus_mwh: float = 0.0
    residual_l2_mw: float = 0.0
    residual: list[float] = Field(default_factory=list)
    shortage: list[float] = Field(default_factory=list)
    surplus: list[float] = Field(default_factory=list)
    hourly_dispatch: list[dict[str, Any]]
    violations: list[str] = Field(default_factory=list)
    structured_violations: list[dict[str, Any]] = Field(default_factory=list)
    solver: str = "highs"
    runtime_ms: float = 0.0
    mip_gap: float | None = None


class BackendResult(BaseModel):
    backend: BackendKind
    status: str
    mode_label: str
    best_energy: float | None = None
    candidates: list[CandidateBitstring]
    raw_payload: dict[str, Any] = Field(default_factory=dict)
    backend_runtime_ms: float = 0.0
    notes: list[str] = Field(default_factory=list)


class RunSummary(BaseModel):
    run_id: str
    status: str
    config: RunConfig
    dataset: DatasetModel
    stages: list[StageEvent]
    metrics: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] | None = None
    qubo: QUBOProblem | None = None
