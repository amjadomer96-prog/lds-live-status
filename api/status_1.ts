interface DesignerConfig {
    name: string
    role?: string
    fileKey: string
    framerUrl?: string
    avatar?: string
}
 
interface ProjectFile {
    key: string
    name: string
    last_modified?: string
    thumbnail_url?: string
    /** Figma page names. Only present on files fetched individually by key. */
    pages?: string[]
}
 
type Trace = Array<{ call: string; status: number | string; note?: string }>
 
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
 
/** Set true by figmaGet when Figma says we are going too fast. */
let rateLimited = false
 
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
        for (const f of files?.files || []) if (f?.key) out.push(f)
 
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
 
const byNewest = (a: ProjectFile, b: ProjectFile) =>
    Date.parse(b.last_modified || "") - Date.parse(a.last_modified || "")
 
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
    const allowAll = env("ALLOW_ALL_EMBEDS").toLowerCase() === "true"
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
 
    /* ---------------- explicit files (per-designer mapping) ------------- */
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
        const canEmbed = allowAll || allowKeys.has(cfg.fileKey)
        const pages = (file.document?.children || [])
            .map((c: any) => (c?.name || "").trim())
            .filter(Boolean)
        designers.push({
            name: cfg.name,
            role: cfg.role || "",
            avatar: cfg.avatar || "",
            isLive,
            project: canEmbed ? file.name : "A private project",
            task: canEmbed ? pages[0] || "" : "",
            platform: "figma",
            sessionStartedAt: isLive ? file.lastModified : "",
            lastUpdated: file.lastModified,
            figmaUrl: canEmbed
                ? `https://www.figma.com/design/${cfg.fileKey}/${encodeURIComponent(
                      file.name.replace(/\s+/g, "-")
                  )}`
                : "",
            framerUrl: cfg.framerUrl || "",
            privateSession: isLive && !canEmbed,
        })
    }
 
    /* ---------------- broad detection ----------------------------------- */
    let activities: Array<{ time: string; title: string }> = []
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
        const active = recent[0]
        const coveredByExplicit = active
            ? explicit.some((c) => c.fileKey === active.key)
            : false
 
        if (active && !coveredByExplicit) {
            const canEmbed = allowAll || allowKeys.has(active.key)
            designers.push({
                name: env("DESIGNER_NAME", "Arham"),
                role: env("DESIGNER_ROLE", "Product Designer"),
                avatar: "",
                isLive: true,
                project: canEmbed ? active.name : "A private project",
                task: canEmbed ? active.pages?.[0] || "" : "",
                platform: "figma",
                sessionStartedAt:
                    recent[recent.length - 1]?.last_modified ||
                    active.last_modified ||
                    "",
                lastUpdated: active.last_modified || "",
                figmaUrl: canEmbed
                    ? `https://www.figma.com/design/${active.key}/${encodeURIComponent(
                          (active.name || "file").replace(/\s+/g, "-")
                      )}`
                    : "",
                framerUrl: "",
                privateSession: !canEmbed,
            })
 
            activities = recent
                .slice(0, 6)
                .map((f) => ({
                    time: hhmm(f.last_modified || ""),
                    title:
                        allowAll || allowKeys.has(f.key)
                            ? `Updated ${f.name}`
                            : "Worked on a private project",
                }))
                .filter((a) => a.time)
        } else if (!explicit.length && !active) {
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
    }
 
    const live = designers.filter((d) => d.isLive)
 
    /* ---------------- public payload ------------------------------------ *
     * Every field below is world-readable. No folder names, no file names
     * outside the embed allowlist, no counts that hint at client volume.
     * ------------------------------------------------------------------- */
    const payload: any = {
        generatedAt: new Date(now).toISOString(),
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
                ? "all files (UNRESTRICTED — client work can be published)"
                : `allowlist only (${allowKeys.size} file(s))`,
            scannedThisRequest: scanned,
            rateLimited,
            refreshSeconds: Math.floor(refreshMs / 1000),
            hint: rateLimited
                ? "Figma rate-limited the scan. Cached results were kept. Raise REFRESH_SECONDS or turn off SCAN_SUBFOLDERS."
                : all.length === 0 && teamIds.length
                  ? "No files found. Check folders:read scope; files in Drafts are invisible to this API."
                  : "",
            calls: trace,
        }
    }
 
    return res.status(200).json(payload)
}