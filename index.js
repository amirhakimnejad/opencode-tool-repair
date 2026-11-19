// opencode-tool-repair (OpenCode 2.x plugin): fixes tool calls that local models
// send in another agent's format, before OpenCode rejects them.
//
// Some local models (Flint, for one) were trained on agents whose tools take
// different argument names. Their calls fail OpenCode's checks, the model retries
// the same call, and nothing changes. This plugin rewrites those calls:
//   - edit with an `edits` list (an array or a JSON string of {oldText, newText}):
//       one change becomes a normal edit; several are applied together when each
//       old text is found exactly once, and otherwise the first is applied and
//       the model is told to send the rest one per call,
//   - other names for the same argument: oldText/old_string -> oldString,
//       newText/new_string -> newString, file_path/filePath -> path, and so on,
//   - empty or text values in number and true/false fields ("offset": ""),
//       and an empty "" key,
//   - a garbled newString ("new": "String" plus the text under a "" key),
//       and a note when an edit has no newString at all,
//   - mistyped paths (an underscore lost or added, a couple of letters lost in a
//       long folder name) when exactly one existing path fits.
// So that those other names reach it, the edit and write tools accept extra
// fields (see openSchema); the fields models are shown don't change.
// When a call was changed, the model is told the right form, so it learns it.
// Remove it from your plugin list (or delete the file) to turn it off.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

const PATH_ALIASES = ["file_path", "filePath", "filepath", "file", "filename"]
const EDIT_ALIASES = {
  oldString: ["oldText", "old_string", "old_str", "old", "search", "find", "edString"],
  newString: ["newText", "new_string", "new_str", "new", "replace", "replacement"],
  replaceAll: ["replace_all"],
}
const NUMBER_FIELDS = new Set(["offset", "limit", "timeout"])
const BOOLEAN_FIELDS = new Set(["replaceAll", "background", "hidden", "literal", "caseSensitive"])
const OPTIONAL_TEXT_FIELDS = new Set(["workdir"])
const FILE_TOOLS = new Set(["read", "edit", "write"])
const PATH_TOOLS = new Set(["read", "edit", "write", "glob", "grep"])
const MAX_NOTES = 1000

function rename(input, to, aliases) {
  if (input[to] !== undefined) return false
  for (const alias of aliases) {
    if (input[alias] !== undefined) {
      input[to] = input[alias]
      delete input[alias]
      return true
    }
  }
  return false
}

// Cleans empty and mistyped optional fields. Returns true when it changed something.
function cleanFields(input) {
  let changed = false
  if ("" in input) {
    delete input[""]
    changed = true
  }
  for (const [key, value] of Object.entries(input)) {
    const optional = NUMBER_FIELDS.has(key) || BOOLEAN_FIELDS.has(key) || OPTIONAL_TEXT_FIELDS.has(key)
    if (optional && (value === "" || value === null)) {
      delete input[key]
      changed = true
    } else if (NUMBER_FIELDS.has(key) && typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
      input[key] = Number(value)
      changed = true
    } else if (BOOLEAN_FIELDS.has(key) && (value === "true" || value === "false")) {
      input[key] = value === "true"
      changed = true
    }
  }
  return changed
}

function parseEdits(value) {
  let list = value
  if (typeof list === "string") {
    try {
      list = JSON.parse(list)
    } catch {
      return undefined
    }
  }
  if (list && typeof list === "object" && !Array.isArray(list)) list = [list]
  if (!Array.isArray(list) || list.length === 0) return undefined
  const edits = []
  for (const item of list) {
    if (!item || typeof item !== "object") return undefined
    const edit = { ...item }
    for (const [to, aliases] of Object.entries(EDIT_ALIASES)) rename(edit, to, aliases)
    if (typeof edit.oldString !== "string" || typeof edit.newString !== "string") return undefined
    edits.push({ oldString: edit.oldString, newString: edit.newString, ...(edit.replaceAll === true ? { replaceAll: true } : {}) })
  }
  return edits
}

function count(text, part) {
  if (!part) return 0
  let n = 0
  for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + part.length)) n++
  return n
}

// Applies every edit to the file's text when each old text is found exactly once
// (or the edit says replaceAll). Returns the new text, or undefined if any doesn't fit.
function applyAll(text, edits) {
  const crlf = text.includes("\r\n")
  for (const edit of edits) {
    let { oldString, newString } = edit
    if (crlf && !oldString.includes("\r")) {
      oldString = oldString.replace(/\n/g, "\r\n")
      newString = newString.replace(/\n/g, "\r\n")
    }
    const found = count(text, oldString)
    if (found === 0 || (found > 1 && !edit.replaceAll)) return undefined
    text = edit.replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
  }
  return text
}

