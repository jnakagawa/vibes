// SQL builders for the MotherDuck dive functions. Shared verbatim by the
// Node harness (@duckdb/node-api) and the extension (@motherduck/wasm-client),
// so the exact statements the extension runs are the ones the harness proved.
//
// Escaping strategy: dive content NEVER goes through SQL-literal escaping.
// It is UTF-8 → base64 (charset [A-Za-z0-9+/=], inert inside a single-quoted
// literal) and decoded server-side:
//   SET VARIABLE dive_arranger_content = decode(from_base64('<b64>'));
//   FROM MD_UPDATE_DIVE_CONTENT(id := '<uuid>', content := getvariable(...));
// This is the browser-safe equivalent of the read_text()-on-a-temp-file trick
// the dive-builder predecessor used (no filesystem in the extension).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(id) {
  if (!UUID_RE.test(String(id))) throw new Error(`not a dive UUID: ${JSON.stringify(id)}`);
  return String(id).toLowerCase();
}

// Simple strings (titles/descriptions we author ourselves) — standard '' doubling.
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function encodeContentBase64(content) {
  const s = String(content);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "utf8").toString("base64");
  }
  // Browser path: UTF-8 bytes first, then base64 in chunks (btoa is latin1-only).
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const CONTENT_VAR = "dive_arranger_content";

export function sqlSetContentVariable(content) {
  return `SET VARIABLE ${CONTENT_VAR} = decode(from_base64('${encodeContentBase64(content)}'))`;
}

export function sqlGetDive(id) {
  return `SELECT * FROM MD_GET_DIVE(id := '${assertUuid(id)}')`;
}

export function sqlUpdateDiveContent(id) {
  return `FROM MD_UPDATE_DIVE_CONTENT(id := '${assertUuid(id)}', content := getvariable('${CONTENT_VAR}'))`;
}

/** Statements to run in order (same connection) to update a dive's content. */
export function sqlStatementsForUpdate(id, content) {
  return [sqlSetContentVariable(content), sqlUpdateDiveContent(id)];
}

/** Statements to create a dive (harness only). */
export function sqlStatementsForCreate({ title, description = "", content }) {
  return [
    sqlSetContentVariable(content),
    `FROM MD_CREATE_DIVE(title := ${q(title)}, description := ${q(description)}, content := getvariable('${CONTENT_VAR}'))`,
  ];
}

export function sqlDeleteDive(id) {
  return `FROM MD_DELETE_DIVE(id := '${assertUuid(id)}')`;
}
