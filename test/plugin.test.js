import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createPlugin, openSchema } from "../index.js"

async function host(directory = mkdtempSync(join(tmpdir(), "tool-repair-"))) {
  const hooks = {}
  await createPlugin().setup({ location: { directory }, tool: { hook: async (name, fn) => { hooks[name] = fn } } })
  let id = 0
  // Runs the before hook and returns the call OpenCode would execute, plus the note added after.
  async function call(tool, input, status = "completed") {
    const c = { id: "c" + ++id, sessionID: "s", tool, input }
    await hooks["execute.before"](c)
    const after = { ...c, status, result: { content: [{ type: "text", text: "ok" }] }, error: { message: "failed" } }
    await hooks["execute.after"](after)
    const note = status === "completed" ? after.result.content.slice(1).map((p) => p.text).join("") : after.error.message
    return { tool: c.tool, input: c.input, note }
  }
  return { call, directory }
}

const flintEdits = JSON.stringify([
  { oldText: "using System;\nusing UnityEngine;", newText: "using System;\nusing System.Linq;\nusing UnityEngine;" },
  { oldString: "    int y = 2;", newString: "    int y = 3;" },
])
const source = "using System;\nusing UnityEngine;\n\nclass A\n{\n    int x = 1;\n    int y = 2;\n}\n"

test("a single change in an edits string becomes a normal edit", async () => {
  const { call } = await host()
  const r = await call("edit", { path: "A.cs", edits: JSON.stringify([{ oldText: "a", newText: "b" }]) })
  assert.equal(r.tool, "edit")
  assert.deepEqual(r.input, { path: "A.cs", oldString: "a", newString: "b" })
  assert.match(r.note, /not an `edits` list/)
})

test("several changes that all fit are written in one go", async () => {
  const { call, directory } = await host()
  writeFileSync(join(directory, "A.cs"), source)
  const r = await call("edit", { path: "A.cs", edits: flintEdits })
  assert.equal(r.tool, "write")
  assert.equal(r.input.content, source.replace("using UnityEngine;", "using System.Linq;\nusing UnityEngine;").replace("y = 2", "y = 3"))
  assert.deepEqual(Object.keys(r.input).sort(), ["content", "path"])
  assert.match(r.note, /applied all 2 changes/)
})

test("windows line endings in the file still match", async () => {
  const { call, directory } = await host()
  writeFileSync(join(directory, "A.cs"), source.replace(/\n/g, "\r\n"))
  const r = await call("edit", { path: join(directory, "A.cs"), edits: flintEdits })
  assert.equal(r.tool, "write")
  assert.match(r.input.content, /using System;\r\nusing System\.Linq;\r\nusing UnityEngine;/)
  assert.ok(!/[^\r]\n/.test(r.input.content))
})

test("if a change doesn't fit, only the first is attempted and the model is told", async () => {
  const { call, directory } = await host()
  writeFileSync(join(directory, "A.cs"), source)
  const edits = JSON.stringify([{ oldText: "int x = 1;", newText: "int x = 5;" }, { oldText: "missing", newText: "x" }])
  const r = await call("edit", { path: "A.cs", edits })
  assert.equal(r.tool, "edit")
  assert.deepEqual(r.input, { path: "A.cs", oldString: "int x = 1;", newString: "int x = 5;" })
  assert.match(r.note, /first of your 2 changes.*other 1 as separate edit calls/)
})

test("an old text found twice is not guessed", async () => {
  const { call, directory } = await host()
  writeFileSync(join(directory, "A.cs"), "a a b")
  const r = await call("edit", { path: "A.cs", edits: [{ oldText: "a", newText: "c" }, { oldText: "b", newText: "d" }] })
  assert.equal(r.tool, "edit")
})

test("other argument names are renamed", async () => {
  const { call } = await host()
  let r = await call("edit", { file_path: "A.cs", old_string: "a", new_string: "b", replace_all: "true" })
  assert.deepEqual(r.input, { path: "A.cs", oldString: "a", newString: "b", replaceAll: true })
  assert.match(r.note, /Use those names next time/)
  r = await call("write", { filePath: "B.cs", contents: "x" })
  assert.deepEqual(r.input, { path: "B.cs", content: "x" })
})

test("garbled edit keys from Flint are recovered", async () => {
  const { call } = await host()
  let r = await call("edit", { path: "A.cs", oldString: "a", new: "String", "": "b" })
  assert.deepEqual(r.input, { path: "A.cs", oldString: "a", newString: "b" })
  assert.match(r.note, /Use those names next time/)
  r = await call("edit", { path: "A.cs", edString: "a", newString: "b" })
  assert.deepEqual(r.input, { path: "A.cs", oldString: "a", newString: "b" })
})

test("an edit with no newString gets a note saying what to send", async () => {
  const { call } = await host()
  const r = await call("edit", { path: "A.cs", oldString: "a", path_hint: "A.cs" }, "error")
  assert.match(r.note, /had no newString, so nothing changed/)
  assert.equal(r.input.newString, undefined) // nothing is guessed
})

test("empty and text values in optional fields are fixed", async () => {
  const { call } = await host()
  const r = await call("read", { path: "A.cs", offset: "", limit: "10", "": "" })
  assert.deepEqual(r.input, { path: "A.cs", limit: 10 })
})

