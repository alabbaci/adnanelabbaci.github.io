-- citytwin reference schema for PostGIS.
-- Mirrors the SQLite feature store so the API and agent can move to a
-- shared database without changing their query layer.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS collection (
    name            text PRIMARY KEY,
    title           text NOT NULL,
    description     text,
    id_column       text NOT NULL,
    crs             text NOT NULL DEFAULT 'EPSG:4326',
    property_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feature (
    collection      text NOT NULL REFERENCES collection(name) ON DELETE CASCADE,
    feature_id      text NOT NULL,
    geometry        geometry(Geometry, 4326) NOT NULL,
    properties      jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (collection, feature_id)
);

CREATE INDEX IF NOT EXISTS feature_geometry_gix
    ON feature USING GIST (geometry);
CREATE INDEX IF NOT EXISTS feature_properties_gin
    ON feature USING GIN (properties jsonb_path_ops);

-- Bounding-box query in a metric CRS, the same semantics as FeatureStore.bbox
CREATE OR REPLACE FUNCTION feature_bbox(
    p_collection text,
    p_bbox       double precision[],
    p_limit      integer DEFAULT 100,
    p_offset     integer DEFAULT 0
)
RETURNS TABLE (feature_id text, geometry geometry, properties jsonb)
LANGUAGE sql STABLE AS $$
    SELECT f.feature_id, f.geometry, f.properties
    FROM feature f
    WHERE f.collection = p_collection
      AND f.geometry && ST_MakeEnvelope(
            p_bbox[1], p_bbox[2], p_bbox[3], p_bbox[4], 4326)
    ORDER BY f.feature_id
    LIMIT p_limit OFFSET p_offset;
$$;

INSERT INTO collection (name, title, description, id_column, property_schema)
VALUES
    ('buildings', 'Buildings',
     'Overture footprints (OSM + Microsoft ML) with imputed LoD1 heights and conformal intervals',
     'gers_id',
     '{"height_final_m": "number", "building_class": "string", "typology": "string"}'),
    ('cells', 'Analysis cells',
     '250 m grid with the heat-exposure index and its uncertainties',
     'cell_id',
     '{"hei": "number", "hotspot_probability": "number"}'),
    ('green', 'Green space',
     'Parks, gardens and other vegetated land from Overture base',
     'gers_id', '{}')
ON CONFLICT (name) DO NOTHING;
