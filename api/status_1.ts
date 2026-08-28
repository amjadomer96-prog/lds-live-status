/**
 * LDS Live Studio — status endpoint.
 *
 * Polls the Figma REST API and publishes a small, PUBLIC JSON document
 * describing who is working and on what. The Figma token stays on the server
 * and is never included in the response.
 *
 * Deploy on Vercel. Required environment variable:
 *   FIGMA_TOKEN          personal access token (Figma → Settings → Security)
 *   LIVE_STUDIO_CONFIG   JSON array, one entry per designer (see README)
 * Optional:
 *   LIVE_WINDOW_MINUTES  minutes of silence before going offline (default 10)
 */

interface DesignerConfig {
    name: string
    role?: string
    fileKey: string
    framerUrl?: string
    avatar?: string
}

interface FigmaFile {
    name: string
    lastModified: string
    document?: { children?: Array<{ name?: string }> }
}

interface FigmaVersion {
    id: string
    created_at: string
    label?: string
    description?: string
    user?: { handle?: string; img_url?: string }
}

const FIGMA = "https://api.figma.com/v1"

function env(key: string, fallback = ""): string {
    return (process.env[key] ?? fallback).trim()
}

function readConfig(): DesignerConfig[] {
    const raw = env("LIVE_STUDIO_CONFIG")
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((d) => d && d.name && d.fileKey)
    } catch {
        return []
    }
}

async function figmaGet<T>(path: string, token: string): Promise<T | null> {
    try {
        const res = await fetch(`${FIGMA}${path}`, {
            headers: { "X-Figma-Token": token },
        })
        if (!res.ok) return null
        return (await res.json()) as T
    } catch {
        return null
    }
}

/** "14:07" in UTC — the component re-displays it verbatim. */
function hhmm(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(
        d.getUTCMinutes()
    ).padStart(2, "0")}`
}

/**
 * Turn Figma version history into readable activity lines.
 * A named version uses its label; an autosave falls back to the page name.
 */
function toActivities(
    versions: FigmaVersion[],
    pageNames: string[],
    windowMs: number
): Array<{ time: string; title: string }> {
    const now = Date.now()
    const fallback = pageNames[0] || "the file"
    return versions
        .filter((v) => {
            const t = Date.parse(v.created_at)
            return !Number.isNaN(t) && now - t <= windowMs * 6
        })
        .slice(0, 6)
        .map((v) => ({
            time: hhmm(v.created_at),
            title:
                (v.label && v.label.trim()) ||
                (v.description && v.description.trim()) ||
                `Updated ${fallback}`,
        }))
        .filter((a) => a.time)
}

export default async function handler(req: any, res: any) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    // Cached at the edge so Figma is polled at most twice a minute.
    res.setHeader(
        "Cache-Control",
        "public, s-maxage=30, stale-while-revalidate=120"
    )
    if (req.method === "OPTIONS") return res.status(204).end()

    const token = env("FIGMA_TOKEN")
    const config = readConfig()
    const windowMin = Number(env("LIVE_WINDOW_MINUTES", "10")) || 10
    const windowMs = windowMin * 60 * 1000
    const now = Date.now()

    const base = {
        generatedAt: new Date(now).toISOString(),
        isLive: false,
        designers: [] as any[],
        activities: [] as any[],
        error: "",
    }

    if (!token || config.length === 0) {
        base.error = !token ? "missing_token" : "missing_config"
        return res.status(200).json(base)
    }

    const designers = await Promise.all(
        config.map(async (cfg) => {
            const file = await figmaGet<FigmaFile>(
                `/files/${cfg.fileKey}?depth=1`,
                token
            )
            if (!file) {
                return {
                    name: cfg.name,
                    role: cfg.role || "",
                    isLive: false,
                    unreachable: true,
                }
            }
            const modified = Date.parse(file.lastModified)
            const isLive =
                !Number.isNaN(modified) && now - modified <= windowMs

            const pageNames = (file.document?.children || [])
                .map((c) => (c?.name || "").trim())
                .filter(Boolean)

            let versions: FigmaVersion[] = []
            if (isLive) {
                const v = await figmaGet<{ versions: FigmaVersion[] }>(
                    `/files/${cfg.fileKey}/versions`,
                    token
                )
                versions = (v && v.versions) || []
            }

            // Session start = oldest edit in the current unbroken run.
            let sessionStartedAt = file.lastModified
            for (const v of versions) {
                const t = Date.parse(v.created_at)
                if (Number.isNaN(t)) continue
                if (now - t <= windowMs * 6) sessionStartedAt = v.created_at
            }

            return {
                name: cfg.name,
                role: cfg.role || "",
                avatar: cfg.avatar || "",
                isLive,
                project: file.name,
                task: pageNames[0] || "",
                platform: "figma",
                sessionStartedAt: isLive ? sessionStartedAt : "",
                lastUpdated: file.lastModified,
                figmaUrl: `https://www.figma.com/design/${cfg.fileKey}/${encodeURIComponent(
                    file.name.replace(/\s+/g, "-")
                )}`,
                framerUrl: cfg.framerUrl || "",
                _versions: isLive ? versions : [],
                _pages: pageNames,
            }
        })
    )

    const live = designers.filter((d: any) => d.isLive)
    const activities = live.length
        ? toActivities(
              (live[0] as any)._versions || [],
              (live[0] as any)._pages || [],
              windowMs
          )
        : []

    const clean = designers.map(({ _versions, _pages, ...rest }: any) => rest)

    return res.status(200).json({
        generatedAt: base.generatedAt,
        isLive: live.length > 0,
        liveWindowMinutes: windowMin,
        designers: clean,
        activities,
    })
}
