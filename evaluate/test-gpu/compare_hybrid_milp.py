from __future__ import annotations

import argparse
import csv
import json
import math
import os
import statistics
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = ROOT / "backend"
MAPPING_CSV = ROOT / "evaluate" / "test-gpu" / "generator-qubit-candidate-mapping.csv"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.models.schemas import ClassicalConfig, HybridConfig, RunConfig, ScenarioInput, ScenarioProfilesInput
from app.services.pipeline import PipelineService


@dataclass
class CaseResult:
    qubits: int
    instance: int
    supported_by_pipeline: bool
    milp_total_operating_cost: float
    hybrid_total_operating_cost: float
    optimality_gap_percent: float | None
    milp_feasible: bool
    hybrid_feasible: bool
    milp_renewable_curtailment_mwh: float
    hybrid_renewable_curtailment_mwh: float
    milp_runtime_ms: float
    hybrid_runtime_ms: float
    active_qubits: int | None
    hybrid_source: str | None
    hybrid_target: str | None
    fallback_reason: str | None
    error: str | None = None


@dataclass(frozen=True)
class MappingRow:
    total_generators: int
    qubit_budget: int
    candidate_generators: int
    candidate_hours: int
    qubits_used: int
    top_k: int


def load_env_value(env_path: Path, key: str) -> str | None:
    if not env_path.exists():
        return None
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() != key:
            continue
        value = value.strip().strip('"').strip("'")
        return value or None
    return None


def backend_base_url_from_env() -> str | None:
    env_path = ROOT / "frontend" / ".env"
    value = load_env_value(env_path, "VITE_API_BASE_URL")
    return value.rstrip("/") if value else None


