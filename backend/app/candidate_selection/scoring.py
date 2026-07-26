from __future__ import annotations

from app.models.schemas import CandidateScore, DatasetModel, DispatchResult


def _normalize(values: list[float]) -> list[float]:
    if not values: return []
    lo, hi = min(values), max(values)
    if hi - lo < 1e-12: return [0.0 for _ in values]
    return [(value - lo) / (hi - lo) for value in values]


def score_candidates(
    dataset: DatasetModel,
    relaxed: dict[tuple[str, int], float],
    incumbent: dict[tuple[str, int], int],
    dispatch: DispatchResult,
    dual: list[float],
    score_weights: dict[str, float],
) -> list[CandidateScore]:
    rows: list[dict[str, float | str | int]] = []
    max_cost = max((g.variable_cost for g in dataset.generators), default=1.0)
    max_abs_residual = max((abs(v) for v in dispatch.residual), default=1.0) or 1.0
    max_abs_dual = max((abs(v) for v in dual), default=1.0) or 1.0

    for gen in dataset.generators:
        flexibility = (gen.ramp_up + gen.ramp_down) / max(2.0 * gen.p_max, 1.0)
        for t, hour in enumerate(dataset.hours):
            x = float(relaxed[(gen.id, hour)])
            u = int(incumbent[(gen.id, hour)])
            residual = float(dispatch.residual[t]) if t < len(dispatch.residual) else 0.0
            transition = 0.0
            prev = gen.initial_status if t == 0 else incumbent[(gen.id, dataset.hours[t - 1])]
            nxt = u if t == len(dataset.hours) - 1 else incumbent[(gen.id, dataset.hours[t + 1])]
            if prev != u or nxt != u: transition = 1.0
            temporal = 1.0 if abs(residual) >= 0.6 * max_abs_residual else 0.35
            cost_impact = (gen.variable_cost / max_cost) * (0.65 if u else 1.0) + 0.35 * flexibility
            rows.append({
                "generator_id": gen.id,
                "hour": hour,
                "relaxed": x,
                "baseline": u,
                "fractionality": 4.0 * x * (1.0 - x),
                "residual": abs(residual) / max_abs_residual,
                "dual": abs(dual[t]) / max_abs_dual if t < len(dual) else 0.0,
                "cost": cost_impact,
                "temporal": temporal,
                "transition": transition,
            })

    for key in ("fractionality", "residual", "dual", "cost", "temporal", "transition"):
        norm = _normalize([float(row[key]) for row in rows])
        for row, value in zip(rows, norm): row[key + "_norm"] = value

    result: list[CandidateScore] = []
    for row in rows:
        final = sum(float(score_weights.get(k, 0.0)) * float(row[k + "_norm"]) for k in score_weights)
        result.append(CandidateScore(
            generator_id=str(row["generator_id"]),
            hour=int(row["hour"]),
            relaxed_value=float(row["relaxed"]),
            baseline_value=int(row["baseline"]),
            fractionality_score=float(row["fractionality_norm"]),
            residual_score=float(row["residual_norm"]),
            dual_pressure_score=float(row["dual_norm"]),
            cost_impact_score=float(row["cost_norm"]),
            temporal_score=float(row["temporal_norm"]),
            transition_score=float(row["transition_norm"]),
            final_score=round(final, 8),
        ))
    return result