const squash = (path) => path.replace(/[^a-z0-9]/gi, "").toLowerCase()

// Edit distance, giving up (returning max + 1) once it can't stay within max.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, cur[j])
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

// Folder entries a mistyped name could stand for: the same letters and digits
// (an underscore or dash added or lost), else a name at most two letters off
// when the name is long enough for that to be unambiguous.
function lookalikes(dir, name) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const want = squash(name)
  if (!want) return []
  const same = entries.filter((e) => squash(e) === want)
  if (same.length || want.length < 8) return same
  return entries.filter((e) => distance(squash(e), want, 2) <= 2)
}

const MAX_TRIES = 200

// Finds the one existing path a mistyped absolute path stands for. With
// `newLeaf`, the last part may be a file that doesn't exist yet (a write), so
// only the folders above it are looked up. Returns undefined when the path
// exists, when nothing fits, or when more than one path fits.
export function findPath(path, { newLeaf = false } = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || existsSync(path)) return undefined
  const parts = path.split(sep).filter(Boolean)
  const found = []
  let tries = 0
  const walk = (dir, i) => {
    if (found.length > 1 || ++tries > MAX_TRIES) return
    if (i === parts.length) {
      found.push(dir)
      return
    }
    const name = parts[i]
    const next = join(dir, name)
    const last = i === parts.length - 1
    if (existsSync(next)) return walk(next, i + 1)
    if (last && newLeaf) return walk(next, i + 1)
    for (const entry of lookalikes(dir, name)) walk(join(dir, entry), i + 1)
  }
  walk(sep, 0)
  if (found.length !== 1 || tries > MAX_TRIES) return undefined
  const fixed = found[0]
  if (newLeaf ? !existsSync(dirname(fixed)) : !existsSync(fixed)) return undefined
  return fixed === path ? undefined : fixed
}

