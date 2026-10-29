import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

type Props = {
  activeIndex: number
  children: React.ReactNode
}

/** A single row of tabs without a scrollbar; arrow buttons appear when the tabs overflow. */
export function TabStrip({ activeIndex, children }: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const update = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanLeft(el.scrollLeft > 0)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useLayoutEffect(update)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return
      e.preventDefault()
      el.scrollLeft += e.deltaY || e.deltaX
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      observer.disconnect()
      el.removeEventListener('wheel', onWheel)
    }
  }, [update])

  useEffect(() => {
    const tab = scrollRef.current?.children[activeIndex]
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeIndex])

  // Scroll so the first tab cut off in the given direction becomes fully visible.
  const step = (direction: -1 | 1): void => {
    const el = scrollRef.current
    if (!el) return
    const left = el.scrollLeft
    const right = left + el.clientWidth
    const tabs = Array.from(el.children) as HTMLElement[]
    const target =
      direction > 0
        ? tabs.find((t) => t.offsetLeft + t.offsetWidth > right + 1)
        : [...tabs].reverse().find((t) => t.offsetLeft < left - 1)
    if (!target) return
    el.scrollTo({
      left: direction > 0 ? target.offsetLeft + target.offsetWidth - el.clientWidth : target.offsetLeft,
      behavior: 'smooth'
    })
  }

  return (
    <div className="tab-strip drag">
      <div className="tabs" ref={scrollRef} onScroll={update}>
        {children}
      </div>
      <div className="tab-strip-fill" />
      {(canLeft || canRight) && (
        <div className="tab-arrows">
          <button disabled={!canLeft} onClick={() => step(-1)} title="Предыдущие вкладки">
            <ChevronLeft size={14} />
          </button>
          <button disabled={!canRight} onClick={() => step(1)} title="Следующие вкладки">
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
