"""Lightweight W3C PROV-JSON lineage recording.

Every derived artefact in the pipeline is registered with its SHA-256 digest,
the activity that produced it, its input entities, and the parameters used.
``citytwin provenance verify`` re-hashes the files, so a published figure or
CityJSON file can be traced back to the exact Overture release it came from --
which is the property a decision-support twin needs in order to be auditable.
"""

from __future__ import annotations

import hashlib
import json
import platform
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

AGENT_ID = "agent:citytwin"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(payload: Any) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass
class Entity:
    id: str
    kind: str
    path: str | None = None
    sha256: str | None = None
    bytes: int | None = None
    created_at: str = ""
    source: str | None = None
    license: str | None = None
    generated_by: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def as_prov(self) -> dict[str, Any]:
        attributes: dict[str, Any] = {
            "kind": self.kind,
            "created_at": self.created_at,
        }
        for key in ("path", "sha256", "bytes", "source", "license"):
            value = getattr(self, key)
            if value is not None:
                attributes[key] = value
        attributes.update(self.extra)
        return {"prov:label": Path(self.path).name if self.path else self.kind, **attributes}


@dataclass
class Activity:
    id: str
    name: str
    started_at: str
    ended_at: str | None = None
    params: dict[str, Any] = field(default_factory=dict)


class Provenance:
    """A PROV-JSON document builder with entity hashing and verification."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self.entities: dict[str, Entity] = {}
        self.activities: dict[str, Activity] = {}
        self.relations: list[dict[str, str]] = []
        self._activity_seq = 0

    # -- recording ---------------------------------------------------------
    @contextmanager
    def activity(self, name: str, **params: Any) -> Iterator[Activity]:
        self._activity_seq += 1
        activity = Activity(
            id=f"activity:{name}/{self._activity_seq}",
            name=name,
            started_at=utc_now(),
            params={k: v for k, v in params.items() if v is not None},
        )
        self.activities[activity.id] = activity
        try:
            yield activity
        finally:
            activity.ended_at = utc_now()

    def record_file(
        self,
        path: Path,
        kind: str,
        activity: Activity | None = None,
        source: str | None = None,
        license: str | None = None,
        **extra: Any,
    ) -> Entity:
        """Register a file artefact and return its entity record."""
        path = Path(path)
        digest = sha256_file(path)
        entity = Entity(
            id=f"entity:{digest[:16]}",
            kind=kind,
            path=str(path),
            sha256=digest,
            bytes=path.stat().st_size,
            created_at=utc_now(),
            source=source,
            license=license,
            generated_by=activity.id if activity else None,
            extra=extra,
        )
        self.entities[entity.id] = entity
        if activity is not None:
            self.relations.append({"prov:generated": entity.id, "prov:activity": activity.id})
            self.relations.append({"prov:activity": activity.id, "prov:agent": AGENT_ID})
        return entity

    def record_value(
        self,
        kind: str,
        payload: Any,
        activity: Activity | None = None,
        **extra: Any,
    ) -> Entity:
        """Register an in-memory artefact (e.g. a model card) by content hash."""
        digest = sha256_json(payload)
        entity = Entity(
            id=f"entity:{digest[:16]}",
            kind=kind,
            sha256=digest,
            created_at=utc_now(),
            generated_by=activity.id if activity else None,
            extra=extra,
        )
        self.entities[entity.id] = entity
        if entity.generated_by:
            self.relations.append(
                {"prov:generated": entity.id, "prov:activity": entity.generated_by}
            )
        return entity

    def used(self, entity: Entity, activity: Activity) -> None:
        self.relations.append({"prov:used": entity.id, "prov:activity": activity.id})

    # -- serialisation -----------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {
            "prefix": {
                "prov": "http://www.w3.org/ns/prov#",
                "xsd": "http://www.w3.org/2001/XMLSchema#",
                "citytwin": "https://github.com/caoqyqianyi/citytwin/ns#",
            },
            "agent": {
                AGENT_ID: {
                    "prov:type": "prov:SoftwareAgent",
                    "prov:label": "citytwin",
                    "citytwin:python": sys.version.split()[0],
                    "citytwin:platform": platform.platform(),
                }
            },
            "activity": {
                aid: {
                    "prov:startTime": act.started_at,
                    "prov:endTime": act.ended_at,
                    "prov:type": act.name,
                    **{f"citytwin:{k}": v for k, v in act.params.items()},
                }
                for aid, act in self.activities.items()
            },
            "entity": {eid: ent.as_prov() for eid, ent in self.entities.items()},
            "wasGeneratedBy": self.relations,
        }

    def write(self, path: Path | None = None) -> Path:
        target = Path(path or self.path or "provenance.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(self.to_dict(), indent=2, default=str), encoding="utf-8")
        return target

    # -- verification ------------------------------------------------------
    @staticmethod
    def verify(path: Path) -> list[str]:
        """Re-hash every recorded file; return a list of human-readable problems."""
        document = json.loads(Path(path).read_text(encoding="utf-8"))
        problems: list[str] = []
        for entity_id, attributes in document.get("entity", {}).items():
            recorded = attributes.get("sha256")
            file_path = attributes.get("path")
            if not recorded or not file_path:
                continue
            candidate = Path(file_path)
            if not candidate.is_absolute():
                candidate = Path(path).parent / candidate
            if not candidate.exists():
                problems.append(f"{entity_id}: missing file {file_path}")
                continue
            if sha256_file(candidate) != recorded:
                problems.append(f"{entity_id}: hash mismatch for {file_path}")
        return problems
