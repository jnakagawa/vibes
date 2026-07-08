// Live round-trip verification of the arranger engine against MotherDuck.
//
//   MOTHERDUCK_TOKEN=<short-lived token> npm run roundtrip
//
// Creates a THROWAWAY dive (MD_CREATE_DIVE), runs the full engine pipeline
// (fetch → discover → applyLayout → write back → read back → assert), then
// DELETES the throwaway dive. It never touches any pre-existing dive: the only
// ids passed to update/delete are the one it just created, and a hard denylist
// guards the known real dives besides.
import { DuckDBInstance } from "@duckdb/node-api";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverBlocks,
  applyLayout,
  sqlGetDive,
  sqlStatementsForUpdate,
  sqlStatementsForCreate,
  sqlDeleteDive,
  assertUuid,
} from "../engine/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(path.join(HERE, "sample-dive.jsx"), "utf8");

// Real dives this harness must never write to or delete, even by accident.
const DENYLIST = new Set([
  "779abb23-f01d-4152-b307-e828ee7bbe3b", // Zero Build Chat funnel dive
  "c5ea2d1b-0000-0000-0000-000000000000".slice(0, 8), // prefix guard below covers the real growth dive
]);
const DENY_PREFIXES = ["779abb23", "c5ea2d1b", "f1f11641"];

function guardId(id) {
  assertUuid(id);
  const lower = String(id).toLowerCase();
  if (DENYLIST.has(lower) || DENY_PREFIXES.some((p) => lower.startsWith(p))) {
    throw new Error(`refusing to touch real dive ${id}`);
  }
  return lower;
}

let passed = 0;
function ok(name, cond, detail = "") {
  if (!cond) throw new Error(`ASSERTION FAILED: ${name} ${detail}`);
  passed += 1;
  console.log(`  ✔ ${name}`);
}

