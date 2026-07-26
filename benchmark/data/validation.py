from __future__ import annotations

from app.models.schemas import DatasetModel


def validate_benchmark_dataset(dataset: DatasetModel) -> None:
    horizon = len(dataset.hours)
    if horizon != 24:
        raise ValueError(f"Benchmark horizon must be 24 hours, received {horizon}.")

    for name, values in {
        "demand": dataset.demand,
        "renewable": dataset.renewable,
        "reserve": dataset.reserve,
    }.items():
        if len(values) != horizon:
            raise ValueError(
                f"{name} length {len(values)} does not match horizon {horizon}."
            )
        if any(float(value) < 0 for value in values):
            raise ValueError(f"{name} contains a negative value.")

    generator_ids = [generator.id for generator in dataset.generators]
    if not generator_ids:
        raise ValueError("Dataset must contain at least one dispatchable generator.")
    if len(generator_ids) != len(set(generator_ids)):
        raise ValueError("Generator IDs must be unique.")

    for generator in dataset.generators:
        if generator.p_min < 0 or generator.p_max < generator.p_min:
            raise ValueError(
                f"Invalid capacity bounds for generator {generator.id}."
            )
        if generator.initial_status not in {0, 1}:
            raise ValueError(
                f"initial_status must be binary for {generator.id}."
            )
        if generator.initial_status == 0 and abs(generator.initial_output) > 1e-9:
            raise ValueError(
                f"Offline generator {generator.id} has non-zero initial output."
            )

    total_capacity = sum(generator.p_max for generator in dataset.generators)
    peak_requirement = max(
        demand + reserve
        for demand, reserve in zip(dataset.demand, dataset.reserve)
    )
    flexible_capacity = (
        total_capacity
        + dataset.grid_import_limit_mw
        + dataset.battery_discharge_limit_mw
        + max(dataset.renewable, default=0.0)
    )
    if flexible_capacity + 1e-9 < peak_requirement:
        raise ValueError(
            "Dataset has insufficient installed/flexible capacity for peak demand and reserve."
        )