def http_json(method: str, url: str, payload: dict[str, object] | None = None) -> dict[str, object]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=body,
        method=method,
        headers={
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    with urlopen(request, timeout=300) as response:
        text = response.read().decode("utf-8")
        return json.loads(text) if text else {}


def load_mapping_rows(csv_path: Path) -> list[MappingRow]:
    rows: list[MappingRow] = []
    with csv_path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for raw in reader:
            rows.append(
                MappingRow(
                    total_generators=int(raw["total_generators"]),
                    qubit_budget=int(raw["qubit_budget"]),
                    candidate_generators=int(raw["candidate_generators"]),
                    candidate_hours=int(raw["candidate_hours"]),
                    qubits_used=int(raw["qubits_used"]),
                    top_k=int(raw["top_k"]),
                )
            )
    return rows


def select_mapping_row(total_generators: int, requested_qubits: int, rows: list[MappingRow]) -> MappingRow | None:
    exact = [
        row for row in rows
        if row.total_generators == total_generators and row.qubit_budget == requested_qubits
    ]
    if exact:
        return exact[0]
    return None


def build_mock_profiles(qubits: int, instance: int) -> ScenarioProfilesInput:
    demand: list[float] = []
    solar: list[float] = []
    wind: list[float] = []
    base_demand = 118.0 + 2.6 * qubits + 1.9 * instance
    demand_swing = 18.0 + 0.75 * qubits
    solar_peak = 34.0 + 1.55 * qubits + 1.1 * instance
    wind_base = 12.0 + 0.65 * qubits

    for hour in range(24):
        demand_factor = (
            0.86
            + 0.19 * math.sin((hour - 6) * math.pi / 12.0)
            + (0.12 if 17 <= hour <= 21 else 0.0)
            - (0.07 if hour <= 4 else 0.0)
        )
        demand.append(round(max(65.0, base_demand + demand_swing * demand_factor), 3))

        sun_shape = max(0.0, math.sin((hour - 6) * math.pi / 12.0))
        solar.append(round(solar_peak * sun_shape, 3))

        wind_factor = 0.82 + 0.16 * math.sin((hour + instance) * math.pi / 8.0)
        wind.append(round(max(0.0, wind_base * wind_factor), 3))

    return ScenarioProfilesInput(
        demand_mw=demand,
        solar_available_mw=solar,
        wind_available_mw=wind,
    )


def build_mock_scenario_input(qubits: int, instance: int) -> ScenarioInput:
    profiles = build_mock_profiles(qubits, instance)
    battery_capacity = 72.0 + 1.4 * qubits
    grid_limit = 52.0 + 0.9 * qubits
    charge_limit = min(battery_capacity, 16.0 + 0.35 * qubits)
    discharge_limit = min(battery_capacity, 18.0 + 0.35 * qubits)
    return ScenarioInput(
        contract_version="pil-hquc-scenario-input-v1",
        scenario_id=f"mock-{qubits}q-{instance}",
        scenario_name=f"Mock Pipeline Scenario {qubits}Q #{instance}",
        profile_id=f"mock-profile-{qubits}-{instance}",
        profile_name=f"Mock 24h profile {qubits}Q #{instance}",
        profile_source="evaluate.compare_hybrid_milp",
        horizon_hours=24,
        peak_demand_mw=max(profiles.demand_mw),
        solar_availability_mw=max(profiles.solar_available_mw),
        wind_availability_mw=max(profiles.wind_available_mw),
        grid_import_limit_mw=round(grid_limit, 3),
        initial_battery_soc_mwh=round(0.52 * battery_capacity, 3),
        initial_battery_soc_percent=52.0,
        battery_capacity_mwh=round(battery_capacity, 3),
        battery_charge_limit_mw=round(charge_limit, 3),
        battery_discharge_limit_mw=round(discharge_limit, 3),
        profiles=profiles,
    )


def execute_pipeline_case(
    service: PipelineService,
    qubits: int,
    instance: int,
    mapping_rows: list[MappingRow],
    target: str,
    depth: int,
    shots: int,
    optimizer_shots: int,
    optimizer_evals: int,
    require_cudaq: bool,
    seed: int,
    mip_gap: float,
    time_limit: float,
) -> CaseResult:
    mapping = select_mapping_row(10, qubits, mapping_rows)
    if mapping is None:
        return CaseResult(
            qubits=qubits,
            instance=instance,
            supported_by_pipeline=False,
            milp_total_operating_cost=math.nan,
            hybrid_total_operating_cost=math.nan,
            optimality_gap_percent=None,
            milp_feasible=False,
            hybrid_feasible=False,
            milp_renewable_curtailment_mwh=math.nan,
            hybrid_renewable_curtailment_mwh=math.nan,
            milp_runtime_ms=math.nan,
            hybrid_runtime_ms=math.nan,
            active_qubits=None,
            hybrid_source=None,
            hybrid_target=None,
            fallback_reason=None,
            error="No matching row in generator-qubit-candidate-mapping.csv for total_generators=10 and requested qubits.",
        )

    config = RunConfig(
        dataset_id="default_10x24",
        classical_config=ClassicalConfig(
            mip_gap=mip_gap,
            time_limit_seconds=time_limit,
        ),
        hybrid_config=HybridConfig(
            qubit_budget=mapping.qubit_budget,
            candidate_generators=mapping.candidate_generators,
            candidate_hours=mapping.candidate_hours,
            qaoa_depth=depth,
            shots=shots,
            optimizer_shots=optimizer_shots,
            optimizer_evaluations=optimizer_evals,
            top_k=mapping.top_k,
            max_quantum_rounds=3,
            random_seed=seed,
            quantum_target=target,
            allow_numpy_fallback=not require_cudaq,
        ),
        scenario_input=build_mock_scenario_input(qubits, instance),
        presentation_mode=False,
        presentation_delay_ms=0,
    )

    summary = service.execute_run(config)
    classical = summary.result["classical"]
    hybrid = summary.result["hybrid"]
    comparison = summary.result["comparison"]
    selected = hybrid.get("selected_candidate", {})
    rounds = hybrid.get("quantum_rounds", [])
    final_backend = rounds[-1]["backend"] if rounds else {}
    fallback_reason = final_backend.get("raw_payload", {}).get("fallback_reason")
    return CaseResult(
        qubits=qubits,
        instance=instance,
        supported_by_pipeline=True,
        milp_total_operating_cost=float(classical["true_operating_cost"]),
        hybrid_total_operating_cost=float(hybrid["true_operating_cost"]),
        optimality_gap_percent=round(float(comparison["cost_gap_percent"]), 6),
        milp_feasible=bool(classical["feasible"]),
        hybrid_feasible=bool(hybrid["feasible"]),
        milp_renewable_curtailment_mwh=float(classical["total_renewable_curtailment_mwh"]),
        hybrid_renewable_curtailment_mwh=float(hybrid["total_renewable_curtailment_mwh"]),
        milp_runtime_ms=float(classical["runtime_ms"]),
        hybrid_runtime_ms=float(hybrid["runtime_ms"]),
        active_qubits=int(hybrid.get("active_qubits", mapping.qubits_used)),
        hybrid_source=str(hybrid.get("backend_source") or selected.get("source") or ""),
        hybrid_target=str(final_backend.get("raw_payload", {}).get("target", target)),
        fallback_reason=str(fallback_reason) if fallback_reason else None,
    )


def summarize(results: list[CaseResult]) -> list[dict[str, object]]:
    grouped: dict[int, list[CaseResult]] = {}
    for row in results:
        grouped.setdefault(row.qubits, []).append(row)

    summary_rows: list[dict[str, object]] = []
    for qubits in sorted(grouped):
        rows = grouped[qubits]
        valid = [row for row in rows if row.error is None]
        if not valid:
            summary_rows.append(
                {
                    "qubits": qubits,
                    "status": "all_failed",
                    "supported_by_pipeline": any(row.supported_by_pipeline for row in rows),
                }
            )
            continue
        gaps = [row.optimality_gap_percent for row in valid if row.optimality_gap_percent is not None]
        summary_rows.append(
            {
                "qubits": qubits,
                "instances": len(valid),
                "supported_by_pipeline": True,
                "active_qubits": sorted({row.active_qubits for row in valid if row.active_qubits is not None}),
                "milp_total_operating_cost_avg": round(statistics.mean(row.milp_total_operating_cost for row in valid), 6),
                "hybrid_total_operating_cost_avg": round(statistics.mean(row.hybrid_total_operating_cost for row in valid), 6),
                "optimality_gap_percent_avg": round(statistics.mean(gaps), 6) if gaps else None,
                "milp_feasibility_rate": round(sum(row.milp_feasible for row in valid) / len(valid), 6),
                "hybrid_feasibility_rate": round(sum(row.hybrid_feasible for row in valid) / len(valid), 6),
                "milp_renewable_curtailment_avg_mwh": round(
                    statistics.mean(row.milp_renewable_curtailment_mwh for row in valid), 6
                ),
                "hybrid_renewable_curtailment_avg_mwh": round(
                    statistics.mean(row.hybrid_renewable_curtailment_mwh for row in valid), 6
                ),
                "milp_runtime_avg_ms": round(statistics.mean(row.milp_runtime_ms for row in valid), 6),
                "hybrid_runtime_avg_ms": round(statistics.mean(row.hybrid_runtime_ms for row in valid), 6),
                "runtime_ratio_hybrid_over_milp": round(
                    statistics.mean(row.hybrid_runtime_ms for row in valid)
                    / max(statistics.mean(row.milp_runtime_ms for row in valid), 1e-9),
                    6,
                ),
                "hybrid_sources": sorted({row.hybrid_source for row in valid if row.hybrid_source}),
                "fallbacks": sum(1 for row in valid if row.fallback_reason),
            }
        )
    return summary_rows


def run_remote_backend_check(api_base_url: str) -> None:
    health_url = f"{api_base_url}/health"
    try:
        payload = http_json("GET", health_url)
    except HTTPError as exc:
        raise RuntimeError(f"Remote backend health check failed with HTTP {exc.code} at {health_url}.") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach remote backend at {health_url}: {exc.reason}") from exc
    status = str(payload.get("status", "")).lower()
    if status != "ok":
        raise RuntimeError(f"Remote backend health check returned unexpected payload: {payload}")


def print_remote_backend_limit(api_base_url: str) -> None:
    print(f"remote_backend={api_base_url}")
    print("remote_mode=env")
    print("")
    print("This script now mirrors the local PipelineService flow and reads qubit/candidate/top-k settings from the CSV mapping.")
    print("The same mock 24h scenario structure can be posted to /api/runs, and the backend now resolves candidate sizes")
    print("and top-k from the CSV mapping when a matching total_generators/qubit_budget row exists.")


def write_outputs(output_dir: Path, cases: list[CaseResult], summary_rows: list[dict[str, object]]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    cases_json = output_dir / "mock_hybrid_vs_milp_cases.json"
    summary_json = output_dir / "mock_hybrid_vs_milp_summary.json"
    summary_csv = output_dir / "mock_hybrid_vs_milp_summary.csv"
    summary_md = output_dir / "mock_hybrid_vs_milp_summary.md"

    cases_payload = [asdict(row) for row in cases]
    cases_json.write_text(json.dumps(cases_payload, indent=2), encoding="utf-8")
    summary_json.write_text(json.dumps(summary_rows, indent=2), encoding="utf-8")

    with summary_csv.open("w", newline="", encoding="utf-8") as handle:
        fieldnames = [
            "qubits",
            "instances",
            "supported_by_pipeline",
            "active_qubits",
            "milp_total_operating_cost_avg",
            "hybrid_total_operating_cost_avg",
            "optimality_gap_percent_avg",
            "milp_feasibility_rate",
            "hybrid_feasibility_rate",
            "milp_renewable_curtailment_avg_mwh",
            "hybrid_renewable_curtailment_avg_mwh",
            "milp_runtime_avg_ms",
            "hybrid_runtime_avg_ms",
            "runtime_ratio_hybrid_over_milp",
            "hybrid_sources",
            "fallbacks",
            "status",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in summary_rows:
            writer.writerow(row)

    lines = [
        "# Mock Hybrid vs MILP Comparison",
        "",
        "| Requested Qubits | Supported | Active Qubits | Instances | MILP Cost | Hybrid Cost | Gap % | MILP Feas. | Hybrid Feas. | MILP Curtail | Hybrid Curtail | MILP Runtime ms | Hybrid Runtime ms | Runtime Ratio | Source |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for row in summary_rows:
        if row.get("status") == "all_failed":
            supported = "yes" if row.get("supported_by_pipeline") else "no"
            lines.append(f"| {row['qubits']} | {supported} | - | 0 | - | - | - | - | - | - | - | - | - | - | failed |")
            continue
        lines.append(
            "| {qubits} | yes | {active_qubits} | {instances} | {milp_total_operating_cost_avg} | "
            "{hybrid_total_operating_cost_avg} | {optimality_gap_percent_avg} | "
            "{milp_feasibility_rate} | {hybrid_feasibility_rate} | "
            "{milp_renewable_curtailment_avg_mwh} | {hybrid_renewable_curtailment_avg_mwh} | "
            "{milp_runtime_avg_ms} | {hybrid_runtime_avg_ms} | {runtime_ratio_hybrid_over_milp} | {sources} |".format(
                qubits=row["qubits"],
                active_qubits=",".join(str(value) for value in row["active_qubits"]),
                instances=row["instances"],
                milp_total_operating_cost_avg=row["milp_total_operating_cost_avg"],
                hybrid_total_operating_cost_avg=row["hybrid_total_operating_cost_avg"],
                optimality_gap_percent_avg=row["optimality_gap_percent_avg"],
                milp_feasibility_rate=row["milp_feasibility_rate"],
                hybrid_feasibility_rate=row["hybrid_feasibility_rate"],
                milp_renewable_curtailment_avg_mwh=row["milp_renewable_curtailment_avg_mwh"],
                hybrid_renewable_curtailment_avg_mwh=row["hybrid_renewable_curtailment_avg_mwh"],
                milp_runtime_avg_ms=row["milp_runtime_avg_ms"],
                hybrid_runtime_avg_ms=row["hybrid_runtime_avg_ms"],
                runtime_ratio_hybrid_over_milp=row["runtime_ratio_hybrid_over_milp"],
                sources=",".join(row["hybrid_sources"]),
            )
        )
    summary_md.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare hybrid and MILP using the real backend pipeline.")
    parser.add_argument("--qubits", nargs="*", type=int, default=[8, 12, 16, 20, 24])
    parser.add_argument("--instances", type=int, default=3, help="Number of mock 24h scenarios per requested qubit size.")
    parser.add_argument("--target", default=os.getenv("CUDAQ_TARGET", "qpp-cpu"))
    parser.add_argument("--depth", type=int, default=1)
    parser.add_argument("--shots", type=int, default=256)
    parser.add_argument("--optimizer-shots", type=int, default=128)
    parser.add_argument("--optimizer-evals", type=int, default=8)
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--mip-gap", type=float, default=0.001)
    parser.add_argument("--time-limit", type=float, default=60.0)
    parser.add_argument("--output-dir", default=str(ROOT / "evaluate" / "test-gpu" / "results"))
    parser.add_argument("--require-cudaq", action="store_true")
    parser.add_argument(
        "--execution-mode",
        choices=["local", "env-remote"],
        default="local",
        help="Use local in-process pipeline code, or only verify the remote backend configured in frontend/.env.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.execution_mode == "env-remote":
        api_base_url = backend_base_url_from_env()
        if not api_base_url:
            print("frontend/.env does not contain VITE_API_BASE_URL.")
            return 1
        try:
            run_remote_backend_check(api_base_url)
        except Exception as exc:
            print(f"remote backend error: {type(exc).__name__}: {exc}")
            return 1
        print_remote_backend_limit(api_base_url)
        return 0

    if args.require_cudaq:
        os.environ["REQUIRE_CUDAQ"] = "1"
    os.environ.setdefault("CUDAQ_TARGET", args.target)

    print("Pipeline-aligned mock comparison: hybrid vs MILP")
    print(f"requested_target={args.target}")
    print(f"requested_qubits={args.qubits}")
    print(f"instances_per_qubit={args.instances}")
    print(f"mapping_csv={MAPPING_CSV}")
    print("")

    service = PipelineService()
    mapping_rows = load_mapping_rows(MAPPING_CSV)
    cases: list[CaseResult] = []
    for qubits in args.qubits:
        for instance in range(1, args.instances + 1):
            try:
                row = execute_pipeline_case(
                    service=service,
                    qubits=qubits,
                    instance=instance,
                    mapping_rows=mapping_rows,
                    target=args.target,
                    depth=args.depth,
                    shots=args.shots,
                    optimizer_shots=args.optimizer_shots,
                    optimizer_evals=args.optimizer_evals,
                    require_cudaq=args.require_cudaq,
                    seed=args.seed + 97 * instance + qubits,
                    mip_gap=args.mip_gap,
                    time_limit=args.time_limit,
                )
            except Exception as exc:
                row = CaseResult(
                    qubits=qubits,
                    instance=instance,
                    supported_by_pipeline=select_mapping_row(10, qubits, mapping_rows) is not None,
                    milp_total_operating_cost=math.nan,
                    hybrid_total_operating_cost=math.nan,
                    optimality_gap_percent=None,
                    milp_feasible=False,
                    hybrid_feasible=False,
                    milp_renewable_curtailment_mwh=math.nan,
                    hybrid_renewable_curtailment_mwh=math.nan,
                    milp_runtime_ms=math.nan,
                    hybrid_runtime_ms=math.nan,
                    active_qubits=None,
                    hybrid_source=None,
                    hybrid_target=args.target,
                    fallback_reason=None,
                    error=f"{type(exc).__name__}: {exc}",
                )
            cases.append(row)
            if row.error is None:
                print(
                    f"{qubits:>2} qubits | instance={instance} | "
                    f"active_qubits={row.active_qubits} | "
                    f"MILP cost={row.milp_total_operating_cost:.3f} | "
                    f"Hybrid cost={row.hybrid_total_operating_cost:.3f} | "
                    f"gap={row.optimality_gap_percent} | "
                    f"hybrid_feasible={row.hybrid_feasible} | "
                    f"source={row.hybrid_source}"
                )
            else:
                print(f"{qubits:>2} qubits | instance={instance} | ERROR | {row.error}")

    summary_rows = summarize(cases)
    write_outputs(Path(args.output_dir), cases, summary_rows)

    print("")
    print("Summary")
    for row in summary_rows:
        if row.get("status") == "all_failed":
            print(f"{row['qubits']:>2} qubits | all_failed | supported={row.get('supported_by_pipeline')}")
            continue
        print(
            f"{row['qubits']:>2} qubits | active_qubits={row['active_qubits']} | instances={row['instances']} | "
            f"milp_cost={row['milp_total_operating_cost_avg']} | hybrid_cost={row['hybrid_total_operating_cost_avg']} | "
            f"gap={row['optimality_gap_percent_avg']} | hybrid_feas={row['hybrid_feasibility_rate']} | "
            f"milp_runtime_ms={row['milp_runtime_avg_ms']} | "
            f"hybrid_runtime_ms={row['hybrid_runtime_avg_ms']} | "
            f"runtime_ratio={row['runtime_ratio_hybrid_over_milp']}"
        )
    print("")
    print(f"results_dir={args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
