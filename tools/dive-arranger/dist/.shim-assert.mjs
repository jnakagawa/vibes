function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
assert.ok = assert;
assert.strictEqual = (a, b, m) => assert(a === b, m);
assert.notStrictEqual = (a, b, m) => assert(a !== b, m);
assert.deepEqual = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m);
export default assert;
export { assert as ok, assert as strict };
