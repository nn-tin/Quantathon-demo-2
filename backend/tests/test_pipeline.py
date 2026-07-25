from __future__ import annotations

import itertools

import pytest

from app.baseline.heuristic import build_baseline_schedule
from app.candidate_selection.block import select_candidate_block
from app.candidate_selection.scoring import score_candidates
from app.classical.full_uc import solve_full_uc_highs
from app.datasets.default_dataset import load_default_dataset
from app.dispatch.economic_dispatch import (
    solve_economic_dispatch,
    solve_relaxed_economic_dispatch,
)
from app.evaluation.reconstruct import reconstruct_schedule
from app.models.schemas import (
    ClassicalConfig,
    HybridConfig,
    RunConfig,
    ScenarioInput,
    ScenarioProfilesInput,
)
from app.preprocessing.preprocess import compute_relaxed_commitment
from app.qubo.builder import build_dynamic_qubo, evaluate_qubo_energy
from app.qubo.ising import evaluate_ising_energy, qubo_to_ising
from app.services.pipeline import PipelineService, apply_scenario_input


def _frontend_scenario() -> ScenarioInput:
    demand = [70,68,66,65,67,72,80,89,96,101,103,102,98,95,94,96,99,103,105,104,100,93,84,76]
    solar = [0,0,0,0,0,4,15,30,48,61,68,70,67,58,43,25,9,1,0,0,0,0,0,0]
    wind = [35,33,31,30,29,28,30,34,38,42,46,50,52,50,47,43,40,38,36,35,34,34,35,36]
    return ScenarioInput(
        contract_version="pil-hquc-scenario-input-v1",
        scenario_id="congestion",
        scenario_name="Grid Congestion",
        grid_import_limit_mw=60,
        initial_battery_soc_mwh=40,
        initial_battery_soc_percent=50,
        battery_capacity_mwh=80,
        profiles=ScenarioProfilesInput(
            demand_mw=demand,
            solar_available_mw=solar,
            wind_available_mw=wind,
        ),
    )


def _small_config(scenario_input=None) -> RunConfig:
    return RunConfig(
        scenario_input=scenario_input,
        classical_config=ClassicalConfig(time_limit_seconds=20),
        hybrid_config=HybridConfig(
            shots=128,
            optimizer_shots=64,
            optimizer_evaluations=4,
            top_k=4,
            max_quantum_rounds=2,
            quantum_target="qpp-cpu",
            allow_numpy_fallback=True,
        ),
    )


def _build_round_inputs(dataset=None):
    dataset = dataset or load_default_dataset()
    fractional = compute_relaxed_commitment(dataset)
    incumbent = build_baseline_schedule(dataset, fractional)
    dispatch = solve_relaxed_economic_dispatch(dataset, incumbent)
    dual = [0.0] * len(dataset.hours)
    scores = score_candidates(
        dataset,
        fractional,
        incumbent,
        dispatch,
        dual,
        HybridConfig().score_weights,
    )
    block = select_candidate_block(dataset, scores, 2, 5, 10)
    qubo = build_dynamic_qubo(
        dataset,
        incumbent,
        block,
        dispatch,
        dispatch.residual,
        dual,
        rho=0.08,
    )
    return dataset, fractional, incumbent, dispatch, dual, scores, block, qubo


def test_lp_fractionality_and_structured_block():
    dataset, fractional, _incumbent, _dispatch, _dual, scores, block, _qubo = _build_round_inputs()
    assert len(fractional) == 240
    assert any(1e-6 < value < 1 - 1e-6 for value in fractional.values())
    assert len(scores) == 240
    assert len(block.generator_ids) == 2
    assert len(block.hours) in {4, 5}
    assert 8 <= len(block.positions) <= 10
    assert block.hours == list(range(block.hours[0], block.hours[-1] + 1))


