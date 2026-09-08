interface DesignerConfig {
    name: string
    role?: string
    fileKey: string
    framerUrl?: string
    avatar?: string
}
 
/** A member of the studio, as configured in DESIGNERS. */
interface StudioDesigner {
    name: string
    role?: string
    avatar?: string
    /** Figma display name, matched case-insensitively against version authors. */
    figmaHandle?: string
    /** Figma user id. More reliable than the handle when you have it. */
    figmaUserId?: string
    framerUrl?: string
}
 
/** Who last saved a file, from its version history. */
interface Editor {
    handle: string
    id: string
    at: string
}
 
interface ProjectFile {
    key: string
    name: string
    last_modified?: string
    thumbnail_url?: string
    /** Figma page names. Only present on files fetched individually by key. */
    pages?: string[]
    /** Folder this file was discovered in. Drives PUBLIC_FOLDER_NAMES. */
    folder?: string
}
 
type Trace = Array<{ call: string; status: number | string; note?: string }>
 
/** Stamped into every response so a stale deploy is obvious at a glance. */
const SERVICE_VERSION = "v7-studio-fallback"
 
const FIGMA = "https://api.figma.com"
 
/** Paths starting with /v2/ pass through; everything else is v1. */
const figmaUrl = (path: string) =>
    path.startsWith("/v2/") ? `${FIGMA}${path}` : `${FIGMA}/v1${path}`
 
const env = (k: string, d = "") => (process.env[k] ?? d).trim()
const list = (k: string) =>
    env(k)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
 
/* ------------------------------------------------------------------ *
 * Caches. A warm lambda keeps these between requests, which is what
 * stops every page view from spending ~120 Figma calls and hitting the
 * rate limit. A cold start just refetches.
 * ------------------------------------------------------------------ */
let folderCache: { at: number; folders: Array<{ id: string; name?: string }> } | null =
    null
let fileCache: { at: number; files: ProjectFile[] } | null = null
const FOLDER_TTL_MS = 60 * 60 * 1000 // folders change rarely
 
/** Cap on version-history lookups per scan, to stay inside Figma's limits. */
const MAX_ATTRIBUTIONS = 8
/** Bucket for edits by someone not on the roster. */
const UNATTRIBUTED = "\u0000unattributed"
 
/** Set true by figmaGet when Figma says we are going too fast. */
let rateLimited = false
/** Why attribution could not run, if it could not. Public-safe text only. */
let attributionProblem = ""
 
async function figmaGet<T>(
    path: string,
    token: string,
    trace: Trace
): Promise<T | null> {
    const label = path.split("?")[0]
    try {
        const res = await fetch(figmaUrl(path), {
            headers: { "X-Figma-Token": token },
        })
        if (!res.ok) {
            if (res.status === 429) rateLimited = true
            let note = ""
            try {
                const body: any = await res.json()
                note = body?.err || body?.message || ""
            } catch {
                /* non-JSON error body */
            }
            trace.push({ call: label, status: res.status, note })
            return null
        }
        trace.push({ call: label, status: res.status })
        return (await res.json()) as T
    } catch (e: any) {
        trace.push({
            call: label,
            status: "network_error",
            note: String(e?.message || e),
        })
        return null
    }
}
 
