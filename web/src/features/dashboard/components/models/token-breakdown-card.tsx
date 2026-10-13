/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
// LOCAL-PATCH(cachetokens): "Token Distribution" card — stacked hourly
// (fresh input / cache read / cache write / output) from the cache-aware
// /api/data/token-breakdown endpoint, with the overall cache hit rate in
// the header. Semantics are fixed server-side; this component only renders.
// Values are plotted (and tooltiped) in millions, matching the rankings
// page M/B convention. Bar/area toggle mirrors the consumption card.
import { VChart } from '@visactor/react-vchart'
import { AreaChart, BarChart3, Coins } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { IconBadge } from '@/components/ui/icon-badge'
import { useThemeCustomization } from '@/context/theme-customization-provider'
import { useTheme } from '@/context/theme-provider'
import {
  CONSUMPTION_DISTRIBUTION_CHART_OPTIONS,
  DEFAULT_TIME_GRANULARITY,
} from '@/features/dashboard/constants'
import { getTokenBreakdown } from '@/features/dashboard/api'
import {
  buildQueryParams,
  getDefaultDays,
} from '@/features/dashboard/lib'
import type {
  ConsumptionDistributionChartType,
  DashboardFilters,
  TokenBreakdownItem,
} from '@/features/dashboard/types'
import { computeTimeRange, formatChartTime } from '@/lib/time'
import { VCHART_OPTION } from '@/lib/vchart'

let themeManagerPromise: Promise<
  (typeof import('@visactor/vchart'))['ThemeManager']
> | null = null

interface TokenBreakdownCardProps {
  filters?: DashboardFilters
}

type SegmentKey = 'fresh_input' | 'cache_read' | 'cache_write' | 'completion'

const SEGMENT_KEYS: SegmentKey[] = [
  'fresh_input',
  'cache_read',
  'cache_write',
  'completion',
]

const SEGMENT_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#a855f7']

const CHART_TYPE_ICONS: Record<
  ConsumptionDistributionChartType,
  typeof BarChart3
> = {
  bar: BarChart3,
  area: AreaChart,
}

// Readable token magnitude: M for millions, B for billions.
function formatMillions(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--'
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  return value.toLocaleString()
}

function formatMillionsPrecise(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0M'
  return `${(value / 1_000_000).toFixed(2)}M`
}

type UpdateContentFn = (
  prev: TooltipLine[],
  data?: unknown
) => TooltipLine[]

// One rendered tooltip row; shape fields draw the leading color swatch.
type TooltipLine = {
  key: string
  value: string
  hasShape?: boolean
  shapeType?: string
  shapeFill?: string
  shapeSize?: number
}

// VChart mark-mode tooltip (confirmed in MarkTooltipProcessor.showTooltip)
// passes data as:  [{ datum: [row], series }]
// The dimension-mode variant passes IDimensionInfo[]:
//  [{ value: <axis Time>, data: [{ datum: [rows] }] }]
// Handle both; every earlier revision missed the mark-mode shape and the
// content callback silently returned undefined (default tooltip rendered).
function extractTooltipTime(data: unknown): string | undefined {
  if (!Array.isArray(data)) {
    return (
      (data as { datum?: Array<{ Time?: string }> })?.datum?.[0]?.Time ??
      (data as { Time?: string })?.Time
    )
  }
  for (const item of data as Array<{
    value?: string | number
    datum?: Array<{ Time?: string }>
    data?: Array<{ datum?: Array<{ Time?: string }> }>
  }>) {
    if (Array.isArray(item?.datum) && typeof item.datum[0]?.Time === 'string') {
      return item.datum[0].Time
    }
    const rows = item?.data?.[0]?.datum
    if (Array.isArray(rows) && typeof rows[0]?.Time === 'string') {
      return rows[0].Time
    }
    if (typeof item?.value === 'string') return item.value
  }
  return undefined
}

