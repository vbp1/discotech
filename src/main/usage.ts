// Usage requests follow Orca (https://github.com/stablyai/orca), MIT License,
// Copyright (c) 2026 Lovecast Inc.: src/main/rate-limits/claude-oauth-usage-request.ts and
// src/main/rate-limits/codex-backend-auth.ts, codex-backend-usage-client.ts. The Z.ai quota
// request follows the official zai-coding-plugins glm-plan-usage skill (query-usage.mjs).
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProviderUsage, UsageReport, UsageWindow } from '../shared/api'
import { runInWsl, toUnc } from './wsl'

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const ZAI_QUOTA_PATH = '/api/monitor/usage/quota/limit'
const ZAI_ORIGINS = new Set(['https://api.z.ai', 'https://open.bigmodel.cn', 'https://dev.bigmodel.cn'])
const REQUEST_TIMEOUT_MS = 15_000
const SESSION_SECONDS = 5 * 3600
const WEEK_SECONDS = 7 * 24 * 3600

const homeByDistro = new Map<string, string>()

async function linuxHome(distro: string): Promise<string> {
  const cached = homeByDistro.get(distro)
  if (cached) return cached
  const result = await runInWsl(distro, ['printenv', 'HOME'])
  const home = result.stdout.trim()
  if (result.code !== 0 || !home.startsWith('/')) {
    throw new Error(`Cannot read HOME in WSL distro "${distro}": ${result.stderr.trim() || `exit code ${result.code}, output "${home}"`}`)
  }
  homeByDistro.set(distro, home)
  return home
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Файл входа не найден: ${file}`)
    throw error
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Файл входа ${file} не читается как JSON: ${(error as Error).message}`)
  }
}

async function getJson(url: string, headers: Record<string, string>, onUnauthorized: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const body = await response.text()
  if (response.status === 401 || response.status === 403) throw new Error(`${onUnauthorized} (HTTP ${response.status})`)
  if (!response.ok) throw new Error(`HTTP ${response.status} от ${url}: ${body.slice(0, 300)}`)
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new Error(`Ответ ${url} не JSON: ${body.slice(0, 300)}`)
  }
}

function unexpected(what: string, value: unknown): Error {
  return new Error(`Неожиданный ответ сервиса: ${what} = ${JSON.stringify(value)?.slice(0, 200)}`)
}

function parseTime(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value > 1e10 ? value : value * 1000
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isNaN(ms)) throw unexpected('resets_at', value)
    return ms
  }
  throw unexpected('resets_at', value)
}

function percent(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw unexpected(what, value)
  return value
}

