from __future__ import annotations

from collections import defaultdict

from app.models.schemas import CandidateBlock, DatasetModel, DispatchResult, QUBOProblem


def _add_linear(linear: dict[str, float], i: int, value: float) -> None:
    key = str(i)
    linear[key] = linear.get(key, 0.0) + float(value)


def _add_quadratic(quadratic: dict[str, float], i: int, j: int, value: float) -> None:
    if i == j:
        raise ValueError("Diagonal QUBO coefficients belong in the linear dictionary.")
    a, b = sorted((i, j))
    key = f"{a},{b}"
    quadratic[key] = quadratic.get(key, 0.0) + float(value)


def build_dynamic_qubo(
    dataset: DatasetModel,
    incumbent: dict[tuple[str, int], int],
    block: CandidateBlock,
    dispatch: DispatchResult,
    residual: list[float],
    dual: list[float],
    rho: float,
    *,
    deviation_weight: float = 0.15,
    temporal_weight: float = 0.08,
) -> QUBOProblem:
    """Build the ADMM-guided active-block QUBO for one outer round.

    Active variables are absolute commitment values q_i, not flip flags.
    The predicted residual is linearized around the incumbent:
        r_t(q) = r_t - sum_i A_ti (q_i - u_i).
    """
    variable_order = list(block.positions)
    n = len(variable_order)
    if n <= 0:
        raise ValueError("Active block must contain at least one variable.")
    index = {position: i for i, position in enumerate(variable_order)}
    gen_map = {generator.id: generator for generator in dataset.generators}
    hour_index = {hour: t for t, hour in enumerate(dataset.hours)}
    dispatch_by_hour = {int(row["hour"]): row for row in dispatch.hourly_dispatch}

    offset = 0.0
    linear: dict[str, float] = {str(i): 0.0 for i in range(n)}
    quadratic: dict[str, float] = {}

    effective_capacity: dict[tuple[int, int], float] = {}
    per_hour_active: dict[int, list[int]] = defaultdict(list)
    for i, (generator_id, hour) in enumerate(variable_order):
        generator = gen_map[generator_id]
        t = hour_index[hour]
        row = dispatch_by_hour.get(hour, {})
        outputs = row.get("generator_output_mw", {}) or {}
        actual = float(outputs.get(generator_id, 0.0))
        hour_residual = max(0.0, float(residual[t])) if t < len(residual) else 0.0
        incumbent_value = int(incumbent[(generator_id, hour)])
        if incumbent_value:
            capacity = max(float(generator.p_min), actual)
        else:
            active_count = max(1, sum(1 for position in variable_order if position[1] == hour))
            capacity = min(
                float(generator.p_max),
                max(float(generator.p_min), hour_residual / active_count + float(generator.p_min)),
            )
        effective_capacity[(t, i)] = capacity
        per_hour_active[t].append(i)

        expected_output = max(float(generator.p_min), min(float(generator.p_max), capacity))
        economic = float(generator.no_load_cost) + 0.35 * float(generator.variable_cost) * expected_output
        _add_linear(linear, i, economic)

        if incumbent_value == 0:
            _add_linear(linear, i, deviation_weight)
        else:
            offset += deviation_weight
            _add_linear(linear, i, -deviation_weight)

    for generator_id in block.generator_ids:
        generator = gen_map[generator_id]
        active_hours = sorted(hour for gid, hour in variable_order if gid == generator_id)
        active_set = set(active_hours)
        for hour in active_hours:
            i = index[(generator_id, hour)]
            previous_hour = hour - 1
            if previous_hour in active_set:
                j = index[(generator_id, previous_hour)]
                _add_linear(linear, i, generator.startup_cost)
                _add_linear(linear, j, generator.shutdown_cost)
                _add_quadratic(quadratic, i, j, -(generator.startup_cost + generator.shutdown_cost))
            else:
                previous = generator.initial_status if hour == dataset.hours[0] else incumbent[(generator_id, previous_hour)]
                offset += generator.shutdown_cost * previous
                _add_linear(
                    linear,
                    i,
                    generator.startup_cost * (1 - previous) - generator.shutdown_cost * previous,
                )

        last_hour = active_hours[-1]
        if last_hour < dataset.hours[-1]:
            i = index[(generator_id, last_hour)]
            next_value = incumbent[(generator_id, last_hour + 1)]
            offset += generator.startup_cost * next_value
            _add_linear(
                linear,
                i,
                -generator.startup_cost * next_value + generator.shutdown_cost * (1 - next_value),
            )

        for left, right in zip(active_hours, active_hours[1:]):
            if right != left + 1:
                continue
            i, j = index[(generator_id, left)], index[(generator_id, right)]
            _add_linear(linear, i, temporal_weight)
            _add_linear(linear, j, temporal_weight)
            _add_quadratic(quadratic, i, j, -2.0 * temporal_weight)

    predicted_constants: dict[int, float] = {}
    for t, _hour in enumerate(dataset.hours):
        active_indices = per_hour_active.get(t, [])
        if not active_indices:
            continue
        constant = float(residual[t])
        for i in active_indices:
            generator_id, active_hour = variable_order[i]
            constant += effective_capacity[(t, i)] * incumbent[(generator_id, active_hour)]
        predicted_constants[t] = constant
        lam = float(dual[t]) if t < len(dual) else 0.0
        offset += lam * constant + 0.5 * rho * constant * constant
        for i in active_indices:
            capacity = effective_capacity[(t, i)]
            _add_linear(linear, i, -lam * capacity - rho * constant * capacity + 0.5 * rho * capacity * capacity)
        for pos, i in enumerate(active_indices):
            for j in active_indices[pos + 1:]:
                _add_quadratic(quadratic, i, j, rho * effective_capacity[(t, i)] * effective_capacity[(t, j)])

    coefficient_scale = max(
        [abs(value) for value in linear.values()] +
        [abs(value) for value in quadratic.values()] + [1e-9]
    )
    normalized_linear = {key: value / coefficient_scale for key, value in linear.items()}
    normalized_quadratic = {
        key: value / coefficient_scale
        for key, value in quadratic.items()
        if abs(value) > 1e-12
    }
    normalized_offset = offset / coefficient_scale

    return QUBOProblem(
        dimension=n,
        offset=normalized_offset,
        linear=normalized_linear,
        quadratic=normalized_quadratic,
        variable_order=variable_order,
        penalty_weights={
            "rho": rho,
            "deviation": deviation_weight,
            "temporal": temporal_weight,
        },
        metadata={
            "formulation": "admm_guided_dynamic_active_block",
            "residual_convention": "shortage_minus_surplus",
            "coefficient_scale": coefficient_scale,
            "raw_offset": offset,
            "raw_linear": linear,
            "raw_quadratic": quadratic,
            "dual": list(dual),
            "residual": list(residual),
            "predicted_residual_constants": predicted_constants,
            "effective_capacity": {
                f"{t},{i}": value for (t, i), value in effective_capacity.items()
            },
            "incumbent_bitstring": "".join(str(incumbent[position]) for position in variable_order),
        },
    )


def build_qubo(*args, **kwargs) -> QUBOProblem:
    """Compatibility alias for the new dynamic builder."""
    return build_dynamic_qubo(*args, **kwargs)


def evaluate_qubo_energy(problem: QUBOProblem, bitstring: str) -> float:
    if len(bitstring) != problem.dimension:
        raise ValueError("Bitstring length does not match QUBO dimension.")
    bits = [1 if bit == "1" else 0 for bit in bitstring]
    energy = float(problem.offset)
    for key, value in problem.linear.items():
        energy += float(value) * bits[int(key)]
    for key, value in problem.quadratic.items():
        i, j = (int(part) for part in key.split(","))
        energy += float(value) * bits[i] * bits[j]
    return float(energy)
