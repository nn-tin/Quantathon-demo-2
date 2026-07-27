from __future__ import annotations

from types import SimpleNamespace

from benchmark.experiments import generator_scaling, qubit_budget_scaling


CLASSICAL = {
    "milp_success": True,
    "milp_feasible": True,
    "milp_cost": 100.0,
    "milp_runtime_ms": 5.0,
    "milp_gap": 0.0,
    "milp_message": "ok",
}


def _hybrid_result(qubit_budget: int, top_k: int) -> dict[str, object]:
    return {
        "hybrid_feasible": True,
        "hybrid_cost": 101.0,
        "hybrid_runtime_ms": 20.0,
        "qaoa_runtime_ms": 10.0,
        "candidate_validation_runtime_ms": 4.0,
        "lp_preprocessing_runtime_ms": 1.0,
        "round_count": 1,
        "requested_qubits": qubit_budget,
        "actual_active_qubits": qubit_budget,
        "top_k": top_k,
        "unique_bitstrings": top_k,
        "selected_bitstring": "0" * qubit_budget,
        "selected_energy": 0.0,
        "backend_source": "test",
        "quantum_target": "nvidia",
        "execution_device": "gpu",
        "execution_backend": "cudaq",
        "candidate_generators": 1,
        "candidate_hours": qubit_budget,
        "extra_positions": 0,
    }


def test_qubit_scaling_discards_one_first_run_per_qubit(monkeypatch):
    dataset = SimpleNamespace(id="ieee30_double-peak_10g")
    warmup_calls: list[str] = []
    measured_calls: list[tuple[int, int]] = []

    monkeypatch.setattr(qubit_budget_scaling, "build_ieee30_dataset", lambda *a, **k: dataset)
    monkeypatch.setattr(qubit_budget_scaling, "run_classical_case", lambda _d: dict(CLASSICAL))
    monkeypatch.setattr(qubit_budget_scaling, "print_case", lambda _r: None)

    def fake_warmup(_service, _dataset, **kwargs):
        warmup_calls.append(kwargs["configuration_id"])
        return {
            "configuration_id": kwargs["configuration_id"],
            "hybrid_runtime_ms": 99.0,
            "requested_qubits": kwargs["qubit_budget"],
            "top_k": kwargs["top_k"],
        }

    def fake_measured(_service, _dataset, **kwargs):
        measured_calls.append((kwargs["qubit_budget"], kwargs["seed"]))
        return _hybrid_result(kwargs["qubit_budget"], kwargs["top_k"])

    monkeypatch.setattr(qubit_budget_scaling, "warmup_hybrid_configuration", fake_warmup)
    monkeypatch.setattr(qubit_budget_scaling, "run_hybrid_case", fake_measured)

    discarded: list[dict[str, object]] = []
    records = qubit_budget_scaling.run(
        object(),
        seeds=[11, 23],
        qubit_budgets=[8, 10],
        warmup_records=discarded,
    )

    assert len(warmup_calls) == 2
    assert len(discarded) == 2
    assert len(measured_calls) == 4
    assert len(records) == 4
    assert all(row["warmup_included_in_statistics"] is False for row in records)


def test_generator_scaling_discards_one_first_run_per_g_q(monkeypatch):
    warmup_calls: list[str] = []
    measured_calls: list[tuple[int, int, int]] = []

    def fake_dataset(_scenario_id: str, *, generator_count: int, **_kwargs):
        return SimpleNamespace(id=f"ieee30_double-peak_{generator_count}g")

    monkeypatch.setattr(generator_scaling, "build_ieee30_dataset", fake_dataset)
    monkeypatch.setattr(generator_scaling, "run_classical_case", lambda _d: dict(CLASSICAL))
    monkeypatch.setattr(generator_scaling, "print_case", lambda _r: None)

    def fake_warmup(_service, _dataset, **kwargs):
        warmup_calls.append(kwargs["configuration_id"])
        return {
            "configuration_id": kwargs["configuration_id"],
            "hybrid_runtime_ms": 99.0,
            "requested_qubits": kwargs["qubit_budget"],
            "top_k": kwargs["top_k"],
        }

    def fake_measured(_service, dataset, **kwargs):
        generator_count = int(dataset.id.rsplit("_", 1)[1][:-1])
        measured_calls.append((generator_count, kwargs["qubit_budget"], kwargs["seed"]))
        return _hybrid_result(kwargs["qubit_budget"], kwargs["top_k"])

    monkeypatch.setattr(generator_scaling, "warmup_hybrid_configuration", fake_warmup)
    monkeypatch.setattr(generator_scaling, "run_hybrid_case", fake_measured)

    discarded: list[dict[str, object]] = []
    records = generator_scaling.run(
        object(),
        seeds=[11],
        generator_counts=[10, 20],
        qubit_budgets=[10, 20],
        warmup_records=discarded,
    )

    assert len(warmup_calls) == 4
    assert len(discarded) == 4
    assert len(measured_calls) == 4
    assert len(records) == 4
    assert all(row["warmup_runs_for_configuration"] == 1 for row in records)
