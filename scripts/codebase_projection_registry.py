#!/usr/bin/env python3
"""Projection-kind registry for #1595 codebase structure artifacts.

The authored ``codeStructure.projectionManifest[]`` record stores intent:
``kind``, ``path``, ``source``, and ``generated``. Runner-specific commands stay
out of that canonical metadata. This registry is the framework-owned bridge
from a stable projection kind to the contract details later task wrappers can
use.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass

CODEBASE_MAP_KIND = "codebase-map"
CODEBASE_MAP_FORMAT_VERSION = "codebase-map.v1"
CODEBASE_PROVIDER_CONTRACT_VERSION = "codebase-provider.v1"


@dataclass(frozen=True)
class ProjectionKind:
    """Framework-owned behavior for one ``projectionManifest[].kind`` value."""

    kind: str
    artifact_format_version: str
    provider_contract_version: str
    output_role: str
    generate_action: str
    freshness_action: str
    description: str

    def to_dict(self) -> dict[str, str]:
        """Return a JSON-serializable representation."""
        return asdict(self)


_REGISTRY: tuple[ProjectionKind, ...] = (
    ProjectionKind(
        kind=CODEBASE_MAP_KIND,
        artifact_format_version=CODEBASE_MAP_FORMAT_VERSION,
        provider_contract_version=CODEBASE_PROVIDER_CONTRACT_VERSION,
        output_role="architecture-map",
        generate_action="generate-codebase-map",
        freshness_action="verify-codebase-map-freshness",
        description=(
            "Generated codebase orientation map derived from authored "
            "codeStructure metadata plus code-derived facts."
        ),
    ),
)


def list_projection_kinds() -> list[ProjectionKind]:
    """Return registered projection kinds in deterministic order."""
    return sorted(_REGISTRY, key=lambda entry: entry.kind)


def resolve_projection_kind(kind: str) -> ProjectionKind:
    """Resolve one projection kind or raise ``KeyError`` with a useful message."""
    for entry in _REGISTRY:
        if entry.kind == kind:
            return entry
    known = ", ".join(entry.kind for entry in list_projection_kinds()) or "<none>"
    raise KeyError(f"unknown projection kind {kind!r}; known kinds: {known}")


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for registry inspection."""
    parser = argparse.ArgumentParser(description="Inspect codebase projection kinds.")
    parser.add_argument("--kind", help="Projection kind to resolve.")
    parser.add_argument("--list", action="store_true", help="List all projection kinds.")
    args = parser.parse_args(argv)

    if args.list:
        payload: object = [entry.to_dict() for entry in list_projection_kinds()]
    elif args.kind:
        try:
            payload = resolve_projection_kind(args.kind).to_dict()
        except KeyError as exc:
            print(str(exc), file=sys.stderr)
            return 1
    else:
        parser.print_help()
        return 0

    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
