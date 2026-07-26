from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from app.models.schemas import DatasetModel
from benchmark.data.synthetic_factory import build_generator_fleet
from benchmark.data.validation import validate_benchmark_dataset


@dataclass(frozen=True)
class SimBenchMetadata:
    simbench_code: str
    day_index: int
    source_steps: int
    source_resolution: str
    aggregation: str = "single-bus 24-hour UC"


def _profiles_for(net: Any, element: str):
    profiles = getattr(net, "profiles", {}) or {}
    candidates = [
        element,
        (element, "p_mw"),
        f"{element}.p_mw",
        f"{element}_p_mw",
    ]
    for key in candidates:
        if key in profiles:
            return profiles[key]
    for key, value in profiles.items():
        key_text = str(key).lower()
        if element in key_text and "p" in key_text:
            return value
    return None


def _aggregate_element_profile(net: Any, element: str) -> np.ndarray:
    table = getattr(net, element, None)
    if table is None or len(table) == 0:
        return np.zeros(0, dtype=float)

    profile_frame = _profiles_for(net, element)
    if profile_frame is None or len(profile_frame) == 0:
        total = float(table.get("p_mw", 0.0).sum()) if "p_mw" in table else 0.0
        return np.full(35040, total, dtype=float)

    length = len(profile_frame)
    total_series = np.zeros(length, dtype=float)
    for _index, row in table.iterrows():
        nominal = max(0.0, float(row.get("p_mw", 0.0)))
        profile_name = row.get("profile")
        if profile_name in profile_frame.columns:
            values = np.asarray(profile_frame[profile_name], dtype=float)
            # SimBench profiles may be normalized or absolute depending on the
            # element/profile export. Normalization below removes that ambiguity;
            # multiplying by p_mw preserves element weighting where applicable.
            if np.nanmax(np.abs(values)) <= 5.0:
                values = nominal * values
        else:
            values = np.full(length, nominal, dtype=float)
        total_series += np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0)
    return np.maximum(total_series, 0.0)


def _hourly_window(values: np.ndarray, day_index: int) -> list[float]:
    if values.size == 0:
        return [0.0] * 24

    # SimBench full-year profiles are normally 15-minute series. Derive the
    # number of samples per day from the annual length and average into 24 bins.
    days = 366 if values.size % 366 == 0 else 365
    steps_per_day = max(24, values.size // days)
    safe_day = day_index % max(1, values.size // steps_per_day)
    start = safe_day * steps_per_day
    window = values[start : start + steps_per_day]
    if window.size < steps_per_day:
        window = np.pad(window, (0, steps_per_day - window.size), mode="edge")

    chunks = np.array_split(window, 24)
    return [float(np.mean(chunk)) for chunk in chunks]


def _normalize_shape(values: list[float], fallback: list[float]) -> list[float]:
    array = np.asarray(values, dtype=float)
    maximum = float(np.max(array)) if array.size else 0.0
    if maximum <= 1e-12:
        array = np.asarray(fallback, dtype=float)
        maximum = float(np.max(array))
    return (array / maximum).tolist()


def build_simbench_uc_dataset(
    *,
    simbench_code: str,
    day_index: int,
    generator_count: int,
    case_id: str,
) -> tuple[DatasetModel, SimBenchMetadata]:
    """Convert SimBench profiles into the prototype's aggregated UC model.

    SimBench supplies the annual demand and renewable shapes. The prototype is
    intentionally single-bus, so topology is not passed into the QUBO. A
    deterministic dispatchable fleet is generated and capacity-normalized to
    the selected profile window.
    """

    try:
        import simbench as sb
    except ImportError as exc:
        raise RuntimeError(
            "SimBench benchmark requires `pip install simbench`."
        ) from exc

    net = sb.get_simbench_net(simbench_code)
    load_series = _aggregate_element_profile(net, "load")
    renewable_series = _aggregate_element_profile(net, "sgen")
    if renewable_series.size == 0:
        renewable_series = _aggregate_element_profile(net, "gen")

    load_window = _hourly_window(load_series, day_index)
    renewable_window = _hourly_window(renewable_series, day_index)
    fallback_load = [
        0.58, 0.55, 0.53, 0.52, 0.54, 0.60,
        0.69, 0.78, 0.84, 0.88, 0.87, 0.83,
        0.78, 0.75, 0.74, 0.76, 0.81, 0.88,
        0.95, 1.00, 0.94, 0.84, 0.72, 0.63,
    ]
    fallback_renewable = [
        0.18, 0.17, 0.16, 0.15, 0.14, 0.13,
        0.16, 0.24, 0.38, 0.56, 0.75, 0.90,
        1.00, 0.96, 0.82, 0.64, 0.45, 0.30,
        0.22, 0.19, 0.18, 0.18, 0.17, 0.16,
    ]
    load_shape = _normalize_shape(load_window, fallback_load)
    renewable_shape = _normalize_shape(renewable_window, fallback_renewable)

    generators = build_generator_fleet(generator_count)
    total_capacity = sum(generator.p_max for generator in generators)
    demand_peak = 0.72 * total_capacity
    renewable_peak = 0.20 * total_capacity
    demand = [round(demand_peak * value, 3) for value in load_shape]
    renewable = [round(renewable_peak * value, 3) for value in renewable_shape]
    reserve = [round(0.08 * value, 3) for value in demand]

    # SimBench sgen profiles combine renewable technologies. Split only for
    # display metadata; the UC equations continue using their sum.
    solar_share = [
        max(0.0, np.sin((hour - 6) * np.pi / 12.0))
        for hour in range(24)
    ]
    solar = [
        round(value * min(0.75, solar_share[hour]), 3)
        for hour, value in enumerate(renewable)
    ]
    wind = [round(value - solar[hour], 3) for hour, value in enumerate(renewable)]

    dataset = DatasetModel(
        id=f"simbench_{case_id}_{generator_count}g",
        name=f"SimBench-derived {case_id} ({generator_count} generators)",
        description=(
            f"SimBench {simbench_code}, day {day_index}, aggregated into the "
            "prototype single-bus 24-hour UC formulation."
        ),
        hours=list(range(24)),
        demand=demand,
        renewable=renewable,
        reserve=reserve,
        generators=generators,
        solar_available=solar,
        wind_available=wind,
        grid_import_limit_mw=round(0.08 * total_capacity, 3),
        initial_battery_soc_mwh=round(0.06 * total_capacity, 3),
        battery_capacity_mwh=round(0.12 * total_capacity, 3),
        battery_charge_limit_mw=round(0.04 * total_capacity, 3),
        battery_discharge_limit_mw=round(0.04 * total_capacity, 3),
    )
    validate_benchmark_dataset(dataset)
    metadata = SimBenchMetadata(
        simbench_code=simbench_code,
        day_index=day_index,
        source_steps=int(max(load_series.size, renewable_series.size)),
        source_resolution="15-minute annual profile (hourly mean window)",
    )
    return dataset, metadata