function hhmm(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(
        d.getUTCMinutes()
    ).padStart(2, "0")}`
}
 
/** Top-level folders for each team, cached for an hour. */
async function teamFolders(
    teamIds: string[],
    token: string,
    trace: Trace
): Promise<Array<{ id: string; name?: string }>> {
    if (folderCache && Date.now() - folderCache.at < FOLDER_TTL_MS) {
        trace.push({
            call: "folders",
            status: "cached",
            note: `${folderCache.folders.length} folder(s)`,
        })
        return folderCache.folders
    }
    const out: Array<{ id: string; name?: string }> = []
    for (const teamId of teamIds) {
        const res = await figmaGet<{
            folders?: Array<{ id: string; name?: string }>
        }>(`/v2/teams/${teamId}/folders`, token, trace)
        const folders = res?.folders || []
        trace.push({
            call: `team ${teamId}`,
            status: res ? "ok" : "failed",
            note: `${folders.length} folder(s)`,
        })
        for (const f of folders) if (f?.id) out.push(f)
    }
    if (out.length) folderCache = { at: Date.now(), folders: out }
    return out
}
 
/**
 * Every file across every configured team, newest first.
 *
 * Figma renamed "projects" to "folders"; the v1 /teams/:id/projects endpoint
 * needs the retired projects:read scope, so this uses the v2 Folders API.
 * Stops early on a rate limit and lets the caller fall back to cache.
 */
async function filesAcrossTeams(
    teamIds: string[],
    token: string,
    trace: Trace
): Promise<ProjectFile[]> {
    const out: ProjectFile[] = []
    const scanSub = env("SCAN_SUBFOLDERS").toLowerCase() === "true"
    const seen = new Set<string>()
 
    const readFolder = async (
        folder: { id: string; name?: string },
        depth: number
    ): Promise<void> => {
        if (rateLimited || seen.has(folder.id) || depth > 3) return
        seen.add(folder.id)
 
        const files = await figmaGet<{ files?: ProjectFile[] }>(
            `/v2/folders/${folder.id}/files`,
            token,
            trace
        )
        for (const f of files?.files || []) {
            if (f?.key) out.push({ ...f, folder: folder.name || "" })
        }
 
        if (scanSub && !rateLimited) {
            const sub = await figmaGet<{
                folders?: Array<{ id: string; name?: string }>
            }>(`/v2/folders/${folder.id}/folders`, token, trace)
            for (const child of sub?.folders || []) {
                if (child?.id) await readFolder(child, depth + 1)
            }
        }
    }
 
    for (const folder of await teamFolders(teamIds, token, trace)) {
        await readFolder(folder, 0)
    }
 
    const unique = new Map<string, ProjectFile>()
    for (const f of out) unique.set(f.key, f)
    return [...unique.values()]
}
 
/** Watch a plain list of file keys. Needs only file_content:read. */
async function filesByKeys(
    keys: string[],
    token: string,
    trace: Trace
): Promise<ProjectFile[]> {
    const out: ProjectFile[] = []
    for (const key of keys) {
        const file = await figmaGet<{
            name: string
            lastModified: string
            document?: any
        }>(`/files/${key}?depth=1`, token, trace)
        if (!file) continue
        out.push({
            key,
            name: file.name,
            last_modified: file.lastModified,
            pages: (file.document?.children || [])
                .map((c: any) => (c?.name || "").trim())
                .filter(Boolean),
        })
    }
    return out
}
 
/**
 * May this file be put on a public web page?
 *
 * An embed publishes the ENTIRE Figma file to anyone who opens the site, so
 * this stays deny-by-default. A file qualifies by living in an approved
 * folder, or by being named outright.
 */
function makeCanEmbed(
    allowAll: boolean,
    allowKeys: Set<string>,
    allowFolders: Set<string>
) {
    return (file: { key: string; folder?: string }) => {
        if (allowAll) return true
        if (allowKeys.has(file.key)) return true
        const folder = (file.folder || "").trim().toLowerCase()
        return !!folder && allowFolders.has(folder)
    }
}
 
const byNewest = (a: ProjectFile, b: ProjectFile) =>
    Date.parse(b.last_modified || "") - Date.parse(a.last_modified || "")
 
/**
 * Who most recently saved this file.
 *
 * Figma's file endpoints carry lastModified but no author, so attribution has
 * to come from version history. Versions are checkpoints rather than
 * keystrokes, so this is "who made the last saved version", which is the best
 * signal the REST API offers.
 */
async function lastEditor(
    key: string,
    token: string,
    trace: Trace
): Promise<Editor | null> {
    const before = trace.length
    const res = await figmaGet<{
        versions?: Array<{
            id: string
            created_at?: string
            user?: { id?: string; handle?: string }
        }>
    }>(`/files/${key}/versions?page_size=1`, token, trace)
 
    if (!res) {
        const failure = trace[before]
        const code = failure?.status
        // Figma's own error text names the exact scope it wants. Quote it
        // verbatim rather than guessing — the scope names have been renamed
        // more than once.
        const note = (failure?.note || "").trim()
        attributionProblem =
            code === 429
                ? "Figma rate-limited the version lookups"
                : `version history unavailable (${String(code)})${
                      note ? ` \u2014 Figma says: ${note}` : ""
                  }`
    }
 
    const versions = [...(res?.versions || [])].sort(
        (a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || "")
    )
    const top = versions[0]
    if (!top?.user) return null
    return {
        handle: (top.user.handle || "").trim(),
        id: (top.user.id || "").trim(),
        at: top.created_at || "",
    }
}
 
/** Match an editor to a configured designer. Id wins over handle. */
function matchDesigner(
    editor: Editor | null,
    team: StudioDesigner[]
): StudioDesigner | null {
    if (!editor) return null
    if (editor.id) {
        const byId = team.find((d) => d.figmaUserId && d.figmaUserId === editor.id)
        if (byId) return byId
    }
    const handle = editor.handle.toLowerCase()
    if (!handle) return null
    return (
        team.find((d) => (d.figmaHandle || "").trim().toLowerCase() === handle) ||
        // fall back to the designer's own name, so a handle of "Ubaid Khan"
        // still matches a designer configured only as "Ubaid"
        team.find((d) => {
            const n = d.name.trim().toLowerCase()
            return !!n && (handle === n || handle.startsWith(n + " "))
        }) ||
        null
    )
}
 
export default async function handler(req: any, res: any) {
    const trace: Trace = [] // request-local: warm lambdas run requests concurrently
    rateLimited = false
 
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    if (req.method === "OPTIONS") return res.status(204).end()
 
    const token = env("FIGMA_TOKEN")
    const teamIds = list("FIGMA_TEAM_IDS")
    const watchKeys = list("WATCH_FILE_KEYS")
    const allowKeys = new Set(list("PUBLIC_FILE_KEYS"))
    const allowFolders = new Set(
        list("PUBLIC_FOLDER_NAMES").map((n) => n.toLowerCase())
    )
    const allowAll = env("ALLOW_ALL_EMBEDS").toLowerCase() === "true"
    const canEmbed = makeCanEmbed(allowAll, allowKeys, allowFolders)
 
    /**
     * The studio roster. Order here is the order the page shows them in.
     *
     * Accepts a plain comma-separated list as well as JSON, because a long JSON
     * string is easy to mangle when pasting into a hosting dashboard — and a
     * silent parse failure looks exactly like "the feature is broken".
     */
    let team: StudioDesigner[] = []
    let rosterStatus = "not set"
    const rawTeam = env("DESIGNERS")
    if (rawTeam) {
        if (rawTeam.startsWith("[")) {
            try {
                const parsed = JSON.parse(rawTeam)
                if (Array.isArray(parsed)) {
                    team = parsed.filter(
                        (d) => d && typeof d.name === "string" && d.name.trim()
                    )
                    rosterStatus = `ok, JSON (${team.length})`
                } else {
                    rosterStatus = "invalid: JSON is not an array"
                }
            } catch (e: any) {
                rosterStatus = `invalid JSON: ${String(e?.message || e)}`
            }
        } else {
            team = rawTeam
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
                .map((entry) => {
                    const [name, handle] = entry.split("=")
                    return {
                        name: (name || "").trim(),
                        role: env("DESIGNER_ROLE", "Product Designer"),
                        figmaHandle: (handle || "").trim() || undefined,
                    }
                })
                .filter((d) => !!d.name)
            rosterStatus = `ok, simple list (${team.length})`
        }
    }
    const windowMin = Number(env("LIVE_WINDOW_MINUTES", "10")) || 10
    const windowMs = windowMin * 60 * 1000
    const refreshMs = (Number(env("REFRESH_SECONDS", "180")) || 180) * 1000
    const now = Date.now()
 
    // Diagnostics name folders and files, so they are never public.
    const debugKey = env("DEBUG_KEY")
    const asked = String(req.query?.debug || "")
    const showDiagnostics = !!debugKey && asked === debugKey
 
    res.setHeader(
        "Cache-Control",
        showDiagnostics
            ? "private, no-store"
            : `public, s-maxage=${Math.floor(refreshMs / 1000)}, stale-while-revalidate=600`
    )
 
    let explicit: DesignerConfig[] = []
    try {
        const raw = env("LIVE_STUDIO_CONFIG")
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) {
                explicit = parsed.filter((d) => d && d.name && d.fileKey)
            }
        }
    } catch {
        /* ignore malformed config */
    }
 
    const fail = (error: string) =>
        res.status(200).json({
            generatedAt: new Date(now).toISOString(),
            isLive: false,
            designers: [],
            activities: [],
            error,
        })
 
    if (!token) return fail("missing_token")
    if (!teamIds.length && !watchKeys.length && !explicit.length)
        return fail("missing_config")
 
    /* ---------------- explicit files (per-designer mapping) ------------- *
     * DESIGNERS is the modern roster and supersedes LIVE_STUDIO_CONFIG. Running
     * both produced duplicate panels for the same person, so the roster wins.
     * ------------------------------------------------------------------- */
    if (team.length) explicit = []
 
    const designers: any[] = []
    for (const cfg of explicit) {
        const file = await figmaGet<{
            name: string
            lastModified: string
            document?: any
        }>(`/files/${cfg.fileKey}?depth=1`, token, trace)
        if (!file) continue
        const modified = Date.parse(file.lastModified)
        const isLive = !Number.isNaN(modified) && now - modified <= windowMs
        const embeddable = canEmbed({ key: cfg.fileKey })
        const pages = (file.document?.children || [])
            .map((c: any) => (c?.name || "").trim())
            .filter(Boolean)
        designers.push({
            name: cfg.name,
            role: cfg.role || "",
            avatar: cfg.avatar || "",
            isLive,
            project: embeddable ? file.name : "A private project",
            task: embeddable ? pages[0] || "" : "",
            platform: "figma",
            sessionStartedAt: isLive ? file.lastModified : "",
            lastUpdated: file.lastModified,
            figmaUrl: embeddable
                ? `https://www.figma.com/design/${cfg.fileKey}/${encodeURIComponent(
                      file.name.replace(/\s+/g, "-")
                  )}`
                : "",
            framerUrl: cfg.framerUrl || "",
            privateSession: isLive && !embeddable,
        })
    }
 
    /* ---------------- broad detection ----------------------------------- */
    let activities: Array<{ time: string; title: string; designer?: string }> = []
    let seenEditors: Editor[] = []
    let all: ProjectFile[] = []
    let scanned = false
 
    if (teamIds.length || watchKeys.length) {
        const fresh = fileCache && now - fileCache.at < refreshMs
        if (fresh) {
            all = fileCache!.files
            trace.push({
                call: "scan",
                status: "cached",
                note: `${all.length} file(s), ${Math.round(
                    (now - fileCache!.at) / 1000
                )}s old`,
            })
        } else {
            scanned = true
            const fromTeams = teamIds.length
                ? await filesAcrossTeams(teamIds, token, trace)
                : []
            const fromKeys = watchKeys.length
                ? await filesByKeys(watchKeys, token, trace)
                : []
 
            // Merge over the previous snapshot so a rate-limited partial scan
            // never loses files we already knew about.
            const merged = new Map<string, ProjectFile>()
            for (const f of fileCache?.files || []) merged.set(f.key, f)
            for (const f of [...fromTeams, ...fromKeys]) merged.set(f.key, f)
            all = [...merged.values()]
            fileCache = { at: now, files: all }
        }
        all = [...all].sort(byNewest)
 
        const recent = all.filter((f) => {
            const t = Date.parse(f.last_modified || "")
            return !Number.isNaN(t) && now - t <= windowMs
        })
        // Attribute each recent file to whoever saved it last. Only recent
        // files cost a call, so an idle studio costs nothing.
        attributionProblem = ""
        const editors = new Map<string, Editor | null>()
        const attributed = new Map<string, ProjectFile[]>()
        const editorsSeen: Editor[] = []
 
        if (team.length) {
            for (const f of recent.slice(0, MAX_ATTRIBUTIONS)) {
                const editor = await lastEditor(f.key, token, trace)
                editors.set(f.key, editor)
                if (editor) editorsSeen.push(editor)
                const who = matchDesigner(editor, team)
                const bucket = who ? who.name : UNATTRIBUTED
                attributed.set(bucket, [...(attributed.get(bucket) || []), f])
            }
        }
 
        // An edit by someone who is not on the roster is not a bug in the
        // token — say so plainly rather than leaving the page silently dead.
        if (!attributionProblem && (attributed.get(UNATTRIBUTED) || []).length) {
            const names = [
                ...new Set(editorsSeen.map((e) => e.handle).filter(Boolean)),
            ]
            attributionProblem = names.length
                ? `recent edits were made by ${names.join(
                      ", "
                  )}, who is not in DESIGNERS — add them, or map an existing name with Name=Figma Display Name`
                : "recent edits could not be matched to anyone on the roster"
        }
 
        // One entry per configured designer, always — the page lists the whole
        // team and marks who is actually working.
        for (const person of team) {
            const mine = (attributed.get(person.name) || []).sort(byNewest)
            const own = mine[0]
            const embeddable = own ? canEmbed(own) : false
            designers.push({
                name: person.name,
                role: person.role || "",
                avatar: person.avatar || "",
                isLive: !!own,
                project: !own
                    ? ""
                    : embeddable
                      ? own.name
                      : "A private project",
                task: own && embeddable ? own.pages?.[0] || "" : "",
                platform: "figma",
                sessionStartedAt: own
                    ? mine[mine.length - 1]?.last_modified ||
                      own.last_modified ||
                      ""
                    : "",
                lastUpdated: own?.last_modified || "",
                figmaUrl:
                    own && embeddable
                        ? `https://www.figma.com/design/${own.key}/${encodeURIComponent(
                              (own.name || "file").replace(/\s+/g, "-")
                          )}`
                        : "",
                framerUrl: person.framerUrl || "",
                privateSession: !!own && !embeddable,
            })
        }
 
        /* When a genuine edit cannot be attributed, the studio is still
           working. Show that under a neutral studio entry rather than either
           going dark (dishonest by omission) or crediting a designer at
           random (dishonest outright). */
        const orphans = (attributed.get(UNATTRIBUTED) || []).sort(byNewest)
        if (team.length && attributionProblem && orphans.length) {
            const lead = orphans[0]
            const embeddable = canEmbed(lead)
            designers.push({
                name: env("STUDIO_NAME", "LDS Studio"),
                role: "Studio session",
                avatar: "",
                isLive: true,
                project: embeddable ? lead.name : "A private project",
                task: embeddable ? lead.pages?.[0] || "" : "",
                platform: "figma",
                sessionStartedAt:
                    orphans[orphans.length - 1]?.last_modified ||
                    lead.last_modified ||
                    "",
                lastUpdated: lead.last_modified || "",
                figmaUrl: embeddable
                    ? `https://www.figma.com/design/${lead.key}/${encodeURIComponent(
                          (lead.name || "file").replace(/\s+/g, "-")
                      )}`
                    : "",
                framerUrl: "",
                privateSession: !embeddable,
            })
        }
 
        // No DESIGNERS configured: keep the original single-designer shape.
        const active = recent[0]
        if (!team.length && active && !explicit.some((c) => c.fileKey === active.key)) {
            const embeddable = canEmbed(active)
            designers.push({
                name: env("DESIGNER_NAME", "Arham"),
                role: env("DESIGNER_ROLE", "Product Designer"),
                avatar: "",
                isLive: true,
                project: embeddable ? active.name : "A private project",
                task: embeddable ? active.pages?.[0] || "" : "",
                platform: "figma",
                sessionStartedAt:
                    recent[recent.length - 1]?.last_modified ||
                    active.last_modified ||
                    "",
                lastUpdated: active.last_modified || "",
                figmaUrl: embeddable
                    ? `https://www.figma.com/design/${active.key}/${encodeURIComponent(
                          (active.name || "file").replace(/\s+/g, "-")
                      )}`
                    : "",
                framerUrl: "",
                privateSession: !embeddable,
            })
        } else if (!team.length && !explicit.length && !active) {
            designers.push({
                name: env("DESIGNER_NAME", "Arham"),
                role: env("DESIGNER_ROLE", "Product Designer"),
                avatar: "",
                isLive: false,
                project: "",
                task: "",
                platform: "figma",
                sessionStartedAt: "",
                lastUpdated: all[0]?.last_modified || "",
                figmaUrl: "",
                framerUrl: "",
                privateSession: false,
            })
        }
 
        activities = recent
            .slice(0, 6)
            .map((f) => {
                const who = matchDesigner(editors.get(f.key) || null, team)
                const what = canEmbed(f)
                    ? `Updated ${f.name}`
                    : "Worked on a private project"
                return {
                    time: hhmm(f.last_modified || ""),
                    title: who ? `${who.name} — ${what}` : what,
                    designer: who?.name || "",
                }
            })
            .filter((a) => a.time)
 
        seenEditors = editorsSeen
    }
 
    // Last guard against two panels for one person: keep the working entry.
    const byName = new Map<string, any>()
    for (const d of designers) {
        const key = (d.name || "").trim().toLowerCase()
        const seen = byName.get(key)
        if (!seen) byName.set(key, d)
        else if (!seen.isLive && d.isLive) byName.set(key, d)
        else if (seen.isLive === d.isLive) {
            const a = Date.parse(seen.lastUpdated || "")
            const b = Date.parse(d.lastUpdated || "")
            if (!Number.isNaN(b) && (Number.isNaN(a) || b > a)) byName.set(key, d)
        }
    }
    designers.length = 0
    designers.push(...byName.values())
 
    const live = designers.filter((d) => d.isLive)
 
    /* ---------------- public payload ------------------------------------ *
     * Every field below is world-readable. No folder names, no file names
     * outside the embed allowlist, no counts that hint at client volume.
     * ------------------------------------------------------------------- */
    const payload: any = {
        generatedAt: new Date(now).toISOString(),
        // Bumped whenever this file changes, so "is my paste actually live?"
        // is answerable without the debug key.
        service: SERVICE_VERSION,
        // Safe in public: it reports only whether the roster parsed, and the
        // roster is the same set of names the page already displays.
        roster: rosterStatus,
        // Empty when attribution is working. Names Figma display names only,
        // which are the studio's own people, never client or file data.
        attribution: attributionProblem,
        isLive: live.length > 0,
        liveWindowMinutes: windowMin,
        designers,
        activities,
    }
 
    if (showDiagnostics) {
        payload.diagnostics = {
            watching: [
                teamIds.length ? `${teamIds.length} team(s)` : "",
                watchKeys.length ? `${watchKeys.length} listed file(s)` : "",
            ]
                .filter(Boolean)
                .join(" + "),
            filesWatched: all.length,
            teamsConfigured: teamIds.length,
            embedPolicy: allowAll
                ? "ALL FILES — UNRESTRICTED. Client work will be published."
                : `${allowFolders.size} folder(s) + ${allowKeys.size} file(s)`,
            foldersSeen: [
                ...new Set(all.map((f) => f.folder).filter(Boolean)),
            ].sort(),
            scannedThisRequest: scanned,
            rateLimited,
            refreshSeconds: Math.floor(refreshMs / 1000),
            hint: rateLimited
                ? "Figma rate-limited the scan. Cached results were kept. Raise REFRESH_SECONDS or turn off SCAN_SUBFOLDERS."
                : all.length === 0 && teamIds.length
                  ? "No files found. Check folders:read scope; files in Drafts are invisible to this API."
                  : "",
            rosterNames: team.map((d) => d.name),
            editorsSeen: seenEditors.map((e) => e.handle).filter(Boolean),
            calls: trace,
        }
    }
 
    return res.status(200).json(payload)
}