async function claudeUsage(home: string, distro: string): Promise<ProviderUsage> {
  const source = toUnc(distro, path.posix.join(home, '.claude/.credentials.json'))
  try {
    const credentials = await readJson(source)
    const oauth = credentials.claudeAiOauth as { accessToken?: string; subscriptionType?: string } | undefined
    if (!oauth?.accessToken) throw new Error(`В ${source} нет claudeAiOauth.accessToken — войдите в Claude Code`)
    const data = await getJson(
      CLAUDE_USAGE_URL,
      { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
      'Вход Claude устарел или отозван: запустите claude в терминале, он обновит вход'
    )
    const windows: UsageWindow[] = []
    const fixed: [string, string][] = [
      ['five_hour', '5 часов'],
      ['seven_day', 'Неделя']
    ]
    for (const [key, label] of fixed) {
      const raw = data[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined
      if (!raw) continue
      windows.push({ label, usedPercent: percent(raw.utilization, `${key}.utilization`), resetsAt: parseTime(raw.resets_at) })
    }
    // Model-scoped weekly limits (e.g. Fable) come only in the generic list.
    const limits = Array.isArray(data.limits) ? (data.limits as Record<string, unknown>[]) : []
    for (const limit of limits) {
      if (limit.kind !== 'weekly_scoped') continue
      const scope = limit.scope as { model?: { display_name?: string } | null } | null
      const name = scope?.model?.display_name ?? 'отдельная модель'
      windows.push({ label: `Неделя · ${name}`, usedPercent: percent(limit.percent, 'limits[].percent'), resetsAt: parseTime(limit.resets_at) })
    }
    if (windows.length === 0) throw unexpected('окна лимитов', Object.keys(data))
    return { status: 'ok', plan: oauth.subscriptionType ?? null, windows, source, fetchedAt: Date.now() }
  } catch (error) {
    return { status: 'error', message: (error as Error).message, source, fetchedAt: Date.now() }
  }
}

function codexWindowLabel(seconds: unknown): string {
  if (seconds === SESSION_SECONDS) return '5 часов'
  if (seconds === WEEK_SECONDS) return 'Неделя'
  if (typeof seconds === 'number') return `${Math.round(seconds / 3600)} ч`
  throw unexpected('limit_window_seconds', seconds)
}

async function codexUsage(home: string, distro: string): Promise<ProviderUsage> {
  const source = toUnc(distro, path.posix.join(home, '.codex/auth.json'))
  try {
    const auth = await readJson(source)
    const tokens = auth.tokens as { access_token?: string; account_id?: string } | undefined
    if (!tokens?.access_token) throw new Error(`В ${source} нет tokens.access_token — войдите в Codex (codex login)`)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.access_token}`,
      'User-Agent': 'codex-cli',
      'OpenAI-Beta': 'codex-1',
      originator: 'Codex Desktop'
    }
    if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id
    const data = await getJson(CODEX_USAGE_URL, headers, 'Вход Codex устарел или отозван: запустите codex в терминале или codex login')
    const rateLimit = data.rate_limit as Record<string, Record<string, unknown> | null> | null | undefined
    if (!rateLimit) throw unexpected('rate_limit', rateLimit)
    const windows: UsageWindow[] = []
    for (const key of ['primary_window', 'secondary_window']) {
      const raw = rateLimit[key]
      if (!raw) continue
      windows.push({
        label: codexWindowLabel(raw.limit_window_seconds),
        usedPercent: percent(raw.used_percent, `${key}.used_percent`),
        resetsAt: parseTime(raw.reset_at)
      })
    }
    if (windows.length === 0) throw unexpected('rate_limit', rateLimit)
    return { status: 'ok', plan: typeof data.plan_type === 'string' ? data.plan_type : null, windows, source, fetchedAt: Date.now() }
  } catch (error) {
    return { status: 'error', message: (error as Error).message, source, fetchedAt: Date.now() }
  }
}

/** Maps the window length the service sends to the labels the status bar shows; unit 3 is hours, 6 is weeks. */
function zaiWindowLabel(unit: unknown, number: unknown): string {
  if (unit === 3 && number === 5) return '5 часов'
  if (unit === 6 && number === 1) return 'Неделя'
  if (unit === 3 && typeof number === 'number') return `${number} ч`
  if (unit === 6 && typeof number === 'number') return `${number} нед.`
  return 'Окно лимита'
}

// The GLM Coding Plan key Claude Code uses; the quota endpoint is asked at the domain of
// ANTHROPIC_BASE_URL, as the official glm-plan-usage plugin does.
async function zaiUsage(home: string, distro: string): Promise<ProviderUsage> {
  const source = toUnc(distro, path.posix.join(home, '.claude/settings.json'))
  try {
    const settings = await readJson(source)
    const env = settings.env as Record<string, unknown> | undefined
    const token = typeof env?.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN : ''
    const baseUrl = typeof env?.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : ''
    if (!token || !baseUrl) throw new Error(`В ${source} нет env.ANTHROPIC_AUTH_TOKEN или env.ANTHROPIC_BASE_URL — настроек подписки Z.ai для Claude Code`)
    let origin: string
    try {
      origin = new URL(baseUrl).origin
    } catch {
      throw new Error(`env.ANTHROPIC_BASE_URL в ${source} не похож на адрес: ${baseUrl}`)
    }
    if (!ZAI_ORIGINS.has(origin)) throw new Error(`env.ANTHROPIC_BASE_URL в ${source} ведёт не к Z.ai: ${baseUrl}`)
    const data = await getJson(
      `${origin}${ZAI_QUOTA_PATH}`,
      { Authorization: token, 'Accept-Language': 'en-US,en', 'Content-Type': 'application/json' },
      'Ключ Z.ai не принят: обновите ключ подписки на z.ai и запишите его в env.ANTHROPIC_AUTH_TOKEN'
    )
    const payload = data.data as { level?: unknown; limits?: unknown } | null | undefined
    const limits = Array.isArray(payload?.limits) ? (payload?.limits as Record<string, unknown>[]) : []
    const windows: UsageWindow[] = []
    for (const limit of limits) {
      if (limit.type !== 'CREDIT_LIMIT') continue
      windows.push({
        label: zaiWindowLabel(limit.unit, limit.number),
        usedPercent: percent(limit.percentage, 'limits[].percentage'),
        resetsAt: parseTime(limit.nextResetTime)
      })
    }
    if (windows.length === 0) throw unexpected('limits', limits)
    return { status: 'ok', plan: typeof payload?.level === 'string' ? payload.level : null, windows, source, fetchedAt: Date.now() }
  } catch (error) {
    return { status: 'error', message: (error as Error).message, source, fetchedAt: Date.now() }
  }
}

export async function getUsage(distro: string): Promise<UsageReport> {
  const home = await linuxHome(distro)
  const [claude, codex, zai] = await Promise.all([claudeUsage(home, distro), codexUsage(home, distro), zaiUsage(home, distro)])
  return { claude, codex, zai }
}