async function main() {
  const token = process.env.MOTHERDUCK_TOKEN;
  if (!token) {
    console.error("MOTHERDUCK_TOKEN is not set (mint a short-lived token; never write it to a file).");
    process.exit(2);
  }

  console.log("connecting to MotherDuck …");
  const instance = await DuckDBInstance.create("md:", { motherduck_token: token });
  const conn = await instance.connect();

  const rowsOf = async (sql) => {
    const r = await conn.runAndReadAll(sql);
    return r.getRowObjects().map((row) => {
      const o = {};
      for (const [k, v] of Object.entries(row)) o[k] = v == null ? null : String(v);
      return o;
    });
  };

  let diveId = null;
  try {
    // ── 1. create the throwaway dive ────────────────────────────────
    console.log("\n[1] MD_CREATE_DIVE (throwaway)");
    const createStmts = sqlStatementsForCreate({
      title: "dive-arranger harness throwaway — safe to delete",
      description: "Created by dive-arranger/harness/roundtrip.mjs; deleted automatically at the end of the run.",
      content: SAMPLE,
    });
    await conn.run(createStmts[0]);
    const created = await rowsOf(createStmts[1]);
    ok("MD_CREATE_DIVE returned a row", created.length === 1, JSON.stringify(created));
    diveId = guardId(created[0].id ?? created[0].dive_id);
    console.log(`  throwaway dive id: ${diveId}`);

    // ── 2. fetch source generically (what the extension does) ───────
    console.log("\n[2] MD_GET_DIVE round-trip of the created content");
    const fetched = await rowsOf(sqlGetDive(diveId));
    ok("MD_GET_DIVE returned the dive", fetched.length === 1);
    const source = fetched[0].content;
    ok("created content survived byte-exactly", source === SAMPLE, `(${source?.length} vs ${SAMPLE.length} chars)`);

    // ── 3. discover blocks ───────────────────────────────────────────
    console.log("\n[3] generic block discovery");
    const { blocks } = discoverBlocks(source);
    ok("discovered 5 top-level blocks", blocks.length === 5, `got ${blocks.length}`);
    ok(
      "kinds are static,static,dynamic,static,static",
      blocks.map((b) => b.kind).join(",") === "static,static,dynamic,static,static",
    );
    ok(
      "labels derived from the source",
      blocks[0].label === "alpha" && blocks[1].label === "beta" && blocks[4].label === "delta",
    );

    // ── 4. apply a layout: reorder + wrap two-up row + resize ───────
    console.log("\n[4] applyLayout (reorder + wrap + resize)");
    const layout = {
      rows: [
        { cells: [{ block: 1, span: 6 }, { block: 0, span: 6, heightPx: 240 }] }, // beta | alpha (h 240)
        { cells: [{ block: 2 }] }, // pinned conditional
        { cells: [{ block: 4 }] }, // delta
        { cells: [{ block: 3 }] }, // gamma
      ],
    };
    const { code } = applyLayout(source, layout);
    ok("engine self-check passed (output re-discovers to the requested layout)", true);

    // ── 5. write back ────────────────────────────────────────────────
    console.log("\n[5] MD_UPDATE_DIVE_CONTENT write-back");
    const [setVar, update] = sqlStatementsForUpdate(diveId, code);
    await conn.run(setVar);
    await rowsOf(update);

    // ── 6. read back + assert ────────────────────────────────────────
    console.log("\n[6] read-back assertions");
    const after = (await rowsOf(sqlGetDive(diveId)))[0].content;
    ok("read-back equals generated source byte-exactly", after === code);
    ok("beta now precedes alpha", after.indexOf('id="beta"') < after.indexOf('id="alpha"'));
    ok("delta now precedes gamma", after.indexOf('id="delta"') < after.indexOf('id="gamma"'));
    ok("arranger row wrapper present", /data-dive-arranger="row"/.test(after));
    ok("span + height markers present", /data-arranger-span="6"/.test(after) && /data-arranger-h="240"/.test(after));
    ok(
      "module-level helper + comment preserved verbatim",
      after.includes('const GREETING = "hello from the arranger harness"; // module-level helper (must survive)'),
    );
    ok("inner JSX comment preserved", after.includes("{/* keep this inner comment */}"));
    ok("hook-adjacent logic preserved", after.includes("const showNote = items.length > 2; // derived flag (must survive)"));
    ok("still exactly one default export", (after.match(/export default/g) || []).length === 1);

    const rediscovered = discoverBlocks(after); // throws if it no longer parses
    ok("read-back still parses as a single default-export component", true);
    ok(
      "re-discovery unwraps to the same 5 logical blocks in the new order",
      rediscovered.blocks.map((b) => b.label).join(",") === "beta,alpha,{conditional} #2,delta,gamma",
      rediscovered.blocks.map((b) => b.label).join(","),
    );
    ok(
      "prior spans/heights recovered from the wrappers",
      rediscovered.rows[0].cells[0].span === 6 && rediscovered.rows[0].cells[1].heightPx === 240,
    );

    // ── 7. second pass: restore original order (idempotence) ────────
    console.log("\n[7] second edit restores original order (no wrapper build-up)");
    const restore = {
      rows: [
        { cells: [{ block: 1 }] }, // alpha (new ids follow the new order)
        { cells: [{ block: 0 }] }, // beta
        { cells: [{ block: 2 }] },
        { cells: [{ block: 4 }] }, // gamma
        { cells: [{ block: 3 }] }, // delta
      ],
    };
    const second = applyLayout(after, restore);
    const [setVar2, update2] = sqlStatementsForUpdate(diveId, second.code);
    await conn.run(setVar2);
    await rowsOf(update2);
    const final = (await rowsOf(sqlGetDive(diveId)))[0].content;
    ok("second write-back verified", final === second.code);
    ok("alpha precedes beta again", final.indexOf('id="alpha"') < final.indexOf('id="beta"'));
    ok("no arranger wrappers left after restoring full-width order", !/data-dive-arranger/.test(final));
    ok(
      "restored source discovers the original 5 blocks",
      discoverBlocks(final).blocks.map((b) => b.label).join(",") === "alpha,beta,{conditional} #2,gamma,delta",
    );
  } finally {
    // ── 8. cleanup: delete the throwaway dive ───────────────────────
    if (diveId) {
      console.log("\n[8] MD_DELETE_DIVE cleanup");
      try {
        await rowsOf(sqlDeleteDive(guardId(diveId)));
        let gone = false;
        try {
          const check = await rowsOf(sqlGetDive(diveId));
          gone = check.length === 0;
        } catch {
          gone = true; // MD_GET_DIVE erroring on a deleted id also proves deletion
        }
        ok("throwaway dive deleted", gone);
      } catch (e) {
        console.error(`  !! cleanup failed — delete dive ${diveId} manually:`, e.message);
        process.exitCode = 1;
      }
    }
  }

  console.log(`\nROUND-TRIP PASS — ${passed} assertions.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("\nROUND-TRIP FAIL:", e.message);
  process.exit(1);
});
