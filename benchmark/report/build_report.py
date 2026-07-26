from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd

from app.config.quantum_profile import FIXED_QUANTUM_PROFILE
from benchmark.config import GENERATOR_COUNTS, GENERATOR_SCALING_QUBITS, QUBIT_BUDGETS


SUMMARY_COLUMNS = [
    "cost_gap_percent",
    "hybrid_feasible",
    "milp_feasible",
    "milp_runtime_ms",
    "hybrid_runtime_ms",
    "qaoa_runtime_ms",
    "candidate_validation_runtime_ms",
    "round_count",
]


def _read_json(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, list) else []


def _summary(
    records: list[dict[str, Any]],
    group_columns: list[str],
) -> pd.DataFrame:
    if not records:
        return pd.DataFrame()
    frame = pd.DataFrame(records)
    available = [column for column in SUMMARY_COLUMNS if column in frame]
    aggregation: dict[str, list[str]] = {
        column: ["mean", "median", "std"]
        for column in available
        if column not in {"hybrid_feasible", "milp_feasible"}
    }
    for column in ("hybrid_feasible", "milp_feasible"):
        if column in frame:
            aggregation[column] = ["mean"]
    summary = frame.groupby(group_columns, dropna=False).agg(aggregation).reset_index()
    summary.columns = [
        "_".join(part for part in column if part).rstrip("_")
        if isinstance(column, tuple)
        else str(column)
        for column in summary.columns
    ]
    return summary


