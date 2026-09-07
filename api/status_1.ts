
 
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
    /** Figma page names. Only present on files fetched by key. */
    pages?: string[]
}
 
const FIGMA = "https://api.figma.com"
 
/** Paths starting with /v2/ are passed through; everything else is v1. */
const figmaUrl = (path: string) =>
    path.startsWith("/v2/") ? `${FIGMA}${path}` : `${FIGMA}/v1${path}`
 
const env = (k: string, d = "") => (process.env[k] ?? d).trim()
const list = (k: string) =>
    env(k)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
 
/** Records what every Figma call actually did, so a zero result explains itself. */
const trace: Array<{ call: string; status: number | string; note?: string }> = []
 
async function figmaGet<T>(path: string, token: string): Promise<T | null> {
    const label = path.split("?")[0]
    try {
        const res = await fetch(figmaUrl(path), {
            headers: { "X-Figma-Token": token },
        })
        if (!res.ok) {
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
        trace.push({ call: label, status: "network_error", note: String(e?.message || e) })
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
 
/**
 * Every file across every configured team, newest first.
 *
 * Uses Figma's v2 Folders API. Figma renamed "projects" to "folders"; the old
 * /v1/teams/:id/projects endpoint needs the retired `projects:read` scope,
 * which Figma no longer issues. These v2 endpoints use `folders:read`.
 */
async function filesAcrossTeams(
    teamIds: string[],
    token: string
): Promise<ProjectFile[]> {
    const out: ProjectFile[] = []
    const seenFolders = new Set<string>()
 
    const readFolder = async (folder: { id: string; name?: string }, depth: number) => {
        if (seenFolders.has(folder.id) || depth > 3) return
        seenFolders.add(folder.id)
 
        const files = await figmaGet<{ files?: ProjectFile[] }>(
            `/v2/folders/${folder.id}/files`,
            token
        )
        const fileList = files?.files || []
        trace.push({
            call: `folder "${folder.name || folder.id}"`,
            status: files ? "ok" : "failed",
            note: `${fileList.length} file(s)`,
        })
        for (const f of fileList) if (f && f.key) out.push(f)
 
        // Nested folders, where the account has them. Undocumented, so failure is fine.
        const sub = await figmaGet<{ folders?: Array<{ id: string; name?: string }> }>(
            `/v2/folders/${folder.id}/folders`,
            token
        )
        for (const child of sub?.folders || []) {
            if (child?.id) await readFolder(child, depth + 1)
        }
    }
 
    for (const teamId of teamIds) {
        const res = await figmaGet<{
            folders?: Array<{ id: string; name?: string }>
        }>(`/v2/teams/${teamId}/folders`, token)
        const folders = res?.folders || []
        trace.push({
            call: `team ${teamId}`,
            status: res ? "ok" : "failed",
            note: `${folders.length} folder(s)`,
        })
        for (const folder of folders) {
            if (folder?.id) await readFolder(folder, 0)
        }
    }
 
    // A file can sit in more than one place; keep one entry each.
    const unique = new Map<string, ProjectFile>()
    for (const f of out) unique.set(f.key, f)
    return [...unique.values()].sort(
        (a, b) =>
            Date.parse(b.last_modified || "") - Date.parse(a.last_modified || "")
    )
}
 
/** Watch a plain list of file keys. Needs only the "File content" read scope. */
async function filesByKeys(
    keys: string[],
    token: string
): Promise<ProjectFile[]> {
    const out: ProjectFile[] = []
    for (const key of keys) {
        const file = await figmaGet<{
            name: string
            lastModified: string
            document?: any
        }>(`/files/${key}?depth=1`, token)
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
    return out.sort(
        (a, b) =>
            Date.parse(b.last_modified || "") - Date.parse(a.last_modified || "")
    )
}
 
export default async function handler(req: any, res: any) {
    trace.length = 0 // warm lambdas reuse the module scope; start each request clean
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader(
        "Cache-Control",
        "public, s-maxage=30, stale-while-revalidate=120"
    )
    if (req.method === "OPTIONS") return res.status(204).end()
 
    const token = env("FIGMA_TOKEN")
    const teamIds = list("FIGMA_TEAM_IDS")
    const watchKeys = list("WATCH_FILE_KEYS")
    const allowKeys = new Set(list("PUBLIC_FILE_KEYS"))
    const allowAll = env("ALLOW_ALL_EMBEDS").toLowerCase() === "true"
    const windowMin = Number(env("LIVE_WINDOW_MINUTES", "10")) || 10
    const windowMs = windowMin * 60 * 1000
    const now = Date.now()
 
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
 
    if (!token) {
        return res.status(200).json({
            generatedAt: new Date(now).toISOString(),
            isLive: false,
            designers: [],
            activities: [],
            error: "missing_token",
        })
    }
    if (!teamIds.length && !watchKeys.length && !explicit.length) {
        return res.status(200).json({
            generatedAt: new Date(now).toISOString(),
            isLive: false,
            designers: [],
            activities: [],
            error: "missing_config",
        })
    }
 
    /* ---------------- explicit files (per-designer mapping) ------------- */
    const designers: any[] = []
    for (const cfg of explicit) {
        const file = await figmaGet<{ name: string; lastModified: string; document?: any }>(
            `/files/${cfg.fileKey}?depth=1`,
            token
        )
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
            project: file.name,
            task: pages[0] || "",
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
 
    /* ---------------- team-wide detection ------------------------------- */
    let activities: Array<{ time: string; title: string }> = []
    let filesWatched = 0
    if (teamIds.length || watchKeys.length) {
        const fromTeams = teamIds.length
            ? await filesAcrossTeams(teamIds, token)
            : []
        const fromKeys = watchKeys.length
            ? await filesByKeys(watchKeys, token)
            : []
        // team results win on duplicate keys
        const merged = new Map<string, ProjectFile>()
        for (const f of [...fromKeys, ...fromTeams]) merged.set(f.key, f)
        const all = [...merged.values()].sort(
            (a, b) =>
                Date.parse(b.last_modified || "") -
                Date.parse(a.last_modified || "")
        )
        filesWatched = all.length
        const recent = all.filter((f) => {
            const t = Date.parse(f.last_modified || "")
            return !Number.isNaN(t) && now - t <= windowMs
        })
        const active = recent[0]
        // a file already covered by LIVE_STUDIO_CONFIG has its own panel above
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
        } else if (!explicit.length) {
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
 
    return res.status(200).json({
        generatedAt: new Date(now).toISOString(),
        isLive: live.length > 0,
        liveWindowMinutes: windowMin,
        watching: [
            teamIds.length ? `${teamIds.length} team(s)` : "",
            watchKeys.length ? `${watchKeys.length} listed file(s)` : "",
        ]
            .filter(Boolean)
            .join(" + ") || "nothing configured",
        filesWatched,
        teamsConfigured: teamIds.length,
        embedPolicy: allowAll ? "all files (unrestricted)" : "allowlist only",
        diagnostics: {
            hint:
                filesWatched === 0 && teamIds.length
                    ? "Team scan returned nothing. Check the token has the folders:read scope, and that files live in a team folder rather than Drafts (Drafts are invisible to this API). WATCH_FILE_KEYS is the fallback."
                    : "",
            calls: trace,
        },
        designers,
        activities,
    })
}