# 24h Temporal Profile integration

The frontend separates **shape** and **amplitude**:

- Shape: Default Synthetic, presets, Custom controls, or CSV upload.
- Amplitude: Demand, Solar and Wind workspace sliders.

Before every run, `buildScenarioInputContract()` calls `makeScenarioPreview24h()` and sends the resulting 24 final MW values:

```text
scenario_input.profiles.demand_mw
scenario_input.profiles.solar_available_mw
scenario_input.profiles.wind_available_mw
```

Grid Limit and Battery SOC/Capacity are sent in the same request. The backend validates the 24-point arrays and applies them to the runtime dataset before optimization.

Quick presets apply immediately. Advanced Preset/Custom/CSV changes remain Pending until `Apply Profile` is pressed.