def _save_plot(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    plt.tight_layout()
    plt.savefig(path, dpi=160, bbox_inches="tight")
    plt.close()


def _plot_method(summary: pd.DataFrame, figures: Path) -> list[str]:
    outputs: list[str] = []
    if summary.empty:
        return outputs
    x = range(len(summary))
    plt.figure(figsize=(9, 4.5))
    plt.bar(x, summary["cost_gap_percent_mean"])
    plt.xticks(x, summary["case_id"], rotation=25, ha="right")
    plt.ylabel("Mean Hybrid–MILP cost gap (%)")
    plt.xlabel("SimBench-derived case")
    plt.title("Benchmark 1 — Method comparison")
    path = figures / "method_comparison_gap.png"
    _save_plot(path)
    outputs.append(path.name)

    plt.figure(figsize=(9, 4.5))
    plt.plot(x, summary["milp_runtime_ms_mean"], marker="o", label="MILP")
    plt.plot(x, summary["hybrid_runtime_ms_mean"], marker="o", label="Hybrid end-to-end")
    plt.xticks(x, summary["case_id"], rotation=25, ha="right")
    plt.ylabel("Runtime (ms)")
    plt.xlabel("SimBench-derived case")
    plt.title("Method runtime on the same case")
    plt.legend()
    path = figures / "method_comparison_runtime.png"
    _save_plot(path)
    outputs.append(path.name)
    return outputs


def _plot_qubit(summary: pd.DataFrame, figures: Path) -> list[str]:
    outputs: list[str] = []
    if summary.empty:
        return outputs
    summary = summary.sort_values("requested_qubits")
    plt.figure(figsize=(8, 4.5))
    plt.plot(summary["requested_qubits"], summary["cost_gap_percent_mean"], marker="o")
    plt.xlabel("Active qubits")
    plt.ylabel("Mean cost gap (%)")
    plt.title("Benchmark 2 — Qubit sufficiency")
    path = figures / "qubit_scaling_gap.png"
    _save_plot(path)
    outputs.append(path.name)

    plt.figure(figsize=(8, 4.5))
    plt.plot(summary["requested_qubits"], summary["qaoa_runtime_ms_mean"], marker="o", label="QAOA")
    plt.plot(summary["requested_qubits"], summary["hybrid_runtime_ms_mean"], marker="o", label="Hybrid end-to-end")
    plt.xlabel("Active qubits")
    plt.ylabel("Runtime (ms)")
    plt.yscale("log")
    plt.title("Qubit scaling runtime (log scale)")
    plt.legend()
    path = figures / "qubit_scaling_runtime.png"
    _save_plot(path)
    outputs.append(path.name)
    return outputs


def _plot_generator(summary: pd.DataFrame, figures: Path) -> list[str]:
    outputs: list[str] = []
    if summary.empty:
        return outputs
    plt.figure(figsize=(8, 4.5))
    for qubits, group in summary.groupby("requested_qubits"):
        group = group.sort_values("generator_count")
        plt.plot(group["generator_count"], group["cost_gap_percent_mean"], marker="o", label=f"q={qubits}")
    plt.xlabel("Number of generators")
    plt.ylabel("Mean cost gap (%)")
    plt.title("Benchmark 3 — Generator scaling quality")
    plt.legend()
    path = figures / "generator_scaling_gap.png"
    _save_plot(path)
    outputs.append(path.name)

    plt.figure(figsize=(8, 4.5))
    for qubits, group in summary.groupby("requested_qubits"):
        group = group.sort_values("generator_count")
        plt.plot(group["generator_count"], group["hybrid_runtime_ms_mean"], marker="o", label=f"q={qubits}")
    plt.xlabel("Number of generators")
    plt.ylabel("Hybrid end-to-end runtime (ms)")
    plt.title("Generator scaling runtime")
    plt.legend()
    path = figures / "generator_scaling_runtime.png"
    _save_plot(path)
    outputs.append(path.name)
    return outputs


def _table(frame: pd.DataFrame) -> str:
    if frame.empty:
        return '<p class="empty">No records were generated for this experiment.</p>'
    display = frame.copy()
    for column in display.columns:
        if pd.api.types.is_float_dtype(display[column]):
            display[column] = display[column].round(4)
    return display.to_html(index=False, border=0, classes="results-table")


def _image_tags(names: list[str]) -> str:
    return "".join(
        f'<figure><img src="../results/figures/{html.escape(name)}" alt="Benchmark figure"><figcaption>{html.escape(name)}</figcaption></figure>'
        for name in names
    )


def build_report(root: Path) -> Path:
    raw_dir = root / "benchmark" / "results" / "raw"
    summary_dir = root / "benchmark" / "results" / "summary"
    figures_dir = root / "benchmark" / "results" / "figures"
    report_dir = root / "benchmark" / "report"
    summary_dir.mkdir(parents=True, exist_ok=True)
    figures_dir.mkdir(parents=True, exist_ok=True)
    report_dir.mkdir(parents=True, exist_ok=True)

    method_records = _read_json(raw_dir / "simbench_method_comparison.json")
    qubit_records = _read_json(raw_dir / "qubit_budget_scaling.json")
    generator_records = _read_json(raw_dir / "generator_scaling.json")

    method_summary = _summary(method_records, ["case_id", "generator_count", "top_k"])
    qubit_summary = _summary(qubit_records, ["requested_qubits", "actual_active_qubits", "top_k"])
    generator_summary = _summary(generator_records, ["generator_count", "requested_qubits", "top_k"])

    method_summary.to_csv(summary_dir / "simbench_method_comparison_summary.csv", index=False)
    qubit_summary.to_csv(summary_dir / "qubit_budget_scaling_summary.csv", index=False)
    generator_summary.to_csv(summary_dir / "generator_scaling_summary.csv", index=False)

    method_figures = _plot_method(method_summary, figures_dir)
    qubit_figures = _plot_qubit(qubit_summary, figures_dir)
    generator_figures = _plot_generator(generator_summary, figures_dir)

    environment_path = raw_dir / "environment.json"
    environment = json.loads(environment_path.read_text(encoding="utf-8")) if environment_path.exists() else {}
    profile = FIXED_QUANTUM_PROFILE

    all_records = method_records + qubit_records + generator_records
    feasible_rate = (
        100.0 * sum(bool(row.get("hybrid_feasible")) for row in all_records) / len(all_records)
        if all_records
        else 0.0
    )
    finite_gaps = [
        float(row["cost_gap_percent"])
        for row in all_records
        if row.get("cost_gap_percent") is not None
    ]
    mean_gap = sum(finite_gaps) / len(finite_gaps) if finite_gaps else 0.0

    content = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PiL-HQUC Benchmark Report</title>
<style>
:root {{ color-scheme: dark; --bg:#07111f; --panel:#0d1b2c; --line:#20344d; --text:#e9f2ff; --muted:#9fb2c8; --accent:#63e6be; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; font:15px/1.55 Inter,system-ui,sans-serif; background:var(--bg); color:var(--text); }}
main {{ width:min(1240px,94vw); margin:32px auto 80px; }}
header,section {{ background:var(--panel); border:1px solid var(--line); border-radius:18px; padding:24px; margin-bottom:20px; }}
h1,h2,h3 {{ margin-top:0; }}
p,li {{ color:var(--muted); }}
.kpis {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }}
.kpi {{ border:1px solid var(--line); border-radius:14px; padding:16px; }}
.kpi strong {{ display:block; color:var(--accent); font-size:24px; }}
figure {{ margin:18px 0; }}
img {{ width:100%; max-width:900px; background:white; border-radius:12px; }}
figcaption {{ color:var(--muted); font-size:12px; }}
.table-wrap {{ overflow:auto; }}
.results-table {{ width:100%; border-collapse:collapse; font-size:12px; }}
.results-table th,.results-table td {{ border-bottom:1px solid var(--line); padding:8px 10px; text-align:right; white-space:nowrap; }}
.results-table th:first-child,.results-table td:first-child {{ text-align:left; }}
code {{ color:var(--accent); }}
.empty {{ padding:18px; border:1px dashed var(--line); border-radius:12px; }}
</style>
</head>
<body><main>
<header>
<h1>PiL-HQUC Offline Benchmark Report</h1>
<p>The localhost application remains a GPU Hybrid-only operational demo. This report contains the separated Classical comparison and scaling evidence.</p>
<div class="kpis">
<div class="kpi"><span>Total measured Hybrid runs</span><strong>{len(all_records)}</strong></div>
<div class="kpi"><span>Hybrid feasibility rate</span><strong>{feasible_rate:.1f}%</strong></div>
<div class="kpi"><span>Mean cost gap</span><strong>{mean_gap:.3f}%</strong></div>
<div class="kpi"><span>Validated qubit range</span><strong>8–26</strong></div>
</div>
</header>
<section>
<h2>Fixed quantum protocol</h2>
<ul>
<li>Qamomile → CUDA-Q, target <code>nvidia</code>, GPU required.</li>
<li>QAOA depth: {profile.qaoa_depth}; final shots: {profile.shots}; optimizer fallback shots: {profile.optimizer_shots}.</li>
<li>COBYLA objective evaluations: {profile.optimizer_evaluations}; maximum ADMM-guided rounds: {profile.max_quantum_rounds}.</li>
<li>Top-K is fixed within qubit scaling and increases with generator count in method/generator scaling.</li>
<li>One in-process GPU warm-up is discarded; all optimizer evaluations and candidate validation remain inside measured runtime.</li>
</ul>
<pre>{html.escape(json.dumps(environment, indent=2))}</pre>
</section>
<section>
<h2>Benchmark 1 — SimBench-derived Hybrid vs Classical</h2>
<p>SimBench annual demand and renewable profiles are converted into aggregated single-bus 24-hour UC cases. The full MILP and Hybrid method solve the same converted case.</p>
{_image_tags(method_figures)}
<div class="table-wrap">{_table(method_summary)}</div>
</section>
<section>
<h2>Benchmark 2 — Active-qubit budget scaling</h2>
<p>A fixed synthetic 10-generator, 24-hour UC instance is reused at q={QUBIT_BUDGETS}. Top-K stays constant so the active-qubit budget is the controlled variable.</p>
{_image_tags(qubit_figures)}
<div class="table-wrap">{_table(qubit_summary)}</div>
</section>
<section>
<h2>Benchmark 3 — Generator scaling</h2>
<p>Capacity-normalized synthetic systems use generator counts {GENERATOR_COUNTS} and two fixed active budgets {GENERATOR_SCALING_QUBITS}. Top-K grows with generator count and is identical for q=10 and q=20 at each system size.</p>
{_image_tags(generator_figures)}
<div class="table-wrap">{_table(generator_summary)}</div>
</section>
</main></body></html>"""

    report_path = report_dir / "benchmark_report.html"
    report_path.write_text(content, encoding="utf-8")
    return report_path
