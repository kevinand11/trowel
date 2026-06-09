# Init writes prompted or existing config only

`trowel init` materializes config values only when they were explicitly produced by an init prompt or copied from an existing config file. Hidden/default-only settings remain valid through the schema and runtime defaults, but are not written into generated config; this keeps generated config intentional while preserving manual tunability for advanced knobs such as `ship.mergeabilityPollSeconds`.