const isDir = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// Absolute paths inside a shell command that don't exist but stand for exactly
// one path that does. Paths that are new (mkdir, a file to create) are left alone.
const COMMAND_PATH = /(^|[\s'"=:(])(\/[^\s'"`;|&<>()$*?]+)/g
export function fixCommandPaths(command) {
  if (typeof command !== "string") return undefined
  let changed = false
  const out = command.replace(COMMAND_PATH, (all, before, path) => {
    const trimmed = path.replace(/[/.,]+$/, "")
    if (trimmed.split("/").filter(Boolean).length < 3) return all
    const fixed = findPath(trimmed)
    if (!fixed) return all
    changed = true
    return before + fixed + path.slice(trimmed.length)
  })
  return changed ? out : undefined
}

// OpenCode drops argument names a tool doesn't declare before plugins see the call,
// so `edits` or `old_string` would be gone by then. This rebuilds a tool's input
// as the same JSON Schema (names, types, descriptions, required fields) that also
// lets other fields through. Only tools whose fields are all plain text or
// true/false are changed; anything else is left as it is.
const JSON_TYPES = { String: "string", Boolean: "boolean" }
export function openSchema(input) {
  const fields = input?.fields
  if (!fields || typeof fields !== "object") return undefined
  const properties = {}
  const required = []
  for (const [name, schema] of Object.entries(fields)) {
    const ast = schema?.ast
    const type = JSON_TYPES[ast?._tag]
    if (!type || (Array.isArray(ast.checks) && ast.checks.length)) return undefined
    const description = ast.annotations?.description
    properties[name] = { type, ...(typeof description === "string" ? { description } : {}) }
    if (!ast.context?.isOptional) required.push(name)
  }
  return { type: "object", properties, required, additionalProperties: true }
}
const OPEN_TOOLS = ["edit", "write"]

export function createPlugin() {
  const notes = new Map() // call id -> note for the model

  function note(call, text) {
    if (notes.size > MAX_NOTES) notes.clear()
    notes.set(call.id, text)
  }

  return {
    id: "tool-repair",
    async setup(ctx) {
      const root = ctx?.location?.directory

      const resolve = (path) => (isAbsolute(path) ? path : root ? join(root, path) : undefined)

      if (typeof ctx.tool.transform === "function") {
        await ctx.tool.transform((tools) => {
          for (const name of OPEN_TOOLS) {
            const open = openSchema(tools.get(name)?.input)
            if (open) tools.update(name, (tool) => { tool.input = open })
          }
        })
      }

      await ctx.tool.hook("execute.before", (call) => {
        const input = call.input
        if (!input || typeof input !== "object" || Array.isArray(input)) return
        let changed = false
        if (call.tool === "edit" && typeof input[""] === "string" && input.newString === undefined) {
          // A garbled key: "newString" split into "new": "String" and "": <the text>.
          input.newString = input[""]
          delete input[""]
          if (input.new === "String") delete input.new
          changed = true
        }
        changed = cleanFields(input) || changed
        const pathNotes = []

        if (FILE_TOOLS.has(call.tool)) changed = rename(input, "path", PATH_ALIASES) || changed

        if (call.tool === "write") changed = rename(input, "content", ["contents", "text", "file_text", "data"]) || changed

        if (PATH_TOOLS.has(call.tool) && typeof input.path === "string") {
          const full = resolve(input.path)
          const fixed = full && findPath(full, { newLeaf: call.tool === "write" })
          if (fixed) {
            const was = input.path
            input.path = isAbsolute(was) ? fixed : relative(root, fixed)
            pathNotes.push(`\`${was}\` doesn't exist; used \`${input.path}\``)
          }
        }

        if (call.tool === "shell") {
          changed = rename(input, "command", ["cmd", "script"]) || changed
          const dir = input.workdir
          if (typeof dir === "string" && !existsSync(dir)) {
            const fixed = root && squash(dir) === squash(root) ? root : findPath(dir)
            if (fixed && isDir(fixed)) {
              input.workdir = fixed
              pathNotes.push(`workdir \`${dir}\` doesn't exist; used \`${fixed}\``)
            }
          }
          const command = fixCommandPaths(input.command)
          if (command) {
            input.command = command
            pathNotes.push("a path in your command doesn't exist; it was corrected to the existing one")
          }
        }

        if (call.tool === "edit") {
          for (const [to, aliases] of Object.entries(EDIT_ALIASES)) changed = rename(input, to, aliases) || changed
          changed = cleanFields(input) || changed // a renamed replace_all may hold "true"
          if (input.edits !== undefined && input.oldString === undefined) {
            const edits = parseEdits(input.edits)
            if (edits) {
              delete input.edits
              const rest = edits.slice(1)
              let content
              if (rest.length && typeof input.path === "string") {
                const file = resolve(input.path)
                try {
                  if (file) content = applyAll(readFileSync(file, "utf8"), edits)
                } catch {}
              }
              if (content !== undefined) {
                // All changes fit: write them in one go.
                call.tool = "write"
                for (const key of Object.keys(input)) if (key !== "path") delete input[key]
                input.content = content
                note(call, `tool-repair: applied all ${edits.length} changes from your \`edits\` list. ` +
                  "OpenCode's edit tool takes one change per call: {path, oldString, newString}.")
                return
              }
              Object.assign(input, edits[0])
              note(call, rest.length
                ? `tool-repair: OpenCode's edit tool takes one change per call ({path, oldString, newString}), so only the ` +
                  `first of your ${edits.length} changes was attempted. Send the other ${rest.length} as separate edit calls.`
                : "tool-repair: edit takes {path, oldString, newString}, not an `edits` list; your change was sent that way.")
              return
            }
          }
          if (typeof input.oldString === "string" && input.newString === undefined && input.edits === undefined) {
            note(call, "tool-repair: your edit call had no newString, so nothing changed. Send path, oldString and " +
              "newString together in one call; to replace most of a file, use write.")
          }
        }

        if (changed && !notes.has(call.id)) {
          note(call, `tool-repair: your ${call.tool} call had argument names or values OpenCode doesn't accept; ` +
            `it was sent as ${JSON.stringify(Object.keys(input))}. Use those names next time.`)
        }
        if (pathNotes.length) {
          const text = `tool-repair: ${pathNotes.join("; ")}. Copy paths exactly as tools print them.`
          note(call, notes.has(call.id) ? notes.get(call.id) + "\n" + text : text)
        }
      })

      await ctx.tool.hook("execute.after", (call) => {
        const text = notes.get(call.id)
        if (text === undefined) return
        notes.delete(call.id)
        if (call.status === "completed" && Array.isArray(call.result?.content)) {
          call.result.content.push({ type: "text", text: "\n\n" + text })
        } else if (call.error && typeof call.error.message === "string") {
          try {
            call.error.message += "\n\n" + text
          } catch {}
        }
      })
    },
  }
}

export default createPlugin()