export function TokenBreakdownCard(props: TokenBreakdownCardProps) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const { customization } = useThemeCustomization()
  const [data, setData] = useState<TokenBreakdownItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [themeReady, setThemeReady] = useState(false)
  const [chartType, setChartType] = useState<ConsumptionDistributionChartType>(
    'bar'
  )
  const themeManagerRef = useRef<
    (typeof import('@visactor/vchart'))['ThemeManager'] | null
  >(null)
  const timeGranularity =
    props.filters?.time_granularity || DEFAULT_TIME_GRANULARITY

  useEffect(() => {
    const updateTheme = async () => {
      setThemeReady(false)

      if (!themeManagerPromise) {
        themeManagerPromise = import('@visactor/vchart').then(
          (m) => m.ThemeManager
        )
      }

      const ThemeManager = await themeManagerPromise
      themeManagerRef.current = ThemeManager
      ThemeManager.setCurrentTheme(resolvedTheme === 'dark' ? 'dark' : 'light')
      setThemeReady(true)
    }

    void updateTheme()
  }, [resolvedTheme])

  useEffect(() => {
    const abortController = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(false)

    const timeRange = computeTimeRange(
      getDefaultDays(props.filters?.time_granularity),
      props.filters?.start_timestamp,
      props.filters?.end_timestamp
    )
    void getTokenBreakdown(buildQueryParams(timeRange, props.filters))
      .then((res) => {
        if (abortController.signal.aborted) return
        setData(res?.data || [])
      })
      .catch(() => {
        if (abortController.signal.aborted) return
        setData([])
        setError(true)
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setLoading(false)
        }
      })

    return () => {
      abortController.abort()
    }
  }, [props.filters])

  const segmentLabels = useMemo(
    () => ({
      fresh_input: t('Fresh Input'),
      cache_read: t('Cache Read'),
      cache_write: t('Cache Write'),
      completion: t('Output'),
    }),
    [t]
  )

  const { values, timeRawTotals, totalInput, totalCacheRead, totalTokens } =
    useMemo(() => {
      // Merge hour buckets into display buckets using the browser-local
      // granularity label — same convention as the other dashboard charts.
      // Raw per-segment sums feed the tooltip; plotted values are millions
      // so axis ticks and hover stay readable.
      const byTime = new Map<string, Record<SegmentKey, number>>()
      let input = 0
      let cacheRead = 0
      let tokens = 0
      for (const row of data) {
        const key = formatChartTime(row.bucket, timeGranularity)
        let acc = byTime.get(key)
        if (!acc) {
          acc = { fresh_input: 0, cache_read: 0, cache_write: 0, completion: 0 }
          byTime.set(key, acc)
        }
        for (const seg of SEGMENT_KEYS) {
          acc[seg] += row[seg] || 0
        }
        input += row.total_input || 0
        cacheRead += row.cache_read || 0
        tokens += (row.total_input || 0) + (row.completion || 0)
      }
      const chartValues: Array<{
        Time: string
        Segment: string
        Tokens: number
      }> = []
      for (const [time, acc] of byTime) {
        for (const seg of SEGMENT_KEYS) {
          if (acc[seg] > 0) {
            chartValues.push({
              Time: time,
              Segment: segmentLabels[seg],
              Tokens: Math.round((acc[seg] / 1_000_000) * 100) / 100,
            })
          }
        }
      }
      return {
        values: chartValues,
        timeRawTotals: byTime,
        totalInput: input,
        totalCacheRead: cacheRead,
        totalTokens: tokens,
      }
    }, [data, timeGranularity, segmentLabels])

  const hitRate =
    totalInput > 0 ? (totalCacheRead / totalInput) * 100 : null
  const hitRateDisplay =
    loading || error || hitRate === null
      ? '--'
      : `${hitRate.toFixed(1)}%`
  const totalTokensDisplay = formatMillions(totalTokens)

  const tooltipUpdateContent = useMemo(
    () => (prev: unknown, data?: unknown) => {
      const time = extractTooltipTime(data)
      if (!time) return prev
      const acc = timeRawTotals.get(time)
      if (!acc) return prev
      // Mirror the consumption card tooltip: total first, then one line per
      // segment with its legend color swatch (shape fields are part of
      // ITooltipLineActual and render as the leading color block).
      const total = SEGMENT_KEYS.reduce((sum, seg) => sum + acc[seg], 0)
      const lines: TooltipLine[] = [
        { key: t('Total:'), value: formatMillionsPrecise(total) },
      ]
      SEGMENT_KEYS.forEach((seg, idx) => {
        if (acc[seg] <= 0) return
        lines.push({
          key: segmentLabels[seg],
          value: formatMillionsPrecise(acc[seg]),
          hasShape: true,
          shapeType: 'rect',
          shapeFill: SEGMENT_COLORS[idx],
          shapeSize: 8,
        })
      })
      return lines
    },
    [timeRawTotals, segmentLabels, t]
  )

  const spec = useMemo(() => {
    const base = {
      data: [{ id: 'tokenData', values }],
      xField: 'Time',
      yField: 'Tokens',
      seriesField: 'Segment',
      stack: true,
      legends: { visible: true, selectMode: 'multiple' as const },
      color: {
        domain: SEGMENT_KEYS.map((key) => segmentLabels[key]),
        range: SEGMENT_COLORS,
      },
      // Default activeType covers both modes: hovering a bar body triggers
      // 'mark' (single segment), hovering elsewhere in the column triggers
      // 'dimension' (whole-column hotspot). updateContent (invoked after all
      // series lines are combined, per BaseTooltipProcessor) replaces either
      // default with one line per segment plus a total line, so both hit
      // paths show the same full breakdown.
      tooltip: {
        mark: { updateContent: tooltipUpdateContent as UpdateContentFn },
        dimension: { updateContent: tooltipUpdateContent as UpdateContentFn },
      },
      axes: [
        {
          orient: 'bottom' as const,
          label: { autoHide: true },
        },
        {
          orient: 'left' as const,
          title: { visible: true, text: `${t('Tokens')} (M)` },
        },
      ],
      title: { visible: false },
    }
    if (chartType === 'area') {
      return {
        ...base,
        type: 'area' as const,
        // Match the consumption card look: smooth curves, no point markers.
        point: { visible: false },
        area: { style: { curveType: 'monotone' } },
        line: { style: { curveType: 'monotone' } },
      }
    }
    return { ...base, type: 'bar' as const }
  }, [values, segmentLabels, t, chartType, tooltipUpdateContent])

  const chartKey = [
    'token-breakdown',
    chartType,
    loading ? 'loading' : 'ready',
    values.length,
    resolvedTheme,
    customization.preset,
  ].join('-')

  return (
    <div className='overflow-hidden rounded-lg border'>
      <div className='flex w-full flex-col gap-1.5 border-b px-3 py-2 sm:gap-3 sm:px-5 sm:py-3 lg:flex-row lg:items-center lg:justify-between'>
        <div className='flex flex-wrap items-center gap-2'>
          <IconBadge tone='primary' size='sm'>
            <Coins />
          </IconBadge>
          <div className='text-sm font-semibold'>{t('Token Distribution')}</div>
          <span className='text-muted-foreground text-xs'>
            {t('Cache Hit Rate')}: {hitRateDisplay}
          </span>
          <span className='text-muted-foreground text-xs'>
            {t('Total:')} {totalTokensDisplay}
          </span>
        </div>

        <div className='bg-muted/60 inline-flex h-7 w-full overflow-x-auto rounded-lg border p-0.5 sm:h-8 sm:w-auto'>
          {CONSUMPTION_DISTRIBUTION_CHART_OPTIONS.map((item) => {
            const Icon = CHART_TYPE_ICONS[item.value]
            return (
              <button
                key={item.value}
                type='button'
                onClick={() => setChartType(item.value)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors ${
                  chartType === item.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className='size-3.5' />
                {t(item.labelKey)}
              </button>
            )
          })}
        </div>
      </div>

      <div className='h-[300px] p-1.5 sm:h-96 sm:p-2'>
        {themeReady && values.length > 0 && (
          <VChart
            key={chartKey}
            spec={{
              ...spec,
              theme: resolvedTheme === 'dark' ? 'dark' : 'light',
              background: 'transparent',
            }}
            option={VCHART_OPTION}
          />
        )}
        {(!themeReady || values.length === 0) && (
          <div className='text-muted-foreground/60 flex h-full items-center justify-center text-xs'>
            {loading ? t('Loading...') : error ? t('Load failed') : t('No data')}
          </div>
        )}
      </div>
    </div>
  )
}