test("a misspelled project folder as workdir is corrected; other folders are left alone", async () => {
  const { call, directory } = await host()
  let r = await call("shell", { command: "ls", workdir: directory.replace(/-/g, "") })
  assert.equal(r.input.workdir, directory)
  r = await call("shell", { command: "ls", workdir: "/nowhere/else" })
  assert.equal(r.input.workdir, "/nowhere/else")
})

test("correct calls pass through untouched, with no note", async () => {
  const { call } = await host()
  const input = { path: "A.cs", oldString: "a", newString: "b" }
  const r = await call("edit", { ...input })
  assert.deepEqual(r.input, input)
  assert.equal(r.note, "")
  assert.deepEqual((await call("shell", { command: "ls" })).input, { command: "ls" })
})

test("the note is added to an error too", async () => {
  const { call } = await host()
  const r = await call("edit", { path: "A.cs", edits: JSON.stringify([{ oldText: "a", newText: "b" }]) }, "error")
  assert.match(r.note, /^failed\n\ntool-repair/)
})

test("an edits value that can't be read is left for OpenCode to reject", async () => {
  const { call } = await host()
  const r = await call("edit", { path: "A.cs", edits: "not json" })
  assert.deepEqual(r.input, { path: "A.cs", edits: "not json" })
})

const field = (tag, description, optional = false, checks = []) =>
  ({ ast: { _tag: tag, checks, annotations: { description }, context: optional ? { isOptional: true } : null } })

test("a tool's input is rebuilt as the same JSON Schema that lets other fields through", () => {
  const input = { fields: { path: field("String", "File to edit"), replaceAll: field("Boolean", "All?", true) } }
  assert.deepEqual(openSchema(input), {
    type: "object",
    properties: { path: { type: "string", description: "File to edit" }, replaceAll: { type: "boolean", description: "All?" } },
    required: ["path"],
    additionalProperties: true,
  })
})

test("a schema with other types or checks is left alone", () => {
  assert.equal(openSchema({ fields: { offset: field("Number", "n") } }), undefined)
  assert.equal(openSchema({ fields: { path: field("String", "p", false, [{}]) } }), undefined)
  assert.equal(openSchema({ type: "object" }), undefined)
  assert.equal(openSchema(undefined), undefined)
})

function tree(directory, files) {
  for (const f of files) {
    mkdirSync(join(directory, f, ".."), { recursive: true })
    writeFileSync(join(directory, f), "x\n")
  }
}

test("a path with an underscore lost or added is corrected, and the model is told", async () => {
  const { call, directory } = await host()
  tree(directory, ["cloud_save/models.py"])
  const r = await call("read", { path: "cloudsave/models.py" })
  assert.equal(r.input.path, "cloud_save/models.py")
  assert.match(r.note, /`cloudsave\/models.py` doesn't exist; used `cloud_save\/models.py`/)
  const r2 = await call("edit", { path: join(directory, "cloud__save/models.py"), oldString: "x", newString: "y" })
  assert.equal(r2.input.path, join(directory, "cloud_save/models.py"))
})

test("a long folder name with two letters dropped is corrected", async () => {
  const { call, directory } = await host()
  tree(directory, ["4ks_drfx3tl0qyp_ngwnqdc40000gp/T/a.md"])
  const r = await call("grep", { pattern: "x", path: join(directory, "4ks_drfx3tl0q_ngwnqdc40000gp/T/a.md") })
  assert.equal(r.input.path, join(directory, "4ks_drfx3tl0qyp_ngwnqdc40000gp/T/a.md"))
})

test("paths that could mean two things, or short names, are not guessed", async () => {
  const { call, directory } = await host()
  tree(directory, ["cloud_save/a.py", "cloud-save/a.py", "abc/a.py"])
  for (const path of ["cloudsave/a.py", "abd/a.py", "nothing/like/this.py"]) {
    const r = await call("read", { path })
    assert.equal(r.input.path, path)
    assert.equal(r.note, "")
  }
})

test("a write keeps its new file name but fixes the folder above it", async () => {
  const { call, directory } = await host()
  tree(directory, ["leader_board/services/old.py"])
  const r = await call("write", { path: "leaderboard/services/repeat_stats.py", content: "x" })
  assert.equal(r.input.path, "leader_board/services/repeat_stats.py")
  tree(directory, ["repeat_stats.py"])
  const r2 = await call("write", { path: "repeatstats.py", content: "x" })
  assert.equal(r2.input.path, "repeatstats.py")
})

test("absolute paths in a shell command and workdir are corrected only when the fix exists", async () => {
  const { call, directory } = await host()
  tree(directory, ["cloud_save/models.py"])
  const bad = join(directory, "cloudsave/models.py")
  const r = await call("shell", { command: `cat ${bad} && mkdir -p ${join(directory, "new_dir/sub")}`, workdir: join(directory, "cloudsave") })
  assert.equal(r.input.command, `cat ${join(directory, "cloud_save/models.py")} && mkdir -p ${join(directory, "new_dir/sub")}`)
  assert.equal(r.input.workdir, join(directory, "cloud_save"))
  assert.match(r.note, /a path in your command/)
})
