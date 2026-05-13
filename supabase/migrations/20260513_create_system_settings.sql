-- Generic key-value store for super-admin-controlled system settings.
-- Each row is a named config entry with a JSONB value.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS system_settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Everyone (including unauthenticated customers) can read settings.
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_system_settings"
  ON system_settings FOR SELECT
  USING (true);

CREATE POLICY "admin_write_system_settings"
  ON system_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  );

-- Default venue map scope: Rizal province
INSERT INTO system_settings (key, value) VALUES (
  'venue_map_scope',
  '{
    "center_lat": 14.5794,
    "center_lng": 121.1878,
    "sw_lat": 14.26,
    "sw_lng": 120.95,
    "ne_lat": 14.82,
    "ne_lng": 121.62
  }'::jsonb
) ON CONFLICT (key) DO NOTHING;
