CREATE TABLE IF NOT EXISTS run_message_projections (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assistant_text text NOT NULL DEFAULT '',
  reasoning text NOT NULL DEFAULT '',
  citations jsonb NOT NULL DEFAULT '[]',
  last_seq integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS agent_runs_session_history_idx
  ON agent_runs(tenant_id, user_id, session_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS session_file_projections (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  path text NOT NULL,
  content text,
  operation text NOT NULL,
  run_created_at timestamptz NOT NULL,
  run_id uuid NOT NULL,
  seq integer NOT NULL,
  PRIMARY KEY (tenant_id, session_id, path)
);

-- Rebuild in PostgreSQL: the application never materializes the event ledger.
CREATE OR REPLACE FUNCTION rebuild_run_message_projection(target_run uuid, target_tenant uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE snapshot_seq integer; snapshot_text text;
BEGIN
  PERFORM 1 FROM agent_runs WHERE id=target_run AND tenant_id=target_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT seq, payload->>'text' INTO snapshot_seq, snapshot_text
    FROM run_events WHERE run_id=target_run AND tenant_id=target_tenant AND event_type='assistant.snapshot'
    ORDER BY seq DESC LIMIT 1;
  INSERT INTO run_message_projections(run_id, tenant_id, assistant_text, reasoning, citations, last_seq)
    SELECT target_run, target_tenant,
      COALESCE(snapshot_text, '') || COALESCE(string_agg(payload->>'text', '' ORDER BY seq)
        FILTER (WHERE event_type='assistant.delta' AND seq>COALESCE(snapshot_seq, 0)), ''),
      COALESCE(string_agg(payload->>'text', '' ORDER BY seq) FILTER (WHERE event_type='assistant.reasoning'), ''),
      COALESCE((SELECT jsonb_agg(c.value ORDER BY e.seq, c.ordinality)
        FROM run_events e CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.payload->'citations', '[]')) WITH ORDINALITY c
        WHERE e.run_id=target_run AND e.tenant_id=target_tenant AND e.event_type='retrieval.completed'), '[]'),
      COALESCE(max(seq), 0)
    FROM run_events WHERE run_id=target_run AND tenant_id=target_tenant
  ON CONFLICT(run_id) DO UPDATE SET assistant_text=EXCLUDED.assistant_text,
    reasoning=EXCLUDED.reasoning, citations=EXCLUDED.citations, last_seq=EXCLUDED.last_seq;
END;
$$;

CREATE OR REPLACE FUNCTION project_run_history_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE file_path text; tool_name text; file_content text; run_session uuid; run_created timestamptz;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM run_message_projections WHERE run_id=NEW.run_id) THEN
    PERFORM rebuild_run_message_projection(NEW.run_id, NEW.tenant_id);
  ELSE
    UPDATE run_message_projections SET
      assistant_text=CASE NEW.event_type
        WHEN 'assistant.snapshot' THEN COALESCE(NEW.payload->>'text', '')
        WHEN 'assistant.delta' THEN assistant_text || COALESCE(NEW.payload->>'text', '')
        ELSE assistant_text END,
      reasoning=reasoning || CASE WHEN NEW.event_type='assistant.reasoning' THEN COALESCE(NEW.payload->>'text', '') ELSE '' END,
      citations=citations || CASE WHEN NEW.event_type='retrieval.completed' THEN COALESCE(NEW.payload->'citations', '[]') ELSE '[]'::jsonb END,
      last_seq=NEW.seq
    WHERE run_id=NEW.run_id AND tenant_id=NEW.tenant_id AND last_seq<NEW.seq;
  END IF;
  IF NEW.event_type='tool.started' THEN
    tool_name=NEW.payload->>'tool';
    file_path=btrim(COALESCE(NEW.payload->'input'->>'file_path', NEW.payload->'input'->>'path', ''));
    IF tool_name IN ('write_file','edit_file','read_file','delete') AND length(file_path) BETWEEN 1 AND 1024 THEN
      SELECT session_id, created_at INTO run_session, run_created FROM agent_runs WHERE id=NEW.run_id AND tenant_id=NEW.tenant_id;
      file_content=CASE WHEN tool_name IN ('write_file','edit_file') AND jsonb_typeof(NEW.payload->'input'->'content')='string'
        THEN NEW.payload->'input'->>'content' END;
      INSERT INTO session_file_projections(tenant_id,session_id,path,content,operation,run_created_at,run_id,seq)
        VALUES(NEW.tenant_id,run_session,file_path,file_content,tool_name,run_created,NEW.run_id,NEW.seq)
      ON CONFLICT(tenant_id,session_id,path) DO UPDATE SET
        content=COALESCE(EXCLUDED.content,session_file_projections.content), operation=EXCLUDED.operation,
        run_created_at=EXCLUDED.run_created_at,run_id=EXCLUDED.run_id,seq=EXCLUDED.seq
      WHERE (EXCLUDED.run_created_at,EXCLUDED.run_id,EXCLUDED.seq)>=
        (session_file_projections.run_created_at,session_file_projections.run_id,session_file_projections.seq);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS run_events_history_projection ON run_events;
CREATE TRIGGER run_events_history_projection AFTER INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION project_run_history_event();

DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT id,tenant_id FROM agent_runs ORDER BY id LOOP
    PERFORM rebuild_run_message_projection(item.id,item.tenant_id);
  END LOOP;
END $$;

-- Preserve the last operation and the last write/edit content independently.
WITH operations AS (
  SELECT e.tenant_id,r.session_id,btrim(COALESCE(e.payload->'input'->>'file_path',e.payload->'input'->>'path','')) AS path,
    e.payload->>'tool' AS operation,r.created_at AS run_created_at,r.id AS run_id,e.seq,
    CASE WHEN e.payload->>'tool' IN ('write_file','edit_file') AND jsonb_typeof(e.payload->'input'->'content')='string'
      THEN e.payload->'input'->>'content' END AS content
  FROM run_events e JOIN agent_runs r ON r.id=e.run_id AND r.tenant_id=e.tenant_id
  WHERE e.event_type='tool.started' AND e.payload->>'tool' IN ('write_file','edit_file','read_file','delete')
), latest AS (
  SELECT DISTINCT ON(tenant_id,session_id,path) * FROM operations WHERE length(path) BETWEEN 1 AND 1024
  ORDER BY tenant_id,session_id,path,run_created_at DESC,run_id DESC,seq DESC
), contents AS (
  SELECT DISTINCT ON(tenant_id,session_id,path) tenant_id,session_id,path,content FROM operations
  WHERE content IS NOT NULL ORDER BY tenant_id,session_id,path,run_created_at DESC,run_id DESC,seq DESC
)
INSERT INTO session_file_projections(tenant_id,session_id,path,content,operation,run_created_at,run_id,seq)
  SELECT l.tenant_id,l.session_id,l.path,c.content,l.operation,l.run_created_at,l.run_id,l.seq
  FROM latest l LEFT JOIN contents c USING(tenant_id,session_id,path)
ON CONFLICT(tenant_id,session_id,path) DO UPDATE SET content=EXCLUDED.content,operation=EXCLUDED.operation,
  run_created_at=EXCLUDED.run_created_at,run_id=EXCLUDED.run_id,seq=EXCLUDED.seq;