def test_residual_sign_convention_shortage_positive_surplus_negative():
    dataset = load_default_dataset()
    all_off = {(gen.id, hour): 0 for gen in dataset.generators for hour in dataset.hours}
    shortage_dispatch = solve_relaxed_economic_dispatch(dataset, all_off)
    assert any(value > 0 for value in shortage_dispatch.residual)
    assert all(
        residual == pytest.approx(shortage - surplus, abs=1e-6)
        for residual, shortage, surplus in zip(
            shortage_dispatch.residual,
            shortage_dispatch.shortage,
            shortage_dispatch.surplus,
        )
    )

    low_demand = dataset.model_copy(update={
        "demand": [1.0] * 24,
        "renewable": [0.0] * 24,
        "grid_import_limit_mw": 0.0,
        "battery_capacity_mwh": 0.0,
        "battery_charge_limit_mw": 0.0,
        "battery_discharge_limit_mw": 0.0,
    })
    all_on = {(gen.id, hour): 1 for gen in low_demand.generators for hour in low_demand.hours}
    surplus_dispatch = solve_relaxed_economic_dispatch(low_demand, all_on)
    assert any(value < 0 for value in surplus_dispatch.residual)


def test_qubo_ising_equivalence_for_every_state():
    *_prefix, qubo = _build_round_inputs()
    ising = qubo_to_ising(qubo)
    for bits in itertools.product("01", repeat=qubo.dimension):
        bitstring = "".join(bits)
        assert evaluate_qubo_energy(qubo, bitstring) == pytest.approx(
            evaluate_ising_energy(ising, bitstring), abs=1e-9
        )


def test_reconstruction_uses_absolute_bit_order():
    _dataset, _fractional, incumbent, _dispatch, _dual, _scores, block, qubo = _build_round_inputs()
    bitstring = "10" + "0" * (qubo.dimension - 2)
    reconstructed = reconstruct_schedule(incumbent, block, bitstring)
    assert reconstructed[block.positions[0]] == 1
    assert reconstructed[block.positions[1]] == 0
    for position, bit in zip(block.positions, bitstring):
        assert reconstructed[position] == int(bit)


def test_admm_update_changes_dynamic_qubo():
    dataset, _fractional, incumbent, dispatch, _dual, _scores, block, first = _build_round_inputs()
    dual = [0.5 * (index + 1) for index in range(24)]
    second = build_dynamic_qubo(
        dataset,
        incumbent,
        block,
        dispatch,
        dispatch.residual,
        dual,
        rho=0.16,
    )
    assert first.linear != second.linear or first.quadratic != second.quadratic
    assert first.penalty_weights["rho"] != second.penalty_weights["rho"]


def test_full_classical_baseline_solves_full_uc():
    result = solve_full_uc_highs(load_default_dataset(), time_limit_seconds=20)
    assert result.success
    assert len(result.schedule) == 240
    assert result.dispatch.feasible
    assert result.dispatch.solver == "scipy.optimize.milp/highs"
    assert result.dispatch.total_cost > 0


def test_frontend_profiles_are_applied_without_mutating_repository_dataset():
    base = load_default_dataset()
    scenario = _frontend_scenario()
    runtime = apply_scenario_input(base, scenario)
    assert runtime.demand == scenario.profiles.demand_mw
    assert runtime.solar_available == scenario.profiles.solar_available_mw
    assert runtime.wind_available == scenario.profiles.wind_available_mw
    assert runtime.renewable == [s + w for s, w in zip(scenario.profiles.solar_available_mw, scenario.profiles.wind_available_mw)]
    assert runtime.grid_import_limit_mw == 60
    assert runtime.initial_battery_soc_mwh == 40
    assert runtime.battery_capacity_mwh == 80
    assert runtime.battery_discharge_limit_mw == 20
    assert base.grid_import_limit_mw == 0


def test_one_request_returns_classical_and_hybrid_on_same_runtime_dataset():
    summary = PipelineService().execute_run(_small_config(_frontend_scenario()))
    assert summary.status.startswith("completed")
    assert summary.result is not None
    assert set(summary.result) >= {"classical", "hybrid", "recommended_plan", "comparison", "convergence"}
    assert summary.result["recommended_plan"]["id"] == "hybrid"
    assert summary.result["comparison"]["same_runtime_dataset"] is True
    assert summary.result["classical"]["dispatch"]["feasible"] is True
    assert summary.result["hybrid"]["round_count"] >= 1
    assert 8 <= summary.result["hybrid"]["active_qubits"] <= 10
    assert summary.metrics["runtime_peak_demand_mw"] == 105
    assert summary.metrics["runtime_grid_import_limit_mw"] == 60
    assert summary.qubo is not None
    assert summary.qubo.metadata["formulation"] == "admm_guided_dynamic_active_block"
